# Phase 2 report: install progress in main

Status: completed. `bunx vitest run src/main/ollama` passes (7 files, 98 tests), `bun run check:types` is clean, and `bunx biome check` is clean on all owned files.

## Files
- `src/main/ollama/install-progress.ts` (new, 117 lines). `createInstallProgressParser()` handles stage lines, curl percent frames, ANSI stripping and partial segments, and only reports a frame when the stage or the whole percent changes. `throttleInstallProgress()` sends at most one frame per 100 ms with the latest frame winning, and sends `done` immediately.
- `src/main/ollama/install-progress.test.ts` (new, 132 lines). Covers the parser table cases and the throttle.
- `src/main/ollama/remedy.ts`. The `execFile` seam is now a `SpawnFn` seam that streams output and then reports one exit or spawn error. The SIGTERM timeout lives in `run()`, and it sets `killed`/`code`/`signal` the way `execFile` did, so `classifyExit` is unchanged. The stderr tail is capped at 8000 chars and the fault keeps its 500-char tail. `RemedyDeps.onProgress` applies to `linux-install` only. That remedy sends an indeterminate frame before spawning and a `done` frame in a `finally` after the settle loop, so it arrives on every outcome, including a probe rejection. A listener that throws is logged and ignored. `REMEDY_COMMANDS`, `INSTALL_LINE`, the closed set and the result mapping are unchanged.
- `src/main/ollama/remedy.test.ts`. The fake is now a spawn script. It adds a timeout/SIGTERM case, a death-by-signal case, the scripted installer frame sequence, done frames on cancelled, unavailable and failed outcomes, done after the settle loop, done on probe rejection, a listener that throws, and a check that `linux-start` emits nothing.
- `src/main/ollama/register-ipc.ts`. Each gated run gets one throttled broadcaster that sends to every live entry in `webContents.getAllWebContents()`.
- `src/main/ollama/hardware.ts` and its test. `HardwareDeps.availableParallelism` defaults to `os.availableParallelism?.() ?? os.cpus().length`. The result is floored, and a value that is invalid or throws becomes 1. The three failing cases now expect `threads: 8`, and a new case covers the fallback.

## Deviations and notes
- curl draws each bar frame with a leading `\r`, so the newest frame stays unterminated until the next redraw. The parser therefore reads a percent from the trailing partial segment once it ends in `%`. It does not read stages from a partial segment.
- Two tests failed on the first run, and I consulted kongming. Both causes were in the test fixtures:
  - One parser fixture had no newline before a `>>>` line. curl always writes `\n` after its bar, on success and on failure, so I fixed the fixture.
  - In the timeout test, fake timers queue the child's exit just past the advanced window. The test now calls `vi.runOnlyPendingTimersAsync()` after asserting the kill.
