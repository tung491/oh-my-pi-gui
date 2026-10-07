# Kongming advice: seeded-window regression after the catch-up check (e2caf7e / 5c1c4ec)

Failure Protocol checkpoint for the Linux window-size fix. Worktree `/home/tung491/WORK/worktrees/tauri-integration` at `2c0d840`; harness `/home/tung491/WORK/worktrees/stage-c/wm-check/` (`out-c623b75`, `out-e824b79`, `out-2c0d840`). Advisory only; no project files were edited. Sources read: tao 0.37.1, tauri-runtime-wry 2.12.1, tauri 2.12.1 (the `Cargo.lock` versions), GTK 3.24 `gtkwindow.c` / `gdkwindow-x11.c` / `gdkdisplay-x11.c`, openbox `client.c` / `frame.c`.

## TL;DR

Your hypothesis is right about the effect and wrong about the mechanism. tao seeds **both** outer caches from the same call, `root_origin()`, but that call is a live X query (`_NET_FRAME_EXTENTS`, else a `XQueryTree` walk plus `XGetGeometry`), made twice, while openbox is concurrently reparenting the window. For a window with an explicit position the answer passes through a transient `(0,0)` (the client sits in a frame openbox created at `0,0 1x1` and has not yet moved), so the two seeds can differ (`outer_position = (0,0)`, `outer_size = (40,30)`), `origin_seeded` says "configured", the catch-up runs synchronously on the main thread, measures a negative decoration, and disarms without correcting. An unpositioned window never shows the asymmetry because every intermediate answer is `(0,0)` until openbox's placement, which is its last step. Fix: (1) the catch-up never disarms on an implausible measurement, and (2) it is skipped when the build ran on the main thread, where `run_on_main_thread` executes inline before the listener exists and could only ever read seeds. Keep M1 fixed through the off-main-thread catch-up. Commit the openbox container check as a release-checklist script.

## A. Root cause (verified from source)

Verified facts, in the order the regression unfolds:

1. **Two live queries, not two caches.** tao `platform_impl/linux/window.rs:317-331`: `o_pos` and `o_size` are each `window.window().map(|w| w.root_origin()).unwrap_or(w_pos)`. The GdkWindow exists (`show_all()` at line 224 runs before `setup_signals` at 270), so both are `gdk_window_get_root_origin` → `gdk_x11_window_get_frame_extents` (`gdkwindow-x11.c`): try `_NET_FRAME_EXTENTS` on the client, else walk `XQueryTree` up to the child of root and `XGetGeometry` it. Each call is 1 to 3 X round trips; nothing is cached between them. The old comment in `windows.rs:174-178` ("the same origin") describes the common case, not a guarantee.

2. **A positioned window is a different X conversation.** `gtk_window_move()` on an unmapped window queues a resize and records `initial_x/y` (`gtkwindow.c:5755-5759`). `gtk_window_show` (6198) realizes the X window at the widget allocation `(0,0)` (`gtk_window_realize`, `attributes.x = allocation.x`), then `gtk_container_check_resize` → `gtk_window_move_resize` (8607-8616, 9809) issues `gdk_window_move`/`move_resize` to `(40,30)` plus `GDK_HINT_POS` hints; GDK does **not** update `window->x/y` for a managed toplevel (`window_x11_move`, only override-redirect windows do). The fresh window issues no move. Then `gtk_widget_map` → `XMapWindow`.

3. **openbox moves the answer through `(0,0)`.** `frame.c:57-64 createWindow`: the frame is created at `0,0 1x1`. `client.c:270-300 client_manage`: `grab_server(TRUE)` … `frame_grab_client` (`XReparentWindow(client, frame, 0, 0)`, `frame.c:1000`) … `grab_server(FALSE)`. Only afterwards `frame_adjust_area` (`client.c:339`) does `XMoveResizeWindow(frame → client area)`, `XMoveWindow(client, left, top)` and sets `_NET_FRAME_EXTENTS` (`frame.c:845-870`); placement (`place_client`, `client.c:373`) is after that and only moves windows that did not position themselves.
   So `root_origin()` for the seeded window returns, in time order: `(40,30)` (client still under root, at its own geometry) → `(0,0)` (reparented, frame unmoved, no property yet) → `(40,30)` (frame moved, property set). For the fresh window: `(0,0)` → `(0,0)` → `(0,0)` → `(99,37)` only at placement. Two back-to-back calls straddle the transient for the positioned window and practically never for the unpositioned one. Why it is 3/3 deterministic rather than a coin flip is inferred, not measured: the server grab taken in `client_manage` holds our first query until right after the reparent, which is exactly the transient state, and the second query lands after openbox's next flush.

4. **The seeds now read as "configured".** `origin_seeded((0,0), (40,30), 1.0)` is false (`windows.rs:195-199`), so `Live::configured()` returns true (`:745-753`).

5. **The catch-up runs inline, before anything else.** Startup windows are built in `setup` → `desktop::init` → `restore_startup_windows` on the main thread (confirmed in `code-review-window-size-fix.md`, lib.rs 443-451; `TauriBackend::new` at `desktop/mod.rs:173`). tauri-runtime-wry `send_user_message` (`lib.rs:263-276`) handles `Message::Task` synchronously on the main thread (`:3182`), while `on_window_event` always goes through the proxy (`:1851-1858`). So `schedule_catch_up` (`windows.rs:816-830`) runs at once, with no listener registered and no GTK iteration run (wry's `gtk::main_iteration()` calls exist only in its cookie methods, `webkitgtk/mod.rs:1139-1210`). `catch_up` (`:254-258`) sees armed and configured, `apply` (`:244-247`) removes the target, `correct_to_outer` (`:204-216`) measures outer `(40,30)` → `corrected_inner_size` gets a negative decoration → `None` → no resize. The window is now disarmed for good.

6. **The listener then saves the uncorrected footprint.** First real configure → `admit_geometry_event` finds nothing armed → `Resized` admitted → `note_window_geometry` → saved `1302x875`. Next launch requests `1302x875` as content; repeat. This is exactly `out-2c0d840/geometry.txt`: `1300x850 → 1302x875 → 1304x900 → 1306x925`. `e824b79` has no catch-up, so the seeds never mattered there; the listener's first `Resized` measured the real frame.

Why the other checks are blind: on the WM-less `:99` and the e2e `window size` case, `root_origin()` always returns the client's own geometry (both seeds equal) and the decoration is genuinely zero, so neither the misfire nor the drift can occur.

## B. Fix design

Keep the deferred-correction architecture; change two things in `PendingCorrections` and `TauriBackend`.

1. **A catch-up never disarms on an implausible measurement.** The catch-up cannot know whether a configure has happened (that is the whole problem); the listener can, because its `Resized` *is* the configure. So: in `catch_up`, measure first, and only on a plausible result (`Some`, including zero decoration) request the size and disarm; on `None` leave the entry armed for the listener. Implement by having `correct_to_outer` return a three-way result (resized / exact / implausible) or by splitting `apply` into a peek and a take. The listener path (`admit_geometry_event`) keeps today's semantics: first `Resized` measures and disarms regardless, because a perpetual arm would swallow every `Moved`/`Resized` under a tiling WM (where the tile is implausible forever) and then fire a correction on the user's first in-band resize.

2. **Skip the catch-up for a main-thread build.** Capture `main_thread: std::thread::ThreadId` in `TauriBackend::new` (constructed in `setup`) and return early from `schedule_catch_up` when `std::thread::current().id() == self.main_thread`. Rationale for the comment: on the main thread `run_on_main_thread` runs inline, before the listener exists and before any GTK iteration, so the check can only read seeds; the listener always sees the first configure there (the review's verified claim). This makes the startup/restore path byte-for-byte the `baea5a6` behaviour the harness proved. Off the main thread (page `window:new`, deep link, second instance, shortcut) the catch-up stays, because M1 is real: the worker's `AddEventListener` races the main thread's next GTK iteration for FIFO position in tao's single `event_tx`.

3. **Keep `origin_seeded`, fix its story.** It remains a necessary first filter (seeds equal → certainly unconfigured, skip the measurement). It is not sufficient: rewrite the doc on `CorrectableWindow::configured` and `origin_seeded` to say the two seeds are two live `root_origin()` queries that normally agree and can disagree under a reparenting WM, which is why a plausibility gate follows. Change (1) also closes the documented "position equals size" collision: a seeded window whose position lies in `[target, target+ceiling]` would read as a plausible decoration and be shrunk; that hole is now reachable only when the seeds differ *and* the position falls in that band, which (2) removes for startup entirely.

4. **Optional diagnostic (cheap, recommended).** `runtime_log::note` the measured decoration and which path applied it (listener vs catch-up) the first time a window is corrected. Field logs then show a zero or implausible first measurement on a decorated desktop without a harness.

### What to avoid

- **Build hidden, register the listener, then `show()`.** It looks like the clean way to kill M1 (the first configure cannot precede the listener), but it moves `show_all()` from inside tao's `Window::new` (followed by WebKit's slow init, all before any GTK iteration) into a `WindowRequest::Visible` glib handler, after which GTK iterates immediately. The pre-WM `ConfigureNotify` from GTK's own `XMoveWindow` (step 2 above; positioned windows only) would then be processed while openbox is still managing the window, and tao's cache handler would `frame_extents()` into the same transient: `1x1` frame (negative, now harmless with change 1) or the un-reparented client (zero decoration, which reads as a valid measurement and disarms). Today's visible build is accidentally race-free on this axis; keep it.
- **A GTK `configure-event` handler through `gtk_window()`.** Thread-affine (must be connected on the main thread), so for an off-main-thread build it cannot be installed earlier than the catch-up task and answers nothing new; Tauri's `after_window_creation` hook is internal (`tauri/src/window/mod.rs:410`), and `Builder::on_window_event` is wired through the same async `on_window_event` (`tauri/src/manager/window.rs:99`), so there is no race-free global route either.
- **Deleting the catch-up and accepting M1.** The worker-thread race is real and would make a late correction land on the user's first drag.
- **Re-arming or time-based arming.** Never re-arm; a decoration measured once per window is the contract that keeps theme and scale changes from fighting the user.
- **Hard-coding `1,1,20,5` or openbox behaviour in product code.** The fix must stay WM-agnostic; openbox is only the test oracle.

## C. Tests

Rust (`windows.rs` fake, shared logic):

- Model the seeds separately: add `outer_position_before_configure: Mutex<Option<(f64, f64)>>` next to `outer_before_configure`, and have `FakeHandle::configured()` return `window.configured || seeds differ` (mirroring `Live` through `origin_seeded` on the logical values) instead of reading the `configured` flag directly. Test: position seed `(0,0)`, size seed `(40,30)`, saved `1300x850` at `(40,30)`, `FirstConfigure::AfterCheck`, off-main-thread model → after the build zero size requests and still armed; after the first configure exactly one request; saved state equals the seed after close. Same seeds with `BeforeListener` (configured for real) → corrected by the catch-up once.
- Add a `built_on_main_thread: Mutex<bool>` to the fake; when true, `build_main_window` does not call `catch_up` at all, and a test asserts the seeds-differ case still saves the seed. Keep `recognizes_the_origin_tao_seeds_both_outer_caches_with_before_the_first_configure` and add the asymmetric pair `(0,0)/(40,30)` as `!origin_seeded`.
- A direct `PendingCorrections` unit test: `catch_up` on an implausible measurement leaves it armed; the following `Resized` corrects once and disarms.

Container check (commit it; cheap and it is the only thing that saw this):

- Add `scripts/tauri-wm-geometry-check.sh` plus `scripts/tauri-wm-geometry-check/{Dockerfile,inside.sh}` beside `tauri-deb-smoke`, same `.deb` discovery and Docker flags (`seccomp`/`apparmor`/`systempaths=unconfined`, `--ulimit core=1`). Keep the small image (xvfb, openbox, x11-utils, xdotool, wmctrl, jq); do not build tauri-driver into it.
- Make it assert, not print: read `_NET_FRAME_EXTENTS` from the frame and check `client + extents == saved` and `saved == seed` for the seeded case and `saved == 1400x900` for the fresh case, three cycles each; exit non-zero with `geometry.txt` on stdout on the first mismatch. Add a third case with a cascaded second window (position `+28,+28`) once the off-main-thread path is testable there, since cascaded windows are always positioned.
- Keep it from flaking: poll for the window by `xdotool search --pid` with a long deadline instead of fixed sleeps; poll `window-state.json` mtime after `wmctrl -c` instead of `sleep 6`; wait for process exit before reading the file; one Xvfb and one openbox per run; no screenshots in the pass path.
- Where it runs: not CI (needs Docker and the built `.deb`), but a named step in the Linux release checklist next to `tauri-deb-smoke.sh`, and the Verify of any phase touching `windows.rs`/`window_bounds.rs`. Also note in the e2e `window size` case's comment that it covers the WM-less display only.
- Alternative worth a look later: start `openbox` on `:99` in `scripts/virtual-display.sh` so the regular e2e `window size` case exercises a real decoration. It would have caught this too, but a WM changes focus and placement for every other spec on that display, so treat it as a separate decision.

## D. Other risks in e2caf7e / 5c1c4ec on real WMs

- **KWin and Mutter on X11** are reparenting WMs with server-side frames for GTK windows that do not use CSD (tao's default `decorations: true`, Ubuntu's default theme), so the same transient exists and the same fix applies. Mutter also honours `PPosition`, so restored windows take the positioned path.
- **Mutter on Wayland**: `gdk_wayland_window_get_frame_extents` has no root position, both seeds are `(0,0)`, the gate is safe, and the decoration (CSD shadow, about 52x89) is plausible. Nothing changes there.
- **The pre-WM configure** (step 2) is a residual race on the listener path for positioned windows if a machine ever processes the first GTK iteration before the WM finishes managing; today WebKit's init between `show_all()` and the first iteration is what prevents it. Change 1 makes the negative variant harmless; the zero-decoration variant stays theoretical. The diagnostic log in B.4 is how you would notice it.
- **`Moved`/`Resized` hold-back while armed** is unchanged and still bounded, because the listener disarms on its first `Resized`.
- **`maximized_or_fullscreen` disarm** is unaffected; a WM that maximises at the first configure still leaves the request alone.
- **HiDPI**: `origin_seeded`'s saturation handling is still needed and still correct; the plausibility gate works on logical values.

## Work checklist

1. `PendingCorrections::catch_up`: measure, correct and disarm only on a plausible result; leave armed on `None`. Adjust `correct_to_outer`'s return type or split `apply`.
2. `TauriBackend`: record the main `ThreadId` in `new`; early-return in `schedule_catch_up` on the main thread, with the inline-`run_on_main_thread` rationale in the comment.
3. Rewrite the `configured`/`origin_seeded` docs (two live `root_origin()` queries; necessary, not sufficient).
4. Fake backend: position seed, seeds-derived `configured()`, `built_on_main_thread`; the tests in C.
5. Optional: first-correction diagnostic in `runtime_log`.
6. Commit the openbox check as `scripts/tauri-wm-geometry-check.sh` with assertions; wire it into the Linux release checklist and the phase Verify.
7. Rebuild the `.deb`, rerun the harness: fresh and seeded must be stable for three cycles each, seeded client `1298x825`, saved `1300x850` at `(40,30)`.

## Success metrics

- Harness: seeded saved state identical across three launches; fresh unchanged; no `request_inner_size` on the seeded path before the first configure (visible in the diagnostic log).
- `cargo test` in `src-tauri`: the seeds-differ tests pass; the existing `BeforeListener`/`BeforeCheck` tests still pass (M1 stays fixed).
- No new GTK-specific code outside `Live`.

## Assumptions

- The grab-induced ordering that makes the race land 3/3 is inferred from the openbox and GDK code paths, not traced with `xtrace`; confidence medium. The structural facts (two live queries, transient `(0,0)` for positioned windows only, inline main-thread catch-up) are verified and are sufficient for the fix regardless of exact timing.
- `TauriBackend::new` runs on the main thread (it is called from `desktop::init` inside `setup`); confidence high. If that ever moves, the `ThreadId` capture must move with it, or use `gtk::is_initialized_main_thread()` instead.
- Off-main-thread builds (page `window:new`, deep link, second instance, shortcut) are the only remaining consumers of the catch-up; confidence high from the review's call-site list. If any of them is later moved onto the main thread, the skip makes the catch-up a no-op there too, which is correct.
- The pre-WM configure race stays theoretical on real hardware because WebKit init is orders of magnitude slower than openbox/Mutter managing a window; confidence medium-high. The diagnostic log is the cheap way to detect it if that assumption fails.

Status: DONE
Summary: Root cause confirmed from tao, GDK and openbox source: both outer seeds are live `root_origin()` X queries racing the reparenting WM, and a positioned window passes through a `(0,0)` transient that makes the seeds differ, so the inline main-thread catch-up measured garbage and disarmed. Fix: catch-up never disarms on an implausible measurement, is skipped for main-thread builds, and the openbox container check becomes an asserting release-checklist script.
