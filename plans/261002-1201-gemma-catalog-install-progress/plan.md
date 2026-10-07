---
title: "Gemma-only model suggestions and Linux install progress"
description: "Port sai-welcome's model-suggestion rules with its three Gemma 4 rows, and stream the Linux Ollama installer's progress into the welcome screen and Settings."
status: completed
priority: P1
effort: 1.5d
branch: feat/gemma-catalog-install-progress
tags: [onboarding, main-process, frontend]
blockedBy: []
blocks: []
created: 2026-10-02
---

# Gemma-only model suggestions and Linux install progress

## Outcome

1. **Install progress.** On Linux, "Install Ollama" shows live progress instead of a
   bare spinner. The bar is indeterminate while polkit asks for the password, then
   shows each installer stage (`>>> Downloading …`, `>>> Installing …`). It shows a
   percentage while curl downloads, and it disappears when the install ends. The
   welcome screen and Settings › Ollama both show it.
2. **Model suggestions.** The welcome screen suggests models with sai-welcome's
   rules (`welcome-rs/welcome-core/src/modelfit`), drawn from Gemma alone: the three
   QAT 4-bit Gemma 4 rows sai-welcome ships.

## Decisions (user-confirmed 2026-10-02)

| Topic | Decision |
|---|---|
| Catalog | sai-welcome's `hf.co` refs: `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf`, `…-E4B-…` (sai-welcome's `DEFAULT_MODEL`), `…-26B-A4B-…` |
| Sizing rules | Port sai-welcome exactly (need, fit, speed, tiers, collapse) |
| Small machines | Loosen: when nothing fits, offer the smallest Gemma row as a minimal card, flagged as a tight fit and slow, provided RAM exceeds its download size |
| Install cancel | No cancel button. A root child of `pkexec` cannot be stopped safely from the GUI |

## Verified facts (2026-10-02)

- sai-welcome `origin/main` is `f22c541`, the same as the local copy at `/tmp/claude-1000/-home-tung491-WORK-oh-my-pi-gui/f36727c1-c49d-4152-98b6-044f2a25ba59/scratchpad/sai-welcome`. Any phase that cites `welcome-rs/…` means that tree.
- Memory need: `ceil(size × 102/100) + 4_563_402_752` (`modelfit/need.rs`). There is **no** separate KV-cache term; the fixed 4.25 GiB covers runtime and context.
- Fit (`modelfit/class.rs:62`): `vramBudget = vram − 1 GiB`, `ramBudget = ram − max(ram/4, 4 GiB)`. Vram if `vramBudget > 0 && need ≤ vramBudget`. Otherwise ram if there is no VRAM budget and need fits the RAM budget, else offload if need fits the RAM budget, else none.
- Speed (`class.rs:95`, unmeasured path): vram → fast. Ram or offload → moderate if `activeB ≤ 9.0` and `min(threads, 16) ≥ 8`, else slow.
- Tiers (`modelfit/sizing.rs:150-218`):
  - The pool is rows that fit with `paramsB ≥ 3.0`, sorted by params descending, then quant rank descending, then repo.
  - Maximum is `pool[0]`.
  - Recommended is the first vram row, else the first row that isn't slow, else none (status `recommended-omitted`).
  - Minimal is the row with the smallest need.
  - Rows are collapsed to one card per ref, never padded to three.
- Unified memory: sai-welcome counts integrated graphics as RAM only (`modelfit/envelope.rs:53`). There is no Apple-unified VRAM path.
- Install matching (`welcome-core/tests/llm_tags.rs:102-134`): case-insensitive. An exact `name:tag` matches, a bare name matches any tag at the `:` boundary, and blank input matches nothing. Ollama lists an `hf.co/...` pull as `hf.co/...:latest`.
- Gemma rows (from `welcome-core/assets/hfmodels.json.gz`, fetched 2026-08-27):
  - E2B: 3,349,516,256 bytes, 5.1B params, 2.3B active
  - E4B: 5,154,941,280 bytes, 8B params, 4.5B active
  - 26B-A4B: 14,439,363,584 bytes, 25.2B params, 3.8B active
  - None of the files end in `-q4_0.gguf`, so each ref carries no quant tag (`hfindex/model.rs:69-90`).
- Installer output (`https://ollama.com/install.sh`, fetched 2026-10-02):
  - Stage lines are `status()`, which runs `echo ">>> $*" >&2` (line 14).
  - Downloads use `curl --progress-bar` (lines 72, 146, 154).
  - I checked locally that curl draws the bar into a **pipe** as `\r`-separated frames: `\r#=#=#` while the total is unknown, then `###…  45.2%`.
- The agent resolves `ollama/hf.co/google/…` on the first `/` (`packages/coding-agent/src/config/model-resolver.ts:707`), so provider `ollama` gets id `hf.co/google/…`.
- The GUI's `isValidModelTag` already accepts `/` and `.` (`src/main/ollama/pull.ts:18`).

## Constraints

- Agent code is not changed.
- Strings go to `en.ts` and `vi.ts` (main's current locale pair; `locales.test.ts`).
- The privileged command set stays closed. Progress is read-only output; the renderer still sends only a remedy id.
- Tests use the linkedom harness and injected seams. No `mock.module()`.

## Non-goals

- Bandwidth measurement or calibrated tok/s (sai-welcome's measured path).
- sai-welcome's GPU VRAM table (`gpuvram_table.json`). We keep `nvidia-smi` as the VRAM source.
- Cancelling an install in progress.
- Removing installed non-Gemma models. They stay usable in the picker.

## Phases

| # | Phase | Runs | Depends on | Status |
|---|---|---|---|---|
| 1 | [Contracts and copy](phase-01-contracts-copy.md) | sequential | none | completed |
| 2 | [Install progress in main](phase-02-install-progress-main.md) | parallel | 1 | completed |
| 3 | [sai-welcome sizing port with Gemma catalog](phase-03-gemma-sizing-port.md) | parallel | 1 | completed |
| 4 | [Install progress UI](phase-04-install-progress-ui.md) | parallel | 1 | completed |
| 5 | [Integration and verification](phase-05-integration-verification.md) | sequential | 2, 3, 4 | completed |

Phases 2 to 4 own disjoint files and meet only at the contracts phase 1 freezes.

## Acceptance criteria

1. On Linux with Ollama absent, pressing Install shows an indeterminate bar until the first installer output arrives. Then it shows the current `>>>` stage text, and a percentage during each download. The bar resets per download and is gone when the remedy result arrives. The welcome screen and the Settings › Ollama window both show the same run.
2. A machine with 16 GiB RAM, no GPU and 8 threads gets E2B (minimal) and E4B (recommended + maximum).
3. A machine with 32 GiB RAM and no GPU gets E2B (minimal) and 26B-A4B (recommended + maximum).
4. A machine with 16 GiB RAM and a 12 GiB GPU gets E2B (minimal) and E4B (recommended + maximum, fast).
5. A machine with 8 GiB RAM gets one E2B card marked as a tight fit and slow. A 2 GiB machine gets the "not enough memory" message.
6. A machine with 16 GiB RAM and 4 threads gets E2B (minimal) and E4B (maximum) with no recommended card.
7. An installed `hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest` marks the E4B card as installed. Continue sets `ollama/hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest`, using the tag Ollama lists, and the agent accepts it.
8. `bunx vitest run`, `bun run check:types`, `bunx biome check <touched files>`, `bun run build`, and `e2e/onboarding.e2e.ts` + `e2e/desktop.e2e.ts` pass.
