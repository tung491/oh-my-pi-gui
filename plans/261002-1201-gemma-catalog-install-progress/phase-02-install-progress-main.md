---
phase: 2
title: "Install progress in main"
status: completed
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 2: Install progress in main

## Goal
Stream the Linux installer's stderr while it runs, parse it into `OllamaInstallProgress` frames, and send them to every window. Keep the closed-set remedy contract and its result unchanged.

## Files to Create / Modify
- Create: `src/main/ollama/install-progress.ts` (+ `.test.ts`), a pure parser.
- Modify: `src/main/ollama/remedy.ts` (+ `remedy.test.ts`): replace the `execFile` seam with a streaming `spawn` seam.
- Modify: `src/main/ollama/register-ipc.ts`: broadcast frames.
- Modify: `src/main/ollama/hardware.ts` (+ test): fill `MachineFacts.threads` from `os.availableParallelism()`, falling back to `os.cpus().length`, at least 1.

## Tasks & Steps
1. **Parser** (`install-progress.ts`): `createInstallProgressParser()` returns `{ push(chunk: string): OllamaInstallProgress | null; final(): OllamaInstallProgress }`.
   - Split on `\r` and `\n`, and keep any partial segment across chunks.
   - A segment matching `/^>>> (.+)$/` sets `stage` to the trimmed text and resets `percent` to -1.
   - A segment matching `/(\d{1,3}(?:\.\d)?)%\s*$/` sets `percent`, clamped to 0–100. This is curl's progress bar, e.g. `######   45.2%`.
   - The other segments are ignored: curl's `#=#=#` indeterminate frames, apt/dnf output, blank lines.
   - `push` returns a frame only when the stage or the integer percent changed.
   - Strip ANSI escapes before matching.
   - Tests cover: chunks split mid-line, `\r` frames, two downloads in one run (the percent resets on the new stage), unrelated noise, and ANSI.
2. **Remedy streaming** (`remedy.ts`):
   - Replace `ExecFileFn` with a `SpawnFn` seam that yields stderr and stdout chunks and an exit `{ code, signal }` or a spawn error.
   - The default uses `child_process.spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] })` with the same timeout. On timeout, send SIGTERM to the `pkexec` child.
   - Keep a 500-character stderr tail for `classifyExit`. Map the result shape back to the existing `ExecError` fields (`code`, `killed`) so `classifyExit` and its tests stay as they are.
   - `runRemedy` gains an optional `onProgress(frame)`. Only `linux-install` feeds chunks to the parser. `linux-start` emits nothing.
   - Emit `{ stage: null, percent: -1, done: false }` immediately, before the polkit dialog, and `parser.final()` with `done: true` before resolving.
   - The closed set, `REMEDY_COMMANDS`, `INSTALL_LINE` and the result mapping are unchanged.
3. **Broadcast** (`register-ipc.ts`):
   - `createRemedyGate` already joins calls with the same id. Pass one `onProgress` that sends `IPC_EVENTS.OLLAMA_INSTALL_PROGRESS` to **all** live webContents (`webContents.getAllWebContents()`, skipping destroyed ones), so the welcome screen and Settings both see one run.
   - Throttle to at most 10 Hz with the latest frame winning, as `pull.ts` does. The `done` frame flushes immediately.
4. **Threads**: add to `readMachine()`, and update its test.

## Verification
- `bunx vitest run src/main/ollama` passes, including:
  - parser table tests;
  - a remedy test with a fake `SpawnFn` scripting the stages `>>> Installing ollama to /usr/local`, `>>> Downloading ollama-linux-amd64.tar.zst`, curl frames at 10%, 55% and 100%, then `>>> Enabling and starting ollama service...`, then exit 0. It asserts the frame sequence starts indeterminate and ends with `done: true`, and that the result is unchanged;
  - exit 126, which maps to cancelled and still sends a `done` frame.
- `bun run check:types` passes, and `bunx biome check` passes on the touched files.

## Risks
- If a distro's `pkexec` closes fds, no output arrives. The bar then stays indeterminate with the waiting text, which is safe.
- The output of `curl` inside `install.sh` goes to the inherited stderr; I verified this locally with a pipe.
