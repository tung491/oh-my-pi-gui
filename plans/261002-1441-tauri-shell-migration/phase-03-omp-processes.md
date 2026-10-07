---
phase: 3
title: "omp child processes: sidecar manager, NDJSON bridge, stats, bench"
status: pending
priority: P1
effort: "7d"
dependencies: [2]
module: omp
---

# Phase 3: omp child processes (module `omp`)

## Goal

Rust owns every `omp` child process the GUI starts: the per-tab `omp --mode rpc-ui` sidecar (spawn through the supervisor frozen in Phase 2, NDJSON framing, v2 chunk reassembly, request correlation, event batching, restart and crash-loop policy), the login-shell environment and proxy injection, the `omp stats` dashboard server and `omp bench`. Each of these behaves exactly as the TypeScript source, except sidecar shutdown, which is stricter than Electron's: after a hard kill of the GUI, no `omp` and no tool child survives (Phase 0 S7b).

## Wave rules (same for Phases 3 to 9)

- Work in your own worktree: `git worktree add ../worktrees/tauri-omp -b tauri/omp tauri/foundation`. Before deleting the worktree, stop any process you started in it.
- Edit only `src-tauri/src/omp/**`. Never edit a file on the frozen list in `plan.md` → Execution rules (`Cargo.toml`, `Cargo.lock`, `main.rs`, `lib.rs`, `ctx.rs`, `ports.rs`, `bridge.rs`, `webview.rs`, `prefs.rs`, `paths.rs`, `i18n.rs`, `runtime_log.rs`, `testing.rs`, `test_hooks.rs`, `capabilities/*`, `contracts/*`, `src/shared/**` and the rest of that list) or any other module's directory. Never change a `pub fn` signature in `src-tauri/contracts/omp.api.txt` or `ports.api.txt` (`omp::supervisor::run` and `SidecarHandle` included). Helpers you add must be private or `pub(crate)`.
- `unsafe` is allowed in exactly two places in this module, each with a `// SAFETY:` comment saying why: the `pre_exec` block in `manager.rs` that dups the control channel to fd 3, and the one `OwnedFd::from_raw_fd(3)` call in `supervisor.rs` (`FromRawFd::from_raw_fd` is an `unsafe fn`). No other wave module may contain `unsafe`. `check-module.sh` has no `unsafe` gate and its clippy gate (gate 4) does not deny `unsafe_code`, so the Verify of Task 3.6 checks the count with `grep`.
- If you believe a frozen file or signature must change, that is a plan bug. Follow the Failure Protocol; do not work around it.
- Port by test: every `it("…")` in the mapped TS test files becomes a `#[test]` (or `#[tokio::test]`) with the normalized name. `scripts/check-test-parity.ts` checks this.
- All process I/O uses `tokio::process` and `tokio::io`. No `std::process::Command`, no `std::thread::sleep`, no `unwrap()`/`expect()` outside tests.
- The final gate for the phase is `bash scripts/check-module.sh omp`. Two gate blind spots to work around, because the script is frozen: gate 1 diffs tracked files only (`git diff --name-only $BASE`), so commit (or at least `git add`) every new file before running the gate, or an out-of-bounds new file passes unseen; gate 3 builds `out/renderer-tauri` only when it is missing, so run `bun run build:renderer:tauri` first whenever the renderer changed since the last build, or the snapshot check embeds a stale frontend. Gate 9 prints WARN for any cross-target failure on this host (no Apple or MSVC toolchain), so a WARN there proves nothing about the macOS or Windows code; Phase 12 builds those branches on real hosts.
- Until Phase 5 is merged, `Desktop::on_second_instance` is still a `todo!()` that the single-instance plugin callback reaches (`lib.rs:396-400`). Never start a second app instance on the same `--user-data-dir` in a manual run; give every run its own `$(mktemp -d)` profile.
- Cross-module calls go only through the frozen traits in `src-tauri/src/ports.rs`. Unit tests use the fakes in `src-tauri/src/testing.rs`, never another module's stubs. Before running anything that needs the agent, check `test -x resources/omp` (see `plan.md` → Sidecar binaries). Every manual app run uses `bun run dev:tauri -- --user-data-dir=$(mktemp -d)`.
- Frozen wiring every wave module follows (Phase 2 Task 2.9b; `lib.rs`, `ports.rs`, `testing.rs` on `tauri/foundation`):
  - **Context.** Each module struct is built once in `lib.rs::build_ctx` (`lib.rs:265-284`, `Arc::new_cyclic`) as `X::new(ctx: CtxRef)` (`Desktop::new(app, ctx)` for desktop), where `ports::CtxRef = Weak<AppCtx>` (`ports.rs:23`). A trait method reaches other ports through the stub's private `self.ctx()` (`self.ctx.upgrade()`), which is `None` only during shutdown. A listener or task that outlives the call captures a `CtxRef` (`Arc::downgrade(ctx)`), never an `Arc<AppCtx>`, so it cannot form a reference cycle.
  - **Handler state.** Handlers are plain `fn` pointers (`bridge::Handler`). A handler reaches its module's state through the port: `ctx.<module>.as_any().downcast_ref::<<module>::<Struct>>()` (for example `ctx.omp.as_any().downcast_ref::<omp::Omp>()`); every port trait has `fn as_any(&self) -> &dyn Any`.
  - **Startup.** `lib.rs` calls `omp::init`, `services::init`, `tabs::init`, `desktop::init`, `ollama::init`, `updater::init` in that order, each `init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()>`, after `AppCtx` is managed (`lib.rs:410-422`). Register listeners on other ports (`on_window_closed`, `on_window_tabs_changed`, `on_sessions_changed`) inside `init`.
  - **Shutdown.** The frozen order is `mark_quitting → tabs.dispose_all → omp.shutdown → services.shutdown → ollama.shutdown → updater.shutdown → desktop.shutdown`, run once from `RunEvent::ExitRequested` or `RunEvent::Exit` (`lib.rs:286-308`). Your module's `shutdown` stops only what your module started.
  - **Spawning.** `tokio::spawn` and `tokio::process::Command::spawn` panic on the main thread, which runs `init` and every menu, tray, shortcut, deep-link and single-instance callback. Code that can run there spawns with `crate::bridge::spawn_task(future)` (`bridge.rs:367-380`, `pub(crate)` since `39fd6bf`), which uses `tokio::runtime::Handle::try_current()` when a runtime drives the caller (so `#[tokio::test]` with `tokio::time::pause()` keeps its clock) and `tauri::async_runtime::spawn` otherwise. Call it rather than copying it; never call bare `tokio::spawn` from such a path. "The spawning helper" in later phases means this function.
  - **`'static` futures.** `SidecarHandle::request`, `kill`, `dispose` and `TabsPort::command_for_idle_session` return `BoxFuture<'static, …>` and do their synchronous part (stdin write, stop signal) before returning. A handler calls them synchronously and hands the future to `Reply::Later`.
  - **Tests.** Install your real port next to the fakes with `testing::fake_ctx_cyclic(&fakes, registry, |ctx, ports| ports.<module> = Some(Arc::new(<Struct>::new(ctx.clone()))))` (`testing.rs:831`; `testing::Ports` has one `Option` per port), then drive handlers with `bridge::dispatch_for_test(&ctx, caller, channel, args)` (`bridge.rs:975`). Script the fakes through their public fields (`FakeHost::open_dialog_answers`, `FakeHost::message_dialog_answers`, `FakeHost::relaunches`, `FakeOmp::sidecars`, `FakeOmp::env`, `FakeDesktop::prevent_exit`, …). Tests never touch the real profile: in a test build, `paths::user_data_dir()` (and `runtime_log_path`, `webview_data_dir`, `is_default_profile`, `single_instance_id`) panics when it would resolve the default profile (`fe94ddf`), and the process-wide runtime log goes to `<temp>/sai-atlas-tests/<pid>-gui-runtime.jsonl`. Code that reads a profile or agent directory takes the directory as a parameter, and its tests pass a `tempfile` dir; do not call `paths::user_data_dir()` or `paths::agent_dir()` from a test path, so no test reads or writes the user's profile or `~/.omp`.
  - **Errors you will see before the merge.** A handler that reaches another module's `todo!()` stub no longer hangs the window: the bridge catches the panic and rejects the call with `handler for <channel> panicked` (`39fd6bf`). That is expected in manual runs until Phase 10 merges the wave.
  - **Prefs writes can fail.** `JsonStore::{set, delete, update}` return `Err(StoreError::Unreadable { .. })` when the store file existed but could not be read at startup (`caffc3a`); the file is then never overwritten. A handler that writes prefs replies with `IpcError::new(error.to_string())` instead of ignoring the result.
  - **Cargo test filters.** `cargo test` accepts one filter before `--`; several filters go after it (`cargo test --manifest-path src-tauri/Cargo.toml -- a b`). Every Verify below is written that way.

This module implements `OmpPort` and the `SidecarHandle` trait, and emits the frozen `SidecarEvent` variants. It may not add, rename or reshape any of them.

## Files (owned)

- `src-tauri/src/omp/mod.rs` (the `OmpPort` implementation from Phase 2; fill the bodies)
- `src-tauri/src/omp/ipc.rs` (handlers: `stats:fetch`, `bench:run`, `bench:abort`; stream `stats:data`)
- `src-tauri/src/omp/supervisor.rs` (the `run` stub from Phase 2; fill the body)
- Create inside the directory as needed: `manager.rs`, `rpc_bridge.rs`, `rpc_client.rs`, `event_batcher.rs`, `shell_env.rs`, `proxy.rs`, `stats.rs`, `stats_restart_policy.rs`, `bench.rs`

## Tasks

### Task 3.1: NDJSON framing and chunk reassembly
- Goal: a Rust port of `src/main/rpc-bridge.ts` that turns sidecar stdout bytes into JSON frames.
- Target: `rpc_bridge.rs` (`ChunkReassembler`, `attach_ndjson_parser`, `RPC_MAX_FRAME_BYTES`, `RPC_MAX_REASSEMBLED_BYTES`, `supports_rpc_protocol_v2`).
- Steps:
  1. Read `src/main/rpc-bridge.ts` and `src/main/rpc-bridge.test.ts` in full.
  2. Port the same limits (frame and reassembled byte caps), the base64 chunk fields (`chunkId`, `index`, `count`) and the error behavior for over-limit or out-of-order chunks.
  3. Read lines with `tokio::io::BufReader::lines` over `ChildStdout`, enforcing the frame cap before parsing.
  4. Port the 3 tests.
- Success criteria: chunked frames reassemble in order; an oversize frame is rejected the same way as in TS.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml omp::rpc_bridge` exits 0 with `3 passed` or more.

### Task 3.2: Request correlation and event batching
- Goal: ports of `rpc-client.ts` (id correlation, per-command timeouts, fire-and-forget) and `event-batcher.ts` (32 ms batches, 1,000-entry buffer cap, drop under backpressure).
- Target: `rpc_client.rs`, `event_batcher.rs`.
- Steps:
  1. Keep `DEFAULT_TIMEOUT_MS = 8_000` as in the TS source (private to `rpc_client.rs`). The batch constants are frozen in `ports.rs:477-478`: use `ports::BATCH_INTERVAL_MS` (32) and `ports::MAX_BUFFER_SIZE` (1000); do not redefine them.
  2. Per-command timeouts come from the renderer (`timeoutMs` in the `rpc:command` payload, computed by `RPC_COMMAND_TIMEOUTS` in `src/shared/rpc-client.ts`). `tabs` passes it as the `timeout_ms` argument of `SidecarHandle::request(command, timeout_ms: Option<u64>)`; `None` means `DEFAULT_TIMEOUT_MS`. Do not duplicate that table in Rust. A timeout returns `SidecarError::Timeout { timeout_ms, command_type }`, whose `Display` is already the TS text `RPC timeout (<ms>ms): <type>` (`ports.rs:393-395`).
  3. Implement the frozen `EventBatcher` trait and return it from `OmpPort::new_event_batcher(flush)`. The manager (Task 3.4) batches its own agent session events with one of these and sends each flush as one `SidecarEvent::Events(Vec<Value>)` (`ports.rs:408, 480-482`), so `tabs` forwards those batches unchanged and never batches `rpc:events` a second time.
  4. Write tests with `tokio::time::pause()`: `responds by id`, `times out with the same error message as TS`, `batches within one interval`, `drops oldest beyond the cap`.
- Success criteria: tests pass.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- omp::rpc_client omp::event_batcher` exits 0.

### Task 3.3: Spawn environment (shell env and proxy)
- Goal: `OmpPort::spawn_env(&self)` (`ports.rs:499`) returns the same environment overlay as Electron, and `OmpPort::resolve_editor_command(&self)` (`ports.rs:501`) the same editor command. `services` (editor `PATH`, `editor.ts:34`) and `ollama` (`base-url.ts:7`, `probe.ts:9`) call these through `ctx.omp`.
- Target: `shell_env.rs` (port `src/main/shell-env.ts` exactly: `$SHELL -ilc` probe between `__OMP_ENV_BEGIN__`/`__OMP_ENV_END__`, 4 s timeout, cached, `OVERLAY_DENYLIST`, Windows static fallback list, `resolve_editor_command`), `proxy.rs` (port the chain in `src/main/index.ts:208-227`: GUI pref `proxyUrl` → inherited `PI_PROXY`/`HTTPS_PROXY`/… → macOS system proxy → none).
- Steps:
  1. Port `shell-env.ts` and its 7 tests. The cache lives in the `Omp` struct (or a private `OnceCell` in `shell_env.rs`), shared by every caller of `spawn_env`.
  2. The GUI pref comes from the context the constructor received: inside `spawn_env(&self)`, `self.ctx()` (the stub's `self.ctx.upgrade()`) then `ctx.prefs.get_string("proxyUrl")`. When the context is gone (shutdown), skip the pref step.
  3. Linux system proxy: Electron's `session.resolveProxy` covered GNOME/KDE settings (`index.ts:211-233`). Use the `org.freedesktop.portal.ProxyResolver` portal through `ashpd` 0.11 (`Cargo.toml` enables only its `tokio` feature; 0.11 has no per-portal features) with a `lookup` of `https://example.com`, and map a `direct://` answer to no proxy. Windows (WinHTTP) and macOS (`scutil --proxy`, PAC) are implemented in Phase 12, when those OSes switch. Until then their `cfg` branches return `None` and write one entry with `runtime_log::note("unknown", "system proxy lookup is not implemented on this OS", json!({}))`. They are not `todo!()`.
  4. Set the same keys Electron sets: `PI_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and their lowercase forms. Remove `APPIMAGE_EXIT_AFTER_INSTALL` from the environment passed to every child.
- Success criteria: the shell-env tests pass, and unit tests of `proxy::resolve` cover pref > env > system > none, with the portal faked and the pref read from a `testing::fake_ctx_cyclic` context.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- omp::shell_env omp::proxy` exits 0.

### Task 3.4: Sidecar manager
- Goal: `SidecarManager` reproduces `src/main/sidecar.ts`: spawn, status, request, side channel, restart and crash-loop handling, stderr tail, dispose.
- Target: `manager.rs`.
- Steps:
  1. Read `src/main/sidecar.ts` and `src/main/sidecar.test.ts` in full.
  2. Arguments: `["--mode", "rpc-ui"]`, then `--session <path>` when resuming (`SidecarOptions.resume_session_path` on the first start, the `restart` argument afterwards), otherwise `--no-auto-resume` for a fresh launch (`SidecarOptions.fresh`), then `--chat` when `kind == SessionKind::Chat`, then `SidecarOptions.extra_flags`, then the workspace's launch profile, all filtered by the same denylist (`stripDenylistedFlags`, `sidecar.ts:298-307`). Re-read `launchProfiles.<cwd>` from `ctx.prefs` on every spawn and every restart, as the `extra_flags` doc says (`ports.rs:376-379`): the manager reaches `ctx.prefs` through the `CtxRef` that `Omp::new` received, which `new_sidecar` hands to each manager.
  3. Environment: the process env, overlaid with `spawn_env` (Task 3.3), plus `PI_RPC_EMIT_TITLE=1`, `PI_NO_PTY=1`, `PI_NOTIFICATIONS=off`, `PI_OLLAMA_API=ollama-chat` (`sidecar.ts:326-331`). `SidecarOptions` has no environment field, so the manager applies `spawn_env` itself; callers never pass it.
  4. Spawn through the supervisor (Phase 2 → Design → Sidecar supervisor topology), never omp directly on Linux and macOS: `tokio::process::Command::new(std::env::current_exe()?)` with `ports::SUPERVISOR_ARGV` first, then `SidecarOptions.binary_path` (the caller fills it from `paths::resolve_bundled_omp()`, or leaves it empty when that fails, as `index.ts:358` passes `bundledOmp ?? ""`; an empty or missing path reports the missing-binary error as `sidecar.ts` does) and the arguments from step 2; piped stdio; the omp-side end of a `socketpair` dup'd to fd 3 in `pre_exec` (one of the module's two `unsafe` sites), the GUI-side end kept in the handle; the environment from step 3 (omp inherits it from the supervisor). `SidecarHandle::start()` can be called from the main thread (desktop's window spawn path), so `start()` does the spawn and every reader/writer task inside the spawning helper from Wave rules (`Handle::try_current()`, else `tauri::async_runtime::spawn`), never with bare `tokio::spawn` or a direct `Command::spawn` on the caller's thread. Keep the stdin handle open for the child's lifetime. `request(command, timeout_ms)` queues the frame on stdin before it returns and returns a `BoxFuture<'static, …>` that awaits the correlated response (`ports.rs:456-459`). Read the `pid <n>` line from the control channel once and store it for `omp_pid()`; `supervisor_pid()` is the child's pid. `kill()` closes the GUI-side end of the control channel and sends SIGTERM to the supervisor (`nix::sys::signal::kill`) before it returns; the returned `BoxFuture<'static, ()>` resolves when the supervisor has exited (`ports.rs:466-470`; `dispose()` is `kill` plus no further restarts or events). The supervisor runs the frozen sequence (SIGTERM omp, 5 s, SIGKILL group, sweep) and exits with omp's status, which the manager reads from `wait()` as before (`sidecar.ts:614-622` sent SIGTERM so the agent runs its session teardown; that still happens, one hop down). Wait at most 8 s for the supervisor to exit, then SIGKILL it and log. On Windows (until Phase 12 adds the Job Object), spawn omp directly and stop it with `Child::kill`.
  5. Restart policy: `MAX_RESTART_ATTEMPTS = 3`, `RESTART_DELAYS = [1000, 2000, 4000]` ms, `STDERR_TAIL_LINES = 20`, `STDERR_REASON_CHARS = 240`. Report failures through `runtime_log::write(&report, None, Some(cwd))` with `source: "sidecar-restart"` and the same details as `index.ts:356-375`.
  6. Events leave through the `SidecarEvents` receiver that `OmpPort::new_sidecar(options)` returns next to the handle (`ports.rs:441, 496`), as the frozen `SidecarEvent` variants (`ports.rs:405-438`): `Status`, `Events` (batched by the manager through `new_event_batcher`, Task 3.2 step 3), `Stderr`, `Frame`, `ExtensionUi`, `HostToolCall`, `HostUriRequest`, `SubagentFrame`, `CommandsUpdate`, `ModelCatalogUpdate`, `ConfigUpdate`, `PromptResult`, `CommandOutput`, `SessionInfoUpdate`, `ExtensionError`, `LiveUpdate`, one for every event `sidecar.ts:191-202, 399-494` emits.
  7. Port the 12 tests. Where a test used a fake child process, spawn the real fixture `e2e/sidecar-fixture.ts` through `bun` (on `PATH` both locally and in CI); the fixture runs under the supervisor like omp does. Do not mark tests `#[ignore]`, and do not skip them at runtime.
- Success criteria: tests pass; dispose leaves no child process, supervisor included.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml omp::manager` exits 0 and prints `test result: ok`, then `pgrep -f "sidecar-fixture"` and `pgrep -f -- "--omp-supervise"` both print nothing.

### Task 3.4b: Sidecar supervisor
- Goal: `omp::supervisor::run` implements the frozen topology, and the Phase 0 S7b gate is a test that runs on every `cargo test`.
- Target: `supervisor.rs`. Source material: `../worktrees/tauri-spike/spike-tauri/src-tauri/src/s7.rs` (`run_supervise`), which has the sequence but no error handling.
- Steps:
  1. `run(args)` (frozen signature `pub fn run(args: Vec<OsString>) -> ExitCode`, called by `main.rs` before Tauri starts): `args[2..]` is omp's command line. No Tauri runtime exists in this process, so `run` builds its own `tokio::runtime::Builder::new_current_thread().enable_all()` runtime and `block_on`s the loop below. In this process `nix` wraps the process calls: `setsid()`, `prctl(PR_SET_CHILD_SUBREAPER, 1)`, `prctl(PR_SET_PDEATHSIG, SIGTERM)`, then check `getppid()` once, because the parent may have died between fork and prctl. Take fd 3 as the control channel with the module's second allowed `unsafe` (Wave rules): one `unsafe { OwnedFd::from_raw_fd(3) }` with a `// SAFETY:` comment stating that the manager's `pre_exec` installed fd 3 and nothing else in this process owns it. That call is the only place the number 3 appears.
  2. Spawn omp with `tokio::process::Command`, `Stdio::inherit()` for all three streams, `process_group(0)`, and the inherited environment. Write `pid <n>\n` to the control channel. Never write to stdout. Write to stderr only on failure, prefixed `supervisor:`, and ignore `EPIPE`. Gate 6 of `check-module.sh` rejects `std::process::Command` and `std::thread::sleep` in this file too, so use `tokio::process` and `tokio::time` on the runtime from step 1.
  3. Wait on three futures at once: omp exiting, SIGTERM (`tokio::signal::unix`), and the control channel reaching EOF. If omp exits first, exit with its status after one orphan sweep. Otherwise run the shutdown sequence: SIGTERM omp, wait up to 5 s, SIGKILL omp's process group, then sweep: read `/proc/[0-9]*/stat`, SIGKILL every pid whose ppid is this process, `waitpid(-1, WNOHANG)` until it returns nothing, repeat until a pass kills nothing or 2 s have elapsed; exit with omp's status (`ExitCode::from(143)` when it died on SIGTERM, the kernel-reported signal otherwise mapped to `128 + signal`).
  4. macOS (`cfg(target_os = "macos")`): the same loop with the control channel and SIGTERM only; `setsid` applies, the two `prctl` calls and the `/proc` sweep are Linux-only and compile out. Phase 12 adds kqueue `NOTE_EXIT` and the `proc_listchildpids` snapshot there. Windows does not compile this file into the spawn path (Phase 12 uses a Job Object).
  5. Tests (`#[cfg(all(test, target_os = "linux"))]`, using `/usr/bin/sleep` and `bash` as stand-ins so no agent is needed):
     - `control channel eof kills the child tree within 10 s`: spawn the supervisor around `bash -c 'setsid /usr/bin/sleep 600 & exec /usr/bin/sleep 600'` (the `setsid` child stands in for a tool that left omp's process group); drop the GUI-side end; poll `/proc` until neither `sleep` exists; assert it took under 10 s.
     - `sigterm runs the grace period before the kill`: the omp stand-in is `bash -c 'trap "sleep 1; exit 143" TERM; /usr/bin/sleep 600 & wait'`; send SIGTERM to the supervisor; assert the supervisor exits with 143 between 1 s and 5 s, and that the orphaned `sleep` is gone.
     - `sigkill of the parent kills the child tree within 10 s` (the S7b gate): the test re-runs its own binary as a stand-in GUI (`std::env::current_exe()` with `--exact <helper test name> --nocapture` and `SAI_ATLAS_TEST_ROLE=gui`; the helper test, when it sees the variable, spawns the same `bash` tree through `SidecarManager::spawn` and sleeps); the test reads the child pids from the helper's stdout, `kill -9`s the helper, and asserts that supervisor, stand-in omp and both `sleep` processes are gone within 10 s.
- Success criteria: the three tests pass on this machine and in CI, and a manual `kill -9` of the dev app leaves no `omp --mode rpc-ui` behind.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml omp::supervisor` exits 0 with `3 passed`, then `pgrep -f "/usr/bin/sleep 600"` prints nothing. Manual: start `bun run dev:tauri -- --user-data-dir=$(mktemp -d)` through the background runner (`test -x resources/omp` first), open one tab, run `!/usr/bin/sleep 600` in it, `kill -9 <tauri pid>`; within 10 s `pgrep -f "omp --mode rpc-ui"`, `pgrep -f -- "--omp-supervise"` and `pgrep -f "/usr/bin/sleep 600"` all print nothing. Stop anything left (the dev server).

### Task 3.5: Stats server and benchmark runner
- Goal: ports of `stats-server.ts`, `stats-client.ts`, `stats-restart-policy.ts` and `benchmark-runner.ts`, plus the three handlers.
- Target: `stats.rs`, `stats_restart_policy.rs`, `bench.rs`, `ipc.rs`.
- Steps:
  1. State: the bench runs and the stats server live in the `Omp` struct. The three handlers in `ipc.rs` reach them with `ctx.omp.as_any().downcast_ref::<omp::Omp>()`, and `OmpPort::shutdown` (frozen order step 3) uses the same struct. Bench runs are keyed by `Caller.win_id`. Resolve the run's cwd with `ctx.tabs.cwd_for(caller, None)`, and abort a window's run when the window closes: in `omp::init(ctx, app)`, register `ctx.desktop.on_window_closed(Box::new(…))` with a closure that captures `Arc::downgrade(ctx)` and reads `WindowRecord.id` (`ipc.ts:358, 368-374, 773-782`).
  2. Stats: spawn `omp stats --host 127.0.0.1 --port 0 --no-open` on first `stats:fetch`, using `paths::resolve_bundled_omp()` for the binary and `spawn_env` for the environment; find the port in stdout with `http://localhost:(\d+)`; restart budget per `stats-restart-policy.ts` (3 attempts). Fetch over loopback with `reqwest` 0.12 (features `json`, `stream`, `rustls-tls`; do not use 0.13 APIs). The handler returns `Reply::Later`. Kill the server in `OmpPort::shutdown`.
  3. Bench: spawn `omp bench <model> --profile <p> --json` with the same binary and with `spawn_env` (TS `deps.benchmarkEnv()`), 8 MiB output cap, 15 min timeout, parse the same JSON summary the zod schema in `benchmark-runner.ts` accepts (serde struct with `camelCase`), reply through `Reply::Later`, refuse with `IpcError::new(<TS message>)`, abort on `bench:abort`.
  4. Port the tests (`stats-server` 4, `stats-restart-policy` 6, `benchmark-runner` 3). Handler tests use `testing::fake_ctx_cyclic` with the real `Omp` installed and `bridge::dispatch_for_test`; the window-closed abort test calls `fakes.desktop.close(WindowId(n))`.
- Success criteria: tests pass; `stats:fetch` against the fixture's stats mode returns the fixture JSON.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- omp::stats omp::bench` exits 0.

### Task 3.6: Module gate and commit
- Steps:
  1. Run the gate.
  2. Check the `unsafe` budget, which the gate does not scan: `grep -rnw unsafe src-tauri/src/omp --include=*.rs | grep -vE '^[^:]+:[0-9]+:\s*//'` (comment lines excluded) lists exactly two code lines, the `pre_exec` block in `manager.rs` and the `from_raw_fd(3)` call in `supervisor.rs`.
  3. Commit in the worktree: `feat(gui): run omp child processes from the Tauri core`.
- Verify: `bash scripts/check-module.sh omp` exits 0 and its last line is `check-module omp: PASS`, and the step 2 `grep` prints exactly two lines, one in `manager.rs` and one in `supervisor.rs`.

## Status report

End with:

```text
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Summary: one or two sentences
Concerns/Blockers: list the proxy branches and the macOS/Windows sidecar-stop branches deferred to Phase 12
```

`DONE` is invalid unless `check-module.sh omp` passed.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
