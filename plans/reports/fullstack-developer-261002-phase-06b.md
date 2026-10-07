# Phase 6 part B report: integration, dead-code sweep, e2e, docs

Status: DONE_WITH_CONCERNS (not committed)

## Changes
- `src/main/ipc.ts`: `registerProviderCleanupIpc(ipcMain)` is called after `registerOllamaIpc()`. The `MODELS_PROVIDER_UPSERT`, `MODELS_PROVIDER_DELETE` and `MODELS_CONFIG_OPEN` handlers are removed (nothing called `openConfig`), along with the now-unused `existsSync`/`CustomProviderInput` imports.
- `src/shared/ipc-types.ts`, `src/preload/index.ts`: those three channels, `models.upsertProvider/deleteProvider/openConfig`, and the `CustomProviderInput` type are removed. `listProviders` stays.
- `src/main/models-config.ts`: now read-only. `upsertModelsProvider`, `deleteModelsProvider`, the writer helpers and `PROVIDER_PROTOCOLS` are removed. `provider-cleanup.ts` imports only `listModelsProviders` and `modelsPath`, checked by grep. `models-config.test.ts` keeps the read-path cases (path resolution with the legacy `.yaml` name, legacy thinking ladder parse, built-in flag, malformed tolerance).
- Deleted `settings/ProviderConfigDialog.tsx` (+test) and `settings/providers/{FormFields,ModelEditor(+test),ProviderConfigRow}.tsx`. Also removed: the App.tsx mount, the `ui.ts` `providerConfigOpen/Edit` and `open/closeProviderConfig` state, the "Add provider" button and the `providerConfig` target (CapabilitiesHome, SettingsWindow), and a stale comment in McpServerWizard.
- Locales: 218 keys removed from both `en.ts` and `zh.ts`: all `onboarding.*`, dead `providers.*` / `providerCfg.*`, `cmd.addProvider|openLogin|openLogout(.desc)`, `modelPicker.{empty,auth.*,footer.manageProviders}`, `common.{none,defaultParenthesized}`, `modelCompare.{authOnly,blockedNoAuth}`, `providers.badge.noAuth`, and `providers.cleanup.{showFile,dismiss}`. A key was removed only if it was quoted-literal used at HEAD (or in a namespace above) and is now used nowhere; dynamic `t(\`…${}\`)` builders were checked. Added `providers.cleanup.noticeSignOutOnly` (en/zh). `lib/provider-cleanup.ts` uses it when `backupPath` is null, and a new test covers that.
- `scripts/capture-showcase.ts`: waits for the welcome dialog, optionally shoots `00-onboarding` once the Ollama row and facts have loaded, then clicks `welcome.skip`.
- e2e: new `e2e/desktop-prefs.ts` (`writeDesktopPrefs`, which seeds `{ welcome: { completed } }` by default, with a `freshWelcome` opt-out). Every spec's `prefs.json` write goes through it (auto-follow, deep-audit, desktop, packaged-smoke, performance, quick-entry, real-core, runtime ×2). There is no shared launch helper, and the sidecar fixture does not know the userData path. `sidecar-fixture.ts` now answers `set_model` / `set_model_role`. New `e2e/onboarding.e2e.ts` covers this flow: fresh profile, welcome visible with "Ollama is running (0 models)", Download, progress bar, installed, Continue (asserts the `set_model ollama/<tag>` and `set_model_role default` RPCs and the pref), relaunch, no welcome.
- Docs: README "Install & start" (en + zh) explains that Ollama is required, describes the welcome screen and its remedies, and notes the `OLLAMA_BASE_URL`/`OLLAMA_HOST` rule. The capability row, the request-destination sentence and the `SHOWCASE_ONBOARDING` text are updated too. CHANGELOG Unreleased gains an Added entry (welcome screen), a Changed entry (Ollama only), and a Removed section (sign-out, `models.yml.bak-<timestamp>` / `models.yaml.bak-<timestamp>` backup, API keys kept but hidden, non-Ollama sessions need Continue or Use as default). The "five-step first-run wizard" phrase is dropped from the VIF bullet.

## Gates
- `bunx vitest run`: 196 files, 1802 tests pass.
- `bun run check:types`: clean. `bunx biome check` on every touched file: clean.
- `bun run build`: pass.
- e2e (DISPLAY=:0 available): `bun run test:e2e -- onboarding.e2e.ts` passes (3 runs). `desktop.e2e.ts` passes 21/21. `runtime`, `auto-follow` and `quick-entry` pass. Not run: deep-audit, real-core, performance (they use the real `resources/omp` and take up to 10 minutes) and packaged-smoke (needs an installed package).
- No Electron or Playwright process left running (checked with `ps`).

## Concerns
- The filter `bun run test:e2e -- onboarding` matches every spec in this worktree, because the worktree path contains "onboarding". Use `onboarding.e2e.ts`.
- `auto-follow.e2e.ts` failed once (scroll gap 100 < 200) in an accidental full run, then passed twice in isolation. It looks flaky and unrelated to this phase.
- `ProvidersWindow.test.tsx:185` (part A) asserts the absence of `providers.login/logout/editConfig` and `providerCfg.list.add` labels. I kept those four keys so the assertion is not made vacuous. They are otherwise unused; delete them once that test checks literal labels.
- `src/main/provider-cleanup.ts:57` (part A) still mentions the removed `deleteModelsProvider` in a comment.
- The showcase data serves non-Ollama models, which the store now filters out, so regenerated screenshots will show empty model lists. `tsc -p tsconfig.node.json` has pre-existing TS6307/TS2307 errors (locale imports, monorepo neighbours absent in the worktree).
- Phase step 6 (a manual smoke test with real Ollama and pkexec) was not done, because Ollama is not installed here.
