# Phase 4 implementation report: sidecar pool, tabs and RPC routing (module `tabs`)

Phase 4 is done. Every Task Verify passed as written, and `bash scripts/check-module.sh tabs` ended with `check-module tabs: PASS`.

- **Plan:** `plans/261002-1441-tauri-shell-migration/phase-04-sidecar-pool-tabs.md`
- **Worktree:** `/home/tung491/WORK/worktrees/tauri-tabs`
- **Branch:** `tauri/tabs` (base `10cf8a5`, not pushed, not merged)

## Files

Every change is inside `src-tauri/src/tabs/` (gate 1 confirms this):

| File | Lines | Contents |
|---|---|---|
| `mod.rs` | 252 | `Tabs` delegates `TabsPort` to the pool. `init` runs `install`, which enables the ready health check and registers the window-closed release with a `Weak` context. |
| `pool.rs` | 1,945 | The `SidecarPool` port: 1,044 lines of code and 900 of tests. |
| `tab_spawn.rs` | 271 | The `tab:spawn` decision and its refusals. |
| `ipc.rs` | 846 | The 18 handlers and the `parseLaunchProfile` port. |
| `snowflake.rs` | 82 | Snowflake tab ids. |
| `window_spawn_target.rs` | 66 | Port of `window-spawn-target.ts`, compiled only under `#[cfg(test)]`. |

## Tasks

### Task 4.1: snowflake ids and spawn targets

- **Commit:** `7a95103 feat(gui): mint tab snowflake ids and resolve window spawn targets in Rust`
- **Verify:** `cargo test --manifest-path src-tauri/Cargo.toml -- tabs::window_spawn_target tabs::snowflake` exited 0 with 7 passed (3 ported tests and 4 snowflake tests).

### Task 4.2: the pool

- **Commit:** `f3488aa feat(gui): pool one sidecar per tab and route their events in Rust`
- **Verify:** `cargo test --manifest-path src-tauri/Cargo.toml tabs::pool` exited 0 with 38 passed. That is the 34 TS twins plus 4 extra tests: spawn options, health check on failure, health check on timeout or no check, and `dispose_all`.

### Task 4.3: tab spawning

- **Commit:** `ed0736f feat(gui): decide tab spawns and their refusals in Rust`
- **Verify:** `cargo test --manifest-path src-tauri/Cargo.toml tabs::tab_spawn` exited 0 with 11 passed (9 twins plus 2 boundary tests).

### Task 4.4: handlers

- **Commit:** `485a6c6 feat(gui): handle the tab, rpc and sidecar channels in Rust`
- **Verify:** `cargo test --manifest-path src-tauri/Cargo.toml tabs::ipc` exited 0 with 19 passed: one dispatch test per channel plus a `parseLaunchProfile` test.
- No `not_ported` remains.

### Task 4.5: module gate

The first gate run failed at gate 4 (clippy). Clippy's `cloned_ref_to_slice_refs` lint flagged three test assertions:

- `ipc.rs:592`
- `pool.rs:1425`
- `pool.rs:1900`

Following the Failure Protocol, I stopped and consulted kongming. It advised rewriting the three assertions with `std::slice::from_ref`, with no `#[allow]`, then running clippy directly and re-running the gate.

- **Fix commit:** `1a7bb6c test(gui): compare single-element expectations as slices in tabs tests`
- **Re-run:** the gate exited 0 and its last line is `check-module tabs: PASS`.
  - Gate 7: `check-test-parity tabs: 46 tests mirrored across 3 files`.
  - Gate 8: 149 passed with default features, 150 with `e2e-hooks`.
  - Gate 9: WARN for both cross targets, because this host has no macOS or Windows SDK. That proves nothing about those OS branches.
- **Gate commit:** `272b733 feat(gui): route tabs and agent RPC through the Tauri core`. It is an empty commit with the message the phase asks for, because the code was already committed task by task.

## Completion check

- The tree is clean, and the diff from `10cf8a5` touches only `src-tauri/src/tabs/*`.
- `git diff 10cf8a5 -- src-tauri/contracts` is empty.
- `cargo test --manifest-path src-tauri/Cargo.toml --all-features` exited 0 (150 + 2 passed).
- `bun scripts/check-test-parity.ts tabs` passes.
- The module has no `todo!`, `unimplemented!`, `#[ignore]`, `tauri_plugin_` call or `unsafe`.
- The only `downcast_ref` calls target this module's own `Tabs`: in `install`, and in a test helper.

## Deviations

kongming reviewed deviations 1 to 4 before I wrote the code and agreed with them.

1. **`rpc:command` and `rpc:command-for-tab` never reject on a sidecar error.** Step 4.2.5 says to map `SidecarError` to `IpcError`. Instead, the handlers resolve the `ipc.ts` response `{ id, type: "response", success: false, code: "rpc_delivery_unknown", error }`. The renderer calls `markUncertain` on that code (`use-composer-submit.ts:147,197,275,390`), and Task 4.4 requires matching `ipc.ts`. `IpcError` is used only for a bad payload, such as a missing `command`.
2. **Each channel uses its TS payload shape, not one envelope for all.** The default for most channels is `{ tabId, payload }`, but four differ:
   - `extension-ui:request` sends `{ tabId, request }`.
   - `host-uri:request` and `host-tool:call` send `{ request }`.
   - `sidecar:status` sends `{ tabId, payload }` with `cwd` overwritten by `sidecar.cwd()`.
   - `tab:status` sends a bare `IpcTabInfo`.

   `rpc:events` batches are forwarded unchanged, with no second batcher.
3. **`window_spawn_target` is compiled only for tests** (`#[cfg(test)] mod window_spawn_target;`). In Rust, the desktop module resolves the window spawn target itself (Phase 5), and it cannot call into this module outside the ports.
4. **`command_for_idle_session` reports a delivery failure as a failed response.** `None` is kept for the TS `null` cases. A delivery failure resolves `Some({ "type": "response", "success": false, "error": <message> })`, so the `sessions:delete` and `sessions:rename` ports surface the same message the TS rejection carried. This is documented on the `TabsPort` impl.
5. **Status and wiring are adapted to the frozen `FakeSidecar`.**
   - `FakeSidecar::restart()` leaves the status `asleep`, so each entry also keeps a pool-side `started` flag. The real manager never returns to `asleep`, so the flag changes nothing in production.
   - The guards (`ensure_started`, `session_owner_is_live`, `command_for_idle_session`, the RPC pre-check) read `sidecar.status()` live.
   - `tab:status` uses the status from the last event.
   - Where the TS fake emitted `starting` on start or restart, the Rust tests first check that the pool started the sidecar, then call `set_status(Starting)` to stand in for the manager.
   - TS `listenerCount` assertions become `wiring()` counts, plus the same behavioral checks as the TS tests.
6. **Host-tool forwarding moved into the pool, as step 4.2.7 says.** The twin of "keeps the route across non-final host-tool updates" therefore asserts one `host-tool:call` send where TS asserted zero.
7. **The Work workspace has a test-only seam.** `ensure_default_workspace` calls `paths::ensure_default_workspace()` in production, but in tests it uses `<temp>/sai-atlas-tests/<pid>-tabs-work`. Without this, tests would create `~/.omp/work`, which the wave rule forbids. I removed those temp dirs after the run.
8. **The health check is turned on by `tabs::init`.** It lives in the pool's event drain and is enabled through `install`, mirroring the `index.ts` factory listener. The TS test factories have no health check, so pool tests without `install` send no `get_state`.
9. **Clippy failed on the first gate run.** The fix is the separate commit `1a7bb6c`, applied under the Failure Protocol.

## Processes

- I started no long-running processes: no dev server, no app run, no agent and no fixture.
- At the end, no `omp --mode rpc-ui`, `--omp-supervise` or `sidecar-fixture` process was running, and nothing listened on ports 5180 to 5189.

## Baseline mtimes

These match at start and end (epoch seconds, then local time):

- `~/.config/@oh-my-pi/omp-gui/prefs.json`: `1790910017` (2026-10-02 12:00:17 +0900).
- `~/.config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl`: `1790951349` (2026-10-02 23:29:09 +0900).

`~/.local/share/applications/vn.io.vif.saiatlas.desktop` does not exist. Nothing was installed.

## NEEDS-HUMAN

None. This phase has no on-screen step. Live routing against the real `omp` waits for the Phase 10 merge, because `omp` is a stub on this branch.

## Notes for integration

- Phase 6 should keep `ipc.ts`'s `if (!response.success) throw new Error(response.error)` path for `command_for_idle_session`. Deviation 4 depends on it.
- Phase 3's `parseLaunchProfile` port must stay identical to `tabs/ipc.rs::parse_launch_profile`. I could not compare the two here, because `omp` is a stub on this branch. A trial merge should check it.

Status: DONE
Summary: The tabs module ports the sidecar pool, tab spawning, snowflake ids, window spawn targets and all 18 tab, rpc and sidecar handlers over the frozen ports, and `check-module.sh tabs` passes (46/46 parity, full `cargo test --all-features` green).
Concerns/Blockers: Deviations 1 to 4 differ from the literal spec wording to match `ipc.ts` and the renderer contract, and kongming agreed with each. Gate 9 cross-OS checks only WARN on this host. `parse_launch_profile` still has to be compared with Phase 3's port at the trial merge.
