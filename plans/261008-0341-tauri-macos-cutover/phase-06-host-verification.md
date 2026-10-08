---
phase: 6
title: "Host verification and the human sitting"
status: pending
priority: P1
effort: "1d"
dependencies: [3, 4, 5]
---

# Phase 6: Host verification and the human sitting

## Goal

A fresh package built from the merged Phases 2–5 passes every automated smoke case, and every NEEDS-HUMAN row turns PASS in one sitting with the user. The phase ends by removing all test-build traces from the user's account.

## Files

- Append: `plans/261008-0341-tauri-macos-cutover/reports/macos-parity.md`, `plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md`

## Tasks

### Task 6.1 — Rebuild and run the automated smoke
- Steps:
  1. `test -x resources/omp && bun run package:tauri:mac:arm64`
  2. `A="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app"; bun scripts/tauri-mac-smoke.ts "$A" 2>&1 | tee "$TMPDIR/smoke-2.txt"`
  3. Replace every `macOS <case>: …` line from Phase 3 in `reports/macos-parity.md` with the new result.
- Success criteria: every case passes, including `hard kill leaves nothing`.
- Verify: the smoke exits 0 and its last line is `tauri-mac-smoke: PASS`, and `grep -c "^FAIL " "$TMPDIR/smoke-2.txt"` prints `0`.

### Task 6.2 — Copy the build for the sitting
- Steps: `H=$(mktemp -d); ditto "$A" "$H/Sai ATLAS.app"; P=$(mktemp -d); mkdir -p "$P/project"`. Write `H` and `P` to the host log.
- Verify: `codesign --verify --strict --deep "$H/Sai ATLAS.app"` exits 0.

### Task 6.3 — The human sitting (NEEDS-HUMAN, one session with the user)
- Goal: every NEEDS-HUMAN row becomes PASS or FAIL, as the user observes it.
- Steps: send the user this script. Mark each row in `reports/macos-parity.md` from the user's answer: replace `NEEDS-HUMAN` with `PASS` or `FAIL`. Launch first with:
  `open -n "$H/Sai ATLAS.app" --env PI_CODING_AGENT_DIR="$P/agent" --args --user-data-dir="$P/profile" "$P/project"`
  (`open` makes the app, not Terminal, the TCC client.)
  1. **Dictation with the TCC prompt.** Click the microphone in the composer. macOS asks for microphone access for "Sai ATLAS". Allow it. Speak one sentence and stop. Expected: a transcript appears in the composer.
  2. **Quick entry over a full-screen app.** Put Safari in full screen (⌃⌘F). Press the quick-entry chord shown in Settings → Quick entry. Expected: the bar appears over Safari, Safari stays full screen, and Sai ATLAS's menu bar does not take over.
  3. **Hidden from Mission Control.** With the bar open, press F3 (Mission Control). Expected: the bar is not shown as a window there.
  4. **⌘W in the bar.** Open the bar, press ⌘W. Expected: the main window stays open. Then press ⌘A in the bar's text. Expected: the text is selected.
  5. **Global chord.** With Finder frontmost, press the chord. Expected: the bar opens. Type "hello" and press Return. Expected: the prompt reaches a chat window.
  6. **Tray.** Click the Sai ATLAS menu-bar icon. Expected: a monochrome icon that adapts to light and dark menu bars, and a menu that opens. Pick "New session". Expected: a new task opens.
  7. **Notification.** Start a task, switch to another app, and let the reply finish. Expected: macOS asks to allow notifications, then shows one.
  8. **omp link cold and warm.** Quit Sai ATLAS (⌘Q). In Terminal run `open "omp://session/new"`, which cold-starts the app. Then run it again while the app runs (warm). Expected: both open the app on the link target.
  9. **Open a folder.** `open -a "$H/Sai ATLAS.app" "$P/project"`. Expected: a window for that folder.
  10. **Settings toggle.** Change one setting in Settings, quit, then relaunch with the step-0 command. Expected: the setting kept its value.
  11. **Quit guard.** While a reply is streaming, press ⌘Q. Expected: the quit confirmation appears.
  12. **Bring All to Front.** Open two windows. Click another app. Choose Window → Bring All to Front. Expected: both Sai ATLAS windows come forward.
  13. **Update DMG in Finder.** Skip unless a newer release than this build is published: the check needs one, so mark the row `PASS (deferred to the first post-release update)` and record that in the host log. When one exists: choose About → Check for updates → Download. Expected: Finder shows the DMG selected, and it opens.
  14. **Ollama window.** Open the Ollama window. Expected: the machine facts show memory and a GPU name (Ollama itself may be absent on this Mac; then only the facts row is checked).
  15. **WKWebView visual pass.** Walk through the parent Phase 10 Task 10.4 list: chat, markdown with code and math, diagrams, file cards, settings, onboarding, both languages. Expected: no broken layout, missing font or blank panel.
- Success criteria: every row is answered.
- Verify: `grep -c ": NEEDS-HUMAN$" plans/261008-0341-tauri-macos-cutover/reports/macos-parity.md` prints `0`, and `grep -c ": FAIL$" plans/261008-0341-tauri-macos-cutover/reports/macos-parity.md` prints `0`. A FAIL row is a Failure Protocol stop: kongming advises a fix in the owning phase's files, and the fix runs through that phase's red/green tasks.

### Task 6.4 — Clean the test traces off the user's account
- Steps:
  1. Quit every test app: `pkill -TERM -f "$H/Sai ATLAS.app/Contents/MacOS/sai-atlas"; pkill -TERM -f "release/bundle/macos/Sai ATLAS.app/Contents/MacOS/sai-atlas"`
  2. `LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister; "$LSR" -u "$H/Sai ATLAS.app"; "$LSR" -u "$PWD/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app"`
  3. Ask the user before running `tccutil reset Microphone vn.io.vif.saiatlas` (quote the command), and run it only after their go-ahead. It is expected to be safe because Task 1.1 recorded no real install, but it changes the user's privacy settings. If they decline, record `tcc: kept (user)` in the host log.
  4. Before deleting, re-run the Task 1.1 `ls -d` and confirm with the user that these four paths still belong only to test builds. Then `rm -rf "$HOME/Library/WebKit/vn.io.vif.saiatlas" "$HOME/Library/Caches/vn.io.vif.saiatlas" "$HOME/Library/HTTPStorages/vn.io.vif.saiatlas" "$HOME/Library/Saved Application State/vn.io.vif.saiatlas.savedState"`. This is safe because Task 1.1 recorded that none of them existed before.
  5. `rm -rf "$H" "$P"`
  6. Notification permission for the bundle id cannot be reset from the command line. Ask the user to remove "Sai ATLAS" in System Settings → Notifications, and record their answer.
- Verify: `"$LSR" -dump | grep -c "Sai ATLAS.app"` prints `0`; the `ls -d` command from Task 1.1 prints four "No such file or directory" lines; `test -e "$HOME/Library/Application Support/@oh-my-pi/omp-gui"; echo $?` prints `1`; `pgrep -fl "omp --mode rpc-ui" | grep -c "Sai ATLAS"` prints `0`.

## Test matrix

| Kind | Coverage |
|---|---|
| Automated, packaged | nine smoke cases (Task 6.1) |
| Human | 15 rows (Task 6.3) |

## Regression gate

Task 6.1 smoke PASS, plus the zero-FAIL and zero-NEEDS-HUMAN greps.

## Rollback

Nothing to revert; this phase only verifies. A FAIL sends the fix back to its owning phase.

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

