---
phase: 3
title: "Store, overlay, main-side scheduler and IPC"
status: pending
depends_on: [1, 2]
---

# Phase 3: Store, overlay, main-side scheduler and IPC

## Context

- The prefs file is shared by both shells: electron-store `prefs.json`, which Tauri reads through `JsonStore` (`src-tauri/src/prefs.rs`). Model tags contain dots, so use **one** top-level key, `ollamaContextFit`, never a dot path per tag.
- Generic `prefs:set` refuses only the keys in `MAIN_OWNED_PREF_KEYS` (`src/main/quick-entry-shortcut-core.ts:72`, `src-tauri/src/desktop/shortcut_core.rs:286`), checked in `src/main/ipc.ts:829-834` and `src-tauri/src/services/ipc.rs:311-316`.
- Main sees every window's sidecars: `SidecarPool` `running`/`compacting` (`src/main/sidecar-pool.ts:297-304`) and `commandForIdleSession` (`:470`); in Rust, `pool.rs` `in_flight()` (`:97-119, 419-425`) and `command_for_idle_session` (`:759`). The quick-entry window uses the same pool.
- Tauri Ollama channels are registered in `src-tauri/src/ollama/mod.rs:31-52` (`CHANNELS`, `EMITS`, `register`), with handler bodies in `ollama/ipc.rs`. `src-tauri/tests/channels.rs:14` hard-codes `EXPECTED_CHANNEL_COUNT = 92`.
- Progress broadcast pattern: `broadcastInstallProgress` (`src/main/ollama/register-ipc.ts:28-31`).

## Store (`src/shared/context-fit-store.ts` + test; Rust `src-tauri/src/ollama/context_fit_store.rs`)

```ts
interface ContextFitEntry {
	maxContext: number | null;        // null until a successful measurement
	trainedContext: number | null;
	pool: ContextPool | null;
	verdict: ContextVerdict | null;
	measuredAt: string | null;
	fingerprint: MachineFingerprint;  // of the last attempt
	userCap: number | null;
	attempts: number;
	lastError: string | null;
	lastAttemptAt: string | null;
}
interface ContextFitStore { version: 1; models: Record<string, ContextFitEntry> }   // keyed by the exact /api/tags name
type MachineFingerprint = Pick<MachineFacts, "ramBytes" | "vramBytes" | "gpuName" | "unifiedMemory">;
```

The probe list is logged by main, not stored. These are pure helpers, with the same test names in TS and Rust:

- `parseContextFitStore(raw)`: tolerant. It drops bad entries, uses `Map`/`Object.hasOwn` and never throws.
- `effectiveContext(entry, envCap)`: `min(userCap ?? max, max, envCap ?? ∞)`, or null when `max` is null.
- `isStale(entry, current)`: RAM at 256 MiB granularity, `unifiedMemory`, and VRAM at 256 MiB granularity **only when both readings are non-null**. A null VRAM reading is unknown, not a change. `gpuName` is compared only when both readings came from `nvidia-smi`.
- `needsAutoMeasure(entry, current)`: true when there is no entry, or when the entry is stale and has no failure recorded under the current fingerprint.
- `clampCap(entry, cap)`: a safe integer in `[min(16384, max), max]`, otherwise rejected. Setting `cap === max` stores null.
- `overlayYaml(store, envCap)`: `ollama:\n  contextLimits:\n    "<tag>": <n>` for entries with a non-null effective value. Tags are quoted.

## Writes (main/Rust only)

- Add `ollamaContextFit` to both `MAIN_OWNED_PREF_KEYS` lists, with a refusal test in each shell (the same name).
- Every mutation re-reads the store at commit time and writes only the touched tag, with no `await` between the read and the write. In Electron this is one synchronous `Store` instance (as `ipc.ts:849-856`); in Rust it is `prefs.update`.
- Before any read or write, every incoming tag is resolved to the exact `/api/tags` name through `installedName`. A tag that is not installed, not valid, a cloud tag or a remote copy is rejected.
- After every mutation that changes an effective value, write `<userData>/ollama-context-limits.yml` atomically (a temp file, then rename), and broadcast `ollama:context-changed`.
- **Measured result:** keep `userCap` if it is still ≤ the new max, otherwise drop it. **Error:** `attempts += 1`, set `lastError`/`lastAttemptAt`/`fingerprint`, and keep any previous ceiling. **Interrupted:** write nothing and re-queue.

## Overlay at spawn

- `src/main/sidecar.ts`: append `--config <userData>/ollama-context-limits.yml` after the pack's `--config`, and create the file (empty `ollama: {contextLimits: {}}`) when it is missing so the watcher has a file to watch. Keep `OLLAMA_CONTEXT_LENGTH: "131072"` as the fallback for unmeasured models.
- `src-tauri/src/omp/manager.rs`: the same. `omp` receives only the path string from `paths.rs`/ctx, so there is no import from `ollama` (no new `cross-module-calls.json` entry for the spawn).
- `envCap` is the user's `OLLAMA_CONTEXT_LENGTH`: read from the process env, else from the resolved login-shell env (`#shellEnvVars` / `spawn_env()`), excluding the GUI's own default. Recompute the overlay when the shell env resolves.

## Scheduler (`src/main/ollama/context-fit-scheduler.ts` + test; `src-tauri/src/ollama/context_fit_scheduler.rs`, parity-paired)

- One instance per app. `enqueue(tag, reason: "manual" | "pulled" | "stale")` de-duplicates and puts "manual" first.
- It runs the next item only when Ollama status is `ok`, the base URL is loopback and **no sidecar in any window is running or compacting**. Electron uses `SidecarPool`. Rust adds `TabsPort::any_in_flight()`, recorded in `cross-module-calls.json` and `ports.api.txt`.
- It passes `isBusy` to the engine (re-checked before every probe), so a starting turn aborts the run as `interrupted`, which is re-queued.
- **Startup pass:** after the first `ok` probe, read `readMachine()` and enqueue each installed local model with `needsAutoMeasure` as "stale".
- **"pulled"** items wait until the welcome dialog has closed (`WELCOME_COMPLETED_PREF`, or a renderer `onboarding-done` signal), so onboarding's `set_model` calls and warm-up are never disturbed.
- After a value drops: for each idle session whose last reported context usage exceeds the new window, send `compact` through `commandForIdleSession` / `command_for_idle_session`.
- It broadcasts `ollama:context-progress` to every window.

## IPC (both shells)

| Channel | Payload → result |
|---|---|
| `ollama:context-list` | → `{ rows: { tag, entry \| null, effective \| null, stale, envCap \| null }[], reason?: "remote-host" }` covering installed local models only |
| `ollama:context-measure` | `{ tag }` → `{ queued: true }` (enqueues as "manual") |
| `ollama:context-set-cap` | `{ tag, cap: number \| null }` → the entry; an error when the cap is out of range or the model is unmeasured |
| event `ollama:context-progress` | `ContextFitProgress` |
| event `ollama:context-changed` | `{ tag }` |

The renderer also sends "pulled" through `ollama:context-measure` with a `reason` field. Main validates the reason against the enum.

## Files

`src/shared/context-fit-store.ts` (+test), `src/shared/ipc-types.ts` (commands and events), `OmpApi` plus `src/shared/bridge/create-omp-api.ts` (+test), `src/main/ollama/register-ipc.ts`, `src/main/ollama/context-fit-scheduler.ts` (+test), `src/main/sidecar.ts` (+ a spawn test for `--config` and the overlay), `src/main/quick-entry-shortcut-core.ts`, `src/main/ipc.ts` (only if the guard needs it), `src-tauri/src/ollama/{mod.rs, ipc.rs, context_fit_store.rs, context_fit_scheduler.rs}`, `src-tauri/src/omp/manager.rs` (+ a spawn test twin of the `sidecar.test.ts` one, per `omp.parity.json`), `src-tauri/src/desktop/shortcut_core.rs`, `src-tauri/src/ports.rs` (`TabsPort::any_in_flight`), `src-tauri/src/tabs/pool.rs`, `src-tauri/tests/channels.rs` (92 → 97), and the contracts: `ollama.api.txt`, `omp.api.txt`, `ports.api.txt`, `ollama.parity.json`, `omp.parity.json` and `cross-module-calls.json`. New serde types use `#[serde(rename_all = "camelCase")]` (gate 5). `src/preload/index.ts` needs no change.

## Tests (beyond the helpers)

- `prefs:set` refuses `ollamaContextFit` in both shells.
- A cap set during a measurement survives it.
- The scheduler waits while any pool entry is running or compacting, and resumes when the pool is idle.
- A turn starting mid-run aborts it, and the item is re-queued.
- A model that failed under the current fingerprint is not auto-retried, but manual measurement retries it.
- A "pulled" item waits for the welcome dialog.
- A pulled bare tag is stored under its `:latest` name, and `context-list` shows it as measured.
- `envCap` lowers the overlay value.
- Dropping a value compacts only the idle sessions above the new window.
- The spawn passes the overlay `--config` after the pack config and creates a missing file.

## Validation

`bunx vitest run src/shared/context-fit-store.test.ts src/main/ollama src/shared/bridge src/main/sidecar*.test.ts`; `cargo test … context_fit manager shortcut`; `bash scripts/check-module.sh snapshots`; `bun scripts/check-test-parity.ts`.

## Risk

If phase 1 recorded that a mid-turn rebind is unsafe, the overlay writer waits for `!anyInFlight()` before writing. The store is still updated immediately, so the UI is not blocked.
