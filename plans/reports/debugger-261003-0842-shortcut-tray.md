# Debugger report: Wayland chord, tray New Session, deep link and SIGTERM on `tauri/integration`

**Date:** 2026-10-03 (KST) · **Worktree:** `/home/tung491/WORK/worktrees/tauri-integration` @ `589b9bf` · **Live run:** PID 2580749, profile `.../scratchpad/human-profile-1` · **Host:** GNOME Shell 50.1, mutter 50.1, xdg-desktop-portal 1.21.1, xdg-desktop-portal-gnome 50.0, ashpd 0.11.1, tauri-plugin-deep-link 2.6.1

This was a read-only investigation. No code was edited, no app process was started or stopped, and `~/.config/@oh-my-pi/omp-gui` was not read by me. The `kongming` advisor I consulted did read that profile's `logs/gui-runtime.jsonl` (read-only, no writes). None of its conclusions here depend on that read. The only commands run were `cargo test --lib desktop::shortcut` (28 passed), `cargo test --lib desktop::deep_link` (4 passed) and `cargo clippy --lib -- -W clippy::await_holding_lock` (clean).

## Outcome

| # | Symptom | Root cause | Owner | Electron affected |
|---|---|---|---|---|
| 1 | Ctrl+Shift+Space does nothing | GNOME already owns that chord: `org.gnome.desktop.wm.keybindings switch-input-source = ['<Shift><Control>space']`. Mutter refuses the grab and returns action 0. The GNOME portal backend still reports the shortcut as bound, so the app cannot tell. The two `shortcut-0` activations were the Ctrl+Shift+O window toggle, which logs nothing. | Environment, plus a detection gap in `desktop/shortcut.rs` (branch `tauri/desktop`) | Yes, same blind spot |
| 2 | Tray "Quick Start → New Session" shows nothing | No defect in the core → bridge → renderer chain. The renderer received `menu:action` and created a session (the file is timestamped 20 ms after the emit). An empty session was replaced by another empty one, which looks identical, and Wayland focus-stealing prevention blocked the raise. | `desktop/menu.rs` (UX only) | Yes, identical |
| A | Tray reached the sidecar | Confirmed. The renderer issued the session, not the core. | none | n/a |
| B | `omp://` opens the dev build on the real profile; link delivered twice | `register_all()` in debug builds on Linux writes a handler with no `--user-data-dir` and makes it the system default. Separately, every link is delivered twice: cold starts take it from argv and from `get_current()`, and warm second instances take it from the single-instance `deep-link` forward and from `on_second_instance`. | `desktop/mod.rs` (branch `tauri/desktop`) | Registration: no. Double delivery: no. |
| C | SIGTERM graceful exit overran 15 s | Not proven. The stall lies between `tabs.dispose_all` and the end of `tray.destroy`, with eight hypotheses eliminated. A stack dump on the merged build would settle it. | Undetermined | Unknown (Tauri-only code path) |

---

## Failure 1: Ctrl+Shift+Space does nothing

### Answers to the four questions

1. **Id mapping.** `install_shortcuts` registers the window toggle first (`desktop/mod.rs:268-274`, `native_accelerator("window.toggle")`, `CommandOrControl+Shift+O`, `shortcut_core.rs:199`). It registers quick entry second (`mod.rs:283-307` → `QuickEntryShortcut::register_at_startup`, `shortcut.rs:124-147`). `PortalShortcutRegistry::register` pushes onto a `Vec` in call order (`shortcut.rs:448-451`). `bind()` names each entry `shortcut-{index}` by `enumerate()` order (`shortcut.rs:412-419`), and dispatch parses the same index back out (`shortcut.rs:434-437`). So **`shortcut-0` is the window toggle and `shortcut-1` is the quick-entry summon chord.** GNOME confirms this in dconf: `/org/gnome/settings-daemon/global-shortcuts/vn.io.vif.saiatlas` holds `shortcut-0 → <Shift><Control>o` and `shortcut-1 → <Shift><Control>space`. The quick-entry handler does log: `on_activate` writes `quick entry shortcut activated` (`mod.rs:295-296`, from df27bf7), behind the `pref.enabled` gate (`shortcut.rs:117`).
2. **Ordering mismatch.** None within a run. The push order, the enumerate index and the dispatch index all come from the same `Vec`, which `start()` hands over whole (`shortcut.rs:460-470`). The ids are positional, though, and GNOME persists bindings by id. A future change to registration order, or a run with only one registration, would silently rebind a stored chord to a different action. See the Recommendations section.
3. **GNOME 50 reporting.** ashpd 0.11.1 decodes `Activated(o, s, t, a{sv})` and returns the app-supplied id as-is (`ashpd-0.11.1/src/desktop/global_shortcuts.rs:142-153`). The xdg-desktop-portal 1.21.1 frontend unicasts `Activated` to the session owner with the backend's `shortcut_id` (`src/global-shortcuts.c:713-736`). xdg-desktop-portal-gnome 50.0 maps a mutter action id back to the shortcut whose stored `accelerator_id` matches (`globalshortcuts.c:880-924`). The ids are not reported differently. **The bind response does not prove a grab**, however. See the root cause below.
4. **Why `shortcut-0` had no effect and no log.** Its callback is the window toggle (`mod.rs:259-266`), which never logs. `toggle_window_shortcut` (`mod.rs:232-247`) hides the focused window, or else calls `backend.focus()` → `show()` + `set_focus()` (`windows.rs:771-779`). On native Wayland, `set_focus` without an activation token only raises mutter's "is ready" notification; the module already notes this in `quick_entry.rs:243-245`. Two presses 2 s apart either hid the window and showed it again, or asked for focus twice and was refused. The portal's `activation_token` option, which xdg-desktop-portal-gnome forwards (`globalshortcuts.c:950-958`), is ignored at `shortcut.rs:431-438`. **Mutter only emits `shortcut-0`'s action for the `<Shift><Control>o` combo** (`mutter keybindings.c` resolves the binding by keycode and modifiers), so those two activations were Ctrl+Shift+O presses. Ask the user to confirm (see Unresolved questions).

### Root cause (proven)

| Step | Evidence |
|---|---|
| The chord is already a GNOME WM keybinding | `gsettings`: `org.gnome.desktop.wm.keybindings switch-input-source ['<Shift><Control>space']` and `switch-input-source-backward ['<Control>space']`. There are two input sources, `[('xkb','us'), ('ibus','Bamboo')]`, so the chord switches the input method. (The IBus hotkey is a separate setting, `<Super>space`, which is why the user's check looked clean.) |
| Mutter refuses a grab of an existing binding | `mutter 50.1 src/core/keybindings.c:1297-1301`: `if (get_keybinding (keys, &resolved_combo)) return META_KEYBINDING_ACTION_NONE;` |
| gnome-shell returns that 0 positionally | `gnome-shell 50.1 js/ui/shellDBus.js:218-234, 321-324` |
| The portal backend stores 0 and still reports success | `xdg-desktop-portal-gnome 50.0 src/globalshortcuts.c:516-523` assigns `accel->accelerator_id = accel_id` (0) with no check, then `shortcuts_to_response_variant` (`:323-370`) builds `"Press <Shift><Control>space"` from the settings strings and completes with `response = 0` |
| The app logs that response as "bound" | `shortcut.rs:420-428` → `portal bound shortcut-1 as 'Press <Shift><Control>space'` |
| Pressing the chord never reaches the portal | mutter dispatches the keypress to `switch-input-source`. No `portal activated shortcut-1` line was ever logged, and no `quick entry shortcut activated` line either. |

The 20-minute gap (23:21:38 → 23:41:02) is the GNOME approval dialog. It plays no part in the failure.

### Owner and branch
The trigger is environmental: this machine's (omakub-style) GNOME keymap. The defect is that the app has no way to see a refused grab, and it lives in `src-tauri/src/desktop/shortcut.rs` and `shortcut_core.rs` on **`tauri/desktop`**. The Electron core, `src/main/quick-entry-shortcut-core.ts`, has the same gap.

### Minimal fix
- **Immediate (user):** in GNOME Settings → Keyboard → Typing / Input sources, move `switch-input-source` off Ctrl+Shift+Space. Alternatively, in Settings → Apps → Sai ATLAS → Global shortcuts, rebind `shortcut-1`. Restart the app either way.
- **Code (desktop module, no frozen files):** see the Recommendations section. In short: before binding in portal mode on GNOME, read the GNOME keybinding schemas and treat a match as a conflict. Log it, and send it through the existing startup-notice path so the Keyboard Shortcuts dialog can warn the user.

### Regression test that would have caught it
A pure test in `shortcut_core.rs` covering a GNOME-keybinding conflict check (for example `gnome_conflict("<Shift><Control>space", &bindings)` → `Some("switch-input-source")`), fed with a keybinding table shaped like `gsettings list-recursively` output. Pair it with a `QuickEntryShortcut` test showing that a conflicting portal chord produces a startup notice instead of a silent "registered". Nothing could have caught this as a pure activation-mapping test: the mapping is correct.

### Does it affect Electron?
Yes. Electron 0.9.15 (electron 44.4.5) uses the same default chord `⇧⌃␣` (`src/shared/hotkeys.ts:50`), the same portal and the same core logic. Its portal status is likewise only "requested" (`src/main/quick-entry-shortcut-core.test.ts:173`), so it cannot see mutter's refusal either.

---

## Failure 2: tray "Quick Start → New Session" shows nothing visible

### Trace (each hop verified)

| Hop | Tauri | Electron reference |
|---|---|---|
| Tray item | `tray.rs:22` id `tray:new-session` → `tray.rs:212` `send_menu_action(ctx, "new-session", None, true)` | `src/main/tray.ts:108` `send(windowManager, "new-session")` |
| Target window and focus | `menu.rs:166-170` `windows.target_window()`, then `backend.focus(id)` because `focus = true` | `tray.ts:41-43` `win.show(); win.focus();` |
| Log and emit | `menu.rs:178-179` logs `menu action new-session → window 1`, then `ctx.bridge.emit_to_window(target, "menu:action", {"action":"new-session"})` | `tray.ts:43` `webContents.send("menu:action", { action })` |
| Bridge | `bridge.rs:718-759`: a registered window with an attached sink sends straight away; an unattached page is queued for replay; only an unknown window id is dropped (`bridge.rs:724-728`, logged at `:800` as `bridge dropped …`). No `bridge dropped` or `bridge channel send failed` line appears in the log. | n/a |
| Renderer subscription | `src/shared/bridge/create-omp-api.ts:211-214` `subscribe(IPC_EVENTS.MENU_ACTION = "menu:action")`, payload `{ action, ...extra }`, the same on both shells | same |
| Renderer action | `src/renderer/App.tsx:578-750` `onMenuAction` → `run("new-session")`, guarded by `acceptsActiveTabEvents()` (`:711`) and the streaming check (`:729-736`), then `newSessionNow()` (`:744-745`, `hooks/use-session-switch.ts:81-97`) | same |

`WindowId(1)` is the main window. The registry hands out ids from `next_id: 1` (`windows.rs:228`), and `WindowId(0)` is reserved for quick entry (`ports.rs:40`).

### Evidence that the renderer acted (item A)
- `~/.omp/agent/sessions/-.omp-work/2026-10-02T23-41-33-214Z_01a0fefe-….jsonl` (672 B, mtime 08:41:33.220 KST) was created 20 ms after the log line at 23:41:33.194Z.
- The core never creates sessions. `grep -rn "new_session\|newSession" src-tauri/src` finds only an i18n key and the deep-link payload. The only path to the sidecar's `newSession` RPC is the renderer's `newSessionNow()`. That path also proves the `acceptsActiveTabEvents()` and streaming guards passed.

### Root cause
There is no functional defect. Two things made a working action look like a no-op:
1. **Empty → empty.** The profile was 20 minutes old and the click came before any prompt was sent (the first prompt, "hi", was sent at 23:44:28 through quick entry, per `prefs.json` `inputHistory`). Both sessions were header-only (672 B, the same size as the other empty session from 23:45:12). `resetSessionSurface()` + `hydrateSession()` redraw the same empty composer.
2. **No raise on Wayland.** `backend.focus()` → `set_focus()` without an xdg-activation token, which mutter turns into an "is ready" notification (as `quick_entry.rs:243-245` notes). The tray menu, a StatusNotifierItem/dbusmenu, supplies no token.

### Owner, minimal fix, test
- Owner: `desktop/menu.rs` (`tauri/desktop`), for UX only. Optional: show a toast in the renderer for a menu-originated new session. That change belongs to the renderer and is outside this branch's scope. Delivering a real activation token is not possible from a tray click.
- Test: a desktop test (fake backend plus the `testing.rs` bridge fake) asserting that `on_menu_id("tray:new-session")` calls `focus(1)` and emits exactly one `menu:action {"action":"new-session"}` to window 1. That test pins the path that is proven to work. The current suite already covers `menu:action:open-settings` (`menu.rs:338`).
- Electron: identical behaviour on GNOME Wayland (`win.focus()` is also refused, and empty → empty also looks the same).

---

## B: Deep link reaches the real profile, and every cold-start link is delivered twice

### B1: Handler registration
- `desktop/mod.rs:337-341`: `if cfg!(debug_assertions) && platform == Linux { backend.register_deep_link_scheme() }` → `windows.rs:901-903` `deep_link().register_all()`. The spec asked for this (Task 5.7 step 1).
- `tauri-plugin-deep-link-2.6.1/src/lib.rs:293-370` writes `$XDG_DATA_HOME/applications/<exe>-handler.desktop` with `Exec="<current_exe>" %u` and runs `xdg-mime default`. Live state: `xdg-mime query default x-scheme-handler/omp` → `sai-atlas-handler.desktop`; `~/.config/mimeapps.list:43` `x-scheme-handler/omp=sai-atlas-handler.desktop`; `Exec="/home/tung491/WORK/worktrees/tauri-integration/src-tauri/target/debug/sai-atlas" %u`. **This is still in effect.** Every `omp://` link on this machine keeps opening the debug binary on the real profile until it is reverted.
- A throwaway profile gets its own single-instance id (`lib.rs:383-387`, `paths::is_default_profile()` at `paths.rs:126`). The handler's instance therefore never hands off to the running dev app, and starts a fresh instance on `~/.config/@oh-my-pi/omp-gui`.
- Electron reference: `src/main/deep-link.ts:42-47` `setAsDefaultProtocolClient`. On Linux, Electron registers through the app's own desktop entry, so a dev run never writes a debug-binary handler that leaves out the profile.

**Fix options (the recommended one is a spec deviation and needs a decision):**
- *Recommended:* drop `register_deep_link_scheme()` from debug builds entirely (`mod.rs:337-341`). Even a default-profile dev run would otherwise point every `omp://` link on the desktop at a debug binary that `cargo clean` deletes. Packaged builds need no registration: the installed `/usr/share/applications/vn.io.vif.saiatlas.desktop` already declares `MimeType=x-scheme-handler/omp;`, and `mimeinfo.cache:577` maps the scheme to it. Dev testing can pass the URL in argv instead (`target/debug/sai-atlas --user-data-dir=X omp://new`, and again while it runs for the warm path). Spec Task 5.7 step 1 asked for the registration, so record the deviation and the new evidence for the user.
- *Minimum:* register only when `paths::is_default_profile()` (`paths.rs:126`) is true. That would have prevented this incident, but it still hijacks the default on default-profile dev runs.
- Rejected: an `Exec` line with `--user-data-dir`. The plugin's `register()` takes no arguments, so it would need a hand-written desktop file, and it would still hijack the default for a temp directory that disappears.

**Test:** a `Desktop::start` test on the fake backend (debug build, Linux) asserting `register_deep_link_scheme` is never called.

**Cleanup for the user (manual, not app code):** `rm ~/.local/share/applications/sai-atlas-handler.desktop`, delete line 43 of `~/.config/mimeapps.list`, then run `update-desktop-database ~/.local/share/applications`. Verify that `xdg-mime query default x-scheme-handler/omp` falls back to `vn.io.vif.saiatlas.desktop`, which comes from the system cache and is the pre-incident state.

### B2: Double delivery (`deep link omp://new delivered to window 1` ×2 in the same millisecond)
- `desktop/mod.rs:352-363`: `start()` offers the argv URL from `parse_launch_argv` (`:359-360`), then offers every URL from `backend.startup_urls()` (`:362-363`).
- On Linux and Windows, `startup_urls()` is `deep_link().get_current()` (`windows.rs:905-907`). The plugin fills that from the **same argv** at init (`tauri-plugin-deep-link-2.6.1/src/lib.rs:81-90, 204-230`) whenever argv is exactly one URL, which is the case for `xdg-open`.
- **Warm links are doubled too.** `src-tauri/Cargo.toml:21` enables `tauri-plugin-single-instance`'s `deep-link` feature. Its callback wrapper first calls `deep_link.handle_cli_arguments(args)` (`tauri-plugin-single-instance-2.5.2/src/lib.rs:103-109`), which emits `deep-link://new-url` → the module's `on_open_url` handler (`desktop/mod.rs:518-535`) → `open_url`. Only then does it run the app callback → `on_second_instance_in` → `handle_deep_link` (`deep_link.rs:129-130`). The cold path loses the plugin's init-time emit because `on_open_url` is registered later, so the duplicate there comes from `get_current()` instead.
- Effect: two `new-session` actions per link, cold or warm. One extra session file is expected, and the second `newSession` may race the first.

**Minimal fix:** gate the deep-link plugin's two inputs to macOS, where they are the OS handoff (`Opened`): make the `on_open_url` closure a no-op elsewhere, and read `startup_urls()` only on macOS. A dedupe set is the wrong tool, because it would also swallow a legitimate repeated `omp://session/<id>`. Once gated, the `deep-link` feature on single-instance is dead weight; removing it from `Cargo.toml` is a follow-up because `Cargo.toml` is shared config. **Tests:** Linux fake backend with `argv = ["bin","omp://new"]` and `startup_urls = ["omp://new"]` → exactly one `deep-link` emit after `start()`; macOS with `startup_urls = ["omp://new"]` and no argv URL → one emit; a packaged e2e where `xdg-open omp://new` twice logs exactly two `deep link … delivered` lines. Electron is not affected (`deep-link.ts:51-53` reads argv once).

Side observation: `paths::user_data_dir_switch` accepts `--user-data-dir <path>` as two arguments (`paths.rs:68-80`), but `parse_launch_argv` (`launch_argv.rs:32-38`) would read that `<path>` as a workspace directory. The `=` form used in the runs is fine.

---

## C: SIGTERM graceful exit overran its 15 s deadline

**Status: root cause not yet proven.** The stall has been narrowed down and the remaining candidates are listed below.

### Timeline (stray instance, controller's backup of its runtime log)
| UTC | Event |
|---|---|
| 23:45:11.501 | Startup. Portal mode, quick entry "registered" (requested) |
| 23:45:11.707 | `deep link omp://new delivered to window 1` **×2** (B2) |
| 23:45:11.725 | Portal bound `shortcut-0`/`shortcut-1`. No dialog: GNOME already stores this app id's bindings, and this second session's grabs fail because the live dev instance holds `<Shift><Control>o` and mutter holds `<Shift><Control>space`. |
| 23:45:12.535 | Sidecar created the session file `2026-10-02T23-45-12-535Z_…jsonl` |
| 23:45:23.635 | `SIGTERM received; exiting through Tauri` → `shutdown started (exit requested, code Some(0))` |
| 23:45:38.636 | `graceful exit overran its deadline; exiting hard with code 143` (15.001 s later) |

No `desktop surfaces destroyed` (`desktop/lifecycle.rs:92`), no `shutdown finished` (`lib.rs:307`) and no `sidecar supervisor ignored SIGTERM` (`omp/manager.rs:893-897`) line was written.

### Where it stalled
`shutdown()` (`lib.rs:288-308`) runs on the main thread inside the `ExitRequested` callback and calls `block_on(tabs.dispose_all → omp.shutdown → services.shutdown → ollama.shutdown → updater.shutdown → desktop.shutdown)`. `desktop.shutdown` → `shutdown_in` writes `desktop surfaces destroyed` only **after** `quick_entry.destroy_window` and `tray.destroy` (`lifecycle.rs:89-92`). **The stall is therefore somewhere between the start of `tabs.dispose_all` and the end of `tray.destroy`.**

### Eliminated (with evidence)
| Hypothesis | Why it is ruled out |
|---|---|
| Tokio timers not driven while the main thread is parked in `block_on` | The 15 s `tokio::time::sleep` in `listen_for_signals` (`lib.rs:346`) runs on the same Tauri global runtime and fired on time. `tauri-2.12.1/src/async_runtime.rs:131-134` is a plain `tokio::Runtime::block_on`. |
| Sidecar dispose waiting out its grace period | `kill()` wraps the wait in `timeout(SUPERVISOR_EXIT_GRACE = 8 s)` and logs on expiry (`manager.rs:38, 890-902`). Timers work, so a wait longer than 8 s would have logged. The supervisor's own worst case is TERM_GRACE 5 s plus SWEEP_BUDGET 2 s (`supervisor.rs:77-79`), which is under 8 s. Note that "no orphan remained" does **not** prove dispose finished: the supervisor sets `PR_SET_PDEATHSIG(SIGTERM)` (`supervisor.rs:97-99`), so the hard exit alone would have stopped it. |
| `notify` watcher drop joining a thread | `notify-8.2.0/src/inotify.rs:606-611`: `Drop` only sends `Shutdown` and wakes the loop. It does not join. |
| Session-index cache lock held by a long scan | `~/.omp/agent/sessions` holds 4 `.jsonl` files (36 KB). Cache locks are taken per file (`session_index.rs:248-288`). |
| A std `Mutex` held across `.await` | `cargo clippy --lib -- -W clippy::await_holding_lock` reports nothing. |
| A blocking event send in cleanup | Sidecar events are a `tokio::sync::mpsc::UnboundedSender` (`manager.rs:415`, `ports.rs:441`), and the batcher flush does not block (`event_batcher.rs:40-82`). |
| `omp`/`ollama` shutdown bodies | All synchronous and short: stats `kill()` (`omp/stats.rs:170-181`), bench `abort()` (`omp/bench.rs:206-214`), `puller.cancel()` (`ollama/pull.rs:255-260`). |
| The portal session task | Nothing in the shutdown chain awaits, joins or locks it. It owns only its moved `Vec` of callbacks (`shortcut.rs:460-470`). |

### Remaining candidates (ranked)
1. **A synchronous lock wait on the main thread at the start of `tabs.dispose_all`, the manager's `dispose`, or `updater.shutdown`.** The holder would be a thread that is itself waiting on the parked main thread: a Tauri getter such as `is_visible`, `outer_position`, `cursor_position` or monitors (`desktop/windows.rs:647-838`), called from a worker while that lock is held. `ports.rs:579-582` and `:638-640` already name this deadlock class. One worker path that does call blocking getters is the portal activation callback, which runs on a tokio worker (`shortcut.rs:436`, spawned at `:465`) even though the spec says shortcut callbacks run on the main thread. It did not fire in the stray instance, however.
2. **A main-thread stall in the first poll of the chain, before any await.** For example `ctx.tabs.dispose_all()` taking the pool lock (`tabs/pool.rs:990`) while a pool mutation on a worker holds it across `bridge.emit_to_window` (`pool.rs:536-541`). The manager does something similar: `kill()`/`cleanup_locked` hold the manager lock across `batcher.flush_now()` and `rpc.reject_all()` (`omp/manager.rs:846-858, 878-886`). Static reading shows those sends do not block, so this needs a stack dump to confirm or rule out.
3. **A stall inside `desktop.shutdown_in`, before its log line.** Either `quick_entry.destroy_window` → `window.destroy()` or `tray.destroy` → `backend.destroy_tray()` (`lifecycle.rs:90-91`, `tray.rs:187-191`). This would require steps 1-5 to have finished promptly, which fits a sidecar that exited quickly. It is weakened by Phase 5's passing run, which also had a tray.
4. **Something only the merged build adds.** Phase 5's passing run logged a 5-step order without `ollama`/`updater` (`fullstack-developer-261002-2333-phase-05-desktop.md:29`). It ran on stub ports, so the merged build has **never** passed the SIGTERM check, with or without a throwaway profile.

### Cheapest discriminating step
- Repeat Task 5.8 on the **merged** build with a throwaway profile and one sidecar. When `shutdown started` appears, run `sudo gdb -p <pid> -batch -ex 'thread apply all bt'` (`ptrace_scope` is 1, so sudo is needed) or `sudo eu-stack -p <pid>`. The main thread's frame names the step and the lock in one shot, with no code change.
- How to read the dump: a main thread in `futex`/`Mutex::lock` under `dispose_all`, `kill` or `with_state` points to candidate 1 or 2, and the frame names the lock. A worker in `recv` under `send_user_message` or a window getter confirms a main-loop round trip and names its caller. A main thread inside `destroy_tray` or `destroy` points to candidate 3.
- If an in-code trace is preferred without touching the frozen `lib.rs`: log entry and exit at the top of each module's own `dispose_all`/`shutdown` (`tabs/pool.rs:988`, `omp/mod.rs:250`, `services/mod.rs:172`, `ollama/mod.rs:200`, `updater/mod.rs:655`), plus one line at the top of `shutdown_in`.

### Owner
Unassigned until the stack is known. The fix will belong to whichever module's step blocks. `lib.rs` is frozen, and the order itself is not suspected.

---

## Recommendations

### Chord reported bound but not grabbed by mutter (the controller's question)
The portal cannot report this. xdg-desktop-portal-gnome 50.0 replies with success whatever `GrabAccelerators` returned, and there is no later signal. Only an up-front check can catch it. In priority order:

1. **P1, desktop module only: detect GNOME keybinding conflicts before binding, and route them through the existing "refused" path.** In portal mode with `XDG_CURRENT_DESKTOP` containing `GNOME`, read the schemas mutter and gnome-shell index: `org.gnome.desktop.wm.keybindings`, `org.gnome.mutter.keybindings`, `org.gnome.mutter.wayland.keybindings`, `org.gnome.shell.keybindings`, and `org.gnome.settings-daemon.plugins.media-keys` including the relocatable `custom-keybinding:<path>` entries (this machine has `custom3 = <Super><Shift><Control>space`). Read them with `gsettings` at init, or with GIO after a `SettingsSchemaSource::lookup` (`gio::Settings::new` aborts on a missing schema).
   - Compare normalised accelerators: a modifier set plus a lowercase keysym, with `<Primary>` = `<Control>` = `CTRL`, `<Super>` = `LOGO` and `<Alt>` = `ALT`.
   - Build the conflict set next to `desktop_entry_missing` (`mod.rs:287-290`) and pass it to `PortalShortcutRegistry::new`. `register()` then returns `Ok(false)` for a conflicting accelerator and still queues the others.
   - `register_at_startup` already turns `Ok(false)` into `registered = Some(false)` plus a startup notice (`shortcut.rs:134-146`). `shortcut_state` maps that to `Refused`, and the renderer already shows "The system refused {chord}. Another app may be using it." No `src/shared` change is needed (`ipc-types.ts:413` is frozen).
   - Log the GNOME owner (for example `switch-input-source`) in the runtime log. A dedicated `conflict` field for the UI would be a frozen-type change, so record it as a user design decision.
   - The parser and matcher are pure. Put them in a new `desktop/gnome_keybindings.rs` or in `shortcut_core.rs`, with tests.
2. **P1: stable portal ids.** Replace `shortcut-{index}` (`shortcut.rs:417, 434`) with semantic ids (`window-toggle`, `quick-entry`), passed through `ShortcutRegistry::register`. GNOME stores bindings by id, so positional ids rebind silently whenever the set or order changes. Migration cost: one fresh GNOME approval dialog per user. The old `shortcut-0`/`shortcut-1` entries stay inert in dconf. The Tauri build has not shipped yet, so this is the cheapest time to make the change.
3. **P2: correct the window toggle's trigger.** `accelerator_to_portal_trigger` passes `CommandOrControl` through unchanged (`shortcut.rs:352-385`; the test at `:662` asserts the wrong output). Map it to `CTRL` off macOS. GNOME happened to show `<Shift><Control>o` anyway, but the preferred trigger string is invalid per the portal spec.
4. **P2: log window-toggle activations** in the `mod.rs:259` closure, as df27bf7 does for quick entry, so the next on-screen test is unambiguous.
5. **P2: use the portal's `activation_token`.** xdg-desktop-portal-gnome forwards it (`globalshortcuts.c:950-958`), but `shortcut.rs:431-438` drops it. Passing it to the window before `present` (GTK startup id / xdg-activation) would let the toggle and the bar actually raise on Wayland, instead of producing an "is ready" notification. This change needs a small backend hook in `windows.rs`.
6. **Default chord: keep it (recommended), but present the choice to the user.** GNOME's stock `switch-input-source` is `<Super>space`; `<Shift><Control>space` on this machine is a user configuration, though it is common among IBus users, which includes the Vietnamese audience. Changing the default would affect every platform and Electron (`src/shared/hotkeys.ts:50`, frozen), so conflict detection (item 1) is the better lever. Evidence that many GNOME users bind this chord would change the recommendation. Do not build on "no activation ever arrived": that cannot be told apart from "not pressed yet".

Electron 0.9.15 has the same blind spot (same chord, same core, portal status "requested"). Item 1 could be ported to `src/main/quick-entry-shortcut-core.ts` if Electron stays supported on Linux.

### Deep link
- P1: stop registering the scheme in debug builds; this needs a decision because it deviates from spec Task 5.7 step 1. The minimum alternative is to guard with `paths::is_default_profile()` (`desktop/mod.rs:337`).
- P1: gate `on_open_url` (`mod.rs:518-535`) and `startup_urls()` (`mod.rs:362-363`) to macOS. That removes both the cold-start and the warm duplicate.
- User cleanup: see B1.

### Shutdown
- P1: run the merged-build SIGTERM check with a stack dump (section C) before any fix. Make Task 5.8 part of the integration gate, not only the module branch's gate.

### Monitoring gaps found
- Window-toggle activations are not logged (item 4).
- The portal "bound" log line is not proof of a grab. Rename it to `portal accepted …` so nobody reads it as proof.
- Shutdown has no per-step log, so a stall cannot be placed without a debugger (section C).

## Unresolved questions

1. Did the user press Ctrl+Shift+O at about 23:41:05 and 23:41:07? Mutter emits `shortcut-0`'s action only for `<Shift><Control>o`. If the user is certain they pressed only Ctrl+Shift+Space, the next run should log the toggle (Recommendation 4) and dump `dconf` before testing.
2. Section C: which step blocks? This needs the stack dump or per-module logs from a merged-build SIGTERM run.
3. Should a conflict get its own field in `QuickEntryShortcutState` (a `src/shared` change, frozen), or is `status: "refused"` plus a log enough? This is a user/design decision.
4. Should the default chord move off Ctrl+Shift+Space on Linux? This is a user decision, and it affects Electron and all platforms.
5. Does GNOME Settings honour a changed `preferred_trigger` for an id it has already stored, or does the stored dconf binding win? This decides whether changing the chord in the app ever takes effect on GNOME without the user rebinding in Settings. It is not verified.

Status: DONE_WITH_CONCERNS
Summary: Failure 1 is a GNOME keybinding conflict (`switch-input-source = <Shift><Control>space`) that the GNOME portal reports as a successful bind. The id mapping is correct, and the two activations were the unlogged Ctrl+Shift+O toggle. Failure 2 is not a code defect: the renderer received the action and created a session, but empty → empty looks unchanged and Wayland blocked the raise. Deep-link registration points `omp://` at the dev binary on the real profile, and every link (cold or warm) is delivered twice; both are in `desktop/mod.rs`.
Concerns/Blockers: The SIGTERM overrun (C) is narrowed to the span from `tabs.dispose_all` to the end of `tray.destroy`, with eight hypotheses eliminated, but it is not proven. It needs a merged-build SIGTERM run with a stack dump. The `omp://` handler still points at `target/debug/sai-atlas` on this machine.
