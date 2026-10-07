---
title: Plan Ollama-only onboarding
date: 2026-10-02
summary: "Planned the port of sai-welcome's one-screen Ollama onboarding and the removal of every non-Ollama provider"
---

# Plan Ollama-only onboarding

## What happened
Scouted sai-welcome (welcome-rs frontend, retired Go backend) and this repo's onboarding and provider surfaces. Wrote `plans/261002-0906-ollama-only-onboarding/` with 6 phases. Phase 1 freezes the contracts, the bundled catalog, the shared OllamaRow/PullBar components and the locale keys. Phases 2 to 5 (main Ollama service, provider cleanup, welcome screen, provider surfaces) own disjoint files and run in parallel. Phase 6 integrates and verifies.

## Decision
- One screen like sai-welcome, not a wizard.
- Destructive cleanup (user choice): `logout` RPC for non-Ollama OAuth providers, and non-Ollama entries deleted from `models.yml`, only after a verified `models.yml.bak-<ts>` backup.
- Linux pkexec remedies (install, start); a download link on macOS and Windows.
- A curated catalog bundled in the app, sized against RAM and VRAM.
- The agent is unchanged: it already discovers Ollama implicitly (`model-discovery.ts:126`).

## Next steps
Confirm catalog sizes with `ollama show`, then `/ak:cook plans/261002-0906-ollama-only-onboarding/plan.md --parallel`. Screens: https://claude.ai/artifact/3qvG5mQEtFocjF3dXydWd7

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
