# Phase 3 report: sai-welcome sizing port with Gemma catalog

Status: completed. All phase 3 verification cases pass. Typecheck and biome are clean on the touched files.

## Files
- `src/shared/ollama-catalog.ts`: rewritten. It holds the three Gemma 4 rows (`quantRank` 10, bare `hf.co` refs) and ports `need.rs`, `class.rs` (fit and speed), `quality.rs` (the 3B floor and the quality order) and `sizing.rs` (tiers and collapse) using sai-welcome's constant names. It adds the small-machine fallback and `isInstalled`, which follows `llm/tags.rs`.
- `src/shared/ollama-catalog.test.ts`: rewritten table tests (24).
- `src/renderer/components/onboarding/ModelCard.tsx`: adds an "Active per token" row and a `welcome.card.tight` note in `--omp-warning`. The skeleton now has 6 rows. welcome-screen.css is unchanged.
- `src/renderer/components/onboarding/ModelCard.test.tsx`: updated the specs assertion and added a tight-note test.

## Public API changes
- `needBytes(sizeBytes: number)` now takes bytes, not an entry. `speedOf(fit, activeParams, threads)` takes a third argument.
- `OllamaCatalogEntry` drops `contextTokens` and adds `activeParams` and `quantRank`. The new export is `isInstalled(installedTags, tag)`.
- The only production caller is `src/main/ollama/register-ipc.ts` (`chooseModels(machine, OLLAMA_CATALOG, ...)`). Its signature is unchanged, so it still compiles. No e2e file references these exports or the old qwen tags.

## Behaviour decisions
- `ModelChoice.tag` is the name Ollama lists when one matches, kept verbatim with its case. Otherwise it is the ref with `:latest` appended, unless the last path segment already has a tag. `OLLAMA_CATALOG` keeps the bare refs.
- `status` is set on every non-empty screen: `"ok"` or `"recommended-omitted"`. The tight fallback card also reports `"recommended-omitted"`, because it has no recommended tier.
- The fallback runs only when no row fits at all. If rows fit but all fall under the 3B floor, the screen gives `emptyReason: "too-small"`. This mirrors sai-welcome's split between BELOW_FLOOR and ENVELOPE. It cannot happen with the Gemma catalog.

## Verification
- `bunx vitest run src/shared/ollama-catalog.test.ts src/renderer/components/onboarding`: 51/51 pass.
- `bun run check:types`: clean.
- `bunx biome check` on the 4 files: clean.
- A wider run outside my ownership found two failures, both in install-progress work in progress by other phases:
  - `src/main/ollama/remedy.test.ts` ("stops the command with SIGTERM…") timed out.
  - `FirstRunOnboardingDialog.test.tsx` ("streams install progress…") failed.

## For phase 5
- `FirstRunOnboardingDialog.test.tsx` still uses qwen fixture tags. That is harmless, because it builds `ModelChoice` objects directly.
- Check acceptance criterion 7 end to end: Continue should send the `:latest` id.
