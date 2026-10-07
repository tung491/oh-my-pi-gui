# Kongming counsel: Electron → Tauri .deb update handover (Task 10.5 step 4)

Date: 2026-10-05 (KST). Advisory only; no project files were edited besides this report.
Runtime: Claude Code on `fable` (Claude Fable 5.1).

## TL;DR

Teach the Tauri binary Electron's relauncher protocol (option A-i): when `argv[1] == "--type=relauncher"`, write one `\0` byte to fd 3, wait for the parent to exit, then start `/usr/bin/sai-atlas` with no arguments. Start it through the user's systemd manager (`systemd-run --user`, transient service, `ExitType=cgroup`) so the new session escapes `no_new_privs`; fall back to a direct detached spawn when there is no user manager. Do not ship an Electron bridge release: electron-updater always jumps to the newest release, so a 0.9.16 install that checks after the Tauri release goes straight to Tauri and the bridge cannot be made mandatory. Independently, make every `pkexec` user in the Tauri app (`updater/install.rs`, `ollama/remedy.rs`) check `NoNewPrivs` first and report "quit and reopen" instead of "refused". The onboarding reappearance is 0.9.16's own behaviour on any restart, not a handover failure. One new finding: the AppImage handover PASS in step 3 ran on a non-production code path and needs a re-run.

## Reframed problem

The decision is not "how do we stop Electron from deadlocking" but "what does the Tauri binary owe the already-shipped 0.9.16 Electron updater, given that we can never change that updater's behaviour". Electron 44.4.5 + electron-updater 6.8.9 is frozen on users' disks. Everything it will do during the handover is fixed and now known from source:

- `DebUpdater.doInstall` (node_modules/electron-updater/out/DebUpdater.js:27-49) runs `pkexec /bin/bash -c 'dpkg -i …'` synchronously, then `this.app.relaunch()` because the GUI leaves `autoRunAppAfterInstall` at its default `true` for the deb (src/main/updater.ts:224-233 only disables it for the AppImage). `BaseUpdater.quitAndInstall` (BaseUpdater.js:13-25) then `setImmediate`s `app.quit()` regardless of what `relaunch()` returned.
- `App::Relaunch` with no options (electron v44.4.5 shell/browser/api/electron_api_app.cc) passes the process's own argv to `relauncher::RelaunchApp`, which uses `CHILD_PROCESS_EXE` as the helper, which is `/opt/Sai ATLAS/sai-atlas`, which the Tauri deb has just turned into a symlink to `/usr/bin/sai-atlas` (src-tauri/linux/finalize-deb.ts:47).
- `RelaunchAppWithHelper` (shell/browser/relauncher.cc) builds `[helper, "--type=relauncher", "--no-sandbox", <relauncher_args>, "---", <argv…>]`, maps the write end of a pipe to fd 3 (`kRelauncherSyncFD = STDERR_FILENO + 1`), launches with default `base::LaunchOptions` (so `PR_SET_NO_NEW_PRIVS` is set: Chromium base/process/launch.h, `allow_new_privs = false` by default), closes its write end, and blocks on `read(fd, &c, 1)`. A result other than 1 logs `read: unexpected result` and returns false.
- The real relauncher (`RelauncherMain` + relauncher_linux.cc) writes `\0` to fd 3, arms `PR_SET_PDEATHSIG`, waits for the parent to die, then `LaunchProgram` with `allow_new_privs = true` and `new_process_group = true`. That `allow_new_privs` is ineffective: the relauncher itself already carries NNP=1, and the flag is inherited and cannot be cleared.

Requirements the fix must meet (phase-10 file, Task 10.5 step 4): dpkg shows the Tauri version (already PASS), the app relaunches on its own through the compat link, old Electron PID gone within 10 s, exactly one instance, settings intact. Step 5 then needs a Tauri deb self-update from that session to work, which means `pkexec` must work in the handed-over session, or the app must say clearly why it cannot.

Non-goals: changing 0.9.16; persisting "Set up later" (product change, see D); making the Electron→Electron deb relaunch right (it has the same NNP bug and is history).

## Verified findings (beyond the evidence already in RESULT.txt)

1. Electron will quit even if the relauncher protocol fails. `quitAndInstall` only checks `install()`'s return, and `DebUpdater.doInstall` returns true after `relaunch()` whatever it returned (DebUpdater.js:45-48, BaseUpdater.js:17-22). So the worst case of a bug in Tauri's relauncher mode is "app quits and nobody relaunches it", never "two instances", as long as Tauri does not launch before the parent is gone. This bounds the blast radius of option A-i.
2. The GUI pre-approves the quit before the install (src/main/updater.ts:345 `approveQuitBeforeInstall`; src/main/app-quit.ts:44-51 then lets `before-quit` through). So "parent never exits" is a corner case, not the common path.
3. NNP is also a problem for the welcome screen, not only for the updater. `ollama/remedy.rs` runs `pkexec systemctl start ollama.service` and `pkexec sh -c <install line>` (remedy.rs:40-45, 574-578) and classifies 127 as "no auth agent / could not authenticate" (remedy.rs:104-120). The handed-over Tauri session shows the welcome screen (see D), so the very first thing a migrated deb user may click is "Install Ollama", which would fail with "pkexec must be setuid root". B must cover remedy.rs too.
4. The AppImage handover PASS (parity-report.md:75-87) ran on a non-production path. The step-3 log says `Install: isSilent: false, isForceRunAfter: true` and `Executing: …/Sai-ATLAS-0.9.17-x86_64.AppImage`, and the new process carried `APPIMAGE_SILENT_INSTALL=true`: that is electron-updater's own Node `spawn` (AppImageUpdater.js:103-107), which means `linuxPackageKind` returned `"other"`, not `"appimage"`. Cause: the harness ran the extracted `squashfs-root/AppRun`, which sets `APPDIR` as a shell variable but never exports it (AppRun lines 7-25 export PATH/XDG_DATA_DIRS/LD_LIBRARY_PATH/GSETTINGS_SCHEMA_DIR only), and `linuxPackageKind` requires `env.APPDIR` plus `execPath` under it (src/main/updater-state.ts:174-182). A real AppImage launch (runtime exports APPDIR) takes the other branch: `autoRunAppAfterInstall = false`, electron-updater runs the new image synchronously with `APPIMAGE_EXIT_AFTER_INSTALL=true` (main.rs:20-25 handles it), then the GUI calls `app.relaunch({ execPath: appImageTarget, args: [] })` (updater.ts:367), which goes through Chromium's relauncher. On that path the helper is the old Electron binary inside the still-mounted squashfs, so the protocol is satisfied and the pass conditions should still hold, but the resulting Tauri AppImage session has NNP=1, the same way the deb one does. Step 3 must be re-run with the production path (export `APPDIR`, or run the real `.AppImage` file instead of `AppRun`) and must record `NoNewPrivs` of the new process.
5. polkit resolves a subject with no logind session to the user's graphical session (polkit `polkitbackendsessionmonitor-systemd.c`: "process -> uid -> graphical session (systemd version 213)" via `sd_pid_get_owner_uid` + `sd_uid_get_display`). This is why GNOME-launched apps (which live in `app-gnome-*.scope` under `user@UID.service`, not in `session-N.scope`) can use `pkexec`, and why a Tauri started by `systemd-run --user` can too. Host facts: systemd 259, polkitd 127; `systemctl --user show-environment` on this GNOME host already contains DISPLAY, WAYLAND_DISPLAY, XAUTHORITY, DBUS_SESSION_BUS_ADDRESS, XDG_CURRENT_DESKTOP, XDG_SESSION_TYPE. The container (ubuntu:24.04, no systemd package) has no `systemd-run`, so there the fallback path runs.
6. The "could not register the omp:// scheme: No such file or directory" line comes from `desktop/mod.rs:425-427` → `register_deep_link_scheme`; the container user has no `~/.local/share/applications`. Harmless on a desktop, but a `create_dir_all` of that directory before registering costs one line and makes the handover evidence clean.

## A. Fix options and the recommendation

### Recommendation: A-i, Tauri implements the relauncher protocol, plus an out-of-tree launch

Where: `main.rs`, before `glib::set_prgname` and before `sai_atlas_lib::run()`, next to the `--omp-supervise` check (main.rs:14-16). New module, say `src-tauri/src/handover.rs` (name it for what it is: the 0.9.x Electron relaunch helper contract), with the launch primitive shared with `relaunch.rs`.

Protocol to implement (Electron 44.4.5 exact):

1. Recognise `args[1] == "--type=relauncher"` only. Do not require `argv.len() >= 4`; be lenient on the rest. Everything from `args[2]` up to the first `"---"` is Electron's relauncher args (`--no-sandbox` today); everything after `"---"` is the argv Electron wanted relaunched (`"/opt/Sai ATLAS/sai-atlas"` plus any original arguments such as an `omp://` link, `--ozone-platform=x11`, or a workspace path). Drop all of it. Launch `std::env::current_exe()` (resolves `/proc/self/exe` → `/usr/bin/sai-atlas`) with no arguments, which mirrors the existing decision for every other relaunch ("No arguments, so a launch link or workspace is not replayed", relaunch.rs:22, updater.ts:364-367).
2. Capture `parent = getppid()` first thing.
3. Sync byte: `fstat(3)`; if it is a FIFO (`S_ISFIFO`), `write(3, "\0", 1)` and `close(3)`. Treat `EBADF`, `EPIPE`, `EAGAIN` and a non-FIFO fd 3 as "no parent is listening" and continue; Rust ignores `SIGPIPE` by default, so `EPIPE` surfaces as an error, not a kill. Never block on this write.
4. Wait for the parent to exit: `pidfd_open(parent)` + `poll(POLLIN)` with a 60 s timeout; if `pidfd_open` fails with `ENOSYS`, poll `getppid() != parent` every 50 ms. `parent == 1`, `ESRCH`, or an already-changed `getppid()` means it is already gone. Do not use `PR_SET_PDEATHSIG`: it keys on the forking *thread*, needs a signal handler, and a pidfd is simpler and testable against any child pid.
5. On timeout: log one line and exit 0 without launching. Electron still owns the profile and its windows; the next manual start is Tauri because dpkg already finished. Launching anyway would recreate the two-instance failure. Finding 1 above shows this corner is rare.
6. Launch, out of tree first:
   `systemd-run --user --quiet --collect -p Type=exec -p ExitType=cgroup --unit=app-vn.io.vif.saiatlas-handover-<pid>.service --working-directory=<cwd> --setenv=K=V … -- /usr/bin/sai-atlas`
   - `Type=exec` makes `systemd-run` return non-zero when the exec itself fails, so you can fall back.
   - `ExitType=cgroup` (systemd ≥ 250; Ubuntu 24.04 floor ships 255) is load-bearing: with the default `ExitType=main`, the moment the Tauri main process exits the unit stops and systemd SIGTERMs everything left in its cgroup, which includes a child the app has just relaunched during a later Tauri self-update. With `cgroup`, the unit lives while any process remains.
   - `--setenv` the scrubbed current environment (section C), one `K=V` per variable, skipping names that are not `[A-Za-z_][A-Za-z0-9_]*` and values containing a newline. The manager's own environment provides the session basics and the explicit variables override it, so a session whose manager never imported `WAYLAND_DISPLAY` still gets it from Electron's environment.
   - `--user` reaches the manager over `$XDG_RUNTIME_DIR/systemd/private`; it needs no session bus.
   - The `app-<ApplicationID>` unit name follows the XDG systemd unit naming convention; it is cosmetic.
   - On any failure (`ENOENT`, non-zero exit, no `XDG_RUNTIME_DIR`), fall back to the existing `relaunch::relaunch_command` (close-on-exec from fd 3 up, scrubbed env, cwd via `relaunch_cwd`) and log that the session runs under `no_new_privs`.
7. Exit 0. Do not initialise GTK, Tauri, the single-instance plugin or the deep-link plugin in this mode; do not read or write prefs. Appending to the runtime log is fine and useful: record parent pid, time to parent exit, launch route (`systemd-run` or `direct`), and the dropped argv.

Share the primitive with `start_pending_relaunch` (lib.rs:263-278): "if this process has `no_new_privs`, relaunch through the user manager, else spawn directly". That keeps the verified AppImage self-update path (parity-report.md:129-131) unchanged for normal sessions and gives the handed-over session a "Restart" that actually clears the flag.

Failure handling summary:

| Condition | Behaviour |
|---|---|
| fd 3 absent or not a pipe | skip the sync byte, still wait for the parent, still launch |
| parent already gone at start | launch immediately |
| parent alive after 60 s | log, exit 0, do not launch |
| `systemd-run` missing or failing | direct detached spawn, log NNP degradation |
| argv after `---` contains switches or links | ignored by construction (nothing after `---` is used) |

### Why not A-ii (an Electron bridge release)

- electron-updater resolves the newest release, not the next one. Any 0.9.16 install that checks after the Tauri release jumps directly to Tauri. The bridge can only help users who happen to update in the window between the two releases, so Tauri must handle the relauncher argv anyway. The bridge does not remove the work; it adds a release.
- The bridge would itself be relaunched by Electron's relauncher with NNP=1, so its own `pkexec` for the Tauri deb would fail until restart unless the bridge also detects NNP. That is the same B work, done twice.
- A bridge is a full multi-platform Electron release (feeds are shared: `latest-linux.yml`, `latest-mac.yml`), delays the Tauri cutover, and the AppImage/macOS populations gain nothing.

Keep the bridge only as a contingency if A-i cannot be made to pass on the real desktop in Phase 11.

### A-iii alternatives considered

- Replace the compat symlink with a tiny shell shim implementing the same protocol. Same NNP constraint, worse testability (no Rust unit tests, `"Sai ATLAS"` has a space, fd handling in `sh`), and a permanent oddity in the deb. The Rust branch is a few dozen lines next to an existing precedent (`--omp-supervise`). Rejected.
- Remove the compat link so `LaunchProcess` fails with `ENOENT`, Electron quits, the user reopens the app by hand. Fails the "relaunches on its own" pass condition and breaks pinned launchers that point at `/opt/Sai ATLAS/sai-atlas`. Rejected, but note it as the natural degraded behaviour if the relauncher mode ever crashes.
- D-Bus activation (`StartServiceByName`) or `xdg-desktop-portal` `OpenURI` to escape NNP. Both run the app from a bus-activated process (NNP=0) but depend on a service file we do not ship, or on the `omp://` handler registration state. Too many moving parts for one launch. Rejected in favour of `systemd-run --user`.

## B. `no_new_privs` detection, independent of A

Yes, do it, and do it in both pkexec users:

- `fn no_new_privs() -> bool`: read `/proc/self/status`, look for `NoNewPrivs:\t1`. Put it where `install.rs` and `remedy.rs` can both call it.
- `updater/install.rs::install_deb`: check before `runner.run(plan.install)`. Return a distinct error (not the string "refused") so `updater/state.rs` and the renderer can show a specific message: the update is downloaded; quit and reopen Sai ATLAS, then install. Keep the state at "downloaded" so the cached package is reused. Also classify a 127 whose stderr contains `must be setuid root` the same way (defence in depth: if detection is ever skipped, the message is still right). Add `en.ts` and `vi.ts` keys together.
- `ollama/remedy.rs`: same check before any `pkexec`; outcome `Unavailable` with a fault string that says the app must be reopened, instead of "No polkit authentication agent".
- If the shared relaunch primitive from A exists, the "Restart now" action in that state can go through `systemd-run --user` and clear the flag; otherwise ask the user to quit and reopen.

What Electron's own updater does: nothing. `LinuxUpdater.runCommandWithSudoIfNeeded` (LinuxUpdater.js:38-55) spawns `pkexec` through `sh -c` and maps any non-zero status to a thrown error. An Electron deb instance that was itself relaunched by Electron (0.9.15 → 0.9.16 in-app) carries NNP=1 and fails the next in-session `pkexec` exactly like the Tauri one. This is a known ecosystem bug; several Electron apps have shipped the same fix shape (relaunch through a detached `sh` started by Node, which does not set NNP): [t3code PR 15387](https://github.com/pingdotgg/t3code/pull/15387), [bldesk PR 103](https://github.com/termau/bldesk/pull/103), [specterm PR 82](https://github.com/froquede/specterm/pull/82), [cats-platform PR 117](https://github.com/cats-inc/cats-platform/pull/117), [hermes-agent issue 108595](https://github.com/NousResearch/hermes-agent/issues/108595). Electron main had NNP=0 in the evidence only because the harness launched 0.9.16 from the session, not from a relaunch.

## C. Environment scrub for the relauncher path

Verified present in the handed-over process's environ (step4/deadlock-evidence.txt) and set by Electron/Chromium, not by the session: `GDK_BACKEND=x11`, `NO_AT_BRIDGE=1`, `CHROME_DESKTOP=vn.io.vif.saiatlas.desktop`, `FC_FONTATIONS=1`. Drop all four. `GDK_BACKEND=x11` would put the Tauri app on XWayland; `NO_AT_BRIDGE=1` would disable WebKitGTK accessibility.

Drop by name or prefix when present (belief, harmless if absent): `ELECTRON_*` (notably `ELECTRON_RUN_AS_NODE`), `CHROME_*`, `ORIGINAL_XDG_CURRENT_DESKTOP`, `APPIMAGE_EXIT_AFTER_INSTALL`, `APPIMAGE_SILENT_INSTALL`, `DESKTOP_STARTUP_ID`, `XDG_ACTIVATION_TOKEN`, `GIO_LAUNCHED_DESKTOP_FILE`, `GIO_LAUNCHED_DESKTOP_FILE_PID`, `LISTEN_PID`, `LISTEN_FDS`, `LISTEN_FDNAMES`, `INVOCATION_ID`, `NOTIFY_SOCKET`, `MANAGERPID`, `JOURNAL_STREAM`. For a deb relaunch also drop `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD`, and run the existing `scrub_env` for old-`$APPDIR` path components.

Keep everything else, in particular `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP`, `XDG_DATA_DIRS`, `XDG_CONFIG_DIRS`, `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` (the profile path depends on them), `DBUS_SESSION_BUS_ADDRESS`, `LANG`/`LANGUAGE`/`LC_*`, `HOME`, `USER`, `LOGNAME`, `PATH`, `SSH_AUTH_SOCK`, theme and input-method variables (`GTK_*`, `QT_*`, `XMODIFIERS`, `GDK_SCALE`, `GDK_DPI_SCALE`, `XCURSOR_*`). Make the denylist a pure function with a unit test; reuse it for both launch routes.

## D. Onboarding reappearing is not a pass-condition failure

"Set up later" is `close()` in `src/renderer/components/dialogs/FirstRunOnboardingDialog.tsx:388-392`: it sets `dismissed.current = true` (a React ref) and closes the dialog. Nothing is persisted. The only persistent marker is `welcome.completed`, written at `:411` after a successful model handoff. The startup gate (`:147-176`) opens the screen on every launch when `welcome.completed` is absent and no usable model provider exists. `step4/prefs.pre-apply.json` has no `welcome.completed`, and the container has no Ollama. The same file is byte-identical in the Tauri worktree (lines 140-182 diffed), and Tauri reads the same `prefs.json` (`src-tauri/src/prefs.rs`). So a 0.9.16 restart would have shown the screen too; the handover preserved every persisted setting. Record it as expected behaviour in the parity report. Making "Set up later" sticky is a product change outside this plan.

## E. What is a user decision here

- Bridge release: a release-sequence decision, so the user's. My recommendation is no, for the reasons in A. Nothing in A-i or B needs it.
- `systemd-run --user` as the out-of-tree launcher: an implementation choice inside the plan's scope ("the app relaunches on its own"), but it adds a code path that only a systemd desktop can exercise. Flag it in the parity report; it is not a scope change.
- "Set up later" persistence: product scope; not needed for the handover; default is to leave it.
- Re-running step 3 on the production AppImage path (finding 4): plan compliance, not a user decision; the current PASS should be marked provisional until then.

## F. Verification plan

Re-run `/home/tung491/WORK/worktrees/stage-c/deb-handover/run.sh` with a Tauri 0.9.17 deb carrying the fix, and add these checks to steps 4 and 5.

Step 4 (handover), from the apply click:

- Electron log shows no `relauncher.cc` `read: unexpected result` line; old Electron PID gone within 10 s (apply-monitor already records it); no `sai-atlas` process left with `--type=relauncher` after the new app is up.
- Exactly one Tauri main process (exe `/usr/bin/sai-atlas`, argv without `--omp-supervise` and without `--type=`), one supervisor, one sidecar.
- Launch route and NNP: `grep NoNewPrivs /proc/<tauri>/status` for main, supervisor and sidecar. In the container (no systemd) expect `1` and a runtime-log line saying the direct fallback ran; on the host expect `0` and `systemctl --user status app-vn.io.vif.saiatlas-handover-*.service` active with `ExitType=cgroup`.
- Environ of the new main: none of `GDK_BACKEND`, `NO_AT_BRIDGE`, `CHROME_DESKTOP`, `FC_FONTATIONS`; `DISPLAY`/`DBUS_SESSION_BUS_ADDRESS` present; no fd pointing at Electron's pipe (`ls -l /proc/<tauri>/fd` has no `pipe:` inherited at fd 3).
- Global shortcuts register (no `HotKey already registered` in `gui-runtime.jsonl`), and no `could not register the omp:// scheme` line once the directory is created.
- Settings intact as before (`language`, `tabLayouts`); welcome screen appearing is expected (D).
- Negative cases, as the session user in the container, against the installed binary: (a) `mkfifo /tmp/sync; sh -c 'exec 3>/tmp/sync; "/opt/Sai ATLAS/sai-atlas" --type=relauncher --no-sandbox --- "/opt/Sai ATLAS/sai-atlas" omp://x --ozone-platform=x11 & sleep 3' & head -c1 /tmp/sync | xxd` must show one `00` byte, and the app must start only after the `sh` parent exits, with no arguments; (b) same with `sleep 120`: the relauncher exits after the timeout without launching and logs it; (c) `"/opt/Sai ATLAS/sai-atlas" --type=relauncher --- x 3<&-` from a shell: no crash, launches after the shell exits.

Step 5 (Tauri deb self-update from the handed-over session):

- Container: the update must stop at the new "quit and reopen" state (NNP=1) rather than "refused"; after a manual restart from the session, `pkexec dpkg -i -- ~/.cache/...` runs and the relaunch of `/usr/bin/sai-atlas` passes the existing PID/instance/render conditions.
- Host (Phase 11 cutover run on the real GNOME desktop): the same from the handed-over session directly, with NNP=0, so `pkexec` prompts and the self-update completes in-session. Also confirm "Install Ollama"/"Start Ollama" on the welcome screen prompt for a password rather than fail.

Step 3 re-run (finding 4): launch the real `.AppImage` file (or `export APPDIR` before `AppRun`), confirm the log says `isForceRunAfter: false`, confirm the `APPIMAGE_EXIT_AFTER_INSTALL=true` child exits at once, and record `NoNewPrivs` of the final Tauri process (expect 1 until the shared relaunch primitive is used by a future Tauri self-update).

Rust unit tests to add: relauncher argv split (`---` boundary, missing `---`, extra switches); sync byte written to a pipe and skipped for a non-pipe fd; `wait_for_exit` against a spawned `sleep 0.2` child and a timeout; the env denylist; the `systemd-run` argv builder (asserts `-p ExitType=cgroup`, `-p Type=exec`, env filtering).

## What to avoid

- Launching before the parent has exited, or after the wait times out. Two instances share one profile and one set of global shortcuts.
- `systemd-run --scope`: it forks the command from `systemd-run` itself, so NNP is inherited. Only a transient service escapes it.
- `ExitType=main` on that service: a later in-app relaunch would be killed with the unit.
- `PR_SET_PDEATHSIG` for parent detection in Rust; use a pidfd.
- Replaying the argv after `---`: stale `omp://` links and Chromium switches would be handed to Tauri.
- Treating pkexec exit 127 as "user refused" anywhere; 127 also means "not setuid" and "command not found".
- Shipping a bridge Electron release to "fix" the order of updates; the feed does not order anything.

## Work checklist

1. `src-tauri/src/handover.rs` (new): argv recognition, sync byte, parent wait, launch; wire in `main.rs` before glib/Tauri init.
2. Shared launch primitive: `via_user_manager(program, env, cwd)` with `systemd-run --user … -p ExitType=cgroup`, falling back to `relaunch_command`; call it from `handover.rs` and from `start_pending_relaunch` when `no_new_privs()` is true.
3. Env denylist (section C) as a pure function used by both routes; unit tests.
4. `no_new_privs()` helper; `install.rs` and `remedy.rs` check it before `pkexec`; new typed error, updater state, renderer message, `en.ts` + `vi.ts` keys.
5. `create_dir_all(~/.local/share/applications)` before `register_deep_link_scheme`.
6. Rebuild the Tauri deb (24.04 container build), re-run the harness steps 4 and 5 with the checks in F; re-run step 3 on the production AppImage path.
7. Parity report: deb handover row, provisional note on step 3, onboarding-expected note, NNP route per environment.
8. Phase 11 host run confirms the `systemd-run` route and in-session `pkexec`.

## Success metrics

- Step 4: old PID gone ≤ 10 s, one instance, settings intact, no relauncher error in Electron's log, no leftover `--type=relauncher` process.
- Host: new Tauri main, supervisor and sidecar show `NoNewPrivs: 0`; in-session deb self-update and Ollama remedies prompt through polkit.
- Container: NNP=1 path produces the "quit and reopen" message, never "refused".
- No AppImage regression: `AppImage self-update relaunch: PASS` row still holds (direct spawn path untouched for NNP=0 sessions).

## Assumptions

- The released 0.9.16 deb binary matches `v0.9.16` sources read here (`git show v0.9.16:src/main/updater.ts` matches HEAD; no updater changes after the tag). Confidence: high.
- Electron 44.4.5's relauncher is the one summarised above (fetched from the `v44.4.5` tag). Confidence: high.
- Ubuntu 24.04 is the floor (memory: Linux build floor 24.04), so systemd ≥ 255 and kernel ≥ 6.8 are available for `ExitType=cgroup` and `pidfd_open`. Confidence: high. A non-systemd desktop silently takes the fallback.
- `systemd-run --user` works from a process with NNP=1 (it is only a D-Bus client of the manager's private socket) and the resulting service can use `pkexec` via polkit's display-session fallback. Confidence: medium-high; verified from polkit source and the GNOME app-scope precedent, not yet by running it here. What would flip it: a host run where `pkexec` from the `systemd-run` child reports "no authentication agent"; then fall back to the "quit and reopen" message only and drop the systemd route.
- The deb-handover population is small and recent (0.9.15/0.9.16 Linux debs). Confidence: medium; the bridge-release verdict does not depend on it.
- Nothing in Tauri's `lib.rs` relies on `argv[0]` being `/usr/bin/sai-atlas` (the compat link gives `/opt/Sai ATLAS/sai-atlas`); `paths::bundled_omp_candidates` uses `/proc/self/exe` per the deb-finalize memory. Confidence: medium-high; relaunching `current_exe()` with no args sidesteps it anyway.

Status: DONE_WITH_CONCERNS
Summary: Implement Electron's relauncher protocol in the Tauri binary and launch the real instance through `systemd-run --user` (fallback: direct spawn), add `NoNewPrivs` detection to every pkexec caller, and treat the onboarding reappearance as expected; no bridge release. Concerns: the AppImage handover PASS was obtained on a non-production code path and must be re-run, and the `systemd-run` route can only be verified on the host, not in the container.
