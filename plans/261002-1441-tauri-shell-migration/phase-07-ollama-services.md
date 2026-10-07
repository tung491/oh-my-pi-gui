---
phase: 7
title: "Ollama: probe, hardware, model screen, pull, remedy, warm"
status: pending
priority: P2
effort: "4d"
dependencies: [2]
module: ollama
---

# Phase 7: Ollama services (module `ollama`)

## Goal

Rust serves the seven `ollama:*` channels and the two progress streams exactly as `src/main/ollama/*` and `src/main/ollama/register-ipc.ts` do, including the Gemma-only model screen (`chooseModels` over `OLLAMA_CATALOG` from `src/shared/ollama-catalog.ts`) and the Linux installer with streamed progress.

## Wave rules

Same as Phase 3 (`phase-03-omp-processes.md` → Wave rules, including "Frozen wiring"), with these substitutions: worktree `../worktrees/tauri-ollama`, branch `tauri/ollama`, owned path `src-tauri/src/ollama/**`, gate `bash scripts/check-module.sh ollama`.

Cross-module calls go only through the frozen traits: `ctx.omp.spawn_env()` for the login-shell environment (`base-url.ts:7` imports `resolveLoginShellEnv` and `probe.ts:9` imports `spawnPath`; both map to this one `OmpPort` method), `ctx.bridge` (`emit_to_window`, `broadcast_main`) and `ctx.host.open_url`. No other module calls `ollama` except the frozen shutdown order (`OllamaPort::shutdown`, step 5). `Ollama::new(ctx: CtxRef)` reaches them through `self.ctx()`. The handlers reach the active pull and the remedy gate with `ctx.ollama.as_any().downcast_ref::<ollama::Ollama>()`. Tests build the context with `testing::fake_ctx_cyclic(&fakes, registry, |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))))` and script the environment through `fakes.omp.env`.

## Files (owned)

- `src-tauri/src/ollama/mod.rs`, `src-tauri/src/ollama/ipc.rs`
- Create as needed: `base_url.rs`, `hardware.rs`, `install_progress.rs`, `probe.rs`, `pull.rs`, `remedy.rs`, `warm.rs`, `catalog.rs`

## Tasks

### Task 7.1: Pure and HTTP modules with their tests
- Goal: ports with all tests.
- Targets and test counts: `base_url.rs` ← `base-url.ts` (5), `hardware.rs` ← `hardware.ts` (11), `install_progress.rs` ← `install-progress.ts` (7), `probe.rs` ← `probe.ts` (12), `pull.rs` ← `pull.ts` (12), `remedy.rs` ← `remedy.ts` (21), `warm.rs` ← `warm.ts` (2), `catalog.rs` ← `src/shared/ollama-catalog.ts` (its tests in `src/shared/ollama-catalog.test.ts`).
- Steps:
  1. For each pair, read the TS file and test, then port. HTTP goes through `reqwest` 0.12 (`Cargo.toml` features `json`, `stream`, `rustls-tls`; do not use 0.13 APIs). `/api/pull` is a streaming NDJSON response: read it with `bytes_stream()` and split on newlines. The base URL and the probe's `PATH` come from `ctx.omp.spawn_env()` as above: `base-url.ts:61-62` reads `OLLAMA_HOST` from `{ ...shell.env, ...process.env }`, which equals the `spawn_env()` overlay with the process environment laid over it, because `OLLAMA_HOST` is not in `OVERLAY_DENYLIST` (`shell-env.ts:31-53`); the probe's `PATH` is `spawn_env()["PATH"]` (TS `spawnPath()`).
  2. Tests that used `src/main/ollama/test-fake-ollama.ts` get a Rust equivalent: a `tokio` TCP listener in a private `#[cfg(test)]` helper serving the same canned responses.
  3. `hardware.rs` detects GPUs and memory the way the TS does, with the same commands through `tokio::process` and the same parsing. The non-NVIDIA GPU name came from Chromium's `app.getGPUInfo("complete")` (`hardware.ts:25-26, 128`), which has no Rust equivalent. On Linux, read it from `lspci -mm` (VGA/3D class), falling back to `/sys/class/drm/card*/device/{vendor,device}`. The tests that fed `gpuInfo` feed this source instead and keep their names. macOS (`system_profiler SPDisplaysDataType`) and Windows come in Phase 12; until then those branches return no name and log `runtime_log::note("unknown", "GPU name lookup is not implemented on this OS", json!({}))` once.
  4. `remedy.rs` keeps the allowlisted remedy ids (`isRemedyId`), the remedy gate (one at a time) and the `pkexec` install path with no cancel (the user decided on 2026-10-02 that a root child of `pkexec` cannot be stopped safely).
  5. `catalog.rs` keeps the exact sizing rules and the three Gemma rows. The same TS file still serves the renderer; a comment at the top of `catalog.rs` says it must change together with `src/shared/ollama-catalog.ts`.
- Success criteria: every mapped TS test has a Rust test with the normalized name.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml ollama::` exits 0 with at least `70 passed`, and `bun scripts/check-test-parity.ts ollama` exits 0.

### Task 7.2: Handlers and streams
- Goal: the seven handlers from `register-ipc.ts:55-98`, and pull/install progress streamed to the requesting window.
- Target: `ipc.rs`.
- Steps:
  1. `ollama:status` → `probe::probe_ollama`. `ollama:model-screen` → `hardware::read_machine` + `catalog::choose_models`. Both reply through `Reply::Later`.
  2. `ollama:pull(tag)` validates with `is_valid_model_tag`, then streams `ollama:pull-progress` to `caller.win_id` only with `ctx.bridge.emit_to_window(caller.win_id, "ollama:pull-progress", …)` (TS sends to `event.sender`). `ollama:pull-cancel` cancels the active pull, and so does `OllamaPort::shutdown` when the app quits mid-pull.
  3. `ollama:warm`; `ollama:remedy`, which broadcasts throttled `ollama:install-progress` to every main window with `ctx.bridge.broadcast_main("ollama:install-progress", …)` (`register-ipc.ts:26-31`: the welcome screen and Settings may both watch one run, and the gate merges repeat requests into it); `ollama:open-download` → `ctx.host.open_url(OLLAMA_DOWNLOAD_URL)` with the TS URL (`register-ipc.ts:24`).
  4. One dispatch test per handler through `bridge::dispatch_for_test`, with the real `Ollama` installed by `testing::fake_ctx_cyclic`, against the test fake server.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml ollama::ipc` exits 0 with at least `7 passed`.

### Task 7.3: Module gate and commit
- Verify: `bash scripts/check-module.sh ollama` exits 0 with last line `check-module ollama: PASS`. Then commit `feat(gui): serve Ollama setup from the Tauri core`.

## Status report

End with `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, a summary, and concerns. `DONE` is invalid unless the gate passed.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
