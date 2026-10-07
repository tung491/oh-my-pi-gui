---
phase: 4
title: "Ollama window UI"
status: pending
depends_on: [3]
---

# Phase 4: Ollama window UI

## Context

`src/renderer/components/settings/ProvidersWindow.tsx` is the Ollama window, and every window mounts it (`App.tsx:621`). Scheduling, the busy gate and applying values all live in main/Rust (phase 3). The renderer only shows state, sends `context-measure` / `context-set-cap`, and listens to `ollama:context-progress` and `ollama:context-changed`. Every string goes through `useT()` with keys in `en.ts` and `vi.ts`.

## A context row per installed local model

```
 gemma-4-E4B-it-qat-q4_0-gguf:latest          [Use as default]
 Context  [ 32k ▾ ]  of 64k · measured on GPU · Measure again
          Capped at 32k by OLLAMA_CONTEXT_LENGTH in your shell                       (envCap)
          ⚠ This model doesn't fully fit even at 16k — replies will be slow           (spills / exceeds-ram)
          Measured on different hardware — will re-measure when idle                  (stale)
          Measuring… 32k                                                              (progress running)
          Waiting for the current reply to finish                                     (queued while busy)
          Couldn't measure: <lastError> · Try again                                   (error)
          Not measured yet · [Measure]                                                (no entry)
```

- The select lists ladder rungs from `min(16384, max)` up to `max`, plus `max` itself. Choosing `max` sends `cap: null`. When `envCap` is lower, the rungs above it are shown disabled.
- Cloud models and remote copies get no context row. When the base URL is not loopback, show one line ("Context sizing is only available for Ollama on this computer").
- Successful change toast: "Context for <model> set to 32k. Applies from the next reply." There is no restart clause, because the change is live.
- There is no Measure-disabled state for busy tabs. Main queues the request, and the row shows "Waiting for the current reply to finish".

## Pull trigger

After a successful pull, both `ProvidersWindow` and the onboarding pull flow (`FirstRunOnboardingDialog.tsx` / the `PullBar` caller) call `ollama.contextMeasure({ tag, reason: "pulled" })`. Main holds it until the welcome dialog has closed.

## Files

`ProvidersWindow.tsx` (+ test), a new `src/renderer/components/settings/ModelContextRow.tsx` (+ test), the onboarding pull-success hook, and `en.ts`/`vi.ts`.

## Tests (linkedom harness, store resets in `afterEach`)

- The row renders the no-entry, measured, stale, running, queued, error, spills and envCap states from `context-list` data.
- The select lists only allowed rungs, and choosing the max sends `cap: null`.
- A progress event for another tag does not change this row.
- Cloud and remote rows get no context row; a non-loopback base URL shows the single notice.
- A successful pull calls `contextMeasure` with `reason: "pulled"`.

## Validation

`bunx vitest run src/renderer/components/settings src/renderer/components/dialogs src/renderer/locales` and `bun run check:types`.
