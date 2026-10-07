---
title: Plan Gemma-only suggestions and Linux install progress
date: 2026-10-02
summary: Planned sai-welcome sizing port over three hf.co Gemma 4 QAT rows plus streamed Linux Ollama install progress; three scout claims corrected against source.
---

# Plan Gemma-only suggestions and Linux install progress

**Date**: 2026-10-02 12:09 (Asia/Seoul)
**Severity**: Medium
**Component**: Onboarding (welcome screen, Settings › Ollama), `src/shared/ollama-catalog.ts`, `src/main/ollama/remedy.ts`
**Status**: Planned — `plans/261002-1201-gemma-catalog-install-progress/`, nothing implemented

## What Happened
Two requests: (1) Linux "Install Ollama" shows a bare spinner while `pkexec` runs `install.sh` for minutes — show real progress; (2) suggest models with sai-welcome's `modelfit` rules, Gemma only.

## Decisions
- Catalog: sai-welcome's `hf.co/google/gemma-4-{E2B,E4B,26B-A4B}-it-qat-q4_0-gguf`. qwen/gpt-oss rows go away.
- Port sai-welcome sizing exactly (need, fit, speed, tiers, collapse). We considered tuning our own rules and rejected it, because two diverging recommenders is how drift starts.
- Small-machine fallback: when nothing fits but RAM > E2B's download size, show one E2B card flagged tight + slow. Below that we still show "too small".
- No install cancel. Killing a root child of `pkexec` from the GUI is not safe, so it ships without a button.

## The Brutal Truth
The first scout pass was wrong on three load-bearing points. Any one of them would have produced a recommender that disagrees with sai-welcome on real machines. Each was caught only by reading the Rust, not the summary:
- **Need has no KV term.** It is `ceil(size*1.02) + 4.25 GiB` (`4_563_402_752`, `modelfit/need.rs`). The fixed constant covers runtime and context, so the old `contextTokens`/KV constant gets deleted.
- **Quality order is params desc first**, then quant rank, then repo (`sizing.rs:150-218`). Maximum is `pool[0]`.
- **curl `--progress-bar` does write `\r` frames into a pipe.** We checked locally: `#=#=#` while the total is unknown, then `###  45.2%`. So percentage parsing from stderr is viable.

## Open Risk
Tool calling through `hf.co/...` GGUF imports is unproven. Ollama may not attach Gemma's tool template to a raw HF pull. If it doesn't, the agent loses tools on the recommended model, and sizing math won't reveal that.

## Lessons
Verify scout claims against source line refs before freezing contracts. A plausible paraphrase ("need includes KV cache") cost nothing to check and would have been expensive to ship.

## Next Steps
- Implement phases 1-5 on `feat/gemma-catalog-install-progress`.
- Phase 5: run one live tool call against `ollama/hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest` before merge. If tools fail, stop and escalate the catalog decision to the user.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
