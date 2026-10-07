---
phase: 9
title: "Renderer compatibility with WebKit and WebView2"
status: pending
priority: P2
effort: "3d"
dependencies: [2]
module: renderer
---

# Phase 9: Renderer compatibility (module `renderer`)

## Goal

The unchanged renderer works the same in WKWebView (macOS), WebKitGTK (Linux) and WebView2 (Windows) as in Electron's Chromium. Fix only real engine differences. Every change must keep the Electron build working, because Electron still ships macOS and Windows until Phase 12.

## Wave rules

Same as Phase 3 (`phase-03-omp-processes.md` → Wave rules), with these substitutions: worktree `../worktrees/tauri-renderer`, branch `tauri/renderer`, gate `bash scripts/check-module.sh renderer`. The first-launch theme seed is already handled by the bootstrap init script (Phase 2), so `pre-paint.js` needs no change. Owned paths: `src/renderer/**` except `src/renderer/boot/**`, `src/renderer/main.tsx`, `src/renderer/quick-entry/main.tsx`, `src/renderer/global.d.ts`, `src/renderer/index.html` and `src/renderer/quick-entry.html` (frozen in Phase 2). `window.omp` and every type in `src/shared/` stay unchanged.

**Task 9.2 is done.** It landed on `main` as `fa1b9c6 feat(gui): capture dictation as raw PCM through WebAudio` before `tauri/foundation` branched, so every wave worktree already has it: `grep -c MediaRecorder src/renderer/lib/voice.ts` prints `0` and `src/renderer/public/pcm-capture-worklet.js` exists. Do not redo it in this worktree. The paragraph below and the Task 9.2 section are kept as the record of what it did.

**Exception for Task 9.2.** The voice capture change runs first, on `main`, before Phase 2 creates `tauri/foundation`: Electron needs it too (Chromium supports the same APIs), Phase 5 Task 5.3b verifies dictation in a Tauri window during the wave and would otherwise lack it, and the wave worktrees inherit it from the branch point. Its gate at that time is the Electron one (`bunx vitest run`, `bun run check:types`, `bunx biome check` on the touched files, `bun run build`, a dictation run in `bun run dev`). Its files, `src/renderer/lib/voice.ts`, `src/renderer/lib/voice-capture.test.ts` and `src/renderer/public/pcm-capture-worklet.js`, are not on the frozen list. Tasks 9.1, 9.3 and 9.4 run in the wave as usual; Task 9.2's WebKitGTK verification happens in Phase 5 Task 5.3b and Phase 10 Task 10.4.

## Verified starting facts (2026-10-02)

- No renderer file imports Electron, uses `process.*`, or builds `file://` URLs. The `file:` hit in `src/renderer/components/panels/FilesPanel.tsx:157` is an id prefix, not a URL.
- `-webkit-app-region` (`src/renderer/styles/global.css:208-212`) has no effect today, because the main window keeps native decorations and the quick-entry window has no drag area. Leave it as it is.
- Engine-sensitive CSS in use: `color-mix()` (`global.css:972-974`), `@container` (`global.css:690-889`), `::-webkit-scrollbar` (`global.css:155-176`). All are supported by Safari 16.4+ and WebKitGTK 2.4x+, so no change is expected. Phase 10's visual pass confirms it.
- Voice (before Task 9.2; `fa1b9c6` replaced this path): `src/renderer/lib/voice.ts:99-166` recorded with `MediaRecorder`, decodes the Blob with `decodeAudioData`, resamples through an `OfflineAudioContext` to 16 kHz mono and encodes PCM16 WAV (`encodeWavPcm16`, `voice.ts:35`) for `transcribeAudio`. Phase 0 S4: on Ubuntu's WebKitGTK 2.52.6, `MediaRecorder.start()` throws `NotSupportedError` for every mime type, with or without `gstreamer1.0-plugins-bad`, while `getUserMedia`, `AudioContext.createMediaStreamSource`, `ScriptProcessorNode`, `AudioWorklet` (from a same-origin file; a `blob:` URL is blocked by `script-src 'self'`) and `OfflineAudioContext` all work and produced a correct 16 kHz WAV. kongming's counsel and the user chose WebAudio PCM capture over `cpal` or the GStreamer plugin.

## Tasks

### Task 9.1: Suppress the non-editable default context menu
- Goal: right-clicking outside a text field shows no menu, as in Electron (`src/main/editable-context-menu.ts:15` returned no items). Editable fields keep the native menu with spelling suggestions.
- Target: create `src/renderer/lib/context-menu-guard.ts` and `src/renderer/lib/context-menu-guard.test.ts`. Install it from `src/renderer/App.tsx` (one `useEffect`) and `src/renderer/quick-entry/QuickEntryBar.tsx`.
- Steps:
  1. `installContextMenuGuard(doc: Document): () => void` adds a `contextmenu` listener that calls `preventDefault()` unless the event target is inside an `input`, a `textarea` or a `[contenteditable]` element, or inside an element marked `data-native-context-menu`. It returns the remover.
  2. Tests (linkedom harness): `prevents the menu on plain content`, `allows the menu in a textarea`, `allows the menu in contenteditable`, `remover detaches the listener`.
- Success criteria: tests pass, and the Electron build behaves as before (its main-process handler already shows nothing for non-editable targets).
- Verify: `bunx vitest run src/renderer/lib/context-menu-guard.test.ts` exits 0 with `4 passed`.

### Task 9.2: Capture dictation with WebAudio PCM instead of MediaRecorder (runs on `main` before Phase 2)
- Goal: dictation works on every engine, Electron included, with one voice path and no recorder dependency on the platform's media encoders.
- Target: `src/renderer/lib/voice.ts`, `src/renderer/lib/voice-capture.test.ts` (new), `src/renderer/public/pcm-capture-worklet.js` (new, plain JavaScript).
- Steps:
  1. Keep `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })` (`voice.ts:129-131`) and the `stopVoiceRecording`/`cancelVoiceRecording` contract; the composer does not change.
  2. Worklet: `pcm-capture-worklet.js` registers an `AudioWorkletProcessor` (`registerProcessor("pcm-capture", …)`) that posts each 128-frame block of channel 0 as a `Float32Array` to the node's port. It lives in `src/renderer/public/` so Vite copies it verbatim next to `index.html` (like `pre-paint.js`, `index.html:12`) and it loads from the app origin under `script-src 'self'` in both shells. Do not import it as a Vite asset: Vite inlines assets under 4 KB as `data:` URLs, which the CSP blocks, and `vite.renderer.shared.ts` is frozen. Load it with `context.audioWorklet.addModule(new URL("./pcm-capture-worklet.js", document.baseURI).href)`.
  3. Capture: create an `AudioContext`, `createMediaStreamSource(stream)`, then `chooseCaptureBackend(context)` returns `"worklet"` when `context.audioWorklet` exists and `"script-processor"` otherwise (Electron's Chromium has both; keep the `ScriptProcessorNode` fallback while Electron ships, with a 4096-frame buffer). Either backend appends blocks to one `Float32Array[]` accumulator; the worklet is preferred because it runs on the audio thread and survives long main-thread tasks such as streaming markdown. Connect the capture node to the destination through a zero-gain node so it is pulled.
  4. Stop: disconnect, close the context, `concatFloat32(blocks)` into one buffer at `context.sampleRate`, build an `AudioBuffer` from it, and feed the existing `OfflineAudioContext` 16 kHz resample and `encodeWavPcm16` (`voice.ts:155-167`, minus the `decodeAudioData` step). The `transcribeAudio(base64, "audio/wav")` call is unchanged. An empty accumulator returns `voice.mic.empty` as before.
  5. Remove every `MediaRecorder` reference and the `Blob` chunk state from `voice.ts`; update the file header comment.
  6. Tests (`voice-capture.test.ts`, pure functions; linkedom has no audio): `prefers the worklet when the context offers audioWorklet`, `falls back to ScriptProcessorNode without audioWorklet`, `concatenates captured blocks in order`, `an empty capture encodes no WAV`.
  7. Manual, in Electron (`bun run dev`): enable `stt`, dictate two seconds, and confirm a transcript arrives; the sidecar log shows one `transcribe_audio` request.
- Success criteria: tests pass, `MediaRecorder` is gone from the renderer, the Electron build dictates as before, and the worklet file ships in both renderer outputs.
- Verify: `bunx vitest run src/renderer/lib/voice-capture.test.ts` exits 0 with `4 passed`; `grep -rn "MediaRecorder" src/renderer` prints nothing; `bun run build` exits 0 and `test -f out/renderer/pcm-capture-worklet.js` succeeds (after Phase 2, `bun run build:renderer:tauri` and `test -f out/renderer-tauri/pcm-capture-worklet.js` too); `grep -c transcribe_audio` over the Electron dev run's sidecar log prints at least `1`.

### Task 9.3: Engine API audit
- Goal: no renderer code depends on a Chromium-only API without a fallback. The full visual pass runs in Phase 10, once all modules are merged and real data flows.
- Steps:
  1. Run `grep -rnE "showSaveFilePicker|showOpenFilePicker|showDirectoryPicker|navigator\.(userAgentData|keyboard|hid|serial|usb|bluetooth)|webkitSpeechRecognition|requestIdleCallback|CSS\.highlights|scheduler\.(postTask|yield)|MediaRecorder|file://" src/renderer --include=*.ts --include=*.tsx --include=*.js | grep -v "\.test\."`. `file://` matters because the WebKit sandbox blocks it (Phase 0 S14); the only expected `file:` hit is the id prefix in `FilesPanel.tsx:157`, which is not a URL.
  2. For each hit, add a feature check with the existing behavior as the fallback. Write one test per fix.
  3. Blob downloads. The only one in the renderer is "Export logs" (`src/renderer/components/panels/LogPanel.tsx:95-104`: `URL.createObjectURL` plus `<a download>.click()`). In WebKitGTK that click is a navigation to a same-origin `blob:` URL. The foundation allows same-origin `blob:` download navigations and routes them through `build_window`'s `.on_download(...)` handler to `Host::save_dialog` (decision of 2026-10-02, recorded in `plan.md` → Decisions), so the renderer code stays as it is; no channel was added. Check that path: `test -x resources/omp`, then in `bun run dev:tauri -- --user-data-dir=$(mktemp -d)` open the Logs panel and click Export. A native save dialog opens with the suggested name `omp-logs-<timestamp>.log`; save into a scratch dir; the file exists and holds the panel's visible lines. The foundation stages the download first: WebKit writes it to the user's Downloads folder (`xdg-user-dir DOWNLOAD`, else `$HOME`) under a hidden name `.<suggested name>.<pid>-<n>.part`, and the save dialog opens only after that write finishes (`webview.rs`, `Downloads`). Before the click, record `ls -a "$(xdg-user-dir DOWNLOAD)" | grep -c '\.part$'`. After Save, the same count is unchanged (the staged file was moved to the chosen path); then repeat the export and press Cancel in the dialog: the count is still unchanged and no `omp-logs-*.log` appeared in the Downloads folder (the staged file was removed). A `.part` file left behind in either case is a FAIL. In this worktree the log tail comes from the `services` stub, so the panel may be empty and the file may be empty too; the check is that the dialog opens and the file is written. Phase 10 Task 10.4 repeats it with real lines. If the dialog does not open, that is a foundation defect: follow the Failure Protocol, do not change `LogPanel.tsx`. Stop the dev process.
  4. Write the hits and fixes (or "no hits"), and the Export-logs result as a line of its own, exactly `Export logs: PASS` or `Export logs: FAIL`, to `/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/reports/renderer-engine-audit.md`.
- Success criteria: the audit report exists, every hit has a fix or a documented reason that it is safe, and Export logs opens a save dialog and writes the file in the Tauri build.
- Verify: `test -f /home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/reports/renderer-engine-audit.md` exits 0, and `grep -c "^Export logs: PASS$" /home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/reports/renderer-engine-audit.md` prints `1`.

### Task 9.4: Module gate and commit
- Verify: `bash scripts/check-module.sh renderer` exits 0 with last line `check-module renderer: PASS`. Then commit `fix(gui): keep the renderer engine-neutral across webviews`. (Task 9.2 was committed separately on `main` as `fa1b9c6 feat(gui): capture dictation as raw PCM through WebAudio`.)

## Status report

End with `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, a summary, the audit result and the Export-logs result. `DONE` is invalid unless the gate passed.

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
