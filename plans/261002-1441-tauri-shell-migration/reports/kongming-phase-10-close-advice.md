# Kongming advice: closing Phase 10 and presenting Task 10.6

Date: 2026-10-05 (Asia/Seoul). Scope: Phase 10 of `plans/261002-1441-tauri-shell-migration`, evidence at `tauri/integration` `ae1d96e` (worktree `/home/tung491/WORK/worktrees/tauri-integration`). Advisory only; nothing here was applied.

## TL;DR

GO: mark Phase 10 done except for the single host sitting, and present Task 10.6 now. Nothing in concerns 1–3 or the parity follow-ups blocks the decision; two of them are small enough to batch into Phase 11 before the tag, the rest are documentation. Two bookkeeping defects should be fixed today because they are Phase 10's own gates: the Task 10.5 verify grep prints `2`, not `3` (the AppImage PASS line in `reports/parity-report.md:75` carries a suffix), and the plan's Outcome and acceptance bullets still state the waived ≤ 60 % footprint gate as if it were in force. My recommendation for 10.6 is to cut over Linux in 0.9.17, conditional on one real-desktop sitting (dictation in the `.deb`, GNOME Wayland window size, the `.deb` handover's `systemd-run` route) passing before Task 11.4; ship the AppImage waiter plus the release-note safety net; no bridge Electron release.

## Reframed problem

The decision is not "is the Tauri shell perfect" but "is the remaining risk of shipping Linux on Tauri in 0.9.17 lower than, or at least priced below, the cost of holding". Requirements that still bind: the user's own rule that dictation must work in the Tauri build before Linux switches (Validation Log, 2026-10-02), the Phase 11 precondition of 7 days after v0.9.15 (earliest 2026-10-09), the protected host baseline, and the release flow in `AGENTS.md`. Non-goals: the ≤ 60 % footprint (waived 2026-10-04), macOS and Windows (Phase 12). The real question for A is which items change the decision's inputs (none) versus which must land before a tag (a short list).

## A. Is Phase 10 complete?

### Verified state

- Every automated Task 10.x gate holds on `ae1d96e` per the Validation Log, and I re-ran the cheap ones: `grep -rnE "todo!\(|unimplemented!\(|not_ported\(" src-tauri/src | grep -v "fn not_ported("` prints nothing; the visual pass has `0` FAIL rows.
- **Task 10.5's verify command fails on formatting.** `grep -cE "^((AppImage|deb) handover|Tauri self-update relaunch): PASS$" reports/parity-report.md` prints `2`. Line 75 reads `AppImage handover: PASS (production path, final bundles at ae1d96e, 2026-10-05)`, so `PASS$` does not match. Fix today: make that line exactly `AppImage handover: PASS` and move the qualifier to the next line. This is the phase's own exit check and must print `3` before the phase is marked done.
- **Plan text still carries the un-waived gate.** `plan.md:18` (Outcome) and the acceptance bullet at `plan.md:112` say ≤ 60 %. The Validation Log records the waiver, but plans are stateful records; amend both bullets to "≤ 60 % — waived by the user 2026-10-04; measured 72–75 % idle, total memory lower in every row". Also tick the acceptance boxes that the evidence now satisfies and leave the dictation clause open.
- **Acceptance criterion 1 (dictation PASS in the visual pass) is PENDING-USER**, so Phase 10 cannot be closed as fully accepted. Record it as "done pending the host sitting", which is honest and does not delay 10.6.
- v0.9.15 and v0.9.16 differ only in the `package.json` version line (`git diff v0.9.15 v0.9.16 -- package.json` is one line; Electron 44.4.5 and electron-updater ^6.8.9 on both). The handover was proven from 0.9.16 only; the mechanism (Chromium relauncher, `no_new_privs`, electron-updater's `quitAndInstall`) is identical on 0.9.15, so installs still on 0.9.15 take the same path. Write that sentence into the Validation Log so nobody asks later.

### Disposition of the three new concerns

| # | Concern | Severity | When | Fix shape |
|---|---|---|---|---|
| 1 | Tauri aborts at startup ("Failed to fully launch dbus-proxy") when `XDG_RUNTIME_DIR` is unset or outside `/run/user/<uid>` | Low | Document in Phase 11 (README Linux requirements); optional hardening | Reproduced by controls A/B/D in `final-appimage/RESULT.txt` with plain launches, so it is WebKitGTK's sandbox launcher, not the handover. Every logind desktop session sets `XDG_RUNTIME_DIR=/run/user/<uid>`; the failing shapes are `ssh`/`su`/cron/containers, which are not this product's audience. If you harden: in `main.rs` before GTK init, when the variable is unset or not under `/run/user/<uid>` and `/run/user/<uid>` exists, is owned by the uid and is mode 0700, set it and log one line; otherwise leave it and let WebKit fail as today. Pure helper, unit-testable. Never respond by disabling the sandbox. The claim "Electron starts there" is unverified; do not put it in release notes. |
| 2 | `systemctl --user stop` of the handover unit (and so logout) SIGTERMs the AppImage FUSE runtime with the app; the app dies with SIGBUS | Low–medium | Phase 11, before the tag; verify in the host sitting | Generic to any AppImage whose FUSE runtime shares a cgroup with the app under `KillMode=control-group`; GNOME launches apps into `app-*.scope` units with the same default, so a desktop-launched Electron AppImage very likely dies the same way at logout (belief, one-command check below). Exposure is one session per AppImage user, and state is already on disk (`persist_window_state` runs on window events, `desktop/lifecycle.rs:28`, `desktop/windows.rs:693`). Cheap fix: add `-p KillMode=mixed -p TimeoutStopSec=15` to `systemd_run_args` (`relaunch.rs:398`) and update the args test at `relaunch.rs:840`. The unit's main PID is `sai-atlas` itself (the runtime execs AppRun in place; the FUSE server is its forked child), so `mixed` SIGTERMs only the app, which runs its seven-step shutdown; the FUSE child exits on keepalive EOF; stragglers get SIGKILL at 15 s. Verify on the host: `systemctl --user stop app-vn.io.vif.saiatlas@handover….service` then `journalctl --user -u <unit>` shows `status=0/SUCCESS` and the runtime log has `shutdown finished`. Control for genericity: `systemd-run --user --scope ./Sai-ATLAS-0.9.16-x86_64.AppImage`, then stop the scope and look for `7/BUS`. |
| 3 | Helper and install-child runtime-log lines report crate version 0.9.15 | Cosmetic | Phase 11 Task 11.4 step 2 (already planned) plus a guard | `runtime_log::global()` falls back to `env!("CARGO_PKG_VERSION")` (`runtime_log.rs:238`); `src-tauri/Cargo.toml:3` is `0.9.15`. Bump it with `package.json` at release time, and add one assertion to `scripts/tauri-packaging-config.test.ts`: Cargo.toml `version` equals package.json `version`, so the bump cannot be skipped again. `Cargo.lock` changes by one line. Do not add a second version source through `build.rs`. |

### Disposition of the existing follow-ups

| Item | Severity | When | Fix shape |
|---|---|---|---|
| `omp://` registration fails when `~/.local/share/applications` is missing | Medium (fresh accounts lose deep links silently) | Phase 11, before the tag | `create_dir_all` on the applications directory before writing `sai-atlas-handler.desktop`; unit test with a tempdir `XDG_DATA_HOME` lacking `applications/`. Re-run the packaged smoke's `omp://` case with such a profile. |
| Update re-downloads after the "quit and reopen" message | Low (fallback route only; 180 MB once) | Document now, backlog | Later: remember the verified package path and digest and reuse it when the digest still matches the feed. |
| `.deb` `Depends` lists `libwebkit2gtk-4.1-0` and `libayatana-appindicator3-1` twice | Cosmetic | Phase 11 | Remove the two entries at `src-tauri/tauri.linux.conf.json:15-16`; tauri-bundler adds them itself. Verify with `dpkg-deb -f <deb> Depends`. |
| AppImage `GST_PLUGIN_SYSTEM_PATH_1_0` points at a missing directory; dictation capture fails in the AppImage | Medium for AppImage users, none for the `.deb` | Phase 11, decide after the host mic test | The AppDir bundles `libgstreamer-1.0.so.0` and nine `libgst*` libraries but no plugins. Do not point the bundled core at host plugins (ABI mix). Either stop bundling the `libgst*` libraries and drop the export so the host GStreamer loads, with README host requirements `gstreamer1.0-plugins-good gstreamer1.0-pipewire` (the same the `.deb` depends on), or release-note "dictation needs the .deb". Try the first; the second is the fallback. |
| Sandbox starts then fails: WebKit aborts instead of exit 70 | Low (fails closed) | Backlog (Phase 12) | Extend the pre-check with a `bwrap` dry run (`bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev true`) and exit 70 with the message on failure. |
| CI foundation module gate fails by design on the cross-module branch | Medium (CI must be green on `main` before a tag) | Phase 11 Task 11.2 | `ci.yml:81` runs `check-module.sh foundation` against the merge-base with `origin/main`. After the cutover merge, replace it with `check-test-parity.ts` for every module plus clippy, or run it only for pull requests whose base is a `tauri/*` wave branch. |

## B. The Task 10.6 presentation

**Recommendation: cut over Linux in the next release (0.9.17), with conditions.** Every automated gate is green; the handover is now better than the Electron baseline (every Electron→Electron AppImage update since 0.9.15 failed to relaunch, and the Tauri path fixes it); rollback is cheap and rehearsed in Phase 11's Rollback section (`pre-tauri-linux` tag, shared feed and profile). Holding gains nothing, because every remaining unknown is observable only on the real desktop, and that is a 45-minute sitting, not a hold. The footprint miss is real and disappointing against the stated goal, but the user has waived it with full-protocol evidence, and total memory is lower in every row.

Conditions, all in one host sitting before Task 11.4, in this order:

1. Dictation in the installed `.deb` (a transcript arrives, sandbox on). This is the user's own cutover blocker; a FAIL means hold and fix.
2. GNOME Wayland window size, three launches, with the script in `parity-report.md:188-192`. A FAIL is a Failure Protocol fix and re-run, not a hold.
3. `.deb` handover on the host from installed 0.9.16: `systemd-run` route taken, `NoNewPrivs 0` on the new main, and the next self-update prompts `pkexec` in the same session. A FAIL here is the only outcome that could call for a bridge release (see below).
4. Tray menu, Wayland chord while another app has focus, notifications, on the release build. Re-verifications of the 2026-10-03 debug-build session; failures are Phase 11 fixes.
5. The KillMode check from concern 2, if the fix is taken.

Treat the PENDING-USER items as blocking for the release, not for the decision. Only item 1 is blocking by the user's rule; items 2 and 3 are blocking by my judgment because their defect classes were found late and only ever ran under X11 harnesses.

**AppImage: ship both.** The waiter scheduler is proven on the `systemd-run` and direct routes with the host's real user manager, and install-on-quit stays closed. Keep the release-note line: "If Sai ATLAS does not reopen by itself after the update, start the new `.AppImage` once by hand; its file name now carries 0.9.17." Add the AppImage host requirement `libwebkit2gtk-4.1-0` (and the GStreamer plugins if the dictation fix lands).

**Bridge release: not needed.** The fixes live on the receiving side (`electron_relauncher.rs` plays Chromium's protocol; `appimage_handover.rs` schedules the waiter), so no Electron change is required, and 0.9.15 and 0.9.16 are the same Electron. A bridge would cost a release cycle and another 7-day wait and would test the same thing. Reconsider only if host item 3 shows electron-updater's `app.relaunch()` must be suppressed on the Electron side.

**Rollout order:** install 0.9.17 on the maintainer host from the real feed first (the protected baseline becomes the first production handover), then hand out.

## C. Risks of misreading the evidence

1. **No post-fix build has run on a real compositor with a geometry assertion.** All window-size evidence is Xvfb without a WM, openbox on Xvfb, or headless weston without a size check; the 2026-10-03 GNOME session predates `baea5a6`. The decoration measurement at first configure is WM-dependent (Mutter plus GTK3 client-side decorations is a different outer/inner relationship). That is why item 2 above is blocking.
2. **The `.deb` `systemd-run` success route has never run anywhere.** `launch_detached` was proven with the real manager only for the AppImage waiter (`/bin/sh`). The helper's D-Bus call is unaffected by `no_new_privs`, so the residual is low, but it is unproven.
3. **Every handover seeded empty sessions.** Both tabs restored, but "restored tabs get new or null sessionPaths" (`deb-handover/run3/RESULT.txt`). Real users have populated sessions. Cheap container addition: seed one tab with a message before the handover and assert it is visible afterwards.
4. **The LevelDB import never ran in a handover.** 0.9.16 mirrors to `prefs.json`, so the import path was skipped every time. Users hand-given 0.9.17 from a pre-0.9.15 build hit it. Cheap test: delete `rendererStorage` from a 0.9.16 profile's `prefs.json`, start Tauri, confirm language and theme return.
5. **Every handover used `provider: generic` on localhost.** Production 0.9.16 uses electron-updater's GitHub provider; that path is proven only by the 0.9.15→0.9.16 host update. Prereleases are ignored by both updaters, so Task 11.4 is the first live run. Mitigation: create the release as a draft, upload every asset including the yml, then publish; a partial asset set breaks the Tauri updater's `latest/download` fetch.
6. **The virtual display hides the session environment.** On the `systemd-run` route the relaunched app inherits the user manager's environment, not Electron's (RESULT.txt N1). In production that is right, but any `GDK_BACKEND=x11`-style workaround a user exported in a shell is lost for that first session; say so where the README gives that advice.
7. **Reassurance, not a risk:** the 0.9.17 `.deb` tree did render on the real GNOME 50 Wayland desktop at 125 % during the footprint protocol (focus clicks, turns), so "blank window on NVIDIA Wayland" is excluded for the release build; only the window geometry after the fix is unseen.

## What to avoid

- Do not re-litigate the ≤ 60 % gate; record the waiver and move on.
- Do not fix concerns 1–3 and the follow-ups on `tauri/integration` today one at a time: each code change forces a bundle rebuild and a re-run of the handover harnesses. Batch them into Phase 11 with one rebuild and one regression pass (`deb-handover` run, `final-appimage` runs 1–4, packaged smoke, openbox geometry).
- Do not disable or weaken the WebKit sandbox to work around concern 1.
- Do not point the bundled GStreamer core at host plugins.
- Do not publish a release with a partial asset set.

## Work checklist

Today (bookkeeping, no code):
1. Reformat `reports/parity-report.md:75` so the Task 10.5 grep prints `3`.
2. Amend `plan.md` Outcome and acceptance bullets for the waived gate; tick satisfied boxes; add the 0.9.15/0.9.16 equivalence note; mark Phase 10 "done pending the host sitting".
3. Present Task 10.6 with: footprint table, visual pass (20 PASS, 4 PENDING-USER, 2 accepted), handover results, the conditions list above, and the recommendation.

Phase 11 before the tag (one batch, one rebuild, one regression pass):
4. `KillMode=mixed`, `TimeoutStopSec=15` in `relaunch.rs:398` plus the test.
5. `create_dir_all` for the handler `.desktop` directory plus a test.
6. Deduplicate `tauri.linux.conf.json` depends.
7. Cargo.toml version bump with the guard test.
8. GStreamer decision after the host mic test; README host requirements.
9. CI gate replacement in `ci.yml`.
10. Container additions from C3 and C4.

Host sitting (user present, ~45 min): items 1–5 of section B, plus the genericity control for concern 2.

## Success metrics

- Task 10.5 grep prints `3`; `plan.md` records the waiver and the decision.
- Host sitting: all five items PASS; `journalctl` shows a clean unit stop.
- Task 11.4 verify: the feed reads 0.9.17 and a baseline `.deb` install relaunches without user action; an AppImage install relaunches or needs at most the documented manual reopen.
- After release: no SIGBUS or relauncher hang reports; runtime logs carry 0.9.17; CI green on `main`.

## Assumptions

- Real users run under a logind session with `XDG_RUNTIME_DIR=/run/user/<uid>` (high).
- The SIGBUS at unit stop is generic to AppImages in a shared cgroup, including GNOME's `app-*.scope` (medium; one command on the host confirms; if it is specific to our unit, raise concern 2 to "fix before the tag" regardless of the host check).
- Electron 0.9.16 starts without `XDG_RUNTIME_DIR` (unverified; stated by the caller as presumption; not load-bearing).
- The unit's main PID is the app, so `KillMode=mixed` reaches the right process (high; from `final-appimage/RESULT.txt` run 1, "Main PID 2239713 (sai-atlas)").
- The handed-over `.deb` session is the only one that runs inside our unit; later launches use the desktop's own units (high).
- No evidence contradicts the 2026-10-03 PASS for tray and chord on the release build (medium; re-verify in the sitting).

Runtime note: this run executed on Claude Fable 5.1, as the protocol expects.

Status: DONE_WITH_CONCERNS
Summary: Phase 10 is GO to present Task 10.6 once two bookkeeping defects are fixed (the Task 10.5 grep prints 2 because of a line suffix; the plan still states the waived gate). Recommend cutting over Linux in 0.9.17 conditional on one host sitting (dictation in the `.deb`, GNOME Wayland window size, `.deb` `systemd-run` handover); batch the small fixes (KillMode=mixed, handler-dir creation, depends dedupe, version guard, GStreamer decision, CI gate) into Phase 11; ship the AppImage waiter plus release-note safety net; no bridge release.
