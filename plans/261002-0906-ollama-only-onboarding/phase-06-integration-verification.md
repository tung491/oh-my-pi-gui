# Phase 6 — Integration, dead-code sweep, verification

Sequential, after phases 2 to 5 merge.

## File ownership

`src/main/ipc.ts` (wire `registerProviderCleanupIpc`), deleting `settings/ProviderConfigDialog.tsx`, `settings/providers/FormFields.tsx` and `settings/providers/ModelEditor.tsx` along with their `ui.ts` state if no longer referenced, `src/renderer/locales/{en,zh}.ts` (remove the `onboarding.*` and dead `providers.*` keys), `e2e/onboarding.e2e.ts` (new), `README.md` (setup section), `CHANGELOG.md` (Unreleased).

## Steps

1. Wire the cleanup IPC, then run the app with `bun run dev` against a test profile that has an OAuth provider and a custom provider. Confirm the backup, the logout and the notice.
2. Delete the dead files and the locale keys found with `grep -rn "t(\"onboarding\.\|t(\"providers\." src/renderer`, removing them from both locale files together.
3. Add `e2e/onboarding.e2e.ts` using `e2e/sidecar-fixture.ts` plus a `Bun.serve` fake Ollama on a free port (passed through `OLLAMA_HOST`). Cover: fresh profile → screen visible → download a model → Continue → screen gone after a relaunch.
4. Docs: README "Getting started" says Sai ATLAS needs Ollama and describes the welcome screen. CHANGELOG notes the removed providers and the `models.yml.bak-*` backup.
5. Full gates: `bunx vitest run`, `bun run check:types`, `bunx biome check` on touched files, `bun run build`, `bun run test:e2e -- onboarding`.
6. Manual smoke on Linux with real Ollama: stopped → Start (pkexec) → ok → pull `qwen3:4b` → Continue → chat replies from the local model.

## Merge note: zh to vi

This branch adds its keys to `zh.ts` (user decision, 2026-10-02). `main` is migrating the second locale from `zh` to `vi`. When the branch merges after that migration, `zh.ts` becomes a delete/modify conflict. Port every `welcome.*`, `ollama.*`, `providers.cleanup.*` and `modelPicker.{emptyLocal,openOllama}` key, plus the changed `cmd.providers*` values, to `vi.ts` with Vietnamese text before `locales.test.ts` can pass.

## Done when

Every acceptance criterion in `plan.md` is checked against the running app, not only against tests.
