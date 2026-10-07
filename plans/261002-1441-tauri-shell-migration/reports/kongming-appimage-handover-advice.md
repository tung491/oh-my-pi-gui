# Kongming advice: Electron 0.9.16 → Tauri AppImage handover (Task 10.5 step 3, production path FAIL)

Date: 2026-10-05 (Asia/Seoul). Advisory only; no project files changed. Runtime: Claude Code on `fable`.

## TL;DR

The relaunch dies for one proven, sufficient reason: Electron's `app.relaunch()` helper is started with `PR_SET_NO_NEW_PRIVS`, the flag is inherited by the new `.AppImage`, the setuid `fusermount3` cannot mount it, and the type-2 runtime exits 127 before any Tauri code runs. I reproduced exactly that on this host with `setpriv --no-new-privs` against both the 0.9.17 Tauri image and the 0.9.16 Electron image (same exit, same message, no extraction fallback). The "helper dies with the old mount" hypothesis is unproven and unnecessary; it changes nothing about the fix. Every 0.9.x Electron→Electron AppImage update had the same defect since v0.9.15.

Build the Tauri-side install-child scheduler, with one change to the idea as posed: the install child must not decide to relaunch by itself (the install-on-quit path hands it an identical environment), so it starts a host `/bin/sh` waiter that relaunches only if it sees Electron spawn its `--type=relauncher` helper before exiting. Reuse `relaunch::launch_detached` (systemd-run route with direct fallback, env scrub, fd close) and add an `args` parameter to it. Do not ship a bridge release. Keep the "if Sai ATLAS does not reopen, start the new file once by hand" release note as the safety net.

## Reframed problem

What is actually being decided: how a 0.9.16 AppImage install becomes a running Tauri app after "Restart & install", given that the only code we can still change is the new Tauri binary (which electron-updater runs once as an install child with NNP=0) and the user's deliberate quit must stay a quit.

Requirements: exactly one Tauri instance after the handover; it runs with `NoNewPrivs: 0` (pkexec paths work); no stale mounts; settings intact; install-on-quit does not reopen the app; a failing scheduler degrades to today's behaviour (file replaced, manual reopen), never worse.

Non-goals: fixing 0.9.16; fixing Electron→Electron AppImage updates retroactively; the deb path (already handled by `electron_relauncher.rs`).

## Verified evidence (what each claim rests on)

| Claim | Source |
|---|---|
| Electron's relaunch helper runs with NNP=1 | Chromium `base/process/launch.h`: "By default, child processes will have the PR_SET_NO_NEW_PRIVS bit set. If true [allow_new_privs], then this bit will not be set"; `relauncher.cc` `RelaunchAppWithHelper` uses a default `LaunchOptions`. Empirically confirmed on the deb handover (pkexec "must be setuid root", 127). |
| `allow_new_privs = true` in the helper's `LaunchProgram` does not help | Electron v44.4.5 `relauncher_linux.cc` sets it, but NNP is inherited and cannot be cleared; the helper already has it. |
| The relaunched program's stdout and stderr go to `/dev/null` | `relauncher_linux.cc` `LaunchProgram`: `fds_to_remap` devnull → `STDERR_FILENO` and `STDOUT_FILENO`. So app.log's silence after "Quitting application." is expected, not evidence that the runtime never ran. |
| An AppImage under NNP exits 127 before any app code, no fallback | Probe on this host: `setpriv --no-new-privs feed-0.9.17/Sai-ATLAS-0.9.17-x86_64.AppImage` (with `APPIMAGE_EXIT_AFTER_INSTALL=true`) → exit 127, "fusermount3: mount failed: Operation not permitted", "Cannot mount AppImage, please check your FUSE setup"; control without NNP → exit 0. Same for `dist/Sai-ATLAS-0.9.16-x86_64.AppImage --version`. |
| The fusermount3 AppArmor audit cannot see the failed attempt | My two NNP probes left zero `profile="fusermount3"` audit lines; only the two privileged controls did (mount + unmount groups at 01:10:04.951/05.066 and 01:13:02.833/03.187). Unprivileged fusermount3 fails at `capable()` before the LSM hook. So the "no further fusermount3 call" line in RESULT.txt does not distinguish the hypotheses. |
| Helper waits via `PR_SET_PDEATHSIG` (SIGUSR2) then execs the target | `relauncher_linux.cc` `RelauncherSynchronizeWithParent`. |
| 0.9.16 code path | `src/main/updater.ts:224` `autoInstallOnAppQuit = installsOnQuit(installMode, linuxKind)`; `updater-state.ts:185-187` returns `mode === "automatic" && kind !== "deb"`; `updater.ts:84-85` `detectInstallMode()` returns `"automatic"` on every non-darwin platform. So **every Linux AppImage install has install-on-quit enabled.** `updater.ts:229` `autoRunAppAfterInstall = false`; `:230-232` stores `appImageTarget`; `:367` `app.relaunch({ execPath: appImageTarget, args: [] })`. |
| electron-updater 6.8.9 | `BaseUpdater.js` `quitAndInstall` → `install(false, this.autoRunAppAfterInstall /* false */)`; `addQuitHandler` → `install(true, false)`. Both reach `AppImageUpdater.doInstall` with `isForceRunAfter: false` → `env = {...process.env, APPIMAGE_SILENT_INSTALL: "true", APPIMAGE_EXIT_AFTER_INSTALL: "true"}`; `execFileSync(destination, [], { env })`. **The two paths are byte-identical from the install child's point of view.** |
| Since when | `git log -S"autoRunAppAfterInstall"` → `e0a214f` "fix(updater): relaunch an updated AppImage after the old one quits", first tag v0.9.15, the first Linux release (CHANGELOG 0.9.15: "Linux x64 packages", "AppImage updates: … starts the new version once the old one has quit"). |
| Tauri side today | `main.rs:32-34` returns `SUCCESS` on `APPIMAGE_EXIT_AFTER_INSTALL=true` before any init. `relaunch.rs:302` `launch_detached(program, env, old_appdir, cwd, purpose)` takes no args; `:63-83` `INHERITED_LAUNCH_ENV` already drops `GDK_BACKEND`, `FC_FONTATIONS`, `CHROME_*`, `APPIMAGE_*_INSTALL`, `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD`, startup tokens; `:120` `scrub_env` takes one `old_appdir`; `:206-212` `close_range(…, CLOSE_RANGE_CLOEXEC)`; `:353-368` systemd-run args (`Type=exec`, `ExitType=cgroup`, `--collect`, `--setenv=NAME`); `:278` 10 s systemd-run cap. `lib.rs:444-450` single-instance plugin; `desktop/deep_link.rs:191-195` second instance with no args → `Focus`. `electron_relauncher.rs:96-97` is the pattern to copy (`relaunch_cwd` + `launch_detached(…, "handover")`). |
| Install child environment (evidence) | `environ/1788993.txt`: `APPIMAGE=<new versioned path>`, `APPDIR=/tmp/.mount_Sai-ATGlNNdi` (its own mount), `APPIMAGE_EXIT_AFTER_INSTALL=true`, `APPIMAGE_SILENT_INSTALL=true`, `GDK_BACKEND=x11`, `CHROME_DESKTOP`, `FC_FONTATIONS=1`, and old-mount components `/tmp/.mount_Sai-ATalkeHI` in `PATH` and `XDG_DATA_DIRS`. Parent (`ppid`) = Electron main, whose `/proc/<pid>/environ` is clobbered by Chromium's setproctitle (RESULT.txt) — do not read it. |

## A. Which hypothesis is right

**Hypothesis 1 (NNP → fusermount3 → runtime exit 127) is proven sufficient and matches every observation**, including the ones that looked like counter-evidence (silent app.log: stdout/stderr are `/dev/null`; silent audit: unprivileged fusermount3 never reaches the AppArmor hook; no relauncher seen by the 100 ms scan: the helper lives only for Electron's ~110 ms shutdown plus a ~50 ms failed mount). The three ecosystem reports say the same (dsh-desktop #1269 and t3code #4 both name `app.relaunch()` + NNP + fusermount; fd0.sh #20 reproduces 127 with `setpriv --no-new-privs`).

**Hypothesis 2 (helper SIGBUSes when the old mount vanishes) is unproven and not needed.** Even if the helper survives (likely: the pages it needs after wake-up were just used by the parent and sit in the page cache; a lazy unmount keeps them readable), the exec'd runtime fails under NNP anyway. Settling it would need `strace -f` on Electron or a 5 ms poller; it is a curiosity, not a decision input. Skip it unless the harness is already running at 5 ms for other reasons.

**Electron→Electron AppImage updates in 0.9.x do not relaunch today.** Same `app.relaunch({ execPath })` path since v0.9.15, and the 0.9.16 image exits 127 under NNP in my probe. The only such update that ever ran in the field was 0.9.15→0.9.16; the CHANGELOG claim for 0.9.15 was evidently verified on the extracted-`AppRun` path (`linuxPackageKind` = "other" → electron-updater's own Node spawn, NNP=0), the same non-production path as the provisional step-3 PASS.

## B. The install-child scheduler: sound, with one correction

**Verdict: sound and safe, provided the relaunch decision is moved out of the install child and into a waiter that observes Electron's intent.** The install child cannot answer (a) from env, args, timing or `isForceRunAfter`: both the quitAndInstall path and the install-on-quit path run `install(…, isForceRunAfter=false)` and hand the child an identical environment (`APPIMAGE_SILENT_INSTALL=true`, `APPIMAGE_EXIT_AFTER_INSTALL=true`). Install-on-quit is live for every Linux AppImage install (`detectInstallMode` is "automatic" off macOS), and it is a common path: download, keep working, quit at the end of the day. Always-relaunching would reopen the app after that deliberate quit.

The reliable intent signal is Electron's own relaunch helper. In the quitAndInstall path, `updater.ts:367` calls `app.relaunch(...)` synchronously right after `execFileSync` returns, which spawns a **direct child of the Electron main process** whose cmdline is `<old-mount>/sai-atlas --type=relauncher --no-sandbox --- <appImageTarget>` — it contains the new file's exact path. It exists from before Electron's shutdown until ~50-150 ms after Electron exits (wake on SIGUSR2, exec the runtime, runtime fails). In the install-on-quit path it never appears. A host `/bin/sh` loop polling the parent's children every 10 ms from ~5 ms after the install child starts catches it deterministically; a Rust waiter started from a third AppImage mount would not (mount takes ~100 ms, which is the whole window seen in `apply-timeline.txt`).

### Design

**1. Install-child mode (`main.rs`, inside the existing `APPIMAGE_EXIT_AFTER_INSTALL` branch, Linux only).** Preconditions, all cheap `/proc` reads, no GTK/Tauri init: `APPIMAGE` non-empty; `getppid() > 1`; `/proc/<ppid>/exe` readable (same uid). Do not insist that the parent is Electron — Tauri's own updater never sets this variable (grep: `updater/*.rs` never mention it; `relaunch.rs` only scrubs it), so any process started this way is electron-updater's install child; over-detection only costs a short-lived `sh`. Derive `old_appdir` from `/proc/<ppid>/exe` (walk up to the `.mount_*` component under `$TMPDIR`/`/tmp`), **not** from the parent's environ (clobbered). Then start the waiter and `return ExitCode::SUCCESS` unconditionally — Electron is blocked in `execFileSync` until this process exits, and any non-zero exit would make electron-updater dispatch an error after the file is already replaced. Log one runtime-log line ("handover: waiter scheduled, route = …") best-effort; the install child shares Electron's `XDG_CONFIG_HOME`, so `paths::runtime_log_path()` resolves the same profile.

**2. The waiter is a host program**: `/bin/sh -c '<script>' sh <electron_pid> <appimage_path> <appimage_basename>`. It must not be anything inside the install child's mount (gone ~100 ms later) nor the old Electron mount. POSIX sh, `kill -0`, `sleep 0.01` (GNU, uutils and busybox all accept fractions), `grep -qsF` on `/proc/<pid>/cmdline` (NUL bytes do not affect `-q`). Sketch:

```sh
pid=$1 img=$2 name=$3 helper=
children() { cat /proc/"$pid"/task/*/children 2>/dev/null || awk -v p="$pid" '$4==p{print $1}' /proc/[0-9]*/stat 2>/dev/null; }
find_helper() { for c in $(children); do
  grep -qsF -- '--type=relauncher' /proc/"$c"/cmdline && grep -qsF -- "$name" /proc/"$c"/cmdline && { helper=$c; return 0; }
done; return 1; }
while kill -0 "$pid" 2>/dev/null; do [ -n "$helper" ] || find_helper; sleep 0.01; done
[ -n "$helper" ] || exit 0                      # install-on-quit (or crash): the user quit; stay quit
n=0; while kill -0 "$helper" 2>/dev/null && [ "$n" -lt 300 ]; do sleep 0.01; n=$((n+1)); done
exec "$img"
```

`/proc/<pid>/task/*/children` needs `CONFIG_PROC_CHILDREN` (Ubuntu, Fedora, Arch, Debian all set it); the `awk` over `/proc/*/stat` is the fallback. Matching the basename rather than the full path tolerates realpath differences between the runtime's `APPIMAGE` and electron-updater's `destination`. The second loop lets Electron's own attempt finish first (it exits 127 within ~100 ms), capped at 3 s so a hypothetical successful Electron launch (see (b)) never blocks ours.

**3. Launch route: reuse `relaunch::launch_detached`** with a new `args: &[OsString]` parameter (today `relaunch.rs:302` takes only `program`; `systemd_run_args` appends `program` after `--`, so appending args is a two-line change, plus `relaunch_command`). `purpose = "handover"` (or a distinct `"appimagehandover"` if you want separate unit names in logs). Why systemd-run first even though NNP is not a problem on this path: the final app then lives in `app-vn.io.vif.saiatlas@handover….service`, so xdg-desktop-portal derives the right app id (the M1 fix in the deb review), and `ExitType=cgroup` keeps a later in-app relaunch alive; the direct fallback (`relaunch_command`: `close_range` CLOEXEC, scrubbed env, cwd outside the mount) is correct for hosts without a user manager. One cost to accept: Electron's UI is frozen while systemd-run answers (normally tens of ms; the 10 s cap at `relaunch.rs:278` is the worst case). Verify `relaunch_command` also starts a new session/process group (`setsid`) so a terminal-launched Electron's job control cannot take the waiter down; add it if missing.

**4. Environment (c).** `launch_env` already drops `GDK_BACKEND`, `CHROME_*`, `FC_FONTATIONS`, `APPIMAGE_*_INSTALL`, `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD` and the startup tokens — exactly the set seen in `environ/1788993.txt`. Two gaps: `scrub_env` takes a single `old_appdir`, but this environment carries components from **two** mounts (the install child's own `$APPDIR`, set by its runtime/AppRun: `PATH`, `LD_LIBRARY_PATH`, `GSETTINGS_SCHEMA_DIR`, `GTK_PATH`, `GIO_MODULE_DIR`, `GDK_PIXBUF_MODULE_FILE`, `PYTHONHOME`, …; and the old Electron mount in `PATH`/`XDG_DATA_DIRS`). Generalise to `scrub_env(env, &[appdirs])` and pass both (`$APPDIR` of this process and the mount root derived from `/proc/<ppid>/exe`). Whole-value variables that point into a mount (`GTK_PATH`, `PYTHONHOME`, `GDK_PIXBUF_MODULE_FILE`, …) are already dropped by the "no non-empty component left" rule. On the systemd-run route, unlisted variables come from the user manager (so a user-set `GDK_BACKEND` survives; Chromium's `x11` does not) and `DISPLAY`/`DBUS_SESSION_BUS_ADDRESS`/`XDG_*` pass through by name, which is what keeps the harness on `:99` with its private bus.

**5. Install child's mount lifetime (d).** Unchanged from today when done right: the systemd-run route inherits no fds at all; the direct route goes through `close_inherited_fds_on_exec`, so the waiter never holds the type-2 keepalive pipe, and the install child's mount is gone within ~100 ms of its exit (as in the evidence: unmount at +0.116 s). `exec "$img"` in the waiter then starts a fresh runtime from the on-disk file; the only mount alive afterwards is the new app's. Pass condition: exactly one `/tmp/.mount_Sai-AT*` after the handover.

**6. (b) If Electron's own relaunch ever succeeds.** On every system with setuid `fusermount3` and this runtime it cannot (probe: no extract-and-run fallback). It could only succeed if the user exports `APPIMAGE_EXTRACT_AND_RUN=1`, and then the resulting Tauri runs with NNP=1. The waiter's 3 s wait on the helper PID makes that instance start first; ours then arrives with no args, the single-instance plugin (`lib.rs:444-450`) turns it into `LaunchRequest::Focus` and exits it. Outcome in that rare case = today's deb-fallback outcome (reopen_required UX), never two instances. No new code needed beyond the bounded wait.

**7. Failure handling.** Waiter never spawned (no `/bin/sh`, systemd-run and direct both fail): log, exit 0 → today's behaviour (file replaced, manual reopen). Helper never seen (install-on-quit, Electron crash, `LaunchProcess` failure): waiter exits silently → file replaced, no relaunch, correct. Parent lingers (a vetoed quit cannot happen: `approveQuitBeforeInstall` sets `approved` before the install, `app-quit.ts:44-50`): the waiter simply keeps polling at 10 ms, same as Electron's helper does; PID reuse within that window is negligible (optional hardening: capture `/proc/<pid>/stat` starttime at start and compare). The waiter exits when the parent exits, so nothing is orphaned.

## What to avoid

- Deciding "relaunch" inside the install child from env/timing. The two electron-updater paths are indistinguishable there; you would reopen the app after every deliberate quit on Linux.
- A Rust waiter started from a third AppImage mount. Its ~100 ms mount time is the entire window in which the relauncher helper exists; it would miss the intent signal on fast shutdowns like the one in `apply-timeline.txt`.
- Keeping the waiter inside either mount, or spawning it without `close_range`: the keepalive pipe would pin the install child's mount for the life of the new app (the step-5 leak, again).
- Reading `/proc/<ppid>/environ` for the old `APPDIR` (clobbered by setproctitle). Use `/proc/<ppid>/exe`.
- A non-zero exit from the install child for any reason; electron-updater would surface an error after the file is already swapped.
- Treating the audit log or app.log silence as evidence in the re-run; both are blind to this failure by construction.
- A bridge Electron release (below).

## C. Alternatives and the user decision

1. **Bridge Electron release (0.9.17-electron) that relaunches correctly.** Rejected, same reason as for the deb: electron-updater always installs the newest release, so the bridge must stay newest until every 0.9.16 AppImage has updated, which delays the Tauri cutover indefinitely and still cannot be enforced (a 0.9.16 that first checks after the Tauri release jumps straight to Tauri). It is also a full multi-platform release for a Linux-AppImage-only benefit.
2. **Accept a one-time manual reopen, release-note wording only.** Zero code, but weaker than it looks: the installed file has a new name (`Sai-ATLAS-0.9.17-x86_64.AppImage`), so launchers and the 0.9.16 `omp://` handler `.desktop` point at a deleted file until Tauri's first start re-registers them; users must find the new file. Suggested wording if chosen (and as the safety-net sentence even if the fix ships): "AppImage: after 'Restart & install' Sai ATLAS may not reopen by itself. Start the new file `Sai-ATLAS-<version>-x86_64.AppImage` in the same folder once; later updates restart automatically."
3. **Always-relaunch waiter (no intent detection).** Smaller script; cost is reopening after a deliberate quit for every Linux AppImage user who downloaded and quit. Keep only as the fallback if the harness shows the helper sighting to be flaky (it should not be).

**Which is a user decision:** whether to invest ~half a day plus a harness re-run in the scheduler before the Tauri release, or ship with option 2. My recommendation is the scheduler: it is the only route that gives the first Tauri start right away (and so the handler re-registration), it runs the handed-over session with NNP=0 (better than the deb route's fallback), it reuses primitives already verified for the deb, and its failure mode is option 2. Evidence that would flip it: the harness re-run showing the helper is spawned too late to be seen on a slow machine, or a decision to postpone the Tauri release anyway.

## D. Verification plan (reuse `handover-evidence/step3-real`)

Harness changes: run `apply-monitor.py` at 5 ms; additionally snapshot `/proc/<electron>/task/*/children` with cmdlines each tick so the `--type=relauncher` sighting and the waiter's `sh` are recorded; keep the `GDK_BACKEND=x11,wayland` sentinel and the kernel-audit capture (now as a mount counter only).

Run 1 — Restart & install (production path, real `.AppImage` file, virtual display, isolated profile), expected:
- app.log: `Install: isSilent: false, isForceRunAfter: false`; the install child seen with NNP=0 and gone before Electron.
- Within ~20 ms of the install child: `sh … <electron_pid> <new path> <basename>` alive, ppid = install child then reparented (direct route) or in unit `app-vn.io.vif.saiatlas@handover*.service` (`systemctl --user list-units`); runtime log has the "waiter scheduled, route" line.
- A `--type=relauncher` child of Electron whose cmdline contains the new path, alive before Electron exits; gone within 1 s after (optionally its exit 127 if traced).
- Electron, its omp children, its mount and the install child's mount gone within 10 s (2b).
- Exactly one new `sai-atlas` + supervisor + sidecar within 10 s of Electron's exit (2d/2e); `NoNewPrivs: 0`; `/proc/<pid>/environ` has no `APPIMAGE_EXIT_AFTER_INSTALL`/`APPIMAGE_SILENT_INSTALL`, no `/tmp/.mount_Sai-ATalkeHI` or install-child-mount components, `GDK_BACKEND` absent or `x11,wayland` (never `x11`), `APPDIR` = the new app's mount; exactly one `/tmp/.mount_Sai-AT*`; `PWD` not under any mount.
- prefs.post-apply == prefs.pre-apply (language vi, 2 tabs); sidecar `Ready`.
- Step 3 NNP remedy demo now runs (pkexec path works) — record it.

Run 2 — install-on-quit: seed, download, then quit through the window (approve the working-tabs prompt). Expected: app.log `Auto install update on quit` + `Install: isSilent: true, isForceRunAfter: false`; file replaced; waiter present then gone within ~1 s of Electron; no `--type=relauncher`; **no** Tauri process, zero mounts, no handover unit left.

Run 3 — regression: Tauri AppImage self-update relaunch (step 5c) still PASS with the keepalive/mount checks; deb handover unchanged.

Unit tests (Rust): `launch_detached` with args (fake `systemd-run` on PATH dumping argv proves `-- /bin/sh -c <script> sh …` ordering); `scrub_env` over two appdirs; parent-exe → mount-root derivation; install-child preconditions. Shell-script test (integration, no GTK): fake parent `sleep 2`, fake helper `sh -c 'sleep 1' sh --type=relauncher --- /x/Name.AppImage` as its child, `img` = a script that touches a marker → marker appears after the parent exits; same without the fake helper → no marker, waiter exits.

Host vs container: the systemd-run route is host-only (as for the deb); the container smoke exercises the direct fallback. Record both in the parity report (replace the provisional AppImage handover row with FAIL-then-PASS and the route used).

## Work checklist

1. `relaunch.rs`: add `args` to `launch_detached`/`launch_detached_with`/`systemd_run_args`/`relaunch_command`; generalise `scrub_env` to a slice of appdirs; confirm `setsid`/new process group in the direct route.
2. New small module (e.g. `appimage_handover.rs`, next to `electron_relauncher.rs`): preconditions, mount-root from `/proc/<ppid>/exe`, waiter script constant, `schedule()` returning the route for the log; called from `main.rs` in the `APPIMAGE_EXIT_AFTER_INSTALL` branch, Linux only, always followed by `SUCCESS`.
3. Tests as in D; `cargo test`, `bunx vitest run`, `check:types`, biome on touched files.
4. Rebuild the 0.9.17 Tauri AppImage in the 24.04 container; re-run steps 3 (runs 1 and 2) and 5c on the host with the extended harness; attach RESULT files.
5. Parity report + phase 10.5 file: AppImage handover row (production path FAIL on 2c0d840, PASS after fix, route), note that the 0.9.15/0.9.16 Electron relaunch never worked; release notes for the first Tauri release: automatic restart plus the one-line safety net from C.2.

## Success metrics

- Run 1: 2a–2g all PASS with one instance, NNP=0, one mount, scrubbed env, intact prefs. Run 2: file replaced, nothing reopened, nothing left running. Run 3 unchanged.
- No handover-related "did not reopen" reports after the first Tauri release from AppImage users; no "app came back after I quit" reports.

## Assumptions

- The relaunch helper is a direct child of the Electron **main** process (`app.relaunch` runs in the browser process; `base::LaunchProcess` forks from it). High confidence; the children-file approach depends on it, the `/proc/*/stat` fallback does not.
- `CONFIG_PROC_CHILDREN` is enabled on target distros (Ubuntu 24.04+, Fedora, Arch, Debian). High confidence; the fallback covers the rest.
- Electron's shutdown after the install child lasts at least ~50 ms on target machines (it was ~110 ms here), so a 10 ms poll started ~5 ms after the install child sees the helper. Medium-high confidence; the harness re-run measures it. If it were ever too short, the always-relaunch fallback (C.3) is the escape hatch.
- The `APPIMAGE` seen by the install child and electron-updater's `destination` share the basename. High confidence (same `dirname`, same `basename(installerPath)`).
- No distro the product targets ships a type-2 runtime with automatic extract-and-run fallback; Tauri's bundled runtime does not (probe). High confidence for the shipped image, since the runtime travels inside it.
- Hypothesis 2 is irrelevant to the fix even if true. High confidence (the intent signal is the helper's existence before Electron exits; the launch does not depend on the helper).

Status: DONE_WITH_CONCERNS
Summary: The AppImage handover fails because Electron's relaunch helper inherits no_new_privs and the new image's setuid fusermount3 cannot mount (reproduced on both images, exit 127; the 0.9.x Electron→Electron AppImage relaunch never worked either). Implement the Tauri install-child scheduler, but let a host /bin/sh waiter decide: relaunch only after Electron has spawned its `--type=relauncher` helper, since the install-on-quit path is otherwise indistinguishable; reuse `launch_detached` (with args), scrub both mounts, no bridge release. Concerns: the helper-sighting window is ~100 ms and must be confirmed on the re-run; the systemd-run route can only be verified on the host; shipping without the fix means a renamed file and a manual reopen for every 0.9.16 AppImage user.
