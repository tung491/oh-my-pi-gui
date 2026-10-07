---
phase: 2
title: "Tauri foundation, bridge and frozen contracts"
status: pending
priority: P1
effort: "7d"
dependencies: [0, 1]
owner: strongest available executor (this phase defines every contract the wave depends on)
---

# Phase 2: Tauri foundation, bridge and frozen contracts

## Goal

A Tauri app in `src-tauri/` boots the unchanged React renderer with a working `window.omp`, inside a sandboxed and navigation-locked webview. Every cross-module Rust contract exists as a frozen trait, and every channel in `src/shared/ipc-types.ts` has one owner module. When this phase ends, seven phases can run in parallel and never edit a shared file. Electron still builds and ships unchanged.

## Preconditions

- Phase 0 verdict is `GO` (`reports/spike-report.md`); the accepted soft-gate degradations and the deferred S5/S8 checks are in `plan.md` → Validation Log → Session 2. The spike's required design changes are already folded into this phase's Design, so read it as written.
- Phase 1 is merged to `main` (this phase reads `src/shared/renderer-storage.ts`, and both phases touch `src/renderer/main.tsx`).
- Phase 9 Task 9.2 (WebAudio voice capture) is merged to `main`: `grep -c MediaRecorder src/renderer/lib/voice.ts` prints `0`. It lands before this phase branches so every wave worktree, and Phase 5 Task 5.3b in particular, carries it.
- `test -x resources/omp` succeeds (see `plan.md` → Sidecar binaries).
- Work on a new branch `tauri/foundation` from `main`. The wave phases branch from this phase's final commit.

## Design (fixed; do not change during the wave)

### Runtime-free context and ports

Handlers and cross-module calls never touch Tauri types directly, so every module can be unit-tested with fakes and no Tauri runtime:

```rust
// src-tauri/src/ctx.rs
pub struct AppCtx {
    pub host: Arc<dyn Host>,          // OS services: dialogs, opener, clipboard, notifications, app version, exit
    pub bridge: Bridge,               // dispatch + outbound streams
    pub prefs: JsonStore,             // prefs.json
    pub window_state: JsonStore,      // window-state.json
    pub i18n: MainI18n,
    pub omp: Arc<dyn OmpPort>,
    pub tabs: Arc<dyn TabsPort>,
    pub desktop: Arc<dyn DesktopPort>,
    pub services: Arc<dyn ServicesPort>,
    pub ollama: Arc<dyn OllamaPort>,
    pub updater: Arc<dyn UpdaterPort>,
}
```

`src-tauri/src/ports.rs` declares the six port traits, the `Host` trait and the shared types they use. Every production port is constructed with `new(ctx: CtxRef)` (`CtxRef = Weak<AppCtx>`; `lib.rs` builds the context with `Arc::new_cyclic`, tests with `testing::fake_ctx_cyclic`), so a trait method reached through `ctx.<module>` can use the rest of the context, and every port trait has `fn as_any(&self) -> &dyn Any`, so a module's handlers reach their own struct with `ctx.<module>.as_any().downcast_ref::<…>()` instead of a process-global. The shared types: `WindowId(u32)`, `WindowKind { Main, QuickEntry }`, `Caller { win_id: WindowId, kind: WindowKind }`, `SidecarEvent` (one variant per event that `src/main/sidecar.ts` emits; inventory them with `grep -n "this.emit(" src/main/sidecar.ts`: `frame` and its kinds, `events`, `status`, `stderr`, `extensionError` and the rest), `SidecarStatus`, `SidecarHandle` (a trait with the manager surface, so the pool can be tested with fakes), and `EventBatcher`. Production implementations live in each module. `lib.rs` wires them, and modules that need native APIs (windows, tray) receive the real `AppHandle` in their constructor. Test fakes live in `src-tauri/src/testing.rs` (foundation, `#[cfg(test)]`): `FakeHost`, plus one `Fake<Port>` per trait that records calls and returns scripted values.

**Window identity.** Each chat window gets a `WindowId(n)` with label `main-<n>`. The quick-entry bar is `quick-entry`. Renderer-visible ids (`IpcSessionOwner.winId`, `ownerWinId`, `src/shared/ipc-types.ts:910-926`) serialize as that number, so the renderer's `typeof … === "number"` checks keep working (`src/renderer/hooks/use-session-switch.ts:196-198`).

### Cross-module contract inventory

The traits must cover every call one module makes into another. Build the list from the TS call sites, not from memory:

1. `grep -nE "sidecarPool\.|windowManager\.|sessionIndex\.|deps\.(sidecarPool|windowManager|sessionIndex)|quickEntry\.|statsServer\.|benchRunner" src/main/*.ts src/main/ollama/*.ts`, excluding tests.
2. Classify each call by caller module and callee module (ownership table below). Keep only cross-module calls.
3. Write them to `src-tauri/contracts/cross-module-calls.json` (`[{ "caller": "services", "callee": "tabs", "ts": "src/main/ipc.ts:586", "method": "session_owner_is_live" }]`). Every entry must map to a trait method.

These methods must exist (verified against the TS on 2026-10-02; the inventory may add more):
- `TabsPort`: `acquire`, `sidecar_for_window`, `sidecar_for_tab`, `command_for_idle_session`, `set_active_tab`, `set_tab_view`, `release_tab`, `release_window`, `session_owner`, `session_owner_is_live`, `foreign_session_owner`, `note_session_file`, `adopt_session_cwd`, `route_side_channel`, `tabs_for_window`, `tab_inventory`, `tab_layout_for_window`, `restore_layout`, `dispose_all`, `at_cap`, `on_window_tabs_changed`, `cwd_for(caller, tab_id)`.
- `OmpPort`: `new_sidecar(options) -> Box<dyn SidecarHandle>`, `spawn_env`, `resolve_editor_command`, `shutdown`.
- `DesktopPort`: `spawn_window`, `records`, `record`, `main_window`, `target_window`, `focus`, `set_cwd`, `consume_pending_session`, `set_run_progress`, `on_window_closed`, `rebuild_menu`, `is_main_owned_pref_key`, `on_second_instance`, `request_quit`, `on_exit_requested` (true keeps the app running: `lib.rs` calls `api.prevent_exit()`), `on_reopen` (macOS dock click), `mark_quitting`, `is_quitting`, `quit_risk`, `approve_quit_before_install`, `withdraw_quit_approval`, `shutdown`.
- `ServicesPort`: `sessions_list`, `session_kind_for`, `session_delete`, `session_search`, `sessions_dir`, `on_sessions_changed`, `execute_host_tool`, `import_legacy_renderer_storage` (run by `services::init` before any window exists), `shutdown`.
- `OllamaPort`: `shutdown` (no other module calls ollama).
- `UpdaterPort`: `check_now`, `status`, `shutdown` (installs a downloaded update on quit when `installsOnQuit` holds). `Host::relaunch_after_exit(program)` starts the new binary with no arguments after this process has exited and released the single-instance name.
- `SidecarHandle::request`, `kill`, `dispose` and `TabsPort::command_for_idle_session` return `'static` futures: the stdin write (or the stop) happens before the call returns, so a handler calls them synchronously and hands the future to `Reply::Later`. The sidecar manager batches its own `SidecarEvent::Events`; the pool forwards those batches unchanged.

### Ordered dispatch

Electron ran every handler on one thread in arrival order, and the code relies on that (`src/main/ipc.ts:906-907`, `ipcMain.on` ordering for `progress:set`/`tray:state-push`, stdin write order for `rpc:command`). Tauri runs commands concurrently, and concurrent invokes can arrive out of order, so:

- The renderer port adds a per-page `seq` to every `omp_invoke` call. Rust delivers calls from one `(win_id, page generation)` to a per-window dispatcher strictly in `seq` order, using a small reorder buffer.
- The handler type does its synchronous work first and returns a future only for what it must await:

```rust
pub enum Reply { Ready(Result<Value, IpcError>), Later(BoxFuture<'static, Result<Value, IpcError>>) }
pub type Handler = fn(&Arc<AppCtx>, Caller, Vec<Value>) -> Reply;
```

- The dispatcher calls each handler in order on its window's queue. A `Later` future is then spawned. Rule for every handler: validate, mutate state and enqueue sidecar stdin writes *before* returning. Await only for responses.
- `JsonStore` exposes `get(dot_path)`, `set(dot_path, Value)`, `delete(dot_path)` and `update(dot_path, FnOnce(Option<Value>) -> Option<Value>)`, all under one `std::sync::Mutex` that also serializes the file write. Writes go to a unique temp file (`prefs.json.<pid>.<counter>.tmp`), then `rename`. Only a missing file reads as empty. Any other read error at open (permissions, I/O) is logged and marks the store unreadable: every later `set`, `delete` or `update` returns `StoreError::Unreadable { path, source }` and the file is never overwritten (`caffc3a`), so callers must handle that error.

### Bridge

The renderer keeps talking to `window.omp: OmpApi` (`src/shared/ipc-types.ts:985`). This phase moves the preload's builder into shared code that takes an `IpcPort`:

```ts
// src/shared/bridge/ipc-port.ts
export interface IpcPort {
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	send(channel: string, ...args: unknown[]): void;
	on(channel: string, listener: (payload: unknown) => void): () => void;
}
```

The Electron preload passes an `ipcRenderer`-backed port. The Tauri port (`src/renderer/boot/tauri-port.ts`):

| Port method | Behavior |
|---|---|
| `invoke(channel, ...args)` | `invoke("omp_invoke", { channel, args, seq, gen })`, or `omp_quick_entry_invoke` in the bar. `gen` is the page generation id the page chose at load (see Attach lifecycle); `seq` rises by one per call within that generation. `args` is a JSON array; `undefined` becomes `null`. A rejection is rethrown as `new Error(err.message)`, because 52 renderer catch sites read `error instanceof Error ? error.message : String(error)`. Responses are never chunked: Phase 0 S3 returned 64 MiB in 227 ms through one `invoke`, so the port passes the value through as is. |
| `send(channel, ...args)` | the same call with its own `seq`, not awaited, rejection swallowed |
| `on(channel, cb)` | synchronous: adds `cb` to a JS `Map<channel, Set<cb>>` and returns a remover that deletes it. No IPC round trip per subscription. |

At boot, the port draws a random `gen` (`crypto.randomUUID()`), creates **one** `Channel` per page and calls `invoke("omp_attach", { gen, onMessage })` once. Rust sends `{ channel, payload }` envelopes on it, and the JS fan-out calls each listener inside a `try`/`catch`, reporting failures as the preload's `isolated()` did. Main→renderer traffic never uses `emit`; `rpc:events` is a 30 Hz stream with frames up to 1 MB (`src/main/rpc-bridge.ts:8-9`).

**Attach lifecycle.** The page chooses its generation id and sends it on `omp_attach` and on every `omp_invoke`; Rust never infers the generation from arrival order, because commands run concurrently and a page's first `omp_invoke` can reach Rust before its `omp_attach`. Each `omp_attach` with a new `gen` becomes that window's current generation and drops the previous `Channel` (a reload or crash recovery leaves no dead subscribers); invokes carrying an older `gen` are rejected with `IpcError`, and invokes carrying a `gen` that has not attached yet are held in that generation's reorder buffer. **Gap policy.** The per-window reorder buffer waits at most 2 s for a missing `seq`; after that it writes a runtime log entry, skips the gap and continues, and a new `omp_attach` flushes the previous generation's buffer outright, so a lost call can never stall a window's queue. Before a page attaches, Rust queues outbound messages for that window (bounded at 1,000; on overflow it drops the oldest, but never a `deep-link`). On attach it flushes the queue, then the replay state: every undelivered `deep-link` in order, and the latest `quick-entry:state`. `updater:status` is not replayed; the renderer pulls `updater:getStatus` at boot (`ipc-types.ts:219-221`). The quick-entry page receives only `quick-entry:state`; Rust filters every other channel for that window kind.

**Robustness (fixed in `39fd6bf`, `a6dead9`).** A handler that panics (synchronously or inside its `Later` future) is caught with `catch_unwind`; the call rejects with `handler for <channel> panicked`, a `main-uncaught` runtime entry is written, and the window keeps dispatching. The drainer role is per window and held by a guard that hands it back on drop; calls flushed from a superseded generation run first, in the drainer, before the current generation, so two handlers never run at once for one window. `Bridge::detach(win_id)` clears a window's sink but keeps its generation; `build_window` calls it from `.on_page_load` on `PageLoadEvent::Started`, so messages emitted during a reload or crash recovery queue for the next attach instead of going to the dead page. The attach replay is sent while the state lock is held, so a concurrent live emit cannot overtake it; an `OutboundSink::send` therefore never calls back into the bridge. A send that fails on a dead channel is retried on a newer channel if one attached, otherwise it is queued for replay under the same bound. Unattached generations are bounded (`UNATTACHED_CALLS_LIMIT` = 256 calls each, `UNATTACHED_GENERATIONS_LIMIT` = 4 waiting generations). A message for an unknown window is counted and dropped, and logged at most once per 60 s per window and channel. `bridge::spawn_task` (the `Handle::try_current()` / `tauri::async_runtime::spawn` helper) is `pub(crate)` for module code.

**Bootstrap.** Each webview gets an initialization script from `bridge::bootstrap_script(ctx, caller)` (`ctx: &AppCtx`, `caller: Caller`, i.e. the window kind and its `WindowId`, since the script carries `winId`). It sets `window.__OMP_BOOTSTRAP__ = { platform, version, windowKind, winId }` and seeds the five `RENDERER_STORAGE_KEYS` into localStorage when they are absent, before any page script runs (including `pre-paint.js`, `src/renderer/index.html:12`, which reads `omp.themeScheme`). Build the script by serializing one `serde_json::Value` with `serde_json::to_string`; never use string interpolation. Escape U+2028/U+2029 and `<` (so `</script>` cannot appear), and drop non-string storage values. `platform` uses Node's names (`"darwin" | "win32" | "linux"`). `src/renderer/boot/boot-tauri.ts` reads the global and installs `window.omp` or `window.ompQuickEntry`. `main.tsx` imports `@boot` first, so the API exists before other renderer modules are evaluated.

### Webview security (foundation-owned, used by every window)

`src-tauri/src/webview.rs` exports `build_window(app, spec: WindowSpec) -> tauri::Result<WebviewWindow>`, the only way windows are created. `WindowSpec` (in `webview.rs`, `#[derive(Clone, Debug)]` with a `Default`) carries everything a caller may vary, so Phase 5 never edits this file: `kind: WindowKind`, `win_id: WindowId`, `url: &'static str` (`"index.html"` or `"quick-entry.html"`), `title: String`, `inner_size: (f64, f64)`, `min_inner_size: Option<(f64, f64)>`, `max_inner_size: Option<(f64, f64)>`, `position: Option<(f64, f64)>`, `visible: bool`, `decorations: bool`, `resizable: bool`, `minimizable: bool`, `maximizable: bool`, `skip_taskbar: bool`, `always_on_top: bool`, `focused: bool`, `background_color: Option<tauri::window::Color>`. The label is derived (`main-<n>` or `quick-entry`), never passed. `build_window` applies the spec first and the security settings below last, so no spec field can weaken them. The spike's window options are the source material (`../worktrees/tauri-spike/spike-tauri/src-tauri/src/lib.rs:280-310`): the quick-entry bar pins its size with equal `min_inner_size` and `max_inner_size` of 680×168 and leaves `resizable` at its default, because `resizable(false)` makes GTK grow the window to 680×200 (Phase 0 S6 human check).

- **Sandbox (Linux).** wry leaves the WebKitGTK web-process sandbox off ([wry #935](https://github.com/tauri-apps/wry/issues/935)) and builds the `WebKitWebContext` and the `WebKitWebView` back to back inside `WebViewBuilder::build` (`wry-0.57.0/src/webkitgtk/web_context.rs:32-50`), so Tauri's `with_webview` runs after the first web process exists and is too late. The hook Phase 0 S14 proved: `webview::install_sandbox_hook()`, called from `main.rs` before `tauri::Builder`, overrides the GObject `constructed` vfunc of the `WebKitWebContext` class once (`std::sync::Once`; `g_type_class_ref` of `webkit_web_context_get_type()`, replace `GObjectClass.constructed`, call the original, then `webkit_web_context_set_sandbox_enabled(TRUE)`), so every context is sandboxed before its first process. `build_window`'s `with_webview` then asserts `webview.context().is_sandbox_enabled()`; if it is false, or if `with_webview` itself returns an error, write a runtime log entry and exit the process with `SANDBOX_MISSING_EXIT_CODE` before the first window shows. Ubuntu 26.04 needs no AppArmor rule (its `bwrap-userns-restrict` profile already allows bubblewrap). Electron's renderer sandbox is a tested invariant today (`e2e/packaged-smoke.e2e.ts:139-156`); Phase 10 checks `Seccomp:\t2` on every `WebKitWebProcess`. The sandbox blocks `file://`; the renderer builds no such URL (Phase 9 Task 9.3 greps for it).
- **Data directory.** `paths::webview_data_dir()` for every window, the bar included, so the bar and chat windows share localStorage (the bar re-reads the theme on each summon: `src/renderer/quick-entry/appearance.ts:1-18`).
- **Navigation.** Allow only the initial app URL, then deny every navigation, matching Electron's `will-navigate` → `preventDefault()` (`src/main/window.ts:91-93`). New-window requests are denied; an `http`/`https` URL opens in the browser through `Host::open_url`, and no other scheme is ever opened (`window.ts:87-90`). The dev URL is allowed only when `cfg!(debug_assertions)` holds. `http(s)://tauri.localhost` counts as the app origin only under `cfg!(windows)`, where WebView2 serves the app from it; elsewhere it could resolve to a local server.
- **Downloads.** A `blob:` navigation is allowed only as a download, and only when `webview::download_allowed(url, dev_url, debug)` holds: the blob's inner origin is the app's (or the dev origin in debug). `build_window` registers `.on_download(...)`: WebKit writes the file to the user's Downloads folder under a hidden `.<suggested name>.<pid>-<n>.part`; on `Finished`, a spawned task asks `Host::save_dialog` (default `<Downloads>/<suggested name>`, parent = the window) and moves the file to the chosen path, or removes it on cancel or failure. The dialog cannot open inside the request callback, because that runs on the main thread the dialog needs. No channel exists for this; LogPanel's "Export logs" (`<a download>` on a `URL.createObjectURL` blob) uses it unchanged (decision of 2026-10-02, code review M8; `a6dead9`).
- **Reload detach.** `.on_page_load` calls `Bridge::detach(win_id)` on `PageLoadEvent::Started` (see Attach lifecycle → Robustness).
- **Drops.** `disable_drag_drop_handler()`, so HTML5 file drops reach the renderer. The navigation lock stops a dropped file from replacing the page.
- **Linux media and spelling.** Set `enable-media-stream` and `enable-webaudio`; answer `permission-request` by allowing audio `UserMediaPermissionRequest` only and denying everything else; enable spell checking with the system locale (fallback `en_US`); on `web-process-terminated`, reload once per 30 s (`src/main/renderer-recovery.ts:33`) and write a runtime log entry.
- **Init script.** `bootstrap_script(ctx, caller)`, added by `build_window` after the spec; a spec cannot add or replace init scripts.

**CSP.** The Tauri build strips the HTML meta CSP in `vite.tauri.config.ts` (`transformIndexHtml`), because the meta tag's `connect-src 'self'` blocks Tauri's IPC transport. `tauri.conf.json` → `app.security.csp` carries the same policy (Tauri adds its IPC origins), with `dangerousDisableAssetCspModification: ["style-src"]` so `'unsafe-inline'` styles keep working (KaTeX, Mermaid, xterm, `pre-paint.js`), while `script-src` keeps Tauri's hashing. `withGlobalTauri: false`. The inline `<style>` in `src/renderer/index.html:14-18` moves into `src/renderer/styles/first-paint.css`; Electron loads the same file, so its CSP test is unchanged.

**Capabilities.** `capabilities/main.json` (`windows: ["main-*"]`) grants exactly `allow-omp-invoke` and `allow-omp-attach`. `capabilities/quick-entry.json` (`windows: ["quick-entry"]`) grants exactly `allow-omp-quick-entry-invoke` and `allow-omp-attach`. No `core:*` and no plugin permissions: plugins are called from Rust only. `build.rs` declares the commands with `tauri_build::AppManifest::commands`.

### Profile, single instance and exit

- `paths::user_data_dir()` = `dirs::config_dir()/@oh-my-pi/omp-gui` (`paths::default_user_data_dir()`), or the resolved `--user-data-dir=<path>` (matching `src/main/user-data-directory.ts`). The webview data dir is `<user_data_dir>/webview`. Resolution is strict (`fe94ddf`): `run()` calls `paths::resolve_user_data_dir()` before anything else and exits with `STARTUP_FAILURE_EXIT_CODE` (on stderr, since no log location exists yet) when there is no config directory (`PathsError::NoConfigDir`); `user_data_dir()` panics if called before that, rather than inventing a relative path. `is_default_profile()` compares the resolved directory with `default_user_data_dir()`, so `--user-data-dir=` (empty) or `--user-data-dir=<the default path>` is the default profile. In a test build, resolving the default profile panics, and the process-wide runtime log defaults to `<temp>/sai-atlas-tests/<pid>-gui-runtime.jsonl`, so tests never touch the real profile.
- `paths::resolve_bundled_omp()` (packaged) searches, in Tauri's `resource_dir` order and without a runtime: on Linux `<exe dir>/../lib/Sai ATLAS/omp`, `$APPDIR/usr/lib/Sai ATLAS/omp`, `/usr/lib/Sai ATLAS/omp`; on macOS `<exe dir>/../Resources/omp`; then `<exe dir>/omp[.exe]` (`paths::bundled_omp_candidates`, `paths::resolve_bundled_omp_in` for tests). Dev uses `CARGO_MANIFEST_DIR/../resources/omp`. A system `omp` is never consulted; a miss returns `PathsError::BundledOmpMissing(Vec<PathBuf>)` with every searched path.
- `tauri-plugin-single-instance` is registered first. `paths::single_instance_id()` = `paths::single_instance_id_for(Some(user_data_dir()))` on a non-default profile: the app id plus `.p` and the first 16 hex chars of the SHA-256 of the resolved profile path; on the default profile, the bare app id (`single_instance_id_for(None)`). It is the plugin's D-Bus id on Linux, and for a non-default profile `lib.rs` also sets the Tauri identifier to it (`context.config_mut().identifier`), which changes the GtkApplication name as well, so throwaway profiles never hand off to the user's running app (Electron kept its lock inside the profile, `src/main/pin-user-data.ts:1-5`). The Wayland `app_id` still comes from `glib::set_prgname`. Phase 12 confirms the plugin keys on the identifier on macOS and Windows.
- `main.rs` exits with code 0 before anything else when `APPIMAGE_EXIT_AFTER_INSTALL=true`. The 0.9.x Electron AppImage updater runs the new AppImage with that variable and blocks until it exits (`src/main/updater.ts:225-232`).
- Shutdown order on `RunEvent::ExitRequested`/`Exit` (frozen), run to completion with `tauri::async_runtime::block_on`, unless `desktop.on_exit_requested(code)` returns true (then `api.prevent_exit()` and nothing else runs): set the quitting latch (`desktop.mark_quitting()`; layout persistence stops) → `tabs.dispose_all()` (every sidecar stopped through its supervisor in parallel, see Sidecar supervisor topology; the GUI waits for each supervisor to exit) → `omp.shutdown()` (stats, bench) → `services.shutdown()` (watchers) → `ollama.shutdown()` (pull, remedy) → `updater.shutdown()` (install on quit) → `desktop.shutdown()` (windows and tray). After `RunEvent::Exit`, `lib.rs` starts the program a module passed to `Host::relaunch_after_exit`, if any.
- **SIGTERM.** A plain SIGTERM to the Tauri process ends it without Tauri's exit path (Phase 0 observed this), so `lib.rs` installs a `tokio::signal::unix` SIGTERM listener (and SIGINT) that calls `AppHandle::exit(0)`, which runs the frozen shutdown order and gives the sidecars their grace. The listener keeps waiting after that: a second SIGTERM/SIGINT, or the graceful exit running past 15 s (`SIGNAL_EXIT_DEADLINE`, private), logs and calls `std::process::exit(128 + signo)` (`d830b75`). The shutdown futures run inside `block_on` on the main thread, so none may await a main-thread round trip issued from another thread (documented on `TabsPort::dispose_all`, `DesktopPort::shutdown` and `lib.rs::shutdown`). Windows handles `CTRL_CLOSE_EVENT` the same way in Phase 12.

### App identity (Linux)

tao sets the Wayland `app_id` from `g_get_prgname()`, which defaults to the binary name, and the identifier reaches GTK only when `tauri.conf.json` → `app.enableGTKAppId` is `true` (Phase 0 S11). `src-tauri/src/product.rs` holds `pub const PRODUCT_NAME: &str = "Sai ATLAS"` and `pub const APP_ID: &str = "vn.io.vif.saiatlas"`, mirroring `src/shared/product.ts`, with a test that parses that TS file through `include_str!` and asserts both values match. On Linux, `main.rs` calls `glib::set_prgname(Some(product::APP_ID))` and `glib::set_application_name(product::PRODUCT_NAME)` before anything initializes GTK (GTK sets prgname only when it is unset, so this wins). The webview storage path is keyed by the identifier, not prgname, and the single-instance D-Bus name does not clash with the GtkApplication name. Phase 8 provides the matching desktop entry (`StartupWMClass=vn.io.vif.saiatlas`).

### Sidecar supervisor topology (frozen; implemented in Phase 3)

Phase 0 S7b showed that after `kill -9` of the GUI, `omp` and its tool children survive: the agent's SIGTERM cleanup does not kill tool children, and stdin EOF makes it drain the running tool first (600 s for the gate's command). `PR_SET_PDEATHSIG` on omp alone leaves the tool child alive. The proven mitigation is a supervisor process, and its shape is frozen here because `main.rs`, `Cargo.toml` and the `omp` API snapshot all depend on it:

- **Process tree.** GUI → supervisor → `omp --mode rpc-ui` (own process group) → tool children. The supervisor is a re-exec of the GUI binary: `main.rs` checks `std::env::args().nth(1) == Some(ports::SUPERVISOR_ARGV)` (`pub const SUPERVISOR_ARGV: &str = "--omp-supervise"`) before `APPIMAGE_EXIT_AFTER_INSTALL` handling and before `tauri::Builder`, and then calls `omp::supervisor::run(args: Vec<OsString>) -> std::process::ExitCode` (stub in `src-tauri/src/omp/supervisor.rs` from this phase, body from Phase 3) and returns its result. No second `externalBin`, and the single-instance and deep-link plugins never see this process; Phase 5's `launch_argv::parse_launch_argv` still ignores `SUPERVISOR_ARGV` defensively, with a test.
- **Handle.** `SidecarHandle` exposes both `omp_pid() -> Option<u32>` and `supervisor_pid() -> Option<u32>`. The control channel is a `socketpair(AF_UNIX, SOCK_STREAM)` rather than a plain pipe so it carries one line the other way: the supervisor writes `pid <n>\n` with omp's pid right after the spawn, and otherwise only reads it, waiting for EOF. Status, restart policy and the stderr tail key on omp's exit status, which the supervisor forwards.
- **Linux primitives.** The supervisor runs in its own session (`setsid`) with `prctl(PR_SET_CHILD_SUBREAPER, 1)` and `prctl(PR_SET_PDEATHSIG, SIGTERM)`. A dedicated control channel is the primary parent-death signal: the GUI holds one end and the supervisor inherits the other as fd 3; EOF means the GUI is gone. PDEATHSIG stays as belt and braces only, because it fires when the forking *thread* exits and tokio can retire that thread.
- **No relay.** omp inherits the supervisor's stdin, stdout and stderr, which are the GUI's pipes (`Stdio::inherit()`, the dup2 the counsel asked for), so the supervisor never touches an NDJSON frame and the S3/S7 numbers stay valid. The supervisor writes nothing to stdout, writes to stderr only on failure with a `supervisor:` prefix, and never panics on a closed pipe.
- **Shutdown.** On SIGTERM or control-channel EOF: SIGTERM omp, wait up to 5 s, SIGKILL omp's process group, then sweep every process whose parent is the supervisor (`/proc/*/stat` ppid) with SIGKILL in passes until a pass kills nothing or 2 s elapse, and exit with omp's exit status (143 after the agent's SIGTERM handler, which the restart policy reads unchanged). The GUI stops a sidecar by closing its end of the control channel and sending SIGTERM to the supervisor; both paths run the same sequence.
- **Other OSes.** Windows uses no supervisor: the GUI holds a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assigns omp to it (Phase 12; check that pi-natives does not spawn with `CREATE_BREAKAWAY_FROM_JOB`). macOS uses the supervisor with the control channel plus kqueue `EVFILT_PROC`/`NOTE_EXIT` on the GUI pid and a recursive `proc_listchildpids` snapshot taken before killing omp, because orphans reparent to launchd there (Phase 12). Until Phase 12, those `cfg` branches spawn omp directly and stop it with `Child::kill`.
- **Proof.** Phase 3 ports the S7b gate as a Rust test (`kill -9` of the parent → omp stand-in and tool child gone within 10 s), and Phase 10's packaged smoke repeats it with the real agent.

### Plugins

`lib.rs` registers every plugin once: `single-instance` (first), `deep-link`, `dialog`, `opener`, `notification`, `clipboard-manager`, `global-shortcut`. Modules use them only through `Host` or their own `AppHandle`. Not used: `process`, `os`, `updater`.

### Test hooks

Test-only behavior is compiled only with the cargo feature `e2e-hooks`, and release bundles never enable it (Phase 8 tests this). Under that feature, `bridge.rs` supports: per-channel fault scripts (`Fault::Error(msg)`, `Fault::Delay(ms)`, `Fault::Barrier(id)` released by `test:release`), event injection (`test:emit { winId, channel, payload }`), `test:quit`, `test:windows`, `test:second-instance { argv }` and `test:navigation-probe`. Phase 10 fills `test_hooks.rs` and may add hooks there, but only behind the feature.

## Module ownership (frozen)

| Module (gate key) | Rust dir | Ported from | Wave phase |
|---|---|---|---|
| foundation | `src-tauri/src/{main,lib,ctx,ports,bridge,webview,prefs,paths,product,i18n,runtime_log,testing,test_hooks}.rs` | `user-data-directory.ts`, `bundled-omp-path.ts`, `initial-cwd.ts`, `default-workspace.ts`, `agent-paths.ts`, `i18n.ts`, `runtime-log*.ts`, the webview parts of `window.ts`/`renderer-recovery.ts` | this phase (`test_hooks.rs` body: Phase 10) |
| omp | `src-tauri/src/omp/` (including `supervisor.rs`, stubbed here) | `sidecar.ts`, `rpc-bridge.ts`, `rpc-client.ts`, `event-batcher.ts`, `shell-env.ts`, proxy resolution in `index.ts:208-233`, `stats-server.ts`, `stats-client.ts`, `stats-restart-policy.ts`, `benchmark-runner.ts` | Phase 3 |
| tabs | `src-tauri/src/tabs/` | `sidecar-pool.ts`, `tab-spawn.ts`, `window-spawn-target.ts`, `snowflake.ts`, the pool factory and ready health check in `index.ts:356-399`, tab/rpc/sidecar handlers in `ipc.ts` | Phase 4 |
| desktop | `src-tauri/src/desktop/` | `window.ts` (window manager), `window-bounds.ts`, `tab-layout.ts`, app lifecycle and layout wiring in `index.ts:260-346, 396-555`, `quick-entry*.ts`, `wayland-portal.ts`, `tray*.ts`, `menu.ts`, `deep-link.ts`, `launch-argv.ts`, `app-quit.ts`, `quit-guard.ts`, `app-icons.ts` | Phase 5 |
| services | `src-tauri/src/services/` | `session-index.ts`, `session-cache.ts`, `log-watcher.ts`, `models-config.ts`, `provider-cleanup.ts`, `dialog-memory.ts`, `editor.ts`, `open-path-target.ts`, fs/system/prefs/session handlers and `executeGuiHostTool` (`ipc.ts:1222`) | Phase 6 |
| ollama | `src-tauri/src/ollama/` | `src/main/ollama/*`, `src/shared/ollama-catalog.ts` | Phase 7 |
| updater | `src-tauri/src/updater/` + the packaging files listed in Phase 8 | `updater.ts`, `updater-state.ts` | Phase 8 |
| renderer | `src/renderer/**` minus the frozen boot files | — | Phase 9 |

Not ported (Electron-only workarounds; no parity entry): `renderer-recovery.ts` ASAR logic (assets are embedded; the crash reload lives in `webview.rs`), `editable-context-menu.ts` (native webview menus provide spelling; Phase 9 suppresses the non-editable menu), `pin-user-data.ts` (covered by `paths`), `src/main/packaging-config.test.ts` (Phase 8 writes the Tauri equivalent; Phase 12 ports its CSP rules).

## Channel ownership (frozen)

`IPC_COMMANDS` + `IPC_EVENTS` hold 94 channels (68 + 26). Each has exactly one owner. "R→M" marks the two `IPC_EVENTS` entries the renderer sends to main.

| Module | Handles (invoke/send) | Emits |
|---|---|---|
| omp | `stats:fetch`, `bench:run`, `bench:abort` | `stats:data` |
| tabs | `rpc:command`, `rpc:command-for-tab`, `extension-ui:respond`, `host-tool:result`, `host-tool:update`, `host-uri:result`, `tab:spawn`, `tab:close`, `tab:set-active`, `tab:set-view`, `tab:get-all`, `tab:get-session-owner`, `sidecar:restart`, `sidecar:status-get`, `sidecar:select-project`, `sidecar:set-project`, `sidecar:default-workspace`, `prefs:update-launch-profile` | `rpc:events`, `sidecar:status`, `tab:status`, `extension-ui:request`, `host-tool:call`, `host-uri:request`, `subagent:frame`, `commands:update`, `config:update`, `prompt:result`, `command:output`, `session-info:update`, `extension:error`, `live:update`, `model-catalog:update` |
| desktop | `app:quit`, `quick-entry:submit`, `quick-entry:consume-restored`, `quick-entry:dismiss`, `quick-entry:claim`, `quick-entry:ack`, `quick-entry:return`, `quick-entry:shortcut-get`, `quick-entry:shortcut-set`, `quick-entry:shortcut-suspend`, `quick-entry:shortcut-notice`, `tray:state-push` (R→M), `progress:set` (R→M) | `menu:action`, `deep-link`, `quick-entry:state` |
| services | `runtime:error-report`, `runtime:log-path`, `log:snapshot`, `sessions:list`, `sessions:delete`, `sessions:rename`, `sessions:search`, `session:open-new-window`, `session:consume-pending`, `system:open-external`, `system:open-path`, `system:save-dialog`, `system:open-dialog`, `system:clipboard-read`, `system:notify`, `prefs:get`, `prefs:set`, `models:providers-list`, `provider-cleanup:config`, `fs:list`, `fs:read`, `fs:read-plan`, `fs:read-image`, `editor:open-external` | `sessions:changed`, `log:line` |
| ollama | `ollama:status`, `ollama:model-screen`, `ollama:pull`, `ollama:pull-cancel`, `ollama:warm`, `ollama:remedy`, `ollama:open-download` | `ollama:pull-progress`, `ollama:install-progress` |
| updater | `updater:check`, `updater:download`, `updater:apply`, `updater:getStatus`, `updater:version` | `updater:status` |

Scope: `Scope::QuickEntry` covers exactly `quick-entry:submit`, `quick-entry:consume-restored` and `quick-entry:dismiss`, plus delivery of `quick-entry:state`. Those are the only channels in `src/preload/quick-entry-api.ts`. Everything else is `Scope::Main`, including `quick-entry:claim`, `ack`, `return` and `shortcut-*` (main-window API, `src/preload/index.ts:382-393`).

## Files (owned by this phase; frozen after it)

- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json` (minimal; Phase 8 takes ownership), `src-tauri/capabilities/main.json`, `src-tauri/capabilities/quick-entry.json`
- `src-tauri/src/{main,lib,ctx,ports,bridge,webview,prefs,paths,product,i18n,runtime_log,testing,test_hooks}.rs`, `src-tauri/rust-toolchain.toml`
- `src-tauri/src/omp/supervisor.rs` (stub: `pub fn run(args: Vec<OsString>) -> ExitCode` returning `todo!()`; Phase 3 fills it)
- Per module `M` in {omp, tabs, desktop, services, ollama, updater}: `src-tauri/src/M/mod.rs` (production struct implementing its port with stub bodies, `register`, `CHANNELS`) and `src-tauri/src/M/ipc.rs` (handler stubs)
- `src-tauri/tests/channels.rs`, `src-tauri/contracts/cross-module-calls.json`, `src-tauri/contracts/<module>.api.txt` (×6), `src-tauri/contracts/<module>.parity.json` (foundation + 6 modules)
- `scripts/check-module.sh`, `scripts/check-test-parity.ts`, `scripts/check-test-parity.test.ts`, `scripts/tauri-dev.ts`, `scripts/rust-pins.env`
- `src/shared/bridge/ipc-port.ts`, `src/shared/bridge/create-omp-api.ts`, `src/shared/bridge/create-quick-entry-api.ts`, plus `src/preload/deep-link-buffer.ts` (+ test) moved to `src/shared/bridge/` with `git mv`
- `src/renderer/boot/boot-electron.ts`, `src/renderer/boot/boot-tauri.ts`, `src/renderer/boot/tauri-port.ts`, `src/renderer/boot/tauri-port.test.ts`, `src/renderer/styles/first-paint.css`
- `vite.renderer.shared.ts`, `vite.tauri.config.ts`
- Modify: `src/preload/index.ts`, `src/preload/quick-entry-api.ts` (deleted after the move), `src/renderer/main.tsx`, `src/renderer/quick-entry/main.tsx`, `src/renderer/index.html` (inline style → `first-paint.css` link), `src/renderer/global.d.ts`, `electron.vite.config.ts`, `package.json`, `bun.lock`, `.gitignore`

## Execution notes

- One executor on the strongest available model, in `../worktrees/tauri-foundation` on branch `tauri/foundation`, branched from `main` at `2b0b698` (or later, once Phase 9 Task 9.2 is merged; see Preconditions).
- Commit after every task, so a re-spawned executor resumes from the last green task instead of starting over.
- Source material from the spike (never copied blindly; it has no error handling): `../worktrees/tauri-spike/spike-tauri/src-tauri/src/sandbox.rs` (the `constructed` override), `s7.rs` (`run_supervise`, the orphan sweep), `lib.rs:280-310` (window options, including the quick-entry size fix) and `webkit_features.rs` (media and permission settings).
- Hard-link the sidecar into the worktree (`ln resources/omp ../worktrees/tauri-foundation/resources/omp`); the file is 301 MB and git-ignored.
- Task 2.8 opens a dev window on the user's desktop. Tell the user before starting it.
- `plans/` is untracked, so the worktree has no copy. Read every plan file by absolute path from the main checkout (`/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/`), and write reports there too.

## Tasks

### Task 2.1: Branch, scaffold and dependencies
- Goal: a Tauri 2.12 crate that builds on this machine, with every dependency the wave needs.
- Steps:
  1. `git switch -c tauri/foundation main`. Confirm Phase 1 is present: `test -f src/shared/renderer-storage.ts`.
  2. Create `src-tauri/` by hand: package `sai-atlas`, edition `2021`, `[lib] name = "sai_atlas_lib", crate-type = ["staticlib", "cdylib", "rlib"]`. Declare `[features] e2e-hooks = []`; `default` is empty.
  3. Add every dependency now; nobody adds one later: `tauri` (features `tray-icon`, `image-png`), `tauri-plugin-single-instance` (feature `deep-link`), `tauri-plugin-deep-link`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-notification`, `tauri-plugin-clipboard-manager`, `tauri-plugin-global-shortcut`, `serde` (`derive`), `serde_json`, `serde_yml`, `tokio` (`rt-multi-thread`, `macros`, `process`, `io-util`, `time`, `sync`, `fs`, `signal`), `futures-util`, `thiserror`, `base64`, `reqwest` (`default-features = false`, features `json`, `stream`, `rustls-tls`), `notify`, `dirs`, `which`, `sha2`, `hex`, `regex`, `semver`, `chrono` (`serde`), `tracing`, `rusty-leveldb` (the one-time Chromium localStorage import). Unix: `nix` (features `signal`, `process`, `socket`, `fs`, `event`; the supervisor needs `setsid`, `prctl`, `socketpair`, `kill`, `waitpid` and, on macOS in Phase 12, kqueue) and `libc`. No voice dependency: dictation moved to WebAudio capture in the renderer (Phase 9 Task 9.2), so there is no `cpal` and no voice channel. Linux: `ashpd` (features `tokio`, `global_shortcuts`, `proxy_resolver` or the version's equivalents), `gtk`, `glib` (for `set_prgname`/`set_application_name`), `gobject-sys`, `webkit2gtk` and `webkit2gtk-sys`. Resolve `tauri` first, then read the webkit2gtk, glib and gobject versions from `cargo tree -i webkit2gtk`, `cargo tree -i glib` and `cargo tree -i gobject-sys`, and write those exact versions; never pin them before resolving tauri (the spike's `webkit2gtk = "=2.0.1"` pin dragged the resolver down to `tauri 2.9.5` with a runtime that does not compile; the correct pair was `tauri 2.12.1` with `webkit2gtk-rs 2.0.2`). macOS: `tauri-nspanel` (git tag for Tauri 2); if `cargo check --target aarch64-apple-darwin` fails on it, drop it and record "quick-entry uses an always-on-top window on macOS" in the Validation Log. Dev: `tempfile`.
  4. Add `src-tauri/target/`, `src-tauri/gen/`, `src-tauri/binaries/` and `dist-release/` to `.gitignore`.
  5. Toolchain: `/usr/bin/cargo` (the distro's 1.93.1) shadows `~/.cargo/bin/cargo` (rustup, 1.99.0) because rustup was installed with `--no-modify-path`. Write `src-tauri/rust-toolchain.toml` (`channel = "stable"`) and `scripts/rust-pins.env` with `CARGO_HOME_BIN="$HOME/.cargo/bin"`, `CARGO_PUBLIC_API_VERSION=<the version installed in Task 2.6>` and `PUBLIC_API_TOOLCHAIN=nightly-YYYY-MM-DD` (the nightly date `cargo-public-api` requires on install day). Every script in this plan that runs cargo (`check-module.sh`, `tauri-dev.ts`, the package scripts, Phase 8 CI) sources or reads that file, puts `CARGO_HOME_BIN` first on `PATH`, and fails loudly (`cargo tauri is missing; run ~/.cargo/bin/cargo install tauri-cli --version "^2" --locked`) when `cargo tauri --version` does not start with `tauri-cli 2.`.
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml` exits 0, `cargo build --manifest-path src-tauri/Cargo.toml --features e2e-hooks` exits 0, and `cargo tree --manifest-path src-tauri/Cargo.toml -i webkit2gtk | head -1` names the same version as the `webkit2gtk` line in `Cargo.toml`. `grep -c "cpal" src-tauri/Cargo.toml` prints `0`.

### Task 2.2: Shared bridge builder (TypeScript)
- Goal: the `OmpApi` object is built by shared code from an `IpcPort`, and Electron behaves exactly as before.
- Steps:
  1. Create `ipc-port.ts` with the interface above.
  2. Move everything that builds the API from `src/preload/index.ts` (`rpcCommand`, `isolated`, `subscribe`, `subscribeActiveTab`, `subscribeTab`, the `DeepLinkBuffer` wiring with its hold rule `deliver(link, link.action !== "quick-entry")`, and the `api` literal) into `create-omp-api.ts` as `createOmpApi(port: IpcPort, platform: OmpApi["platform"]): OmpApi`. Replace `ipcRenderer.invoke` with `port.invoke`, `ipcRenderer.send` with `port.send`, and `on`/`removeListener` pairs with `port.on`.
  3. Move `src/preload/quick-entry-api.ts` to `create-quick-entry-api.ts` as `createQuickEntryApi(port, platform)` (the API exposes `platform`, and `process.platform` does not exist in shared code). Move the deep-link buffer and its test with `git mv`.
  4. Rewrite `src/preload/index.ts` to about 30 lines: an `ipcRenderer` port (its `on` wrapper strips the event argument), the `--omp-quick-entry` argv check, and `contextBridge.exposeInMainWorld`.
- Verify: `bunx vitest run` exits 0, `bun run check:types` exits 0, and `grep -c "IPC_COMMANDS\." src/preload/index.ts` prints `0`.

### Task 2.3: Renderer boot entry
- Goal: both renderer entries import `@boot` first; it is a no-op in Electron and installs the Tauri bridge in Tauri.
- Steps:
  1. `boot-electron.ts`: a comment only.
  2. `tauri-port.ts`: the port in the Bridge table (seq counter, one `Channel`, `omp_attach`, the listener map, `Error` wrapping). Take the invoke command name as a parameter.
  3. `boot-tauri.ts`: read `window.__OMP_BOOTSTRAP__` (throw a clear error if it is missing), build the port, and assign `window.omp = createOmpApi(port, platform)` or `window.ompQuickEntry = createQuickEntryApi(port, platform)`, with `platform` from `window.__OMP_BOOTSTRAP__`.
  4. `import "@boot";` as the first line of `src/renderer/main.tsx` and `src/renderer/quick-entry/main.tsx`. Declare `__OMP_BOOTSTRAP__` in `global.d.ts`.
  5. `bun add @tauri-apps/api` and `bun add -d @tauri-apps/cli`.
  6. `tauri-port.test.ts` with `@tauri-apps/api/mocks`: `invoke forwards channel positional args and a rising seq`, `attach and every invoke carry the same page generation`, `undefined args become null`, `invoke rejects with an Error carrying the Rust message`, `on registers synchronously and the remover stops delivery`, `a throwing listener does not stop the others`, `send swallows rejections`.
- Verify: `bunx vitest run src/renderer/boot` exits 0 with `7 passed`.

### Task 2.4: Vite configs and CSP
- Goal: one renderer config for both shells, differing only in the `@boot` alias and the CSP handling.
- Steps:
  1. `vite.renderer.shared.ts` exports `rendererConfig(bootModule)`, containing the existing renderer block (tailwind, aliases, both HTML inputs, `manualChunks` with `VENDOR_CHUNK_RULES` and `SHARED_HELPER_ID` moved unchanged) plus `"@boot": bootModule`.
  2. `electron.vite.config.ts`: `renderer: rendererConfig(".../boot-electron.ts")`.
  3. `vite.tauri.config.ts`: `root: "src/renderer"`, `rendererConfig(".../boot-tauri.ts")`, a `transformIndexHtml` plugin removing `<meta http-equiv="Content-Security-Policy">`, `build.outDir: "../../out/renderer-tauri"`, `emptyOutDir: true`, and `server.port` from `OMP_TAURI_DEV_PORT` (default 5183) with `strictPort: true`.
  4. Move the inline `<style>` of `src/renderer/index.html` into `src/renderer/styles/first-paint.css`, linked from the same place.
  5. `scripts/tauri-dev.ts`: reads `scripts/rust-pins.env`, prepends `CARGO_HOME_BIN` to `PATH` and exits with the Task 2.1 step 5 message when `cargo tauri` is missing; picks the dev port by worktree (`foundation`/`integration` 5183, `omp` 5184, `tabs` 5185, `desktop` 5186, `services` 5187, `ollama` 5188, `updater` 5189, `renderer` 5190, from the worktree directory name). It refuses to start without `--user-data-dir=<path>`. It runs `tauri dev --config '{"build":{"devUrl":"http://localhost:<port>"}}' -- -- --user-data-dir=<path>`. If the port is busy, it prints the owner (`ss -ltnp`) and exits instead of picking another port.
  6. Package scripts: `build:renderer:tauri`, `dev:tauri` (→ `bun scripts/tauri-dev.ts`), `build:tauri`.
- Verify: `bun run build` exits 0 (Electron, including `check-renderer-chunks.ts`), `bun run build:renderer:tauri` exits 0, and `grep -c "Content-Security-Policy" out/renderer-tauri/index.html` prints `0`.

### Task 2.5: Foundation Rust modules
- Goal: the shared services, fully implemented and tested.
- Targets and tests:
  1. `paths.rs`: `user_data_dir()`, `webview_data_dir()`, `agent_dir()`, `resolve_bundled_omp()` (packaged: the resource-dir search in Design → Profile, single instance and exit, then the executable's dir; dev: `CARGO_MANIFEST_DIR/../resources/omp`), `ensure_default_workspace()`, `initial_cwd()`, `single_instance_id()`. Port the tests of `bundled-omp-path` (3), `initial-cwd` (3) and `user-data-directory` (2).
  1b. `product.rs`: `PRODUCT_NAME` and `APP_ID` as in Design → App identity. Test `mirrors the shared product constants`: `include_str!("../../src/shared/product.ts")`, extract both string literals with a regex, assert equality.
  2. `prefs.rs`: `JsonStore` as in Ordered dispatch. Tests: `nests dotted keys`, `reads electron-store files unchanged`, `update is atomic under concurrent callers`, `unique temp names leave no residue`, `missing file reads as empty`, `renderer storage reads the five nested keys`.
  3. `i18n.rs`: port `src/main/i18n.ts`.
  4. `runtime_log.rs`: port `runtime-log-core.ts` + `runtime-log.ts`, writing to the same path `runtime-log-core.ts` computes, with its 5 tests.
  5. `bridge.rs`: `Scope`, `Caller`, `IpcError` (`{ message }`), `Reply`, `Handler`, `Registry::register(channel, scope, handler)`, the per-window ordered dispatcher, `omp_invoke`, `omp_quick_entry_invoke`, `omp_attach`, outbound queueing, replay, kind filtering, `Bridge::emit_to_window(win_id, channel, Value)`, `Bridge::broadcast_main(channel, Value)`, `bootstrap_script`, `dispatch_for_test(&Arc<AppCtx>, Caller, channel, args) -> Result<Value, IpcError>` (`#[cfg(test)]`, runs the ordered dispatcher without Tauri), and the `e2e-hooks` fault/emit machinery. Tests: `dispatches in seq order when calls arrive out of order`, `an invoke that arrives before its attach waits for that generation`, `an older generation is rejected after reattach`, `a missing seq is skipped after the gap timeout` (with `tokio::time::pause()`), `later futures do not block the next admission` (the first handler returns `Later` with a future that never resolves during the test; assert the second handler ran), `rejects a main channel from the quick-entry window`, `reattach drops the old channel`, `queues before attach and flushes on attach`, `replays undelivered deep links in order`, `quick-entry receives only its state channel`, `bootstrap escapes hostile values` (quotes, backslashes, `</script>`, U+2028), `fault hooks are absent without the feature`.
  6. `webview.rs`: `WindowSpec`, `build_window` and, on Linux, `install_sandbox_hook()` as in Webview security (source material: `../worktrees/tauri-spike/spike-tauri/src-tauri/src/sandbox.rs`). Test the navigation predicate as a pure function: `allows the initial app url`, `denies later navigations`, `denies non-http new windows`, `allows the dev url only in debug`. Test the spec as a pure function over a recorded builder (`apply_spec` returns the list of builder calls it would make): `equal min and max inner size are applied and resizable is left alone`, `security settings are applied after the spec`, `the label derives from kind and id`. The sandbox hook is covered by Task 2.8's Seccomp check, not by a unit test.
  7. `ctx.rs`, `ports.rs`, `testing.rs`: as in Design.
  8. `test_hooks.rs`: `pub fn register(reg: &mut Registry)`, empty without `e2e-hooks`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --lib -- paths product prefs i18n runtime_log bridge webview` exits 0 and prints `test result: ok`.

### Task 2.6: Ports, stubs and API snapshots
- Goal: every wave module compiles with its final public API and stub bodies.
- Steps:
  1. Build `src-tauri/contracts/cross-module-calls.json` as described in Design → Cross-module contract inventory. Every entry must appear as a method in `ports.rs`.
  2. For each module, write the production struct implementing its port with `todo!()` bodies, `pub fn register(reg: &mut Registry)` registering every owned channel to a handler stub that returns `Reply::Ready(Err(IpcError::not_ported(channel)))`, and `pub const CHANNELS: &[(&str, Scope)]` with exactly the module's rows. For `omp`, also `supervisor.rs` with `pub fn run(args: Vec<OsString>) -> ExitCode { todo!() }`, and `SidecarHandle` in `ports.rs` with `omp_pid()` and `supervisor_pid()` (Design → Sidecar supervisor topology). `ports.rs` also holds `pub const SUPERVISOR_ARGV: &str = "--omp-supervise"`.
  3. Serde types use `#[serde(rename_all = "camelCase")]` and the TS type names (`IpcSpawnTabPayload` stays `IpcSpawnTabPayload`).
  4. Install the snapshot tool with pins: `~/.cargo/bin/cargo install cargo-public-api --version <latest> --locked`, then `~/.cargo/bin/rustup toolchain install <the nightly-YYYY-MM-DD it requires> --profile minimal`, and write both into `scripts/rust-pins.env` (Task 2.1 step 5). For each module, with `cargo +$PUBLIC_API_TOOLCHAIN`: `cargo public-api --manifest-path src-tauri/Cargo.toml -ss | grep "sai_atlas_lib::<module>::" > src-tauri/contracts/<module>.api.txt`. Make `ports` its own snapshot file too (`ports.api.txt`). This covers full signatures, structs, enums and traits.
- Verify: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets` exits 0, and `wc -l src-tauri/contracts/*.api.txt` lists 7 files, each with at least 3 lines.

### Task 2.7: Channel completeness test
- Goal: the Rust side can never drift from `ipc-types.ts` unnoticed.
- Steps:
  1. `include_str!("../../src/shared/ipc-types.ts")`. Extract the values in the `IPC_COMMANDS` and `IPC_EVENTS` blocks with `^\s*[A-Z_]+: "([A-Za-z0-9:/_-]+)"`, and assert the count is 94.
  2. `every_channel_has_one_owner`: the union of all modules' `CHANNELS` and emitted-stream lists equals the TS set, with no duplicates.
  3. `every_handler_is_registered`: build a `Registry` from every module's `register` and assert each handled channel is present with its `Scope`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --test channels` exits 0 with `2 passed`.

### Task 2.8: App wiring and first window
- Goal: `bun run dev:tauri -- --user-data-dir=$(mktemp -d)` opens a sandboxed window running the real renderer, and `runtime:log-path` works end to end.
- Steps:
  1. `main.rs`, in this order: (a) if `args().nth(1) == Some(ports::SUPERVISOR_ARGV)`, return `omp::supervisor::run(args)`; (b) exit 0 when `APPIMAGE_EXIT_AFTER_INSTALL=true`; (c) on Linux, `glib::set_prgname(Some(product::APP_ID))`, `glib::set_application_name(product::PRODUCT_NAME)` and `webview::install_sandbox_hook()`, all before anything touches GTK; (d) `sai_atlas_lib::run()`. Phase 0 S1 needed no WebKit env var (`__NV_DISABLE_EXPLICIT_SYNC`, `WEBKIT_DISABLE_DMABUF_RENDERER`), so `main.rs` sets none; if a later machine needs one, that is a plan change, not a quiet addition. `unsafe` is allowed in three files only, each use with a `// SAFETY:` comment saying why: `webview.rs` (the GObject `constructed` override and the webkit2gtk hooks), and in the omp module exactly two places, `omp/manager.rs` (the `pre_exec` that dups the control channel to fd 3) and `omp/supervisor.rs` (the one `OwnedFd::from_raw_fd(3)` that takes that channel; `FromRawFd::from_raw_fd` is an `unsafe fn`). `main.rs` needs none. No gate scans for `unsafe`; Phase 3 Task 3.6 checks the omp count with `grep` (Phase 3 → Wave rules).
  2. `lib.rs`: the plugins in Design order, `setup` constructing `AppCtx` with every production port, one `Registry` from every module's `register` (plus `test_hooks::register` under the feature), `init` for each module (foundation, omp, services, tabs, desktop, ollama, updater), the bridge commands in `generate_handler!`, the frozen shutdown order, and the SIGTERM/SIGINT listener from Design → Profile, single instance and exit (`tokio::signal::unix::signal(SignalKind::terminate())` and `interrupt()`, each calling `app_handle.exit(0)`).
  3. The `desktop` stub's `init` opens one window through `webview::build_window(app, WindowSpec { kind: WindowKind::Main, win_id: WindowId(1), url: "index.html", title: product::PRODUCT_NAME.into(), inner_size: (1400.0, 900.0), ..Default::default() })`, with a `// replaced by the window manager` comment. Phase 5 replaces it.
  4. `tauri.conf.json`: `productName: "Sai ATLAS"`, `identifier: "vn.io.vif.saiatlas"`, `mainBinaryName: "sai-atlas"`, `build.frontendDist: "../out/renderer-tauri"`, `build.beforeBuildCommand: "bun run build:renderer:tauri"`, `app.windows: []` (Tauri 2.12 creates configured windows before the user `setup` hook, `tauri-2.12.1/src/app.rs:2375-2382`, which would bypass `build_window`), `app.enableGTKAppId: true` (Design → App identity), `app.withGlobalTauri: false`, `app.security.csp` equal to the meta CSP in `src/renderer/index.html` with `dangerousDisableAssetCspModification: ["style-src"]` (Design → CSP), and `plugins.deep-link.desktop.schemes: ["omp"]`, so Phase 5 can test links before Phase 8 lands.
- Verify: tell the user a dev window is about to open on their desktop, then start `WAYLAND_DEBUG=1 bun run dev:tauri -- --user-data-dir=$(mktemp -d)` with the harness's background runner, capturing stderr to a file, and note its PID. In the webview console, `await window.omp.runtime.logPath()` returns a path inside the throwaway profile. `grep Seccomp /proc/$(pgrep -n WebKitWebProces)/status` prints `Seccomp:	2`. `grep -c 'set_app_id("vn.io.vif.saiatlas")' <stderr file>` prints at least `1`. Then send SIGTERM to the Tauri process: it exits within 10 s and the runtime log shows the shutdown order ran. Stop anything still running.

### Task 2.9: Gate scripts
- Goal: wave executors verify themselves mechanically.
- Steps:
  1. `scripts/check-test-parity.ts <module>`: read `src-tauri/contracts/<module>.parity.json` (`[{ "ts": "src/main/x.test.ts", "rust": "src-tauri/src/m/x.rs" }]`). Collect `it("…")`/`test("…")` names, and `it.each(…)("…")`/`test.each(…)("…")` names with the suffix `_cases`. Normalize them: lowercase, non-alphanumerics → `_`, collapse repeats, trim, `_2`/`_3` for duplicates. Each name must exist as a `fn` in a `#[cfg(test)]` module of the Rust file, and its body must contain `assert`. Print every miss; exit 1 on any. Unit-test the collector in `scripts/check-test-parity.test.ts`, covering `it.each`.
  2. Parity files: foundation ← `bundled-omp-path`, `initial-cwd`, `user-data-directory`, `runtime-log-core`; omp ← `rpc-bridge`, `sidecar`, `shell-env`, `stats-restart-policy`, `stats-server`, `benchmark-runner`; tabs ← `sidecar-pool`, `tab-spawn`, `window-spawn-target`; desktop ← `quick-entry-core`, `quick-entry-shortcut-core`, `quick-entry-shortcut`, `wayland-portal`, `tray-labels`, `tab-layout`, `window-bounds`, `launch-argv`, `quit-guard`, `app-icons`; services ← `session-cache`, `session-index`, `log-watcher`, `models-config`, `provider-cleanup`, `dialog-memory`, `open-path-target`; ollama ← `base-url`, `hardware`, `install-progress`, `probe`, `pull`, `remedy`, `warm`, and `src/shared/ollama-catalog.test.ts` → `src-tauri/src/ollama/catalog.rs`; updater ← `updater-state`. No skip entries.
  3. `scripts/check-module.sh <module>` sources `scripts/rust-pins.env`, prepends `CARGO_HOME_BIN` to `PATH`, fails loudly when `cargo tauri --version` is missing (Task 2.1 step 5), runs the snapshot step with `cargo +$PUBLIC_API_TOOLCHAIN public-api`, and then, with `BASE=${BASE:-$(git merge-base HEAD tauri/foundation)}`, stops at the first failure and runs:
     1. `git diff --name-only $BASE` ⊆ the module's owned paths;
     2. no `todo!(`, `unimplemented!(` or `not_ported(` in owned Rust files;
     3. the regenerated `cargo public-api` snapshot for the module equals `contracts/<module>.api.txt` byte for byte, and so does `ports.api.txt`;
     4. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings -D clippy::unwrap_used -D clippy::expect_used` (crate root: `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]`);
     5. every owned file that derives `Serialize`/`Deserialize` contains `rename_all`;
     6. no `std::thread::sleep` or `std::process::Command` in owned files;
     7. `bun scripts/check-test-parity.ts <module>`;
     8. `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml --features e2e-hooks`;
     9. `cargo check` for `aarch64-apple-darwin` and `x86_64-pc-windows-msvc`, reported as WARN when the SDK is missing.

     It prints `check-module <module>: PASS` last on success. `updater` additionally runs `bunx vitest run scripts/ src/main/packaging-config.test.ts`. `renderer` replaces gates 2–9 with `bunx vitest run`, `bun run check:types`, `bunx biome check` over the changed files, `bun run build`, `bun run build:renderer:tauri` and `node scripts/lint-surfaces.mjs`.
  4. The script names modules, never plan phases.
- Verify: `bash scripts/check-module.sh omp; echo "exit=$?"` prints a gate-2 failure and `exit=1` (stubs present), and `bash scripts/check-module.sh foundation` prints `check-module foundation: PASS`. `PATH=/usr/bin:/bin bash scripts/check-module.sh foundation` still passes (the script finds rustup's cargo itself), and `CARGO_HOME_BIN=/nonexistent bash scripts/check-module.sh foundation; echo "exit=$?"` prints the `cargo tauri is missing` message and `exit=1`.

### Task 2.9b: Contract review before the wave branches
- Goal: no wave phase needs a frozen file. A step that has no contract to stand on is a plan bug found now, not in a worktree.
- Steps:
  1. Spawn a reviewer (the `code-reviewer` agent, or do it yourself if none can be spawned) with `ports.rs`, `webview.rs`, `bridge.rs`, `contracts/cross-module-calls.json` and the seven wave phase files (3 to 9).
  2. For every Task step in Phases 3 to 9 that calls another module, builds a window, uses an OS service or talks to the renderer, the reviewer names the exact `ports.rs` method, `WindowSpec` field, `Host` method or bridge call it will use, and writes the list to `plans/261002-1441-tauri-shell-migration/reports/phase-02-contract-review.md` as a table (`phase`, `task`, `step`, `contract`, or `GAP`).
  3. Fix every `GAP` in this phase (add the method, field or call; regenerate the snapshots), rerun the review until the table has no `GAP` rows, and commit.
- Success criteria: the review table exists and has zero `GAP` rows.
- Verify: `test -f plans/261002-1441-tauri-shell-migration/reports/phase-02-contract-review.md && grep -c "| GAP" plans/261002-1441-tauri-shell-migration/reports/phase-02-contract-review.md` prints `0`.

### Task 2.10: Foundation gate and commit
- Steps: run the gates below, then commit `feat(gui): add the Tauri shell foundation beside Electron`. The commit is the tip of `tauri/foundation`.
- Verify: `bunx vitest run`, `bun run check:types`, `bun run build`, `cargo test --manifest-path src-tauri/Cargo.toml --all-features` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` each exit 0.

## Risk

- The sandbox hook relies on wry building the context and the webview back to back and on `WebKitWebContext` having no subclasses; both held in wry 0.57.0 and WebKitGTK 2.52.6 (S14). A wry or WebKitGTK upgrade can move that point, which is why `build_window` asserts `is_sandbox_enabled()` and exits, and Phase 10 checks every web process: the failure is loud, never silent.
- Response chunking is settled: S3 returned 16 MiB in 69 ms and 64 MiB in 227 ms through one `invoke`, so the bridge has no chunking and this is frozen with the port table.
- The supervisor adds one process per sidecar (about 1 MB RSS each in the spike). The S2 margin (55.4% against the 60% threshold) covers it; Phase 10 measures the real number.

## Rollback

Delete the `tauri/foundation` branch. `main` and the Electron build are untouched until Phase 11.

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
