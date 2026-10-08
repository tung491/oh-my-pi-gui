---
phase: 5
title: "Desktop and webview parity"
status: completed
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 5: Desktop and webview parity

## Goal

The macOS desktop behaviors the Electron build had work in the Tauri build:
- the quick-entry panel floats on every Space, stays out of Mission Control and does not crash on first open;
- ⌘ chords bound to app-menu items do nothing while the bar is focused;
- the Window menu has Zoom and Bring All to Front;
- each profile gets its own WKWebView data store;
- single instance per profile and the microphone delegate are confirmed in the crates' source.

Show-in-Finder for the downloaded DMG is already ported: `src-tauri/src/updater/mod.rs:450-453` calls `ctx.host.reveal_in_folder`, which `src-tauri/src/lib.rs:220-222` implements with the opener plugin's `reveal_item_in_dir`. That makes the scout's "PARTIAL" row stale, so only the human sitting re-checks it.

## Context

- Quick entry: `src-tauri/src/desktop/windows.rs:1022-1035` converts the window with `tauri_nspanel::WebviewWindowExt::to_panel` and sets the non-activating style mask and `set_hides_on_deactivate(false)`. No `tauri_nspanel::init()` plugin is registered in `src-tauri/src/lib.rs:446-462`, and the panel has no collection behavior.
- Chord guard: `src-tauri/src/desktop/quick_entry_core.rs:133-157`. `MenuChordInput` and `is_blocked_menu_chord` are ported, with tests (lines 369-390), but nothing calls them: "No Tauri hook sees key events before the page does". App-menu clicks and accelerators reach `Desktop::on_menu_id` (`src-tauri/src/desktop/menu.rs:161`) through `app.on_menu_event` (`src-tauri/src/desktop/mod.rs:594-600`). `self.windows.focused()` (`windows.rs:438`) returns the focused `WindowId`, and `WindowId::QUICK_ENTRY` is `ports.rs:40`.
- Window menu: `src-tauri/src/desktop/menu.rs:90-100` adds only `Maximize` on darwin. Electron had `zoom`, a separator and `front` (`src/main/menu-template.ts:157`). The `PredefinedItem` enum is `windows.rs:66-80`, and rendering is `menu.rs:241`.
- Webview data: `paths::webview_data_dir()` (`paths.rs:134-136`) feeds `BuilderCall::DataDirectory` (`webview.rs:116, 161, 281`). On macOS wry ignores `data_directory`.
- Single instance: `lib.rs:439-441` swaps the identifier for non-default profiles, and `lib.rs:448-449` passes `dbus_id` (Linux only).
- Mic: `webview.rs:707-712` grants audio on WebKitGTK only. `src-tauri/Info.plist` has `NSMicrophoneUsageDescription`.

## Files

- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/desktop/windows.rs`, `src-tauri/src/desktop/menu.rs`, `src-tauri/src/desktop/quick_entry_core.rs`, `src-tauri/src/paths.rs`, `src-tauri/src/webview.rs`
- Append: `plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md`

## Tasks

### Task 5.1 — Confirm crate facts in source (decision points)
- Goal: four recorded facts, each with the file and line it was read from.
- Steps (crate sources are under `~/.cargo/registry/src/index.crates.io-*/`; run `cargo fetch --manifest-path src-tauri/Cargo.toml` first):
  1. `grep -rn "pub fn init" tauri-nspanel-2.1.0/src` → record whether an `init()` plugin exists, and `grep -rn "fn set_collection_behaviour\|fn set_collection_behavior" tauri-nspanel-2.1.0/src` → the exact method name.
  2. `grep -rn "requestMediaCapturePermissionForOrigin\|request_media_capture_permission" wry-0.57.0/src` → record whether wry grants media capture on macOS, and with what decision.
  3. `grep -rn "fn data_store_identifier" tauri-2.*/src/webview` → the exact builder signature and its OS note.
  4. `grep -rn "identifier\|sock" tauri-plugin-single-instance-2.*/src/platform_impl/macos.rs` → what the macOS lock is keyed on.
  5. `grep -rn "fn bring_all_to_front" tauri-2.*/src/menu` → the exact `PredefinedMenuItem` constructor.
  6. `grep -rn "fn set_focus" tao-*/src/platform_impl/macos/window.rs` and read the body → record whether it calls `activateIgnoringOtherApps` (or `activate`) on `NSApplication`. Electron brought the chat window forward with `app.focus({ steal: true })` (`src/main/quick-entry.ts:363`); if tao does not activate the app, record it, because the sitting row "submit brings the chat window forward" then needs extra attention.
  Write each answer to the host log as `fact <n>: <answer> (<file>:<line>)`. In fact 1, also record the parameter type of the collection-behavior method (it is a typed bitflag such as `NSWindowCollectionBehavior`, not the `i32` that `set_style_mask` takes) and the path the crate re-exports it from.
  zsh note: quote every glob in these commands or prefix them with `noglob`, or zsh stops with "no matches found".
- Success criteria: six fact lines.
- Verify: `grep -c "^fact [1-6]:" plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md` prints `6`. If fact 2 shows wry does not grant audio capture, STOP after recording it (Failure Protocol): a WKUIDelegate override is a design decision for kongming and the user, not an executor fix.

### Task 5.2 — Single instance is keyed on the swapped identifier
- Goal: evidence that two throwaway profiles do not hand off to each other, while one profile does.
- Steps: if fact 4 shows the macOS lock is keyed on the config identifier, record `macOS single instance per profile: covered by smoke case` in `reports/macos-parity.md`. If it is keyed on something else (for example the executable path), STOP: Failure Protocol.
- Verify: `grep -c "single instance per profile" plans/261008-0341-tauri-macos-cutover/reports/macos-parity.md` prints at least `1`.

### Task 5.3 — Quick-entry panel: plugin and collection behavior
- Goal: the bar opens without a panic, floats on every Space and over full-screen apps, and stays out of Mission Control and window cycling.
- Target files: `src-tauri/src/lib.rs` (builder chain at 446-462), `src-tauri/src/desktop/windows.rs` (block at 1027-1035).
- Steps:
  1. If fact 1 shows an `init()`: in `lib.rs`, after `let app = tauri::Builder::default()`, add the nspanel plugin under `#[cfg(target_os = "macos")]`. Register it before `.build(context)`, for example by binding the builder to a `let builder = …;` and then `#[cfg(target_os = "macos")] let builder = builder.plugin(tauri_nspanel::init());`.
  2. In `windows.rs` after `panel.set_hides_on_deactivate(false);`, call the collection-behavior method from fact 1 with `CanJoinAllSpaces (1 << 0) | Transient (1 << 3) | IgnoresCycle (1 << 6) | FullScreenAuxiliary (1 << 8)`. Build the value as the typed bitflag fact 1 names (its named variants or `from_bits`), not as an `i32` like `NS_NONACTIVATING_PANEL_MASK`, which only `set_style_mask` takes. Add the comment "Mission Control and ⌘` skip the bar, and it joins full-screen Spaces".
  3. If Task 1.6 took the fallback (no nspanel), skip steps 1–2 and record `quick-entry: fallback, no collection behavior` in the host log.
- Success criteria: compiles. Its on-screen behavior is checked in the Phase 6 sitting.
- Verify: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` exits 0.

### Task 5.4 — Red/green: menu chords are dropped while the bar is focused
- Goal: ⌘W, ⌘N, ⌘, and any other app-menu ⌘ accelerator do nothing while the quick-entry bar is the focused window on macOS. Editing chords and ⌘Q are unaffected (they are predefined items and never reach `on_menu_event`).
- Target files: `src-tauri/src/desktop/menu.rs` (`on_menu_id` at :161 and its tests), `src-tauri/src/desktop/quick_entry_core.rs` (only to delete the now-dead `MenuChordInput`/`is_blocked_menu_chord` if nothing else uses them).
- Design: every app-menu action that reaches `on_menu_id` while the bar is focused on macOS is dropped. Predefined edit items (copy, paste, undo, select all) and ⌘Q never reach `on_menu_id` (`menu.rs:161-186`), so the bar keeps its editing chords. This is a two-line guard on the menu id and the focused window, not an accelerator lookup.
- Steps:
  1. Red. In `menu.rs` tests, on the fake desktop backend (`windows.rs:1276`, `focused: Mutex<Option<WindowId>>`), add `app_menu_actions_are_dropped_while_the_bar_is_focused`: with `Platform::Darwin` and focused `Some(WindowId::QUICK_ENTRY)`, calling `on_menu_id(ID_CLOSE_WINDOW)` (grep `menu.rs` for the exact id constant) leaves the main window open and records no action; with focused `Some(WindowId(1))` the same call closes it; on `Platform::Linux` with the bar focused it also closes it.
     - Verify (red): `cargo test --manifest-path src-tauri/Cargo.toml --all-features app_menu_actions_are_dropped_while_the_bar_is_focused` exits non-zero with an assertion failure. Passing is a failure of this step.
  2. Green. As the first statement of `on_menu_id`: `if <platform> == Platform::Darwin && self.windows.focused() == Some(WindowId::QUICK_ENTRY) { return; }`, where `<platform>` is the `Platform` value `menu.rs` already uses for its darwin branch. Add the comment "The quick-entry bar is a panel: app-menu chords must not act on the chat window behind it."
  3. If `MenuChordInput`/`is_blocked_menu_chord` (`quick_entry_core.rs:133-157`) now have no caller outside their own tests, leave them and their `#[cfg_attr(not(test), allow(dead_code))]` as they are (they mirror a TS function with parity tests); do not delete parity-mapped code.
- Risk to record in the host log: a non-activating panel may not be reported as the focused window by tao. Then the guard never fires, and the sitting row `macOS cmd-W in the bar leaves the main window open` is the only catch; a FAIL there follows the Failure Protocol.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features desktop::` exits 0.

### Task 5.5 — Red/green: Bring All to Front
- Target files: `src-tauri/src/desktop/windows.rs` (`PredefinedItem`), `src-tauri/src/desktop/menu.rs` (lines 97-99, 241, tests).
- Steps:
  1. Red. Add the test `darwin_window_menu_has_zoom_and_bring_all_to_front`. In the darwin model's Window submenu, the last three items are `Predefined(Maximize)`, `Separator` and `Predefined(BringAllToFront)`. The Linux model has none of them.
     - Verify (red): `cargo test --manifest-path src-tauri/Cargo.toml --all-features darwin_window_menu_has_zoom_and_bring_all_to_front` exits non-zero. Passing is a failure of this step.
  2. Green:
     - add `BringAllToFront` to `PredefinedItem`;
     - in the darwin branch push `MenuItemModel::Separator` then `MenuItemModel::Predefined(PredefinedItem::BringAllToFront)` after `Maximize`;
     - render it with the constructor from fact 5. On non-macOS targets render it as a separator, matching how `muda` treats it.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features desktop::menu` exits 0.

### Task 5.6 — Red/green: one WKWebView data store per profile
- Goal: on macOS a throwaway profile's renderer storage is separate from every other profile's.
- Target files: `src-tauri/src/paths.rs` (new `webview_data_store_id`), `src-tauri/src/webview.rs` (line 281).
- Steps:
  1. Red. In `paths.rs` tests add `derives_a_stable_webview_store_id_per_profile`:
     - `webview_data_store_id(Path::new("/a/webview"))` equals itself;
     - it differs from `webview_data_store_id(Path::new("/b/webview"))`;
     - it has length 16.
     - Verify (red): `cargo test --manifest-path src-tauri/Cargo.toml --all-features derives_a_stable_webview_store_id_per_profile` exits non-zero. Passing is a failure of this step.
  2. Green. `pub(crate) fn webview_data_store_id(dir: &Path) -> [u8; 16]`: the first 16 bytes of `Sha256::digest(dir.to_string_lossy().as_bytes())` (`sha2` is already imported at `paths.rs:10`).
  3. In `webview.rs:281`, split the arm. On `#[cfg(target_os = "macos")]` call `builder.data_directory(dir.clone()).data_store_identifier(crate::paths::webview_data_store_id(dir))`. Use the exact method from fact 3. `data_store_identifier` requires macOS 14 or later while the floor is 13.3, so the guard is unconditional: add `pub(crate) fn macos_major() -> u32` in `paths.rs` (`#[cfg(target_os = "macos")]`), cached in a `OnceLock`, that reads `/usr/bin/sw_vers -productVersion` and parses the major number (0 on any failure), with a unit test for the parser (`"13.6.1"` → 13, `"27.0"` → 27, `""` → 0) written red first. Call `data_store_identifier` only when `macos_major() >= 14`. On 13.x the windows share WebKit's default store: an accepted limit (it matters only when a Mac runs several profiles, such as test profiles; one installed profile per Mac is the normal case). Record `webview store: shared below macOS 14` in the host log. `data_directory` is a no-op in WKWebView, so the existing call stays harmless. Keep the other OSes unchanged.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features` exits 0, and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` exits 0.

### Task 5.7 — Record the microphone and deep-link expectations
- Goal: rows for the sitting.
- Steps: append to `reports/macos-parity.md`:
  - `macOS dictation with the TCC prompt: NEEDS-HUMAN`
  - `macOS quick entry over a full-screen app: NEEDS-HUMAN`
  - `macOS quick entry hidden from Mission Control: NEEDS-HUMAN`
  - `macOS cmd-W in the bar leaves the main window open: NEEDS-HUMAN`
  - `macOS global chord: NEEDS-HUMAN`
  - `macOS tray click and menu: NEEDS-HUMAN`
  - `macOS notification: NEEDS-HUMAN`
  - `macOS omp link cold and warm: NEEDS-HUMAN`
  - `macOS open a folder with open -a: NEEDS-HUMAN`
  - `macOS settings toggle persists across relaunch: NEEDS-HUMAN`
  - `macOS quit guard: NEEDS-HUMAN`
  - `macOS window menu bring all to front: NEEDS-HUMAN`
  - `macOS update DMG revealed in Finder: NEEDS-HUMAN`
  - `macOS Ollama window shows memory and GPU: NEEDS-HUMAN`
  - `macOS WKWebView visual pass: NEEDS-HUMAN`
- Verify: `grep -c ": NEEDS-HUMAN$" plans/261008-0341-tauri-macos-cutover/reports/macos-parity.md` prints `15`.

### Task 5.8 — Regression gate and commit
- Steps: regression gate 1–7. Commit `feat(macos): quick-entry panel behavior, menu chord guard and per-profile web storage`.
- Verify: all gate commands exit 0.

## Test matrix

| Test | Red | Green |
|---|---|---|
| `app_menu_actions_are_dropped_while_the_bar_is_focused` | 5.4.1 | 5.4.2 |
| `macos_major` parser cases | 5.6.3 | 5.6.3 |
| `darwin_window_menu_has_zoom_and_bring_all_to_front` | 5.5.1 | 5.5.2 |
| `derives_a_stable_webview_store_id_per_profile` | 5.6.1 | 5.6.2 |
| Existing chord tests (`swallows_w_and_n_on_macos` …) | — | stay green |
| On-screen rows | — | Phase 6 sitting |

## Regression gate

Plan regression gate items 1–7.

## Rollback

Revert the commit. Each change is behind `cfg(target_os = "macos")` or is a pure helper, so Linux is unaffected.

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

