# Phase 1 report: contracts, catalog and copy

Status: done with one spec discrepancy (recommended-tier rule). Not committed.

## Files
- Created: `src/shared/ollama-types.ts`, `src/shared/ollama-catalog.ts` (+ test), `src/shared/provider-policy.ts` (+ test),
  `src/renderer/components/onboarding/{OllamaRow,PullBar}.tsx` (+ tests), `src/renderer/components/onboarding/onboarding.css`.
- Edited (additions only): `src/shared/ipc-types.ts` (constants + `OmpApi.ollama` / `OmpApi.providerCleanup` typing, which lives here),
  `src/preload/index.ts`, `src/renderer/stores/ui.ts` (`welcomeOpen`, `openWelcome`, `closeWelcome`; the store has no `reset()`),
  `src/renderer/locales/en.ts`, `src/renderer/locales/zh.ts` (53 keys each).

## Catalog
Sizes from ollama.com library tag pages, read 2026-10-02 (ollama not installed locally): qwen3:4b 2.5 GB, qwen3:8b 5.2 GB,
qwen3:14b 9.3 GB, gpt-oss:20b 14 GB, qwen3:30b 19 GB. contextTokens = 8192 (sai-welcome `modelfit.CtxAssumed`).
KV cache = 163,840 B/token (f16 Qwen3 14B, the largest in the catalog), so need = size x 1.2 + 1.34 GB.

## Discrepancy
The phase file says recommended = "largest with speed != slow". With that rule, 16 GB RAM + 12 GB VRAM picks gpt-oss:20b
(offload, moderate) and the listed expectation 4b / 14b / 20b cannot hold. sai-welcome's `Suggest` (core/modelfit/suggest.go)
picks the largest **VRAM-fit** row first, then falls back to largest non-slow. Implemented the source's rule, falling back to
minimal at the end; all five listed scenarios pass with it.

## Wire payloads for phase 2
`ollama:pull` `{ tag }` -> PullProgress (final frame); `ollama:warm` `{ tag }`; `ollama:remedy` `{ id }` -> OllamaStatus;
others take no payload. Event `ollama:pull-progress` carries a bare PullProgress.

## Verification
Focused vitest (36 tests), full vitest (188 files / 1699 tests), `bun run check:types`, `bunx biome check` on touched files,
and `bun run build` all pass.
