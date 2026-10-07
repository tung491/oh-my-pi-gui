---
phase: 1
title: "Live per-model limit setting in the sidecar (patch 0005)"
status: pending
depends_on: []
---

# Phase 1: Live per-model limit setting in the sidecar

This phase is a **gate**: if the live-reload test (step 4) fails, stop and re-plan the carrier before phase 3.

## Context

- 0001 is already in the fork as commit `411f272184`, and `build:omp` skips a patch the checkout contains. So 0005 is written against monorepo HEAD.
- The cap today is `packages/coding-agent/src/config/model-registry.ts:1461-1468`, which only covers the implicit provider (`provider === "ollama" && api === "ollama-chat"`). A configured `ollama` entry in `models.yml` skips the implicit branch (`:1501`; the GUI's cleanup keeps such an entry, `src/main/provider-cleanup.ts:92`), and `modelOverrides` are applied after normalisation (`:1406-1411`, `:1975-1980`).
- Live re-apply already exists: `#reapplyExtendedContextPolicy` (`session/agent-session.ts:10512-10526`) calls `reapplyModelPolicies()`, which re-runs normalisation, and it is wired to the `cfgExtendedContext` listener (`:2319`). 0003 already reads `this.#settings` in the same branch (`readModelPolicy`).
- Settings supports the `record` type, watches `--config` overlays with a 200 ms debounce, and notifies the listeners of changed keys (`config/settings.ts:1040, 1093-1104, 1199-1208`). A `--config` file is not `settings.json`, so an unknown key there cannot break the stock CLI (`assertKnownSettingPaths`, `settings.ts:269-276, 687`).

## Requirements

- Register the setting `ollama.contextLimits`, of type `record`: the keys are exact model ids (`item.model || item.name` as discovery assigns them), and the values are positive safe integers.
- Apply the limit to **every** model with `provider === "ollama"` and `api === "ollama-chat"`, after `modelOverrides` are applied: `contextWindow = min(current, limit)` and `maxTokens = min(maxTokens, contextWindow)`. An absent id leaves the model unchanged, so the 0001 global cap still governs it.
- Use an exact id lookup with no `:latest` aliasing. The GUI canonicalises tags before writing (phase 3).
- Drop an invalid entry (non-integer, ≤ 0, > 2^24, a non-object record) without failing. Discovery never throws.
- Add `cfgOllamaContextLimits.listen(this, () => this.#reapplyExtendedContextPolicy())` next to the `cfgExtendedContext` listener.

## Files (monorepo `../oh-my-pi`, commit at the monorepo root)

- `packages/coding-agent/src/config/settings-schema.ts` (or wherever settings are declared; find it with `grep -rn "extendedContext" packages/coding-agent/src/config`): the new setting.
- `packages/coding-agent/src/config/model-registry.ts`: apply the limit after the overrides.
- `packages/coding-agent/src/session/agent-session.ts`: the listener.
- Tests: `packages/coding-agent/test/model-discovery.test.ts` (or a new `ollama-context-limits.test.ts`), plus a settings and session test for the live reload.
- `docs/models.md` and the settings docs: document the key.
- GUI repo: `patches/omp/0005-ollama-per-model-context-limits.patch` (`git format-patch -1`), and the `AGENTS.md` Sidecar & Packaging Rules (a fifth patch: the setting, written by the GUI's overlay `<userData>/ollama-context-limits.yml`).

## Steps

1. `bun run build:omp` in the GUI repo, to confirm that 0001–0004 are in the checkout or apply cleanly.
2. Implement the setting, the post-override cap and the listener.
3. Add the unit tests:
   - an exact id gets its limit, and another id keeps the global cap;
   - a limit above the trained context gives the trained context;
   - a `modelOverrides` `contextWindow` above the limit is capped;
   - a configured (non-implicit) `ollama` provider model with `ollama-chat` is capped;
   - malformed entries are ignored (a string, a float, a negative value, 2^30, a non-object).
4. **Gate test (live reload):** start a settings manager with a temp `--config` overlay, create a session on an `ollama` model, rewrite the overlay with a smaller limit, wait out the debounce, and assert that the session model's `contextWindow` changed and that no provider-session reset happened. Also assert that a rebind during a mocked in-flight turn does not abort that turn. If this assertion fails, record it: phase 3 then defers overlay writes until the pool is idle.
5. `bun test` the touched test files at the monorepo root.
6. Commit in the monorepo and export the patch. Follow how 0002–0004 are handled for the fork.
7. `bun run build:omp`, then `bun scripts/check-assistant-pack.ts resources/omp`.

## Validation

- The monorepo tests from steps 3–4 pass.
- Smoke test: run the built sidecar in RPC mode with `--config assistant-pack/config.yml --config /tmp/limits.yml` (where the file has `ollama: { contextLimits: { "<installed tag>": 32768 } }`). `get_available_models` shows 32768 for that tag only. Edit the file to 16384, and within about a second the same call shows 16384.

## Risk / rollback

When the key is absent, behaviour is identical to today. Rollback means deleting the patch and its `AGENTS.md` line; the GUI then writes an overlay that nothing reads, which is harmless.
