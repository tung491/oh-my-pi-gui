# Code review: Phase 2 Tauri foundation (`tauri/foundation`, b83f19c..d4ce82e)

Date: 2026-10-02 (Asia/Seoul). Worktree `/home/tung491/WORK/worktrees/tauri-foundation`, `git diff main...HEAD` (81 files, +16.6k/-0.5k). Read-only review. I did not redo the contract-coverage review (2.9b). This review covers correctness, Electron regressions, and security.

## Scope and gates I ran

| Gate | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml --all-features` | 61 lib + 2 `channels` passed |
| `cargo clippy --all-targets --all-features -- -D warnings` | clean |
| `bunx vitest run` | 204 files / 1896 tests passed |
| `bun run check:types` | clean |
| `bun run build` (electron-vite + main-bundle + chunk guards) | exit 0 |
| `bun run build:renderer:tauri` | exit 0; `Content-Security-Policy` count 0 in both Tauri HTML outputs |
| `bunx biome check` on the touched TS files | clean |

No long-running processes or windows were started.

## (a) Electron regression: none found

I compared the old `src/preload/index.ts` + `quick-entry-api.ts` (main) with `src/shared/bridge/create-omp-api.ts`, `create-quick-entry-api.ts` and the new 28-line preload, channel by channel:

- Every `invoke` and `send` keeps its channel, its positional args and its sync/async kind. `port.invoke(ch, ...args)` forwards `undefined` args the way `ipcRenderer.invoke(ch, undefined)` did. `send` with no args is unchanged. The `ui.*`/`system.notify` fire-and-forget invokes are still unawaited; `void` adds no catch, so behavior is identical.
- `isolated()`: same `source: "preload"`, message, stack, and `details`, still sent on `RUNTIME_ERROR_REPORT`.
- `subscribeActiveTab` (`activeTabId === null || envelope.tabId === activeTabId`), `subscribeTab`, and the `setActive`/`setView` gating of `activeTabId` are byte-for-byte the same logic. The unsubscribe still removes the exact wrapped listener (`ipcRenderer.removeListener(channel, wrapped)`).
- Deep links: the hold rule `deliver(link, link.action !== "quick-entry")` is unchanged. The listener is now registered inside `createOmpApi`, and the preload calls that only when it is not the quick-entry bar, which is the old `if (!isQuickEntry)` guard.
- `window.ompQuickEntry`: the latest-state replay, `submit`, `consumeRestored` and `dismiss` are unchanged. `contextBridge` still exposes exactly one of the two globals.
- Build output: `out/preload/index.cjs` has a single `require("electron")`, so the sandboxed preload is still one self-contained bundle. `out/renderer/index.html` and `quick-entry.html` still carry the meta CSP, which is the only CSP Electron has; `src/main` is untouched and sets no CSP header. `pre-paint.js` and `pcm-capture-worklet.js` are both emitted. The `first-paint.css` rule is the first rule of `components-*.css`, the earliest stylesheet in both pages, so its cascade position matches the old inline `<style>` (both sat before the bundled theme CSS).

Low-risk note: see L8 (Windows path joining in `vite.renderer.shared.ts`).

## Findings

Marker: **[FROZEN]** means the fix lands in a file that is frozen for the wave (`plan.md:76`), so it must land on `tauri/foundation` before Phases 3–9 branch.

### High

**H1. A panicking handler permanently wedges its window's IPC [FROZEN: `bridge.rs`]**
- Evidence: `bridge.rs:464-468` sets `window.draining = true`, then `bridge.rs:483` calls `run_call` → `call_handler` → `handler(ctx, caller, args)` (`bridge.rs:546-548`). Nothing catches an unwind. The reset at `bridge.rs:485-490` is skipped, and every later `drain` returns at `bridge.rs:461` (`window.draining` is still true).
- Failure scenario: 49 `todo!()` bodies remain across the module stubs (tabs 23, desktop 12, services 7, omp 4+1, updater 2). During the wave, a ported `services` handler that calls `ctx.tabs.cwd_for(...)` before Phase 4 merges panics inside the tokio task. That renderer promise never settles, and every later `omp_invoke` from that window queues forever. The app looks frozen with no log line. The executor already hit this once (`Desktop::record` → `todo!()`, report line 30). The same applies after the wave to any `index out of bounds`, `unwrap` or `RefCell` panic in a handler.
- Fix: wrap the handler call in `std::panic::catch_unwind(AssertUnwindSafe(..))`, map a panic to `Reply::err(IpcError::new("handler for <channel> panicked"))`, and write a runtime-log entry. Also reset `draining` through a drop guard, not a straight-line statement. Add a test: register a handler that panics, assert that call rejects, and assert the next `seq` still dispatches.

**H2. Reattach can strand the new page's buffered calls, and runs handlers concurrently [FROZEN: `bridge.rs`]**
- Evidence: `draining` is per window (`bridge.rs:224`), but `drain` is per generation (`bridge.rs:452`).
  1. Thread T1 is inside a G1 handler with `draining = true`.
  2. The page reloads, and the new page's first `omp_invoke` calls (G2) arrive before its `omp_attach` (the spec says this happens). They buffer unattached (`bridge.rs:437-438`).
  3. `omp_attach(G2)` on T2 runs G1's flushed calls through `run_call` directly (`bridge.rs:402-404`), concurrently with T1's handler. That breaks the one-handler-at-a-time rule that `rpc:command` stdin ordering relies on.
  4. T2 then calls `drain(G2)`, sees `draining == true` and returns (`bridge.rs:461`).
  5. T1 finishes, loops, finds no G1 queue (`bridge.rs:457-459`) and returns.
  6. Nobody drains G2. No gap timer is armed either, because that only starts in the `None` branch.
- Failure scenario: the user clicks "Reload" in `RootErrorBoundary` (`window.location.reload()`, `RootErrorBoundary.tsx:38`) while the crashed page still has a call in flight. The new page fires its boot calls (`prefs:get`, `tabs:list`…) before attach completes and then awaits them. They never run, so the window hangs at boot until some unrelated call happens to arrive. The window for this race is small, but when it hits, the window is dead.
- Fix: key the drainer role per generation, or run the flushed calls under the drainer role. Also, at the end of `drain`, when `window.current_gen != gen`, re-enter `drain` for `current_gen`. Add a test: a barrier-style handler holds G1, reattach G2 with pre-buffered calls, release, and assert G2's calls resolve.

### Medium

**M1. Outbound messages are silently lost across a page reload or crash recovery [FROZEN: `bridge.rs`, `webview.rs`]**
- Evidence: the bridge only learns of a new page at `omp_attach`. Until then `window.sink` is still the old `Channel`. Tauri's `Channel::send` for payloads under 8 KiB is `webview.eval("runCallback(<old id>, …)")`, which returns `Ok` even after the page navigated (`tauri-2.12.1/src/ipc/channel.rs:293-300`). The new page has no such callback, so the message is dropped and the failure path at `bridge.rs:623` is never taken. Reloads happen through `RootErrorBoundary`, crash recovery (`webview.rs:423-436`, `webview.reload()`), and a user's Ctrl+R.
- Failure scenario: a deep link or `quick-entry:state` emitted during the reload is lost, which contradicts "every undelivered deep-link in order" on attach. A `sidecar:status` or `tab:status` change during crash recovery leaves the recovered UI stale.
- Fix: in `build_window`, add `.on_page_load(...)`. On `PageLoadEvent::Started`, call a new `Bridge::detach(win_id)` that sets `sink = None` (keeping `current_gen`), so emits queue into `pre_attach`/`undelivered_deep_links` until the new page attaches. Add a test: `detach` → emit → attach(g2) → the queued message arrives.

**M2. Attach replay can be overtaken by live emits [FROZEN: `bridge.rs`]**
- Evidence: `attach` publishes the new sink under the lock (`bridge.rs:386`), releases it, runs the flushed calls, and only then delivers `replay` (`bridge.rs:400-407`). Any concurrent `emit_to_window` sees the sink and sends directly (`bridge.rs:607-608, 623`). The JS `Channel` orders by send index, so the page sees the live message first.
- Failure scenario: `rpc:events` batch N is queued before attach, and batch N+1 arrives live during the attach. The renderer applies N+1 before N, so message deltas are out of order. A flushed old-generation handler that emits also lands ahead of the replay.
- Fix: send the replay while holding the lock (`Channel::send` from a worker only posts to the event loop), or add a `replaying` flag that makes concurrent emits append to `pre_attach` until the replay drains.

**M3. The send-failure path re-queues into replay state even when a newer page is attached [FROZEN: `bridge.rs`]**
- Evidence: `bridge.rs:623-635`. If `window.sink` is a different (newer) sink, the old sink is left alone, but the envelope is still pushed into `pre_attach` (with no `PRE_ATTACH_QUEUE_LIMIT` check) or `undelivered_deep_links`. Those are drained only at the next attach.
- Failure scenario: a deep link that failed on a dying channel is not delivered to the live page. Instead it replays on the user's next reload, so a stale "open session X" fires minutes later.
- Fix: if a newer sink exists, retry on it. Otherwise queue with the same bound as the pre-attach path.

**M4. Every drop to an unknown window writes a synchronous runtime-log line while holding the bridge-wide lock [FROZEN: `bridge.rs`]**
- Evidence: `bridge.rs:589-599`. The `state` guard is alive while `runtime_log::note` runs `create_dir_all` + `metadata` + `open` + `write`, and nothing throttles it.
- Failure scenario: a sidecar keeps streaming `rpc:events` at 30 Hz for a window that just closed (the close and pool-release race Phase 4/5 will have). That is 30 file appends per second, each serializing every window's invoke, attach and emit behind disk I/O, and it floods the 4 MiB crash log that users attach to bug reports.
- Fix: count the drop under the lock, log after releasing it, and log once per `(win_id, channel)` (or rate-limit).

**M5. `cargo test` writes into the user's real shipping-app crash log [FROZEN: `runtime_log.rs`, `testing.rs`]**
- Evidence: `runtime_log::global()` (`runtime_log.rs:233-235`) lazily installs `paths::runtime_log_path()`, which is `~/.config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl`, the profile the shipping Electron app uses. `testing::fake_ctx` (`testing.rs:860`) gives the stores a temp dir but never installs a log. That file on this machine now holds 21 `"message":"boom"` records plus `bridge dropped sessions:changed for unknown window 9` and `bridge skipped 1 missing call(s)` lines with pid 1698025 at `2026-10-02T13:56:20Z`, which is my own `cargo test` run.
- Failure scenario: every wave executor's `check-module.sh` (gate 8 runs the tests twice) appends fake errors to the real crash log, so real triage data gets polluted. `bridge::tests::runtime_log_path_answers_through_the_dispatcher` also asserts against the real path.
- Fix: under `#[cfg(test)]`, make `global()` default to a per-process temp file, or have `fake_ctx*` call `runtime_log::install` with a tempdir path. Separately, remove the test lines from the user's log (I did not touch it).

**M6. A second SIGTERM/SIGINT is swallowed for the rest of the process's life [FROZEN: `lib.rs`]**
- Evidence: `lib.rs:311-335` handles exactly one signal, then the task ends. Registering a tokio signal listener replaces the default disposition permanently, so later SIGTERM/SIGINT do nothing.
- Failure scenario: shutdown hangs, for example inside `block_on(tabs.dispose_all())` (`lib.rs:297-304`) because a Phase 3 supervisor never exits. `kill <pid>` again, or a second Ctrl+C in dev, has no effect; only SIGKILL works, and that skips the supervisor control-channel path.
- Fix: loop. On the second signal, write a log line and call `std::process::exit(128 + signo)`.

**M7. The sandbox assertion fails open if `with_webview` errors [FROZEN: `webview.rs`]**
- Evidence: `webview.rs:438-440` only logs when `window.with_webview(...)` returns `Err`, so `is_sandbox_enabled()` is never checked and the window stays up.
- Failure scenario: a Tauri/wry upgrade or an early-close path makes `with_webview` fail, and an unsandboxed web process runs silently. The plan says this failure must be loud (Risk section).
- Fix: on `Err`, log and `std::process::exit(SANDBOX_MISSING_EXIT_CODE)` as well.

**M8. The navigation lock breaks blob downloads, and no contract exists to replace them [FROZEN: `webview.rs`; contract gap in `src/shared/ipc-types.ts`]**
- Evidence: `LogPanel.tsx:95-103` exports logs with `URL.createObjectURL` + `<a download>.click()`. In WebKitGTK that is a navigation to `blob:tauri://localhost/<uuid>`, which `navigation_allowed` denies because the path check fails (`webview.rs:175-193`). `build_window` registers no download handler. Electron's `will-navigate` never sees downloads; its default `will-download` shows a save dialog.
- Failure scenario: in Tauri, "Export logs" does nothing. Phase 9 cannot reroute it without a new channel (there is no file-write channel among the 94) or a `webview.rs` change, and both are frozen. Phase 9 does not mention it.
- Fix (decide now): either allow same-origin `blob:` download navigations and add `.on_download(...)` that routes through `Host::save_dialog`, or add a write-file channel to the frozen inventory before the wave.

### Low

**L1. `http(s)://tauri.localhost` counts as the app origin on every OS [FROZEN: `webview.rs`]**
- Evidence: `webview.rs:181-185`.
- Scenario: on Linux and macOS that origin is not the app. systemd-resolved maps `*.localhost` to 127.0.0.1, so a renderer-initiated navigation (after an XSS) to `http://tauri.localhost/index.html` would load whatever listens on local port 80. The init script runs there too and exposes `__OMP_BOOTSTRAP__` and the seeded storage. IPC stays blocked, because capabilities are local-only.
- Fix: accept that branch only under `cfg!(windows)`.

**L2. Throwaway-profile identity has gaps [FROZEN: `paths.rs`]**
- Evidence: `is_default_profile()` checks only whether the switch exists (`paths.rs:89-93`).
- Scenario: `--user-data-dir=` (empty) resolves to the default profile (`paths.rs:34-39`). `--user-data-dir=<the default path>` is the same profile. Both get a hashed single-instance id (`paths.rs:217-223`), so two instances can run on one profile and write `prefs.json` concurrently. Electron's in-profile lock prevented that.
- Fix: compute `is_default_profile` as `user_data_dir() == default_dir`, and hash the resolved path.

**L3. An unreadable store reads as empty and the next write overwrites it [FROZEN: `prefs.rs`]**
- Evidence: `prefs.rs:152`. Every read error except a parse failure is treated as empty.
- Scenario: EACCES or EIO on `prefs.json` at startup, then the first `set` replaces the user's settings with `{}`.
- Fix: treat only `NotFound` as empty. For any other error, move the file aside, or refuse to persist and log.

**L4. A missing config dir silently falls back to a relative profile [FROZEN: `paths.rs`]**
- Evidence: `dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))` at `paths.rs:84`.
- Scenario: the profile lands in whatever the cwd is (`/` from a file-manager launch). `PathsError::NoConfigDir` exists but is never used.
- Fix: return `NoConfigDir` and fail startup with `startup_failure`.

**L5. Phantom test [FROZEN: `paths.rs`]**
- Evidence: `derives_a_profile_specific_single_instance_id_shape` (`paths.rs:309-314`) recomputes the formula itself and never calls `single_instance_id()`, so it cannot catch a regression.
- Fix: factor out a pure `single_instance_id_for(path: Option<&Path>)` and test that.

**L6. Missing tests for the risky paths [FROZEN: test files under `src/shared/**`, `bridge.rs`]**
- Gaps: there is no `create-omp-api.test.ts` over a fake `IpcPort`, even though that file now backs both shells. It should cover the active-tab filter, `setActive` gating, the deep-link hold rule, and the `isolated` report. There are also no bridge tests for a handler panic (H1), reattach while draining (H2), or reload detach (M1).

**L7. Barrier-fault race in e2e hooks (`bridge.rs:566-575, 686-695`; `e2e-hooks` only)**
- Evidence: `notify_waiters()` wakes only futures already polled, and the barrier is removed from the map.
- Scenario: a `test:release` that runs before the `Later` task first polls `notified()` loses the wakeup, and the call hangs. This produces flaky e2e runs in Phase 10.
- Fix: use a `tokio::sync::watch`/`Semaphore`, or keep a released flag.

**L8. Root paths are joined by string concatenation [FROZEN: `vite.renderer.shared.ts`]**
- Evidence: `resolveFromRoot` (`vite.renderer.shared.ts:12`) joins with `/` onto a `fileURLToPath` result. On Windows that gives `C:\repo\/src/renderer`. The old config used `path.resolve(__dirname, …)`.
- Fix: use `path.resolve(ROOT, ...parts)`. This only matters if Electron is ever built on Windows.

**L9. Shutdown deadlock hazard should be stated in the frozen docs [FROZEN: `ports.rs` docs, `lib.rs`]**
- Evidence: `shutdown` runs `block_on` on the main thread (`lib.rs:297-304`).
- Scenario: a `dispose_all` or `desktop.shutdown` future that awaits a reply from a worker thread, where that worker is waiting on a main-thread getter (for example persisting window bounds via `outer_position()` from a spawned task), deadlocks quit.
- Fix: document on `TabsPort::dispose_all` and `DesktopPort::shutdown` that their futures must never await a main-thread round trip made from another thread.

**L10. Unbounded buffers for unknown generations [FROZEN: `bridge.rs`]**
- Evidence: `bridge.rs:433-445`. After 16 reloads, an older generation's late invoke is no longer recognized as superseded. It buffers forever until the next attach. An unattached generation's buffer has no size cap.
- Fix: reject any generation that is neither current nor pending-first-attach after the current one attached. Cap the pending entries.

**L11. Gate script soft spots (`scripts/check-module.sh`)**
- Gate 1 uses `git diff --name-only $BASE`, which skips untracked files (`check-module.sh:104`).
- Gate 3 builds `out/renderer-tauri` only when it is missing (`:134-137`), so it embeds a stale frontend.
- Gate 9's WARN pattern (`:201`) matches almost any cross-target failure on this host, so `cfg(windows|macos)` compile errors are never caught before Phase 12. Phase 12 should treat gate 9 as unverified.

**L12. Tauri dev runs with no CSP at all**
- Evidence: `transformIndexHtml` strips the meta CSP in dev too, and the `devUrl` page is not served through the Tauri protocol that adds the header.
- Consequence: CSP breakage only shows in release builds. Phase 10 smoke should cover CSP.

**L13. `TauriHost::clipboard_read_text` reads synchronously on the calling tokio worker (`lib.rs:201-204`)**
- Scenario: a slow X11/Wayland selection owner blocks a runtime thread.
- Fix: use `spawn_blocking`.

**L14. `Desktop::on_second_instance` is `todo!()` but reachable at runtime (`desktop/mod.rs:139-142`)**
- Scenario: the single-instance callback (`lib.rs:367-371`) calls it when a second instance launches, so starting a second wave dev build on the same profile panics inside a plugin callback.
- Fix: make it a no-op stub like `records`. This file is desktop-owned, so it is not frozen, but every wave worktree carries it.

## Checked and fine

- **Capabilities:** exactly the bridge commands, no `core:*` and no plugin permissions. Capabilities are local-only by default. `caller_for` re-checks the window kind (defense in depth).
- **Bootstrap script:** one `serde_json` value, with `\u2028`/`\u2029`/`<` escaped. Non-string storage values are dropped. Nothing is string-interpolated. The test parses the result back.
- **`e2e-hooks`:** the feature is off by default, absent from `build:tauri`, `tauri-dev.ts` and `tauri.conf.json`, and the registry is empty without it (tested).
- **Sandbox hook:** `Once`-guarded, installed before `tauri::Builder`. The success-path assertion is correct, because `with_webview` from setup runs inline on the main thread before the window maps. `Seccomp: 2` was evidenced in the executor report.
- **Navigation:** only the page's own URL, the dev origin only under `debug_assertions`, new windows open only for `http(s)` and are otherwise denied. `Host::open_url` re-checks the scheme.
- **Panics and blocking calls:** no `unwrap`/`expect` on runtime input paths in the foundation files (clippy gate). `omp_attach` is async, and `spawn_task` falls back to Tauri's runtime when called off-runtime. Apart from `TauriHost::clipboard_read_text` (L13), I found no other blocking call reachable from the main thread.
- **Shutdown order:** matches the frozen seven steps and runs once (`done` latch). `prevent_exit` returns before anything else runs.

## Must fix before Phases 3–9 branch

H1, H2, M1, M2, M3, M4, M5, M6, M7, and the M8 decision. L1–L6, L8–L10 are cheap and also live in frozen files, so fold them into the same fix commit. L7, L11, L13 and L14 can follow in their owning phases.

## Plan follow-ups (for the controller; no plan files edited)

- After the fix commit, re-run the Task 2.10 gate set and regenerate `contracts/*.api.txt` if `Bridge::detach` or any `pub` item changes.
- Add the M8 decision to `plan.md` → Decisions, and to Phase 9 if the route is renderer-side.
- The executor's open items N4/N7/N11/N12/N13 (wave phase wording) still need propagating, as their report says.

Status: DONE_WITH_CONCERNS
Summary: Electron behavior is unchanged and every gate is green. The frozen bridge has two dispatcher defects that can permanently hang a window (a handler panic, and a reattach while a handler runs), outbound messages are lost across reloads, and `cargo test` pollutes the user's real crash log. These and the other frozen-file items should be fixed on `tauri/foundation` before the wave branches.
Concerns/Blockers: M8 (blob download vs. navigation lock) needs a product/contract decision because both possible fixes touch frozen surfaces. I left the test entries in `~/.config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl` untouched.
