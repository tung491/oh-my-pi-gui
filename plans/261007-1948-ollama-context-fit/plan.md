---
title: "Measured, user-capped context size per Ollama model"
description: "Load-and-search each local model's largest context that stays in GPU (or RAM) memory, let the user lower it, and apply it live per model through a sidecar setting."
status: pending
priority: P2
effort: 4d
branch: main
tags: [ollama, sidecar, settings, tauri, electron]
blockedBy: []
blocks: []
created: 2026-10-07
---

# Measured, user-capped context size per Ollama model

## Outcome

Every installed **local** Ollama model has a measured maximum context: the largest `num_ctx` at which Ollama keeps the whole model on the GPU, or, when it runs from system memory, within the RAM budget. The user can lower each model's context in the Ollama window but never raise it past that maximum. Each value reaches every running sidecar live, without a restart, and the sidecar sends it as that model's `num_ctx`.

## Decisions

| Question | Choice | When |
|---|---|---|
| Scope | Per model, through a new sidecar patch (`0005`) | 2026-10-07, plan |
| Method | Full load-and-search: load the model at a ladder of `num_ctx` values and read `/api/ps` | plan |
| Triggers | The Measure button; automatically after a pull; automatically on a hardware change, and once for models never measured | plan |
| Carrier | A live `ollama.contextLimits` setting in a GUI-owned `--config` overlay file, so no restarts | red team |
| `OLLAMA_CONTEXT_LENGTH` exported by the user | A hard cap on every measured value, shown in the row | red team |
| Floor | 16384. When even the floor spills, store 16384 with a "slow" warning. Failures are remembered | red team |
| Search | An ascending walk from the floor that skips only the rungs predicted, and therefore certain, to fail | red team |

## Current state (verified)

- `src/main/sidecar.ts:381` and `src-tauri/src/omp/manager.rs:605-609` set a global `OLLAMA_CONTEXT_LENGTH=131072` at spawn, and an inherited or login-shell value wins.
- Patch 0001 (already commit `411f272184` in the fork) caps each implicit-Ollama model at that value in `model-registry.ts:1461-1468`, and `ollama-chat` sends `contextWindow` as `num_ctx`.
- The sidecar re-applies a changed `contextWindow` live: `agent-session.ts:10512-10526` (`#reapplyExtendedContextPolicy` → `reapplyModelPolicies()` → `#normalizeDiscoverableModels`). Settings watches `--config` overlays on disk (`config/settings.ts:1093-1104, 1199-1208`), `--config` can be passed more than once (`cli/flag-tables.ts:116-118`), and the pack already passes one (`src/main/assistant-pack.ts:92-93`).
- Main already knows whether any sidecar in any window is busy: `SidecarPool` tracks `running`/`compacting` (`src/main/sidecar-pool.ts:297-304`), and so does the Rust pool (`src-tauri/src/tabs/pool.rs:97-119`).
- Every window mounts `ProvidersWindow` (`src/renderer/App.tsx:621`), and `sidecar:restart` is scoped to one window (`src/main/ipc.ts:861-872`, `src-tauri/src/tabs/ipc.rs:397-406`). So the renderer cannot own the scheduler.
- `/api/ps` reports `size`, `size_vram` and `context_length`. Ollama spills to the CPU instead of failing, and it clamps a `num_ctx` above the trained context without saying so (`plans/reports/research-261007-1853-…`, and Kongming's verdict).

## Architecture

```
 Ollama window (any window) ── enqueue(tag) ──┐        ┌── pull finished / startup stale pass
                                              ▼        ▼
                     main / Rust  context-fit scheduler (single queue for the whole app)
                       │  gate: no sidecar in any window running/compacting (pool)
                       │  local-only tags, loopback base URL only
                       ▼
                     engine: /api/show → ceiling = min(trained, Modelfile num_ctx)
                             ascending ladder 16k,32k,… ; /api/generate {num_ctx} ; /api/ps
                             pool from size_vram ; stop at first spill or predicted spill
                       ▼
     prefs "ollamaContextFit" (main-owned key)  ──►  <userData>/ollama-context-limits.yml
                                                       ollama.contextLimits: {tag: n}
                                                         (min with the user's OLLAMA_CONTEXT_LENGTH)
                       │ broadcast ollama:context-progress / ollama:context-changed to every window
                       ▼
     every sidecar spawned with  --config <pack>/config.yml --config <overlay>
       settings watcher reloads the overlay → patch 0005 listener → contextWindow rebinds → num_ctx
```

## Phases

| # | Phase | Depends on | Status |
|---|---|---|---|
| 1 | [Live per-model limit setting in the sidecar (patch 0005)](phase-01-sidecar-per-model-limits.md) | — | pending |
| 2 | [Context-fit measurement engine (TS + Rust)](phase-02-measurement-engine.md) | — | pending |
| 3 | [Store, overlay, main-side scheduler and IPC](phase-03-store-ipc-spawn-env.md) | 1, 2 | pending |
| 4 | [Ollama window UI](phase-04-ui-and-triggers.md) | 3 | pending |
| 5 | [Real-machine verification and docs](phase-05-verification-and-docs.md) | 4 | pending |

Phase 1 is a gate. If its live-reload test fails, stop and re-plan the carrier (fallback: spawn env plus restarts coordinated by main). Phases 1 and 2 touch disjoint trees and can run in parallel.

## Acceptance criteria

1. With patch 0005, an overlay containing `ollama.contextLimits: { "m:latest": 32768 }` makes model `m:latest` report `contextWindow` 32768 and send `num_ctx` 32768. Other models keep the global cap. A `modelOverrides` `contextWindow` above the limit is still capped. A malformed entry is ignored. Editing the overlay while the sidecar runs changes the active model's `contextWindow` without a restart. Monorepo tests cover each case.
2. Measuring a local model walks the ladder from 16384 upward and returns the largest rung with `size_vram >= size` (when the floor probe shows GPU residency) or with `size` within the RAM budget (otherwise, and always on unified memory). It never loads a rung predicted to exceed the budget, and the model is unloaded afterwards. The TS and Rust engines pass the same fixture tests.
3. The user can set a cap between `min(16384, max)` and `max`, and clear it. Main/Rust reject any other value, and the renderer cannot write `ollamaContextFit` through `prefs:set`. The effective value is `min(userCap ?? max, max, OLLAMA_CONTEXT_LENGTH from the user's env if set)`.
4. A changed effective value reaches every running sidecar in every window without a restart. `/api/ps` shows the new `context_length` on the next turn. When the value drops below an idle session's current usage, that session is compacted.
5. Measurement runs automatically after a successful pull (once the welcome dialog has closed) and at startup for each local model that is unmeasured or whose fingerprint changed. It never runs while any sidecar in any window is running or compacting, and it aborts when a turn starts. Only one measurement runs app-wide. A model that failed under the current fingerprint is not retried automatically. Cloud tags and non-loopback hosts are never measured.
6. Every new string is in `en.ts` and `vi.ts`. `bunx vitest run`, `bun run check:types`, biome on touched files, `cargo clippy … -D warnings`, `cargo test`, test parity, API snapshots, `e2e-tauri/check-twins.ts` and both onboarding e2e suites pass.

## Non-goals

- Changing the Ollama server's settings (`OLLAMA_KV_CACHE_TYPE`, flash attention, `OLLAMA_NUM_PARALLEL`).
- A quality cap for small models (for example 64k for E2B).
- Cloud models, remote Ollama hosts and non-Ollama providers.
- A cancel button. A starting chat turn aborts a measurement instead.

## Prerequisite

The uncommitted attachment work touches `ipc-types.ts`, `create-omp-api.ts`, both locale files and the Tauri `services` contracts. Commit or stash it before phase 3.

## Risks

- **Free VRAM moves.** Ollama sizes against free VRAM at load time. A probe that sees another runner in `/api/ps` is discarded, and the user can press Measure again.
- **The live-reload assumptions** (the overlay watcher fires `listen` callbacks, and a same-model rebind does not disturb an in-flight turn) are proven or disproven by phase 1's tests. If a mid-turn rebind is unsafe, main defers overlay writes until the pool is idle.
- **Ollama truncates oversized prompts** to `num_ctx` rather than rejecting them. This is documented, not yet observed; phase 5 observes it, and the compaction in AC4 guards it.
- **Upstream sync** may make patch 0005 stop applying. `build:omp` fails loudly with rebase steps.

## Red Team Review

Run on 2026-10-07 with `--ultra`. Four hostile reviewers (Security Adversary, Failure Mode Analyst, Assumption Destroyer, Scope & Contract Critic) raised 36 findings with file:line evidence. Kongming (Fable) independently re-verified them against the GUI repo, the monorepo and the local Ollama, and merged them into 23 findings. All 23 were accepted, some modified. Four were design decisions, and the user chose Kongming's recommendation on each (Decisions table, rows marked "red team").

Reports: `plans/reports/red-team-261007-1953-{security-adversary,failure-mode-analyst,assumption-destroyer,scope-contract-critic}.md`, verdict `plans/reports/kongming-261007-1953-context-fit-red-team-verdict.md`.

| # | Finding (merged) | Severity | Disposition | Where applied |
|---|---|---|---|---|
| M1 | The scheduler, busy gate and fan-out assumed a renderer "main window" | Critical | Accept: moved to main/Rust | Phase 3 |
| M2 | Restart fan-out (one per model, asleep tabs, onboarding race) | High | Accept; made unnecessary by M3 | — |
| M3 | A live mechanism exists, so restarts are not needed | High | Accept: overlay carrier | Phases 1, 3 |
| M4 | The renderer can forge `ollamaContextFit` through `prefs:set` | High | Accept | Phase 3 |
| M5 | Tauri registration is in `ollama/mod.rs`; the channel count is 92 → 97; an undeclared event | High | Accept | Phase 3 |
| M6 | Cloud tags and remote hosts would be measured automatically | High | Accept | Phases 2, 3 |
| M7 | Pool detection relied on `nvidia-smi`, and the fingerprint flapped | High | Accept: pool from `size_vram` | Phases 2, 3 |
| M8 | Tags not canonical (bare tag vs `:latest`) | High | Accept: `installedName` | Phases 1, 3 |
| M9 | Precedence with inherited env and `OLLAMA_CONTEXT_LENGTH` | Medium | Accept: hard cap | Phase 3 |
| M10 | Read-modify-write lost caps during a measurement | Medium | Accept | Phase 3 |
| M11 | A turn could start mid-measurement, and foreign runners skew `/api/ps` | High | Accept-modified (no prompt holding) | Phases 2, 3 |
| M12 | The 8192 floor is below the agent's first request | High | Accept: 16384 | Phase 2 |
| M13 | Failures not persisted, so models were retried on every start | High | Accept | Phase 3 |
| M14 | Binary search could load a huge rung and push the machine into swap | High | Accept-modified: ascending walk | Phase 2 |
| M15 | Ladder edge cases (trained below the floor, absurd values) | Medium | Accept | Phase 2 |
| M16 | `set-cap` own-key and tag validation | Low | Accept-modified | Phase 3 |
| M17 | Non-2xx undefined; onboarding e2e fakes return 404 | High | Accept | Phases 2, 5 |
| M18 | Persisted shape too large | Medium | Accept-modified | Phase 3 |
| M19 | Cancel channel and step-counted progress | Medium | Accept-modified: no cancel, simple progress | Phases 3, 4 |
| M20 | Rust `omp` → `ollama` module boundary | Medium | Accept: `omp` only gets a path | Phase 3 |
| M21 | A Modelfile `num_ctx` bounds the sidecar | Low | Accept-modified | Phase 2 |
| M22 | A lowered cap truncates a long resumed session | Medium | Accept-modified: `compact` | Phase 3 |
| M23 | The cap missed a configured `ollama` provider and `modelOverrides` | Medium | Accept-modified | Phase 1 |

Rejected sub-suggestions: holding new prompts in main during a measurement; removing the progress event entirely; confirming every winning rung with a second load; hiding the key from `prefs:get`.

### Whole-Plan Consistency Sweep

All five phase files were rewritten after adjudication. Superseded terms searched for and removed: `PI_OLLAMA_CONTEXT_LIMITS`, the renderer `context-fit-scheduler`, `ollama:context-cancel`, `8192`, binary search, the `nvidia-smi` pool rule, restart fan-out and `preload/index.ts` edits. No contradictions remain. Phase file names are unchanged (`phase-03-store-ipc-spawn-env.md` now covers the overlay and the scheduler).
