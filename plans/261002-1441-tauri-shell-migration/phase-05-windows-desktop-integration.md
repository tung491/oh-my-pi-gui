---
phase: 5
title: "Windows, quick entry, shortcuts, tray, menu, deep links, quit guard"
status: pending
priority: P1
effort: "8d"
dependencies: [2]
module: desktop
---

# Phase 5: Desktop integration (module `desktop`)

## Goal

Rust owns every OS-facing desktop surface: chat windows with persisted bounds and tab layouts, the quick-entry bar, global shortcuts (including native Wayland through the GlobalShortcuts portal), the tray, the app menu, `omp://` deep links with a single instance, the quit guard and the dock/taskbar badge and progress. Webview security and the Linux WebKitGTK hooks live in the foundation's `webview.rs`; this module only calls `webview::build_window`.

## Wave rules

Same as Phase 3 (`phase-03-omp-processes.md` → Wave rules, including "Frozen wiring"), with these substitutions: worktree `../worktrees/tauri-desktop`, branch `tauri/desktop`, owned path `src-tauri/src/desktop/**`, gate `bash scripts/check-module.sh desktop`. This module replaces the temporary window opener that Phase 2 left in `desktop::init` (`desktop/mod.rs:186-201`), and the stub answers that let the shell start before the wave: `record`, `records`, `main_window` and `target_window` answer "no window known", and `on_exit_requested` always answers `false`.

Cross-module calls go only through the frozen traits in `src-tauri/src/ports.rs`: `ctx.tabs` (`acquire`, `restore_layout`, `tab_layout_for_window`, `on_window_tabs_changed`, `tab_inventory`, `at_cap`), `ctx.services` (`sessions_list` for quick-entry workspaces), `ctx.updater` (`check_now` for the menu's "Check for Updates…" item), `ctx.bridge` (`emit_to_window`, `unregister_window`) and `ctx.host` (`message_dialog`, `open_url`, `exit`). `tabs.dispose_all` belongs to the frozen shutdown order in `lib.rs`, not to this module. `Desktop::new(app: AppHandle, ctx: CtxRef)` holds the real `AppHandle` (Wry runtime), so `tauri::test::mock_app()` (a `MockRuntime` app, available through the `tauri` `test` dev-feature) cannot build a `Desktop`: keep each decision in a pure function or behind a private window-backend trait, and unit-test that. Handlers reach the module's state (quick-entry controller, shortcut registration, tray and progress snapshots) with `ctx.desktop.as_any().downcast_ref::<desktop::Desktop>()`. `init`, the menu, tray, shortcut, deep-link and single-instance callbacks all run on the main thread, so every task they start goes through the spawning helper from the Phase 3 Wave rules, never bare `tokio::spawn`. Tests build an `AppCtx` with `testing::fake_ctx_cyclic` from `testing.rs` fakes. Every manual run uses `bun run dev:tauri -- --user-data-dir=$(mktemp -d)`: for a non-default profile `lib.rs` sets the Tauri identifier to `paths::single_instance_id()` (`lib.rs:385-387`), so the single-instance D-Bus name and the GtkApplication name stay away from the user's real app, while the Wayland `app_id` stays `vn.io.vif.saiatlas` (`main.rs` `glib::set_prgname`).

## Files (owned)

- `src-tauri/src/desktop/mod.rs`, `src-tauri/src/desktop/ipc.rs`
- Create as needed: `windows.rs`, `window_bounds.rs`, `tab_layout.rs`, `quick_entry.rs`, `quick_entry_core.rs`, `shortcut.rs`, `shortcut_core.rs`, `wayland_portal.rs`, `tray.rs`, `tray_labels.rs`, `menu.rs`, `deep_link.rs`, `launch_argv.rs`, `app_quit.rs`, `quit_guard.rs`, `app_icons.rs`, `lifecycle.rs`. No `unsafe` in this module.

## Tasks

### Task 5.1: Pure cores first
- Goal: ports of the logic-only modules with all their tests, before any window code.
- Targets and test counts: `quick_entry_core.rs` ← `quick-entry-core.ts` (24), `shortcut_core.rs` ← `quick-entry-shortcut-core.ts` (20), `wayland_portal.rs` ← `wayland-portal.ts` (12), `tray_labels.rs` ← `tray-labels.ts` (11), `tab_layout.rs` ← `tab-layout.ts` (13), `window_bounds.rs` ← `window-bounds.ts` (5), `launch_argv.rs` ← `launch-argv.ts` (10), `quit_guard.rs` ← `quit-guard.ts` (3).
- Steps:
  1. For each pair, read the TS file and its test, port the functions with `snake_case` names, and port every test with its normalized name.
  2. `wayland_portal.rs` keeps the detection logic (`XDG_SESSION_TYPE=wayland` → portal mode). The Chromium feature-flag list (`PORTAL_SHORTCUT_FEATURES`) has no Tauri meaning; replace those tests' assertions with assertions on the Rust mode decision, keeping the test names.
- Success criteria: 98 tests pass.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::` exits 0 and the summary shows at least `98 passed`.

### Task 5.2: Window manager
- Goal: `WindowRegistry` and `spawn_window` behave like `src/main/window.ts` and `index.ts:260-346`.
- Target: `windows.rs`.
- Steps:
  1. Read `src/main/window.ts` in full.
  2. Windows get `WindowId(n)` (incrementing from 1; `WindowId::QUICK_ENTRY` is 0; label `main-<n>`), title `Sai ATLAS` (`product::PRODUCT_NAME`), default 1400×900, `min_inner_size: Some((800.0, 600.0))`, and bounds restored from `ctx.window_state` key `windowState` through `window_bounds::restore_within_displays` (monitors from `self.app.available_monitors()`). `WindowSpec` has no maximized field: call `WebviewWindow::maximize()` on the returned window when the saved bounds say `isMaximized`, as `window.ts:181-183` does after construction.
  3. Build every window with the foundation's `webview::build_window(&self.app, WindowSpec { kind: WindowKind::Main, win_id, url: "index.html", title, inner_size, min_inner_size, position, background_color, ..Default::default() })`, varying only `WindowSpec` fields (`webview.rs:35-56`). It already registers the window with the bridge (`Bridge::register_window`) and applies the init script (`bridge::bootstrap_script(ctx, caller)`), the shared data directory, the navigation lock, drop handling, the Linux sandbox, media, spelling and crash reload. Do not duplicate any of it here, and do not edit `webview.rs`; a missing field is a plan bug (Failure Protocol). The window icon has no spec field: set it after build with `WebviewWindow::set_icon`. There is no `ready-to-show` hook, so chat windows are built `visible: true` with a `background_color` instead of `show: false`.
  4. Persist bounds on move/resize (debounced 500 ms) and on close, with the same `{ x, y, width, height, isMaximized }` shape, through `WebviewWindow::on_window_event` (`Moved`, `Resized`, `CloseRequested`) and `ctx.window_state.set("windowState", …)`.
  5. Tab layouts: register `ctx.tabs.on_window_tabs_changed(Box::new(…))` in `desktop::init` (the closure captures `Arc::downgrade(ctx)`); on each change write `ctx.prefs.set("tabLayouts", …)` and `ctx.prefs.delete("tabLayout")`, exactly as `index.ts:277-298`, skipped while `is_quitting()` (Task 5.3). At startup, read both through `tab_layout::sanitize_persisted_tab_layouts` and open one window per saved layout through `ctx.tabs.restore_layout(win_id, layout)`.
  6. Implement the registry methods (`records`, `record`, `main_window`, `target_window`, `focus`, `set_cwd`, `consume_pending_session`, `set_run_progress`, `on_window_closed`) and `spawn_window(cwd, pending_session_path, kind)`: refuse with `None` when `ctx.tabs.at_cap()`, resolve the cwd with `paths::initial_cwd` (then `paths::ensure_default_workspace()` for Work mode), build the window, then `ctx.tabs.acquire(AcquireOptions { kind, fresh, placeholder, .. })` (`AcquireOptions::new(cwd, win_id)` fills the defaults). `spawn_window` runs on the main thread (menu, tray, deep link, second instance), which is why the sidecar manager spawns through `tauri::async_runtime` (Phase 3 Task 3.4 step 4). `set_run_progress` maps working/waiting/idle to `WebviewWindow::set_progress_bar` (Windows/Linux taskbar) and the macOS dock badge through the `AppHandle` (`●` / `!` / empty, `window.ts:421-424`).
  7. Remove Phase 2's temporary opener from `desktop::init`.
- Success criteria: closing and reopening the app restores the window position and its tabs.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::windows` exits 0. Then, with `bun run dev:tauri` started through the background runner: move the window, quit from the menu, start again, and, for the throwaway profile passed with `--user-data-dir=$PROFILE`, `jq .windowState "$PROFILE/window-state.json"` shows the new position. Stop the dev process.

### Task 5.3: App lifecycle and close ordering
- Goal: quitting and closing behave as `src/main/index.ts:396-555` does, so multi-window restore and the tray process survive.
- Target: `lifecycle.rs`.
- Steps:
  1. Read `index.ts:396-555`, `sidecar-pool.ts:754-767` and `app-quit.ts:44-50`.
  2. On quit, the frozen shutdown order (`lib.rs:286-308`) calls `DesktopPort::mark_quitting` first; `is_quitting` reads the latch. While the latch is set, `tabLayouts` is not rewritten when windows close, so a three-window session restores as three windows. Test: `quit with three windows keeps three saved layouts`.
  3. On Linux and Windows, closing the last chat window destroys the hidden quick-entry window and calls `request_quit`, so no hidden process stays behind. `request_quit` ends in `ctx.host.exit(0)`, which runs Tauri's exit path and therefore the frozen shutdown order. On macOS the app stays running, as today. Test: `closing the last window quits on linux`.
  4. When a window is destroyed, notify the `on_window_closed` subscribers (tabs `release_window`, services dialog memory, omp bench) while its record still exists, then drop the record, then call `ctx.bridge.unregister_window(win_id)` so the bridge forgets the window (an unregistered window's late events are dropped and counted, `bridge.rs:718`). Test: `closing a window notifies subscribers before the record and the bridge entry go`.
  5. `DesktopPort::shutdown` (the last step of the frozen order) destroys the quick-entry window and the tray.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::lifecycle` exits 0 with at least `3 passed`.

### Task 5.3b: Voice in a real window (Linux)
- Goal: confirm that dictation works end to end in a window this module builds: the foundation's media hooks (`enable-media-stream`, `enable-webaudio`, `permission-request` → allow) plus the renderer's WebAudio PCM capture from Phase 9 Task 9.2, which is already on `main` (`MediaRecorder` is unusable on this WebKitGTK build, Phase 0 S4).
- Steps: `test -x resources/omp`, then in `bun run dev:tauri -- --user-data-dir=$(mktemp -d)` (sandbox on, as always) enable `stt` in settings, press the composer's dictation button, speak for about two seconds, stop. The recording indicator appears while recording, and a transcript (possibly imperfect) lands in the composer.
- Success criteria: the capture used the worklet, not the fallback, and the sidecar received the WAV.
- Verify: in the webview console, `typeof AudioWorkletNode === "function" && "audioWorklet" in AudioContext.prototype` prints `true` (so Task 9.2's capture took the worklet path, which it prefers whenever the engine offers it), and `grep -c transcribe_audio` over the dev run's runtime log prints at least `1`. Stop the dev process. There is no accepted degradation for this check; a FAIL follows the Failure Protocol.

### Task 5.4: Quick-entry bar
- Goal: a port of `src/main/quick-entry.ts` with the five `quick-entry:*` bar handlers and the five main-window ones.
- Target: `quick_entry.rs`, `ipc.rs`.
- Steps:
  1. Read `src/main/quick-entry.ts` in full.
  2. Window: mirror the options at `src/main/quick-entry.ts:246-268` as a `WindowSpec` for `webview::build_window` (`kind: WindowKind::QuickEntry`, `win_id: WindowId::QUICK_ENTRY`, `url: "quick-entry.html"`; same data directory as chat windows, so theme changes show on the next summon): `visible: false` at creation, `decorations: false`, `minimizable: false`, `maximizable: false`, `skip_taskbar: true`, `always_on_top: true`, `focused: true` when shown, `background_color` `#0a1a33` (dark) or `#f7f9fc` (light) from the system theme, position from `quick_entry_core::quick_entry_bounds` on the monitor under the cursor. "No menu" has no spec field: call `WebviewWindow::remove_menu()` after build on Linux and Windows (`quick-entry.ts:271`). Size: `inner_size`, `min_inner_size` and `max_inner_size` all equal to `QUICK_ENTRY_SIZE` (680×168, `src/main/quick-entry-core.ts:13`), and `resizable` left at its default. Do not set `resizable: false`: on GTK it makes the window 680×200 and the page reports `innerHeight` 200 (Phase 0 S6 human check; equal min/max gave 680×168). Accepted degradation (user, 2026-10-02): Mutter ignores always-on-top for Wayland toplevels, so the bar does not stay above other windows there. On macOS, convert it to an `NSPanel` with `tauri-nspanel` (non-activating, hidden in Mission Control, matching `quick-entry.ts:259`). `Cargo.toml` pins `tauri-nspanel = "2"` from crates.io (2.1.0, which targets Tauri 2) for `cfg(target_os = "macos")` only; this host cannot compile it (no Apple toolchain, gate 9 WARN), so write the panel code behind `#[cfg(target_os = "macos")]` and leave its build and on-screen check to Phase 12 Task 12.1 step 5. If Phase 12 finds the crate unusable, the fallback is a normal always-on-top window.
  3. Port the queue/lease/restore flow through `quick_entry_core`, and send the bar its state with `ctx.bridge.emit_to_window(WindowId::QUICK_ENTRY, bridge::QUICK_ENTRY_STATE_CHANNEL, state)`; the bridge keeps it as replay state and delivers it when the bar attaches. A claim sends `ctx.bridge.emit_to_window(target, bridge::DEEP_LINK_CHANNEL, json!({ "action": "quick-entry" }))` to the target chat window. Port the menu-chord filter (`quick-entry.ts:286-288`, `isBlockedMenuChord`): chords the app menu owns are swallowed while the bar has focus. Electron's `before-input-event` has no Tauri equivalent; if no Tauri hook can swallow a chord, record it as a concern in the status report rather than editing a frozen file.
  4. Port all ten handlers, already registered in `desktop::register` with their scopes (`quick-entry:submit`, `consume-restored`, `dismiss` with `Scope::QuickEntry`; `claim`, `ack`, `return`, `shortcut-get`, `shortcut-set`, `shortcut-suspend`, `shortcut-notice` with `Scope::Main`). A bar handler's caller is `Caller::quick_entry()`. The submit path uses `ctx.tabs.at_cap()`, `ctx.services.sessions_list(SessionScope::Global, None)` for workspaces, `paths::ensure_default_workspace()` and the saved target in `ctx.prefs`.
- Success criteria: the shortcut opens the bar at exactly 680×168, a prompt submitted with Enter or with the bar's Send button (`src/renderer/quick-entry/QuickEntryBar.tsx`, commit `2b0b698`; both paths call `quick-entry:submit`) lands in the target window's tab, and dismissing hides it.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::quick_entry` exits 0, including one dispatch test per handler (10) through `bridge::dispatch_for_test` with `testing.rs` fakes. Then, with `bun run dev:tauri -- --user-data-dir=$(mktemp -d)` running, summon the bar and in its webview console run `[innerWidth, innerHeight]`: it prints `[680, 168]`. Type a prompt and click Send: a new tab in the main window carries it. Record PASS or FAIL for both, then stop the dev process.

### Task 5.5: Global shortcuts
- Goal: a port of `src/main/quick-entry-shortcut.ts`, with two backends.
- Target: `shortcut.rs`.
- Steps:
  1. macOS, Windows and Linux X11: register through `tauri-plugin-global-shortcut` 2.4. `lib.rs:408` already registers the plugin (`tauri_plugin_global_shortcut::Builder::new().build()`); registering it again would fail, so do not call `.plugin(...)`. Use the extension trait instead: `use tauri_plugin_global_shortcut::GlobalShortcutExt;` then `app.global_shortcut().on_shortcut(shortcut, handler)` (and `unregister` for `shortcut-suspend`). The handler runs on the main thread. Accelerators come from `src/shared/hotkeys.ts` (`CommandOrControl+Shift+O`) and the saved pref `ctx.prefs.get_string("quickEntryShortcut")` (`QUICK_ENTRY_DEFAULT_CHORD` is `⇧⌃␣`).
  2. Linux Wayland (`wayland_portal` mode): the plugin is X11-only and fails silently on Wayland ([tauri #3578](https://github.com/tauri-apps/tauri/issues/3578)). Use `ashpd::desktop::global_shortcuts::GlobalShortcuts` instead. First register the host app id `vn.io.vif.saiatlas` with the host Registry portal; xdg-desktop-portal 1.20 and later (this machine has 1.21.1) reject `GlobalShortcuts` from unregistered apps ([electron #51875](https://github.com/electron/electron/issues/51875)). Then `create_session`, `bind_shortcuts` with the preferred triggers translated from the accelerator, and listen to `receive_activated`.
  3. Port `shortcut-suspend` (unregister while the settings recorder is open) and the startup notice.
  4. Port `quick-entry-shortcut.test.ts` (6 tests) against a fake backend trait (private to this module).
- Success criteria: on this GNOME Wayland machine, the chord opens the bar while another app has focus. Phase 0 S5 verified only the portal plumbing (registration, session, `BindShortcuts`); the chord firing on screen was deferred by the user (2026-10-02), so this check is mandatory here.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::shortcut` exits 0. Then, with `vn.io.vif.saiatlas.desktop` installed in `~/.local/share/applications/` and `bun run dev:tauri` running: tell the user, ask them to approve GNOME's shortcut dialog if it appears, focus another app and press the chord. The bar appears, and the runtime log has one line for the activation. Record PASS or FAIL with the user's confirmation; a FAIL follows the Failure Protocol, since no degradation was accepted for S5.

### Task 5.6: Tray, menu and icons
- Goal: ports of `tray.ts`, `menu.ts`, `app-icons.ts`, plus the `tray:state-push` and `progress:set` handlers (`ipc.ts:435-450`).
- Target: `tray.rs`, `menu.rs`, `app_icons.rs`, `ipc.rs`.
- Steps:
  1. Tray: `tauri::tray::TrayIconBuilder` through `self.app` (the `tray-icon` and `image-png` Tauri features are enabled in `Cargo.toml`) with the template mark. Read `src/main/tray-mark.ts` with `include_str!`, extract `TRAY_MARK_SIZE` and the `TRAY_MARK_ALPHA` base64 with a regex at startup (unit-tested), and decode the alpha into RGBA. Phase 12 moves this source to a binary file when `src/main/` goes away. Labels and tooltip come from `tray_labels` and `ctx.i18n` (`language()`, `t`, `t_with`). Rebuild the menu only when `tray_labels::menu_signature` changes. On Linux, click events do not exist, so everything must be reachable from the menu (the TS menu already is). On macOS/Windows, left-click focuses the main window as today. Tray actions reach the renderer through `ctx.bridge.emit_to_window(target, "menu:action", …)` with `target` from `DesktopPort::target_window()`.
  2. Menu: port `menu.ts`, using `tauri::menu` with labels from `ctx.i18n.t(MainTextKey::Menu…)`, the recent-workspaces list and `menu:action` emits to the focused window (`ctx.bridge.emit_to_window`, which queues the action until a new window attaches). Help links open with `ctx.host.open_url`. The "Check for Updates…" item uses `MainTextKey::MenuCheckForUpdates` (`"menu.checkForUpdates"`), a documented Rust-only key with no TS counterpart (`i18n.rs` `RUST_ONLY_KEYS`), and its click calls `ctx.updater.check_now()`. Rebuild the menu when `prefs:set` changes `language`: `services` calls `ctx.desktop.rebuild_menu()` (`DesktopPort::rebuild_menu(&self)`, frozen in Phase 2).
  3. Icons: port `app-icons.ts` and its 7 tests (dock icon in dev on macOS; window icon on Linux/Windows through `WebviewWindow::set_icon`).
  4. `tray:state-push` and `progress:set` aggregate per-window snapshots keyed by `Caller.win_id` (`ipc.ts:346`), held in the `Desktop` struct and reached through `as_any`, and update the tray and `set_run_progress(RunProgressState)`.
- Success criteria: the tray shows status, the menu opens windows and fires actions. Phase 0 S8 verified the tray over D-Bus only (`GetLayout`, `Event clicked`); the icon being visible and a menu click from the shell were deferred by the user (2026-10-02), so this check is mandatory here. The missing left-click on Linux is an accepted degradation.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- desktop::tray desktop::menu desktop::app_icons` exits 0. Then, with `bun run dev:tauri` running, ask the user to confirm the icon is visible in the GNOME top bar, open its menu and click "Open Sai ATLAS": the main window gains focus, and the runtime log records the menu action. Record PASS or FAIL with the user's confirmation.

### Task 5.7: Deep links, single instance, launch arguments
- Goal: a port of `deep-link.ts` and the argv flow in `index.ts`.
- Target: `deep_link.rs`, `mod.rs` (`on_second_instance`).
- Steps:
  1. The `omp` scheme is already in `tauri.conf.json` → `plugins.deep-link.desktop.schemes` (Phase 2), and `lib.rs:403` registers `tauri_plugin_deep_link::init()`. In dev on Linux, call `app.deep_link().register_all()` (`use tauri_plugin_deep_link::DeepLinkExt;`) so `xdg-open` reaches the dev build.
  2. Cold start: parse `std::env::args()` with `launch_argv::parse_launch_argv`. It ignores `ports::SUPERVISOR_ARGV` and everything after it (that argv never reaches Tauri, because `main.rs` returns first, but the parser must not treat it as a workspace path if it ever does); add the test `ignores the supervisor argv`. Second instance: the single-instance callback in `lib.rs:396-400` calls `ctx.desktop.on_second_instance(argv, Some(cwd))` (`DesktopPort::on_second_instance(&self, argv: Vec<String>, cwd: Option<String>)`), which parses and focuses. Its Phase 2 body is still `todo!()` (`desktop/mod.rs`), and that callback runs inside a plugin callback whenever a second instance starts on the same profile, so implement it before the manual check below and add the test `a second instance with a link focuses and delivers it`. macOS: `lib.rs` has no `RunEvent::Opened` arm and is frozen; `tauri-plugin-deep-link` 2.6.1 forwards every `Opened` URL (including `file://`) to `app.deep_link().on_open_url(…)`, so register that handler in `desktop::init` for URLs and files.
  3. Buffer links that arrive before any window exists and replay them after setup (the `beforeSetup` queue in `deep-link.ts`); that buffer is this module's. Once a window exists, deliver with `ctx.bridge.emit_to_window(target, bridge::DEEP_LINK_CHANNEL, payload)`: the bridge keeps every undelivered link per window and replays it in order when the page attaches.
- Success criteria: `xdg-open "omp://new"` with the app running focuses it and opens a new session.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- desktop::deep_link desktop::launch_argv` exits 0, then the manual `xdg-open` check against `bun run dev:tauri` passes.

### Task 5.8: Quit guard
- Goal: a port of `app-quit.ts` with the `app:quit` handler.
- Target: `app_quit.rs`, `ipc.rs`.
- Steps:
  1. Port `request_quit`, `is_quitting`, `quit_risk`, `approve_quit_before_install`, `withdraw_quit_approval` (all `DesktopPort` methods). `quit_risk` aggregates `ctx.tabs.tab_inventory()` (`Vec<WindowTabFact>`) into `QuitRisk`. The confirmation goes through `ctx.host.message_dialog(MessageDialogOptions { title: ctx.i18n.t(MainTextKey::QuitWorkingTitle), message: ctx.i18n.t_with(MainTextKey::QuitWorkingBody, &[("working", …), ("total", …), ("windows", …)]), kind: MessageKind::Warning, buttons: vec![ctx.i18n.t(MainTextKey::QuitQuitAnyway), ctx.i18n.t(MainTextKey::QuitKeepWorking)], parent: <the focused window>, ..Default::default() })`, never through `tauri-plugin-dialog` directly. The safe choice goes last: a dismissed dialog answers the **last** button on every platform (`ports.rs:745-747`, `lib.rs:170-182`), and that matches `app-quit.ts:78-80` (`[quitAnyway, keepWorking]`, `cancelId: 1`). Answer `0` quits; `1` or a dismissal keeps working. `MessageDialogOptions` has no default-button field, so Electron's `defaultId: 1` (Enter keeps working) cannot be set: record in the status report which button Enter activates on GNOME.
  2. Exit requests: `lib.rs:431-438` asks `DesktopPort::on_exit_requested(code)` on every `RunEvent::ExitRequested` and calls `api.prevent_exit()` (skipping the shutdown order) when it returns `true`. `code` is `Some(_)` for the app's own exits (`request_quit` → `ctx.host.exit(0)`, the updater's `exit(0)`, the SIGTERM/SIGINT listener's `app.exit(0)`), and Tauri honors `prevent_exit` for those too, so **`on_exit_requested(Some(_))` must return `false`**, or the app would veto its own quit, an update install or a SIGTERM. For `None` (the OS or the last window closing): return `false` when `is_quitting()` or the quit was already approved; on macOS return `true` and stay in the dock, as today; otherwise return `true` and start the guarded quit from step 1 (no dialog when nothing works), which ends in `request_quit` → `Some(0)`. This mirrors `app-quit.ts:44-67` (`before-quit` prevented unless approved). Keep the decision in a pure function and test it. Also wire `DesktopPort::on_reopen(has_visible_windows)` (macOS `RunEvent::Reopen`, `lib.rs:445-450`) to show or spawn a window, and intercept window `CloseRequested` (`WebviewWindow::on_window_event` + `CloseRequestApi::prevent_close`) for the last window on macOS.
  3. Tests: `an exit the app requested is never vetoed` (`Some(0)` and `Some(1)` answer `false` whatever the quit risk), `a user exit with working sessions asks first`, `a user exit with nothing working quits`, `the keep-working button is last`, `a dismissed quit dialog keeps working` (script `FakeHost::message_dialog_answers` with the last index).
- Success criteria: quitting while a turn runs asks first, and `kill -TERM` of the dev app still exits through the shutdown order.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::app_quit` exits 0 with at least `5 passed`. Then start `bun run dev:tauri -- --user-data-dir=$(mktemp -d)` through the background runner, send `kill -TERM` to the `sai-atlas` pid, and confirm it exits within 10 s with `shutdown finished` in the profile's `logs/gui-runtime.jsonl`.

### Task 5.9: Module gate and commit
- Verify: `bash scripts/check-module.sh desktop` exits 0 with last line `check-module desktop: PASS`. Then commit `feat(gui): move windows, tray, shortcuts and deep links to the Tauri core`.

## Status report

End with `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, a summary, and the PASS/FAIL results of the manual checks in Tasks 5.2, 5.3b (voice, worklet backend), 5.4 (680×168 and the Send button), 5.5 (chord on screen), 5.6 (tray icon and menu click), 5.7 and 5.8 (SIGTERM exit). `DONE` is invalid unless the gate passed and every one of those is PASS. Also report, as an observation rather than a PASS/FAIL, which quit-dialog button Enter activates on GNOME (Task 5.8 step 1).

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
