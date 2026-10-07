# Phase 2 review fixes on `tauri/foundation`

Date: 2026-10-02 (Asia/Seoul). Worktree `/home/tung491/WORK/worktrees/tauri-foundation`, branch `tauri/foundation`, `d4ce82e` → `10cf8a5` (8 commits). Nothing pushed or merged; `git status` is clean. Spec: `plans/reports/code-reviewer-261002-2143-phase-02-foundation.md`. Every finding was re-verified against the code before it was changed; none was found to be wrong.

## Per finding

| Finding | Verdict | What changed | Commit |
|---|---|---|---|
| H1 handler panic wedges the window | Confirmed (`draining` reset was straight-line after `run_call`; nothing caught an unwind). | `run_call` wraps the handler in `catch_unwind` and the `Later` future in `FutureExt::catch_unwind`; a panic rejects the call with `handler for <channel> panicked` and logs `main-uncaught`. The drainer role is held by a `DrainerRole` guard that hands it back on drop. | `39fd6bf` |
| H2 reattach during a drain | Confirmed (`draining` per window, `drain` per generation, flushed calls bypassed the drainer). | The drainer is per window: it runs `window.ready` (calls flushed from the superseded generation) first, then the current generation at `next_seq`. `attach` moves flushed calls into `ready` instead of running them. The drainer releases its role and re-checks for work under one lock, so a call admitted during the hand-off is never left behind. | `39fd6bf` |
| M1 outbound lost across a reload | Confirmed (bridge learned of a new page only at `omp_attach`; `Channel::send` into a navigated page returns `Ok`). | `Bridge::detach(win_id)` clears the sink and keeps the generation; `build_window` registers `.on_page_load` and calls it on `PageLoadEvent::Started` (`BuilderCall::ReloadDetach`). | `39fd6bf`, `a6dead9` |
| M2 live emits overtake the replay | Confirmed. | The replay is sent while the state lock is held, so a concurrent emit sees the new sink only after the replay is in flight. Sinks only post to the event loop (or record, in tests) and never re-enter the bridge; the docs say so. | `39fd6bf` |
| M3 failed send re-queued into replay state | Confirmed (also unbounded). | `retire_sink`: if a newer channel is attached, the message is retried there; otherwise the dead channel is dropped and the message goes through the same bounded `queue_for_replay` path as pre-attach messages. | `39fd6bf` |
| M4 drop log under the lock, unthrottled | Confirmed. | The drop is counted under the lock; `note_dropped` logs after releasing it, at most once per 60 s per `(window, channel)`, carrying `suppressedSinceLast`; the table is cleared past 256 pairs. | `39fd6bf` |
| M5 tests write the real crash log | Confirmed (the executor's and reviewer's runs had appended to it). | Under `cfg(test)` the process-wide log defaults to `<temp>/sai-atlas-tests/<pid>-gui-runtime.jsonl`. `paths::resolve_user_data_dir` panics in test builds when it would resolve the default profile, so any test touching `user_data_dir()`, `runtime_log_path()`, `webview_data_dir()`, `is_default_profile()` or `single_instance_id()` fails; `resolving_the_default_profile_inside_a_test_is_refused` covers the guard. Prefs were already on temp dirs through `Fakes`. | `fe94ddf` |
| M6 second SIGTERM/SIGINT ignored | Confirmed. | After the first signal calls `app.exit(0)`, the listener keeps waiting: a second signal, or a 15 s deadline (`SIGNAL_EXIT_DEADLINE`), logs and calls `std::process::exit(128 + signo)`. | `d830b75` |
| M7 sandbox assertion skipped on `with_webview` error | Confirmed. | On `Err`, log and `std::process::exit(SANDBOX_MISSING_EXIT_CODE)` for every window built this way. | `a6dead9` |
| M8 blob downloads (controller's decision) | Confirmed (`navigation_allowed` failed the path check for `blob:tauri://localhost/<uuid>`; no download handler). | `download_allowed` accepts only a `blob:` URL whose inner origin is the app's (or the dev origin in debug); `navigation_allowed` defers to it for `blob:`. `build_window` registers `.on_download` (`BuilderCall::DownloadHandler`): the request is staged under a hidden `.<name>.<pid>-<n>.part` in the Downloads folder (where wry's default already wrote), and on `Finished` a spawned task runs `Host::save_dialog` (default `<Downloads>/<suggested name>`, parent = the window) and moves the file there, removing it on cancel or failure. The dialog cannot run inside the request callback, which runs on the main thread the dialog needs. No new channel; the inventory stays at 94. `LogPanel.tsx` is unchanged. | `a6dead9` |
| L1 `tauri.localhost` on every OS | Confirmed. | `is_app_origin` accepts `http(s)://tauri.localhost` only under `cfg!(windows)`; test `tauri_localhost_is_the_app_origin_only_on_windows`. | `a6dead9` |
| L2 default-profile identity gaps | Confirmed. | `is_default_profile` compares the resolved dir to `default_user_data_dir()`; the hash uses the resolved path (`single_instance_id_for(Some(user_data_dir()))`). | `fe94ddf` |
| L3 unreadable store read as empty | Confirmed. | Only `NotFound` reads as empty. Any other read error logs and marks the store unreadable; every write returns `StoreError::Unreadable` and the file is left alone. Test `an_unreadable_store_refuses_to_overwrite_the_file`. | `caffc3a` |
| L4 missing config dir → relative profile | Confirmed. | `default_user_data_dir()` returns `NoConfigDir`; `run()` resolves the profile first and exits with `STARTUP_FAILURE_EXIT_CODE` on stderr (there is no log location yet). `user_data_dir()` panics instead of inventing a path if called before that validation. | `fe94ddf` |
| L5 phantom single-instance test | Confirmed. | Pure `single_instance_id_for(Option<&Path>)`; `derives_a_profile_specific_single_instance_id` calls it. | `fe94ddf` |
| L6 missing tests | Confirmed. | See "Tests added". | `39fd6bf`, `10cf8a5` |
| L8 string-joined root paths | Confirmed. | `path.resolve(ROOT, ...parts)`. | `39760f0` |
| L9 shutdown deadlock hazard undocumented | Confirmed. | Docs on `TabsPort::dispose_all`, `DesktopPort::shutdown` and `lib.rs::shutdown`. | `0c83b77` |
| L10 unbounded buffers for unknown generations | Confirmed. | `UNATTACHED_CALLS_LIMIT` (256 per unattached generation) and `UNATTACHED_GENERATIONS_LIMIT` (4 waiting generations); the current page is never limited. Test `calls_waiting_for_an_attach_are_bounded`. | `39fd6bf` |
| Controller add-on: sidecar resource dir | — | `resolve_bundled_omp()` now searches, runtime-free and in Tauri's `resource_dir` order: Linux `exe_dir/../lib/Sai ATLAS`, `$APPDIR/usr/lib/Sai ATLAS`, `/usr/lib/Sai ATLAS`; macOS `exe_dir/../Resources`; then the executable's directory. Dev keeps `CARGO_MANIFEST_DIR/../resources/omp`. A system `omp` on `PATH` is never consulted; a missing binary lists every searched path. Tests for the deb layout (a stray `omp` beside the executable does not shadow the bundled one), the AppImage layout and the fallback. | `fe94ddf` |
| L7, L11–L14 | Left alone, as instructed. | — | — |

## Tests added

Rust (`cargo test --all-features`: 61 → 75 lib tests, `channels` still 2):
- `bridge`: `a_panicking_handler_rejects_its_call_and_the_window_keeps_dispatching` (sync and `Later` panics), `a_reattach_while_a_handler_runs_still_drains_the_new_page` (multi-thread runtime, a handler blocked on a condvar while G2 pre-buffers and attaches), `a_detached_window_queues_messages_for_the_next_page`, `a_failed_send_is_retried_on_the_newer_page` (a sink whose first send attaches the next page before failing), `a_failed_send_without_a_newer_page_is_kept_for_the_next_attach` (including the bound), `drops_to_an_unknown_window_are_logged_once_per_interval`, `calls_waiting_for_an_attach_are_bounded`.
- `webview`: `tauri_localhost_is_the_app_origin_only_on_windows`, `allows_same_origin_blob_downloads_and_denies_foreign_ones`; `allows_the_initial_app_url` no longer assumes `tauri.localhost`.
- `paths`: `resolving_the_default_profile_inside_a_test_is_refused`, `finds_the_sidecar_in_the_deb_resource_dir`, `finds_the_sidecar_in_the_appimage_resource_dir`, `falls_back_to_the_executable_dir_and_errors_when_nothing_is_bundled`; `derives_a_profile_specific_single_instance_id` replaces the phantom test.
- `prefs`: `an_unreadable_store_refuses_to_overwrite_the_file`.

TypeScript (`bunx vitest run`: 1896 → 1904): `src/shared/bridge/create-omp-api.test.ts` (8 tests over a fake `IpcPort`): invoke/send forwarding and `platform`, the active-tab filter with `setActive` gating, `setView` gating, per-tab streams and the remover, the deep-link hold rule (quick-entry nudges are not held), the isolated-listener report (source `preload`, message, `details.channel`, stack) for a regular and a deep-link listener.

## Snapshot and signature changes (the planner must re-sync phases 3–9)

`src-tauri/contracts/*.api.txt` regenerated with `cargo +nightly-2026-10-01 public-api` (cargo-public-api 0.52.0, from `scripts/rust-pins.env`):
- `ports.api.txt`: one added line, `pub fn sai_atlas_lib::bridge::Bridge::detach(&self, sai_atlas_lib::ports::WindowId)`. The six module snapshots (omp, tabs, desktop, services, ollama, updater) are byte-identical.

Public items in foundation files that are not snapshotted (wave phases may reference them):
- `bridge.rs`: new `Bridge::detach(&self, WindowId)`; new consts `UNATTACHED_CALLS_LIMIT: usize = 256`, `UNATTACHED_GENERATIONS_LIMIT: usize = 4`. New `IpcError` messages: `handler for <channel> panicked`, `too many calls are waiting for the page to attach`, `too many page generations are waiting to attach`. `spawn_task` is now `pub(crate)`. Behavior: the replay is sent under the state lock, so an `OutboundSink::send` must never call back into the bridge.
- `webview.rs`: `BuilderCall` gains `ReloadDetach` and `DownloadHandler` (both in `security_calls`, before `InitializationScript`); new `pub fn download_allowed(&Url, Option<&Url>, bool) -> bool`; `http(s)://tauri.localhost` is the app origin only on Windows.
- `paths.rs`: `PathsError::BundledOmpMissing(PathBuf)` → `BundledOmpMissing(Vec<PathBuf>)`; new `default_user_data_dir() -> Result<PathBuf, PathsError>`, `resolve_user_data_dir() -> Result<&'static Path, PathsError>`, `single_instance_id_for(Option<&Path>) -> String`, `bundled_omp_candidates(os_name, exe_dir, appdir) -> Vec<PathBuf>`, `resolve_bundled_omp_in(os_name, exe_dir, appdir) -> Result<PathBuf, PathsError>`. `user_data_dir()` keeps its signature but panics if called before `run()` validated the profile (and in any test build that would resolve the default profile).
- `prefs.rs`: `StoreError` gains `Unreadable { path, source }`.
- `lib.rs`: `run()` resolves the profile before installing the log; `SIGNAL_EXIT_DEADLINE` (15 s) is private.
- Phase 10 Task 10.1 step 5 (sidecar resource-dir lookup) is implemented here, as the controller said it would mark it a no-op. Phase 8's packaging must place the Linux sidecar at `lib/Sai ATLAS/omp` (deb `/usr/lib/Sai ATLAS/omp`, AppImage `$APPDIR/usr/lib/Sai ATLAS/omp`) for the new lookup to find it; the executable-directory fallback still works for the old layout.
- Phase 9 needs no change for Export logs: `LogPanel.tsx` works unchanged through the download route. Phase 10's smoke could add "Export logs opens a save dialog and writes the file".

Design notes for the controller: the download handler shows the save dialog after WebKit has finished writing the staged file, not before (the request callback runs on the GTK main thread, which the dialog itself needs); blob downloads are instant, so the user sees one dialog. Downloads stage in the user's Downloads folder (wry's own default location) rather than the profile, so the WebKit network process writes where it already could.

## Gate results (all on the final tree, `10cf8a5`)

| Gate | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml --all-features` | 75 lib + 2 `channels` (`EXPECTED_CHANNEL_COUNT = 94`) passed; default features 74 + 2 |
| `cargo clippy --all-targets --all-features -- -D warnings` (also with `-D clippy::unwrap_used -D clippy::expect_used`) | clean |
| `bash scripts/check-module.sh foundation` | `check-module foundation: PASS` (gate 9 WARN ×2: no Apple/MSVC toolchain, as before) |
| `bunx vitest run` | 205 files / 1904 tests passed |
| `bun run check:types` | clean |
| `bun run build` | exit 0 (main bundle self-contained, both entries lean) |
| `bun run build:renderer:tauri` | exit 0; `Content-Security-Policy` count 0 in both Tauri HTML outputs, 1 in both Electron outputs |
| `bunx biome check src/shared/bridge/create-omp-api.test.ts vite.renderer.shared.ts` | clean |
| `bunx playwright test e2e/quick-entry.e2e.ts` | 8/8 passed, first run; no Electron process left behind |

Electron, review section (a): no `src/preload/**` or runtime `src/shared/**` file changed (the only new shared file is a test). `out/preload/index.cjs` still has exactly one `require("electron")`; `out/renderer/index.html` and `quick-entry.html` keep the meta CSP; `pre-paint.js` and `pcm-capture-worklet.js` are emitted. `vite.renderer.shared.ts` resolves the same absolute paths on Linux (`path.resolve` of the same parts).

Real profile: `~/.config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl` before any run: mtime `2026-10-02 22:56:20.713815002 +0900`, 13954 bytes, 66 lines (21 `"boom"` test records from earlier runs). After every test run above: identical mtime, size and line count. Test logs landed in `/tmp/sai-atlas-tests/<pid>-gui-runtime.jsonl` (11 lines each, including the two expected `panicked` entries). I did not remove the earlier test lines from the user's log; the reviewer left that to the controller.

## Processes

None started beyond the test runners (cargo, vitest, bun build, Playwright's Electron, which all exited). No dev window was opened.

Status: DONE
Summary: All 19 review items in scope plus the controller's sidecar resource-dir lookup are fixed in 8 commits on `tauri/foundation` (`10cf8a5`), every gate is green, and the real profile log was not touched by the test runs. The only snapshot change is the added `Bridge::detach` line in `ports.api.txt`; the other signature additions are listed above for the phase 3–9 re-sync.
Concerns/Blockers: Phase 8 must ship the Linux sidecar at `lib/Sai ATLAS/omp` for the new lookup (the executable-dir fallback still covers the old layout). The 21 earlier test records in the user's real `gui-runtime.jsonl` are still there; removing them is a controller/user decision.
