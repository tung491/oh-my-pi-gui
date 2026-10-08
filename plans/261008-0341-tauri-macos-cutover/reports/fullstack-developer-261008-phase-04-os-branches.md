# Phase 4 report: OS branches (supervisor, proxy, GPU and RAM)

Lane B, worktree `tauri_macos-core`, branch `tung491/tauri_macos-core`. Status: completed. Not pushed or merged.

## Commits
- `a19693f` feat(macos): end the sidecar tree when the app dies (supervisor.rs, test_support.rs, manager.rs tests, shell_env.rs tests, e2e/sidecar-fixture.ts)
- `f56ddb1` feat(macos): read the system proxy from scutil (proxy.rs)
- `27e1c21` feat(macos): read the GPU name and memory for Ollama sizing (hardware.rs)
- a docs commit with the host log, parity lines and this report

## What changed
- Supervisor: on macOS, `parent_exit` (kqueue `EVFILT_PROC`/`NOTE_EXIT` on a blocking thread; ESRCH resolves at once), a 500 ms refresh of the `proc_listchildpids` descendant snapshot, merges before SIGTERM and before the group SIGKILL, and `kill_snapshot_survivors` after omp exits. The Linux order and `sweep_orphans` are unchanged. `mod tests` runs on all unix and has two new tests: `a_dead_parent_ends_supervision_even_when_the_control_channel_stays_open` and `an_escaped_tool_dies_when_omp_exits_on_its_own`. The subreaper test stays Linux-only.
- `test_support.rs`: shared `alive`, `argv`, `ppid`, `cwd`, `children_of`, `fixture_path`, `read_env_dump`. The fixture writes `process.env` to `$OMP_GUI_TEST_ENV_DUMP`.
- The 8 manager/shell_env tests are un-gated. `grep -c 'cfg(target_os = "linux")'` prints 1 for manager.rs and 0 for shell_env.rs.
- Proxy: `ScutilProxy`, `scutil_proxy_to_url`, and a macOS `lookup_system_proxy` (2 s timeout, PAC-only logged once).
- Hardware: `gpu_name_from_system_profiler`, `parse_sysctl_memsize`, `read_gpu_name_macos`, and the `sysctl hw.memsize` RAM read. `grep -rn "is not implemented on this OS" src-tauri/src` prints nothing.

## Verify evidence
The evidence is in the host log under `## Phase 4`. Every red step failed as required. All Verify steps are green, and gate items 1–7 pass (cargo test 783/0, vitest 2374 passed with exit 0, snapshots PASS). The host log has 8 `ungated:` lines.

## Deviations
1. The Task 4.2b Verify command is rejected by cargo (two positional filters). Per counsel I ran `cargo test … -- omp::manager omp::shell_env` instead: 27 passed. The phase file's line should be corrected.
2. Gate 5 needed `resources/omp`. Per counsel I copied it from `~/WORK/oh-my-pi/packages/gui/resources/omp` (sha256 verified, gitignored) rather than running with `SKIP_COMPILED=1`.
3. Each refresh drops snapshot pids that have exited, so a recycled pid is never killed.
4. `run` ends with `runtime.shutdown_background()`, so the blocked kqueue thread cannot hold up the supervisor's exit.
5. `#[allow(clippy::zombie_processes)]` on the test holder sleep, which must outlive the stand-in GUI by design.
6. The sigterm test's script uses `SLEEP_BIN` instead of the literal `/usr/bin/sleep`, which macOS does not have.

## Concerns
- The Linux cfg branches were not compiled on this Mac (no Linux target installed). Linux CI clippy and `cargo test` must confirm them before the merge.
- On macOS, `argv` splits `ps` output on whitespace. Every asserted argv here has no spaces, and the tests' exact-equality checks would still catch an extra token.
