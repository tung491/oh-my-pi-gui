# Quit guard skipped with a running `!` shell command (Phase 5, Task 5.8)

Worktree `/home/tung491/WORK/worktrees/tauri-integration` @ a92e7f6 (tauri/integration). Read-only diagnosis; no code edited, app not started.

## Outcome

Two independent defects. Either one alone is enough to make the reported quits exit without a dialog.

1. **The last-window close on Linux never consults the guard** (desktop module, `tauri/desktop`). This is what the logged second attempt hit. The guard is only wired to `ExitRequested(None)`. By the time Tauri emits that event, the window is already destroyed, its tabs have been released, and `on_window_destroyed` has *pre-approved* the quit.
2. **A `!` composer shell command is never counted as working** (tabs module, `tauri/tabs`). The working-tab inventory only tracks `agent_start` to `agent_end` and auto-compaction. User bash (and `$` python eval) runs through the `bash`/`eval` RPC, which never emits `agent_start`. As a result, even the correctly guarded tray Quit sees `working_tabs = 0` and quits. The Electron guard has the same gap, so this one is a parity gap rather than a migration regression.

There is no stale-state or integration gap (question 4 is eliminated; see below).

## Evidence chain

### Q1: the quit paths

| Path | Code | Guard consulted? |
|---|---|---|
| Tray Quit | `desktop/tray.rs:218` `ID_QUIT => start_guarded_quit_from` then `desktop/mod.rs:233-238` then `app_quit.rs:109` `start_guarded_quit` | Yes |
| Renderer `app:quit` | `desktop/ipc.rs:42-46` then `start_guarded_quit` | Yes |
| OS / last-window `ExitRequested{code:None}` | `lib.rs:447-453` then `desktop/mod.rs:488-500` `on_exit_requested` then `exit_decision` (`app_quit.rs:66-74`) | Only when the quit is **not already approved** |
| App's own exits `Some(code)` | same; `exit_decision` returns `Allow` | No, by design |
| Window close (`CloseRequested`) | `desktop/windows.rs:637-652` then `desktop/lifecycle.rs:24-34` | **No.** Prevented only for the macOS last window (`keep_last_window_on_close`, `lifecycle.rs:45-47`) |
| Window destroyed | `lifecycle.rs:35`, then `on_window_destroyed` `lifecycle.rs:55-79` | **No.** It calls `request_quit_in(ctx)` (`lifecycle.rs:75`), which sets `approved` and `quitting` and calls `host.exit(0)` (`app_quit.rs:134-138`) |

The working-tabs decision is `Desktop::quit_risk_in` (`app_quit.rs:77-80`) then `ctx.tabs.tab_inventory()` (the `TabsPort`, `ports.rs:575`) then `tabs/pool.rs:919-927`, which maps each entry to `in_flight: entry.in_flight()`, then `assess_quit_risk`/`quit_needs_confirmation` (`quit_guard.rs:9-25`). The omp port is not involved.

### Q3: the window-close ordering (proves root cause 1 and matches the log)

`tauri-runtime-wry-2.12.1/src/lib.rs:4211-4268`, on `TaoWindowEvent::Destroyed`:
1. It dispatches the event to the window's listeners first (`handler(&event)`, lines 4227-4231). That runs `on_window_destroyed`:
   - The closed listeners run. `tabs/mod.rs:248-250` calls `ctx.tabs.release_window(id)`, which kills that window's sidecars, including the one running `sleep 600`.
   - With `windows.count() == 0` on Linux, it calls `request_quit_in`, which sets **approved = true** and queues `Message::RequestExit(0)`.
2. Only after that, with the window store empty, it emits `RunEvent::ExitRequested { code: None }` (lines 4258-4262).
3. `on_exit_requested(None)` computes `approved = true`. `exit_decision` returns `Allow`, and `shutdown("exit requested, code None")` runs.

The log matches this exactly: `shutdown started (exit requested, code None)`, no `quit confirmation answered` line, and `desktop surfaces destroyed {"windows": 0}`. A tray Quit would have logged `code Some(0)`, so the logged attempt was the window close (or GNOME's app-menu Quit, which also closes the windows).

Of the three hypotheses in the brief:
- "Window destroyed before ExitRequested": **confirmed**.
- "`prevent_close` not called": **confirmed** for Linux. It is only returned for macOS.
- "`on_exit_requested(Some(_))` false but dialog never shown": **eliminated**. The exit arrived as `None`, already approved. `Some(_)` → `Allow` is correct per the plan.

There is also a plan defect. Task 5.8 step 2 assigns "the last window closing" to the `ExitRequested(None)` branch. On Linux that branch is never reached unapproved, and if it were, the inventory would already be empty because the tabs are released in `Destroyed`. Electron behaves the same way: `index.ts:533-537` `window-all-closed` → `requestQuit()` (approved), so Electron never asked on a window close either. The guard therefore has to run at `CloseRequested`, while the window and its tabs still exist.

The existing test `lifecycle.rs:146-156` `closing_the_last_window_quits_on_linux` encodes the unguarded behavior. It never seeds a working tab.

### Q2: what "working" means, in both shells

- Tauri: `tabs/pool.rs:114-116` `in_flight = running || compacting == Some(true)`. `running` is set only by the `agent_start` and `agent_end` events (`pool.rs:405-418`).
- Electron: `sidecar-pool.ts:297-300` and `:658` `inFlight: entry.running || entry.compacting === true`. Same semantics.
- Sidecar: the composer `!cmd` calls `rpc.bash` (`use-composer-submit.ts:127-142`, `shared/rpc-client.ts:158`). Its route is `rpc:command` → `tabs/ipc.rs:164-169` → `dispatch_rpc_command` (`tabs/ipc.rs:80-131`) → stdin. In the monorepo, `coding-agent/src/modes/rpc/rpc-mode.ts:2563-2568` `case "bash"` → `session.executeBash` → `session/bash-runner.ts:70-132`. That path emits no session event. `agent_start` is only pushed by `agent/src/agent-loop.ts:628,691` (prompt runs). The sidecar does track it (`BashRunner.isRunning`), but the pool never sees it.

So `!/usr/bin/sleep 600` gives `in_flight = false`, `working_tabs = 0`, and `quit_needs_confirmation = false`, which leads to `request_quit_in` with no dialog. This happens on the tray path as well. The `kill -9` observation is consistent with this: the command is a live omp child, but it is not an agent *turn*.

### Q4: stale state or integration gap (eliminated)

`tab_inventory` reads the pool state synchronously at quit time (`pool.rs:919`). Desktop caches nothing. `build_ctx` (`lib.rs:286-298`) wires the real `tabs::Tabs` into `ctx.tabs`. `lifecycle.rs`, `app_quit.rs`, `mod.rs`, `pool.rs` and `ipc.rs` are byte-identical between `tauri/integration` and their owning branches (`git diff --stat tauri/desktop HEAD` and `tauri/tabs HEAD` are empty), so the merge introduced no drift. Agent turns *would* be guarded correctly on the tray path.

### Environment

- `cargo test desktop::app_quit` passes 6 tests. Those tests only exercise `on_exit_requested` directly, which is why the close path was never covered.
- Tauri 2.12.1 / tauri-runtime-wry 2.12.1 (`Cargo.lock:4286,4605`).

## Minimal fixes (no frozen file touched)

### Fix 1: guard the last-window close (`tauri/desktop`, `src-tauri/src/desktop/lifecycle.rs`)

In `on_window_event`, `WinEvent::CloseRequested`, put the check after the geometry and state persistence but **before** `shortcut_release_window(win_id)` (`lifecycle.rs:28`). Otherwise a "Keep working" answer leaves the surviving window without its quick-entry shortcut.

```rust
if self.guard_last_window_close(ctx, win_id) {
    return true; // prevent_close: the window and its tabs stay until "Quit anyway"
}
```

```rust
/// Linux/Windows: closing the last chat window quits, and its tabs die with it
/// in `Destroyed`, so the working-sessions guard must run here, while they exist.
fn guard_last_window_close(&self, ctx: &Arc<AppCtx>, win_id: WindowId) -> bool {
    if self.backend.platform() == Platform::Darwin || self.is_quitting_latched() || self.quit.approved() {
        return false;
    }
    if self.windows.ids() != vec![win_id] {
        return false;
    }
    if !self.quit.asking() && !quit_needs_confirmation(&self.quit_risk_in(ctx)) {
        return false; // nothing works: close, then Destroyed quits as today
    }
    self.start_guarded_quit(ctx); // no-op while a dialog is already open
    true
}
```

`QuitState::asking` must become `pub(crate)`, or the check can be folded into a helper in `app_quit.rs`. "Quit anyway" ends in `request_quit_in`, then `ExitRequested(Some(0))`, then the frozen shutdown order. "Keep working" or a dismissal leaves the window open. This does not change `lib.rs` or `exit_decision`.

### Fix 2: count user shell/eval runs as working (`tauri/tabs`, `src-tauri/src/tabs/pool.rs` + `tabs/ipc.rs`)

- In `pool.rs`, add `user_execs: usize` to `Entry`, and add a `TabPool::begin_user_exec(tab_id) -> Option<UserExecGuard>`. The guard holds the entry `key`, and its `Drop` decrements under the pool lock. Then `tab_inventory` (`pool.rs:924`) reports `in_flight: entry.in_flight() || entry.user_execs > 0`. Leave `Entry::in_flight` unchanged so tab-status pushes and `command_for_idle_session` keep their current behavior.
- In `ipc.rs` `dispatch_rpc_command`: when `str_field(command, "type")` is `"bash"` or `"eval"` and `issuer_tab_id` is `Some`, take the guard before `sidecar.request` (line 120) and move it into the `Reply::Later` future. It then drops on the response, on a delivery error, or on cancellation.
- `WindowTabFact`/`ports.rs` are unchanged.
- The guard's `Drop` must tolerate the entry having been released already (tab closed mid-command). Two known early decrements are acceptable and should be documented in a comment: a renderer `timeoutMs` expiry, and an `abort_bash` reply arriving before the `bash` reply. Only `bash` and `eval` qualify, because the sidecar's handlers (`rpc-mode.ts:2563`, `:2579`) `await` the whole run, so response completion means the command has ended.
- Rejected alternatives: polling `get_state` at quit time is async per tab, while `quit_risk_in` is synchronous. Widening `Entry::in_flight` would flip `tab:status` to Running and change idle-session routing.

This goes beyond Electron parity (`sidecar-pool.ts:658` has the same gap; a backport is optional). It is not gated on a separate decision, because the user's own repro is the bash case.

## Regression tests

1. `desktop/lifecycle.rs`, using the desktop fake backend:

```rust
#[tokio::test]
async fn closing_the_last_window_with_a_working_tab_asks_first_on_linux() {
    let Harness { ctx, desktop, fakes, backend } = harness(Platform::Linux);
    let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
    *fakes.tabs.inventory.lock().unwrap() = vec![WindowTabFact { window_id: id, tab_id: "t0".into(), in_flight: true }];

    // Keep working (also the dismissal answer): the window survives, nothing exits.
    fakes.host.message_dialog_answers.lock().unwrap().push(1);
    assert!(desktop.on_window_event(&ctx, id, WinEvent::CloseRequested), "the close is prevented while the guard asks");
    tokio::task::yield_now().await;
    assert!(fakes.host.log.calls().iter().any(|call| call == "message_dialog(Sessions are still running)"));
    assert!(backend.exists(id));
    assert!(fakes.host.exit_codes.lock().unwrap().is_empty());
    assert!(!desktop.is_quitting());

    // Quit anyway: the app exits through request_quit, so the shutdown order runs.
    fakes.host.message_dialog_answers.lock().unwrap().push(0);
    assert!(desktop.on_window_event(&ctx, id, WinEvent::CloseRequested));
    tokio::task::yield_now().await;
    assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
}
```

   Also keep `closing_the_last_window_quits_on_linux` (nothing working, no dialog), and add the assertion that a non-last window's `CloseRequested` returns `false`.

2. `tabs/ipc.rs`: a running user bash is in the quit inventory. Call `ipc::rpc_command(&h.ctx, caller, vec![json!({ "command": { "id": "b", "type": "bash", "command": "sleep 600" } })])` on a Ready tab and hold the returned `Reply::Later` future without polling it. Assert `h.ctx.tabs.tab_inventory()` has `in_flight: true` for that tab. Then await the future and assert it is `false`. Do the same for `eval`, and check that a `get_state` command never counts. The `FakeSidecar` resolves immediately, so the guard must be taken synchronously at dispatch. That is also what makes the test meaningful.

Verify with `cargo test --manifest-path src-tauri/Cargo.toml desktop::lifecycle desktop::app_quit tabs::ipc`. Then repeat the manual check on GNOME: `!/usr/bin/sleep 600`, then close the window, and separately use tray Quit. Both should show the dialog, and the runtime log should show `quit confirmation answered`.

## Advisory review

`kongming` reviewed both fixes. It confirmed the CloseRequested placement, said GTK/Wayland `prevent_close` (tao `delete-event`) is reliable, said the shutdown path cannot re-enter (the `is_quitting_latched` check), confirmed that the RAII counter at dispatch is the right layer, and said Fix 2 should not be gated. It contributed the shortcut-release ordering and the drop-tolerance notes above.

## Recurrence prevention

- The Task 5.8 test list only drove `on_exit_requested`. It never drove a real close path end to end. Add the close-path test above to the module gate. Also correct the plan text: the Linux last-window close must be guarded at `CloseRequested`, not at `ExitRequested(None)`.
- Fake fidelity: the desktop harness lets `Destroyed` be delivered without the preceding `CloseRequested`. Tests should drive `CloseRequested` then `Destroyed`, the order the runtime uses.

## Unresolved questions

1. Closing a **non-last** window that has working tabs still releases and kills them without asking, both here and in Electron. Should that window close be guarded too? It is out of scope for Task 5.8.
2. Which button Enter activates on the GNOME dialog is still unobserved (Task 5.8 step 1 observation).
3. The first failed attempt has no log excerpt. Its path (tray or close) is inferred. Root cause 2 alone explains a tray-Quit failure.
