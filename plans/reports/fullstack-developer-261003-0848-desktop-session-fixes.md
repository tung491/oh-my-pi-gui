# Desktop session fixes: GNOME chord conflict, deep-link delivery, dev `omp://` registration

**Worktree:** `/home/tung491/WORK/worktrees/tauri-desktop` · **Branch:** `tauri/desktop` · **Date:** 2026-10-03 (KST)

All four items are implemented and every gate passes. No app was started, no window was opened, and no user config or GNOME setting was written. The only live access was one temporary, read-only GSettings probe (described below), which I removed before committing.

## Commits (not pushed)

| Commit | Subject |
|---|---|
| `a91f6d1` | fix(gui): report a quick-entry chord GNOME already binds as refused |
| `0c6e920` | fix(gui): deliver each deep link once and register omp:// only from release builds |

Each commit builds, passes clippy and passes the desktop tests on its own. Only files under `src-tauri/src/desktop/` changed: `gnome_keybindings.rs` (new), `shortcut.rs`, `mod.rs`, `deep_link.rs`, `windows.rs`. No frozen file or public API changed (gate 3 passes).

## What changed

1. **GNOME conflict check (user decision 1).**
   - New `desktop/gnome_keybindings.rs` holds a pure parser and matcher. Every chord spelling is reduced to one form, a modifier set plus a lowercase keysym, so `Control+Shift+Space`, `CTRL+SHIFT+space`, `<Shift><Control>space` and `<Primary><Shift>space` all compare equal.
   - It reads GNOME's bindings through the GIO GSettings API, reached via the existing `gtk` dependency's `gtk::gio`. It reads `org.gnome.desktop.wm.keybindings`, `org.gnome.shell.keybindings`, `org.gnome.mutter.keybindings`, `org.gnome.mutter.wayland.keybindings`, `org.gnome.settings-daemon.plugins.media-keys`, and the relocatable `custom-keybinding` entries.
   - There is no subprocess: the reads come from dconf in memory, on the main thread during `init`.
   - Each schema is looked up first, and custom paths are validated, because GIO aborts on an unknown schema or a malformed path.
   - The check runs only in portal mode, inside a GNOME session (`XDG_CURRENT_DESKTOP`).
   - When a chord conflicts, `PortalShortcutRegistry::register` returns `Ok(false)`. The existing path then produces `status: "refused"` and the startup notice, with no shared-type change.
   - It also logs the owner, for example `Control+Shift+Space is already a GNOME keybinding (org.gnome.desktop.wm.keybindings switch-input-source)`.
   - The chord is still sent to the portal, so the user can rebind it in GNOME Settings.
   - A read-only probe on this machine found 185 settings and reported `switch-input-source` for the default chord.
2. **Release-only `omp://` registration (user decision 2).**
   - The decision is `deep_link::registers_url_scheme(BuildKind, Platform)`. It is true only for a release build on Linux.
   - `BuildKind` is `Debug` when `debug_assertions` is set, `E2e` when the `e2e-hooks` feature is on, and `Release` otherwise.
   - The registration call itself exists only under `#[cfg(not(debug_assertions))]`.
3. **Single deep-link delivery.**
   - `deep_link::plugin_owns_links(platform)` is true only on macOS.
   - Off macOS, `start()` no longer reads `startup_urls()`, and the `on_open_url` handler (now `Desktop::on_plugin_urls`) ignores the plugin's URLs.
   - Argv and `on_second_instance` stay the only source there.
   - There is no dedupe, so a link the user opens twice is still delivered twice.
4. **Logging and naming.**
   - Window-toggle presses log `window toggle shortcut activated`.
   - Portal ids are now `quick-entry` and `toggle-window`, passed through `ShortcutRegistry::register(id, …)`. Dispatch matches on the id.
   - `CommandOrControl` (and its `CmdOrCtrl` variants) maps to `CTRL` in portal triggers.
   - The misleading `portal bound …` log line now reads `portal accepted …`.

## Tests added (15, plus one updated)

- `gnome_keybindings`, pure, over a fake table:
  - `treats_every_spelling_of_a_chord_as_the_same_chord`
  - `skips_entries_that_bind_no_press`
  - `finds_the_gnome_setting_that_already_owns_a_chord`
  - `reports_no_conflict_for_a_free_chord`
  - `detects_a_gnome_session_from_the_desktop_list`
  - `opens_only_well_formed_custom_shortcut_paths`
- `shortcut`:
  - `a_portal_chord_gnome_already_binds_is_refused_at_startup_with_a_notice`
  - `a_free_portal_chord_is_requested_and_keeps_its_stable_id`
  - `outside_gnome_the_portal_trusts_the_desktop`
  - Updated: `translates_accelerators_into_portal_triggers`, which now asserts `CTRL+SHIFT+o`.
- `deep_link`:
  - `a_cold_start_link_is_delivered_once_on_linux_and_windows`
  - `a_cold_start_link_from_the_os_handoff_is_delivered_once_on_macos`
  - `a_warm_link_from_a_second_instance_is_delivered_once`
  - `a_warm_link_from_the_os_handoff_is_delivered_once_on_macos`
  - `only_a_release_build_on_linux_registers_the_url_scheme`
  - `a_debug_build_never_registers_the_url_scheme_at_startup`
- **Mutation check:** I forced `plugin_owns_links` back to always true, and the cold and warm single-delivery tests both failed. Then I reverted it.

## Gate results (on `0c6e920`)

| Command | Result |
|---|---|
| `bash scripts/check-module.sh desktop` | `check-module desktop: PASS`. Gate 9 skipped the macOS and Windows checks because their SDKs are not installed here; it skipped them before this change too. |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-features` | 255 passed, 0 failed (plus 2 in the other test binary) |
| `bun scripts/check-test-parity.ts desktop` | 111 tests mirrored across 10 files |
| `cargo clippy --release --lib -- -D warnings` (extra, covers the release-only path) | clean |

## Needs a human re-check

1. **New GNOME approval dialog.** The portal ids changed, so the next portal run asks once to approve `quick-entry` and `toggle-window`. The old `shortcut-0` and `shortcut-1` entries stay inert in dconf at `/org/gnome/settings-daemon/global-shortcuts/vn.io.vif.saiatlas`.
2. **On-screen check.** On this machine, with the default chord, the Keyboard Shortcuts dialog should show "The system refused ⇧⌃␣…". The runtime log should contain the GNOME-owner line above, and pressing Ctrl+Shift+O should log `window toggle shortcut activated`.
3. **Release scope.** Linux release builds still call `register_all()` at every start. That writes `~/.local/share/applications/sai-atlas-handler.desktop` and runs `xdg-mime default`. This is needed for the AppImage and redundant for the `.deb`, whose system entry already declares the scheme. Windows release builds do not register at runtime, because the installer does it. Confirm both choices match "only release builds register".
4. **Stale dev handler.** The handler from the earlier debug run is still on this machine. The cleanup steps are in the debugger report, section B1. I did not touch it, as instructed.

## Unresolved questions

- **Chord changes in portal mode.** A chord changed in the app is checked for conflicts only at the next startup, because the portal binds only then. Whether GNOME applies a new `preferred_trigger` to an id it has already stored is still unverified (debugger Q5).
- **Unused Cargo feature.** The `deep-link` feature of `tauri-plugin-single-instance` in `src-tauri/Cargo.toml` no longer does anything off macOS. Removing it is a follow-up for the owner of that shared config, not this module.

Status: DONE
Summary: The GNOME keybinding conflict now shows as a refused chord with the existing notice. Each deep link is delivered exactly once on cold and warm paths. Debug and e2e builds never register `omp://`. Portal shortcuts have stable ids, `CommandOrControl` maps to `CTRL`, and window-toggle presses are logged. The module gate, the full all-features test suite and the parity check all pass.
Concerns/Blockers: The on-screen behaviour (new GNOME approval dialog, refused notice, toggle log line) still needs the human re-check above.
