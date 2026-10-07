---
phase: 10
title: "Integration, e2e migration, visual pass and Linux parity report"
status: pending
priority: P1
effort: "12d"
dependencies: [3, 4, 5, 6, 7, 8, 9]
---

# Phase 10: Integration, e2e migration and Linux parity

## Goal

All seven module branches are merged into one working Tauri app. Every Playwright/Electron e2e scenario runs against the Tauri app on Linux with the same assertions. A visual pass, a sandbox check and a footprint measurement prove Linux parity, and the update handover from the installed Electron builds is proven end to end. macOS and Windows verification belongs to Phase 12.

## Preconditions

- All seven wave phases report `Status: DONE` (or `DONE_WITH_CONCERNS` that the user accepted), and each `check-module.sh` passed on its branch.
- `test -x resources/omp && test -x resources/omp.linux-x64` succeeds (see `plan.md` → Sidecar binaries).

## Files

Work is sequential from here, so no ownership limits apply. Expect changes in `e2e-tauri/**` (new), `wdio.conf.ts` (new), `src-tauri/src/test_hooks.rs`, `package.json`, and fixes wherever a run proves a defect. `e2e/**` keeps every existing test unchanged, because macOS and Windows still ship Electron and run those specs; this phase may add Playwright tests there that also pass on Electron (Task 10.3 step 2 adds one).

## Tasks

### Task 10.1: Serial merge
- Goal: one integration branch with all modules, green at every step.
- Steps:
  1. `git switch -c tauri/integration tauri/foundation`.
  2. Merge in this order, one at a time, with `git merge --no-ff`: `tauri/omp`, `tauri/tabs`, `tauri/services`, `tauri/desktop`, `tauri/ollama`, `tauri/updater`, `tauri/renderer`.
  3. After each merge, run `cargo test --manifest-path src-tauri/Cargo.toml --all-features` and `bunx vitest run`. Both must exit 0 before the next merge. Ownership was disjoint, so a merge conflict means a wave phase broke its rules: follow the Failure Protocol.
  4. Remove each worktree with `git worktree remove ../worktrees/tauri-<module>`, after `pgrep -af "worktrees/tauri-"` prints nothing (stop only processes you started).
  5. Linux sidecar lookup (check only; implemented on `tauri/foundation` in `fe94ddf`). `paths::resolve_bundled_omp()` searches, in Tauri's `resource_dir` order, `<exe dir>/../lib/Sai ATLAS/omp`, `$APPDIR/usr/lib/Sai ATLAS/omp` and `/usr/lib/Sai ATLAS/omp` on Linux, `<exe dir>/../Resources/omp` on macOS, then `<exe dir>/omp[.exe]`, and never a system `omp` (`paths::bundled_omp_candidates`, `paths.rs:205`). Phase 8 ships the Linux sidecar at `lib/Sai ATLAS/omp` in both bundles. Confirm the merged tree still has that order: `cargo test --manifest-path src-tauri/Cargo.toml -- paths::tests::finds_the_sidecar_in_the_deb_resource_dir paths::tests::finds_the_sidecar_in_the_appimage_resource_dir paths::tests::falls_back_to_the_executable_dir_and_errors_when_nothing_is_bundled` reports `3 passed`. Do not reimplement it.
  6. `TauriHost::clipboard_read_text` (`lib.rs`) reads the clipboard synchronously on the calling tokio worker, so a slow X11/Wayland selection owner blocks a runtime thread. Move the read into `tokio::task::spawn_blocking` (the `Host` signature already returns a future), and keep `services`' `system:clipboard-read` and `gui_clipboard_read` callers unchanged.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --test channels` exits 0; `grep -rnE "todo!\(|unimplemented!\(|not_ported\(" src-tauri/src | grep -v "fn not_ported("` prints nothing (the `IpcError::not_ported` constructor in `bridge.rs` stays); the step 5 command reports `3 passed`.

### Task 10.2: Test hooks
- Goal: the e2e specs can do in Tauri what they did through Electron's main process, and none of it reaches a release build.
- Target: `src-tauri/src/test_hooks.rs` (compiled only with `--features e2e-hooks`), `e2e-tauri/test-hooks.ts`.
- Steps:
  1. Inventory every main-process reach-in, including multi-line calls: `grep -nE "\bapp\.evaluate\(" e2e/*.e2e.ts`. On 2026-10-02 there were 34 (desktop 16, real-core 6, packaged-smoke 3, quick-entry 3, runtime 2, deep-audit 2, onboarding 1, auto-follow 1). Read each one and record in `e2e-tauri/reach-ins.json` what it does and which hook replaces it.
  2. Map each reach-in to a hook the foundation's `e2e-hooks` machinery already provides: handler fault scripts (`Fault::Error`, `Fault::Delay`, `Fault::Barrier` + `test:release`, replacing `ipcMain.removeHandler` overrides at `e2e/desktop.e2e.ts:573-598` and `e2e/real-core.e2e.ts:249-253`), `test:emit` (replacing `webContents.send` injections at `desktop.e2e.ts:471, 514`), `test:quit`, `test:windows`, `test:second-instance` (`quick-entry.e2e.ts:53-55`) and `test:navigation-probe` (`desktop.e2e.ts:527`). Page capture and zoom (`desktop.e2e.ts:401-416`) use WebDriver's `takeScreenshot` and the renderer's own zoom API. Opening an exported file (`real-core.e2e.ts:115-121`) opens it in a WebDriver-driven second session, not in an app window.
  3. If a reach-in fits none of these, add a named hook in `test_hooks.rs` behind the feature. Never add a hook that loads an arbitrary URL into an app window or replaces a handler with arbitrary code.
  4. Fix the barrier race before any spec relies on `Fault::Barrier`: the barrier in `bridge.rs` (the `Fault::Barrier` wait in the call path and `Bridge::release_barrier`, both `e2e-hooks` only) wakes waiters with `notify_waiters()`, which reaches only futures that were already polled, and then removes the barrier. A `test:release` that runs before the held call's `Reply::Later` task first polls loses the wakeup, and the call hangs. Keep a released state instead (for example a `tokio::sync::watch` per barrier, or a released flag checked before waiting) so a release that comes first still lets the call through. Test (with `--features e2e-hooks`): `a barrier released before the call waits still releases it`.
  5. Test: `no test hook is registered without e2e-hooks`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml test_hooks` exits 0, `cargo test --manifest-path src-tauri/Cargo.toml --features e2e-hooks -- test_hooks bridge::tests` exits 0 and includes the step 4 test, and `jq length e2e-tauri/reach-ins.json` prints `34`.

### Task 10.3: Tauri e2e harness and spec migration (Linux)
- Goal: every e2e scenario runs against the Tauri app with the same assertions.
- Steps:
  1. Harness: `cargo install tauri-driver --locked`; ask the user to run `! sudo apt-get install -y webkit2gtk-driver`. Add `@wdio/cli`, `@wdio/local-runner`, `@wdio/mocha-framework` and `@wdio/spec-reporter`. `wdio.conf.ts` starts `tauri-driver`, sets `tauri:options.application` to the binary built by `bun x tauri build --debug --features e2e-hooks --no-bundle` (embedded assets, no dev server), passes a fresh `--user-data-dir`, and runs one worker.
  2. Port the specs one file at a time into `e2e-tauri/`, with the same file names and test titles: `runtime`, `onboarding`, `desktop`, `quick-entry`, `auto-follow`, `real-core`, `performance`, `deep-audit`. Reuse `e2e/sidecar-fixture.ts` and `e2e/desktop-prefs.ts` by import. The quick-entry bar gained a Send button after the Electron specs were written (`2b0b698`; `e2e/quick-entry.e2e.ts` only presses Enter, and its `"Send (Enter)"` click at line 158 is the main composer's button): add `quick entry sends from the Send button` to `e2e/quick-entry.e2e.ts` first (Playwright, must pass on Electron), then port it with the rest, so the twins check covers the button. The twin also asserts the bar's `innerWidth`/`innerHeight` are `680`/`168` (Phase 5 Task 5.4). Add one Tauri-only spec, `e2e-tauri/csp.e2e.ts` (no Playwright twin; list it as Tauri-only in `check-twins.ts`): `the renderer runs under the Tauri CSP` asserts, through `browser.execute`, that `fetch("https://example.com/")` rejects and that a `securitypolicyviolation` event fires for an `<img src="https://example.com/x.png">` with `effectiveDirective` `img-src`. This is the only CSP check that counts: `bun run dev:tauri` serves the page from the Vite dev server, outside the Tauri protocol that adds the CSP header, and `vite.tauri.config.ts` strips the meta CSP, so a dev run has no CSP at all; the wdio build embeds the assets and gets the header.
  3. Translate Playwright to WebdriverIO (`page.locator(sel)` → `$(sel)`, `page.evaluate(fn)` → `browser.execute(fn)`, `expect(locator).toBeVisible()` → `await expect($(sel)).toBeDisplayed()`), and reach-ins to the hooks from Task 10.2.
  4. `packaged-smoke`: run against the installed `.deb` (`/usr/bin/sai-atlas`) built without `e2e-hooks`, observing only from outside: `/proc` for processes, `Seccomp:	2` and a nested `NSpid` on every `WebKitWebProcess` (the twin of "boots sandboxed and renders with a ready sidecar", `e2e/packaged-smoke.e2e.ts:139-156`; "every", not the newest one, so a second window's process is checked too), `bwrap` as the parent of each web process, D-Bus for single-instance (the smoke runs on a throwaway `--user-data-dir`, so the bus name is `paths::single_instance_id()`: `vn.io.vif.saiatlas.p<16 hex chars>` of the profile path's SHA-256, not the bare app id, which only the default profile uses; `lib.rs:385-387` also sets that value as the Tauri identifier), the window list for windows, and the sidecar log for `ready`. Add the real-agent S7b case as the last test, `a hard kill leaves no sidecar or tool child`: with one tab running `!/usr/bin/sleep 600` through the agent, `kill -9` the `sai-atlas` pid; within 10 s `pgrep -f "omp --mode rpc-ui"`, `pgrep -f -- "--omp-supervise"` and `pgrep -f "/usr/bin/sleep 600"` print nothing. Also check the Wayland app id of the window is `vn.io.vif.saiatlas` (on every profile, since `main.rs` sets it with `glib::set_prgname`) (`busctl --user tree org.gnome.Shell` or the `gdbus` introspection the spike used; a `StartupWMClass` match means GNOME shows the Sai ATLAS icon for the window, not a generic one).
  5. Add `"test:e2e:tauri": "wdio run wdio.conf.ts"` to `package.json`.
- Success criteria: every Playwright test has a twin with the same title and at least as many `expect(` calls.
- Verify: `bun run test:e2e:tauri` exits 0. Then `bun e2e-tauri/check-twins.ts` exits 0. That script (write it in this task) compares, per title, the Playwright test in `e2e/` with its twin in `e2e-tauri/`: same title set, and a twin `expect(` count ≥ the original's.

### Task 10.4: Visual pass on Linux
- Goal: evidence that each heavy surface works in WebKitGTK with real data.
- Steps:
  1. Install the `.deb` from `bun run package:tauri:linux` and launch it with a throwaway profile. It uses the real sidecar.
  2. Record PASS/FAIL with a screenshot path in `reports/renderer-visual-pass.md` for: chat with markdown and code (highlight.js), KaTeX, Mermaid, xterm, CodeMirror, stats charts, diff panel, files panel, settings reflow at 800 px and 1400 px, light and dark themes, scrollbars, quick-entry bar at 680×168 with no empty band at the bottom and a working Send button, theme change reaching the bar on its next summon, voice dictation through the WebAudio capture with the sandbox on (a transcript arrives), tray icon visible with a working menu click, global shortcut on Wayland while another app has focus, an `omp://` link, Export logs in the Logs panel (a native save dialog opens and the saved file holds the visible log lines; the blob download routes through `build_window`'s download handler to `Host::save_dialog`; the download is first staged in the Downloads folder as a hidden `.<name>.<pid>-<n>.part` file and the dialog opens once WebKit has finished writing it, so after both Save and Cancel `ls -a "$(xdg-user-dir DOWNLOAD)" | grep -c '\.part$'` must equal its value before the export), the quit guard during a turn, closing the last window (the process exits on Linux), and quitting with three windows (all three restore). Accepted degradations, recorded as such and not as FAIL: the bar does not stay above other windows on Wayland, and the tray has no left-click.
  3. Fix each FAIL with the smallest engine-neutral change, then re-run the affected checks and `bunx vitest run`.
- Verify: `grep -c "| FAIL |" plans/261002-1441-tauri-shell-migration/reports/renderer-visual-pass.md` prints `0`.

### Task 10.5: Footprint and update-handover evidence
- Goal: the numbers that justify the cutover, and proof that installed Electron builds move to the Tauri build on their own.
- Steps:
  1. Footprint: with Phase 0 Task 0.2's method, measure PSS for the packaged Tauri app and the packaged Electron AppImage, each with 1 and 3 tabs, 60 s idle and during one turn against the same fixture. The Tauri shell total includes the supervisor processes (about 1 MB each in the spike) and the `bwrap`/`xdg-dbus-proxy` helpers, as the S2 measurement did (250,010 kB = 55.4%). Record the installer sizes next to the S12 baseline (.deb 169.88 MiB, AppImage 245.73 MiB).
  2. Baseline: use the Electron build the installed Sai ATLAS population runs, as recorded in the Validation Log (its version and channel). Do not substitute a local build.
  3. AppImage handover: run `bun scripts/release-feeds.ts` on the Tauri bundles into `dist-release/`, and serve it with `bunx serve -l 8765 dist-release` through the background runner. Extract the baseline AppImage (`--appimage-extract`), replace `squashfs-root/resources/app-update.yml` with `provider: generic`, `url: http://127.0.0.1:8765/`, and run `squashfs-root/AppRun` with `APPIMAGE` pointing at a copy of the original. Check, download and apply. Pass conditions: the copy is replaced by the Tauri AppImage; the old Electron PID is gone within 10 s of apply; exactly one app instance runs; the Tauri app starts without user action; settings and tabs are intact.
  4. deb handover: in a VM or container with a desktop session, install the baseline `.deb`, point it at the same server (the `app-update.yml` path comes from `dpkg -L <package> | grep app-update.yml`), and apply. Pass conditions: `dpkg -s sai-atlas` shows the Tauri version; any older package name from the Validation Log is removed or replaced; the app relaunches on its own through the `/opt/Sai ATLAS/sai-atlas` compat link; exactly one instance runs; settings are intact.
  5. Tauri self-update relaunch. Steps 3 and 4 exercise the Electron updater; this step exercises the Rust one (`Host::relaunch_after_exit`, started in the `RunEvent::Exit` arm with this process's environment minus `APPIMAGE_EXIT_AFTER_INSTALL`, `lib.rs:236-247`). Build the bundle under test with `SAI_ATLAS_UPDATE_BASE=http://127.0.0.1:8765` in the environment of `bun run package:tauri:linux` (the build-time feed override from Phase 8 Task 8.2 step 1), then build a second Tauri bundle with a higher version, run `bun scripts/release-feeds.ts` on the second one into `dist-release/`, and serve it as in step 3. Check, download and apply from the Tauri AppImage. Pass conditions: the file at `$APPIMAGE` is the new build; the old PID is gone within 10 s; exactly one instance runs; in the new process, `tr '\0' '\n' < /proc/<new pid>/environ` shows `APPIMAGE` equal to the replaced file, `APPDIR` naming the new mount (not the old `/tmp/.mount_*` directory, which no longer exists) and no `APPIMAGE_EXIT_AFTER_INSTALL`; its window renders and its sidecar reaches `ready`. Repeat for the installed Tauri `.deb` (relaunch of `/usr/bin/sai-atlas`): the same instance, PID and render conditions hold. If `APPDIR` or `LD_LIBRARY_PATH` still points at the old mount and the app fails to start, that is a foundation defect in `start_pending_relaunch`: follow the Failure Protocol.
  6. Stop the server you started.
- Verify: `reports/parity-report.md` contains the footprint table (four rows), `AppImage handover: PASS`, `deb handover: PASS` and `Tauri self-update relaunch: PASS`. Check with `grep -cE "^((AppImage|deb) handover|Tauri self-update relaunch): PASS$" plans/261002-1441-tauri-shell-migration/reports/parity-report.md`, which prints `3`. The table must also show the Tauri shell at ≤ the S2 threshold in the Validation Log.

### Task 10.6: Linux cutover decision
- Goal: the user decides with the parity report in hand.
- Steps: present the footprint table, the visual-pass result, the handover results and any accepted degradations. Ask the user to choose: cut over Linux in the next release, or hold.
- Verify: no verification needed; record the decision in `plan.md` → Validation Log.

## Rollback

`tauri/integration` is a branch; `main` still ships Electron. Abandoning it costs nothing in production.

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
