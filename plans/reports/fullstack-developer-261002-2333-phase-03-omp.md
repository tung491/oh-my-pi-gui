# Phase 3 report: omp child processes (module `omp`)

- Plan: `/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/phase-03-omp-processes.md`
- Worktree: `/home/tung491/WORK/worktrees/tauri-omp`, branch `tauri/omp`, base `10cf8a5`
- Status: completed (`check-module omp: PASS`); not pushed, not merged
- Commits (in order): `622e96f`, `6ddb8c9`, `6db3766`, `0bd445d`

## Per task

### Task 3.1: NDJSON framing and chunk reassembly — commit `622e96f`
- Files: `src-tauri/src/omp/rpc_bridge.rs` (new), `mod.rs` (module registration).
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml omp::rpc_bridge` → exit 0, `4 passed` (3 parity twins plus one parser test covering blank, oversize and chunked lines).
- Note: the line reader discards an oversize line without buffering it, so the frame cap bounds memory as well as parse size.

### Task 3.2: Request correlation and event batching — commit `6ddb8c9`
- Files: `rpc_client.rs`, `event_batcher.rs` (new); `Omp::new_event_batcher` filled.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- omp::rpc_client omp::event_batcher` → exit 0, `6 passed` (`responds_by_id`, `times_out_with_the_same_error_message_as_ts`, `batches_within_one_interval`, `drops_oldest_beyond_the_cap`, plus two more), all under `tokio::time::pause`.
- Deviation: the TS `RpcClient.fire` (fire-and-forget) has no caller in `src/main` and was dropped because the gate's clippy `-D warnings` rejects dead code; `request` covers every GUI use.
- Note: `drops_oldest_beyond_the_cap` carries the prescribed name but asserts the frozen TS semantics (`ports.rs:476`): over the 1,000 cap the incoming `tool_execution_update` is dropped, never a lifecycle event.

### Task 3.3: Spawn environment (shell env and proxy) — commit `6db3766` (shared with 3.4/3.4b, see below)
- Files: `shell_env.rs`, `proxy.rs` (new); `Omp::spawn_env`, `Omp::resolve_editor_command`, `Omp::proxy_env`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- omp::shell_env omp::proxy` → exit 0, `13 passed` (7 shell-env parity twins, 6 proxy tests: pref > env > system > none, portal URL mapping, and the pref read from a `fake_ctx_cyclic` context through `Omp::set_system_proxy_for_test`).
- First run FAILED (Failure Protocol followed, see "kongming consultations" #1), then passed after the counsel's remedy.
- Deviations: the Linux portal lookup has a 3 s timeout (Electron's `resolveProxy` had none) so a hung portal cannot delay a spawn; `socks://` from the portal maps to `socks5://`. The shell probe cache lives in `Omp` (`tokio::sync::OnceCell`), shared by every caller.

### Task 3.4: Sidecar manager — commit `6db3766`
- Files: `manager.rs` (new), `Omp::new_sidecar`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml omp::manager` → exit 0, `test result: ok. 14 passed` (12 parity twins + `strips_denylisted_flags_pair_aware` + `dispose_stops_the_supervisor_and_the_fixture`). `pgrep -f "sidecar-fixture"` and `pgrep -f -- "--omp-supervise"` printed nothing of mine (my first combined run matched only the pgrep shell's own command line; re-run with self-safe patterns: empty).
- Deviations and notes:
  - Fixture use: tests that only need a protocol peer (argv, cwd, env, ready, dispose) run the real `e2e/sidecar-fixture.ts` under the supervisor and read argv/cwd/env from `/proc/<omp pid>`; tests whose TS twin scripted a crash (boot crash, stderr tail, pid file) write the same inline bun script into a temp dir, as the TS tests did, because the frozen fixture cannot reproduce those behaviours.
  - The crash report seam is a `FailureReporter` (TS `reportFailure`); production writes `runtime_log::write` with `source: "sidecar-restart"`; the test captures reports directly.
  - stderr is kept per chunk (trim, split into lines), matching the TS ring.
  - Lib unit tests cannot re-exec `main.rs`, so under `#[cfg(test)]` the manager launches the supervisor as a helper test of the test binary (`--exact omp::supervisor::tests::supervisor_role_helper` plus `TEST_HARNESS_ARGS`), with omp's argv in `SAI_ATLAS_TEST_SUPERVISE_ARGV`. Production uses `current_exe() --omp-supervise …` unchanged.

### Task 3.4b: Sidecar supervisor — commit `6db3766`
- Files: `supervisor.rs` (body filled; `run` signature unchanged).
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml omp::supervisor` → exit 0, `6 passed` (the three prescribed tests, the two role helpers, and the guard test `the_test_relaunch_keeps_omp_stdout_line_aligned` from kongming). `pgrep -f "/usr/bin/sleep 600"` printed nothing of mine.
- The S7b gate (`sigkill_of_the_parent_kills_the_child_tree_within_10_s`) passes: supervisor, omp stand-in and the `setsid` tool child are gone well within 10 s.
- Parent-gone check: `getppid() == 1` plus a zero-timeout poll of the control channel for EOF (on this host orphans reparent to the user `systemd`, not pid 1).
- **NEEDS-HUMAN (manual part of the Verify):** cannot be run in this worktree because `tabs::acquire` is still the Phase 2 `todo!()` stub here, so no tab can spawn a sidecar until the wave merges. Steps for the integration branch: `test -x resources/omp`; start `bun run dev:tauri -- --user-data-dir=$(mktemp -d)` through the background runner and note the Tauri pid; open one tab; run `!/usr/bin/sleep 600` in it; `kill -9 <tauri pid>`; within 10 s `pgrep -f "omp --mode rpc-ui"`, `pgrep -f -- "--omp-supervise"` and `pgrep -f "/usr/bin/sleep 600"` must all print nothing; then stop the dev server.

### Task 3.5: Stats server and benchmark runner — commit `0bd445d`
- Files: `stats.rs`, `stats_restart_policy.rs`, `bench.rs` (new), `ipc.rs` (handlers), `mod.rs` (state, `shutdown`, `init` → `register_listeners`).
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- omp::stats omp::bench` (run as `-- omp::stats omp::bench omp::ipc`) → exit 0, `23 passed` (stats-server 4, stats-restart-policy 6, benchmark-runner 3 parity twins, plus handler tests including `stats_fetch_returns_the_fixture_json` and `closing_a_window_aborts_its_bench_run` via `fakes.desktop.close(WindowId(1))`).
- First run FAILED on my own over-assertion (Failure Protocol followed, see "kongming consultations" #2), then passed.
- Deviations: `bench:run` keeps the TS wire shape (`{success:false,error}` for "Bundled omp is unavailable" / "No active workspace" / arg validation) and uses `IpcError::bad_payload` only for an undecodable payload, because the renderer reads `result.success`. `stats:data` is listed in `EMITS` but neither the TS main process nor the renderer emits or consumes it, so nothing streams it. `Omp::shutdown` empties the stats slot; a `stats:fetch` after shutdown would rebuild the server where the TS answered "exhausted" — unreachable under the frozen shutdown order and noted in a code comment (kongming #2). `reqwest` is built with `.no_proxy()` so loopback stats reads never go through a proxy env var. `init` runs the startup `statsClient.probe()` the TS did (`index.ts:522`).

### Task 3.6: Module gate
- `bash scripts/check-module.sh omp` → exit 0, last line `check-module omp: PASS`; gate 9 printed two WARNs (no Apple/MSVC SDK on this host), as the phase predicts.
- `grep -rnw unsafe src-tauri/src/omp --include=*.rs | grep -vE '^[^:]+:[0-9]+:\s*//'` → exactly two lines: `supervisor.rs:106` (`OwnedFd::from_raw_fd(3)`) and `manager.rs:330` (the `pre_exec` block), each with a `// SAFETY:` comment.
- The phase's prescribed commit message was split across the four task commits above (commit-per-task was requested by the controller); no single "run omp child processes" commit exists.

## Completion check per phase
- Tree clean; `git diff --name-only 10cf8a5` lists only `src-tauri/src/omp/*` (12 files, +4600/−31); `git diff 10cf8a5 -- src-tauri/contracts` empty.
- `cargo test --manifest-path src-tauri/Cargo.toml --all-features` → 141 lib tests + 2 `channels` tests pass.
- `bun scripts/check-test-parity.ts omp` → `35 tests mirrored across 6 files`.
- No `todo!`, `unimplemented!`, `#[ignore]`; no `tauri_plugin_` call; no cross-module `downcast_ref` (only `ctx.omp…downcast_ref::<Omp>()` on the module's own port); `grep -c runtime_log src-tauri/src/omp/supervisor.rs` → 0.
- Baseline untouched: `prefs.json` mtime `2026-10-02 12:00:17.869` and `logs/gui-runtime.jsonl` mtime `2026-10-02 23:29:09.083` both before and after; no `dpkg`/`apt`; `~/.local/share/applications/vn.io.vif.saiatlas.desktop` does not exist.

## kongming consultations (Failure Protocol)
1. Task 3.3 Verify: `injects_the_shellenv_overlay_into_the_spawned_process` timed out. Evidence from a read-only probe: libtest's pretty formatter writes `test <name> ... ` with no newline before the helper body when `--test-threads=1`, so omp's first NDJSON frame was glued to the harness prefix and dropped by the parser. Counsel: one shared `TEST_HARNESS_ARGS = ["--nocapture", "--test-threads=1", "--quiet"]` in `supervisor.rs` used by both re-exec sites, a fast guard test, and a `module_path!()` check on the helper name. Applied; both the 3.3 and the S7b tests then passed.
2. Task 3.5 Verify: `stats_fetch_returns_the_fixture_json` asserted a post-shutdown reply ("not running") that neither the TS source nor the frozen shutdown order requires. Counsel: drop that assertion, assert instead that `shutdown()` leaves no fixture process, and record the post-kill slot deviation as a comment. Applied.

## Processes
Started and stopped (all by PID or by the tests' own teardown; none survive): the test-spawned fixtures, inline bun stand-ins, `bash`/`/usr/bin/sleep 600` trees and test-binary role helpers; two hand probes of the supervisor role (python socketpair harness, exited 0 / 143); the clippy and cargo test runs. No dev app was started; port 5184 was never bound. Final sweep: `pgrep` for `omp --mode rpc-ui`, `--omp-supervise`, `sidecar-fixture`, `/usr/bin/sleep 600` and the role helpers prints nothing.

## Interruptions
Two rate-limit cuts; both resumed from the committed state with no lost work (the second resume found remedy (a) already committed as `0bd445d`).

Status: DONE_WITH_CONCERNS
Summary: Module `omp` is fully ported on `tauri/omp` (4 commits, tip `0bd445d`): every Task Verify passes as written, `check-module omp: PASS`, 141+2 tests under `--all-features`, parity 35/35, two `unsafe` sites, baseline untouched. The S7b orphan gate passes as a Rust test; the Task 3.4b on-screen `kill -9` check is NEEDS-HUMAN on the integration branch because tabs cannot spawn a sidecar in this worktree yet.
Concerns/Blockers: deferred to Phase 12 — the macOS (`scutil`/PAC) and Windows (WinHTTP) system-proxy branches (they log one note and return no proxy), the Windows direct-spawn/`Child::kill` sidecar-stop branch (no Job Object yet) and the macOS supervisor extras (kqueue `NOTE_EXIT`, `proc_listchildpids` snapshot; the `/proc` orphan sweep compiles out there). Also: `RpcClient.fire` dropped as unused; `stats:data` has no emitter in either implementation; post-shutdown `stats:fetch` would rebuild the server (unreachable, commented).
