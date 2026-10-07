---
phase: 6
title: "Sessions, files, dialogs, system actions, logs, prefs"
status: pending
priority: P1
effort: "6d"
dependencies: [2]
module: services
---

# Phase 6: Data and system services (module `services`)

## Goal

Rust serves the 24 `services` channels from Phase 2's channel table: session listing, search, rename, delete and the file watcher; workspace file listing and reading with the same path-escape protection; save/open dialogs with per-window folder memory; external open, clipboard, notifications and the external editor; prefs get/set; the runtime log and the `~/.omp/logs` tail; the models and provider-cleanup helpers; and the GUI host tools.

## Wave rules

Same as Phase 3 (`phase-03-omp-processes.md` → Wave rules), with these substitutions: worktree `../worktrees/tauri-services`, branch `tauri/services`, owned path `src-tauri/src/services/**`, gate `bash scripts/check-module.sh services`.

Cross-module calls go only through the frozen traits in `src-tauri/src/ports.rs`: `ctx.tabs` (`cwd_for`, `sidecar_for_window`, `sidecar_for_tab`, `command_for_idle_session`, `session_owner`, `session_owner_is_live`, `note_session_file`, `at_cap`), `ctx.desktop` (`spawn_window`, `record`, `focus`, `consume_pending_session`, `on_window_closed`, `rebuild_menu`, `is_main_owned_pref_key`), `ctx.omp` (`resolve_editor_command`, `spawn_env`), `ctx.bridge` (`broadcast_main`) and `ctx.host` (`open_dialog`, `save_dialog`, `open_url`, `open_path`, `reveal_in_folder`, `clipboard_read_text`, `notify`). The Phase 3 Wave rules → "Frozen wiring" apply: `Services::new(ctx: CtxRef)` reaches the other ports through `self.ctx()`; handlers that need module state (session index, dialog memory, notification dedupe, log buffer) use `ctx.services.as_any().downcast_ref::<services::Services>()`; `services::init` runs on the main thread, so its watchers and tasks start through the spawning helper. Tests build an `AppCtx` with `testing::fake_ctx_cyclic(&fakes, registry, |ctx, ports| ports.services = Some(Arc::new(Services::new(ctx.clone()))))` and drive handlers with `bridge::dispatch_for_test`.

## Files (owned)

- `src-tauri/src/services/mod.rs`, `src-tauri/src/services/ipc.rs`
- Create as needed: `session_index.rs`, `session_cache.rs`, `fs.rs`, `dialogs.rs`, `dialog_memory.rs`, `system.rs`, `open_path_target.rs`, `editor.rs`, `log_watcher.rs`, `models_config.rs`, `provider_cleanup.rs`, `host_tools.rs`, `legacy_storage.rs`

## Tasks

### Task 6.1: Pure ports with tests
- Goal: logic modules ported with their tests.
- Targets and test counts: `session_cache.rs` ← `session-cache.ts` (`StampedLru`, 7), `models_config.rs` ← `models-config.ts` (5), `provider_cleanup.rs` ← `provider-cleanup.ts` (6), `dialog_memory.rs` ← `dialog-memory.ts` (`dialog_start_path`, `dialog_dir_of`, 5), `open_path_target.rs` ← `open-path-target.ts` (7 `it` + 1 `it.each` table; it uses `src/shared/launchable-path.ts`, so port the needed functions privately here).
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- services::session_cache services::models_config services::provider_cleanup services::dialog_memory services::open_path_target` exits 0 with at least `30 passed`.

### Task 6.2: Session index and watcher
- Goal: a port of `session-index.ts`: index `~/.omp/sessions` (the agent dir from `paths::agent_dir()` in production; the index takes the directory as a parameter so its tests pass a temp dir, per Phase 3 Wave rules → Tests), list, search, rename, delete, and emit `sessions:changed` on outside changes.
- Target: `session_index.rs`, `ipc.rs`.
- Steps:
  1. Read `src/main/session-index.ts` and its test (3 tests). Port them, and implement `ServicesPort::{sessions_list, sessions_dir, session_delete, session_search, session_kind_for}` over the index (`tabs` calls `session_kind_for`, desktop's quick entry calls `sessions_list`).
  2. Watch with the `notify` crate (recommended watcher, debounced as in TS), started in `services::init`. The watcher callback runs on its own thread, so hop to async through the spawning helper. On a change, call every listener registered through `ServicesPort::on_sessions_changed` and broadcast to all main windows with `ctx.bridge.broadcast_main("sessions:changed", Value::Null)`. `ServicesPort::shutdown` (frozen order step 4) stops this watcher.
  3. Port the handlers at `ipc.ts:577` (`sessions:list`, cwd from `ctx.tabs.cwd_for(caller, None)`); `582` (`sessions:delete`, ported exactly from `ipc.ts:582-602`: refuse only while the owning tab's sidecar is running (`ctx.tabs.session_owner`, `session_owner_is_live`); if the owner is live and idle, send it `drop_session` with `ctx.tabs.command_for_idle_session(path, json!({ "type": "drop_session" }))`, called synchronously (it queues the command on stdin before returning) and awaited inside `Reply::Later`; if the owner has no process, drop the claim with `ctx.tabs.note_session_file(owner_tab, None)`, then delete); `603` (`sessions:rename`, same ownership rules, `ipc.ts:603-632`; the no-owner fallback uses `ctx.tabs.sidecar_for_window(caller.win_id)` and `SidecarHandle::{status, has_rpc_client, request}`); `727` (`sessions:search`), `633` (`session:open-new-window`: focus the owner's window with `ctx.desktop.focus(owner.win_id)` when the session is open, refuse when `ctx.tabs.at_cap()`, otherwise `ctx.desktop.spawn_window(Some(cwd), Some(path), Some(kind))` with the kind from this module's `session_kind_for` and the cwd from `ctx.tabs.cwd_for` → `paths::initial_cwd` → `dirs::home_dir()`), `652` (`session:consume-pending` → `ctx.desktop.consume_pending_session(caller.win_id)`).
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::session_index` exits 0.

### Task 6.3: Workspace files
- Goal: `fs:list`, `fs:read`, `fs:read-plan`, `fs:read-image` match `ipc.ts:985-1168`, including every limit and every refusal.
- Target: `fs.rs`, `ipc.rs`.
- Steps:
  1. Read `ipc.ts:985-1168` and the helpers it calls (`resolveWithin`, `loadIgnoreRules`, `walkWorkspace`, `clampInt`). The workspace root is `ctx.tabs.cwd_for(caller, payload.tabId)`; `fs:read-plan` resolves against `ServicesPort::sessions_dir()` (`ipc.ts:1152`).
  2. Keep the constants: `FS_READ_DEFAULT_MAX_BYTES = 200_000`, `FS_READ_MAX_BYTES_CAP = 2_000_000`, `FS_IMAGE_MAX_BYTES = 25_000_000`, plus the `FS_LIST_*` depth and file caps.
  3. Keep the current trust contract exactly (`ipc.ts:249-254, 1026-1027, 1105-1106`): relative paths are confined lexically to the workspace root by `resolve_within` (`path.resolve` plus a prefix check, no realpath). Absolute and `~/` paths are read as given, because the renderer is trusted and its integrity rests on the sandbox, the CSP and the navigation lock. Do not tighten or loosen this; any change is a product decision for the user.
  4. Port the ignore-rule semantics of `loadIgnoreRules` exactly (read it; do not assume full gitignore semantics).
  5. Write tests: `rejects relative parent traversal`, `reads absolute paths unconfined like the TS handler`, `clamps max depth and max entries`, `marks truncated listings`, `refuses images above the cap`, `reads utf8 with a byte cap`, `applies the ignore rules like the TS walker`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::fs` exits 0 with at least `7 passed`.

### Task 6.4: Dialogs, system actions and the editor
- Goal: `system:*` and `editor:open-external` match `ipc.ts:792-878` and `ipc.ts:1177`.
- Target: `dialogs.rs`, `system.rs`, `editor.rs`, `ipc.rs`.
- Steps:
  1. `system:save-dialog(defaultPath, filters)` and `system:open-dialog(filters, options)` are positional. Use `ctx.host.save_dialog(SaveDialogOptions { default_path, filters: Vec<FileFilter>, parent: Some(caller.win_id), .. })` and `ctx.host.open_dialog(OpenDialogOptions { filters, directory, multiple, can_create_directories, parent: Some(caller.win_id), .. })` inside `Reply::Later`, start at `dialog_start_path(last_dir_for(caller.win_id), requested)` (save defaults to `session.html`, `ipc.ts:835`), and remember the folder per window in memory, keyed by `WindowId` (`ipc.ts:364-371`). Clear a window's entry when it closes: register `ctx.desktop.on_window_closed(Box::new(…))` in `services::init`, with a closure that captures `Arc::downgrade(ctx)`.
  2. `system:open-external`: allow only the URL schemes the TS handler allows (`ipc.ts:792-806`), then `ctx.host.open_url(url)` (the host refuses non-`http(s)` again).
  3. `system:open-path`: port the `open-path-target` decision (refuse launching executables the TS code refuses). Resolve relative targets with `ctx.tabs.cwd_for(caller, None)`, open with `ctx.host.open_path`, and fall back to `ctx.host.reveal_in_folder` on failure or for launchable files.
  4. `system:clipboard-read`: `ctx.host.clipboard_read_text()`.
  5. `system:notify`: `ctx.host.notify(title, body)`, with the same title/body handling as the TS handler at `ipc.ts:865`; on failure write `runtime_log::write(&json!({ "source": "notification", … }), Some(caller.win_id.0), None)`.
  6. `editor:open-external`: port `editor.ts` (temp file + the command from `ctx.omp.resolve_editor_command()`, the frozen `OmpPort` method; `shell_env` is a private omp file) and spawn with `tokio::process`, with `PATH` set to `ctx.omp.spawn_env().await["PATH"]` (TS `spawnPath()`, `editor.ts:34`).
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- services::system services::dialogs services::editor` exits 0, plus one dispatch test per `system:*` channel through `bridge::dispatch_for_test` with `testing.rs` fakes (`FakeHost::open_dialog_answers`, `save_dialog_answers`, `clipboard_text`, `FakeOmp::editor_command`, `FakeOmp::env`).

### Task 6.5: Prefs, logs, models, provider cleanup, host tools
- Goal: the remaining handlers and the host-tool executor.
- Target: `log_watcher.rs`, `host_tools.rs`, `ipc.rs`.
- Steps:
  1. `prefs:get` / `prefs:set` (`ipc.ts:881-897`) over `ctx.prefs.{get, all, set}`: reject non-string keys and keys where `ctx.desktop.is_main_owned_pref_key(key)` is true. After setting `language` to `en` or `vi`, call `ctx.desktop.rebuild_menu()`. When `ctx.prefs.set` returns `Err(StoreError::Unreadable { .. })` (the store could not be read at startup, so it is never overwritten), reject with `IpcError::new(error.to_string())`; test it with an unreadable store file.
  2. `runtime:error-report` and `runtime:log-path` are already implemented in the Phase 2 stub of `ipc.rs` (`runtime_log::write(&report, Some(caller.win_id.0), cwd)` with the cwd from `ctx.desktop.record(caller.win_id)`, which normalizes through `runtime_log::normalize_runtime_error_report`; and `runtime_log::path()`). Keep them as they are and give each a dispatch test.
  3. `log_watcher.rs`: port `log-watcher.ts` (tail `omp.*.log` in `paths::agent_dir().join("..").join("logs")`, as `log-watcher.ts:41` joins `agentDir(), "..", "logs"`; 1,000-line ring buffer, 150 ms flush, directory watch plus a 15 s poll fallback) and its 1 test. `log:snapshot` returns the buffer and its sequence number from the `Services` struct (through `as_any`). Stream lines with `ctx.bridge.broadcast_main("log:line", json!({ "lines": …, "nextSequence": … }))`. `ServicesPort::shutdown` stops the watcher.
  4. `models:providers-list` and `provider-cleanup:config` call the ported modules.
  5. `ServicesPort::execute_host_tool(&self, caller: Caller, name: &str, args: Value) -> Option<BoxFuture<'static, Result<Value, String>>>` (`ports.rs:668`): port `executeGuiHostTool` (`ipc.ts:1222-1244`): `gui_open_url` (http/https only), `gui_notify`, `gui_clipboard_read`; `None` for anything else. Upgrade `self.ctx()` before building the future and move the `Arc<AppCtx>` into it, so the `'static` future can call `ctx.host.{open_url, notify, clipboard_read_text}`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::` exits 0, and `grep -c "IpcError::not_ported" src-tauri/src/services/ipc.rs` prints `0` (the file's header comment mentions `not_ported` by name, so grep for the call).

### Task 6.6: One-time import of Electron localStorage
- Goal: installs that never ran the Phase 1 mirror release still keep language, theme and UI state (user decision, 2026-10-02).
- Target: `src-tauri/src/services/legacy_storage.rs`, behind `ServicesPort::import_legacy_renderer_storage(&self)`. The Phase 2 `services::init` already runs it with `tauri::async_runtime::block_on(ctx.services.import_legacy_renderer_storage())`, and `lib.rs` calls `services::init` before `desktop::init`, so it finishes before any window exists and the bootstrap script (`bridge::bootstrap_script`) seeds the imported values. Keep that call; fill the body.
- Steps:
  1. Run only when `prefs.json` has no `rendererStorage` subtree (`ctx.prefs.get("rendererStorage")` is `None`) and `<profile>/Local Storage/leveldb` exists, where the import function takes the profile directory as a parameter (`paths::user_data_dir()` in production; a temp dir in tests, because `user_data_dir()` panics in a test build that would resolve the default profile). Write each value with `ctx.prefs.set(&prefs::renderer_storage_pref_key(key), …)` for `key` in `prefs::RENDERER_STORAGE_KEYS`, and log failures with `runtime_log::note`.
  2. Copy that directory to a temp dir first, because a running Electron build may hold its `LOCK`. Open the copy with `rusty-leveldb`, read-only.
  3. Chromium keys look like `_file://\u0000\u0001<key>`. Values start with a format byte: `0x01` means Latin-1 bytes follow, `0x00` means UTF-16LE. Read only the five `RENDERER_STORAGE_KEYS` and write each as a string into `rendererStorage.<key>` in `prefs.json`.
  4. Any error (missing, locked or corrupt data, unknown format) logs one runtime entry and imports nothing. It never blocks startup. Delete the temp copy.
  5. Tests with a fixture LevelDB built in the test by `rusty-leveldb` with Chromium-shaped keys: `imports latin1 and utf16 values`, `ignores other origins and keys`, `skips when prefs already has renderer storage`, `a corrupt store imports nothing and does not fail startup`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::legacy_storage` exits 0 with `4 passed`. On this machine, run it against a copy of `~/.config/@oh-my-pi/omp-gui` passed as `--user-data-dir`: the copy's `prefs.json` gains the `rendererStorage` values that the Electron build shows in its DevTools localStorage.

### Task 6.7: Module gate and commit
- Verify: `bash scripts/check-module.sh services` exits 0 with last line `check-module services: PASS`. Then commit `feat(gui): serve sessions, files and system actions from the Tauri core`.

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
