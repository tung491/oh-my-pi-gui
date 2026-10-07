# Kongming verdict: red-team pass on plan 261007-1948-ollama-context-fit

Date: 2026-10-07 (Asia/Seoul). Model: Claude Fable 5.1. Advisory only; no plan file was edited.

Inputs: `plans/261007-1948-ollama-context-fit/` (plan.md, phase-01..05), the four red-team reports (`red-team-261007-1953-{security-adversary,failure-mode-analyst,scope-contract-critic,assumption-destroyer}.md`, 36 findings) and `research-261007-1853-ollama-context-from-machine-spec.md`. Every load-bearing claim below was re-checked against the GUI repo, the monorepo at `f674c994a9`, the local Ollama 0.35.0 (`/api/tags`, `/api/ps`, read-only) and Ollama's docs and source.

Locked user decisions are respected throughout: per-model limits via a new sidecar patch, full load-and-search, and the three triggers. Where a finding brushes against one, it is presented as a trade-off question, never as a reversal.

## TL;DR

The plan's measurement idea is sound and the research holds up, but three structural pieces are placed wrong and must move before implementation: the scheduler, its busy gate and any fan-out belong in main/Rust (the renderer has no "main window" and `sidecar:restart` is window-scoped); the carrier for the limits should be a live setting delivered through a GUI-owned `--config` overlay file, which patch 0005 reads and the sidecar's existing file watcher applies without any restart; and the GPU-or-RAM pool must come from Ollama's own `size_vram`, not from `nvidia-smi`. With those three moves, roughly half of the 36 findings disappear or shrink to a one-line rule. The remaining accepted findings are concrete and cheap: prefs write guard, tag canonicalisation, loopback-and-local-only gating, synchronous read-modify-write, a 16384 floor with failure persistence, and the Tauri channel bookkeeping.

## Fact-check corrections to the plan text

| Plan claim | Verified state |
|---|---|
| `src/main/ipc.ts:871` restart IPC | `src/main/ipc.ts:861-872`; resolves the sidecar through `BrowserWindow.fromWebContents(event.sender)`, so it can only restart the calling window's tabs. Tauri twin `src-tauri/src/tabs/ipc.rs:397-406` uses `caller.win_id` the same way. |
| `src/main/sidecar.ts:378` sets `OLLAMA_CONTEXT_LENGTH` | `sidecar.ts:381`, as the first key of the env literal, before `...process.env` and `...this.#shellEnvVars` (`:378-392`), so any inherited value wins. Rust twin `manager.rs:605-609` checks both `std::env` and the login-shell map. |
| 0001 cap at `model-registry.ts:1461` | `:1464` at monorepo HEAD. The fork already carries 0001 as commit `411f272184`, and `build:omp` skips a patch the checkout contains, so 0005 is written against HEAD directly. |
| Tauri Ollama IPC "registered in `src-tauri/src/ollama/ipc.rs`" | Registration is `src-tauri/src/ollama/mod.rs:31-52` (`CHANNELS`, `EMITS`, `register`); `ipc.rs` holds handler bodies only. `src-tauri/tests/channels.rs:14` hard-codes `EXPECTED_CHANNEL_COUNT = 92`. |
| "Main/Rust is the only writer of `ollamaContextFit`" | Not enforced: `MAIN_OWNED_PREF_KEYS` holds only `quickEntryShortcut` and `quickEntryTarget` in both shells (`src/main/quick-entry-shortcut-core.ts:72`, `src-tauri/src/desktop/shortcut_core.rs:286`). |
| `src/preload/index.ts` needs edits | It only delegates to `createOmpApi`; no edit needed. |
| `/api/ps` exposes `size`, `size_vram`, `context_length` | Confirmed in Ollama's API docs example; nothing was loaded locally (`/api/ps` is empty), so phase 5 remains the live confirmation. `OLLAMA_NUM_PARALLEL` defaults to 1 (FAQ), and Ollama multiplies context by parallelism only in its scheduler estimate (`server/sched.go:812-814`), so `context_length == num_ctx` is the expected case. |
| Ollama accepts any `num_ctx` | Ollama clamps `num_ctx` above the trained context silently (`llm/server.go:110-114`), which is one more reason the ladder must stop at `trained`. |

## Merged findings and verdicts

Overlapping findings are merged; the source IDs are given as SA (security adversary), FM (failure-mode analyst), SC (scope/contract critic) and AD (assumption destroyer).

### M1. The scheduler, busy gate and fan-out live in a renderer "main window" that does not exist. [SA-5, FM-1, SC-2, AD-1] — Accept (Critical)

Verified: every window mounts `ProvidersWindow` (`src/renderer/App.tsx:91,621`); `getMainWindow()` is just the first live record (`src/main/window.ts:393-398`); renderer streaming state is per-window. Main already knows what the renderer scheduler needs: `SidecarPool` tracks `running` and `compacting` per entry from `agent_start`/`agent_end` (`src/main/sidecar-pool.ts:297-304`), and the Rust pool does the same with `in_flight()` (`src-tauri/src/tabs/pool.rs:97-119, 419-425`). The quick-entry window opens tabs through the same pool (`src/main/quick-entry.ts:81,356`), so a pool-wide gate covers it too (resolves FM's open question).

Plan change: Phase 4 "Scheduler" moves to Phase 3 as a main/Rust queue (`src/main/ollama/context-fit-scheduler.ts`, `src-tauri/src/ollama/context_fit_scheduler.rs`, parity-paired). The renderer keeps only `enqueue(tag, reason)` and the progress listener. Delete `src/renderer/lib/context-fit-scheduler.ts` and its test from the Files list. Progress and change events are broadcast to every `WebContents` like `broadcastInstallProgress` (`src/main/ollama/register-ipc.ts:28-31`).

### M2. Restart fan-out: one restart per measured model, `agent_end` is not idle, asleep tabs wake, session path missing, onboarding `set_model` race. [FM-6, SC-3, AD-2] — Accept, but mooted by M3

Verified: `restart(undefined, undefined)` nulls the resume path and `--no-auto-resume` only applies before the first `ready` (`src/main/sidecar.ts:362, 573, 697-702`); the GUI's own restart guard checks `isStreaming || isCompacting` (`src/renderer/lib/command-registry.ts:222-232`); onboarding e2e asserts `set_model` on the first sidecar right after the pull (`e2e-tauri/onboarding.e2e.ts:104-112`).

Plan change: if the caller keeps the spawn-env carrier (fork b, option 2), Phase 3 "Applying a change" must say: main restarts only sidecars whose spawned limits JSON differs from the new one, once per queue drain, using each entry's own `session_file`, skipping `asleep`/`exited`/`error`, waiting for `!running && !compacting`, and never while the welcome dialog is open. If the caller takes the recommended live carrier, this whole section is deleted.

### M3. A live mechanism exists and is better than spawn-env plus restart. [AD-2, second half] — Accept (verified)

Verified chain: `#reapplyExtendedContextPolicy` rebinds the active model when its `contextWindow` changes, without a provider-session reset for the same model (`packages/coding-agent/src/session/agent-session.ts:10512-10526`); it calls `reapplyModelPolicies()`, which is `refresh("offline")` and re-runs `#normalizeDiscoverableModels` over the cached discovery (`model-registry.ts:511-523, 1406-1411`), the exact place where the 0001 cap and 0003's `readModelPolicy(this.#settings)` already run (`:1461-1468`, patch 0003 lines 283-303). The settings manager supports `record` and `json` setting types, accepts `--config` more than once (`cli/flag-tables.ts:116-118`), watches `--config` overlays on disk with a 200 ms debounce (`config/settings.ts:1093-1104, 1199-1208`) and notifies listeners of every setting whose effective value changed (`:1040`). The pack already passes `--config <packDir>/config.yml` (`src/main/assistant-pack.ts:92-93`).

Plan change: see fork (b). Phase 1 declares a setting instead of an env variable; Phase 3 writes a GUI-owned overlay file instead of `PI_OLLAMA_CONTEXT_LIMITS`; AC1 and AC4 are reworded.

### M4. The prefs write guard does not cover `ollamaContextFit`, so a renderer write forges the ceiling. [SA-3, SC-5, AD-7a] — Accept (High)

Verified at `src/main/ipc.ts:829-834`, `quick-entry-shortcut-core.ts:72-80`, `src-tauri/src/services/ipc.rs:311-316`, `shortcut_core.rs:286-291`.

Plan change: Phase 3 Files adds both `MAIN_OWNED_PREF_KEYS` lists with a refusal test each, parity-paired. Returning the key from `prefs:get` is fine (low sensitivity); reject that sub-suggestion.

### M5. Tauri channel registration, count and the undeclared `context-changed` event. [SC-1, SA fact-check] — Accept (High, mechanical)

Plan change: Phase 3 Context and Files list `ollama/mod.rs` (`CHANNELS`, `EMITS`, `register`), `ollama/ipc.rs` handlers, `channels.rs` with the new count, `ipc-types.ts` commands and events, `OmpApi`, `create-omp-api.ts` plus test, `ollama.api.txt`, and drop `preload/index.ts`. With M19's trimming the new surface is three commands (`context-list`, `context-measure`, `context-set-cap`) and two events (`context-progress`, `context-changed`), so the count becomes 97.

### M6. Automatic measurement contacts Ollama cloud models and non-loopback hosts. [SA-1, SA-2] — Accept (High)

Verified: `parseTags` keeps every row (`src/main/ollama/probe.ts:121-128`); the base URL accepts any host from the login shell (`src/main/ollama/base-url.ts`); patch 0003 defines both rules (`isOllamaCloudTag`, `remote_host`/`remote_model`, `isLoopbackBaseUrl`). Severity is High rather than Critical because it needs a signed-in cloud account or a remote host, but the startup trigger makes it happen with no user action and charges the user's account.

Plan change: Phase 2 adds a shared `isLocalOllamaRow(row)` and `isLoopbackBaseUrl(url)` pair (TS and Rust, parity test "skips cloud tags and remote copies without any request"). `context-list` excludes them; `context-measure` rejects them before any request; a non-loopback base URL returns no candidates and a stated reason.

### M7. The GPU-or-RAM pool comes from `nvidia-smi` only, and the fingerprint flaps when it times out. [SA-8, FM-3, AD-3] — Accept (High)

Verified: `hardware.ts:120-128` and `hardware.rs:250-258` set `vramBytes` only from `nvidia-smi` within 2 s; otherwise `null` with `gpuName` from a different source.

Plan change: see fork (c). Phase 2 algorithm picks the pool from the floor probe's `/api/ps`; Phase 3 `isStale` treats a `null` VRAM reading as unknown, never as a change, and compares `gpuName` only when both sides came from the same source.

### M8. Store keys are not canonical: pulls use bare tags, Ollama lists `:latest`, the patch carries a three-way alias. [SC-9, AD-5] — Accept (High)

Verified live: `/api/tags` lists `hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest` while the catalog tag is bare; `installedName` and `withDefaultTag` exist but are private (`src/shared/ollama-catalog.ts:124-147`).

Plan change: Phase 3 resolves every incoming tag to the exact `/api/tags` name through `installedName` before any store read or write, rejects a tag that is not installed, and keys the store and the overlay by that name. Phase 1 drops the alias lookup to an exact match on `item.model || item.name` (the sidecar's own id).

### M9. Precedence: inherited `PI_OLLAMA_CONTEXT_LIMITS` survives, and a user-exported `OLLAMA_CONTEXT_LENGTH` is silently overridden. [SA-4, FM-9a, AD-6] — Accept (Medium)

Verified: env literal order at `sidecar.ts:378-392`; `OVERLAY_DENYLIST` lacks the key (`src/main/shell-env.ts:30-60`); both shells' comments promise "a user-set value wins".

Plan change: see fork (e). With the overlay carrier the inherited-env half vanishes (there is no env variable to inherit). The `OLLAMA_CONTEXT_LENGTH` half is a user question (Q2) with a recommended default.

### M10. Whole-key read-modify-write across a minute-long measurement loses concurrent cap changes. [SA-9, FM-8, AD-7c] — Accept (Medium)

Verified precedent: `ipc.ts:849-856` keeps the launch-profile merge synchronous; Rust has `prefs.update` (`src-tauri/src/prefs.rs:215`).

Plan change: Phase 3 states that every mutation re-reads the store at commit time and writes only the touched tag with no `await` between read and write (Electron: one `Store` instance, synchronous; Rust: `prefs.update`). Test: "a cap set during a measurement survives it".

### M11. A chat turn can start after a measurement began; foreign runners skew `/api/ps`. [FM-2] — Accept-modified (High)

Accepted: gate per probe, not once per run; abort the run when any pool entry turns `running`; discard a probe whose `/api/ps` lists another runner or whose `context_length` is absent or differs from `n`, and record the run as `interrupted` for a later retry. Rejected: holding new prompts in main; the user's turn always wins.

Plan change: Phase 2 algorithm and Phase 3 scheduler, with tests "aborts when a sidecar starts a turn" and "discards a probe with a foreign runner".

### M12. Floor 8192 is below the agent's first request, and misreads collapse to the floor. [FM-4, AD open question] — Accept-modified (High)

Verified: 0001's default is 16384 because Ollama's 4096 is "smaller than the agent's first request" (`patches/omp/0001-…patch`, `model-discovery.ts:163`); the research names 16384 as the floor.

Plan change: see fork (f) and Q3. Floor 16384; a complete floor probe that spills stores `max = 16384, verdict = spills`; an incomplete or ambiguous probe is an `error` with no ceiling written, so the sidecar keeps today's 131072.

### M13. Failures are not persisted, so an unmeasurable model is retried and evicts others every startup. [FM-7] — Accept (High)

Plan change: Phase 3 store entry gains `{ attempts, lastError, lastAttemptAt }`; the stale pass skips a tag that already failed under the current fingerprint; only Measure retries; the first probe's timeout scales with the model's `/api/tags` size (for example 120 s plus one second per 50 MB); a timeout is `error`, never "does not fit".

### M14. The measurement itself can push a machine into swap, and binary search amplifies one noisy probe. [AD-4, FM-5] — Accept-modified (High)

Verified: Ollama clamps `num_ctx` to the trained context and refuses a load that exceeds available system memory with HTTP 500, so a hard OOM is unlikely, but memory pressure on unified memory and page-cache eviction are real. Binary search's first probe lands mid-ladder, which is the worst overshoot.

Plan change: see fork (d) and Q4. Rejected: FM-5's "confirm the winning rung with a second load" on every run; instead re-probe only the first failing rung once after an explicit unload and an empty `/api/ps` poll.

### M15. The ladder breaks on a trained context below the floor or an absurd value. [SA-6] — Accept (Medium)

Plan change: Phase 2 validates `trained` as a safe integer in `[1, 2^24]` (else unknown); `ladder = { rungs <= ceiling } ∪ { ceiling }` with `floor = min(16384, ceiling)`; `clampCap` lower bound `min(16384, maxContext)`. Test rows "trained below the floor" and "absurd trained value" in both engines.

### M16. `set-cap` lacks own-key and tag validation. [SA-7] — Accept-modified (Low)

Plan change: Phase 3 helpers use `Map`/`Object.hasOwn`; every handler validates `isValidModelTag` and `Number.isSafeInteger(cap) || cap === null`; `set-cap` on a tag without a measured entry is rejected. One TS test with a prototype-name tag; Rust keeps the parity name.

### M17. Non-2xx from `/api/show` or `/api/ps` is undefined; both onboarding e2e fakes 404 them; the shared fake server gets routes. [SC-4] — Accept (High)

Verified: `e2e-tauri/onboarding.e2e.ts:50` and `e2e/onboarding.e2e.ts:61` fall through to 404; `test-fake-ollama.ts` is a handler-only server.

Plan change: Phase 2 defines any non-2xx from `/api/show` or `/api/ps`, or a missing `size`/`size_vram`, as `error` (never persisted); the VRAM simulator lives in `context-fit.test.ts`'s handler and the Rust test, not in the shared fake; both onboarding fakes gain `/api/show` and `/api/ps`, or assert that measurement waits for the dialog to close; Phase 5 gates add both e2e suites and `e2e-tauri/check-twins.ts`.

### M18. The persisted shape is larger than needed. [SC-6] — Accept-modified (Medium)

Plan change: Phase 3 store entry is `{ maxContext, trainedContext, pool, verdict, measuredAt, fingerprint, userCap, attempts, lastError, lastAttemptAt }`; `probes[]` is logged by main, not stored; `fingerprintOf`/`isStale` stay in main and Rust. Rejected: dropping `pool`/`verdict`/`trainedContext`, which the row needs.

### M19. Cancel channel and step-counted progress. [SC-7] — Accept-modified (Medium)

Plan change: drop `ollama:context-cancel` (M11's abort-on-turn replaces the user's reason to cancel). Keep one progress event `ollama:context-progress { tag, state: "running" | "done" | "error", numCtx? }`, broadcast to every window, because the run now lives in main and each window must render it. Rejected: dropping progress entirely.

### M20. The Rust spawn path crosses the `omp` → `ollama` module boundary. [SC-8, AD-7b] — Accept (Medium)

Verified: `omp/manager.rs:20-31` imports only `bridge`, `ports`, `product`; `cross-module-calls.json` plus `ports.rs:831-849` enforce the inventory; `omp.parity.json` pairs `sidecar.test.ts` with `manager.rs`.

Plan change: with the overlay carrier, `omp` only needs the overlay file path (a string the GUI already knows, next to the pack dir) to append `--config <path>`; no cross-module parse. Phase 3 names the `manager.rs` spawn test twin, `omp.api.txt`, and gate 5's `rename_all` on new serde types.

### M21. A Modelfile `num_ctx` bounds what the sidecar sends. [FM-9b] — Accept-modified (Low)

Verified: `extractOllamaContextWindow` prefers the runtime `num_ctx` (`model-discovery.ts:316-320`).

Plan change: Phase 2's ceiling is `min(trained, Modelfile num_ctx from /api/show parameters)`, and the row shows that ceiling. Nothing more.

### M22. Lowering a cap below a resumed session's size truncates the next prompt. [FM-10] — Accept-modified (Medium)

Verified: compaction runs from `agent_end` maintenance (`agent-session.ts:4086-4141, 4277`); a `compact` RPC exists (`rpc-mode.ts:2435`).

Plan change: Phase 3, after an effective value drops: for every idle session whose last reported context usage exceeds the new window, main sends `compact` through `commandForIdleSession` (`sidecar-pool.ts:470`) / `command_for_idle_session` (`pool.rs:759`). Phase 5 adds a live check "cap lowered below the session's size". Ollama's silent truncation is verified only from documentation and should be observed in that step.

### M23. The cap misses a configured `ollama` provider in `models.yml` and is overwritten by `modelOverrides`. [AD-8] — Accept-modified (Medium)

Verified: branch condition `provider === "ollama" && api === "ollama-chat"` (`model-registry.ts:1461`), implicit provider only without a configured one (`:1501`), overrides applied after normalisation (`:1406-1411`, `:1975-1980`); the GUI's cleanup keeps an `ollama` entry (`src/main/provider-cleanup.ts:92`).

Plan change: Phase 1 applies the per-model limit after `#applyProviderModelOverrides` for every `ollama` model that uses `ollama-chat`, and adds the test "a modelOverrides contextWindow above the limit is capped". The GUI-side warning is not needed.

### Resolved open questions from the reports

`/api/ps` `context_length` is the running runner's context; with `OLLAMA_NUM_PARALLEL` at its default of 1 it equals `num_ctx`, and M11 turns any mismatch into a discarded probe rather than a stored verdict. The quick-entry window is covered by the pool gate (M1). The `busy` rejection problem for renderer schedulers is gone with M1.

## Architectural forks

### (a) Where the scheduler, busy check and fan-out live — main/Rust

Only main sees every window's sidecars, their `running`/`compacting` state and their session files, and only main can broadcast. The renderer is reduced to buttons and listeners. Rust gets the twin in the `ollama` module, reading the pool through a new `TabsPort` method (`any_in_flight()`), recorded in `cross-module-calls.json`.

### (b) How limits reach the sidecar — a live setting through a GUI-owned `--config` overlay (recommended)

Mechanism: patch 0005 registers `ollama.contextLimits` (type `record`, exact model id → positive safe integer), reads it in the `ollama-chat` normalisation branch with `this.#settings` exactly where 0001 and 0003 already read env and settings, and adds `cfgOllamaContextLimits.listen(this, () => this.#reapplyExtendedContextPolicy())` next to the existing `cfgExtendedContext` listener (`agent-session.ts:2319`). The GUI writes `<userData>/ollama-context-limits.yml` (one key, derived from `ollamaContextFit` with clamps applied) on every change and appends `--config <that path>` after the pack's config. Every running sidecar reloads it through the existing watcher and rebinds within about a second; a new sidecar reads it at start. No env, no restarts, no cross-window fan-out, no M2.

Why not `set_setting` to `settings.json`: `assertKnownSettingPaths` throws on an unknown key (`settings.ts:269-276, 687`), so a patch-only key in the user's global `settings.json` could make the stock `omp` CLI reject that whole layer; the overlay is read only by pack sidecars.

Why this stays inside the locked decision: it is still per-model limits through a new sidecar patch; only the carrier changes. The cost is one more GUI-owned file and a rewrite of AC1 ("`ollama.contextLimits` in a `--config` overlay makes model `m` report and send 32768") and AC4 ("a changed value reaches every running sidecar without a restart; `/api/ps` shows the new `context_length` on the next turn"). What would flip it: a phase 1 test showing that a watcher-triggered overlay reload does not fire `listen` callbacks, or that a mid-turn rebind disturbs the in-flight request (in that case, defer the overlay write until the pool is idle, which is still simpler than restarts).

Option 2 (plan as written, env plus restart) remains viable with M2's rules, at the price of a second scheduling system in two languages.

### (c) GPU-vs-RAM pool — Ollama's `size_vram` from the floor probe

`pool = unifiedMemory ? "ram" : (floorProbe.size_vram > 0 ? "gpu" : "ram")`. GPU test `size_vram >= size`; RAM test `size <= ramBudget` (export `ramReserve` from `ollama-catalog.ts:98` and `catalog.rs:179`). `nvidia-smi` feeds only the fingerprint, and a `null` reading is "unknown", never "changed". This covers AMD, Intel, GPU-less daemons and Apple Silicon (where `size_vram == size` always).

### (d) Avoiding swap during measurement — ascending walk with a predicted stop

Walk the ladder upward from the floor; after two fitting rungs, fit `size(n) = a + b·n` (the research shows linear growth) and stop before loading a rung whose predicted size exceeds the pool budget plus a 10 percent margin; otherwise load the next rung and keep the last one that fits. Every candidate rung is still loaded and measured, so this is load-and-search; the only rungs never loaded are those both predicted and, by monotonicity, certain to fail. Overshoot is bounded to one rung above the last fit, and a single noisy probe cannot delete the upper half of the ladder. Load count is the same order as binary search on a five-rung ladder. Because this narrows the user's "full" wording, it is Q4.

### (e) Precedence with a user-exported `OLLAMA_CONTEXT_LENGTH` — treat it as a hard cap (recommended, Q2)

Both shells already resolve the login-shell env (`#shellEnvVars`, `spawn_env()`). When `OLLAMA_CONTEXT_LENGTH` is present there or in the process env, the GUI writes `min(effective, userValue)` into the overlay and the row says "capped at N by OLLAMA_CONTEXT_LENGTH in your shell". The patch keeps the simple rule "per-model wins over the global". The GUI's own `131072` fallback stays for unmeasured models.

### (f) Floor and failure persistence — 16384, and errors are remembered

Floor 16384. A complete floor probe that still spills stores `max = 16384, verdict = spills` (less spill than today's 131072). Any incomplete, foreign-runner, timeout or non-2xx outcome writes `{ attempts, lastError, lastAttemptAt }` and no ceiling; the automatic triggers skip it under the same fingerprint, and only Measure retries.

### (g) Cloud tags and remote hosts — excluded everywhere

Port 0003's two rules into a shared helper used by `context-list`, `context-measure` and the scheduler, and require a loopback base URL for any measurement. The pack sidecar refuses those models anyway, so measuring them can only cost money or evict another machine's models.

## Plan edits by phase (condensed)

- plan.md: Architecture diagram (scheduler and overlay in main; no env; no restart arrow), AC1, AC4, AC5 ("never while any sidecar in any window is busy"), Risks (free-VRAM lag re-probe; fingerprint unknown rule).
- Phase 1: `ollama.contextLimits` setting (record) instead of env; exact-id lookup; cap applied after `modelOverrides`; listener reuse; tests for the override case and for a live overlay edit.
- Phase 2: ceiling `min(trained, Modelfile num_ctx)` with validation; ladder floor 16384; ascending walk with predicted stop; pool from `/api/ps`; probe discard rules; non-2xx as error; local-only and loopback helpers; scaled first timeout; simulator confined to the engine tests.
- Phase 3: main-owned pref key; canonical tags via `installedName`; trimmed store shape with failure fields; synchronous read-modify-write; overlay file writer in both shells and `--config` at spawn; main/Rust scheduler with pool gate; `compact` for shrunken sessions; corrected Tauri files and count; `TabsPort::any_in_flight` in `cross-module-calls.json`.
- Phase 4: row and toast only; "Applies from the next reply" without the restart clause; no renderer scheduler; the onboarding pull enqueues after the welcome dialog closes.
- Phase 5: both e2e suites and `check-twins.ts`; the live `/api/ps` check also asserts `context_length == num_ctx`; the shrunken-session check; the AMD/CPU-only pool check recorded as skipped if no such machine exists.

## Questions for the user (max 4)

1. Carrier for the limits. Options: (A) live setting through a GUI-owned `--config` overlay, no restarts (recommended); (B) spawn-time env with main-side coalesced restarts as planned. Evidence that would flip to B: a phase 1 test shows overlay reloads do not fire listeners.
2. A user-exported `OLLAMA_CONTEXT_LENGTH`. Options: (A) remains a hard cap on every measured value, shown in the row (recommended, keeps the documented contract); (B) the measured value wins and the env only covers unmeasured models.
3. Floor and the "spills at the floor" result. Options: (A) floor 16384, store 16384 as the ceiling with a `spills` warning (recommended); (B) floor 8192 as planned; (C) write no ceiling and keep 131072 for such models.
4. Search strategy under "full load-and-search". Options: (A) ascending walk that skips only rungs predicted and certain to fail (recommended; bounded overshoot, noise-tolerant); (B) strict binary search over every rung as written, accepting a mid-ladder first load on small machines.

## Assumptions

- A watcher-triggered reload of a `--config` overlay notifies `listen` subscribers (medium-high confidence, from `settings.ts:1040` and the reload path; verify with a monorepo test in phase 1).
- A same-model rebind while a turn streams does not disturb the in-flight request (medium confidence; `#setModelWithProviderSessionReset` skips the reset for the same model; if wrong, defer overlay writes until the pool is idle).
- `/api/ps` on Ollama 0.35 reports `context_length` equal to `num_ctx` with the default `OLLAMA_NUM_PARALLEL=1` (high confidence from docs and source; phase 5 confirms live).
- Ollama truncates an oversized `/api/chat` prompt to `num_ctx` rather than rejecting it (medium confidence, documentation only; phase 5 observes it).
- No AMD or CPU-only machine is available for phase 5; the pool rule is covered by the fake-Ollama tests and recorded as untested live (medium confidence).
