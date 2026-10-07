# Phase 6 part A: review fixes

Status: completed. Full suite 196 files / 1801 tests pass, `bun run check:types` is clean, and `bunx biome check` is clean on every touched file.

## Fixes

1. **ModelCompare** (`src/renderer/components/settings/ModelCompare.tsx`): removed the `no-auth` unusable reason. `UnusableReason` is now `"disabled"` only. Removed the `providers.badge.noAuth` badge (an unauthenticated keyless provider now shows no auth badge), and removed the auth-only filter together with its toggle button and state. The three row-availability tests now use Ollama fixtures: a disabled provider stays blocked, a keyless row click calls `setModel("ollama","qwen3:8b")`, and a model whose provider list is `[]` stays usable.
2. **use-rpc-events.test.tsx**: the catalog completion frame now uses `ollama/qwen3:8b`. The store filters out non-Ollama models, which is why this test was failing.
3. **provider-cleanup.ts**: the order is now parse, delete in the document, render, back up (`COPYFILE_EXCL`, with the size checked against the byte length of the parsed source), then temp write and rename. A `deleteIn` that throws (an alias) or returns false raises a "cannot remove provider" error before any backup is written. A new test covers `providers: *p`: it throws, and the directory still contains only `models.yml`.
4. **remedy.ts**: when the command applies but the daemon is still not `ok` after the settle loop, it returns `failed` with "Ollama is still not answering after the command finished". The old "reports applied when the daemon never comes up" test was replaced, because the behaviour changed as specified.
5. **ProvidersWindow "Use as default"**: after `setModel` it calls `setModelRole("default", "ollama/<tag>")` (an error toast is shown and nothing is marked on failure), then sets `WELCOME_COMPLETED_PREF` to an ISO time. A failure to write the pref only logs a warning, as Continue does. Tests cover success, a refused role, and a pref write failure.
6. **Hidden account commands**: `HIDDEN_ACCOUNT_COMMANDS` now lives in `src/shared/provider-policy.ts` and is used by `command-registry.ts` and by the new pure `slashCommandItems()` in `src/renderer/components/layout/use-completion-menu.ts`, which the slash-name autocomplete now uses. A hand-typed `/login` is still forwarded, because submit routing is unchanged.

## Now-unused locale keys (owned by part B)

- `providers.badge.noAuth`
- `modelCompare.authOnly`
- `modelCompare.blockedNoAuth`

## Note

`use-completion-menu.ts` and its test hold the composer's slash-completion source, which was edited under the "wherever completion is fed" ownership clause.
