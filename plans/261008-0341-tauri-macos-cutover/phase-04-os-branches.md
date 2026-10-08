---
phase: 4
title: "OS branches: supervisor, proxy, GPU and RAM"
status: completed
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 4: OS branches: supervisor, proxy, GPU and RAM

## Goal

No macOS branch in the Rust core is still a placeholder.
- The supervisor's tests run on macOS, and a hard kill of the GUI takes the whole tool tree with it.
- The system proxy comes from `scutil --proxy`.
- The GPU name comes from `system_profiler`, and RAM from `sysctl hw.memsize`, so Ollama sizing works on Macs.

## Context

- `src-tauri/src/omp/supervisor.rs`:
  - `mod unix` (lines 64-332). Its Linux-only parts are `prctl` (95-103), `reap_orphans` (277-294) and `live_children_of_self` (306-331, which returns empty off Linux).
  - The tests module is `#[cfg(all(test, target_os = "linux"))]` (line 334). It uses `/proc` helpers (`alive`, `cmdline`, `ppid`, `sleeps_under`), `SLEEP_BIN = "/usr/bin/sleep"` and `TOOL_TREE` with the `setsid` binary, which macOS does not ship.
  - `manager.rs` re-executes the test binary into `omp::supervisor::tests::supervisor_role_helper` (`TEST_SUPERVISOR_HELPER`, line 28), so that helper must exist on macOS.
  - On macOS, orphans reparent to launchd, not to the supervisor. So the existing sweep finds nothing, and a tool that left omp's process group survives the `killpg`.
  - `unsafe` is allowed in this file, with a `// SAFETY:` comment.
- `nix` has the `event` feature (`src-tauri/Cargo.toml`, `[target.'cfg(unix)'.dependencies]`), so `nix::sys::event` (kqueue) is available. `libc = "0.2"` is a unix dependency.
- `src-tauri/src/omp/proxy.rs:102-106` is the non-Linux placeholder. `lookup_system_proxy` returns `Option<String>` (a URL like `http://host:port`).
- `src-tauri/src/ollama/hardware.rs:105-113` `gpu_name_other_os` is a placeholder. `sysinfo_totalmem` (144-161) returns `0` off Linux, so `read_machine` (244-259) returns `None` on macOS. `default_deps` (115-142) chooses `read_gpu_name_linux` only on Linux.
- New items are `pub(crate)` so `src-tauri/contracts/omp.api.txt` and `ollama.api.txt` do not change.

## Files

- Modify: `src-tauri/src/omp/supervisor.rs`, `src-tauri/src/omp/proxy.rs`, `src-tauri/src/ollama/hardware.rs`

## Tasks

### Task 4.1 — Red: run the supervisor tests on macOS
- Goal: the Linux tool-tree tests compile and run on macOS, and fail where the macOS port is missing.
- Target files: `src-tauri/src/omp/supervisor.rs`, `mod tests`.
- Steps:
  1. Change `#[cfg(all(test, target_os = "linux"))]` on `mod tests` to `#[cfg(all(test, unix))]`.
  2. Make the helpers per-OS, leaving the test bodies unchanged:
     - `SLEEP_BIN`: `"/usr/bin/sleep"` on Linux and `"/bin/sleep"` on macOS.
     - `alive(pid)` on macOS: `nix::sys::signal::kill(Pid::from_raw(pid as i32), None).is_ok()`, and the process is not a zombie (`ps -o stat= -p <pid>` does not start with `Z`).
     - `cmdline(pid)` on macOS: `ps -o command= -p <pid>`, split on whitespace.
     - `ppid(pid)` on macOS: `ps -o ppid= -p <pid>`, trimmed and parsed.
     - `sleeps_under(parent)` on macOS: parse `ps -axo pid=,ppid=,command=` and keep the rows where `ppid == parent` and `command == "<SLEEP_BIN> 600"`.
  3. `TOOL_TREE` on macOS: `"set -m; /bin/sleep 600 & exec /bin/sleep 600"`. Job control gives the background sleep its own process group, which is the macOS stand-in for `setsid`: a tool that left omp's group. Linux keeps its string.
  4. Gate `an_orphan_that_exits_is_reaped_while_omp_runs` with `#[cfg(target_os = "linux")]` and the comment "subreaper-only: macOS reparents orphans to launchd".
  5. Add the test `a_dead_parent_ends_supervision_even_when_the_control_channel_stays_open` (both OSes):
     - Clone `sigkill_of_the_parent_kills_the_child_tree_within_10_s`, but the stand-in GUI (new role `gui-leak` in `gui_role_helper`) also spawns `SLEEP_BIN 600` after clearing `FD_CLOEXEC` on `supervised.control_write` with `nix::fcntl::fcntl(&fd, FcntlArg::F_SETFD(FdFlag::empty()))`. That sleep holds the control channel open after the GUI dies.
     - The role prints `tree <supervisor> <omp> <holder>`.
     - The test SIGKILLs the GUI and asserts the supervisor, omp and tool are gone within 10 s.
     - It always kills `holder` at the end.
     - This test proves the second parent-death signal (Linux: `PR_SET_PDEATHSIG`; macOS: kqueue `NOTE_EXIT`).
  6. Add the test `an_escaped_tool_dies_when_omp_exits_on_its_own` (both OSes): the stand-in omp starts the macOS/Linux `TOOL_TREE` escaped tool, waits 1.5 s, then exits 0 by itself (no signal from the supervisor). Assert the supervisor exits with omp's status and the escaped `SLEEP_BIN 600` is gone within 10 s. Always kill any survivor at the end.
- Success criteria: the module compiles on macOS, and the failing tests are the ones that need the port.
- Verify (red): `cargo test --manifest-path src-tauri/Cargo.toml --all-features omp::supervisor` exits non-zero, and the failures include `sigkill_of_the_parent_kills_the_child_tree_within_10_s` (the tool survives) and `a_dead_parent_ends_supervision_even_when_the_control_channel_stays_open` and `an_escaped_tool_dies_when_omp_exits_on_its_own`. All passing is a failure of this task: STOP and report it, because the tests would not prove the port.

### Task 4.2 — Green: kqueue parent watch and descendant snapshot
- Goal: the supervisor tests pass on macOS, and Linux behavior is unchanged.
- Target files: `src-tauri/src/omp/supervisor.rs`, `mod unix`.
- Steps:
  1. Add `#[cfg(target_os = "macos")] async fn parent_exit(parent: Pid)`. It resolves when `parent` exits, using `tokio::task::spawn_blocking`:
     - `let kq = nix::sys::event::Kqueue::new()?`.
     - Register `KEvent::new(parent.as_raw() as usize, EventFilter::EVFILT_PROC, EventFlag::EV_ADD | EventFlag::EV_ONESHOT, FilterFlag::NOTE_EXIT, 0, 0)`.
     - Block in `kevent` with no timeout.
     - Check the exact constructor names in `~/.cargo/registry/src/*/nix-0.30*/src/sys/event.rs`.
     - If registration fails with `ESRCH` (the parent is already gone), resolve at once.
     - In `run`, capture `let parent = nix::unistd::getppid();` before `supervise` and pass it in.
  2. In `supervise`'s `tokio::select!`, add a macOS-only branch `_ = parent_exit(parent) => {}` (use a `#[cfg]`-selected future that is `std::future::pending()` on Linux, so the select stays one block).
  3. Add `#[cfg(target_os = "macos")] fn descendants_of(root: Pid) -> Vec<Pid>`:
     - Breadth-first over `libc::proc_listchildpids(pid, buf.as_mut_ptr().cast(), (buf.len() * size_of::<i32>()) as i32)` with a 4096-entry `i32` buffer. Each `unsafe` call carries a `// SAFETY:` comment: the buffer is valid for the byte length passed, and the returned count is clamped to it.
     - If `proc_listchildpids` is not in `~/.cargo/registry/src/*/libc-0.2*/src/unix/bsd/apple/mod.rs`, implement the same walk with `/usr/bin/pgrep -P <pid>` instead (no `unsafe`), and note it in the host log.
  4. Snapshot and kill:
     - Keep `let mut snapshot: Vec<Pid>` (macOS only) fresh while omp runs: add a `tokio::time::interval(Duration::from_millis(500))` arm to `supervise`'s `select!` that merges `descendants_of(omp)` into it (dedupe; keep pids that have since exited, the survivor check skips them). This is what covers the `child.wait()` arm, where omp exits on its own and no kill path runs.
     - Right before `kill(omp, SIGTERM)`, merge a fresh `descendants_of(omp)` into `snapshot`. Right before `killpg(omp, SIGKILL)` in the timeout branch, merge again.
     - After `child.wait()` returns, call `#[cfg(target_os = "macos")] kill_snapshot_survivors(&snapshot)`. It sends SIGKILL to every pid where `kill(pid, None).is_ok()`, re-checks every 20 ms within `SWEEP_BUDGET`, and returns when none is alive.
     - Linux keeps `sweep_orphans` unchanged. Make the `cfg` split explicit with two small `#[cfg]` blocks. Never change the Linux order.
  5. Replace the comment at line 327 ("arrives with that OS's cutover") with one sentence on why macOS uses the snapshot.
  6. Update the module doc (lines 1-15) with one sentence on the macOS parent watch and snapshot.
- Success criteria: green on macOS. On Linux, CI runs the same tests unchanged.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features omp::supervisor` exits 0, and the output contains `sigkill_of_the_parent_kills_the_child_tree_within_10_s ... ok` and `a_dead_parent_ends_supervision_even_when_the_control_channel_stays_open ... ok` and `an_escaped_tool_dies_when_omp_exits_on_its_own ... ok`. Afterwards `pgrep -f "/bin/sleep 600" || echo none` prints `none`.

### Task 4.2b — Un-gate the manager and shell_env tests
- Goal: the eight `omp::manager`/`omp::shell_env` tests Phase 1 gated to Linux (host log `gated:` lines naming Task 4.2b) run on macOS.
- Target files: `src-tauri/src/omp/test_support.rs` (shared `#[cfg(test)]` process-table helpers), `src-tauri/src/omp/manager.rs` (`launch_argv` and the gated tests/helpers), `src-tauri/src/omp/shell_env.rs`, the fixture or fake scripts where an environment dump is needed.
- Steps:
  1. Add process-table helpers to `test_support.rs`: `argv(pid)` (`ps -ww -o args= -p <pid>` off Linux, `/proc/<pid>/cmdline` on Linux), `alive(pid)`, `ppid(pid)`, `cwd(pid)` (`lsof -a -p <pid> -d cwd -Fn`, or the fixture's reported `get_state.cwd`). Task 4.1 step 2 uses the same helpers; write them once.
  2. Environment reads cannot come from `ps -E` (it prints nothing for a child on macOS): have the fixture or fake script dump `process.env` to a file the test reads.
  3. Port `launch_argv` and the `/proc` reads to the helpers, then remove the `#[cfg(target_os = "linux")]` attributes Phase 1 added (tests and the helpers/imports only they used).
  4. Append one `ungated: <test path>` line to the host log per test.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features -- omp::manager omp::shell_env` on the Mac (cargo takes one filter before `--`) prints `… ok` for each of the eight names; `grep -c 'cfg(target_os = "linux")' src-tauri/src/omp/manager.rs` prints `1` and `src-tauri/src/omp/shell_env.rs` prints `0`; every host-log `gated:` line naming Task 4.2b has an `ungated:` twin.

### Task 4.3 — Red: scutil parsing
- Goal: a failing test for the macOS proxy parser.
- Target files: `src-tauri/src/omp/proxy.rs`, `mod tests`.
- Steps: add `scutil_answers_map_to_agent_proxy_urls` (not `cfg`-gated: the parser is pure). It calls `scutil_proxy_to_url(text)` and expects these `ScutilProxy` results:
  1. `HTTPSEnable : 1`, `HTTPSProxy : proxy.corp`, `HTTPSPort : 8443`, `HTTPEnable : 1`, `HTTPProxy : other`, `HTTPPort : 80` → `ScutilProxy::Url("http://proxy.corp:8443".into())` (HTTPS wins).
  2. HTTP only (`HTTPEnable : 1`, `HTTPProxy : 10.0.0.2`, `HTTPPort : 3128`) → `Url("http://10.0.0.2:3128")`.
  3. `ProxyAutoConfigEnable : 1` with no HTTP(S) → `ScutilProxy::PacOnly`.
  4. Everything off, or empty text → `ScutilProxy::None`.
  5. `HTTPSEnable : 1` with no `HTTPSProxy` → `None`.
  Use the real `scutil --proxy` shape: `<dictionary> {` then `  Key : value` lines.
- Verify (red): `cargo test --manifest-path src-tauri/Cargo.toml --all-features scutil_answers_map_to_agent_proxy_urls` exits non-zero (`cannot find function` or `cannot find type`). Passing is a failure of this task.

### Task 4.4 — Green: the macOS proxy lookup
- Target files: `src-tauri/src/omp/proxy.rs`.
- Steps:
  1. Add `pub(crate) enum ScutilProxy { Url(String), PacOnly, None }`, `#[derive(Debug, PartialEq, Eq)]`, and `pub(crate) fn scutil_proxy_to_url(text: &str) -> ScutilProxy`. It reads `key : value` pairs and prefers HTTPS, then HTTP. The scheme is always `http://`: macOS proxies are HTTP CONNECT proxies.
  2. Replace the `#[cfg(not(target_os = "linux"))]` placeholder with two functions:
     - `#[cfg(target_os = "macos")] async fn lookup_system_proxy()`: run `/usr/sbin/scutil --proxy` through `tokio::process::Command` with a 2 s `tokio::time::timeout`, then map the result. `Url(u)` → `Some(u)`. `PacOnly` → write one `runtime_log::note("proxy", "a PAC-only system proxy is not supported; no proxy is used", json!({}))` guarded by a `std::sync::Once`, then `None`. `None`, or a failure → `None`.
     - `#[cfg(not(any(target_os = "linux", target_os = "macos")))]`: return `None` with no log line.
  3. Update the comment at lines 100-101.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features omp::proxy` exits 0. `grep -n "is not implemented on this OS" src-tauri/src/omp/proxy.rs` prints nothing.

### Task 4.5 — Red: GPU name and RAM parsers
- Target files: `src-tauri/src/ollama/hardware.rs`, `mod tests`.
- Steps: add two tests (pure, every OS):
  1. `reads_the_gpu_name_from_system_profiler`:
     - `gpu_name_from_system_profiler(r#"{"SPDisplaysDataType":[{"_name":"Apple M3 Pro","sppci_model":"Apple M3 Pro","sppci_cores":"18"}]}"#)` → `Some("Apple M3 Pro")`.
     - `sppci_model` wins over `_name` when they differ.
     - `"{}"`, `"not json"` and an empty array → `None`.
  2. `reads_total_memory_from_sysctl`: `parse_sysctl_memsize("38654705664\n")` → `Some(38654705664)`; `"0"`, `""` and `"abc"` → `None`.
- Verify (red): `cargo test --manifest-path src-tauri/Cargo.toml --all-features ollama::hardware` exits non-zero (missing functions). Passing is a failure of this task.

### Task 4.6 — Green: macOS GPU and RAM probes
- Target files: `src-tauri/src/ollama/hardware.rs` (`gpu_name_other_os`, `sysinfo_totalmem`, `default_deps`).
- Steps:
  1. Add `pub(crate) fn gpu_name_from_system_profiler(json: &str) -> Option<String>` (serde_json; first entry; `sppci_model` then `_name`; trimmed, non-empty).
  2. Add `pub(crate) fn parse_sysctl_memsize(text: &str) -> Option<u64>` (trimmed, parsed, > 0).
  3. Add `fn read_gpu_name_macos() -> BoxFuture<Result<Option<String>, String>>`. It runs `/usr/sbin/system_profiler SPDisplaysDataType -json` via `tokio::process::Command` and maps stdout with the parser. A spawn error is `Err(error.to_string())`. `read_machine` already wraps the call in `deps.timeout`.
  4. In `default_deps`, pick `read_gpu_name_linux` on Linux, `read_gpu_name_macos` on Darwin, and keep `gpu_name_other_os` for the rest. Change that function's log text to `"GPU name lookup is not available on this OS"`.
  5. In `sysinfo_totalmem`, add a `#[cfg(target_os = "macos")]` block: `std::process::Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output()`, then `parse_sysctl_memsize`, else `0`. Change the other branch to `#[cfg(not(any(target_os = "linux", target_os = "macos")))]`.
  6. Live check on the Mac: add a test `#[cfg(target_os = "macos")] #[tokio::test] async fn reads_this_macs_memory_and_gpu()` asserting `read_machine_default().await` is `Some` with `ram_bytes > 0`, `unified_memory == true` and `gpu_name.is_some()`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features ollama::hardware` exits 0, and `grep -rn "is not implemented on this OS" src-tauri/src` prints nothing.

### Task 4.7 — Regression gate and commit
- Steps: run regression gate 1–7. Commit `feat(macos): end the sidecar tree when the app dies and read proxy, GPU and memory` (or split into three commits, one per file).
- Verify: all gate commands exit 0. `bash scripts/check-module.sh snapshots` prints `check-module snapshots: PASS`.

## Test matrix

| Test | File | OS | Red | Green |
|---|---|---|---|---|
| `control_channel_eof_kills_the_child_tree_within_10_s` | supervisor.rs | Linux + macOS | — (may already pass) | 4.2 |
| `sigterm_runs_the_grace_period_before_the_kill` | supervisor.rs | Linux + macOS | 4.1 | 4.2 |
| `sigkill_of_the_parent_kills_the_child_tree_within_10_s` | supervisor.rs | Linux + macOS | 4.1 | 4.2 |
| `a_dead_parent_ends_supervision_even_when_the_control_channel_stays_open` | supervisor.rs | Linux + macOS | 4.1 | 4.2 |
| `an_orphan_that_exits_is_reaped_while_omp_runs` | supervisor.rs | Linux only (subreaper) | — | — |
| `scutil_answers_map_to_agent_proxy_urls` | proxy.rs | all | 4.3 | 4.4 |
| `reads_the_gpu_name_from_system_profiler`, `reads_total_memory_from_sysctl` | hardware.rs | all | 4.5 | 4.6 |
| `reads_this_macs_memory_and_gpu` | hardware.rs | macOS | — | 4.6 |
| Packaged hard kill | `scripts/tauri-mac-smoke.ts` | macOS | Phase 3 | Phase 6 |

## Regression gate

Plan regression gate items 1–7.

## Rollback

Revert the commits. The Linux code paths are unchanged, which is checked by CI's Linux `cargo test`.

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

