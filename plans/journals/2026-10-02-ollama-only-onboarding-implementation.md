---
title: Ollama-only onboarding implementation
date: 2026-10-02
summary: Built the Ollama-only provider and the sai-welcome one-screen onboarding; review caught a set_model race the e2e fixture had hidden
---

# Ollama-only onboarding implementation

**Date**: 2026-10-02 10:50 (Asia/Seoul)
**Severity**: High (one merge-blocking happy-path bug, caught before commit)
**Component**: onboarding, provider surfaces, models.yml migration
**Status**: Implemented, uncommitted (worktree `oh-my-pi-gui-feat-ollama-only-onboarding`, branch `feat/ollama-only-onboarding`)

## What happened
- Built plan `plans/261002-0906-ollama-only-onboarding/`. The five-step wizard is replaced by sai-welcome's single screen: machine facts, an Ollama status row with a remedy (Linux uses `pkexec` install/start, macOS and Windows get a download link plus "Check again"), and minimal/recommended/maximum model cards with pull progress.
- Ollama is the only provider the GUI shows anywhere. The store's `filterAllowedModels` is the single filter point.
- A one-time cleanup migration (`providers.cleanupVersion`) signs out non-Ollama OAuth providers and removes non-Ollama entries from `models.yml`, after writing a verified `models.yml.bak-<ts>`.
- The models.yml write IPC and the provider config dialogs were deleted. 218 dead locale keys were removed.
- How it ran: phase 1 (contracts, catalog, copy) ran alone. Phases 2-5 own separate files and ran in parallel. Phase 6 was split into A (fixes from the advisory checkpoint) and B (integration, e2e, docs), followed by a final code review and a fix pass. Gates: vitest 1819/1819, types, biome on touched files, build, `onboarding.e2e.ts` and `desktop.e2e.ts` (22 passed).

## The Brutal Truth
The worst bug got past every green gate. On the real agent, clicking Continue right after an on-screen download failed with `Model not found: ollama/qwen3:8b`. The e2e was green only because `e2e/sidecar-fixture.ts` accepted any `set_model`. The test proved the GUI sent the RPC, not that a real agent would accept it. We only found it because the reviewer read `rpc-mode.ts` instead of trusting the fixture.

## Technical Details / Lessons
- **The agent never marks implicit keyless Ollama as authenticated.** Code that checked for auth treated Ollama as unusable. ModelCompare blocked every row with `no-auth`, and the welcome screen's usable-model check never passed. Fix: drop the auth-based reason and decide usability from the provider allow-list plus the disabled state. Lesson: an implicit provider is not a logged-in provider.
- **`set_model` only awaits a catalog refresh that is already running** (`model-registry.ts:583`). It does not start a new one. Ollama discovery ran when the sidecar started, before the pull, so the new tag was unknown. Fix: `await refreshAvailableModels(true)` before `setModel`, and also once a pull finishes. The fixture now reads `/api/tags` only on forced refreshes and rejects unknown models with the agent's exact error message. Negative check: removing the awaited refresh now fails the e2e.
- **Back up only after every edit that can fail.** The first version wrote the backup and then edited the YAML, so a YAML alias (`providers: *p`) could throw after the backup existed. New order: parse, delete in the document, render, back up (`COPYFILE_EXCL` plus a size check), write a temp file, rename.
- **The spec's recommended-tier rule contradicted its own example.** "Largest with speed != slow" picks `gpt-oss:20b` on 16 GB RAM / 12 GB VRAM, but the expected result was 4b/14b/20b. We followed sai-welcome's `Suggest` instead (largest model that fits in VRAM, then largest non-slow), and all five scenarios pass. Lesson: check spec examples against the spec's own rule before freezing contracts.
- Review also fixed: the `^` autocomplete fallback and the Ctrl+P `cycle_model` shortcut were both leaking non-Ollama models; Download buttons stayed disabled after an error frame; "Start Ollama" was offered without a systemd unit; and main now re-probes before running a remedy and allows one at a time.
- Gotcha: `test:e2e -- onboarding` matches every spec, because the worktree path contains "onboarding". Use `onboarding.e2e.ts`.

## Decision
The agent is unchanged. All fixes stay in the GUI: forced refresh, a GUI-side cycle over the filtered list, and the filtered fallback. API keys set in the environment or stored are kept but hidden.

## Next Steps
1. Manual smoke test on Linux with real Ollama and pkexec (not installed on the dev machine).
2. Run the heavy e2e specs: deep-audit, real-core, performance, packaged-smoke.
3. Locales: this branch uses en+zh, but main is moving to en+vi (`zh.ts` deleted, `vi.ts` added). At merge, port every new `welcome.*`/`ollama.*`/`providers.cleanup.*` key to `vi.ts` and drop the zh additions.
4. Commit in the GUI repo after steps 1-3. Exclude `*.tsbuildinfo` (now in `.gitignore`).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
