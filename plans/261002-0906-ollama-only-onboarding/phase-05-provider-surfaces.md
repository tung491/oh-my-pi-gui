# Phase 5 — Ollama-only provider surfaces

Parallel with phases 2, 3 and 4.

## File ownership

Edits `src/renderer/components/settings/ProvidersWindow.tsx`, `settings/providers/ProviderConfigRow.tsx`, `settings/ModelRolesWindow.tsx`, `settings/ModelValueSelect.tsx`, `settings/SettingsWindow.tsx`, `dialogs/ModelPicker.tsx`, `dialogs/BenchmarkDialog.tsx`, `dialogs/CommandPalette.tsx`, `lib/command-registry.ts`, `lib/provider-login.ts`, `layout/Sidebar.tsx`, the model store that fills `availableModels` (find it with `grep -rn "availableModels" src/renderer/stores`), excluding `stores/ui.ts`, and their existing tests.
Does **not** edit `ProviderConfigDialog.tsx`, `FormFields.tsx` or `ModelEditor.tsx`. They become unreachable, and phase 6 deletes them.

## Requirements

1. **Model source of truth**: filter `availableModels` once, at the store boundary where `get_available_models` results land, with `filterAllowedModels`. ModelPicker, ModelRolesWindow, ModelValueSelect and BenchmarkDialog then inherit it. Add a direct filter only where a surface calls RPC itself (ModelPicker's `getLoginProviders`).
2. **ProvidersWindow → "Ollama" window** (keep the file and the `openProviders` action so every entry point still works):
   - A status card reusing phase 1's `OllamaRow` (import only), showing the endpoint read-only (`ollama.status().baseUrl`).
   - The installed-model list from `installedTags`, each with "Use as default".
   - A "Pull a model" input (tag) + Pull button with `PullBar`.
   - "Run setup again" → `openWelcome()`.
   - Remove login/logout buttons, the custom-provider "Add" button, and the `openProviderConfig` entry.
3. **ModelPicker**: drop provider grouping headers and the login annotations. When there are no models, show "No local models yet" + "Open Ollama settings" (→ `openProviders`).
4. **Command palette / registry**: rename "Providers & Login" to "Ollama", and remove the `login` / `logout` / `provider config` commands (`command-registry.ts:919` and siblings). Slash commands typed by hand still reach the agent unchanged, which is out of GUI scope.
5. **provider-login.ts**: delete `loginProvider` if nothing else imports it after the edits above. Otherwise guard it with `isAllowedProvider` and throw for any other id.
6. **Sidebar / SettingsWindow**: relabel the provider entries to "Ollama" (keys from phase 1).

## Validation

- Update the existing tests of the touched files. Add a ModelPicker test where models from `anthropic` and `ollama` both arrive and only `ollama` renders.
- `grep -rn "openProviderConfig\|loginProvider" src/renderer` returns no live call sites outside the files phase 6 deletes.
- `bunx vitest run src/renderer/components/settings src/renderer/components/dialogs/ModelPicker* src/renderer/lib`, `bun run check:types`.
