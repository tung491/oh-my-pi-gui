# Review fixes: feat/ollama-only-onboarding

fullstack-developer, 2026-10-02 (Asia/Seoul). Fixes the confirmed findings in `code-reviewer-261002-final.md`. Nothing is committed.

## Outcome
H1, H2, M1, M2, M3, M4 and M5 are fixed. Each fix has a test, and every gate passes.

## Fixes

### H1: Continue after an on-screen download
- `FirstRunOnboardingDialog.tsx` adds `refreshCatalog()`, which calls the model store's `refreshAvailableModels(true)`.
  - `handleContinue` awaits it before `setModel`.
  - `markInstalled` fires it as soon as a pull finishes.
  - If the refresh fails, the screen logs it and still tries `setModel`. Any real failure then shows in the existing inline error.
- `e2e/sidecar-fixture.ts` now discovers Ollama models the way the agent does:
  - It reads `GET /api/tags` from `OMP_GUI_TEST_OLLAMA_URL` at startup and again on every forced `get_available_models` / `get_providers`, never in between.
  - It adds an `ollama` provider row once models exist.
  - `set_model` rejects any model missing from its catalog with `Model not found: provider/id`, which is the agent's own message.
- `e2e/onboarding.e2e.ts` passes `OMP_GUI_TEST_OLLAMA_URL` and checks that a forced catalog read was recorded.
- Negative check: with the awaited refresh removed, the onboarding e2e fails, because the welcome screen stays open on the set_model error. With it restored, the e2e passes.

### H2: `^` autocomplete fallback
- `use-completion-menu.ts` now passes the direct `getAvailableModels(true)` result through `filterAllowedModels`.
- I kept the direct read rather than going through the store on purpose. Committing an empty filtered catalog to the store changes `availableModels`, which re-runs the effect and triggers another forced refresh in a loop. The code comment explains this.

### M1: Cycle model
- `cycleAllowedModel(rpc, direction)` is new in `lib/command-registry.ts`.
  - It reads the store's filtered `availableModels` and picks the next or previous model after the current one, wrapping at both ends. If the current model is not in the list, it starts from the first (forward) or last (backward) model.
  - It switches with `set_model` through `runSessionCommand` and applies the returned model.
  - With no other model to move to, it does nothing, as `cycle_model` did.
- Both entry points use it: Ctrl+P / Shift+Ctrl+P in `App.tsx`, and the palette entry through `CommandPalette.tsx` and `buildCommandMenu`.
- Feedback: the old shortcut path toasted errors under `palette.failed` and showed nothing on success. That is unchanged. The palette path used to swallow an unsuccessful response silently; it now gets the same error toast.
- The description text in en and zh now reads "next downloaded model" instead of "next recent model".

### M2: Download buttons stuck disabled
- The dialog keeps `startedTags` (a ref that lives for the whole launch). Frames for tags this screen did not start are ignored. A tag stays in the set until its `pull()` settles, so a pull started before the screen closed still updates when it reopens.
- An `error` frame is stored as terminal (`done: true`), and `pullRunning` also excludes frames that carry an error.

### M3: Start button on Linux without a systemd unit
- `probe.ts` adds `detectOllamaInstall`, which returns `{installed, systemdUnit}`. `isOllamaInstalled` is kept and now wraps it.
- `remedyFor(state, platform, systemdUnit)` returns `linux-start` only when the unit exists. A binary found only on PATH gives `stopped` with remedy `null`.
- `OllamaRow` shows a new key, `welcome.ollama.stopped.manual`, for Linux + stopped + no remedy: "Ollama is installed but not running. Run “ollama serve” in a terminal, then check again." That case has no command block and no remedy button. Open-download and Check again stay enabled. The key is in en and zh.

### M4: Remedy guard in main
- `createRemedyGate(probe, run)` is new in `remedy.ts`, and `register-ipc.ts` uses it.
  - It re-probes and rejects (`That fix no longer matches Ollama's state; check again`) when `id !== status.remedy`, without running anything.
  - Single flight: a concurrent call with the same id gets the in-flight promise, which covers a double click or the welcome screen and Settings together. A concurrent call with a different id is rejected with `Another Ollama fix is already running`.
  - The gate is freed when the attempt settles, whether it succeeded, failed or was rejected.
- The welcome screen re-reads the status after a rejected remedy, so a stale button is replaced by the current state.

### M5: Stray build artifact
- I deleted `tsconfig.node.tsbuildinfo` and added `*.tsbuildinfo` to `.gitignore`. The main checkout's HEAD `.gitignore` did not cover it, and `git check-ignore` now matches.

## Tests added or updated
- `FirstRunOnboardingDialog.test.tsx`:
  - The expected call order is now refresh(true), then setModel, setModelRole and prefs.
  - A refresh runs after a pull.
  - A failed refresh still sets the model.
  - Frames for a download the screen did not start are ignored.
  - An error frame ends its download.
  - A download started earlier keeps updating after the screen reopens.
  - A refused remedy shows its notice and re-reads the status.
- `layout/use-completion-menu-models.test.tsx` (new): the fallback read offers only `ollama/*` and leaves the store untouched.
- `lib/cycle-allowed-model.test.ts` (new): forward, backward, wrapping at both ends, a current model outside the list, no-op cases, and a toast on a refused switch.
- `main/ollama/probe.test.ts`: a PATH-only install gets remedy null, plus `detectOllamaInstall` and the new `remedyFor` signature.
- `main/ollama/remedy.test.ts`: the gate runs a matching remedy, refuses a mismatched one, joins or refuses concurrent calls, and frees itself after a failure.
- `onboarding/OllamaRow.test.tsx`: a Linux install without a service shows the manual message and a working Check again.

## Gates
- `bunx vitest run`: 198 files, 1819 tests, all pass.
- `bun run check:types`: clean.
- `bunx biome check` on the 19 touched TS files: clean.
- `bun run build`: OK.
- `bunx playwright test e2e/onboarding.e2e.ts e2e/desktop.e2e.ts`: 22 passed.
- No Electron or fixture process was left running.

## Files touched
- **Edited:**
  - `e2e/sidecar-fixture.ts`
  - `e2e/onboarding.e2e.ts`
  - `src/renderer/components/dialogs/FirstRunOnboardingDialog.tsx` and `FirstRunOnboardingDialog.test.tsx`
  - `src/renderer/components/layout/use-completion-menu.ts`
  - `src/renderer/lib/command-registry.ts`
  - `src/renderer/components/dialogs/CommandPalette.tsx`
  - `src/renderer/App.tsx`
  - `src/main/ollama/{probe,probe.test,remedy,remedy.test,register-ipc}.ts`
  - `src/renderer/components/onboarding/OllamaRow.tsx` and `OllamaRow.test.tsx`
  - `src/renderer/locales/{en,zh}.ts`
  - `.gitignore`
- **New:**
  - `src/renderer/components/layout/use-completion-menu-models.test.tsx`
  - `src/renderer/lib/cycle-allowed-model.test.ts`
- **Deleted:** `tsconfig.node.tsbuildinfo`

## Unresolved questions
- `ProvidersWindow.tsx` (Settings › Ollama) does not re-read the status after a remedy rejected by the new gate. It shows the error toast, and Check again recovers. I left it alone because it was outside the listed scope.
- The worktree's locales are `en` and `zh`, while the main checkout's AGENTS.md describes `en` and `vi`. I followed the worktree.

Status: DONE
Summary: All seven confirmed findings are fixed with tests, and vitest, types, biome, build, and the onboarding and desktop e2e runs are green.
