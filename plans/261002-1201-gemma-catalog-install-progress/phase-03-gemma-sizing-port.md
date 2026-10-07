---
phase: 3
title: "sai-welcome sizing port with Gemma catalog"
status: completed
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 3: sai-welcome sizing port with Gemma catalog

## Goal
Replace the qwen/gpt-oss catalog and the current rules in `chooseModels` with sai-welcome's unmeasured sizing rules over its three Gemma 4 rows, plus the user's small-machine fallback and sai-welcome's install matching.

## Files to Create / Modify
- Modify: `src/shared/ollama-catalog.ts` (+ `ollama-catalog.test.ts`, rewritten table tests)
- Modify: `src/renderer/components/onboarding/ModelCard.tsx` (+ test): render `activeParams` and the `tight` note. This file is display-only, and phase 4 does not touch it.
- Read-only references (sai-welcome tree at the path in plan.md): `welcome-rs/welcome-core/src/modelfit/{need,class,sizing,quality}.rs`, `src/backend/models.rs:214-257`, `tests/llm_tags.rs:102-134`.

## Tasks & Steps
1. **Catalog**: `OLLAMA_CATALOG` becomes three entries `{ tag, label, params, activeParams, sizeBytes, quantRank }`:
   - `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf`, "Gemma 4 E2B", params 5.1, active 2.3, size 3_349_516_256
   - `hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf`, "Gemma 4 E4B", params 8, active 4.5, size 5_154_941_280
   - `hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf`, "Gemma 4 26B A4B", params 25.2, active 3.8, size 14_439_363_584

   All three are Q4_0, with quant rank 10. Add a comment citing sai-welcome `assets/hfmodels.json.gz` (fetched 2026-08-27) and `SUGGEST_FAMILIES = ["gemma"]`. Drop `contextTokens` and the KV constant.
2. **Rules**: port as pure functions, with constants named as in sai-welcome.
   - `needBytes = ceil(size × 102 / 100) + 4_563_402_752`
   - `fitOf(need, machine)`: the `class.rs:62` rule, with `vram = machine.vramBytes ?? 0`. `unifiedMemory` contributes no VRAM, because sai-welcome counts integrated and unified memory as RAM.
   - `speedOf(fit, activeParams, threads)`: the `class.rs:95` rule (`CPU_ACTIVE_BUDGET = 9.0`, `CPU_THREAD_FLOOR = 8`, `CPU_THREAD_PLATEAU = 16`).
   - Tiers: the `sizing.rs:150-218` rule, with `MIN_PARAMS_B = 3.0`.
     - The pool is sorted by params descending, then quant rank descending, then tag ascending.
     - Maximum is `pool[0]`. Recommended is the first vram row, else the first row that isn't slow, else omitted, with `status: "recommended-omitted"`. Minimal is the row with the smallest need, ties broken by pool order.
     - Collapse to one card per tag, with tiers in `MODEL_TIERS` order, never padded.
3. **Small-machine fallback** (user decision): when the pool is empty, the machine is readable, and `machine.ramBytes > smallest.sizeBytes`, return one card for the smallest-need row with `tiers: ["minimal"]`, `fit: "ram"`, `speed: "slow"` and `tight: true`. Otherwise keep `emptyReason: "too-small"`. A `null` machine still gives `"unreadable"`.
4. **Install matching**: `isInstalled(installedTags, tag)` follows `llm_tags.rs`. It is case-insensitive; an exact `name:tag` matches, a bare `tag` matches `tag:<anything>`, and blank input matches nothing. `ModelChoice.tag` is the **installed** listing when one matches (for example `…-gguf:latest`), so Continue sets the exact id the agent's Ollama discovery reports; otherwise it is the catalog ref.
5. **ModelCard**: show "Active per token" (`welcome.card.active`) next to Parameters, and the `welcome.card.tight` note in a warning tone when `tight` is set.

## Verification
- `bunx vitest run src/shared/ollama-catalog.test.ts src/renderer/components/onboarding` passes. The table tests are hand-checked against the rules (see plan.md acceptance criteria 2–6):
  - 16 GiB, no GPU, 8 threads: E2B minimal; E4B recommended + maximum
  - 32 GiB, no GPU, 8 threads: E2B minimal; 26B recommended + maximum
  - 16 GiB + 12 GiB VRAM: E2B minimal; E4B recommended + maximum, fast
  - 64 GiB + 24 GiB VRAM, 16 threads: E2B minimal; 26B recommended + maximum, fast
  - 16 GiB, 4 threads: E2B minimal; E4B maximum; no recommended card; `status` is `"recommended-omitted"`
  - 8 GiB: one E2B card, `tight`, slow. 2 GiB: `emptyReason` is `"too-small"`. `null`: `"unreadable"`.
  - Install matching: `hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest` installed marks E4B installed and the card tag carries `:latest`; `HF.CO/…` matches case-insensitively; `gemma` does not match `gemma-2:9b`.
- `bun run check:types` passes, and `bunx biome check` passes on the touched files.
