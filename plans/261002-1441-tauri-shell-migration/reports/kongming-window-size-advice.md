# Kongming advice: Tauri main-window size doubling and the stale runtime_log version

Phase 10 (integration/parity) Failure Protocol checkpoint. Worktree `/home/tung491/WORK/worktrees/tauri-integration` at `c623b75`. Advisory only; no project files were edited.

## TL;DR

Root cause confirmed, and it is worse than "virtual display only": `build_main_window` probes `outer_size()` synchronously after `build()`, but on Linux tao seeds that cache with the window *position* until the first `configure-event`, and no GTK main-loop iteration can run between `build()` and the probe. The correction therefore computes `content = 2 x target - position` on every Linux session, GNOME Wayland included (there position is always 0,0, so the window asks for 2800x1800 and Mutter squeezes it to the work area). Fix: make the correction use the *requested* size as its probe, reject implausible decorations, and on Linux apply it once on the window's first `Resized` event instead of synchronously. Save/restore has no logical/physical unit bug; the "GTK scale 2" hypothesis in the parity report is wrong (the run had no `GDK_SCALE`, and every observed number fits `2 x target - position` at scale 1). For the version string, build the `RuntimeLog` from `context.package_info().version` by moving `generate_context!()` above `runtime_log::install`.

## Reframed problem

Decide (1) whether the doubling is a display-harness artifact or a product defect that blocks the Linux cutover decision in Task 10.6, (2) the smallest cross-platform fix that keeps the decision recorded in commit `5b4355f` (window-state.json stores the outer footprint, shared with Electron) and (3) how far unattended verification can go. Non-goal: changing the saved-state contract.

## Verified evidence

- tao 0.37.1 `src/platform_impl/linux/window.rs`: `show_all()` at line 224 runs before `setup_signals` at line 270, so the GdkWindow exists when the caches are seeded; lines 321 and 329 seed both `outer_position` and `outer_size` from `root_origin()` (a position); lines 333-357 update inner and outer in one `configure-event` handler; lines 495-522 return the caches converted logical -> physical by the scale factor.
- tao `event_loop.rs:609-633` emits `Moved`/`Resized` from a second configure handler that is connected later (via `WireUpEvents`), so GTK runs the cache handler first: when Tauri's `Resized` reaches us, `inner_size()`/`outer_size()` already describe that configure.
- `src-tauri/src/desktop/windows.rs:708-740` probes right after `build()`; `content_and_outer_size` at 670-675; `corrected_inner_size` at `window_bounds.rs:44-47` subtracts `outer - inner` with only a `>= 1` clamp.
- Handover evidence (`/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/handover-evidence/`):
  - `step3/.../window-state.json` = `{2540 x 1710, x 260, y 90}`. Electron's centered default on 1920x1080 is 1400x900 at (260, 90). `2*1400-260 = 2540`, `2*900-90 = 1710`. Exact match, scale 1.
  - `step3/tauri-environ.txt` has no `GDK_SCALE`/`GDK_DPI_SCALE`; `renderer-visual-pass.md` states "GDK monitor scale 1 at 96 dpi".
  - Visual pass restored windows at 2800x1800, 2772x1772, 2744x1744 = `2*1400 - 28k` for cascade offsets k = 0, 1, 2.
  - `step5b/.../window-state.json` = `{2800 x 1800, 0, 0}`: the inflated size was saved, so the next launch requested 5600x3600. The observed "800x3600" matches in height; the 800 width is not explained by the formula (speculation: GTK clamped an oversize request to the 800 min; verify after the fix rather than chase it).
- tao macOS `window.rs:744` and Windows `window.rs:228` read the live frame (`NSWindow::frame`, `GetWindowRect`): the synchronous probe is correct there.
- `startup_geometry` (windows.rs:191-204), `logical_rect` (656-662) and `set_bounds` (851-855) are all logical. No unit mix-up.
- Version: `lib.rs:407` installs the log with `env!("CARGO_PKG_VERSION")` before `generate_context!()` at 412; `Cargo.toml` and `Cargo.lock` still say 0.9.15; `TauriHost::app_version` (lib.rs:246) reads `package_info()`, which `tauri.conf.json` ties to `package.json`.

## Answers

### A. Root cause and fix

Confirmed. Treat it as a Linux cutover blocker, not a harness artifact: the synchronous probe can never see a real configure on Linux, so the only reason it has not been seen on GNOME is that nobody looked (Mutter constrains the oversize request to the work area, so the symptom there is "always opens filling the screen, never at the saved size").

Recommended fix (a blend of your (i) and (ii)):

1. `window_bounds.rs`: change the signature to `corrected_inner_size(target_outer, requested_inner, measured_outer) -> Option<(f64, f64)>`. Decoration = `measured_outer - requested_inner`. Return `None` when either axis is negative or above a plausibility ceiling. Use the *requested* size, not `inner_size()` read back: it is what the FakeBackend already models, and it makes the fixed point independent of what tao's Linux `inner_size` (the configure event size) includes under CSD. Clamp the result to `MIN_WIDTH x MIN_HEIGHT` instead of 1.
2. Ceiling: `MAX_DECORATION_WIDTH = 200`, `MAX_DECORATION_HEIGHT = 300` logical px. Observed GNOME CSD is 52x89; Windows is about 16x39 (two 8 px invisible borders plus a 31 px caption); macOS is 0x28. Anything larger is garbage (position leakage or a compositor-constrained first configure), and skipping the correction is always safe: the window simply keeps its requested content size. Note the ceiling alone cannot catch garbage on multi-monitor X11 (a window at x = 1500 yields a "decoration" of 100), which is why step 3 is required.
3. Linux: defer. `TauriBackend` keeps `pending_outer: Mutex<BTreeMap<WindowId, (f64, f64)>>`; `build_main_window` inserts `spec.size` when not maximizing and makes no synchronous `set_size`. In `route_window_event`, on the first `WindowEvent::Resized` for that id, remove the entry, read `outer_size().to_logical(scale)`, compute the correction, and `set_size(LogicalSize)` once if it differs. Never re-arm, so no resize loop. macOS/Windows keep the synchronous call (same function, now `Option`). Gate with `cfg!(target_os = "linux")`.
4. Save-side guard (see B): ignore reported bounds smaller than the window's minimum size.

Reject (iii) GDK frame extents: it is the same number tao caches, with the same timing problem, plus GTK-specific code on a cross-platform path. Reject "save the inner size instead": it reverses the `5b4355f` decision on the shared file and its fixed point is unproven (GTK3's `resize()` and the configure-event size disagree by the CSD title bar on Wayland).

### B. Save/restore

No separate unit fix. Two hardenings only:

- `WindowRegistry::note_bounds` (`windows.rs:330-338`): drop a `bounds` whose width or height is below `MIN_WIDTH x MIN_HEIGHT`. Before the first configure the tao caches hold the position, so a `CloseRequested` on a never-configured window would otherwise save `width = x`. The outer footprint can never be smaller than the minimum content size, so the guard is sound.
- Nothing else. `restore_within_displays` never shrinks a reachable window to the display; that is Electron parity (`window_bounds.rs:50-53` comment) and stops mattering once sizes stop inflating.

The 800x3600 state is explained by the inflated 2800x1800 save (step5b) feeding the formula again; the fix removes the mechanism. Verify it instead of diagnosing further.

### C. Tests

`window_bounds.rs` (unit):

- the field case: target (1400, 900), requested (1400, 900), measured outer (260, 90) returns `None`, never (2540, 1710); same for (0, 0) and the cascade (28, 28);
- the known decoration: measured (1452, 989) returns `Some((1348, 811))`; zero decoration returns `Some(target)`;
- ceilings: a 201 px wide or 301 px tall decoration returns `None`; the result is clamped at `MIN_WIDTH x MIN_HEIGHT`.

`windows.rs` FakeBackend (~1110): add `outer_before_configure: Mutex<Option<(f64, f64)>>` and a `configured: BTreeSet<WindowId>`. `build_main_window` stores the uncorrected size; apply the correction when the test emits `WinEvent::Resized` for the window (mirroring the deferred real backend). Tests:

- `a_restored_window_keeps_its_requested_size_until_its_first_configure_then_matches_the_saved_footprint`: spawn with saved 1452x989 and decoration 52x89; before `Resized`, `bounds()` is the raw request; after `Resized`, `bounds()` is 1452x989; `CloseRequested` saves the identical JSON (extends `restoring_a_decorated_window_saves_the_same_outer_bounds_it_was_given`, windows.rs:1416).
- `a_position_seeded_probe_never_doubles_the_window`: outer-before-configure = position, `Resized` never emitted, `CloseRequested`: saved state must equal the input, not 2x.
- `a_close_before_the_first_configure_does_not_save_garbage`: `note_bounds` ignores a 260x90 rect.

e2e (unattended, WM-less `:99`, where the bug is deterministic): extend `test:windows` (`test_hooks.rs:146-148`) to include logical bounds, then in `e2e-tauri/desktop.e2e.ts` seed `window-state.json` with `{width: 1300, height: 850, x: 40, y: 30}` and assert the first window reports 1300x850 (today it reports 2560x1670), and that after a restart the file still holds 1300x850.

### D. Verification without the user

- The WM-less Xvfb `:99` is the regression environment: before the fix a fresh window is 2800x1800 (`xdotool search --name "Sai ATLAS" getwindowgeometry`), after it is 1400x900, and three launches leave `window-state.json` unchanged. Run it twice, once with `GDK_SCALE=2`, to cover the integer-HiDPI conversion path (`tao` reports scale 2 there, like GTK3 at GNOME 125%).
- No X11 WM or nested compositor is installed (`openbox`, `weston`, `mutter` absent; `gnome-shell` present but `--nested --wayland` inside Xvfb is heavy and flaky). Do not block on it. `sudo apt install openbox` is a user action; if the user is available later, `openbox` inside `:99` exercises `_NET_FRAME_EXTENTS` (server-side decorations) in two minutes.
- Leave the real GNOME 50 Wayland 125% check as `PENDING-USER` with this script in the parity report: quit Sai ATLAS, `jq .windowState ~/.config/@oh-my-pi/omp-gui/window-state.json`, launch, `jq` again, quit, `jq` a third time; pass = all three identical and the window visibly the same size. Acceptable because the mechanism is proven from code (no main-loop iteration between `build()` and the probe) and the fix removes the probe; the remaining risk on GNOME is a CSD decoration that is not constant between the first configure and the correction (theme or scale change mid-launch), which the ceiling turns into a one-time no-op rather than a drift.

## Second defect: runtime_log appVersion

Fix in code, not in the release flow: move `let mut context = tauri::generate_context!();` (lib.rs:412) above `runtime_log::install` (lib.rs:407) and pass `context.package_info().version.to_string()`. `Context::package_info()` exists before any app handle and resolves to the same `package.json` version `Host::app_version` reports. Keep `env!("CARGO_PKG_VERSION")` only in the lazy `global()` fallback (`runtime_log.rs:235`): it is reachable only if something logs before `run()` reaches that line, which nothing does today; a comment there saying "may lag the bundle version" is enough. Syncing `Cargo.toml` in the release flow is the weaker option: it also changes `Cargo.lock`, which a `--locked` CI build then rejects until the lock is regenerated, and it adds a manual step that the stage builds already skipped twice.

## What to avoid

- Shipping option (i) alone (skip when negative): on Linux the probe is garbage in both directions, so it just reintroduces the original 52x89 compounding drift on GNOME.
- Looping the correction on every `Resized`: a theme or scale change would fight the user's resize.
- Changing the saved-state contract to inner size during Phase 10; it is a user-visible file shared with Electron and a recorded decision.
- Clamping the saved size to the display in `restore_within_displays`: Electron did not, and it masks inflation instead of fixing it.

## Work checklist

1. `window_bounds.rs`: `Option` return, requested-size probe, ceilings, min clamp; update the two existing tests and add the field-number tests.
2. `windows.rs` TauriBackend: `pending_outer`, arm in `build_main_window` (Linux, not maximized), apply once on the first `Resized` in `route_window_event`; synchronous path for other OSes.
3. `windows.rs` `note_bounds`: ignore sub-minimum rects.
4. FakeBackend: deferred model plus the three tests above.
5. `lib.rs`: reorder `generate_context!()` and pass `package_info().version`.
6. `cargo test --manifest-path src-tauri/Cargo.toml --all-features`, `cargo clippy ... -D warnings`.
7. Rebuild the deb/AppImage, run the Xvfb geometry check (scale 1 and `GDK_SCALE=2`), update `parity-report.md`: replace the "GTK scale 2 / unit mix-up" sentence with the confirmed cause, record the Xvfb result, and add the `PENDING-USER` desktop script.

## Success metrics

- Fresh window on `:99` is 1400x900; three restarts leave `window-state.json` byte-identical.
- The Electron handover state `{1400 x 900, 260, 90}` opens a Tauri window of exactly 1400x900 at (260, 90).
- `gui-runtime.jsonl` shows the bundle version (0.9.17/0.9.18) in `appVersion`.
- No new window ever exceeds the primary work area on a fresh profile.

## Assumptions

- The "GTK scale 2" phrase in `parity-report.md:77,108` was inferred from the 2x numbers, not configured (high; `tauri-environ.txt` lacks `GDK_SCALE`, and the arithmetic fits scale 1).
- On GNOME Wayland the decoration measured at the first configure (frame extents minus the requested size) is constant for a fixed theme and scale (medium; this is also what `5b4355f` assumed). If the user's desktop still drifts after the fix, the next step is to log `requested`, `inner_size`, `outer_size` on the first three `Resized` events and compare.
- The e2e-hooks feature can expose bounds without touching release builds (high; `test_hooks.rs` is feature-gated).
- No Phase 10 acceptance row requires the real-desktop size check before Task 10.6; it can be listed as an accepted `PENDING-USER` item in the cutover decision (medium; the plan's 10.6 text only asks for the parity report in hand).

Status: DONE_WITH_CONCERNS
Summary: Root cause confirmed from tao source and the saved-state numbers: the synchronous post-build probe reads a position-seeded outer size on every Linux session, so the correction doubles the window; fix by probing against the requested size with plausibility ceilings and deferring the one-shot correction to the first Resized event on Linux, guard garbage saves, and take the log version from `context.package_info()`. Concern: real GNOME Wayland confirmation stays PENDING-USER, and the 800 px width in one observation is explained only by speculation.
