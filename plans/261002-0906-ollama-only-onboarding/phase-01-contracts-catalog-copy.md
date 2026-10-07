# Phase 1 — Contracts, catalog and copy

Sequential. It must merge before phases 2 to 5 start, because they all compile against it.

## File ownership

Creates: `src/shared/ollama-types.ts`, `src/shared/ollama-catalog.ts` (+ `.test.ts`),
`src/shared/provider-policy.ts` (+ `.test.ts`), and the two presentational components both phase 4 and phase 5 render: `src/renderer/components/onboarding/OllamaRow.tsx` and `PullBar.tsx` (+ tests), styled in `src/renderer/components/onboarding/onboarding.css`.
Edits `src/renderer/stores/ui.ts`, adding `welcomeOpen` / `openWelcome()` / `closeWelcome()` and nothing else.
Edits: `src/shared/ipc-types.ts` (channel constants only), `src/preload/index.ts`
(bindings only), `src/renderer/locales/en.ts`, `src/renderer/locales/zh.ts` (add keys only, delete nothing).

## Requirements

1. **`ollama-types.ts`**: the wire types between main and renderer, mirroring sai-welcome's `OllamaStatus` / `ModelScreen` / `PullProgress`:
   - `OllamaState = "ok" | "stopped" | "absent"`; `OllamaStatus { state; baseUrl; version?; modelCount; installedTags: string[]; platform: NodeJS.Platform; remedy: OllamaRemedyId | null; fault?: string }`.
   - `OllamaRemedyId = "linux-start" | "linux-install"` (closed set). `OLLAMA_REMEDY_COMMANDS: Record<OllamaRemedyId, string>` holds the display text only (`systemctl start ollama.service`, `curl -fsSL https://ollama.com/install.sh | sh`).
   - `MachineFacts { ramBytes; vramBytes: number | null; gpuName: string | null; unifiedMemory: boolean }`.
   - `ModelTier = "minimal" | "recommended" | "maximum"`; `ModelChoice { tag; label; params; sizeBytes; needBytes; fit: "vram" | "ram" | "offload"; speed: "fast" | "moderate" | "slow"; tiers: ModelTier[]; installed: boolean | null }`.
   - `ModelScreen { machine: MachineFacts | null; choices: ModelChoice[]; emptyReason?: "too-small" | "unreadable" }`.
   - `PullProgress { tag; status; completed; total; percent /* -1 = indeterminate, capped at 99 until done */; done; error? }`.
2. **`ollama-catalog.ts`**: an ordered list of `{ tag, label, params, sizeBytes, contextTokens }` for tool-calling models (start with `qwen3:4b`, `qwen3:8b`, `qwen3:14b`, `gpt-oss:20b`, `qwen3:30b`). Confirm each `sizeBytes` with `ollama show` or the library page. Add the pure function `chooseModels(machine, catalog, installedTags): ModelScreen`, ported from `welcome/backend/models.go` (`Suggest` / `statusMessage`):
   - `needBytes = sizeBytes × 1.2 + KV cache at contextTokens` (document the constant).
   - fit: `vram` if needBytes ≤ VRAM (or unified memory ≤ 75% of RAM); `offload` if needBytes ≤ VRAM + 60% RAM; `ram` if needBytes ≤ 60% RAM; otherwise it does not fit.
   - speed: vram→fast, offload→moderate, ram→slow (≥14B on ram→slow, smaller→moderate).
   - minimal = smallest that fits; maximum = largest that fits; recommended = the largest with speed ≠ slow, else minimal. Merge tiers when two of them land on the same model (cards = distinct tags, at most 3).
   - `machine === null` gives `emptyReason: "unreadable"`; nothing fits gives `"too-small"`.
3. **`provider-policy.ts`**: `ALLOWED_PROVIDER_IDS = ["ollama"] as const`, `isAllowedProvider(id)`, `filterAllowedModels<T extends { provider: string }>(models)`. Every surface filters through this, so re-enabling a provider later is a one-line change.
4. **IPC channels** in `IPC_COMMANDS`: `OLLAMA_STATUS`, `OLLAMA_MODEL_SCREEN`, `OLLAMA_PULL`, `OLLAMA_PULL_CANCEL`, `OLLAMA_WARM`, `OLLAMA_REMEDY`, `OLLAMA_OPEN_DOWNLOAD`, `PROVIDER_CLEANUP_CONFIG`. Event channel: `OLLAMA_PULL_PROGRESS`.
5. **Preload** `window.omp.ollama = { status(), modelScreen(), pull(tag), cancelPull(), warm(tag), runRemedy(id), openDownload(), onPullProgress(cb) => unsubscribe }` and `window.omp.providerCleanup = { cleanConfig(): Promise<{ backupPath: string | null; removed: string[] }> }`. Follow the existing `models:` block pattern at `src/preload/index.ts:329`.
6. **Locale keys** (en + zh, same keys), namespace `welcome.*` for the screen and `ollama.*` for settings. The copy follows sai-welcome:
   - `welcome.title` "Set up your local assistant" (the header shows the Sai ATLAS lockup image, never the name as live text), `welcome.subtitle` "This machine can run an AI assistant locally, with nothing leaving the computer."
   - `welcome.reading` "Reading this machine…", `welcome.fact.memory|graphics|graphicsNone|unified`
   - `welcome.ollama.running` "Ollama is running ({count} models)", `welcome.ollama.stopped.linux` "Ollama is installed but not answering. Starting its service should be enough.", `welcome.ollama.stopped.other` "Ollama is installed but not running. Open the Ollama app, then check again.", `welcome.ollama.absent` "Ollama is not installed on this machine. It is what runs the local AI model.", `welcome.ollama.installNote` "This downloads and runs Ollama's own installer as root. You will be asked to authorize it.", `welcome.ollama.start|install|checkAgain|openDownload`
   - `welcome.tier.minimal|recommended|maximum`, `welcome.card.params|download|needs|runsIn|speed|fit.vram|fit.ram|fit.offload|speed.fast|speed.moderate|speed.slow`
   - `welcome.card.installed` "On this machine, ready to use", `welcome.card.notInstalled` "Not downloaded yet.", `welcome.card.installUnknown` "Already downloaded? Unknown — Ollama did not answer.", `welcome.card.use` "Use this model", `welcome.card.download`, `welcome.card.cancel`, `welcome.card.starting` "Starting download…"
   - `welcome.empty.tooSmall`, `welcome.empty.unreadable`, `welcome.continue` "Continue to the assistant", `welcome.skip` "Set up later", `welcome.pickHeading` "Pick a model for this machine", `welcome.footNote` "{tag} becomes your default model. Change it any time in Settings › Ollama."
   - `ollama.settings.title|endpoint|models|pullPlaceholder|pull|refresh|runSetup`, `providers.cleanup.showFile`, `providers.cleanup.dismiss`, `providers.cleanup.notice` "Sai ATLAS now runs on local models through Ollama. Other providers were signed out, and your previous model config was saved to {path}."

7. **OllamaRow** `{ status: OllamaStatus | null; busy: OllamaRemedyId | null; onRemedy(id); onCheckAgain(); onOpenDownload() }`. Pure props, no IPC. States and copy follow the keys above: `ok` = success tone + count; `stopped`/`absent` = warn/error tone + message + the command in a mono block (Linux only) + the remedy button + "Open ollama.com/download" + "Check again". While a remedy runs (`busy`), its button shows a spinner and the others are disabled.
8. **PullBar** `{ progress: PullProgress | null; onCancel() }`: striped indeterminate (`percent === -1`), then percent with status text, then hidden when `done`. Respects `prefers-reduced-motion`. Only `--omp-*` tokens.

## Validation

- `bunx vitest run src/shared/ollama-catalog.test.ts src/shared/provider-policy.test.ts`. Table tests cover: 8 GB RAM no GPU → only 4b (minimal+recommended+maximum merged); 16 GB RAM + 12 GB VRAM → 4b / 14b / 20b; 32 GB unified Mac; unreadable machine; nothing fits.
- `bun run check:types`, `bunx vitest run src/renderer/locales` (key parity).

## Risk

Catalog sizes go stale as Ollama retags. They are only used for sizing, so a stale size never blocks a pull.
