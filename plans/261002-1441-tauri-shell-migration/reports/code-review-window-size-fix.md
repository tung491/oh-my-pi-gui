# Code review: Tauri window-size fix and runtime-log version

Worktree `/home/tung491/WORK/worktrees/tauri-integration`, branch `tauri/integration`, range `3f6af10..e824b79`:

- `baea5a6` fix(tauri): open restored windows at their saved size on Linux
- `e824b79` fix(tauri): log the bundle version in the runtime log

I read the code at HEAD through `git show`. Nothing was built or run, because a bundle build was running in the worktree. To check the timing claims, I read tao 0.37.1 and tauri / tauri-runtime-wry 2.12.1 in `~/.cargo/registry`; those are the versions in `Cargo.lock`.

## Scope

- Files: `src-tauri/src/desktop/window_bounds.rs`, `src-tauri/src/desktop/windows.rs`, `src-tauri/src/test_hooks.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/runtime_log.rs`, `e2e-tauri/desktop.e2e.ts`, `e2e-tauri/test-hooks.ts`, `e2e-tauri/check-twins.ts`
- About 343 lines added and 63 removed.
- Spec: `plans/261002-1441-tauri-shell-migration/reports/kongming-window-size-advice.md`. Every checklist item is implemented as written.

## Verdict

**Nothing blocks the merge.** The fix removes the doubling on every path where it was observed: the startup and restored windows, which are built in `setup` on the main thread. The decoration math, the plausibility ceilings, the minimum clamp, the save guard and the version change all match the spec. I found no lock held across a Tauri call, no resize loop and no cfg problem. One finding (M1) should be fixed before the Linux cutover decision. M1 is a real ordering gap: when a window is built off the main thread, tao and Tauri do not guarantee the "correct on the window's first `Resized`" step.

## How it works (verified)

- In tao `linux/event_loop.rs:609-633`, the configure handler emits `Moved` and then `Resized` on **every** `configure-event`, moves included, through the single `event_tx` crossbeam channel. User events share that channel (`user_event_tx = event_tx.clone()`, line 241), so everything is FIFO.
- In tao `linux/window.rs:321-357`, the outer-size cache starts out holding `root_origin()` (a position) and is overwritten by the cache handler. That handler was connected earlier, so it runs first. This confirms the spec's root cause.
- In tauri-runtime-wry `lib.rs:1851-1858`, `on_window_event` **always** registers its listener asynchronously through `proxy.send_event(AddEventListener)`, even on the main thread. Tauri's own manager listener is registered the same way (`tauri/src/manager/window.rs:99`).
- In `lib.rs:443-451` (setup), `desktop::init` → `restore_startup_windows` runs on the main thread. `create_window` is synchronous there, and `AddEventListener` is queued before GTK gets another main-loop iteration, so the listener always sees the first configure. This covers the path the field data came from.

## Findings

### M1 (Medium; fix before the Linux cutover). A window built off the main thread can miss its first `Resized`, and the armed correction then fires on a later configure, possibly mid-drag

- Where: `src-tauri/src/desktop/windows.rs:759-762` (arms the correction), `:784` (`observe`), `:649-665` / `:670-675` (consumes it). Trigger: `src-tauri/src/services/ipc.rs:175-190`. The `window:new` handler is `async` (it `.await`s `session_kind_for`), so `spawn_window` → `build_main_window` runs on a tokio worker.
- How it happens: off the main thread, tauri-runtime-wry's `create_window` (`lib.rs:300-330`) posts `CreateWindow` and blocks on `rx.recv()`. The main thread builds the window (`show_all` maps it), sends the result and goes straight back to the tao loop. Meanwhile the worker wakes, runs `attach_window`, `configure_webkit` and then `observe` → `AddEventListener`. On a WM-less X server the `ConfigureNotify` comes back almost immediately; with a WM it takes a few milliseconds. If the main thread's GTK iteration queues `Moved`/`Resized` before the worker queues `AddEventListener`, Tauri dispatches the first `Resized` to a listener list that does not yet contain ours. That `Resized` is lost, and the `pending_outer` entry stays armed.
- What happens next: the entry is consumed by the **next** configure.
  - Usually that is a move or a WM state change with an unchanged size. The correction then measures correctly and the window jumps late, which is still visible.
  - If the next configure is the user's first resize drag, `decoration = user_outer - target`. Any growth between 0..200 x 0..300 counts as plausible, so the window is `set_size`d to `2*target - user_outer`: it shrinks under the user's drag, once.
  - If the user shrinks instead, the measurement is skipped and the footprint stays `target + decoration`, which is the old 52x89 drift for that window.
- The comment at `:753-758` ("armed before the build so the entry is in place however early that event arrives") is wrong for the same reason. No listener exists before `observe` returns and its proxy message is processed, so arming before the build adds nothing; the build-failure cleanup at `:777-783` exists only because of it.
- Fix (no race, small): right after `observe`, queue a follow-up with `app.run_on_main_thread`. It travels through the same FIFO proxy, so it runs after `AddEventListener`.
  - If the entry is still armed and the window has already been configured, apply the correction there and disarm.
  - Otherwise leave the entry armed for the listener.
  - On tao/Linux, "not configured yet" is detectable: before the first configure, `outer_size() == outer_position()` exactly, because both caches are seeded from `root_origin()` (`window.rs:321,329`). After a configure they match only by coincidence.
  - Alternative: build main windows on the main thread (`run_on_main_thread` plus a oneshot back to the caller).
- Other spawn paths I did not trace for thread affinity: the global-shortcut toggle (`desktop/mod.rs:261-276`), quick-entry submit (`quick_entry.rs:354`) and deep links (`deep_link.rs:160,178`). Each of them hits M1 if it runs off the main thread.

### M2 (Medium-Low). The first configure can carry a size the WM imposed, and a plausible-looking gap is then applied against the WM

- Where: `windows.rs:710-719` (`correct_to_outer`), `window_bounds.rs:59-62`.
- Scenario A, Mutter auto-maximize or work-area constraint. The content is first requested at the full saved footprint, which is decoration-larger than the target. A saved window close to the work-area size (for example 1850x1000 on 1920x1080) maps maximized or constrained. Example: measured 1920x1048 against a requested 1850x1000 gives a "decoration" of 70x48, which is plausible. `set_size(1780, 952)` is then sent to a maximized window, and GTK stores it as the restore size. After unmaximize the footprint is about 1832x1041 instead of 1850x1000.
- Scenario B, tiling WMs (sway, i3, Hyprland, or GNOME tiling extensions). The first configure is the tile size. If the tile is up to 200x300 larger than the target, the correction is computed from the tile and requested while the WM ignores it. When the window is floated later, its content is `2*target - tile`.
- No loop happens in either case, because the entry is disarmed. The result is a one-time wrong restore size.
- Fix: in `apply_pending_outer`, skip and disarm when `window.is_maximized()` or `window.is_fullscreen()` is true at the time of the event. Tiling cannot be detected cheaply; record it as a known limit next to the ceilings.

### L1 (Low). The doc comment understates what skipping costs

`window_bounds.rs:55-57` says "skipping the correction costs at most one decoration of growth". That is true for one launch, but the grown footprint is saved and becomes the next target. Wherever the skip is systematic, the window grows by one decoration per launch, which is exactly the pre-`5b4355f` drift. For example, a WM whose first configure always arrives constrained, or before `_NET_FRAME_EXTENTS` is known on a reparenting X11 WM, would be systematic. Reword it to say the cost is "one decoration per launch while the measurement keeps failing". This also belongs in the parity report as the residual risk for the PENDING-USER desktop check, next to the openbox-in-`:99` check the spec suggests.

### L2 (Low). The real backend saves the uncorrected footprint first; the fake hides it

- Where: `windows.rs:656` then `:662`. GTK's `set_size` is asynchronous, so when `route_window_event` runs for the first `Resized`, `note_window_geometry` reads the **uncorrected** footprint (for example 1504x1078) and schedules a debounced write. The corrected configure normally supersedes it within the 500 ms debounce.
- If the WM ignores the resize, or the user closes within 500 ms (`CloseRequested` persists immediately), the inflated size is saved for that run.
- `FakeBackend::configure` (`:1180-1190`) applies the correction to `bounds` synchronously before the routed `Resized`. Because of that, `a_restored_window_keeps_its_requested_size_until_its_first_configure_then_matches_the_saved_footprint` (`:1554`) cannot observe the intermediate note. Either model the second configure explicitly in the fake, or skip `note_window_geometry` on the event that triggered a correction, since another configure is guaranteed to follow a `set_size` that changes the size.

### L3 (Low). The `note_bounds` guard catches only small positions, but its comment claims more

`windows.rs:330-343`, filter at `:337`. A window seeded with its position passes the 800x600 filter whenever its position is at least 800,600. That happens on multi-monitor X11, for example a window at (2180, 900) on a second screen, which would save `{width: 2180, height: 900}` if it closed before its first configure. That window is narrow (close before first configure), and on Wayland the position is always 0,0, so the filter does catch it there. The comment "it is what a Linux window reports before its first configure" reads as complete coverage. Narrow the wording, or use the `outer_size == outer_position` discriminator from M1 in `TauriBackend::bounds` and return `None` before the first configure. That is exact and would also make the filter unnecessary on Linux. The filter has one side benefit: Windows reports about 160x28 for minimized windows, and those are no longer saved.

### L4 (Low). The e2e test proves "no doubling" but never exercises the decoration subtraction

`e2e-tauri/desktop.e2e.ts:818-848`. On WM-less Xvfb there is no frame, so the decoration is 0x0 and `correct_to_outer` never calls `set_size`. The test is deterministic and a good regression guard for the original bug: before the configure, `bounds` holds the position, so `until` waits, and the old code produced 2560x1670. Its limits:

- It cannot catch a wrong decoration sign or unit.
- It cannot catch M1, because startup windows are built on the main thread.
- `toEqual(saved)` includes `x/y`, so the test assumes the WM honors the requested position. Under a real WM, for example a developer running it on their own desktop, it would flake. Add a comment saying it needs the virtual display.
- The 1.5 s pauses prove that nothing changed, not that a write happened. That is acceptable for a "the file is unchanged" claim.

### N1 (Nit)

- `windows.rs:757`: one comment line runs to about 130 columns while its neighbors wrap near 80.
- `window_bounds.rs:5` now imports `MIN_WIDTH`/`MIN_HEIGHT` from `windows.rs`, which already imports `corrected_inner_size` from `window_bounds.rs`. The import cycle is legal, but the constants fit better in `window_bounds.rs`, which is the geometry leaf.

## Focus items with no problems found

- **Resized for a different window id**: each `observe` closure captures its own `id`, and `apply_pending_outer` removes only that key. Window ids come from a monotonic `next_id` (`windows.rs:290-293`) and are never reused. The entry is removed on `Destroyed` and on build failure. A window that is never configured and never destroyed leaks one map entry until the process exits, which is harmless.
- **Maximize**: `defer_correction` is false when `spec.maximize` is set, the same as the old code. A window maximized on restore keeps its uncorrected restore size; that drift is pre-existing and out of scope.
- **User resize before the first configure**: not possible, because an unmapped window takes no input. The real hazard is the lost-first-event case in M1.
- **Quick-entry window**: it goes through `observe`, never has a pending entry, and `apply_pending_outer` returns early.
- **Other window builders**: `webview::build_window` has exactly two callers, the main window and quick entry (`git grep build_window(`). No settings or stats windows share this code.
- **Resize loops**: the entry is removed before `set_size` and never re-armed. The `Resized` caused by the correction finds no entry.
- **Locks**:
  - The `lock(pending_outer).remove(&id)` guard in the `let ... else` at `:671` is a temporary, dropped at the end of the statement before `get_webview_window`/`set_size`.
  - The other uses at `:658`, `:761` and `:780` are single-statement temporaries.
  - Nothing is held across a Tauri call or an await, so the `significant_drop_in_scrutinee` and `await_holding_lock` lints are respected.
  - tauri-runtime-wry holds `window_event_listeners` while calling handlers (`lib.rs:4202`). The handler's getters and `set_size` never touch that map, and `route_window_event` already made the same kind of calls before this change.
  - In the fake, the lock order is `windows` → `scale`/`decoration_physical` in `configure`. Nothing takes them in the reverse order.
- **`cfg!` vs `#[cfg]`**: every API used (`outer_size`, `scale_factor`, `set_size`, `BTreeMap`, `Arc`) exists on every target. `pending_outer` is read by `observe` on all OSes, so there is no dead-code warning on macOS or Windows. Using `cfg!` there costs only one uncontended mutex per `Resized`.
- **macOS/Windows synchronous path**: it uses `requested_inner = target` instead of reading the size back. tao keeps the logical size across `WM_DPICHANGED`, so the math still holds on mixed-DPI Windows setups.
- **No plan IDs, phase numbers or finding codes** in code, tests or commit messages. Test names follow the module's sentence style.

## Runtime-log commit (`e824b79`)

Correct. Nothing to change.

- `generate_context!()` only builds a struct from data embedded at compile time; it has no runtime side effects. Moving it above `runtime_log::install` and `create_dir_all(profile)` changes no dependency: `context` is mutated only later, for the identifier, before `Builder` runs.
- `RuntimeLog::new` takes `impl Into<String>` (`runtime_log.rs:193`), so the `String` from `package_info().version.to_string()` fits.
- Nothing logs before `install`: the profile-resolution failure uses `eprintln!` only, `main.rs` does not log, `paths.rs:252` only calls `node_platform()`, and the supervisor re-exec (`omp::supervisor::run`) does not use `runtime_log`. The new `global()` comment is accurate.
- `tauri.conf.json` has `"version": "../package.json"`, so the version comes from `package.json` at compile time. A bundle build that rewrites `package.json` before compiling embeds the rewritten version, which is the intended behavior.

## Tests and quality

- Unit tests cover the field numbers, the ceilings with boundaries on both sides, negative decorations, the minimum clamp, a single correction, close-before-configure and the save guard. They are meaningful, not phantom.
- One gap: the real `TauriBackend` arm/consume/disarm logic is not executed by any test. The fake reimplements it (`FakeWindow::pending_outer`). Pulling a tiny `PendingCorrections { arm, take, disarm }` type into `windows.rs` would let both backends share it and test it once. This is optional, because M1's timing issue cannot be unit-tested either way.
- Not run by me: type coverage, coverage numbers and lint results (no cargo or bun runs).

## Recommended actions

1. M1: add the main-thread follow-up check after `observe`, using `outer_size == outer_position` as the "not configured yet" test. Fix the misleading comment at `windows.rs:753-758`.
2. M2: skip and disarm the deferred correction when the window is maximized or fullscreen at its first configure.
3. L1 and L3: correct the two comments that overclaim. Optionally return `None` from `TauriBackend::bounds` before the first configure.
4. L2: avoid noting the uncorrected footprint on the configure that triggered a correction, or make the fake model the intermediate state.
5. Keep the spec's PENDING-USER GNOME check and the openbox-in-`:99` check. Neither unit tests nor the WM-less e2e can reach the WM-imposed-configure paths in M2 and L1.

## Unresolved questions

- Which threads run the global-shortcut toggle, quick-entry submit and deep-link spawns? Each one that runs off the main thread also hits M1.
- On a reparenting X11 WM, does the first `configure-event` already see `_NET_FRAME_EXTENTS` and the frame parent? If not, the correction is skipped on every launch and the per-launch growth in L1 comes back. Only a real WM can answer this; openbox in `:99` is the cheapest test.

Status: DONE_WITH_CONCERNS
Summary: Neither commit has a blocking defect. The fix removes the position-seeded doubling on the startup and restore path, and the runtime-log version change is correct. Concern: windows built off the main thread (at least the async `window:new` IPC) can lose their first `Resized`, because Tauri registers window listeners asynchronously; the armed correction then fires on a later configure, possibly against a user's resize. WM-imposed first configures (auto-maximize, tiling) can also feed a plausible but wrong decoration.

---

## Re-review of e2caf7e

`e2caf7e` fix(tauri): correct windows built off the main thread and leave maximized ones alone. I reviewed it with `git show` and read `windows.rs` at `e2caf7e`, checking against tao 0.37.1, tauri-runtime-wry 2.12.1 and dpi. Nothing was built or run.

**Verdict: nothing blocks the merge.** M1, M2, L1, L2, L3, L4 and both nits are addressed. Two new findings are Low, plus some comment nits.

### Earlier findings: how each was resolved

- **M1 resolved.** `build_main_window` now arms the correction after `build` and before `observe`, then `schedule_catch_up` (`windows.rs:799`) queues a `run_on_main_thread` task.
  - Both `AddEventListener` and the task go through tauri-runtime-wry's `proxy.send_event` from the same thread, so the main thread runs them in order and the task runs after the listener exists.
  - Off the main thread, two cases:
    - If the first configure went by unseen, `catch_up` finds the window configured and applies the correction once.
    - If the listener saw it, the listener already disarmed it and `catch_up` does nothing.
  - On the main thread, `send_user_message` runs the task at once, before any GTK iteration. The window is still unconfigured, so the correction is left to the listener.
  - Removing the build-failure cleanup is correct: nothing is armed before `build` now.
- **M2 resolved.** `correct_to_outer` returns early when the window is maximized or fullscreen, and `apply` disarms either way. Residual risk, which I could not check: the guard reads tao's `maximized` cache, which the window-state-event updates. On X11 a WM can deliver the maximized `ConfigureNotify` before the `_NET_WM_STATE` change, and then the guard reads false at the first `Resized`. The 200x300 ceilings still cap the damage. Wayland delivers state and size in one configure.
- **L1 and L3:** the comments now state the limits (`window_bounds.rs` doc, `note_bounds` doc).
- **L2 resolved.** `admit_geometry_event` (`windows.rs:248`) holds back `Moved`, and the `Resized` that requests a resize, while a correction is armed. The test now asserts that `saved_state_for` is `None` between the request and the corrected configure.
- **L4:** the virtual-display requirement is commented in the e2e test.
- **Nits:** `MIN_*` now lives in `window_bounds.rs`, so the import cycle is gone, and the overlong comment line is gone.
- **Shared logic:** `PendingCorrections` and `CorrectableWindow` are used by `TauriBackend` (through `Live`) and by `FakeBackend` (through `FakeHandle`), so the arm/apply/disarm logic the tests run is the production code. `FirstConfigure` models the three orderings that can really happen (after the catch-up, before the listener, between the two). The tests now check the request count, so "never a second correction" and "a user's resize drag is left alone" are actually asserted.

### Can anything wait forever while a correction is armed?

No. Nothing awaits or blocks on the armed state. The only effect of holding events back is that a geometry note is skipped. I checked the only consumer of `Moved`/`Resized`, which is `lifecycle.rs:24` → `note_window_geometry`, used for persistence only. The renderer learns its size from the DOM, not from these events. Case by case:

- **Maximized at the first configure:** `apply` disarms and returns false, so that `Resized` is admitted. The `Moved` from the same configure is dropped, which is harmless because `note_window_geometry` reads the whole rect.
- **WM ignores `set_size`, or clamps it to the same geometry so no new `ConfigureNotify` comes:** the triggering `Resized` is dropped and the entry is already disarmed, so the next move or resize is admitted. Until then `last_bounds` stays `None`.
  - Closing the window still saves, because `CloseRequested` calls `note_window_geometry` itself, which reads the live bounds.
  - A quit that skips `CloseRequested` (tray Quit, SIGTERM) leaves the previous saved state in place, which is the state this window was restored from.
- **Window never configured:** it produces no geometry events at all. `Destroyed` disarms it, and a close falls back to the minimum-size filter.
- **position == size collision** (documented by the author): the entry stays armed until the next configure. That configure may be a user's resize drag, and geometry notes are held back until then. It is vanishingly rare and documented. The comment's "like a window built on the main thread" is not accurate: such a window gets a *later* configure, not its first.

### Thread safety and lock order

- `PendingCorrections` is a `Mutex<BTreeMap>`, so it is `Send` and `Sync`.
  - `arm` runs on whichever thread builds the window (tokio worker, zbus, global-hotkey or main), always before `observe`, so no listener can race it.
  - `apply`, `catch_up`, `admit_geometry_event` and `disarm` (on `Destroyed`) run on the main thread, so `is_armed` → `configured()` → `apply` cannot interleave with the listener.
- No guard is held across a Tauri call:
  - `is_armed` returns a `bool`.
  - In `apply`, the `remove` in the `let ... else` drops its temporary before `correct_to_outer` runs.
  - `arm` and `disarm` are single statements.
- `Live`'s getters on the main thread go directly to `handle_user_message`. No `windows` RefCell borrow is outstanding inside a listener or a `Task`.
- In the fake, `targets` is never held while `windows` is locked. `configure_window` releases `windows` before `admit_geometry_event`, and `close`/`destroy` lock `windows` and then `pending` one after the other, never nested.

### New findings

**N-L1 (Low). `Live::configured` misjudges a window with a negative origin at integer scale 2 or more** (`windows.rs:726-735`).
- Before the first configure, tao stores the origin in both caches. `outer_size()` converts it as `i32 as u32` logical, then multiplies by the scale and rounds to `u32`, which saturates. `outer_position()` multiplies the `i32` by the scale.
- At scale 1, x = -1920 compares equal (4294965376 on both sides). At scale 2, the size saturates to `u32::MAX` while `position.x as u32` is 4294963456, so the comparison reads "configured".
- On the main-thread path, `catch_up` runs right away, measures a width of about 2^31, gets `None` from the ceilings and **disarms**. That window's correction is skipped for the launch: there is no wrong resize, but the footprint grows by one decoration, and this repeats every launch while the window sits there.
- It needs X11 with `GDK_SCALE` of 2 or more and a saved window whose x or y is below 0 (partly off the left or top edge, but still reachable so it is not recentered). Wayland positions are always 0,0, and X11 root coordinates are otherwise not negative. Narrow.
- Fix: compare in tao's own conversion. Take `position.to_logical::<i32>(scale)`, cast each axis `as u32`, convert `.to_physical::<u32>(scale)`, and compare that with `outer_size()`. Alternatively, treat any width or height of `i32::MAX as u32` or more as unconfigured.

**N-L2 (Low, cannot verify here). The M2 guard depends on window-state and configure ordering on X11.** See the residual-risk note under M2 above. There is no code change to make; add it to the parity report's real-WM check (openbox, or the user's GNOME X11 session).

**Nits**
- The `Live` doc says "Its getters are cache reads on the main thread, where every caller here runs". The macOS/Windows synchronous `correct_to_outer(&Live(&window), …)` in `build_main_window` runs on the building thread, where each getter is a blocking round trip to the main thread. That is correct (it reads the live frame) and existed before; only the comment is wrong.
- The `PendingCorrections` doc says "all run on the main thread"; `arm` does not. The behavior is fine because of the mutex.

### Tests

- The fake models the orderings that matter.
- `Live::configured` (the `u32`/`i32` comparison) and `schedule_catch_up` (the FIFO claim) remain untestable without a display. Their correctness rests on the tauri-runtime-wry and tao source cited above, which I checked.
- No phantom tests: each new test asserts the request count, the bounds and the saved JSON.

Status: DONE
Summary: e2caf7e resolves M1 (a main-thread catch-up queued behind the async listener), M2, L1, L2, L3, L4 and the nits, shares the correction logic with the fake, and keeps locks off Tauri calls. Holding events back cannot stall anything: it only skips geometry notes, and the close path reads live bounds. Remaining: two Low findings (negative-origin misjudgment at scale 2 or more; X11 maximize-state ordering) and some comment nits, none blocking.
