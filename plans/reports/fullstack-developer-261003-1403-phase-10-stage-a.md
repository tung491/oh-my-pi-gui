# Phase 10 Stage A: lock lints, clipboard, barrier race, tauri-driver, e2e-hooks binary

**Worktree:** `/home/tung491/WORK/worktrees/tauri-integration` · **Branch:** `tauri/integration` · **Base:** `0a91013` · **Tip:** `a98b4d4` · **Date:** 2026-10-03 (KST)

All six Stage A items are done. Three commits, none pushed. No app was started, no window opened, no package installed or removed, and no user config path touched. No process from the worktree is left running (`pgrep -af worktrees/tauri-integration` is empty).

## Commits

| Commit | Item | Subject |
|---|---|---|
| `c72e956` | 1 | build(tauri): warn on lock guards held across match arms and awaits |
| `809f386` | 2 | fix(tauri): read the clipboard off the async runtime workers |
| `a98b4d4` | 3 | fix(tauri): keep a barrier's released state so an early release still frees the call |

Items 4 and 5 produce no tracked files (`~/.cargo/bin`, `src-tauri/target/`, `out/renderer-tauri` are outside git or ignored).

## Gates, run after every item

| Gate | Item 1 | Item 2 | Item 3 |
|---|---|---|---|
| `cargo test --all-features` | 658 + 2 passed | 658 + 2 passed | 659 + 2 passed |
| clippy `-D warnings -D clippy::unwrap_used -D clippy::expect_used`, `--all-features --all-targets` | clean | clean | clean |
| the same clippy without features (release path) | clean | clean | clean |
| `bunx vitest run` | 208 files, 1945 passed | same | same |
| `bun run check:types` | clean | clean | clean |
| `bun run build` | clean, chunk checks pass | clean | clean |

## Item 1: lock-lifetime lints (`c72e956`)

`[lints.clippy]` with `significant_drop_in_scrutinee = "warn"` and `await_holding_lock = "warn"` added to `src-tauri/Cargo.toml`. Under `-D warnings` the first lint produced 12 hits (5 in library code, 7 in test code); `await_holding_lock` produced none. Every hit was fixed by taking or cloning the value into a `let` and dropping the guard before the body runs.

| Site | What was held while calling out | Hazard class |
|---|---|---|
| `bridge.rs` `release_barrier` | `faults` lock across `notify_waiters()` | Long hold. `Notify` takes no bridge lock. (Rewritten again in Item 3.) |
| `bridge.rs` tests `ReloadingSink::send` | sink's own `ctx` lock across `bridge.attach(...)` | Long hold. `attach` replays into the *replacement* sink, so it never re-enters this sink's lock. |
| `ollama/pull.rs` `cancel` | `active` lock across an atomic store and `notify_one()` | Long hold. |
| `omp/manager.rs` supervisor SIGKILL path | `kill_request` lock across the oneshot `send` | Long hold. Oneshot send takes no lock. |
| `omp/stats.rs` `terminate` | `kill_request` lock across the oneshot `send` | Long hold. |
| `omp/mod.rs` `omp_binary` (`cfg(test)`) | `test_overrides` lock across a pure `ok_or_else` | Long hold, trivial. The `#[cfg(test)]` had to move onto a block so the `if let` stays test-only. |
| `omp/mod.rs` `spawn_env_provider` (`cfg(test)`) | `test_overrides` lock across a `return` | Long hold, trivial; same `cfg(test)` block treatment. |
| `omp/mod.rs` `shutdown` | `stats` slot lock across `StatsServer::kill()` | Long hold. `kill` locks `inner.state` and the child's `kill_request`, never the slot, so it could not deadlock; but a stats read racing shutdown would have blocked on the slot for the length of a SIGTERM. |
| `testing.rs` `RecordingSink::send` | `fail_with` lock across a `return` | Long hold, trivial. |
| `desktop/windows.rs` fake `build_main_window` | `build_failure` lock across a `return` | Long hold, trivial. |
| `updater/mod.rs` test `ReleaseServer::answer` (feed) | `feed` lock across the `match` arms | Long hold, trivial. |
| `updater/mod.rs` test `ReleaseServer::answer` (range) | `range_mode` lock across the `match` arms | Long hold, trivial. |

None of the twelve was a real deadlock: in every case the code reached under the guard takes no lock that could lead back to the held one. The value of the lint is that the long holds (the supervisor and stats kill paths, the `stats` slot) are the exact shape of the log-watcher and tray deadlocks fixed earlier today, so the gate now catches that shape before it reaches a run.

## Item 2: clipboard read (`809f386`)

`TauriHost::clipboard_read_text` (`src-tauri/src/lib.rs`) now clones the `AppHandle` and runs `clipboard().read_text()` inside `tokio::task::spawn_blocking`. A failed join (panic or runtime shutdown) maps to `HostError::Failed("clipboard read did not complete: …")` instead of propagating. `services`' `system:clipboard-read` handler and `gui_clipboard_read` host tool are unchanged; they already consume the `BoxFuture`. There is no unit test for `TauriHost` (it needs a live `AppHandle`), so the fake host in `testing.rs` keeps covering the callers.

Task 10.1 Verify, run with this item:
- `cargo test --test channels`: 2 passed, exit 0.
- `grep -rnE "todo!\(|unimplemented!\(|not_ported\(" src-tauri/src | grep -v "fn not_ported("`: prints nothing.
- the step 5 paths command: `3 passed`.

## Item 3: e2e barrier race (`a98b4d4`)

`Faults::barriers` is now `HashMap<String, tokio::sync::watch::Sender<bool>>`. The `Fault::Barrier` arm subscribes a receiver synchronously inside dispatch (before the `Reply::Later` future is spawned) and awaits `wait_for(|released| *released)`; `release_barrier` removes the sender and `send_replace(true)`. The receiver keeps seeing `true` after the sender is dropped, so a release that arrives between dispatch and the task's first poll is not lost. If the barrier is dropped unreleased (bridge going away), the waiter runs the handler rather than hanging; the comment in code records that choice.

New test, `e2e-hooks` only: `bridge::tests::a_barrier_released_before_the_call_waits_still_releases_it`. It invokes a barrier-faulted call and calls `release_barrier` immediately, without yielding, on a current-thread runtime; the spawned task has not polled yet at that point. It then asserts the call completes within 500 ms and that a second release of the same name misses.

Mutation check: with the `Notify` implementation restored and the new test kept, the test fails with a timeout at the 500 ms `expect`; with the fix it passes. The Task 10.2 Verify command `cargo test --features e2e-hooks -- test_hooks bridge::tests` exits 0 with 31 tests, including this one.

## Item 4: tauri-driver

`cargo install tauri-driver --locked` installed **tauri-driver v2.1.0** at `~/.cargo/bin/tauri-driver` (`cargo install --list` confirms). The binary has no `--version` flag; the version comes from the install line. `/usr/bin/WebKitWebDriver` is present (system package). No `tauri-driver` process was left running.

## Item 5: e2e-hooks debug binary

`cargo tauri build --debug --features e2e-hooks --no-bundle` (with `~/.cargo/bin` and `~/.bun/bin` on PATH) exited 0. Its `beforeBuildCommand` rebuilt `out/renderer-tauri` first, so the embedded assets are current.

- Binary: `/home/tung491/WORK/worktrees/tauri-integration/src-tauri/target/debug/sai-atlas`, 485 MB, built 14:22 KST, sha256 prefix `54f906c7392c834b`.
- The hook channels are compiled in: `grep -a -c` finds `test:release`, `test:navigation-probe` and `test:second-instance` in the binary.
- This overwrote the earlier debug binary from the human session (built without the feature). Anything that wants a hook-free debug build must rebuild without `--features e2e-hooks`.

## Item 6: remaining Task 10.1 steps

Steps 1, 2 and 4 were done by the controller; step 5 was implemented in the foundation and re-verified above (3 passed); step 6 is Item 2; step 3's gates are the gates in the table. Nothing else in Task 10.1 remains.

## Notes for Stage B

- Task 10.2 step 5's test, `no test hook is registered without e2e-hooks`, does not exist yet. `cargo test test_hooks` without the feature currently runs 0 tests (exit 0). It belongs to the hooks lane.
- `src-tauri/src/test_hooks.rs` already provides `test:release`, `test:emit`, `test:fault`, `test:quit`, `test:windows`, `test:second-instance` and `test:navigation-probe`.
- `wdio.conf.ts` should point `tauri:options.application` at the binary path above and launch `~/.cargo/bin/tauri-driver` with `--native-driver /usr/bin/WebKitWebDriver`.

Status: DONE
Summary: All six Stage A items are complete on `tauri/integration` (`0a91013` → `a98b4d4`, three commits, not pushed): the lock lints are on and their twelve hits fixed, the clipboard read runs through `spawn_blocking`, the barrier race is closed with a `watch` and a mutation-checked test, `tauri-driver v2.1.0` is installed, and the `e2e-hooks` debug binary is built. Every gate is green after each item.
Concerns/Blockers: None blocking. The `e2e-hooks` build replaced the hook-free debug binary in `target/debug`; Task 10.2 step 5's test is still to be written in Stage B.
