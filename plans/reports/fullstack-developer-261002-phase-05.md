# Phase 5 report: Ollama-only provider surfaces

Status: DONE_WITH_CONCERNS

## Changes (owned files only)
- `stores/model.ts`: one `allowedCatalog()` filter on every catalog read (`get_available_models`, `get_providers`) and push (`model_catalog_update`). It filters models, provider rows and discovery states, so return values and the store agree. New `stores/model.test.ts`.
- `settings/ProvidersWindow.tsx`: rewritten as the Ollama window. It has an `OllamaRow` status card, the endpoint shown read-only, installed tags with "Use as default" (`tabRpc.setModel("ollama", tag)` + `applyModelInfo`, as ModelPicker does), a tag input with Pull and `PullBar`, and "Run setup again" (`openWelcome`). Login, logout, the custom-provider Add, `openProviderConfig`, `providerConfigOpen` and the models.yml hint are gone. Remedy outcomes and the busy frame are handled as specified. Test rewritten (16 cases).
- `dialogs/ModelPicker.tsx`: a flat list with no provider headers and no `getLoginProviders` call. The empty state shows `modelPicker.emptyLocal` + `modelPicker.openOllama`, and the footer button is now "Open Ollama settings". Tests added for anthropic + ollama arriving with only ollama rendering, for the empty state and for selection.
- `settings/ModelRolesWindow.tsx`: filters `get_model_roles` candidates directly, because it reads that RPC itself.
- `dialogs/BenchmarkDialog.tsx`: no longer seeds the run from a non-Ollama session model. New test.
- `lib/command-registry.ts` / `CommandPalette.tsx`: removed `add-provider` (aliases `provider-config`, `custom-provider`), `login`, `logout` and `openProviderConfig` from the context. Sidecar-advertised `login`/`logout` are no longer merged into the palette. `providers` keeps `cmd.providers` ("Ollama"). New registry test.
- `lib/provider-login.ts` + test: deleted, because no importer remained (phase 4 had already dropped its import).
- `layout/Sidebar.tsx`: the nav entry now uses `ollama.settings.title`. `settings/SettingsWindow.tsx`: the `providerConfig` capability target now opens the Ollama window.
- `ProviderConfigRow.tsx` and `ModelValueSelect.tsx` are unchanged. ModelValueSelect gets the filter from the store; its test now covers it.

## Gates
- `bun run check:types`: clean.
- `bunx biome check <owned files>`: clean.
- `bunx vitest run` over settings, ModelPicker, Benchmark, CommandPalette, layout, lib and stores: everything in my files passes.
- `grep -rn "openProviderConfig\|loginProvider" src/renderer`: only `ui.ts` and the `ProviderConfigDialog.tsx` comment remain.

## Concerns (outside my ownership, caused by the store filter)
1. `settings/ModelCompare.test.tsx` "row availability" (3 tests) uses providers `serving`/`noauth`/`off`/`unlisted`, and the store now drops them. The suite needs reworking around `ollama` rows. ModelCompare's per-provider auth/disabled logic is mostly moot now.
2. `hooks/use-rpc-events.test.tsx` "applies a model catalog completion frame…" uses provider `custom`. Changing the fixture to `ollama` fixes it.
3. `settings/pages/CapabilitiesHome.tsx:337` still renders the `cmd.addProvider` button (target `providerConfig`). It now opens the Ollama window. Remove the button and the target in phase 6.
4. `ProviderConfigRow.tsx` is only used by `ProviderConfigDialog.tsx`. Delete it with that dialog in phase 6.
5. Optional locale key: the busy download notice currently shows main's own error text. If a fixed string is preferred: `ollama.settings.pullBusy` en "Another download is running. Try again when it finishes." / zh "另一个下载正在进行，完成后再试。"
