# Install progress UI: implementation report

Status: completed. The Ollama status row now shows the Linux install bar on both the welcome screen and Settings › Ollama.

## Files
- New: `src/renderer/components/onboarding/InstallProgressBar.tsx` (53 lines) and `InstallProgressBar.test.tsx` (102 lines). The bar reuses PullBar's `.omp-pull-track` / `.omp-pull-fill` markup, so it gets the striped indeterminate state and the existing `prefers-reduced-motion` rules. It has no cancel control. The stage text is rendered as a text node, cleaned with `sanitizeToolText`, and cut to one line with `headLines(…, 1)`. A CSS `truncate` class handles overflow.
- `OllamaRow.tsx` (+ test): new optional `installProgress` prop. `visibleInstallFrame` returns nothing unless `status.remedy === "linux-install"`. A held non-done frame is shown regardless of `busy`, and a held done frame hides the bar. With no frame held, the waiting state shows while local `busy === "linux-install"`. The bar sits under the button row, so nothing above it moves.
- `FirstRunOnboardingDialog.tsx` / `ProvidersWindow.tsx` (+ tests): each subscribes to `onInstallProgress` for the component's lifetime and holds the latest frame. The held frame is reset to null at the start of `runRemedy` and in its `finally`. Both test fakes gained `onInstallProgress`.
- `onboarding.css`: only the header comment changed. The install bar shares the existing pull-bar styles.

## Deviation from the brief
The brief said to clear the held frame when a done frame arrives. Clearing it on done let the waiting fallback come back, because `busy` is still set until the remedy result lands. The first test run caught this. The fix keeps the done frame in state: a null frame means no frame has arrived yet, and a held done frame means the run ended. The frame is reset when a local run starts and when it settles. kongming reviewed the change against `install-progress.ts`, `register-ipc.ts` and `remedy.ts`. A done frame is always flushed last and runs never overlap, so a late frame cannot leak across runs.

## Verification
- `bunx vitest run src/renderer/components/onboarding src/renderer/components/dialogs/FirstRunOnboardingDialog.test.tsx src/renderer/components/settings/ProvidersWindow.test.tsx`: 86/86 pass, including ModelCard.test.tsx.
- Cases covered:
  - the waiting text shows before any stage;
  - a stage at 42% renders `aria-valuenow=42`;
  - a done frame hides the bar, even while this window's own install is busy;
  - Settings shows the bar from a broadcast frame without having called `runRemedy`;
  - frames are ignored once the row stops offering the install;
  - a rejected `runRemedy` clears the bar;
  - no cancel button exists.
- `bun run check:types`: clean. `bunx biome check` on the touched files: clean.

## Unresolved
- None. An optional follow-up: the subscribe-and-reset logic is duplicated in two parents. A shared hook would remove the duplication, but it would need a new file outside this phase's ownership.
