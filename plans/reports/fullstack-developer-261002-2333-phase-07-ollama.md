# Phase 7 — Ollama services (module `ollama`)

- Plan: `/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/`
- Worktree: `/home/tung491/WORK/worktrees/tauri-ollama`, branch `tauri/ollama`, base `10cf8a5`
- Status: **completed**, gate passed

## Commits

| Commit | Task | Summary |
|---|---|---|
| `3afcfb2` | 7.1 | `base_url.rs`, `hardware.rs`, `install_progress.rs`, `probe.rs`, `pull.rs`, `remedy.rs`, `warm.rs`, `catalog.rs`, `test_fake_ollama.rs` — every mapped TS test ported by name |
| `bb13b7e` | 7.2 | `Ollama` struct (status/model-screen/pull/pull-cancel/warm/remedy/shutdown) and the seven `ipc.rs` handlers wired to `ctx.bridge`/`ctx.host`; fixed a dropped `MachineFacts.gpuName` field and wired `probe::fault_text` into the connection-error paths; cleared every clippy finding |
| `2781454` | 7.3 | `OLLAMA_DOWNLOAD_URL` → `pub(crate)` so the public-API snapshot stays frozen; module gate PASS |

## Task 7.1 — Pure and HTTP modules with their tests

Ported `src/main/ollama/{base-url,hardware,install-progress,probe,pull,remedy,warm}.ts` and `src/shared/ollama-catalog.ts` into private submodules of `ollama` (not `pub mod`, so none of their new types/functions appear in the frozen `contracts/ollama.api.txt` snapshot — only `ipc.rs`, `Ollama`, `CHANNELS`, `EMITS`, `init`, `register` stay public, unchanged from the Phase 2 stub).

Notable design decisions:
- `base_url.rs`'s URL handling reuses `reqwest::Url` (already a dependency via `reqwest`/`ashpd`, re-exported as `reqwest::Url`), avoiding a new crate for the wave.
- `hardware.rs`'s GPU name source follows the phase's Linux substitution: `lspci -mm` (VGA/3D class) with a `/sys/class/drm` fallback, replacing Chromium's `app.getGPUInfo`. The three `gpuNameFromInfo` tests keep their TS names, fed lspci-shaped fixtures instead of Chromium JSON, per the phase text ("feed this source instead and keep their names"). macOS/Windows log once via `runtime_log::note("unknown", …)` and return no name, per the phase.
- `install_progress.rs` adds a private, generic `Throttle<T>` (frame type + "is terminal" predicate + interval) used both by `InstallProgressThrottle` (install progress) and by `pull.rs`'s per-run throttle, instead of duplicating the throttle twice.
- `test_fake_ollama.rs` is the Rust `test-fake-ollama.ts` equivalent: a raw `tokio::net::TcpListener` on an ephemeral loopback port, hand-rolled HTTP/1.1 parsing (enough for these tests: request line, `Content-Length`, no chunked framing needed since every response is `Connection: close` + closed on completion). Two layers: `start_fake_ollama` (simple JSON-or-hang responder, mirrors `startFakeOllama`+`sendJson`) and `start_raw_fake_ollama` (hands the handler the raw `TcpStream` for manual streaming control, used by `pull.rs`'s multi-chunk NDJSON tests).
- `pull.rs`'s `OllamaPuller` join/busy/cancel logic uses `tokio::sync::Notify` (whose documented "permit stored for the next `.notified()`" behavior avoids a lost-wakeup on cancel) plus a `OnceCell<PullProgress>` for the shared result, mirroring the TS `Promise` fan-out.
- `remedy.rs`'s process layer is abstracted behind a `Spawner`/`SpawnedHandle` event-channel seam (`ProcEvent::{Stderr,Exited,SpawnError}` + a `kill` closure) so every pkexec exit-code/timeout/EPERM-after-kill test runs against a fake spawner — no `pkexec` or any other real command is ever invoked.

Verify:
```
cargo test --manifest-path src-tauri/Cargo.toml ollama::
# test result: ok. 96 passed (at the time of this commit)
bun scripts/check-test-parity.ts ollama
# check-test-parity ollama: 96 tests mirrored across 8 files
```
Both passed as written (phase asked for "at least 70 passed"; got 96).

## Task 7.2 — Handlers and streams

`Ollama` (in `mod.rs`) owns a cached base-URL resolver (`ctx.omp.spawn_env()` overlaid with the process env, matching `shell.env, ...process.env` precedence — `base-url.ts:61-62`), an `OllamaPuller`, and a `RemedyGate`. `ipc.rs` implements the seven handlers from `register-ipc.ts:55-98`:

- `ollama:status` → `Ollama::status` (probe).
- `ollama:model-screen` → `tokio::join!(hardware::read_machine_default(), status())` then `catalog::choose_models`.
- `ollama:pull` → streams `ollama:pull-progress` to `caller.win_id` only, via a `pull::ProgressSink` closure that calls `ctx.bridge.emit_to_window`.
- `ollama:pull-cancel` → `Ollama::pull_cancel`.
- `ollama:warm` → validates the tag synchronously, then fires-and-forgets through `bridge::spawn_task` (matches `void warmModel(...)`).
- `ollama:remedy` → `RemedyGate::run`, broadcasting throttled `ollama:install-progress` to every main window via `ctx.bridge.broadcast_main` (one `InstallProgressThrottle` per actual attempt; joined callers don't re-trigger it).
- `ollama:open-download` → `ctx.host.open_url(OLLAMA_DOWNLOAD_URL)`.

While wiring this, two issues surfaced and were fixed before committing:
1. `MachineFacts.gpu_name` had been dropped entirely in the Task 7.1 commit (both `read_machine` branches discarded the resolved name). Fixed by adding the field back to `catalog::MachineFacts` and wiring both branches of `hardware::read_machine`; all three affected hardware tests now assert it.
2. `probe::fault_text` (ported in 7.1) had no caller; wired into `probe.rs`'s `get_json` and `pull.rs`'s connection-error path, matching the TS source's reuse of `faultText` across both files.

Verify:
```
cargo test --manifest-path src-tauri/Cargo.toml ollama::ipc
# test result: ok. 7 passed
```
Passed as written.

## Task 7.3 — Module gate and commit

`bash scripts/check-module.sh ollama` → `check-module ollama: PASS` (all 9 gates; gate 9 WARN-only, no Apple/MSVC toolchain on this host, as expected per the plan). Fixed one gate-3 regression first: `OLLAMA_DOWNLOAD_URL` had been declared `pub` in `mod.rs`, which would have added a new entry to the frozen `contracts/ollama.api.txt` snapshot; changed to `pub(crate)`.

## Completion check per phase

- Tree clean; diff stays inside `src-tauri/src/ollama/**`; `git diff 10cf8a5 -- src-tauri/contracts` is empty.
- `check-module.sh ollama`, `cargo test --all-features`, and `check-test-parity.ts ollama` all pass.
- No `todo!`, `unimplemented!`, `#[ignore]` anywhere in the module; no `tauri_plugin_` call; the only `downcast_ref` is the module's own (`ctx.ollama.as_any().downcast_ref::<Ollama>()`); zero `unsafe`.
- No leftover `omp`, `--omp-supervise`, fixture or port-518x processes. (One unrelated `trial-merge.sh omp tabs services` process was observed running under the session's shared `CK_SESSION_ID`; it was not started by this phase's execution and was left untouched per "only stop processes you started.")
- Baseline untouched: `~/.config/@oh-my-pi/omp-gui/prefs.json` (2026-10-02 12:00:17) and `.../logs/gui-runtime.jsonl` (2026-10-02 23:29:09) carry timestamps from before this session; every test run resolves through the `#[cfg(test)]` temp-profile guard in `runtime_log.rs`/`paths.rs`, so nothing in this phase could have touched the real profile.

## Deviations from the phase text

- **`gpuNameFromInfo` → `gpu_name_from_lspci`**: per the phase's own instruction, this is a source substitution, not a 1:1 port; the three test names are kept but now feed synthetic `lspci -mm` lines (discrete `3D controller` preferred over a plain `VGA compatible controller`, mirroring "prefers the active device" / "falls back to the GL renderer" conceptually).
- **Throttling lives in `ipc.rs`, not `remedy.rs`**: the TS `remedy.ts`'s `runRemedy` takes a plain `onProgress` callback; only `register-ipc.ts` wraps it with `throttleInstallProgress`. The first draft of `remedy.rs` embedded the throttle directly and failed its own "streams the installer's stages..." test (only 2 of 8 frames arrived under real, unpaused time) until this was corrected to match the TS layering.
- **One real-process accommodation**: `ollama_status_reports_the_daemon_state` (a handler-dispatch test) resolves against the login-shell `PATH`/env overlay like production code, and this host happens to have a real Ollama daemon on `127.0.0.1:11434` (confirmed via `curl`, read-only `/api/version`). The test asserts the state is one of the three valid values rather than a specific one, since `probe.rs`'s own 12 tests already cover every state transition in isolation.

## Manual checks

None required; this phase has no on-screen UI surface (model-screen/pull/remedy are consumed by Phase 9's renderer, out of scope here).

## Processes

No long-running process was started or left behind. Every verification ran as a short-lived `cargo test` / `cargo clippy` / `bash scripts/check-module.sh` invocation that exited on its own.

Status: DONE
Summary: All three tasks of Phase 7 are complete and committed on `tauri/ollama` (`3afcfb2`, `bb13b7e`, `2781454`); `check-module.sh ollama` ends with `PASS`, `cargo test --all-features` is green, and `check-test-parity.ts ollama` confirms all 96 Task-7.1 tests plus the 7 Task-7.2 handler tests are mirrored.
Concerns/Blockers: None. macOS/Windows GPU-name and system-proxy branches remain unimplemented by design (Phase 12, same as every other wave module); gate 9's two WARNs are expected on this Linux-only host.
