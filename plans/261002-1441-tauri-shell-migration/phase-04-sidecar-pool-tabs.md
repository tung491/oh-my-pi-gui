---
phase: 4
title: "Sidecar pool, tabs and RPC routing"
status: pending
priority: P1
effort: "6d"
dependencies: [2]
module: tabs
---

# Phase 4: Sidecar pool, tabs and RPC routing (module `tabs`)

## Goal

Rust reproduces `src/main/sidecar-pool.ts`: one `SidecarManager` per tab, cap 10, per-window active and visible tabs, session-file ownership, routing frames only to visible tabs and `tab:status` to every tab, and every tab/RPC/sidecar handler listed for `tabs` in Phase 2's channel table.

## Wave rules

Same as Phase 3 (see `phase-03-omp-processes.md` → Wave rules), with these substitutions: worktree `../worktrees/tauri-tabs`, branch `tauri/tabs`, owned path `src-tauri/src/tabs/**`, gate `bash scripts/check-module.sh tabs`.

Cross-module calls go only through the frozen traits in `src-tauri/src/ports.rs`: `ctx.omp` (`new_sidecar`), `ctx.desktop` (`target_window`, `record`, `set_cwd`, `focus`, `spawn_window`, `on_window_closed`), `ctx.services` (`execute_host_tool`, `session_kind_for`), `ctx.bridge` (`emit_to_window`) and `ctx.host` (`open_dialog`). The pool never calls `ctx.omp.spawn_env()`: the manager applies it (Phase 3 Task 3.4 step 3). The Phase 3 Wave rules → "Frozen wiring" apply here: `Tabs::new(ctx: CtxRef)` reaches the other ports through `self.ctx()`, handlers reach the pool through `ctx.tabs.as_any().downcast_ref::<tabs::Tabs>()`, and code reachable from the main thread spawns through the `Handle::try_current()` / `tauri::async_runtime::spawn` helper. Tests build an `AppCtx` with `testing::fake_ctx_cyclic(&fakes, registry, |ctx, ports| ports.tabs = Some(Arc::new(Tabs::new(ctx.clone()))))`, so handler and pool tests hit the real pool over the fakes. Sidecars in tests are `testing::FakeSidecar`s, which `FakeOmp::new_sidecar` creates and records in `fakes.omp.sidecars`, as `sidecar-pool.test.ts` casts fakes to `SidecarManager` (lines 133, 146). Before running anything that needs the agent, check `test -x resources/omp`. Manual runs use `bun run dev:tauri -- --user-data-dir=$(mktemp -d)`.

## Files (owned)

- `src-tauri/src/tabs/mod.rs`, `src-tauri/src/tabs/ipc.rs`
- Create as needed: `pool.rs`, `tab_spawn.rs`, `window_spawn_target.rs`, `snowflake.rs`

## Tasks

### Task 4.1: Snowflake ids and spawn targets
- Goal: ports of `snowflake.ts` and `window-spawn-target.ts`.
- Target: `snowflake.rs`, `window_spawn_target.rs`.
- Steps:
  1. Port both files. `snowflake` must produce ids with the same string shape the renderer stores (check `src/main/snowflake.ts`).
  2. Port `window-spawn-target.test.ts` (3 tests).
- Success criteria: tests pass.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- tabs::window_spawn_target tabs::snowflake` exits 0.

### Task 4.2: The pool
- Goal: `SidecarPool` with the frozen public surface, behaving as `sidecar-pool.ts`.
- Target: `pool.rs`.
- Steps:
  1. Read `src/main/sidecar-pool.ts` (787 lines) and `src/main/sidecar-pool.test.ts` (34 tests) in full before writing code.
  2. Model the TS maps as one `std::sync::Mutex<PoolState>` (never held across an `.await`): `entries`, `by_tab_id`, `active_by_window`, `visible_by_window` (1 or 2 tab ids), `split_by_window` (ratio clamped to 0.2–0.8, `sidecar-pool.ts:507`), `request_owners`, `session_files`, `restoring_windows`. Windows are keyed by `WindowId`, and every renderer-visible id (`winId`, `ownerWinId`) is that number.
  3. Inside `TabsPort::acquire(&self, options: AcquireOptions)`, the pool upgrades its `CtxRef` and creates the sidecar with `ctx.omp.new_sidecar(SidecarOptions { binary_path, cwd, extra_flags: vec![], packaged: !tauri::is_dev(), fresh, kind, resume_session_path })`, where `binary_path` is `paths::resolve_bundled_omp()` or an empty `PathBuf` when that fails (`index.ts:358` passes `bundledOmp ?? ""`; the manager reports the missing binary). `SidecarOptions` has no environment field. It keeps the returned `SidecarEvents` receiver and drains it in a task started through the spawning helper. `tabs::init(ctx, app)` ports the ready health check (`index.ts:380-393`): on each `SidecarEvent::Status` with `SidecarStatus::Ready`, if `has_rpc_client()`, call `request(json!({ "type": "get_state" }), None)` and `mark_unhealthy` with the TS reason on `success: false` or on an error. `tabs::init` also registers `ctx.desktop.on_window_closed(Box::new(…))`, whose closure captures `Arc::downgrade(ctx)` (not an `Arc<AppCtx>`, which would form a cycle) and calls `release_window(record.id)` (TS: `sidecar-pool.ts:232-234`, test "releases every tab of a closed window").
  4. Routing: for each `SidecarEvent`, if the tab is visible in its window, forward on the event's channel (the `tabs` `EMITS` list in `tabs/mod.rs`) through `ctx.bridge.emit_to_window(win_id, channel, json!({ "tabId": tab_id, "payload": payload }))`; the `IpcActiveTabEnvelope` struct, if you write one, stays private to this module. Always send `tab:status` with an `IpcTabInfo` for every tab. Forward `SidecarEvent::Events(batch)` on `rpc:events` exactly as the manager batched it: the manager already batches at 32 ms / 1,000 entries (`ports.rs:408, 480-482`), so do not create an `EventBatcher` for it, or each event waits a second interval.
  5. Handlers follow the frozen `Reply` rule: `rpc:command` validates, then calls `SidecarHandle::request(command, timeout_ms)` synchronously; that call queues the frame on stdin before it returns (`ports.rs:456-459`). The handler maps the returned `'static` future's `SidecarError` with `IpcError::new(error.to_string())` and returns it as `Reply::Later`. This keeps stdin order equal to arrival order.
  6. `release_tab` must do everything `#releaseEntry` does (`sidecar-pool.ts:405-420`): drop request-id routes, dispose the manager, fix visibility and split, pick the oldest surviving tab as active, notify the `on_window_tabs_changed` listeners. `release_tab` is synchronous, and `SidecarHandle::dispose()` initiates the stop before it returns, so hand the returned future to the spawning helper rather than awaiting it.
  7. Host tools: on `SidecarEvent::HostToolCall`, call `ctx.services.execute_host_tool(Caller::main(win_id), name, args)` (`ports.rs:668`). When it returns `Some(future)`, await it in a spawned task and reply with `send_side_channel(json!({ "type": "host_tool_result", "id": id, "result": … }))` or an error result, as `src/main/ipc.ts:380-400` does. When it returns `None`, forward `host-tool:call` to the renderer with `ctx.bridge.emit_to_window` (same payload as TS) and record the request-id owner for `route_side_channel`.
  8. Port all 34 tests with their normalized names, using `testing::fake_ctx_cyclic` with the real `Tabs` installed, `FakeOmp`/`FakeSidecar` underneath (`FakeSidecar::emit` injects events, `FakeSidecar::responses` scripts `request` answers), and `fakes.desktop.close(win_id)` for the closed-window test.
- Success criteria: 34 tests pass.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml tabs::pool` exits 0 and the summary shows at least `34 passed`.

### Task 4.3: Tab spawning
- Goal: port of `tab-spawn.ts` (acquire a sidecar, notify the renderer).
- Target: `tab_spawn.rs`.
- Steps: port the file and its 9 tests. The kind-mismatch refusal awaits `ctx.services.session_kind_for(path)` (`tab-spawn.ts:20, 41`), so `tab:spawn` replies through `Reply::Later`; tests script `FakeServices`. The fallback cwd follows `TabsPort::cwd_for(caller, None)`, then `paths::initial_cwd(&[ctx.prefs.get_string("lastProject").as_deref(), <process cwd>])`, then `dirs::home_dir()`; the Work-mode workspace comes from `paths::ensure_default_workspace()`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml tabs::tab_spawn` exits 0 with at least `9 passed`.

### Task 4.4: Handlers
- Goal: all 18 `tabs` channels work, matching `src/main/ipc.ts`.
- Target: `ipc.rs`.
- Steps:
  1. For each channel, read the TS handler and port it. Where they live: `rpc:command` `ipc.ts:525`, `rpc:command-for-tab` 535, `extension-ui:respond` 546, `host-tool:result` 555, `host-tool:update` 563, `host-uri:result` 570, `tab:spawn` 673, `tab:close` 690, `tab:set-active` 699, `tab:set-view` 705, `tab:get-all` 713, `tab:get-session-owner` 721, `prefs:update-launch-profile` 899, `sidecar:restart` 920, `sidecar:select-project` 933, `sidecar:set-project` 957, `sidecar:default-workspace` 974, `sidecar:status-get` 1169. Line numbers are as of 2026-10-02; locate each by its `IPC_COMMANDS.` name if they moved.
  2. Resolve "this window" from `Caller.win_id`, never from a payload field. Pool internals come from `ctx.tabs.as_any().downcast_ref::<tabs::Tabs>()`; everything else uses the trait methods (`foreign_session_owner`, `note_session_file`, `adopt_session_cwd`, `route_side_channel`, `sidecar_for_window`, `sidecar_for_tab`, `set_active_tab`, `set_tab_view`, `release_tab`, `tabs_for_window`, `session_owner`, `cwd_for`) and `SidecarHandle::{status, has_rpc_client, request, send_side_channel, restart, cwd}`. `extension-ui:respond`, `host-tool:result`, `host-tool:update` and `host-uri:result` call `route_side_channel(id, frame, is_final)` and fall back to `sidecar_for_window(caller.win_id)` plus `send_side_channel`. `prefs:update-launch-profile` merges through `ctx.prefs.update("launchProfiles", …)` (one mutex, matching the TS synchronous merge); this module's `parseLaunchProfile` port and the one in `omp` (Phase 3 Task 3.4 step 2) must stay identical. `sidecar:set-project` and `sidecar:default-workspace` use `paths::is_existing_directory`, `paths::ensure_default_workspace`, `ctx.prefs.set("lastProject", …)` and `ctx.desktop.set_cwd(caller.win_id, cwd)`.
  3. `sidecar:select-project` (`ipc.ts:933-952`) calls `ctx.host.open_dialog(OpenDialogOptions { title: Some(ctx.i18n.t(MainTextKey::DialogOpenProject)), default_path: Some(sidecar.cwd().into()), directory: true, can_create_directories: true, parent: Some(caller.win_id), ..Default::default() })` and replies through `Reply::Later`. On a pick, it sets prefs `lastProject`, calls `ctx.desktop.set_cwd(caller.win_id, &cwd)`, restarts that window's sidecar with `restart(Some(&cwd), None)` and returns the path. On cancel (`None`) it returns `null`.
  4. Write one dispatch test per channel. Use `bridge::dispatch_for_test(&ctx, caller, channel, args)` with a context from `testing::fake_ctx_cyclic` that installs the real `Tabs` (so the handlers hit the pool, not `FakeTabs`), with `FakeHost::open_dialog_answers`, `FakeDesktop` and `FakeSidecar`s underneath, and assert the response shape and the recorded calls (`fakes.host.log`, `fakes.desktop.log`, each `FakeSidecar::log`).
- Success criteria: no handler in `ipc.rs` returns `not_ported`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml tabs::ipc` exits 0 with at least `18 passed`.

### Task 4.5: Module gate and commit
- Verify: `bash scripts/check-module.sh tabs` exits 0 with last line `check-module tabs: PASS`. Then commit `feat(gui): route tabs and agent RPC through the Tauri core`.

## Status report

End with `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, a one- or two-sentence summary, and concerns. `DONE` is invalid unless the gate passed.

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
