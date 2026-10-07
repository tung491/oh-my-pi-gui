# Red team: Security Adversary + Fact Checker

Plan: `plans/261007-1948-ollama-context-fit/` (plan.md, phases 1-5)
Date: 2026-10-07

## Fact check

| Claim | Result |
|---|---|
| `src/main/sidecar.ts:378` sets `OLLAMA_CONTEXT_LENGTH=131072` | VERIFIED (off by 3: `src/main/sidecar.ts:381`; comment at 379-380) |
| `src-tauri/src/omp/manager.rs:605` sets the same | VERIFIED (`manager.rs:607-608`) |
| 0001 caps `contextWindow` at `model-registry.ts:1461` | VERIFIED in content, line is `../oh-my-pi/packages/coding-agent/src/config/model-registry.ts:1464`; monorepo HEAD already carries 0001 as commit `411f272184` |
| `ramReserve` in `src/shared/ollama-catalog.ts` is private | VERIFIED (`ollama-catalog.ts:98`); Rust twin `catalog.rs:179` also private and not listed in phase 2 Files |
| `fitOf` exists | VERIFIED (`ollama-catalog.ts:108`, `catalog.rs:187`) |
| Hardware facts in `hardware.ts` / `hardware.rs` incl. VRAM | VERIFIED, but VRAM is NVIDIA-only (`hardware.ts:70`, `hardware.rs:55-59`) |
| `loadLaunchProfileFlags` at `sidecar.ts:181` with `new Store({name:"prefs",projectName:"omp-gui"})` | VERIFIED (`sidecar.ts:182-193`) |
| `sidecar.restart(undefined, sessionPath)` at `src/main/ipc.ts:871` | VERIFIED (`ipc.ts:861-872`, window-scoped via `BrowserWindow.fromWebContents`) |
| Tauri restart twin | VERIFIED `sidecar:restart` (`src-tauri/src/tabs/mod.rs:45,84`) |
| Ollama IPC registered in `src-tauri/src/ollama/ipc.rs` | FAILED: channels are registered in `src-tauri/src/ollama/mod.rs:31-52` (`CHANNELS` + `register`); `ipc.rs` only holds handlers |
| `src-tauri/tests/channels.rs` enumerates channels | VERIFIED (`channels.rs:46`, `ollama::CHANNELS, ollama::EMITS`) |
| `isValidModelTag` reusable | VERIFIED (`src/main/ollama/pull.ts:18-23`) |
| `WARM_TIMEOUT_MS` 120 s | VERIFIED (`warm.ts:9`) |
| `ollama.parity.json` pattern | VERIFIED (`src-tauri/contracts/ollama.parity.json`) |
| `ctx.prefs` in Tauri | VERIFIED (`src-tauri/src/ctx.rs:19`) |
| "Main/Rust is the only writer of `ollamaContextFit`" | UNENFORCED: generic `prefs:set` accepts it (Finding 3) |
| `ollama:context-changed` event | UNVERIFIED/MISSING from the phase 3 IPC table and Tauri `EMITS` |

## Finding 1: Automatic measurement contacts Ollama cloud models, bypassing the pack's local-only guarantee
- **Severity:** Critical
- **Location:** Phase 3, IPC table `ollama:context-list` ("installed tags from the probe"); Phase 4, Scheduler ("On startup ... enqueue every `installedUnmeasured` tag"); Phase 2, Algorithm (`/api/show`, `/api/generate`).
- **Flaw:** The installed-tag list comes from `parseTags`, which keeps every `/api/tags` row, including signed-in cloud tags (`kimi-k2:cloud`, `gpt-oss:120b-cloud`) and renamed remote copies carrying `remote_host`. Nothing in the plan filters them. Patch 0003 and the pack's `modelPolicy.localOnly: true` exist so that no cloud model is used, but this engine runs outside the sidecar, so that policy never applies to it.
- **Failure scenario:** A user signed in to Ollama has `gpt-oss:120b-cloud` in `/api/tags`. At startup, with no user action, the scheduler enqueues it as "stale", and the engine sends `/api/show` and up to about 5 `/api/generate` calls. The local daemon forwards these to `https://ollama.com:443` under the user's account. `/api/ps` never lists a cloud model, so every rung "fails" and the store records `maxContext: 8192, verdict: "spills"`. The UI then shows "does not fully fit" for a model the pack does not even allow. It repeats on every start because the fingerprint check also feeds "stale".
- **Evidence:** `src/main/ollama/probe.ts:121-128` (`parseTags`, no cloud or remote filter); `patches/omp/0003-model-policy-local-only.patch:44` (localOnly definition), `:79-84` (`remote_host`/`remote_model` exclusion), `:174-181` (cloud tag rule); `src/main/ollama/register-ipc.ts:76-80` (precedent: `warm` likewise has no cloud check).
- **Suggested fix:** Port 0003's `isOllamaCloudTag` plus the `remote_host`/`remote_model` row check into a shared `isLocalOllamaRow` helper (TS and Rust twins, with parity tests), and apply it in `context-list`, in `context-measure` (reject with `not-local` before any request), and in the scheduler. Add tests named "skips cloud tags and remote copies without any request".

## Finding 2: The engine measures whatever host the login shell names, and judges it against this machine's hardware
- **Severity:** High
- **Location:** Phase 2, Algorithm (`measure(baseUrl, …)`, `ram: ps.size <= ramBudget(machine)`); Phase 3, "isStale".
- **Flaw:** `baseUrl` comes from `resolveOllamaBaseUrl`, which takes `OLLAMA_BASE_URL`/`OLLAMA_HOST` from the login shell or launch env. That can be a LAN or remote host. `machine` and the fingerprint come from local `readMachine` (local RAM and local `nvidia-smi`). The plan never requires a loopback endpoint.
- **Failure scenario:** `OLLAMA_HOST=gpu-box.lan:11434` in `~/.zshrc`. Startup auto-measures every model on the shared box, and the final `keep_alive: 0` unload evicts models that other users of that box are serving. On a RAM-pool laptop, `ps.size` is compared against the laptop's RAM budget, so the stored max is meaningless. Meanwhile the pack sidecar (localOnly) refuses every non-loopback model anyway, so the measurements buy nothing and only cost availability on another machine.
- **Evidence:** `src/main/ollama/base-url.ts:47-66` (shell env wins, any host accepted); `src/main/ollama/hardware.ts:68-75` (local facts); `patches/omp/0003-model-policy-local-only.patch:44` (loopback-only rule the sidecar enforces).
- **Suggested fix:** Gate measurement (both shells) on the same loopback rule as 0003 (`localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`; no DNS names). On a non-loopback endpoint, `context-list` returns no candidates and `context-measure` rejects with a stated reason. Add one test per shell.

## Finding 3: "Main is the only writer" is not enforced, so the renderer can forge `maxContext` through generic `prefs:set`
- **Severity:** High
- **Location:** Phase 3, IPC section ("Main/Rust is the only writer of `ollamaContextFit`, and the renderer never writes it through generic prefs").
- **Flaw:** This is stated as a convention, not as a control. Generic `prefs:set` refuses only `MAIN_OWNED_PREF_KEYS = {quickEntryShortcut, quickEntryTarget}` in both shells. `parseContextFitStore` checks shape, but it cannot tell a forged `fit.maxContext` from a measured one, and `clampCap` clamps against that same forged value.
- **Failure scenario:** Any renderer code path, such as a future settings import, a bug, or injected script in the main-scope webview, calls `prefs.set("ollamaContextFit", {version:1, models:{"gemma4:e4b":{fit:{…maxContext:1048576…}, userCap:null}}})`. At the next spawn the sidecar sends `num_ctx` up to the trained context, which is exactly the CPU spill or OOM case the feature exists to prevent. AC3 ("a value above is rejected") is defeated without ever touching `context-set-cap`.
- **Evidence:** `src/main/ipc.ts:829-834`; `src/main/quick-entry-shortcut-core.ts:72-80`; `src-tauri/src/desktop/shortcut_core.rs:286-291`; `src-tauri/src/services/ipc.rs:311-316`.
- **Suggested fix:** Add `ollamaContextFit` to `MAIN_OWNED_PREF_KEYS` in both shells, in the Files list of phase 3, with tests next to `prefs_set_refuses_a_main_owned_key…` (`services/ipc.rs:622`) and its TS twin. Also consider not returning the key from `prefs:get` without a reason.

## Finding 4: Spawn-env precedence is unspecified: an inherited `PI_OLLAMA_CONTEXT_LIMITS` survives, and the per-model value silently overrides a user's `OLLAMA_CONTEXT_LENGTH`
- **Severity:** Medium
- **Location:** Phase 3, "Spawn env"; Phase 1, Requirements (lookup order).
- **Flaw:** (a) The plan sets the variable only "when it is non-null". When the store is empty or unreadable, a `PI_OLLAMA_CONTEXT_LIMITS` from `process.env` or the login shell (`#shellEnvVars` is the full shell env minus `OVERLAY_DENYLIST`) reaches the sidecar unchecked. In Tauri, `Command` inherits `std::env` and only `REMOVED_ENV` is stripped. "Next to the existing env block" also invites placing it in the object literal before `...process.env`, where inherited values win. (b) The current code deliberately lets a user-set `OLLAMA_CONTEXT_LENGTH` win (comment at `sidecar.ts:379-380`, `manager.rs:605-607`). Under phase 1's lookup the per-model value replaces the global, so a user who exported `OLLAMA_CONTEXT_LENGTH=16384` to save memory gets the measured 131072 instead, with no notice.
- **Failure scenario:** The store is empty on first run, and a stale `export PI_OLLAMA_CONTEXT_LIMITS='{"gemma4:e4b":262144}'` in `.bashrc`, left over from testing, drives `num_ctx` straight past the measured fit.
- **Evidence:** `src/main/sidecar.ts:378-398`; `src/main/shell-env.ts:30-60` (denylist lacks the key); `src-tauri/src/omp/manager.rs:596-616`; `src/main/assistant-pack.ts:234-242`.
- **Suggested fix:** Always delete the inherited key after the `ASSISTANT_PACK_REMOVED_ENV` loop (`env_remove` in Rust), then set the GUI value when it is non-null. Add the key to `OVERLAY_DENYLIST`. Decide and document whether a user `OLLAMA_CONTEXT_LENGTH` caps the per-model value (for example `min(perModel, userGlobal)`), and test it in both shells.

## Finding 5: Multi-window breaks the "one scheduler, never while any tab streams" guarantee, and the restart fan-out misses other windows
- **Severity:** High
- **Location:** Phase 4, Scheduler ("owned by the main window … so only one instance runs"; "restart every idle tab's sidecar"); Phase 3, "Applying a change"; AC4 and AC5.
- **Flaw:** There is no single main window. `SidecarPool` serves several chat windows, and `ProvidersWindow` is a `Modal` rendered inside every window's `App.tsx`. Each window boots the same root, so each starts its own scheduler, and each scheduler's "no tab streaming" check sees only that window's tab store. `sidecar:restart` resolves the sidecar from `BrowserWindow.fromWebContents(event.sender)`, so a window can restart only its own tabs. Main's single-flight serializes measurements but does not gate them on streaming. `ollama:context-changed` is also missing from the phase 3 IPC table and from Tauri `EMITS`.
- **Failure scenario:** Window A streams a reply on `gemma4:e4b` while window B starts, finds the model stale, and runs a measurement. The probe reloads the same model at 8k/16k/… and the final `keep_alive: 0` unloads it, so window A's next request pays a cold reload or hits a mid-turn reload. After a cap change, window B's idle tabs restart with the new env, but window A's never do, so AC4's "`/api/ps` shows the new `context_length` on the next turn" fails there.
- **Evidence:** `src/main/sidecar-pool.ts:117,459-466`; `src/main/index.ts:311` (`spawnWindow`); `src/renderer/components/settings/ProvidersWindow.tsx:46,246` (Modal per window); `src/main/ipc.ts:861-872`; `src-tauri/tests/channels.rs:46` (`ollama::EMITS`).
- **Suggested fix:** Move the queue and the streaming gate into main/Rust, which can see every sidecar in the pool (a `pool.anyStreaming()`), and broadcast `context-changed` to all webContents (the same pattern as `broadcastInstallProgress`). Alternatively, have main restart idle sidecars itself and defer streaming ones to `agent_end`. Add `ollama:context-changed` and `ollama:context-progress` to the IPC table, `ipc-types.ts` events, and Tauri `EMITS`.

## Finding 6: The ladder and floor break on untrusted or small `/api/show` contexts
- **Severity:** Medium
- **Location:** Phase 2, Algorithm (`ladder`, `floor = ladder[0]`, "missing → 131072"); Phase 3, `clampCap` ("[ladder floor, maxContext]").
- **Flaw:** The `context_length` from `/api/show` is untrusted daemon output. The plan handles only "missing". For `trained < 8192` that is a power of two (2048 or 4096, common for small models), the ladder is `[]`, so `floor = ladder[0]` is `undefined`, `maxContext` becomes `undefined`/`NaN` in TS (Rust panics on indexing), and the stored entry is garbage. Even when it is handled, `num_ctx: 8192` would be sent to a 4096-trained model. Values such as `0`, negative, fractional, `1e300` or above `Number.MAX_SAFE_INTEGER` are not addressed, and a Rust `u64` above 2^53 round-trips lossily through the shared JSON prefs. `clampCap` uses floor 8192 even when `maxContext < 8192`, so no cap is valid.
- **Failure scenario:** The user pulls `tinyllama` (trained 2048). Auto-measure runs after the pull, an empty ladder is indexed, and the TS engine persists `maxContext: undefined`. `parseContextFitStore` drops the entry, so it is "unmeasured" again and re-enqueued on every start, in an endless loop. The Rust engine panics in the measurement task.
- **Evidence:** Phase 2 Algorithm text; `src/main/ollama/probe.ts:116-118` (`isRecord` is the only shape guard style in place); patch 0001 `model-registry` cap expects a safe integer (`patches/omp/0001-ollama-native-api-num-ctx.patch`, ollama.ts `Number.isSafeInteger(contextWindow)`).
- **Suggested fix:** Validate `trained` as a safe integer in `[1, 2^24]`, otherwise treat it as unknown. Define `ladder = rungs ≤ trained ∪ {trained}`, always non-empty with `floor = min(8192, trained)`. Make `clampCap`'s lower bound `min(8192, maxContext)`. Add the matrix rows "trained below the floor" and "absurd trained value" to both engines.

## Finding 7: `context-set-cap` / store lookups lack own-key and tag validation
- **Severity:** Medium
- **Location:** Phase 3, IPC table (`ollama:context-set-cap {tag, cap}`), Store shape (`models: Record<string, ContextFitEntry>`).
- **Flaw:** The plan applies `isValidModelTag` only to measurement (phase 2 test list). For `set-cap` it specifies only the range check. `TAG_PATTERN` accepts `constructor`, `toString` and `hasOwnProperty`. On a plain-object `models`, `models["constructor"]` is truthy (`Object`), so "entry exists" passes and `entry.fit.maxContext` throws or yields `NaN`. The plan also does not say that set-cap on a tag with no entry is rejected rather than creating one.
- **Failure scenario:** The renderer sends `context-set-cap {tag:"constructor", cap: 8192}`. Main throws an uncaught `TypeError` inside the handler, or, depending on the implementation, writes `models.constructor = {fit: undefined, userCap: 8192}`, which the next spawn's `contextLimitsEnv` serializes or crashes on.
- **Evidence:** `src/main/ollama/pull.ts:18-23` (`/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/`); `src/main/ollama/register-ipc.ts:33-35` (`tagOf` precedent, unchecked `unknown`).
- **Suggested fix:** Use `Map`/`Object.create(null)` plus `Object.hasOwn` in `context-fit-store.ts`. Every handler validates `isValidModelTag(tag)` and `Number.isSafeInteger(cap) || cap === null`, and set-cap requires an existing measured entry. Add tests for prototype-name tags in TS (Rust `HashMap` is immune, but keep the parity names).

## Finding 8: GPU pool detection is NVIDIA-only, so AMD/Intel GPU machines get a RAM-pool "fit" that hides VRAM spill
- **Severity:** Medium
- **Location:** Phase 2, Algorithm (`pool = machine.vramBytes > 0 && !unifiedMemory ? "gpu" : "ram"`).
- **Flaw:** `vramBytes` comes only from `nvidia-smi`. On a Linux ROCm (AMD) or Vulkan machine, Ollama loads onto the GPU (`size_vram > 0`), but the plan picks the `ram` pool and accepts any rung with `size <= ramBudget`. The large rungs that spill from VRAM to CPU then count as "fits", which defeats the stated outcome (no CPU spill).
- **Failure scenario:** On an RX 7800 XT (16 GiB) with 64 GiB RAM, every rung up to 131072 "fits" the 48 GiB RAM budget. The model runs with half its layers on the CPU at the measured "max", and replies are several times slower, with the UI claiming "measured on GPU"-equivalent safety.
- **Evidence:** `src/main/ollama/hardware.ts:68-75`; `src-tauri/src/ollama/hardware.rs:33-59` (`NvidiaGpu`, `run_nvidia_smi`).
- **Suggested fix:** Decide the pool from the first probe's `/api/ps` (`size_vram > 0` and not unified memory → gpu, `size_vram >= size` test), not from `nvidia-smi`. Add the matrix row "uses the GPU rule when the daemon reports VRAM the hardware probe missed".

## Finding 9: A whole-key read-modify-write across a minute-long measurement loses concurrent cap changes
- **Severity:** Medium
- **Location:** Phase 3, Context ("a single top-level key … read and written whole") and IPC (`context-measure` "persists the result and keeps an existing `userCap`").
- **Flaw:** The plan does not say when the store is read relative to persist. A measurement takes up to about 60 s across awaits. If the engine snapshots `ollamaContextFit` at start (natural, since it needs the old `userCap`) and writes the whole key at the end, any `context-set-cap` for any tag during that window is overwritten. In Electron, main also has several independent `Store` instances (`ipc.ts` `prefsStore`, `sidecar.ts` new `Store` per spawn, and now `register-ipc`).
- **Failure scenario:** While `gemma4:e4b` is measuring, the user lowers `gemma4:e2b` to 16k and sees the toast "Context set to 16k". At measurement end the e2b cap silently reverts to null, and the next restart sends the full max.
- **Evidence:** `src/main/sidecar.ts:190` (`new Store(...)` per read); `src/main/ipc.ts:829-834` (separate `prefsStore`); `src-tauri/src/prefs.rs:1-5` (the Tauri mutex serializes single ops, not read-modify-write across awaits).
- **Suggested fix:** Specify that every mutation is a synchronous read-modify-write of only the touched tag, done at persist time with no await between read and write. Add a test: "a cap set during a measurement survives it".

## Not attacked (locked user decisions)
Per-model limits via patch 0005, full load-and-search, and the three triggers are accepted. The findings above target only how they are implemented.

## Unresolved questions
- Should a user-exported `OLLAMA_CONTEXT_LENGTH` cap the measured per-model value (Finding 4b)? This is a product decision.
- Is `prefs:get` returning `ollamaContextFit` (with `gpuName` and RAM/VRAM sizes) to any main-scope renderer acceptable? It is low sensitivity, but worth a decision.
