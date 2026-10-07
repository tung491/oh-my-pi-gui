---
title: "Ollama-only provider and sai-welcome onboarding"
description: "Replace the five-step provider wizard with sai-welcome's one-screen local-model onboarding, and remove every provider except Ollama."
status: in-progress
priority: P1
effort: 3d
branch: feat/ollama-only-onboarding
tags: [frontend, main-process, onboarding, providers]
blockedBy: []
blocks: []
created: 2026-10-02
---

# Ollama-only provider and sai-welcome onboarding

## Outcome

On first launch Sai ATLAS shows one screen, ported from
[`tung491/sai-welcome`](https://github.com/tung491/sai-welcome)
(`welcome-rs/welcome-tauri/frontend/src/screen-one.js`). The screen shows what
this machine has (memory, graphics), an Ollama status row with a remedy, and
three model cards (minimal / recommended / maximum) with download progress.
"Continue to the assistant" sets the picked model as the default and closes the
screen. Ollama (local) is the only provider the GUI offers anywhere. Earlier
logins to other providers are signed out, and their custom entries are removed
from `models.yml` after a backup.

## Decisions (user-confirmed 2026-10-02)

| Topic | Decision |
|---|---|
| Flow shape | One screen like sai-welcome, not a wizard |
| Existing providers | Hide everywhere, **and** log out OAuth providers and delete non-Ollama custom providers from `models.yml` (backed up first) |
| Remedies | Linux: "Install Ollama" (official installer via `pkexec`) and "Start Ollama" (`pkexec systemctl start ollama.service`). macOS/Windows: ollama.com/download link + "Check again" |
| Catalog | Curated Ollama tags bundled in the app, sized against RAM/VRAM, works offline |

## Constraints

- Agent code (`../../packages/coding-agent`) is not changed. Ollama already works there as an implicit provider (`model-discovery.ts:126`, `getImplicitOllamaBaseUrl`, which honours `OLLAMA_BASE_URL` / `OLLAMA_HOST`). The GUI uses the same base-URL rule.
- Every new string is added to both `en.ts` and `zh.ts` (`locales.test.ts`).
- Privileged commands come from a closed set defined in main. The renderer can only ask for a remedy by id and can never send a command string.
- Back up `models.yml` before any destructive edit. Credentials in `~/.omp/agent/agent.db` are only removed through the agent's `logout` RPC, never by editing the database.
- Tests use the linkedom harness. Stores are reset in `afterEach`. No `mock.module()`.

## Non-goals

- Editing the Ollama endpoint from the GUI (it stays env-driven, as in the agent).
- A remote model catalog, benchmarking on the onboarding screen, or the `said` daemon.
- Rewriting stats history (`stats/ProvidersRoute.tsx` keeps showing past usage).

## Phases

| # | Phase | Runs | Depends on | Status |
|---|---|---|---|---|
| 1 | [Contracts, catalog and copy](phase-01-contracts-catalog-copy.md) | sequential | none | completed |
| 2 | [Main-process Ollama service](phase-02-main-ollama-service.md) | parallel | 1 | completed |
| 3 | [Provider cleanup migration](phase-03-provider-cleanup.md) | parallel | 1 | completed |
| 4 | [Onboarding screen](phase-04-onboarding-screen.md) | parallel | 1 | completed |
| 5 | [Ollama-only provider surfaces](phase-05-provider-surfaces.md) | parallel | 1 | completed |
| 6 | [Integration, dead-code sweep, verification](phase-06-integration-verification.md) | sequential | 2, 3, 4, 5 | in progress (manual smoke with real Ollama pending) |

Phases 2 to 5 own disjoint files (see each phase's **File ownership**) and run
concurrently after phase 1 merges. They meet only at the contracts that phase 1
freezes: `src/shared/ollama-types.ts`, `src/shared/ollama-catalog.ts`,
`src/shared/provider-policy.ts`, the shared `OllamaRow` / `PullBar` components and `openWelcome()` store action, the `window.omp.ollama` / `window.omp.providerCleanup`
preload bindings, and the locale keys.

```
phase 1 ──┬── phase 2 (main/ollama/*, main/ipc.ts)
          ├── phase 3 (main/provider-cleanup.ts, renderer/lib/provider-cleanup.ts, App.tsx)
          ├── phase 4 (dialogs/FirstRunOnboardingDialog*, components/onboarding/*)
          └── phase 5 (settings/Providers*, ModelPicker, ModelRoles, command registry …)
                         └── phase 6 (locales cleanup, e2e, docs, full gates)
```

## Acceptance criteria

1. On a fresh profile with Ollama running and at least one catalogued model installed, the onboarding screen opens and shows Memory/Graphics facts, "Ollama is running (N models)", and three cards with the installed card marked "On this machine, ready to use". Continue sets `ollama/<tag>` as the default model and closes the screen. It does not reopen on the next launch.
2. With Ollama stopped or absent on Linux, the row shows the matching message, the exact command, and a working Start/Install button. On macOS/Windows it shows the download link and "Check again".
3. Download streams a progress bar that goes indeterminate, then percent, then ready. Cancel stops it, and a later Download resumes.
4. No surface (onboarding, Providers window, model picker, model roles, settings model selects, command palette, benchmark) lists or offers a non-Ollama provider or model.
5. After upgrade, the cleanup runs once. `models.yml` is backed up to `models.yml.bak-<timestamp>` before non-Ollama providers are removed, and every authenticated non-Ollama provider gets a `logout` RPC. A one-line notice tells the user what changed.
6. `bunx vitest run`, `bun run check:types`, `bunx biome check <touched files>` and `bun run build` pass.

## Validation log

- Decisions above were confirmed by the user through the interview on 2026-10-02.
- Verified against source: implicit Ollama base URL (`packages/coding-agent/src/config/model-discovery.ts:126-156`); `logout` and `set_model` RPCs (`src/shared/rpc-types.ts:29,70`); onboarding mounted unconditionally (`src/renderer/App.tsx:776`); readiness helper `hasUsableModelProvider` (`FirstRunOnboardingDialog.tsx:54`); custom-provider IPC (`src/main/ipc.ts:975`, `src/preload/index.ts:329`).
- `[UNVERIFIED]` Catalog download sizes. Phase 1 confirms them with `ollama show <tag>` or the ollama.com library page before freezing.

## Progress (2026-10-02)

Implemented on branch `feat/ollama-only-onboarding` in worktree `../worktrees/oh-my-pi-gui-feat-ollama-only-onboarding` (uncommitted). Gates: vitest 1819/1819, check:types, biome on touched files, build, e2e `onboarding.e2e.ts` + `desktop.e2e.ts`. Not yet done: phase 6 step 6 (manual Linux smoke with real Ollama; Ollama is not installed on the dev machine) and the heavy e2e specs (deep-audit, real-core, performance, packaged-smoke). Reports: `plans/reports/*-261002-*`.

## Design artifact

Screens: [Sai ATLAS Ollama Onboarding](https://claude.ai/artifact/3qvG5mQEtFocjF3dXydWd7). It shows the welcome screen in four states (running and downloading, stopped on Linux, absent on macOS, loading), the Ollama settings window with the cleanup notice, the Ollama-only model picker, and the shared OllamaRow and ModelCard parts.
