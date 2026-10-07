# Planner changelog: Phase 2 contract fixes propagated into Phases 3–12

Date: 2026-10-02 (Asia/Seoul). Plan: `plans/261002-1441-tauri-shell-migration`. Frozen code read at `tauri/foundation` tip `d4ce82e` (worktree `/home/tung491/WORK/worktrees/tauri-foundation`). Sources: the Phase 2 executor report (`fullstack-developer-261002-2038-phase-02-foundation.md`), the 2.9b review (`261002-1441-tauri-shell-migration/reports/phase-02-contract-review.md`), and the controller's later input, the Phase 2 code review (`code-reviewer-261002-2143-phase-02-foundation.md`, items L7 and L11–L14 plus the M8 decision only).

No `status:` front matter, no Phases-table Status cell and no Validation Log entry was touched. Each phase file still has exactly one `## Failure Protocol`. `phase-02` was not edited (outside scope).

## Known items, where each landed

| Item | Source | Landed in |
|---|---|---|
| tabs must not re-batch `rpc:events` | N4 | P3 Task 3.2 step 3 (manager batches via `new_event_batcher`, emits `SidecarEvent::Events`); P4 Task 4.2 step 4 (forward unchanged, no `EventBatcher`) |
| `omp/supervisor.rs` one `unsafe` for fd 3, and how the gate permits it | N7 | P3 Wave rules (two allowed sites; `check-module.sh` has no `unsafe` gate and gate 4 does not deny `unsafe_code`), Task 3.4b step 1, Task 3.6 step 2 + Verify (grep must list exactly the two sites); plan.md Execution rules (three files) |
| managers spawn through `tauri::async_runtime::spawn` | N11 | P3 Wave rules "Spawning" (the `Handle::try_current()` / `tauri::async_runtime::spawn` pattern of `bridge.rs:275-287`), Task 3.4 step 4 (`start()` spawns there); repeated for P4, P5, P6, P7, P8 |
| `on_exit_requested(Some(_))` returns `false` | N13 | P5 Task 5.8 step 2 (rule, `None` handling per `app-quit.ts:44-67`), step 3 test `an exit the app requested is never vetoed`, Verify (≥5 tests + a SIGTERM run) |
| quit dialog's safe button last | N2 | P5 Task 5.8 step 1 (`[QuitQuitAnyway, QuitKeepWorking]`, matching `app-quit.ts:78-80`; dismissal = last); test `the keep-working button is last` |
| `/usr/bin/omp` collision in the .deb | N6 (executor numbering) | P8 Task 8.3 steps 1, 3, 6 + Verify; P8 Task 8.4 tests; P10 Task 10.1 step 5 (paths lookup); P11 Tasks 11.3, 11.4; plan.md Decisions row. See "Design decision" below |
| relaunch env in the Phase 10 smoke | N14 | P10 Task 10.5 step 5 (Tauri self-update, `/proc/<pid>/environ` checks) + Verify count 3; P8 Task 8.2 step 1 (build-time `SAI_ATLAS_UPDATE_BASE` so the test bundle can read a local feed) and Task 8.4 test |
| `createQuickEntryApi(port, platform)`, `bootstrap_script(ctx, caller)` | executor deviation 2 | plan.md Decisions "Bridge" row; P5 Task 5.2 step 3; P12 Task 12.4 step 4. No old-arity occurrence existed in Phases 3–12 |
| throwaway profiles get their own identifier | executor deviation 5 | P5 Wave rules; P10 Task 10.3 step 4 (D-Bus name `vn.io.vif.saiatlas.p<16 hex>`, Wayland app id unchanged); P12 Task 12.1 step 3 |
| reqwest 0.12, plugins `"2"`, tauri-nspanel crates.io, ashpd 0.11 | executor deviation 1 | plan.md Execution rules (dependency pins); P3 Task 3.5, P7 Task 7.1, P8 Wave rules (reqwest); P3 Task 3.3 (ashpd); P5 Task 5.4 step 2 and P12 Task 12.1 step 5 (nspanel) |
| `src-tauri/icons/icon.png` placeholder | executor deviation 3 | P8 Task 8.3 step 4 |
| N12 stale wording | N12 | P3 Task 3.3 (`OmpPort::spawn_env(&self)` via `self.ctx()`), P5 (`rebuild_menu()`, `on_second_instance(argv, Some(cwd))`), P6 Task 6.4 step 6 (`ctx.omp.resolve_editor_command()`), P7 Wave rules (calls `ctx.omp.spawn_env()`), P8 Task 8.2 step 3 (`Host::relaunch_after_exit`) |

## Other items from the reports

- `CtxRef` / `as_any` / `fake_ctx_cyclic` / init and shutdown order / `'static` futures: one "Frozen wiring" block in P3 Wave rules; P4–P8 reference it and name their own struct, listeners and tests. plan.md Execution rules points to it; plan.md Decisions "Contracts" row updated.
- N3 follow-up: P5 Task 5.3 step 4 calls `ctx.bridge.unregister_window(win_id)` after the close listeners and record drop, with a test.
- N6 (review numbering, global shortcut): P5 Task 5.5 step 1 uses `app.global_shortcut().on_shortcut(…)`; `lib.rs:379` already registers the plugin.
- N8 (fixed in `6416e89`): P3 Task 3.2 step 2 returns `SidecarError::Timeout { timeout_ms, command_type }`, whose `Display` is the TS text.
- macOS `RunEvent::Opened`: `lib.rs` has no arm, so P5 Task 5.7 step 2 uses `deep_link().on_open_url` (deep-link 2.6.1 forwards `Opened`).
- `UpdaterPort::shutdown` install-on-quit, `OllamaPort::shutdown` pull cancel, `DesktopPort::shutdown`: P8 Task 8.2 step 3, P7 Task 7.2 step 2, P5 Task 5.3 step 5.
- `Desktop::new` holds a Wry `AppHandle`, so `tauri::test::mock_app()` (MockRuntime) cannot build it: P5 Wave rules say to test pure functions or a private window-backend trait.
- Code review M8 (controller decision): plan.md Decisions row; P9 Task 9.3 step 3 checks Export logs through the save dialog (`Export logs: PASS` line in the audit report, Verify grep); P10 Task 10.4 visual pass repeats it with real lines.
- Code review L7: P10 Task 10.2 step 4 (barrier keeps a released state) + test + Verify.
- Code review L11: P3 Wave rules (gate 1 skips untracked files, gate 3 stale frontend, gate 9 WARN proves nothing); P12 Task 12.1 step 6 + Verify (clippy on the Mac and the Windows VM).
- Code review L12: P10 Task 10.3 step 2 adds `e2e-tauri/csp.e2e.ts` (Tauri-only), because `dev:tauri` runs with no CSP.
- Code review L13: P10 Task 10.1 step 6 moves `TauriHost::clipboard_read_text` into `spawn_blocking` (lib.rs is frozen during the wave).
- Code review L14: P5 Task 5.7 step 2 implements `on_second_instance` before its manual check, with a test; P3 Wave rules warn every wave run not to start a second instance on one profile.

## Defects found in the plan text and fixed

- Eight Verify commands passed two or more test filters to `cargo test` before `--`, which cargo rejects (`Usage: cargo test [OPTIONS] [TESTNAME] [-- [ARGS]...]`, reproduced in a scratch crate). Fixed to `cargo test … -- a b` in P3 (3.2, 3.3, 3.5), P4 (4.1), P5 (5.6, 5.7), P6 (6.1, 6.4).
- `grep -c "not_ported"` in P6 Task 6.5 and P8 Task 8.2 counts the `//! … not_ported stub` header in every `ipc.rs`, so it could never print `0`; now `grep -c "IpcError::not_ported"`.
- P10 Task 10.1's `grep -rnE "…not_ported\("` always matches `pub fn not_ported(` in `bridge.rs`; now excludes the definition.
- P8 Task 8.3 Verify looked under `target/release/bundle`, but `tauri build --target <triple>` writes `target/x86_64-unknown-linux-gnu/release/bundle`.
- P11 Task 11.4 bumped `tauri.conf.json`, which reads `"version": "../package.json"`.
- P9 still described Task 9.2 as pending and quoted a different commit subject; it now records `fa1b9c6`.

## Design decision taken here (for review)

The deb sidecar cannot leave `/usr/bin` with config alone: the bundler installs `externalBin` beside the main binary in `usr/bin` (`tauri-bundler-2.10.1/src/bundle/linux/debian.rs:118-133`), `paths::resolve_bundled_omp()` looks only in the executable's directory (`paths.rs:162-180`), and `deb.files` are not applied to the AppImage (`linuxdeploy.rs:80` calls `generate_data` only; `debian.rs:82` applies `files` after it). The plan therefore ships the Linux sidecar as a bundle resource (`usr/lib/Sai ATLAS/omp` in both packages, `debian.rs:329-331`) and changes `resolve_bundled_omp()` in Phase 10 Task 10.1 step 5, when `paths.rs` is no longer frozen. Alternative: land that one-function `paths.rs` change on `tauri/foundation` with the code-review fix commit; then Phase 10's step is a no-op check. A packaged Linux build from the `tauri/updater` branch cannot find its sidecar until then, which Phase 8 does not exercise (it checks layout only).

## Identifier check

Every backticked span in Phases 3–9 was scanned for `a::b` paths and `.method(` calls: 301 unique identifiers. 214 are defined in `src-tauri/src` or `src-tauri/contracts` at `d4ce82e`. The other 87 are one of:
- std, tokio, nix, dirs, glib or serde names (`Arc::new_cyclic`, `Handle::try_current`, `OwnedFd::from_raw_fd`, `Value::Null`, …);
- Tauri 2.12.1 / plugin / ashpd API checked in `~/.cargo/registry`: `WebviewWindow::{maximize, on_window_event, remove_menu, set_icon, set_progress_bar}`, `available_monitors`, `CloseRequestApi`, `RunEvent::{Exit, ExitRequested, Reopen, Opened}`, `tauri::test::mock_app`, `TrayIconBuilder`, `on_download`, `GlobalShortcutExt::global_shortcut` + `on_shortcut` (global-shortcut 2.4.0 `lib.rs:157, 278`), `DeepLinkExt::deep_link` + `register_all` + `on_open_url` (deep-link 2.6.1 `lib.rs:249, 527, 562`), `ashpd` `GlobalShortcuts` and `register_host_app`;
- names the phase itself creates while porting TS (`launch_argv::parse_launch_argv`, `window_bounds::restore_within_displays`, `proxy::resolve`, test-module filters such as `desktop::lifecycle`).

No contract name used in a step is missing. Struct-literal fields (`SidecarOptions`, `OpenDialogOptions`, `MessageDialogOptions`, `AcquireOptions`, `WindowSpec`) and fake fields (`FakeHost::*`, `FakeOmp::*`, `FakeDesktop::*`, `FakeSidecar::*`) were checked by hand against `ports.rs`, `webview.rs` and `testing.rs`.

**Re-run pending.** The code-review fix commit (bridge detach, prefs read errors, `single_instance_id_for`, …) has not landed yet (`git log` tip is still `d4ce82e`, `bridge.rs` modified in the worktree). After it lands: re-run the identifier check against the new `contracts/*.api.txt`, and re-check the line citations into `lib.rs`, `bridge.rs` and `webview.rs` that Phases 3–10 now carry (`lib.rs:236-247, 265-284, 287-306, 356-358, 367-371, 379, 381-393, 401-409, 410-415, 416-421`; `bridge.rs:275-287, 586, 812`; `webview.rs:29-52`; `ports.rs` citations).

## Checks

- `ak plan validate plans/261002-1441-tauri-shell-migration` → `[OK] … is a valid plan directory`.
- `grep -c "^## Failure Protocol$"` → `1` for each of the 13 phase files.
- Superseded-wording grep (`spawn_env(ctx)`, `rebuild_menu(ctx)`, `on_second_instance(ctx`, `` `omp::shell_env` ``, `calls no other wave module`, `SidecarManager::new`, `handle().plugin`, `Tabs::init`, `If Phase 2 dropped`, ``Batch `rpc:events` ``, ``no `unsafe` needed``, `grep -c "not_ported"`) over Phases 3–12 and plan.md → no hits; multi-filter `cargo test` grep → no hits outside Phase 2's correct `--lib -- …` form.

## Left for the controller

- `phase-02` Design still says only `webview.rs` and `omp/manager.rs` may hold `unsafe` (line 287) and shows the old arity `bootstrap_script(ctx, kind)` / `createQuickEntryApi(port)` (lines 109, 120, 227, 236). Out of my edit scope; it is the completed phase's record.
- Phase 5 cannot set the quit dialog's Enter default (no field in `MessageDialogOptions`); Task 5.8 asks the executor to report what Enter does on GNOME.

## Round 2: re-sync to `tauri/foundation` at `10cf8a5`

Input: the review-fix report `plans/reports/fullstack-developer-261002-2143-phase-02-review-fixes.md` (8 commits `39fd6bf`..`10cf8a5`; only snapshot change is `Bridge::detach` in `ports.api.txt`). The controller also opened `phase-02` for edits.

### Line citations re-anchored (phases 3–12, plan.md)

`lib.rs` grew by about 29 lines above `run()`; `bridge.rs`, `webview.rs` and `ports.rs` shifted too. Updated: `lib.rs:286-308` (shutdown, was 287-306), `299-306` (block_on, was 296-304), `385-387` (identifier override, was 356-358), `396-400` (single-instance callback, was 367-371), `403` (deep-link plugin), `408` (global-shortcut plugin), `410-422` (setup), `431-438` (ExitRequested), `439-444` (Exit arm), `445-450` (Reopen); `bridge.rs:718` (`emit_to_window`), `975` (`dispatch_for_test`); `webview.rs:35-56` (`WindowSpec`); `ports.rs:668` (`execute_host_tool`), `745-747` (dialog buttons doc), `762-787` (`Host`). Unchanged and re-checked: `lib.rs:170-182, 236-247, 265-284`, `testing.rs:831`, `desktop/mod.rs:186-201`, every other `ports.rs` citation.

### Drift fixed

- `bridge::spawn_task` is now `pub(crate)` (`bridge.rs:367-380`): the Phase 3 "Spawning" rule now says call it, instead of copying a private helper.
- Phase 3 Wave rules → Tests: tests take profile and agent dirs as parameters, because `paths::user_data_dir()` (and the functions built on it) panics in a test build that would resolve the default profile; the test runtime log goes to `<temp>/sai-atlas-tests/`. Phase 6 Tasks 6.2 and 6.6 take their directories as parameters accordingly.
- Phase 3 Wave rules: a handler that reaches another module's `todo!()` now rejects with `handler for <channel> panicked` (expected until Phase 10); prefs writes can return `StoreError::Unreadable`. Phase 6 Task 6.5 step 1 rejects `prefs:set` with that error, with a test.
- Sidecar lookup is done in foundation (`fe94ddf`, `paths::bundled_omp_candidates`, `paths.rs:205`). Phase 10 Task 10.1 step 5 is now check-only: three named `paths::tests` must report `3 passed`; the implementation text is gone, and the Verify points at that command. Phase 8 Task 8.3 step 3 states the exact lookup order, says the resource must be exactly `lib/Sai ATLAS/omp`, and keeps the layout checks inside both built packages (`dpkg -c`/`dpkg -x` for the .deb, `--appimage-extract` for the AppImage, plus a `--version` run of each extracted sidecar). plan.md Decisions row updated (source: controller).
- Blob downloads: Phase 9 Task 9.3 step 3 and the Phase 10 Task 10.4 visual pass now check the staging behavior. The file is staged in the Downloads folder as `.<name>.<pid>-<n>.part`, and the dialog opens after WebKit finishes writing it. The `.part` count in `$(xdg-user-dir DOWNLOAD)` must be unchanged after both Save and Cancel, and Cancel must leave no `omp-logs-*.log`.

### Phase 2 Design updated

- Arities: `bridge::bootstrap_script(ctx, caller)` (Bootstrap and Init script bullets) and `createQuickEntryApi(port, platform)` (Tasks 2.2 step 3 and 2.3 step 3). The bootstrap escape list now includes `<`.
- `unsafe` (Task 2.8 step 1): the three-file rule, with the two omp sites `manager.rs` `pre_exec` and `supervisor.rs` `from_raw_fd(3)`. `main.rs` needs none (re-grepped: no `unsafe` in `main.rs` or `lib.rs`). This matches Phase 3 Wave rules and plan.md.
- New names and behaviors:
  - Attach lifecycle → Robustness: panic catch, per-window drainer, `Bridge::detach` from `.on_page_load` on `PageLoadEvent::Started`, replay under the lock, dead-channel retry, `UNATTACHED_CALLS_LIMIT`/`UNATTACHED_GENERATIONS_LIMIT`, throttled drop log, `spawn_task` visibility.
  - Webview security: Downloads (`download_allowed`, `.on_download` → `Host::save_dialog`, the `.part` staging), Reload detach, `tauri.localhost` only on Windows, and the sandbox exit on a `with_webview` error.
  - Ordered dispatch: `StoreError::Unreadable`.
  - Profile: strict resolution (`default_user_data_dir`, `resolve_user_data_dir`, `NoConfigDir` → `STARTUP_FAILURE_EXIT_CODE`, `is_default_profile` by resolved path, the test-build guard) and the sidecar resource-dir search (`bundled_omp_candidates`, `resolve_bundled_omp_in`, `BundledOmpMissing(Vec<PathBuf>)`).
  - Single instance: `single_instance_id_for` and the identifier override.
  - SIGTERM: the second signal or the 15 s `SIGNAL_EXIT_DEADLINE` exits hard with `128 + signo`, plus the main-thread rule for shutdown futures.
- No `status:` front matter or Phases-table cell changed.

### Identifier check, re-run at `10cf8a5` (phases 2–12 and plan.md)

The check found 370 unique identifiers; 266 are defined in `src-tauri/src` or `contracts/`.
- Every identifier that resolved at `d4ce82e` still resolves.
- The 104 that are not defined there are std/tokio/serde/glib/dirs names, Tauri or plugin API (`PageLoadEvent::Started`, `config_mut`, `is_sandbox_enabled`, `tauri::window::Color`), clippy lint names, Playwright/WebdriverIO calls in Phase 10 (`locator`, `evaluate`, `execute`), or port target names the phases create.
- The new foundation names all resolve: `Bridge::detach`, `download_allowed`, `single_instance_id_for`, `spawn_task`, `bundled_omp_candidates`, `resolve_bundled_omp_in`, `default_user_data_dir`, `resolve_user_data_dir`, `StoreError::Unreadable`. The bare constants `UNATTACHED_CALLS_LIMIT` (`bridge.rs:34`), `UNATTACHED_GENERATIONS_LIMIT` (`bridge.rs:36`), `SANDBOX_MISSING_EXIT_CODE` (`webview.rs:31`), `STARTUP_FAILURE_EXIT_CODE` (`lib.rs:49`) and `SIGNAL_EXIT_DEADLINE` (`lib.rs:312`) were checked by hand.

### Checks

- `ak plan validate plans/261002-1441-tauri-shell-migration` → `[OK]`.
- `grep -c "^## Failure Protocol$"` → `1` for all 13 phase files.
- Stale-text grep (`bootstrap_script(ctx, kind)`, `createQuickEntryApi(port)` without `platform`, ``Besides `main.rs` ``, the old Phase 10 implementation wording) → no hits.

The round-1 "Design decision" and "Left for the controller" items about the sidecar location and `phase-02` are resolved by this round. One item remains open: the quit dialog's Enter default (Phase 5 Task 5.8 reports it).
