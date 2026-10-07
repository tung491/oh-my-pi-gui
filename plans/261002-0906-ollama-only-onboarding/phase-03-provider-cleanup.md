# Phase 3 — Provider cleanup migration

Parallel with phases 2, 4 and 5. This is destructive, so the backup comes first.

## File ownership

Creates `src/main/provider-cleanup.ts` (+ `.test.ts`), `src/renderer/lib/provider-cleanup.ts` (+ `.test.ts`).
Does not edit `src/main/ipc.ts`, which phase 2 owns during the parallel window. Export `registerProviderCleanupIpc(ipcMain)` instead; phase 6 wires that one call.
Edits `src/renderer/App.tsx`, adding one `useProviderCleanup()` hook call (App.tsx is otherwise untouched by phases 4 and 5; the onboarding dialog keeps its name and export).

## Requirements

1. **main `cleanConfig()`**:
   - Read `models.yml` through the existing `src/main/models-config.ts` API.
   - If no provider outside `ALLOWED_PROVIDER_IDS` exists, return `{ backupPath: null, removed: [] }`.
   - Otherwise copy the file to `models.yml.bak-<YYYYMMDD-HHmmss>` next to it (`fs.copyFile`, failing if the target exists), verify the copy's byte length, and only then delete each non-Ollama provider with the existing delete function (keep an `ollama` override if one is present).
   - Return the backup path and the removed ids. Idempotent.
2. **renderer `useProviderCleanup()`**: runs once per profile, guarded by the pref `providers.cleanupVersion === 1` stored through `window.omp.prefs`.
   - Wait for sidecar `ready`, then call `tabRpc.getProviders(true)`.
   - For each provider where `!isAllowedProvider(id) && authenticated && authKind === "oauth"`, call `tabRpc.logout(id)`. Do them sequentially, and if one fails, log it and carry on.
   - Then call `window.omp.providerCleanup.cleanConfig()`.
   - Set the pref only after both steps finish. If anything threw, leave it unset so the next launch retries.
   - If anything was removed or logged out, show the `providers.cleanup.notice` toast through the existing toast store.
3. API keys that come from environment variables cannot be removed by the GUI. They stay hidden by the phase 5 filter. Add a code comment saying so.

## Validation

- main test: a temp agent dir with a `models.yml` holding `anthropic`, a custom `my-proxy`, and `ollama`. After cleanup the backup exists byte-identical, only `ollama` remains, and a second run is a no-op that writes no new backup.
- renderer test: a linkedom harness with a fake `tabRpc` object (an injected dependency, not `mock.module`). Logout is called for each OAuth provider, the pref is set, and a failure leaves the pref unset.

## Rollback

The user (or support) restores `models.yml.bak-*` over `models.yml`. Signed-out OAuth providers need a fresh login once the allow-list is widened.
