# Phase 2 contract-coverage review (Phases 3 to 9)

- Date: 2026-10-02
- Reviewed: `/home/tung491/WORK/worktrees/tauri-foundation` at `a8406a4 feat(gui): close the contract gaps found by the wave review`. This re-verifies the first pass, which was run against `bc859d4` and found 16 gaps.
- Scope: every Task step in Phases 3 to 9 that calls another module, builds a window, uses an OS service, or talks to the renderer, mapped to the frozen surface. That surface is `ports.rs`, `webview.rs`, `bridge.rs`, `ctx.rs`, `testing.rs`, `paths.rs`, `prefs.rs`, `runtime_log.rs`, `i18n.rs`, `contracts/*.api.txt`, the module stubs and the frozen `lib.rs` wiring. Stub bodies are not gaps; only signatures, types and wiring count.
- Evidence: I read the diff `bc859d4..a8406a4` in full: the 19 files under `src-tauri/`, including the regenerated `contracts/*.api.txt`. I also ran `cargo test --lib` in `src-tauri/`: `59 passed; 0 failed`. That run includes `every_inventoried_cross_module_call_is_a_trait_method` and the `Rust-only key` check in `i18n`.
- The two root causes are closed:
  - **Root A** (no context in port implementations): every port is built as `X::new(ctx: CtxRef)`, where `CtxRef = Weak<AppCtx>`. `lib.rs::build_ctx` builds the context with `Arc::new_cyclic`, and desktop's constructor is `Desktop::new(app, ctx)`.
  - **Root B** (handlers cannot reach module state): every port trait has `fn as_any(&self) -> &dyn Any`, so a handler can `downcast_ref` to its module's struct.
  - Module tests install their real port with `testing::fake_ctx_cyclic(&fakes, registry, |ctx, ports| ..)`.

| phase | task | step | contract |
|---|---|---|---|
| 3 | 3.1 | 1-4 | module-internal (`rpc_bridge.rs` over `tokio::process::ChildStdout`) |
| 3 | 3.2 | 1-2 | module-internal; the per-command timeout arrives as `SidecarHandle::request(command, timeout_ms: Option<u64>)` from `tabs`. Keep the TS text `RPC timeout (<ms>ms): <type>` by returning `SidecarError::Other` (note N8) |
| 3 | 3.2 | 3 | `OmpPort::new_event_batcher(FlushCallback) -> Box<dyn EventBatcher>`, `ports::BATCH_INTERVAL_MS`, `ports::MAX_BUFFER_SIZE`; the manager batches `SidecarEvent::Events` itself (`EventBatcher` doc). The step's "Phase 4 constructs it per tab" is now stale (note N4) |
| 3 | 3.2 | 4 | module-internal (`tokio::time::pause`; `tokio/test-util` is in dev-dependencies) |
| 3 | 3.3 | 1 (shell env, editor) | `OmpPort::spawn_env(&self) -> BoxFuture<HashMap<String, String>>`, `OmpPort::resolve_editor_command(&self)`; probe module-internal |
| 3 | 3.3 | 1, 3, 4 (proxy chain from pref `proxyUrl`) | resolved: `Omp::new(ctx: CtxRef)` → `self.ctx.upgrade()?.prefs.get_string("proxyUrl")` inside `spawn_env(&self)`. The step text still says `Omp::spawn_env(ctx)` (note N12) |
| 3 | 3.3 | 3 (non-Linux branches) | `runtime_log::note(source, "system proxy lookup is not implemented on this OS", details)` |
| 3 | 3.4 | 2 (launch-profile flags) | resolved: the `SidecarOptions.extra_flags` doc now says the manager appends `launchProfiles.<cwd>`, re-read from prefs on every spawn and restart, and applies the denylist. The manager reaches `ctx.prefs` through the `CtxRef` that `Omp::new` holds and hands to each sidecar |
| 3 | 3.4 | 2-3 (argv, denylist, env) | module-internal; the manager applies `OmpPort::spawn_env` itself (`SidecarOptions` has no env field) |
| 3 | 3.4 | 4 | `SidecarOptions.binary_path` (the caller fills it from `paths::resolve_bundled_omp()`), `ports::SUPERVISOR_ARGV`, `SidecarHandle::{omp_pid, supervisor_pid, kill, dispose}`. `kill` and `dispose` now return `BoxFuture<'static, ()>` and initiate the stop before returning. Spawn through `tauri::async_runtime::spawn`, because `start()` is reachable from the main thread (note N11) |
| 3 | 3.4 | 5 | `runtime_log::write(&report, None, Some(cwd))` with `source: "sidecar-restart"` |
| 3 | 3.4 | 6 | `OmpPort::new_sidecar(SidecarOptions) -> (Arc<dyn SidecarHandle>, SidecarEvents)`; `SidecarEvent` covers all 14 typed emits of `sidecar.ts` plus `Frame` and `Stderr` |
| 3 | 3.4 | 7 | module-internal (fixture through `bun`) |
| 3 | 3.4b | 1-5 | `omp::supervisor::run(Vec<OsString>) -> ExitCode`, called by `main.rs` on `ports::SUPERVISOR_ARGV`; rest module-internal (conflict over `unsafe`, note N7) |
| 3 | 3.5 | 1 | `TabsPort::cwd_for(caller, None)`; `DesktopPort::on_window_closed(WindowClosedListener)`, registered in `omp::init(ctx, app)`; runs keyed by `Caller.win_id` |
| 3 | 3.5 | 1-3 (runner and server state) | resolved: handlers reach the runners and the stats server through `ctx.omp.as_any().downcast_ref::<omp::Omp>()`. `OmpPort::shutdown` and the window-closed listener use the same struct |
| 3 | 3.5 | 2 | `paths::resolve_bundled_omp()`, `Reply::Later`, stopped by `OmpPort::shutdown` (frozen order step 3) |
| 3 | 3.5 | 3 | `paths::resolve_bundled_omp()`, `OmpPort::spawn_env` (TS `deps.benchmarkEnv()`), `Reply::Later`, `IpcError::new` for refusals |
| 3 | 3.6 | gate | module-internal |
| 4 | 4.1 | 1-2 | module-internal |
| 4 | 4.2 | 2 | `WindowId` keys; `IpcTabInfo`, `IpcTabSplit`, `IpcTabViewSplit`, `IpcSessionOwner`, `TabStatus` from `ports.rs` |
| 4 | 4.2 | 3 (pool creates sidecars, routes, notifies) | resolved: `Tabs::new(ctx: CtxRef)`. Inside `TabsPort::acquire(&self, AcquireOptions)`, `self.ctx.upgrade()` gives `ctx.omp.new_sidecar`, `ctx.bridge.emit_to_window`, `ctx.services.execute_host_tool` and `ctx.desktop.record` |
| 4 | 4.2 | 3 (options) | `OmpPort::new_sidecar(SidecarOptions { binary_path: paths::resolve_bundled_omp()?, packaged: !tauri::is_dev(), fresh, kind, resume_session_path, .. })`. The step's `ctx.omp.spawn_env()` has no field to go into; the manager applies it (3.4 step 3) |
| 4 | 4.2 | 3 (ready health check) | `SidecarEvent::Status`, `SidecarHandle::request(json!({"type":"get_state"}), None)`, `SidecarHandle::mark_unhealthy` |
| 4 | 4.2 | 3 (release on close) | `DesktopPort::on_window_closed` → `TabsPort::release_window`, registered in `tabs::init`; capture a `CtxRef`, not an `Arc<AppCtx>`, so the listener does not form a cycle |
| 4 | 4.2 | 4 | `Bridge::emit_to_window(win_id, channel, json!({ "tabId": .., "payload": .. }))` (the envelope struct stays module-local), `tab:status` with `IpcTabInfo`. Forward `SidecarEvent::Events` as batched by the manager; the step's "Batch `rpc:events` through the frozen `EventBatcher`" now contradicts the `EventBatcher` doc (note N4) |
| 4 | 4.2 | 5 (`rpc:command` ordering) | resolved: `SidecarHandle::request(..) -> BoxFuture<'static, Result<Value, SidecarError>>`, documented as "queued on stdin before this returns". The handler calls it synchronously and wraps the future in `Reply::Later` |
| 4 | 4.2 | 6 | `SidecarHandle::dispose() -> BoxFuture<'static, ()>`, spawned with `tauri::async_runtime::spawn` (`release_tab` is sync), plus `on_window_tabs_changed` listeners |
| 4 | 4.2 | 7 | `ServicesPort::execute_host_tool(Caller::main(win_id), name, args) -> Option<BoxFuture<'static, Result<Value, String>>>` (the step omits the `caller` argument), `SidecarHandle::send_side_channel`; `None` → `Bridge::emit_to_window(win_id, "host-tool:call", json!({ "request": .. }))` |
| 4 | 4.2 | 8 | `testing::fake_ctx_cyclic(&fakes, reg, build)`, where `build` sets `ports.tabs = Some(Arc::new(Tabs::new(ctx.clone())))`, with `FakeOmp`/`FakeSidecar` underneath |
| 4 | 4.3 | 1 | `ServicesPort::session_kind_for(path)`; fallback cwd `TabsPort::cwd_for` → `paths::initial_cwd(&[ctx.prefs.get_string("lastProject"), current_dir])` → `dirs::home_dir()`; `paths::ensure_default_workspace()` |
| 4 | 4.4 | 1 (`rpc:command`, `rpc:command-for-tab`) | `ctx.tabs.as_any().downcast_ref::<tabs::Tabs>()` for pool internals, plus `TabsPort::foreign_session_owner`, `note_session_file`, `adopt_session_cwd`, `DesktopPort::set_cwd(caller.win_id, cwd)` and `SidecarHandle::{status, has_rpc_client, request}` |
| 4 | 4.4 | 1 (`extension-ui:respond`, `host-tool:result`, `host-tool:update`, `host-uri:result`) | `TabsPort::route_side_channel(id, frame, is_final)`, fallback `sidecar_for_window(caller.win_id)` + `SidecarHandle::send_side_channel` |
| 4 | 4.4 | 1 (`tab:spawn`, `tab:close`, `tab:set-active`, `tab:set-view`, `tab:get-all`, `tab:get-session-owner`) | `ctx.tabs` trait methods with `Caller.win_id`; `Reply::ok` |
| 4 | 4.4 | 1 (`sidecar:restart`, `sidecar:set-project`, `sidecar:default-workspace`, `sidecar:status-get`) | `SidecarHandle::restart(cwd, resume_session_path)`, `ctx.prefs.set("lastProject", ..)`, `DesktopPort::set_cwd`, `paths::is_existing_directory`, `paths::ensure_default_workspace`, `SidecarStatus`, `TabsPort::cwd_for` |
| 4 | 4.4 | 1 (`prefs:update-launch-profile`) | `ctx.prefs.update("launchProfiles", ..)` (one mutex = the TS synchronous merge). `parseLaunchProfile` is ported privately here and again in `omp` (3.4 step 2), so the two copies can drift |
| 4 | 4.4 | 2 | `Caller` (the bridge derives it from the webview label) |
| 4 | 4.4 | 3 | `Host::open_dialog(OpenDialogOptions { title: Some(ctx.i18n.t(MainTextKey::DialogOpenProject)), default_path: Some(sidecar.cwd().into()), directory: true, can_create_directories: true, parent: Some(caller.win_id), .. })`, `ctx.prefs.set("lastProject")`, `DesktopPort::set_cwd`, `SidecarHandle::restart(Some(cwd), None)` |
| 4 | 4.4 | 4 | `bridge::dispatch_for_test`, `testing::fake_ctx_cyclic` with the real `Tabs` installed through `testing::Ports` (so handler tests hit the pool, not `FakeTabs`), `FakeHost::open_dialog_answers`, `FakeSidecar` |
| 4 | 4.5 | gate | module-internal |
| 5 | 5.1 | 1-2 | module-internal |
| 5 | 5.2 | 2 | `WindowSpec { kind: Main, win_id, url: "index.html", title, inner_size, min_inner_size: Some((800.0, 600.0)), position, .. }`, `ctx.window_state` key `windowState`, `AppHandle::available_monitors` (held by `Desktop::new(app, ctx)`). `isMaximized` has no spec field: call `WebviewWindow::maximize()` on the returned window, as `window.ts:181-183` does after construction |
| 5 | 5.2 | 3 | `webview::build_window(&AppHandle, WindowSpec)`. The window icon has no spec field, so use `WebviewWindow::set_icon` after build. `show: false` + `ready-to-show` has no hook, so chat windows use `visible: true` + `background_color` |
| 5 | 5.2 | 4 | module-internal (`WebviewWindow::on_window_event` Moved/Resized/CloseRequested → `ctx.window_state.set("windowState", ..)`) |
| 5 | 5.2 | 5 | `TabsPort::on_window_tabs_changed(WindowTabsChangedListener)`, `TabsPort::tab_layout_for_window`, `ctx.prefs.set("tabLayouts", ..)` + `ctx.prefs.delete("tabLayout")`, `TabsPort::restore_layout(win_id, PersistedTabLayout)` |
| 5 | 5.2 | 6 | `DesktopPort::{records, record, main_window, target_window, focus, set_cwd, consume_pending_session, set_run_progress(RunProgressState), on_window_closed}`; `WebviewWindow::set_progress_bar` and the macOS badge through `AppHandle` |
| 5 | 5.2 | 6 (`spawn_window`) | `DesktopPort::spawn_window(cwd, pending_session_path, kind)` → `TabsPort::at_cap`, `TabsPort::acquire(AcquireOptions { kind, fresh, placeholder, .. })`, `paths::initial_cwd`, `paths::ensure_default_workspace`; `Desktop` reaches `ctx` through its `CtxRef` |
| 5 | 5.2 | 7 | module-internal (`desktop::init` is module-owned) |
| 5 | 5.3 | 2 | `DesktopPort::mark_quitting` (frozen order step 1), `DesktopPort::is_quitting` gating the layout writer |
| 5 | 5.3 | 3 | `DesktopPort::request_quit` → `Host::exit(0)` |
| 5 | 5.3 | 4 | `WindowClosedListener` before the record drops, plus `Bridge::unregister_window(win_id)`, which no phase names (note N3) |
| 5 | 5.3b | 1 | foundation `webview.rs` (`configure_webkit`: media stream, WebAudio, audio-only permission) + `rpc:command` (tabs) for `transcribe_audio`; no module code |
| 5 | 5.4 | 2 | `WindowSpec { kind: QuickEntry, win_id: WindowId::QUICK_ENTRY, url: "quick-entry.html", visible: false, decorations: false, minimizable: false, maximizable: false, skip_taskbar: true, always_on_top: true, focused, background_color, position, inner_size = min_inner_size = max_inner_size = (680.0, 168.0) }`. "No menu" means `WebviewWindow::remove_menu()` after build on Linux/Windows (`quick-entry.ts:271`); `tauri-nspanel` goes through `AppHandle` |
| 5 | 5.4 | 3 | `Bridge::emit_to_window(WindowId::QUICK_ENTRY, bridge::QUICK_ENTRY_STATE_CHANNEL, state)` (replayed on attach), `Bridge::emit_to_window(target, bridge::DEEP_LINK_CHANNEL, json!({"action":"quick-entry"}))` for the claim. The menu-chord filter (`before-input-event`) has no Tauri equivalent; module-internal risk |
| 5 | 5.4 | 3-4, 5.6 step 4 (bar controller, shortcut and tray/progress state) | resolved: the ten `quick-entry:*` handlers and `tray:state-push`/`progress:set` reach the controller, the shortcut registration and the per-window snapshots through `ctx.desktop.as_any().downcast_ref::<desktop::Desktop>()` |
| 5 | 5.4 | 4 | `Scope::QuickEntry`/`Scope::Main` in `desktop::register`, `Caller::quick_entry()`, `TabsPort::at_cap`, `ServicesPort::sessions_list(SessionScope::Global, None)`, `paths::ensure_default_workspace`, `ctx.prefs` (saved target) |
| 5 | 5.5 | 1 | `tauri_plugin_global_shortcut::GlobalShortcutExt::on_shortcut` on the `AppHandle`. The plugin is already registered in `lib.rs`; the step's `app.handle().plugin(..)` would register it twice (note N6). Read the shortcut with `ctx.prefs.get_string("quickEntryShortcut")` |
| 5 | 5.5 | 2 | `ashpd::register_host_app` + `ashpd::desktop::global_shortcuts` (ashpd 0.11.1, in `Cargo.toml`); module-internal |
| 5 | 5.5 | 3-4 | module-internal (private backend trait) |
| 5 | 5.6 | 1 | `TrayIconBuilder` through `AppHandle` (features `tray-icon`, `image-png`), `include_str!` of `src/main/tray-mark.ts`, `ctx.i18n.language()`; clicks go to `Bridge::emit_to_window(DesktopPort::target_window(), "menu:action", ..)` |
| 5 | 5.6 | 2 | `ctx.i18n.t(MainTextKey::Menu*)`, `Bridge::emit_to_window(.., "menu:action", ..)` (queued until a new window attaches), `DesktopPort::rebuild_menu(&self)` (the step writes `rebuild_menu(ctx)`), `Host::open_url` for Help links |
| 5 | wave rules + 5.6 | 2 ("Check for Updates…" item) | resolved: `MainTextKey::MenuCheckForUpdates` (`"menu.checkForUpdates"`) is a documented Rust-only key (`i18n.rs` `RUST_ONLY_KEYS`, enforced by `mirrors_every_text_key_in_the_typescript_table`), and the click handler calls `UpdaterPort::check_now()`. This is a deliberate addition with no TS counterpart; the inventory row's TS anchor is still not a desktop call (note N9) |
| 5 | 5.6 | 3 | module-internal + `WebviewWindow::set_icon` |
| 5 | 5.6 | 4 | `Caller.win_id`, `DesktopPort::set_run_progress`, state through `as_any` (5.4 row above) |
| 5 | 5.7 | 1 | `tauri_plugin_deep_link::DeepLinkExt::register_all` via `AppHandle`; the scheme is in `tauri.conf.json` `plugins.deep-link.desktop.schemes` |
| 5 | 5.7 | 2 | `std::env::args()`, `ports::SUPERVISOR_ARGV`; second instance: `DesktopPort::on_second_instance(argv, Some(cwd))`, called by `lib.rs` (the step writes `(ctx, argv)`). macOS `RunEvent::Opened`: `tauri-plugin-deep-link` 2.6.1 forwards every `Opened` URL, `file://` included, to `DeepLinkExt::on_open_url` |
| 5 | 5.7 | 3 | `Bridge::emit_to_window(target, bridge::DEEP_LINK_CHANNEL, payload)` (the bridge keeps undelivered links per window and replays them on attach); the no-window `beforeSetup` buffer is module-internal |
| 5 | 5.8 | 1 | `DesktopPort::{request_quit, is_quitting, quit_risk, approve_quit_before_install, withdraw_quit_approval}`, `TabsPort::tab_inventory() -> Vec<WindowTabFact>`, `QuitRisk`, `Host::message_dialog(MessageDialogOptions { .. })` with `MainTextKey::{QuitWorkingTitle, QuitWorkingBody, QuitKeepWorking, QuitQuitAnyway}` via `ctx.i18n.t_with`. Put the safe button last (note N2) |
| 5 | 5.8 | 2 (window `CloseRequested`) | `WebviewWindow::on_window_event` + `CloseRequestApi::prevent_close` |
| 5 | 5.8 | 2 (`RunEvent::ExitRequested`, macOS `Reopen`) | resolved: `DesktopPort::on_exit_requested(&self, code: Option<i32>) -> bool`. `lib.rs` calls `api.prevent_exit()` and skips `shutdown()` when it returns true. `DesktopPort::on_reopen(&self, has_visible_windows)` is wired to `RunEvent::Reopen` on macOS. Return `false` for `Some(code)`: the app's own exits (`request_quit`, the updater, SIGTERM) arrive with a code (note N13) |
| 5 | 5.9 | gate | module-internal |
| 6 | 6.1 | 1 | module-internal |
| 6 | 6.2 | 1 | `paths::agent_dir()`; `ServicesPort::{sessions_list, sessions_dir, session_delete, session_search, session_kind_for}` |
| 6 | 6.2 | 2 | `Bridge::broadcast_main("sessions:changed", Value::Null)`, `ServicesPort::on_sessions_changed`; the watcher starts in `services::init` |
| 6 | 6.2 | 3 (`sessions:list`, `sessions:search`) | `TabsPort::cwd_for(caller, None)` + the module's own index |
| 6 | 6.2 | 3 (`sessions:delete`, `sessions:rename`) | `TabsPort::{session_owner, session_owner_is_live, note_session_file}`, `TabsPort::command_for_idle_session(..) -> BoxFuture<'static, Option<Value>>` ("queued on stdin before this returns"), called synchronously and awaited in `Reply::Later`. Rename fallback: `TabsPort::sidecar_for_window(caller.win_id)` + `SidecarHandle::{status, has_rpc_client, request}` |
| 6 | 6.2 | 3 (`session:open-new-window`) | `TabsPort::session_owner`, `DesktopPort::focus(owner.win_id)`, `TabsPort::at_cap`, `TabsPort::cwd_for` → `paths::initial_cwd` → `dirs::home_dir()`, the module's own `session_kind_for`, `DesktopPort::spawn_window(cwd, Some(path), kind)` |
| 6 | 6.2 | 3 (`session:consume-pending`) | `DesktopPort::consume_pending_session(caller.win_id)` |
| 6 | 6.3 | 1-5 | `TabsPort::cwd_for(caller, payload.tabId)`; `ServicesPort::sessions_dir()` for `fs:read-plan` (`ipc.ts:1152`); the rest is module-internal |
| 6 | 6.4 | 1 | `Host::save_dialog(SaveDialogOptions { default_path, filters: Vec<FileFilter>, parent: Some(caller.win_id), .. })`, `Host::open_dialog(OpenDialogOptions { directory, multiple, can_create_directories, parent, .. })`, cleared on `DesktopPort::on_window_closed` |
| 6 | 6.4 | 1, 5; 6.5 step 3 (dialog memory, notify dedupe, log buffer) | resolved: `ctx.services.as_any().downcast_ref::<services::Services>()` from `system:*-dialog`, `system:notify` and `log:snapshot` |
| 6 | 6.4 | 2 | `Host::open_url` after the `http`/`https` check |
| 6 | 6.4 | 3 | `TabsPort::cwd_for` for relative targets, `Host::open_path`, then `Host::reveal_in_folder` on failure or for launchable files |
| 6 | 6.4 | 4 | `Host::clipboard_read_text()` |
| 6 | 6.4 | 5 | `Host::notify(title, body)`; on failure, `runtime_log::write` with `source: "notification"` |
| 6 | 6.4 | 6 | `OmpPort::resolve_editor_command()` (the step names `omp::shell_env`, a private omp file; the contract is the port method); the editor `PATH` comes from `OmpPort::spawn_env()["PATH"]` (TS `spawnPath`, `editor.ts:34`) |
| 6 | 6.5 | 1 | `ctx.prefs.{get, all, set}`, `DesktopPort::is_main_owned_pref_key`, `DesktopPort::rebuild_menu` |
| 6 | 6.5 | 2 | `runtime_log::write(&report, Some(caller.win_id.0), cwd)`, `DesktopPort::record(caller.win_id)`, `runtime_log::path()`; both are already implemented in the stub |
| 6 | 6.5 | 3 | `Bridge::broadcast_main("log:line", json!({ "lines": .., "nextSequence": .. }))`, `paths::agent_dir()` |
| 6 | 6.5 | 4 | module-internal (`paths::agent_dir()`) |
| 6 | 6.5 | 5 | resolved: `Services::new(ctx: CtxRef)`. `execute_host_tool(&self, caller, name, args)` upgrades the context and moves the `Arc<AppCtx>` into the `'static` future for `ctx.host.{open_url, notify, clipboard_read_text}` |
| 6 | 6.6 | 1-5 | `paths::user_data_dir()`, `prefs::RENDERER_STORAGE_KEYS`, `prefs::renderer_storage_pref_key`, `ctx.prefs.{get, set}` (reached from `import_legacy_renderer_storage(&self)` through the `CtxRef`), `runtime_log::note`; run by `services::init` before any window exists |
| 6 | 6.7 | gate | module-internal |
| 7 | 7.1 | 1-5 | module-internal, except the login-shell env: `base-url.ts:7` (`resolveLoginShellEnv`) and `probe.ts:9` (`spawnPath`) map to `OmpPort::spawn_env()` through `Ollama::new(ctx)`. The phase text still says "calls no other wave module" (note N12). GPU-name fallback log: `runtime_log::note` |
| 7 | 7.2 | 1 | module-internal, `Reply::Later` |
| 7 | 7.2 | 2 | `Bridge::emit_to_window(caller.win_id, "ollama:pull-progress", ..)` |
| 7 | 7.2 | 2-3 (active pull, remedy gate) | resolved: `ctx.ollama.as_any().downcast_ref::<ollama::Ollama>()` from `ollama:pull`, `ollama:pull-cancel` and `ollama:remedy` |
| 7 | 7.2 | 3 | `Bridge::broadcast_main("ollama:install-progress", ..)`, `Host::open_url(OLLAMA_DOWNLOAD_URL)` |
| 7 | 7.2 | 4 | `bridge::dispatch_for_test`, `testing::fake_ctx_cyclic` with the real `Ollama` installed through `testing::Ports` |
| 7 | 7.2 | shutdown (cancel the pull on exit) | resolved: `lib.rs::shutdown` now runs `mark_quitting → tabs.dispose_all → omp.shutdown → services.shutdown → ollama.shutdown → updater.shutdown → desktop.shutdown` (`OllamaPort::shutdown`) |
| 7 | 7.3 | gate | module-internal |
| 8 | 8.1 | 1 | module-internal |
| 8 | 8.2 | 1 | `Host::app_version()` for the `semver` comparison, `tauri::is_dev()`, the 4 h timer from `updater::init`, `Bridge::broadcast_main("updater:status", ..)`, `UpdaterPort::status()` for `updater:getStatus` |
| 8 | 8.2 | 1 (`check_now`) | resolved: `Updater::new(ctx: CtxRef)`. `UpdaterPort::check_now(&self)` upgrades the context for `ctx.host.app_version()` and `ctx.bridge.broadcast_main(..)` |
| 8 | 8.2 | 2 | `Bridge::broadcast_main("updater:status", ..)` every 100 ms |
| 8 | 8.2 | 2-3 (download and install state) | resolved: `ctx.updater.as_any().downcast_ref::<updater::Updater>()` from `updater:download` and `updater:apply`; `UpdaterPort::status` reads the same struct |
| 8 | 8.2 | 3 (macOS) | `Host::reveal_in_folder` + `Host::open_path` (`updater.ts:120-121`); the step's direct `tauri-plugin-opener` call goes through `Host` |
| 8 | 8.2 | 3 (AppImage, deb approval) | `DesktopPort::approve_quit_before_install()`, `DesktopPort::withdraw_quit_approval()`, `MainTextKey::UpdatesInstallFailed` (and the other `updates.*` keys), `Host::exit(0)` |
| 8 | 8.2 | 3 (relaunch, then exit) | resolved: `Host::relaunch_after_exit(&self, program: PathBuf)` (no arguments), then `Host::exit(0)`. `lib.rs` starts the program in the `RunEvent::Exit` arm after `shutdown()`. Plugin `on_event` hooks run before the app callback (`tauri-2.12.1/src/app.rs:2811-2815`), so the single-instance name is already released by then. `FakeHost::relaunches` records it (environment caveat: note N14) |
| 8 | 8.1, 8.2 | `installsOnQuit` (automatic AppImage, macOS, Windows) | resolved: `UpdaterPort::shutdown(&self) -> BoxFuture<'_, ()>`, run in the frozen order after `tabs.dispose_all` and `ollama.shutdown` and before `desktop.shutdown`; it installs when `installs_on_quit(mode, kind)` holds |
| 8 | 8.2 | 3 (Windows) | `Host::exit(0)` after starting the installer |
| 8 | 8.2 | 4 | `Host::app_version()` (`TauriHost` returns `package_info().version`) |
| 8 | 8.3 | 1-6 | module-internal (packaging). Risk: `externalBin: ["binaries/omp"]` installs the sidecar at `/usr/bin/omp` in the deb, where `paths::resolve_bundled_omp()` (exe dir + `omp`) finds it. That is also the conventional path of a system `omp`, so dpkg fails if another package owns it |
| 8 | 8.4-8.7 | all | module-internal |
| 9 | 9.1 | 1-2 | module-internal (renderer); no Rust contract |
| 9 | 9.2 | 1-7 | already on `main` (`fa1b9c6`). The runtime contracts are foundation-owned: `webview.rs` Linux media hooks, `tauri.conf.json` CSP `script-src 'self'` for the worklet, and `rpc:command` (tabs) for `transcribe_audio` |
| 9 | 9.3 | 1-3 | module-internal |
| 9 | 9.4 | gate | module-internal |

## Notes found during the walk (not gaps)

Contracts exist for these, but the frozen implementation or the plan text still needs attention.

- **N1 (resolved in `a8406a4`).** `bridge::omp_attach` is now `async`, so attach replays run on Tauri's runtime. `Bridge` spawns `Later` replies and gap timers through a private `spawn_task`. That helper uses `tokio::runtime::Handle::try_current()` when a runtime is driving the caller, and falls back to `tauri::async_runtime::spawn`, so no path calls `tokio::spawn` from the main thread.
- **N2 (open, foundation).** `TauriHost::message_dialog` (`lib.rs`) still maps the plugin result `MessageDialogResult::Cancel` to `fallback` and maps `Custom(label)` by position. On Linux, `tauri-plugin-dialog` 2.8.1 turns a dismissed two-button dialog into `Custom(cancel_label)` (`desktop.rs:227-251`), so dismissal returns index 1 rather than `cancel_button`. That contradicts the `Host` doc. Callers must put the safe button last, or the mapping must change.
- **N3 (open, foundation).** `Bridge::emit_to_window` still recreates a `WindowState` for any unknown id (`bridge.rs:590`, `entry().or_insert_with`). Sidecar events that arrive after `unregister_window` resurrect a closed window, and `broadcast_main` then queues up to 1,000 envelopes for it. No phase names the `Bridge::unregister_window` call.
- **N4 (contract resolved, plan text open).** The `EventBatcher` doc now says the manager batches `SidecarEvent::Events` and the pool forwards them unchanged. Phase 3 Task 3.2 step 3 ("Phase 4 constructs it per tab") and Phase 4 Task 4.2 step 4 ("Batch `rpc:events` through the frozen `EventBatcher`") still say the opposite. An executor that follows Phase 4 literally would batch twice.
- **N5 (resolved in `a8406a4`).** The `SidecarOptions.extra_flags` doc now matches Phase 3 Task 3.4 step 2 and TS.
- **N6 (open, plan conflict).** Phase 5 Task 5.5 step 1 still registers `tauri-plugin-global-shortcut` again, though `lib.rs` already registers it. Use `GlobalShortcutExt::on_shortcut`.
- **N7 (open, plan conflict).** Phase 3 Task 3.4b step 1 still says "no `unsafe` needed", but `OwnedFd::from_raw_fd(3)` is an `unsafe fn`, and the wave rule allows `unsafe` only in `manager.rs`'s `pre_exec`.
- **N8 (open, contract text).** `SidecarError::Timeout(u64)` and `Closed` still display English strings that differ from the TS messages the renderer shows (`RPC timeout (8000ms): get_state`). Return `Other(ts_message)` to keep parity.
- **N9 (open, inventory anchors).** `cross-module-calls.json` (57 entries) has three wrong or missing anchors. None of them breaks the trait-method test.
  - `desktop → updater check_now` is anchored at `updater.ts:217` (`setupUpdater`), which is not a desktop call site. The menu item is a Rust-only addition.
  - `ollama → omp spawn_env` is anchored at `remedy.ts:1`, a doc comment. The real call sites are `base-url.ts:7` and `probe.ts:9`.
  - `services → omp spawn_env` (`editor.ts:34`, `spawnPath`) is still missing.
- **N10 (partly resolved).** `testing::fake_ctx_cyclic` and `testing::Ports` let a module install its real port, so handler tests no longer have to assert on fakes. `tauri` still has no `test` feature in `Cargo.toml`, so `desktop` window and lifecycle tests need a private window-backend trait.
- **N11 (open, modules).** `tokio::spawn` and `tokio::process::Command::spawn` panic on the main thread. That thread runs setup/`init` and the menu, tray, shortcut, deep-link and single-instance callbacks. Module code reachable from there must use `tauri::async_runtime::spawn`. The bridge's `spawn_task` is private and does not cover module code.
- **N12 (new, plan text).** Phases 3 to 9 were not updated for `a8406a4`. None of them mentions `CtxRef`, `as_any`, `fake_ctx_cyclic`/`Ports`, `on_exit_requested`/`on_reopen`, `UpdaterPort::shutdown` or `Host::relaunch_after_exit`. Several still carry the superseded wording:
  - Phase 3 Task 3.3: `Omp::spawn_env(ctx)`.
  - Phase 5: `rebuild_menu(ctx)` and `on_second_instance(ctx, argv)`.
  - Phase 6 Task 6.4: `omp::shell_env`.
  - Phase 7: "calls no other wave module".
  - Phase 8 Task 8.2 step 3: relaunch, without naming `Host::relaunch_after_exit`.
  
  Phase 2's Design was updated.
- **N13 (new, contract use).** `lib.rs` asks `DesktopPort::on_exit_requested(code)` on every `ExitRequested`, including the app's own `Host::exit(0)` / `AppHandle::exit(0)` from `request_quit`, the updater and the SIGTERM listener. Those arrive as `Some(0)`, and `prevent_exit` is honoured for them (`app.rs:90-94` ignores it only for the restart code). The desktop implementation must answer `false` for `Some(_)`, or it can veto its own quit, the update install or a SIGTERM. Add that rule to Phase 5 Task 5.8 and a unit test with `FakeDesktop::prevent_exit`.
- **N14 (new, foundation).** `start_pending_relaunch` spawns the program with the exiting process's full environment, removing only `APPIMAGE_EXIT_AFTER_INSTALL`. From an AppImage, that includes `APPDIR`, `APPIMAGE`, `LD_LIBRARY_PATH` and GStreamer/GIO paths that point into the old squashfs mount, which disappears once this process exits. The new AppImage's `AppRun` normally overwrites these. For the deb relaunch of `/usr/bin/sai-atlas` from an AppImage-free environment, this does not apply. Phase 10's packaged smoke test should cover the relaunch.

## Summary

**0 gaps** at `a8406a4` (no table row has a `GAP:` contract). Each of the 16 gaps from `bc859d4` now maps to a frozen contract:

1. P3 3.3, proxy pref in `spawn_env` → `Omp::new(ctx: CtxRef)` + `ctx.prefs`.
2. P3 3.4 step 2, launch profile on every spawn → `CtxRef` in the manager + the new `SidecarOptions.extra_flags` doc.
3. P3 3.5, bench and stats state → `OmpPort::as_any`.
4. P4 4.2 step 3, pool needs other ports → `Tabs::new(ctx: CtxRef)`.
5. P4 4.2 step 5, synchronous stdin write → `SidecarHandle::request` and `TabsPort::command_for_idle_session` return `'static` futures, queued before return.
6. P5 5.4 / 5.6 step 4, desktop handler state → `DesktopPort::as_any`.
7. P5 5.8 step 2, `ExitRequested` / `Reopen` → `DesktopPort::on_exit_requested` + `on_reopen`, wired in `lib.rs` (see N13 for the `Some(code)` rule).
8. P5 "Check for Updates…" → `MainTextKey::MenuCheckForUpdates` as a documented Rust-only key.
9. P6 6.4 / 6.5 step 3, services handler state → `ServicesPort::as_any`.
10. P6 6.5 step 5, `execute_host_tool` needs the host → `Services::new(ctx: CtxRef)`.
11. P7 7.2, pull and remedy state → `OllamaPort::as_any`.
12. P7 shutdown → `ctx.ollama.shutdown()` in the frozen order.
13. P8 8.2 step 1, `check_now` → `Updater::new(ctx: CtxRef)`.
14. P8 8.2 steps 2-3, updater handler state → `UpdaterPort::as_any`.
15. P8 install on quit → `UpdaterPort::shutdown` in the frozen order.
16. P8 relaunch → `Host::relaunch_after_exit`, run in `RunEvent::Exit` after the single-instance name is released.

Recommended before the wave branches: fix N2 and N3 in the foundation; update the Phase 3 to 9 text for N4, N6, N7, N12 and N13; correct the three inventory anchors in N9.
