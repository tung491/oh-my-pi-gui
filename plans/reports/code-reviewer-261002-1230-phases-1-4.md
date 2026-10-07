# Code review: Gemma catalog and Linux install progress (phases 1-4)

Scope: uncommitted `git diff` on `feat/gemma-catalog-install-progress`, plus the untracked `src/main/ollama/install-progress*.ts` and `src/renderer/components/onboarding/InstallProgressBar*.tsx`.
Plan: `plans/261002-1201-gemma-catalog-install-progress/plan.md`.
Not rerun: tsc, vitest and biome (the lead reported them green). One scratch repro was run with bun (see M1).

## Findings

### M1 (major): when the 15-minute timeout cannot stop a running install, the UI reports the wrong outcome and frames keep arriving after `done`
`src/main/ollama/remedy.ts:143-154` and `:69-72`

- **How the kill fails.** Once polkit has authorised the install, `pkexec` drops all of its uids to root and `execv`s `sh` in place. The `SIGTERM` from the timer at `:152-154` therefore goes to a root process. Node's `ChildProcess.kill` gets `EPERM` and emits `'error'`, so `onError` runs `finish(...)` while the installer keeps running.
- **How the stream leaks.** `onOutput` (`:143-147`) has no `settled` guard, so the parser and the broadcaster stay attached after the run has resolved.
- **Reproduced with bun.** I used a fake spawn whose `kill` raises `EPERM`, then sent one more stderr line after the run resolved:
  - The result was `{"outcome":"failed","fault":"kill EPERM"}`. "Timed out" was lost because `timedOut` is never consulted on the error path.
  - The frames were `[initial, done, {stage:"Installing ollama to /usr/local", done:false}]`.
- **When it happens.** The Linux bundle is large. On a slow link the download alone can take longer than 15 minutes, so this path is realistic.
- **What the user sees:**
  - The welcome screen shows "kill EPERM".
  - Every window then gets non-`done` frames. `OllamaRow` draws the bar again, because the status still offers `linux-install`.
  - The bar stays stuck on its last frame for good. No second `done` is ever sent, because `close` → `finish` does nothing once the run has settled.
  - The gate is free again, so the user can press Install and start a second root installer while the first is still running.
- **Fix:**
  - Add `if (settled) return;` at the top of `onOutput`.
  - On the timeout path, resolve directly with `{ outcome: "failed", fault: "Timed out…" }` instead of depending on how the kill turns out.
  - Optionally, give `linux-install` no hard timeout at all. This matches the user's decision that a root child of pkexec cannot be stopped safely: the timer could only resolve the result, never kill.

### m1 (minor): the parser's `partial` buffer has no size limit
`src/main/ollama/install-progress.ts:56-64`

- `stderr` is capped at `STDERR_KEEP` (8,000 chars), but `partial` grows until it sees a `\r` or `\n`.
- `PERCENT.exec` is then rerun over the whole `partial` on every chunk, which is quadratic.
- `install.sh` output always hits a `\r` or `\n` soon, so the practical risk is low. Still, it is the one unbounded buffer on this path, and the output comes from a root process.
- Fix: cap it, for example `partial = partial.slice(-512)`.

### m2 (minor): the `STDERR_KEEP` comment describes trimming that does not exist, and the fault text is mostly bar redraws
`src/main/ollama/remedy.ts:92-99`

- The comment reads "Enough stderr kept for `tail` after trimming curl's trailing bar redraws", but `tail()` only calls `trim()` and slices to the last 500 chars.
- If an install fails during or soon after a download, the fault shown to the user is mostly `\r######…` frames.
- This behaviour existed before this change (execFile captured the same stderr), but the new comment hides it.
- Fix: correct the comment, or actually strip the bar segments (for example, keep only the last `\r` segment of each line) before calling `tail`.

### m3 (minor): a window that joins a running install shows "Waiting for authorization…" during silent stages
`src/renderer/components/onboarding/OllamaRow.tsx:41-51`, together with `FirstRunOnboardingDialog.tsx:343-344` and `ProvidersWindow.tsx:106-107`

- **Scenario.** Window A starts the install. Window B already holds a live stage frame, for example ">>> Installing ollama to /usr/local". In B, the user presses Install, which joins the gate.
- `runRemedy` in B clears `installProgress`, so `visibleInstallFrame` falls back to `WAITING_FRAME`.
- B then shows "Waiting for authorization…" even though authorisation was granted minutes ago. It stays that way until the installer prints again, which during extraction or the systemd setup can take a while.
- Fix: clear only a held frame that is `done`, i.e. `setInstallProgress(p => (p?.done ? null : p))`.

## Mandatory checks

**(a) Acceptance criteria and sizing.** I checked these by hand against the Rust sources (`class.rs:62-118`, `sizing.rs:150-218`, `quality.rs:18-58`).

The `needBytes` values are:

| Model | Need (bytes) | About |
|---|---|---|
| E2B | 7,979,909,334 | 7.43 GiB |
| E4B | 9,821,442,858 | 9.15 GiB |
| 26B-A4B | 19,291,553,608 | 17.97 GiB |

| Case | Machine | Budget | Result |
|---|---|---|---|
| 2 | 16 GiB RAM, no GPU, 8 threads | RAM: 12 GiB (the reserve is the 4 GiB floor, because a quarter only overtakes it above 16 GiB) | E2B and E4B fit RAM; E4B is moderate (4.5 ≤ 9, 8 ≥ 8). E2B is minimal; E4B is recommended and maximum. Pass. |
| 3 | 32 GiB RAM, no GPU, 8 threads | RAM: 24 GiB | All three fit. 26B-A4B (3.8B active) is moderate, so it is maximum and recommended; E2B is minimal. Pass, assuming 8 or more threads, which the AC does not state. |
| 4 | 16 GiB RAM, 12 GiB GPU | VRAM: 11 GiB | E2B and E4B fit VRAM. 26B-A4B misses both VRAM and the 12 GiB RAM budget. E4B is recommended and maximum (fast); E2B is minimal. Pass. |
| 5 | 8 GiB RAM | RAM: 4 GiB | Nothing fits; 8 GiB exceeds 3.35 GB, so one tight, slow E2B minimal card. On 2 GiB, `too-small`. Pass. |
| 6 | 16 GiB RAM, 4 threads | RAM: 12 GiB | Both rows are slow, so there is no recommended card and the status is `recommended-omitted`. Pass. |

The sizing port is faithful to the Rust code:
- The minimal tie-break gives the same result, because the pool is already in quality order and the scan uses `<`.

Results against the remaining criteria:
- **AC1:** met in the normal path, but see M1 and m3.
- **AC7:** met through `installedName` plus `toChoice`.

**(b) Closed command set.** It still holds.
- `REMEDY_COMMANDS` is unchanged.
- `spawn` runs without a shell and with fixed argv.
- The IPC handler accepts only `{id}`, checked by `isRemedyId`.
- The gate re-probes before every run.
- Progress only flows from main to the renderer.

**(c) Spawn, timeout and kill.**
- When the child exits normally, `finish` clears the timer.
- `close` and `error` arriving twice is harmless.
- The stderr tail is bounded at 8,000 chars.
- Gaps: post-settle listeners and the timeout path (M1), and the unbounded `partial` buffer (m1).

**(d) Install matching and the `:latest` flow.**
- Matching is case-insensitive, accepts exact or bare names at the `:` boundary, and rejects blank input. `withDefaultTag` only looks at the last path segment, so a registry port is safe.
- Pull, then Continue:
  - The card pulls `ref:latest`, and `markInstalled` adds that tag to `pulledTags`.
  - `load()` then fetches the screen again, and its tag becomes the name Ollama lists.
  - If the listed name differed only in case, the stale `picked` value would fall back to `defaultPick`, so Continue would still use the listed name.
  - No defect found.

**(e) Subscriptions.** Both new `useEffect`s return the `subscribe` unsubscribe function, which calls `ipcRenderer.removeListener`. The throttle's timer is cleared on `done`.

**(f) Conventions.**
- No `any`, no `mock.module`, and no plan or phase IDs in code.
- The four new keys exist in both `en.ts` and `vi.ts`.
- The stage text is sanitised (`sanitizeToolText` plus `headLines`) and rendered as React text.

## Unresolved questions

- AC3 does not state a thread count. On 32 GiB with fewer than 8 threads there is no recommended card. Is that intended?
- `ModelScreen.status` is set, but no renderer reads it. Is it reserved for later use, or dead contract?

Status: DONE_WITH_CONCERNS
Summary: Sizing, matching, the closed command set and subscription cleanup are correct, and AC 2-7 hold. One major defect: when the timeout cannot kill a root install (`EPERM`), the run resolves with the wrong fault and keeps broadcasting non-`done` frames after `done`, which leaves a stuck bar and frees the gate for a second root installer.
