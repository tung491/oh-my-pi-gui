# Renderer engine API audit

Scope: Phase 9 Task 9.3. Worktree `../worktrees/tauri-renderer`, branch `tauri/renderer`, commit `5ddf1d8` (after Task 9.1).

## Grep hits

Command:

```
grep -rnE "showSaveFilePicker|showOpenFilePicker|showDirectoryPicker|navigator\.(userAgentData|keyboard|hid|serial|usb|bluetooth)|webkitSpeechRecognition|requestIdleCallback|CSS\.highlights|scheduler\.(postTask|yield)|MediaRecorder|file://" src/renderer --include=*.ts --include=*.tsx --include=*.js | grep -v "\.test\."
```

One hit:

```
src/renderer/components/panels/DiffPanel.tsx:91:				isVirtual: /^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !file.startsWith("file://"),
```

`file` here is a tool-reported path string (`fileResult.path` or `deriveFile(entry.args, diff, details)`), used only to classify a diff row as "virtual" (a URL-scheme path such as a plugin's synthetic path) versus a real local file. The line compares a string against the `file://` prefix; it never builds, assigns, or navigates to a `file://` URL. Safe as is, no fix needed — same shape as the already-accepted `FilesPanel.tsx:157` hit from the phase's "Verified starting facts".

No other API in the pattern list (`showSaveFilePicker`, `showOpenFilePicker`, `showDirectoryPicker`, `navigator.userAgentData/keyboard/hid/serial/usb/bluetooth`, `webkitSpeechRecognition`, `requestIdleCallback`, `CSS.highlights`, `scheduler.postTask`/`yield`, `MediaRecorder`) appears anywhere in non-test renderer source. `MediaRecorder` was already removed by Task 9.2 (`fa1b9c6`); re-confirmed here with `grep -c MediaRecorder src/renderer/lib/voice.ts` printing `0`.

## Blob downloads (Export logs)

`LogPanel.tsx:95-104` ("Export logs": `URL.createObjectURL` + `<a download>.click()`) is unchanged, per the plan's Decisions table ("Blob downloads") and this phase's Verified starting facts: the foundation allows same-origin `blob:` download navigations and routes them through `build_window`'s `.on_download(...)` to `Host::save_dialog`. No renderer code change was made or needed for this path.

**On-screen verification: NEEDS-HUMAN.** This check requires a running Tauri window with a display (`bun run dev:tauri -- --user-data-dir=$(mktemp -d)`), which in turn needs a from-scratch `cargo` build in this worktree (no pre-warmed `src-tauri/target/debug` here — this module owns renderer/TS files only and the wave rules direct executors to avoid full cargo builds unless a Verify strictly requires one) plus a native save-dialog interaction. Per the assignment's explicit instruction, this manual/on-screen check is parked here and batched with Phase 5's human session rather than attempted in this automated pass.

Steps for that session (controller / human):

1. `test -x resources/omp` in the worktree (confirmed present: yes, `resources/omp` exists).
2. Record the `.part` baseline: `ls -a "$(xdg-user-dir DOWNLOAD)" | grep -c '\.part$'` (on this machine, `xdg-user-dir DOWNLOAD` resolves to `/home/tung491/Downloads`).
3. `bun run dev:tauri -- --user-data-dir=$(mktemp -d)`.
4. Open the Logs panel, click "Export logs".
5. Expect: a native save dialog opens with suggested name `omp-logs-<timestamp>.log`.
6. Save into a scratch directory. Expect: the file exists (content may be empty — this worktree's log tail comes from the `services` stub).
7. Re-check `.part` count in Downloads: expect it unchanged from the step-2 baseline (the staged file was moved to the chosen path, not left behind).
8. Repeat the export, this time press Cancel in the dialog. Expect: `.part` count is still unchanged from baseline, and no `omp-logs-*.log` appears in the Downloads folder (the staged file was removed on cancel).
9. A leftover `.part` file in either case is a FAIL and, per the phase, a foundation defect — do not change `LogPanel.tsx`; follow the Failure Protocol instead.
10. Stop the `dev:tauri` process afterward.

Phase 10 Task 10.4 repeats this check with real log lines once all modules are merged.

Export logs: NEEDS-HUMAN
