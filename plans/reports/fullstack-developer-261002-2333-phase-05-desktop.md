# Phase 5 report: desktop module (windows, quick entry, shortcuts, tray, menu, deep links, quit guard)

- Plan: `/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/phase-05-windows-desktop-integration.md`
- Worktree: `/home/tung491/WORK/worktrees/tauri-desktop`, branch `tauri/desktop`, base `10cf8a5`, tip `0d6386d`, tree clean. Not pushed, not merged.
- Commits:
  - `a7ef504` feat(gui): port the desktop module's pure cores to Rust (Task 5.1)
  - `3be9fe1` feat(gui): move windows, tray, shortcuts and deep links to the Tauri core (Tasks 5.2–5.8; the Task 5.9 commit)
  - `df27bf7` fix(gui): log every quick-entry shortcut activation (the 5.5 log line for the plugin backend too)
  - `0d6386d` fix(gui): guard desktop callbacks whole and never save a partial tab session (kongming's two findings)
- Files: 19 files under `src-tauri/src/desktop/` (`mod, ipc, windows, lifecycle, quick_entry, quick_entry_core, shortcut, shortcut_core, wayland_portal, tray, tray_labels, menu, deep_link, launch_argv, app_quit, quit_guard, app_icons, tab_layout, window_bounds`), about 7,700 lines. No frozen file touched; `git diff 10cf8a5 -- src-tauri/contracts` is empty.

## Outcome

Every automatable Verify in the phase passes as written; `bash scripts/check-module.sh desktop` ends with `check-module desktop: PASS` on the committed tree (`0d6386d`); the full `cargo test --all-features` passes (240 tests, 165 in `desktop::`); `bun scripts/check-test-parity.ts desktop` reports `111 tests mirrored across 10 files`; the module has no `todo!`, `unimplemented!`, `#[ignore]` or `unsafe`, and `downcast_ref` targets only `desktop::Desktop`.

The seven dev-run checks (5.2, 5.3b, 5.4, 5.5, 5.6, 5.7, 5.8) are **NEEDS-HUMAN on the integration trial merge**, not on this branch. This is a plan gap, not a module defect: on `tauri/desktop` alone every chat window dies within a second at the frozen Phase 2 `todo!()` in `tabs.acquire`, so none of those checks can be observed here (evidence under "Dev run on this branch"). kongming confirmed that `tauri/omp`, `tauri/tabs` and `tauri/services` carry zero `todo!()` and merge with `tauri/desktop` in Phase 10 order without conflicts, so the controller's `tauri/integration` trial merge is the first tree where the script below can run.

## Design in one paragraph

`Desktop::new(app, ctx)` wraps the `AppHandle` in a private `Backend` trait (`windows.rs`): windows through `webview::build_window`, monitors, tray, menu and the filesystem probes. Tests install the real `Desktop` over a `FakeBackend` with `testing::fake_ctx_cyclic` (`desktop::testing::harness`), so every decision — window registry and persistence, quit guard, bar queue, tray aggregate, menu routing, deep links — runs without a Tauri runtime, and the handlers are driven through `bridge::dispatch_for_test`. Window events route back as `WinEvent` (`Moved`, `Resized`, `CloseRequested`, `Destroyed`, `Focused`); `CloseRequested` can be vetoed (macOS hides the last window). Every main-thread callback body (window, menu, tray, deep link, both shortcuts) and every cross-module call on those paths runs inside `survive()`, a `catch_unwind` + `main-uncaught` runtime-log wrapper modelled on the bridge's handler guard, so a panic never unwinds through the GTK event loop and aborts the process.

## Tasks

### Task 5.1: Pure cores — DONE (`a7ef504`)
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::` → exit 0, `109 passed` at that commit (≥ 98 required); 165 at the tip.
- `wayland_portal.rs` keeps the TS test names; the Chromium feature-flag and ozone assertions became assertions on the Rust mode decision, with `GDK_BACKEND` (first listed backend wins; `*`/empty = no preference) as the GTK analogue of `--ozone-platform`.
- `shortcut_core.rs` carries a private port of `src/shared/chord.ts` and the `NATIVE_CHORDS` table, checked against the TS sources with `include_str!`.
- `app_icons.rs` reads `TRAY_MARK_SIZE`, `TRAY_MARK_ALPHA` and `TRAY_MARK_SOURCE_SHA256` out of `src/main/tray-mark.ts` with a regex (unit-tested) and decodes the alpha into RGBA.

### Task 5.2: Window manager — DONE
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::windows` → exit 0, `12 passed`.
- `WindowId(n)` from 1 (`main-<n>`), `Sai ATLAS`, 1400×900, `min_inner_size (800, 600)`, `#0a1a33` background, bounds from `window_state.windowState` through `restore_within_displays` with the 28 px cascade, `maximize()` after build, icon after build. Bounds persist on move/resize (500 ms debounce, generation-checked; the geometry is read on the reporting thread so no cross-thread getter runs) and on close as `{ x, y, width, height, isMaximized }`.
- Tab layouts: `tabs.on_window_tabs_changed` registered in `init`; `persist_tab_layouts` writes `tabLayouts`, deletes `tabLayout`, is skipped while quitting, never writes an empty list and, since `0d6386d`, never writes a partial one (test `a_layout_query_that_panics_keeps_the_saved_session_untouched`). Startup opens one window per saved layout through `tabs.restore_layout`.
- `spawn_window` refuses at `tabs.at_cap()`, resolves the cwd (`lastProject` → process cwd → home; Work mode through `ensure_default_workspace`), builds, then `tabs.acquire(AcquireOptions { kind, fresh, placeholder, .. })`; a failed acquire discards the window.
- Manual part (move, quit, restart, `jq .windowState`): NEEDS-HUMAN 1.

### Task 5.3: App lifecycle and close ordering — DONE
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::lifecycle` → exit 0, `3 passed` (`quit_with_three_windows_keeps_three_saved_layouts`, `closing_the_last_window_quits_on_linux`, `closing_a_window_notifies_subscribers_before_the_record_and_the_bridge_entry_go`).
- `Destroyed`: listeners run while the record exists → record dropped → `bridge.unregister_window` → bar prompts returned → tray and progress snapshots forgotten → layouts persisted (unless quitting) → on Linux/Windows the last window destroys the bar and calls `request_quit` (→ `ctx.host.exit(0)`). `shutdown` destroys the bar and the tray.

### Task 5.3b: Voice in a real window — NEEDS-HUMAN 2
- Needs a chat window with the composer, which this branch cannot keep open.

### Task 5.4: Quick-entry bar — DONE (automatable part)
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::quick_entry` → exit 0, `33 passed`; plus the ten named dispatch tests `desktop::ipc::tests::dispatches_quick_entry_{submit,consume_restored,dismiss,claim,ack,return,shortcut_get,shortcut_set,shortcut_suspend,shortcut_notice}` (`10 passed`).
- Window: `WindowKind::QuickEntry`, `quick-entry.html`, `visible: false`, no decorations, not minimizable or maximizable, `skip_taskbar`, `always_on_top`, `focused`, `#0a1a33` / `#f7f9fc` from the theme, `inner_size == min_inner_size == max_inner_size == 680×168`, `resizable` left default, `remove_menu()` off macOS. The macOS `NSPanel` conversion is behind `cfg(target_os = "macos")` and runs only when the `tauri-nspanel` plugin state exists (Concern 6).
- Manual part (`[680, 168]` in the bar console; Send and Enter → tab): NEEDS-HUMAN 3.

### Task 5.5: Global shortcuts — DONE (automatable part)
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::shortcut` → exit 0, `28 passed` (the 6 ported `quick-entry-shortcut.test.ts` tests over a fake registry, the 20 core tests, the trigger translation, the plugin/portal-independent policy).
- Backends behind the private `ShortcutRegistry` trait: `PluginShortcutRegistry` (`GlobalShortcutExt::on_shortcut` / `unregister`; suspension releases and re-grabs the remembered accelerators) and, on native Wayland, `PortalShortcutRegistry` (`ashpd::register_host_app("vn.io.vif.saiatlas")`, `GlobalShortcuts::create_session`, one `bind_shortcuts` for both chords at `start()`, `receive_activated`). Both chords register in the same tick. Tonight's dev run logged `global shortcut mode {"portal":true}`, `quick entry registered`, `host registry: registered`.
- Manual part (chord while another app has focus): NEEDS-HUMAN 4.

### Task 5.6: Tray, menu and icons — DONE (automatable part)
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- desktop::tray desktop::menu desktop::app_icons` → exit 0, `24 passed`.
- Tray: `TrayIconBuilder` with the decoded mark (template off Linux), tooltip and menu from `tray_labels` plus the renderer's language, rebuilt only when `menu_signature` changes; left click focuses the target window off Linux. Menu: port of `menu.ts` with `MainTextKey` labels, native accelerators only where the TS had them, `Check for Updates…` → `updater.check_now()`, Documentation → `host.open_url`, `rebuild_menu()` reinstalls after a language change. `tray:state-push` / `progress:set` aggregate per `Caller.win_id`.
- Manual part (icon visible; menu click focuses the window and logs): NEEDS-HUMAN 5.

### Task 5.7: Deep links, single instance, launch arguments — DONE (automatable part)
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- desktop::deep_link desktop::launch_argv` → exit 0, `15 passed`, including `ignores_the_supervisor_argv` and `a_second_instance_with_a_link_focuses_and_delivers_it`.
- `on_second_instance` parses `launch_arguments(argv, false)` into link / `--quick-entry` / path / focus; links before setup are buffered and replayed; `app.deep_link().on_open_url` handles URLs and `file://` paths; dev builds on Linux call `register_all()`.
- Manual part (`xdg-open "omp://new"`): NEEDS-HUMAN 6.

### Task 5.8: Quit guard — DONE (automatable part)
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml desktop::app_quit` → exit 0, `6 passed` (the five named tests plus the `app:quit` dispatch test).
- `exit_decision(code, approved, platform)` is pure: `Some(_)` → allow; `None` with approval or the latch → allow; macOS → veto; else veto and run the guard, which asks through `ctx.host.message_dialog` with `[Quit anyway, Keep working]` (safe choice last) and ends in `request_quit`. `on_reopen` focuses or spawns; macOS keeps the last window by hiding it on `CloseRequested`.
- Manual part (`kill -TERM` → `shutdown finished` within 10 s): NEEDS-HUMAN 7. Tonight's dev run shows the frozen order completing on its own exit (`shutdown started (exit requested, code None)` → `shutdown finished`), which is the same path a signal takes after `app.exit(0)`.
- Which button Enter picks in the GNOME dialog: NEEDS-HUMAN 8 (observation only).

### Task 5.9: Module gate and commit — DONE
- Verify: `bash scripts/check-module.sh desktop` → exit 0, last line `check-module desktop: PASS`, run on the committed tree at `3be9fe1` and again at `0d6386d`. Gate 9 printed its two expected `WARN` lines (no Apple or MSVC SDK on this host).

## Completion check per phase (module `desktop`)

- Tree clean; the diff since `10cf8a5` is 19 files, all under `src-tauri/src/desktop/`; `git diff 10cf8a5 -- src-tauri/contracts` is empty.
- `check-module.sh desktop` PASS; `cargo test --all-features` 240 passed; `check-test-parity.ts desktop` 111 tests mirrored.
- No `todo!`, `unimplemented!`, `#[ignore]`; `unsafe` 0 lines; `downcast_ref` only to `desktop::Desktop`.
- `tauri_plugin_` appears at four sites, each prescribed by the phase text: `shortcut.rs` (`GlobalShortcutExt`, 5.5 step 1) and `windows.rs` / `mod.rs` (`DeepLinkExt` for `register_all`, `get_current`, `on_open_url`, 5.7 steps 1–2). The frozen `Host` trait (`ports.rs`) has no shortcut or deep-link surface, so these cannot go through `ctx.host`; the plan's generic completion line should be amended to name this exception (Deviation 3).
- No leftover `omp`, `--omp-supervise`, fixture, `sai-atlas`, vite or port-518x process.

## Dev run on this branch (evidence for the plan gap)

`bun run dev:tauri -- --user-data-dir=/tmp/sai-atlas-desktop-Cl7ROK` (port 5186, `target/debug/sai-atlas` pid 2143861). Runtime log, in order:

1. `tabs.on_window_tabs_changed panicked: not yet implemented` (`main-uncaught`, caught by `survive`)
2. `global shortcut mode {"portal":true}` → `quick entry registered {"accelerator":"Control+Shift+Space","portal":true}`
3. `tabs.at_cap panicked` (caught) → window `main-1` built → `tabs.acquire panicked` (caught) → window discarded
4. tray built (libayatana deprecation warning on stderr)
5. last window gone → `request_quit` → `shutdown started (exit requested, code None)` → `desktop surfaces destroyed` → `shutdown finished` (frozen order complete)
6. `host registry: registered {"appId":"vn.io.vif.saiatlas"}` (the portal task finished its D-Bus call as the process exited)

The process was gone about one second after start, without a crash. So the startup wiring, the portal registration, the tray, the quit path and the shutdown order are exercised; nothing that needs a live tab can be.

## NEEDS-HUMAN script (one sitting, in order)

Precondition: run on the controller's `tauri/integration` trial merge (`tauri/omp` → `tauri/tabs` → `tauri/services` → `tauri/desktop`, Phase 10 order), from that worktree (at the time of writing `/home/tung491/WORK/worktrees/tauri-integration` exists at `041f5c8` with `tauri/tabs` and `tauri/services` merged and `tauri/desktop` not yet; I did not touch it), with `test -x resources/omp` passing and `out/renderer-tauri` built (`bun run build:renderer:tauri`). The integration worktree's dev port is 5183 (`scripts/tauri-dev.ts`); check `ss -ltnp 'sport = :5183'` is empty first. Use one profile for the sitting:

```bash
export PROFILE=$(mktemp -d)
bun run dev:tauri -- --user-data-dir=$PROFILE      # background runner; note the PID of target/debug/sai-atlas
LOG=$PROFILE/logs/gui-runtime.jsonl
```

1. **5.2 window restore.** Move the main window and resize it. Quit from the tray menu ("Quit") or close the window. Start the dev run again with the same `$PROFILE`. Expected: the window reopens at the new position and size, with its tabs. Check: `jq .windowState "$PROFILE/window-state.json"` shows the new `x`, `y`, `width`, `height`; `jq '.tabLayouts | length' "$PROFILE/prefs.json"` prints the window count.
2. **5.3b voice (Linux, sandbox on).** Settings → enable `stt`. Press the composer's dictation button, speak about two seconds, stop. Expected: the recording indicator shows while recording, and a transcript (possibly imperfect) lands in the composer. In the main window's webview console run `typeof AudioWorkletNode === "function" && "audioWorklet" in AudioContext.prototype` → must print `true`. Check: `grep -c transcribe_audio "$LOG"` prints ≥ 1. No accepted degradation; a FAIL blocks the cutover.
3. **5.4 quick entry.** Press Ctrl+Shift+Space (the default ⇧⌃␣), or run a second instance `target/debug/sai-atlas --user-data-dir=$PROFILE --quick-entry`. In the bar's webview console run `[innerWidth, innerHeight]` → must print `[680, 168]`. Type a prompt and click **Send**; repeat with **Enter**. Expected: the bar hides and a new tab in the main window carries the prompt each time. Check: the tab's composer text; `grep -c '"action":"quick-entry"' "$LOG"` is not logged, so rely on the tab.
4. **5.5 chord on screen (GNOME Wayland).** Startup logs `global shortcut mode {"portal":true}`. If GNOME shows its "allow global shortcuts" dialog, approve it. Focus another application (a terminal) and press Ctrl+Shift+Space. Expected: the bar appears. Check: `grep -c 'quick entry shortcut activated' "$LOG"` prints 1 (also `portal activated shortcut-1`). No accepted degradation (S5 mandatory). Known: Mutter ignores always-on-top for Wayland toplevels (accepted 2026-10-02). Note: the portal needs a `vn.io.vif.saiatlas.desktop` entry; the system one at `/usr/share/applications/` satisfies it, so do not install a user-level copy (plan.md baseline rule).
5. **5.6 tray.** Confirm the Sai ATLAS mark is visible in the GNOME top bar. Open its menu and choose **Quick Start → New Session**. Expected: the main window gains focus and a new session opens. Check: `grep -c 'menu action new-session' "$LOG"` prints 1. Left-click does nothing on Linux (accepted degradation).
6. **5.7 deep link.** With the app running: `xdg-open "omp://new"`. Expected: the app focuses and opens a new session. Check: `grep -c 'second instance: Url' "$LOG"` and `grep -c 'deep link omp://new delivered' "$LOG"` both print ≥ 1. Side effect of a Linux dev run: the dev build registers `~/.local/share/applications/sai-atlas-handler.desktop` and points `x-scheme-handler/omp` at itself. After the sitting: `rm ~/.local/share/applications/sai-atlas-handler.desktop`, restore the `x-scheme-handler/omp=vn.io.vif.saiatlas.desktop` line in `~/.config/mimeapps.list`, and confirm with `xdg-mime query default x-scheme-handler/omp`.
7. **5.8 SIGTERM.** `kill -TERM $(pgrep -f 'target/debug/sai-atlas --user-data-dir')`. Expected: the process exits within 10 s. Check: `grep -c 'shutdown finished' "$LOG"` prints 1 and `pgrep -f 'omp --mode rpc-ui'` prints nothing.
8. **Quit dialog Enter (observation).** Start a turn that keeps running, then quit (tray → Quit or close the last window). The dialog shows `Quit anyway` / `Keep working`. Press Enter and record which button GNOME activates. The port cannot set Electron's `defaultId: 1`; by construction a dismissal (Escape, closing the dialog) keeps working.

Afterwards: `kill <pid of bun scripts/tauri-dev.ts>` (SIGTERM; vite and `cargo run` exit with it), confirm `ss -ltnp 'sport = :5183'` is empty and `pgrep -f 'omp --mode rpc-ui|--omp-supervise'` prints nothing, remove `$PROFILE`, and restore the mime default from step 6.

Phase 10's visual pass covers steps 2–6 by its own rows; steps 1 (`jq` restore) and 7 (SIGTERM) have no Phase 10 row and must be run from this list.

## Deviations and concerns

1. **Manual checks unrunnable on this branch (plan gap).** See "Dev run on this branch". Resolution: NEEDS-HUMAN on the integration trial merge; `DONE_WITH_CONCERNS`, as kongming advised under the Failure Protocol.
2. **`survive()` guard.** Main-thread callback bodies and the cross-module calls on them run inside `catch_unwind` and log `main-uncaught`. Without it the stub panics above would have aborted the process through the GTK main loop. For Phase 10: after the merge a panicking `acquire` would look like a clean, immediate quit, so the e2e and visual passes should grep the runtime log for `main-uncaught` and fail on any hit; keep `panic = "unwind"` (the default; `Cargo.toml` sets no `panic = "abort"`).
3. **`tauri_plugin_` calls.** Prescribed by the phase text, confined to `shortcut.rs`, `windows.rs`, `mod.rs`; the frozen `Host` offers no alternative. The controller should amend plan.md's completion-check wording ("no `tauri_plugin_` call outside `ctx.host`") to name the shortcut and deep-link extension traits as the allowed exception.
4. **Menu chord filter (5.4 step 3).** No Tauri hook sees a key chord before the page does (Electron's `before-input-event`), so `is_blocked_menu_chord` exists with its tests but is not wired; on macOS ⌘W from the bar could still reach the main window's menu until Phase 12 finds a hook.
5. **Lease release on reload.** The TS released leased prompts on `did-navigate`; the bridge detaches on page load inside the frozen foundation and exposes no hook to this module, so `release_leases` is ported and tested but not wired. A prompt is leased only between `claim` and `ack` (one renderer tick), and a window close still returns it as `interrupted`.
6. **macOS `NSPanel`.** `tauri-nspanel 2.1.0` needs `.plugin(tauri_nspanel::init())` in the frozen `lib.rs`, which is absent, and `to_panel()` panics without the plugin's managed state. The conversion runs only when `try_state::<WebviewPanelManager>()` exists and otherwise logs and keeps the always-on-top window. Phase 12 has to add the plugin or accept the fallback. This host cannot compile that branch (gate 9 WARN).
7. **Menu roles without a Tauri predefined item.** `reload`, `forceReload`, `toggleDevTools`, `resetZoom`, `zoomIn`, `zoomOut` from `menu.ts` have no `PredefinedMenuItem` and were dropped; fullscreen, minimize, zoom/maximize, the edit roles and the macOS app-menu roles are present. Tauri also has no "menu is open" event, so the TS guard against swapping an open tray menu is replaced by the signature check alone.
8. **Window icon in dev.** `default_window_icon()` (from `src-tauri/icons/icon.png`) first; `linux_window_icon_path` is the fallback.
9. **Dev-only `register_all` side effect.** Restored tonight: `~/.config/mimeapps.list` md5 `36d00fe15e98b20fc805224699d2f097` before and after, `sai-atlas-handler.desktop` removed, `xdg-mime query default x-scheme-handler/omp` → `vn.io.vif.saiatlas.desktop`.

## Processes

- Started and stopped: `bun run dev:tauri -- --user-data-dir=/tmp/sai-atlas-desktop-Cl7ROK` (background runner, port 5186; vite + `cargo run` → `target/debug/sai-atlas` pid 2143861). The app exited by itself after about one second (Deviation 1); the runner exited 0. Final check: no `sai-atlas`, vite, `omp --mode rpc-ui`, `--omp-supervise` or `sidecar-fixture` process; ports 5183 and 5186 free.
- Also run to completion: `cargo test`, `cargo clippy`, `check-module.sh desktop` (twice), `check-test-parity.ts desktop`.
- Two kongming consults were spawned (the first died with the session rate limit, the second answered); neither started processes.

## Baseline

- `~/.config/@oh-my-pi/omp-gui/prefs.json` mtime `2026-10-02 12:00:17.869392351 +0900` at start and at end.
- `~/.config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl` mtime `2026-10-02 23:29:09.083976746 +0900` at start and at end.
- No `dpkg -i` / `apt`; no `~/.local/share/applications/vn.io.vif.saiatlas.desktop` created (the system entry serves the portal); `~/.config/mimeapps.list` restored.

## Quit dialog: which button Enter picks

NEEDS-HUMAN 8. Not observable without a running turn on the integration branch. By construction a dismissed dialog answers the last button, `Keep working`.

Status: DONE_WITH_CONCERNS
Summary: The desktop module is fully ported and green on every automatable Verify, the module gate, parity and the full suite (240 tests); the seven dev-run checks are written up as a numbered NEEDS-HUMAN script for the `tauri/integration` trial merge, because on `tauri/desktop` alone every chat window dies at the still-stubbed `tabs.acquire`.
Concerns/Blockers: manual checks 5.2, 5.3b, 5.4, 5.5, 5.6, 5.7, 5.8 need the integration tree (omp + tabs + services + desktop); Phase 10 should grep the runtime log for `main-uncaught`; `tauri-nspanel` needs its plugin registered in the frozen `lib.rs` before Phase 12 can use the panel; no Tauri hook exists for the macOS menu-chord filter or for lease release on page reload; the plan's "no `tauri_plugin_` call" completion line conflicts with the phase's prescribed `GlobalShortcutExt` / `DeepLinkExt` use.
