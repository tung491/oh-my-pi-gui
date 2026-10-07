# Phase 3 — provider cleanup migration: report

Status: DONE_WITH_CONCERNS

## Files
- Created `src/main/provider-cleanup.ts`: `cleanConfig(now?)`, `backupStamp`, `registerProviderCleanupIpc(ipcMain)` (phase 6 wires it into ipc.ts).
- Created `src/main/provider-cleanup.test.ts` (5 tests).
- Created `src/renderer/lib/provider-cleanup.ts`: `runProviderCleanup(deps)`, `useProviderCleanup(overrides?)`, `PROVIDER_CLEANUP_PREF`.
- Created `src/renderer/lib/provider-cleanup.test.tsx` (9 tests; `.tsx` because the hook test renders JSX).
- Edited `src/renderer/App.tsx`: one import and one `useProviderCleanup()` call.

## Decisions
- Built-in overrides (e.g. `providers.anthropic`) must be removed, but `deleteModelsProvider` refuses built-in ids. Cleanup therefore edits the YAML document itself (one atomic temp+rename write, comments preserved) after `listModelsProviders()` validates the file. models-config.ts was not edited.
- Main side is synchronous, so concurrent calls from several windows serialize; the second one is a no-op.
- Backup: `copyFileSync(..., COPYFILE_EXCL)` to `<models file>.bak-<YYYYMMDD-HHmmss>` (local time), size verified; a mismatched copy is removed and the call throws before any delete.
- Pref `providers.cleanupVersion`: electron-store stores it as `{providers:{cleanupVersion:1}}`. A `conf` round-trip gave back `1`, and `isMainOwnedPrefKey` does not block the `providers` root.
- Failure semantics: a single failed logout is warned and skipped, and the pref is still set. The pref stays unset when reading the pref, `getProviders`, `cleanConfig`, or `prefs.set` throws. The tests cover both cases.
- Only `authKind === "oauth"` providers are signed out. The code comment says env-var and stored API keys stay, hidden by provider-policy.

## Gates
- `bunx vitest run src/main/provider-cleanup.test.ts src/renderer/lib/provider-cleanup.test.tsx`: 14 passed.
- `bun run check:types`: clean.
- `bunx biome check` on the 5 files: clean.

## Concerns
- `providers.cleanup.notice` says the config "was saved to {path}". When only sign-outs happened (no backup), the hook fills `models.yml`. Phase 6 may want a separate sign-out-only key.
- The toast store has no action buttons, so `providers.cleanup.showFile` and `dismiss` are unused here.
