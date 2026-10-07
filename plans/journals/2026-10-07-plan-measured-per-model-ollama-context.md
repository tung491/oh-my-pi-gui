---
title: "Plan: measured per-model Ollama context"
date: 2026-10-07
summary: "Planned load-and-search context sizing per Ollama model with a user cap, sent via patch 0005"
---

# Plan: measured per-model Ollama context

## What happened
Commit 4986122 set a global OLLAMA_CONTEXT_LENGTH=131072 for every local model. KV cost per token differs about 25x between models (research-261007-1853), so 128k can spill a dense model off the GPU. Ollama offloads to the CPU instead of failing, so too large a context shows up as a slowdown or as RAM pressure, not as an error.

## Decision
- Per-model limits through a new sidecar patch 0005, `PI_OLLAMA_CONTEXT_LIMITS` (a JSON map of tag to num_ctx), looked up in the ollama-chat cap in model-registry.ts.
- Measurement is a full load-and-search over the 2x ladder from 8k to the trained context. The fit test is /api/ps `size_vram >= size` on a GPU, or `size` within the catalog RAM budget without one. A binary search gives the same result as walking every rung.
- The user cap is clamped to at most the measured max. Results are stored in the single prefs key `ollamaContextFit`, because tags contain dots.
- Triggers: the Measure button, after a pull, and at startup when a model is unmeasured or the hardware fingerprint changed. Measurement runs only when every tab is idle.

## Next steps
Plan: plans/261007-1948-ollama-context-fit/plan.md (5 phases). Commit the pending attachment work before phase 3.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
