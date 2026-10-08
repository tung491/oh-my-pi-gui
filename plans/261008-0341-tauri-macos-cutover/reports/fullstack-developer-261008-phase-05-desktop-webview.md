## Phase Implementation Report

### Executed Phase
- Phase: phase-05-desktop-webview-parity
- Plan: plans/261008-0341-tauri-macos-cutover
- Status: completed, with two plan deviations and two runtime defects fixed through the Failure Protocol (all recorded in `macos-host-log.md` under `## Phase 5`)
- Branch: `tung491/tauri_macos-core` (worktree `tauri_macos-core`), code commit `daf9847`, then a docs commit. Not pushed or merged.

### Files Modified
- `src-tauri/src/lib.rs` (+7/-1): registers `tauri_nspanel::init()` on macOS before the other plugins.
- `src-tauri/src/desktop/windows.rs` (+~65): `PredefinedItem::BringAllToFront`; the panel conversion, style mask, `set_hides_on_deactivate` and the collection behavior now run through `run_on_main_thread`, with a `quick entry panel configured` note; `TauriBackend::destroy` restores the bar from panel to window (`hide` + `to_window` inside `objc2::exception::catch`, on the main thread) before destroying it.
- `src-tauri/src/desktop/menu.rs` (+~80): guards app-menu (`menu:`) ids while the bar is the key window on macOS; adds Zoom, a separator and Bring All to Front to the Window menu; tests.
- `src-tauri/src/paths.rs` (+51): `webview_data_store_id`, `macos_major` (cached `sw_vers`), `parse_macos_major`; tests.
- `src-tauri/src/webview.rs` (+13): the macOS `DataDirectory` arm adds `data_store_identifier` on macOS 14 and later.
- `reports/macos-host-log.md`: `## Phase 5` (6 facts, task evidence, deviations, gate results).
- `reports/macos-parity.md`: `## Phase 5`, a single-instance row and 15 `NEEDS-HUMAN` rows with steps.

### Tasks Completed
- [x] 5.1 Six crate facts recorded (`grep -c "^fact [1-6]:"` prints 6). wry grants media capture when no handler is set, and tao's `set_focus` activates the app.
- [x] 5.2 Single instance is keyed on the swapped identifier, recorded as covered by the smoke case.
- [x] 5.3 Plugin registered and collection behavior set. The required runtime check found two crashes, both now fixed (see Issues).
- [x] 5.4 Red, then green after a deviation: the guard reads `backend.focused_window()` and is limited to `menu:` ids. Added `tray_actions_pass_while_the_bar_is_focused`.
- [x] 5.5 Red, then green. `PredefinedItem` is `pub(crate)`, so the snapshot is unchanged.
- [x] 5.6 Both reds (store id, `sw_vers` parser), then green. Store ids are used only on macOS 14 and later; below that the store is shared (recorded).
- [x] 5.7 15 NEEDS-HUMAN rows (`grep -c ": NEEDS-HUMAN$"` prints 15).
- [x] 5.8 Regression gate run and commit made.

### Tests Status
- Gate 1, clippy `-D warnings`: pass.
- Gate 2, `cargo test --all-features`: pass (792 passed, 0 failed).
- Gate 3, parity for every contract: pass. Gate 4, snapshots: `check-module snapshots: PASS`.
- Gate 5, vitest: pass (2389 passed, 9 skipped). Gate 6, `check:types`: pass.
- Gate 7, biome: no TypeScript was touched. Biome does not include `.rs` files, so it exits 1 with "No files were processed" for them; there is nothing to check.
- Runtime quick-entry check (debug binary, throwaway profiles):
  - Warm `--quick-entry` handoff and cold `--quick-entry` launch: the first process survives, the log shows `quick entry panel configured` `{"mainThread":true}` with no failure note, and no new crash report is written.
  - SIGTERM then exits 0 after `quick entry panel restored before destroy` `{"restored":true,"releasedWhenClosed":false}`, with supervisor and omp gone.
  - A run that never opens the bar also exits 0 on SIGTERM.

### Issues Encountered
- The plan's chord guard could never fire. `WindowRegistry::focused()` never holds the bar (`note_focus` admits chat windows only, and `lifecycle.rs:18-22` routes bar events away from it). Kongming's fix is in place.
- Opening the bar crashed on macOS. The single-instance callback runs on a tokio task, and AppKit traps when `setStyleMask:` is called off the main thread. The conversion is now queued on the main thread.
- Quitting after the bar had been opened aborted with "Rust cannot catch foreign exceptions", because a class-swapped panel was being closed. The bar is now restored to a window before it is destroyed. The Objective-C exception's name and reason were not captured.
- `scripts/tauri-mac-smoke.ts` is outside this lane's ownership. A `--quick-entry` second-launch case there would guard both fixes in the packaged smoke run; that is handed off to the harness owner.

### Next Steps
- Merge `tung491/tauri_macos-core` (Phase 5) into the integrated branch, then run the full regression gate there.
- Phase 6 sitting: the 15 NEEDS-HUMAN rows. The quit-guard row now includes ⌘Q and tray Quit after opening the bar. ⌘Q is expected to be clean because tao never processes the queued destroy, but it has not been run.
- Reconcile the Task 5.4 green text and the extra runtime check into the phase file when it is closed. Plan status was not changed.

### Unresolved questions
- Should the smoke harness owner add the `--quick-entry` second-launch and TERM-exit case before Phase 8?
- The macOS 13.x branch (shared WebKit store, `macos_major() < 14`) is untested on this host. That is an accepted limit.

Status: DONE_WITH_CONCERNS
Summary: Phase 5 is implemented and every gate passes. The required quick-entry runtime check found and drove fixes for two real macOS crashes: a panel configured off the main thread, and an abort on quit after the bar was opened.
Concerns/Blockers: the plan's menu guard was changed after Failure Protocol counsel; the ⌘Q-after-bar path and all on-screen behavior wait for the Phase 6 sitting; the packaged smoke harness does not cover quick entry yet.
