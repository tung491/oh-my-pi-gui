---
phase: 4
title: "Install progress UI"
status: completed
priority: P1
effort: "3h"
dependencies: [1]
---

# Phase 4: Install progress UI

## Goal
Render the install progress in the Ollama status row, so the welcome screen and Settings › Ollama both show it, with no cancel control.

## Files to Create / Modify
- Create: `src/renderer/components/onboarding/InstallProgressBar.tsx` (+ test). It follows `PullBar.tsx`'s markup and its striped indeterminate state, and has no cancel button. Style it in `onboarding.css` with `--omp-*` tokens only, and respect `prefers-reduced-motion`.
- Modify: `src/renderer/components/onboarding/OllamaRow.tsx` (+ test): an `installProgress: OllamaInstallProgress | null` prop renders the bar under the remedy button while `busy === "linux-install"`.
- Modify: `src/renderer/components/dialogs/FirstRunOnboardingDialog.tsx` (+ test) and `src/renderer/components/settings/ProvidersWindow.tsx` (+ test): subscribe with `window.omp.ollama.onInstallProgress`, keep the latest frame, pass it to `OllamaRow`, and clear it on a `done` frame and when the remedy result arrives.

## Tasks & Steps
1. **InstallProgressBar** `{ progress: OllamaInstallProgress }`:
   - `stage === null && percent === -1`: indeterminate stripes, with the text `welcome.install.waiting`.
   - `percent === -1` with a stage: indeterminate stripes, with the stage text.
   - `percent >= 0`: a determinate bar (`role="progressbar"`, `aria-valuenow`), the stage text, and `welcome.install.percent`.
   - Under the bar: `welcome.install.note`.
   - The stage text is installer output, so render it as a text node only, cut to a single line with the existing `format.ts` truncation helper.
2. **OllamaRow**: no layout jump. The bar replaces nothing; it appears below the command block. Other remedy buttons stay disabled while busy, as they are today.
3. **Subscribers**: the welcome screen and Settings each subscribe on mount and unsubscribe on unmount. A window that opens mid-install shows frames from the next one it receives. Ignore frames when the row's status no longer offers `linux-install`.

## Verification
- `bunx vitest run src/renderer/components/onboarding src/renderer/components/dialogs/FirstRunOnboardingDialog.test.tsx src/renderer/components/settings/ProvidersWindow.test.tsx` passes. Cases: waiting text before any stage; a stage and 42% renders `aria-valuenow=42`; a `done` frame hides the bar; the bar is also shown in Settings; no cancel button exists.
- `bun run check:types` passes, and `bunx biome check` passes on the touched files.
