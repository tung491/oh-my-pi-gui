---
phase: 2
title: "Context-fit measurement engine (TS + Rust)"
status: pending
depends_on: []
---

# Phase 2: Context-fit measurement engine

## Context

Electron (macOS) uses `src/main/ollama/` and Tauri (Linux) uses `src-tauri/src/ollama/`, kept in step by `scripts/check-test-parity.ts` and `src-tauri/contracts/ollama.parity.json`. Follow `warm.ts`/`warm.rs` (plain HTTP to the daemon, injectable fetch, never throws) and `hardware.ts` (injected deps). `/api/ps` reports `size`, `size_vram` and `context_length`. Ollama spills to the CPU rather than failing, refuses a load beyond system memory with HTTP 500, and silently clamps `num_ctx` above the trained context.

## Algorithm

```
measure(baseUrl, tag, machine, isBusy, onProgress) -> MeasureOutcome
  precondition  isLoopbackBaseUrl(baseUrl) && isLocalOllamaRow(tag row) && isValidModelTag(tag), else reject with no request
  show          /api/show {model: tag}
  trained       model_info["<general.architecture>.context_length"], valid when a safe integer in [1, 2^24]
  ceiling       min(trained, Modelfile num_ctx from show.parameters if present); unknown trained → 131072
  floor         min(16384, ceiling)
  ladder        { floor·2^k ≤ ceiling } ∪ { ceiling }        (ascending, deduplicated)
  for n in ladder (ascending):
    if isBusy() → abort: outcome "interrupted"
    if two fitting probes exist and predict(n) > budget × 1.10 → stop   (size(n) = a + b·n, least squares)
    load(tag, n); ps = /api/ps
    discard the probe (outcome "interrupted") if ps lists another runner, or the entry lacks size/size_vram,
      or context_length is absent or ≠ n
    on the first probe: pool = machine.unifiedMemory ? "ram" : (ps.size_vram > 0 ? "gpu" : "ram")
    fits(n) = pool == "gpu" ? ps.size_vram >= ps.size : ps.size <= ramBudget(machine)
    if !fits(n):
       if n is the first failing rung: unload, poll /api/ps until empty (≤ 10 s), re-probe n once
       if it still does not fit: stop
    else best = n
  finally unload: /api/generate {model, keep_alive: 0}
  result: best → { maxContext: best, verdict: "fits" }
          the floor does not fit (complete probe) → { maxContext: floor, verdict: pool == "gpu" ? "spills" : "exceeds-ram" }
```

- `load(tag, n)` is `POST /api/generate {model, keep_alive: "30s", stream: false, options: {num_ctx: n}}` with no prompt.
- The first probe's timeout scales with the model's size (120 s plus 1 s per 50 MB of the `/api/tags` size), and later probes use 120 s.
- An HTTP 500 such as "requires more system memory" is a valid "does not fit" result. Any other non-2xx from `/api/show` or `/api/ps`, a network error or a timeout ends the run with outcome `error` and no ceiling.
- `ramBudget(machine) = ramBytes − ramReserve(ramBytes)`. Export `ramReserve` from `src/shared/ollama-catalog.ts:98` and from `src-tauri/src/ollama/catalog.rs:179`; there is no logic change.
- `onProgress({ tag, state: "running", numCtx })` is called before each load.

## Types (`src/shared/ollama-types.ts`)

```ts
export type ContextPool = "gpu" | "ram";
export type ContextVerdict = "fits" | "spills" | "exceeds-ram";
export interface ContextFitResult { maxContext: number; trainedContext: number; pool: ContextPool; verdict: ContextVerdict }
export type MeasureOutcome =
	| { kind: "measured"; result: ContextFitResult }
	| { kind: "interrupted" }                       // busy or a foreign runner; retried later, nothing persisted as failure
	| { kind: "error"; message: string };           // persisted as a failed attempt (phase 3)
export interface ContextFitProgress { tag: string; state: "running" | "done" | "error"; numCtx?: number }
```

## Files

- `src/shared/ollama-types.ts`: the types above.
- `src/shared/ollama-catalog.ts` and `src-tauri/src/ollama/catalog.rs`: export `ramReserve`/`ram_reserve`, and export `installedName`/`withDefaultTag` for phase 3.
- `src/shared/ollama-local.ts` (+ `.test.ts`) and `src-tauri/src/ollama/local.rs`: `isLocalOllamaRow` (no cloud tag, no remote copy; port 0003's `isOllamaCloudTag` and `remote_host`/`remote_model` rules) and `isLoopbackBaseUrl`.
- `src/main/ollama/context-fit.ts` (+ `.test.ts`) and `src-tauri/src/ollama/context_fit.rs` (+ inline tests with the same names): the ladder, the walk, the prediction and the probe rules. The VRAM simulator lives **inside these tests**, not in the shared `test-fake-ollama.ts`.
- `src-tauri/src/ollama/mod.rs`: the module declarations.
- `src-tauri/contracts/ollama.parity.json`: the pairs `context-fit.test.ts ↔ context_fit.rs` and `ollama-local.test.ts ↔ local.rs`.

## Test matrix (identical names in TS and Rust)

- picks the largest rung that stays on the GPU
- returns the ceiling when every rung fits
- uses a trained context that is not a power of two as the top rung
- caps the ceiling at the Modelfile num_ctx
- handles a trained context below the floor
- treats an absurd trained context as unknown
- decides the pool from size_vram, not from nvidia-smi
- uses the RAM budget on unified memory
- skips a rung predicted to exceed the budget
- re-probes the first failing rung once after unloading
- treats HTTP 500 on load as not fitting
- reports spills at the floor
- returns error on a non-2xx from api/show or api/ps
- discards a probe with a foreign runner
- discards a probe whose context_length differs
- aborts as interrupted when a sidecar becomes busy
- unloads the model after measuring, also after an abort
- rejects a cloud tag, a remote copy and a non-loopback host without any request
- rejects an invalid tag without any request

## Validation

`bunx vitest run src/main/ollama/context-fit.test.ts src/shared/ollama-local.test.ts`; `cargo test --manifest-path src-tauri/Cargo.toml --all-features context_fit local`; `bun scripts/check-test-parity.ts`.
