---
phase: 1
title: "Contracts and copy"
status: completed
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Contracts and copy

## Goal
Freeze the wire types, the IPC event, the preload binding and the locale keys that phases 2 to 4 compile against.

## Files to Create / Modify
- Modify: `src/shared/ollama-types.ts` (types only)
- Modify: `src/shared/ipc-types.ts`: add `IPC_EVENTS.OLLAMA_INSTALL_PROGRESS = "ollama:install-progress"` and `OmpApi.ollama.onInstallProgress`.
- Modify: `src/preload/index.ts`: binding only, following the `onPullProgress` pattern in the same `ollama` block.
- Modify: `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`: add keys only.

## Tasks & Steps
1. In `ollama-types.ts`:
   - `MachineFacts` gains `threads: number`. This is the logical CPU count, at least 1, and sai-welcome's speed rule needs it.
   - `ModelChoice` gains `activeParams: number` (billions active per token) and `tight: boolean`. `tight` is true only for the small-machine fallback card.
   - Add `ModelScreen.status?: "ok" | "recommended-omitted"`, matching sai-welcome's `ModelStatus`. `emptyReason` stays as it is.
   - Add:
     ```ts
     export interface OllamaInstallProgress {
       /** Latest `>>> …` stage text from the installer, without the `>>> ` prefix; null before the first one. */
       stage: string | null;
       /** 0–100 for the current download; -1 while no percentage is known (polkit dialog, non-download stage). */
       percent: number;
       /** True on the final frame, sent just before the remedy result resolves. */
       done: boolean;
     }
     ```
2. Add the IPC event and `onInstallProgress(cb: (p: OllamaInstallProgress) => void): () => void` to `OmpApi.ollama` and to the preload binding.
3. Add the locale keys to both `en.ts` and `vi.ts`, using real Vietnamese:
   - `welcome.install.waiting`: "Waiting for authorization…"
   - `welcome.install.stage`: "{stage}"
   - `welcome.install.percent`: "{percent}%"
   - `welcome.install.note`: "Installing Ollama. This can take a few minutes."
   - `welcome.card.tight`: "Tight fit: this machine may slow down while the model runs."
   - `welcome.card.active`: "Active per token"

   `welcome.install.stage` stays a pass-through because the installer's text is English. Allowlist it in `locales.test.ts` if the identical-value rule applies to its namespace.

## Verification
- `bun run check:types` passes, with the new fields optional or defaulted wherever producers don't fill them yet. Phases 3 and 2 make them required in their own files. If a field must be required now, add it with a temporary producer value in the single place it is built (`chooseModels` / `readMachine`), and note it for phase 3 or 2 to replace.
- `bunx vitest run src/renderer/locales` passes.
- `bunx biome check` on the touched files passes.

## Failure handling
If parity or type checks fail after a genuine fix attempt, stop and report the exact command and output. Never weaken `locales.test.ts`.
