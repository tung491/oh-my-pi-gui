# Linux parity report — Tauri 0.9.17 vs Electron 0.9.16

Stage C evidence for Phase 10 Task 10.5, gathered 2026-10-04 on the maintainer host (Ubuntu 26.04.1, GNOME 50 Wayland at 125 % fractional scale on 3840×2560, NVIDIA RTX 5080 driver 595, WebKitGTK 2.52.6). The decision itself belongs to Task 10.6.

## Footprint

**Verdict: FAIL against the S2 gate (Tauri shell ≤ 60 % of the Electron shell, 1 tab, idle) — gate waived by the user on 2026-10-04.** The Tauri shell is 72–75 % of Electron's at idle, 66 % after a turn, and about equal at the peak of a turn. Total memory (shell + sidecar) is lower with Tauri in every row. The user chose to bypass S2 after seeing these numbers; the footprint no longer blocks the cutover decision in Task 10.6.

### Method

- Electron: the released 0.9.16 AppImage (the build the installed population runs). Tauri: the 0.9.17 release `.deb` unpacked with `dpkg-deb -x`, so system WebKit and the bundled sidecar, sandbox on.
- Each launch uses a fresh throwaway profile seeded only with `language`, `providers` and `welcome` from the real prefs, a copy of the agent dir without sessions, the real sidecar and the same local model (Gemma 4 E2B through Ollama). The prompt is "Write a 300-word story about a lighthouse keeper."
- PSS from `/proc/<pid>/smaps_rollup`, summed over the root process's whole tree. A process whose executable is `omp`, or any descendant of one, is sidecar; everything else is shell: supervisor, WebKit web and network processes, `bwrap`, `xdg-dbus-proxy`, Electron's GPU, renderer, utility and zygote processes. The AppImage runtime process is outside the tree on both sides.
- Rows: unfocused idle (launch, 60 s settle, 60 s at 5 s), focused idle (one click on the title bar, 60 s settle, 60 s at 5 s), turn (1 s samples until the reply ends; maximum reported), post-turn idle (60 s settle, 60 s at 5 s). Three launches for the idle rows, one turn per shell.
- Scripts and raw data: `worktrees/stage-c/` (`fp-run.sh`, `pss.sh`, `fp-evidence.sh`, `samples.csv`, per-window breakdowns in `fp-rows/`).

### Results at 125 % scale (median of launch medians, shell PSS)

| Row | Electron | Tauri | Ratio |
|---|---|---|---|
| 1 tab, unfocused idle (3 launches) | 368.1 MB (366.5 / 368.1 / 396.8) | 277.5 MB (272.8 / 284.4 / 277.5) | 75.4 % |
| 1 tab, focused idle (3 launches) | 377.3 MB (376.1 / 377.3 / 417.7) | 271.6 MB (271.6 / 279.7 / 270.4) | 72.0 % |
| 1 tab, turn (maximum) | 442.1 MB | 446.8 MB | 101 % |
| 1 tab, post-turn idle | 432.9 MB | 286.3 MB | 66.1 % |

Total (shell + sidecar), 1 tab: unfocused idle 734.0 vs 657.3 MB, post-turn idle 785.7 vs 583.6 MB.

The first, single-launch pass also measured 3 tabs (one sidecar per tab):

| Row | Electron shell | Tauri shell | Ratio | Electron total | Tauri total |
|---|---|---|---|---|---|
| 1 tab idle | 400.9 MB | 304.5 MB | 76.0 % | 760.6 MB | 664.9 MB |
| 1 tab turn (median / max) | 429.8 / 438.0 MB | 420.0 / 523.8 MB | 98 % | 788.4 MB | 728.0 MB |
| 3 tabs idle | 433.8 MB | 375.8 MB | 86.6 % | 1268.6 MB | 1242.9 MB |
| 3 tabs turn (median / max) | 442.4 / 454.7 MB | 383.2 / 553.7 MB | 86.6 % | 1256.2 MB | 1232.0 MB |

The first pass's Tauri turn was the session's second turn (Electron's was its first), and its idle samples were not controlled for window focus; the protocol rows above supersede its 1-tab numbers.

### Integer scale (virtual display, X11, software GL, one launch each)

| Row | Electron | Tauri | Ratio |
|---|---|---|---|
| idle, scale 1 | 305.0 MB | 278.5 MB | 91 % |

Without a GPU, Electron's GPU process shrinks and the WebKit processes do not, so the fractional-scale penalty of GTK3 (buffer scale 2 against Chromium's 1.25) does not explain the gap. The desktop display scale was not changed because the run finished unattended.

### Where the Tauri shell's memory goes (1 tab, focused idle)

- WebKit web process ≈ 153 MB; it holds its own NVIDIA GPU context (51 driver mappings) next to the main process's (77).
- Main process 131–213 MB, 65 threads (the tokio pool), including a 42 MB `memfd:gdk-wayland` pool of window buffers.
- WebKit network process ≈ 17 MB; supervisor ≈ 11 MB (the spike measured about 1 MB: the re-exec'd GUI binary loads GTK and WebKit it never uses); `bwrap` and `xdg-dbus-proxy` ≈ 1.5 MB.
- Most Tauri idle windows swing between about 270 and 360 MB as GTK repaints; with compositing off the series is flat.

### Rendering experiments (Tauri only, environment variables)

| Experiment | Unfocused | Focused | Post-turn | Result |
|---|---|---|---|---|
| none (L1–L3) | 277.5 MB | 271.6 MB | 286.3 MB | baseline |
| `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1` | 273.6 MB | 355.8 MB | 297.0 MB | no saving; +84 MB focused |
| `WEBKIT_DISABLE_COMPOSITING_MODE=1` | 271.9 MB | 268.0 MB | 267.9 MB (no turn) | ≤ 4 % saving, no swings |

Neither experiment brings the shell near 60 % (≈ 226 MB against the focused Electron median). The structural floor is about 265 MB (web process + network process + a spike-sized main process + helpers), about 70 % of today's Electron.

### Installer sizes

| Package | Tauri 0.9.17 | Electron 0.9.16 | S12 baseline |
|---|---|---|---|
| `.deb` | 180.7 MB (172.3 MiB) | 256 MB | 169.88 MiB |
| AppImage | 254.3 MB (242.6 MiB, after the finalize step) | 283 MB | 245.73 MiB |

Sizes are from the 0.9.17 build in the Ubuntu 24.04 container (`scripts/tauri-linux-build.sh`) at `tauri/integration` `c623b75`, with both bundles finalized and the glibc floor (2.39) checked. The earlier 26.04 host build was 180.7 MB and 261.7 MB.

## Update handover

AppImage handover: PASS

Production path, final bundles at `ae1d96e`, 2026-10-05.

**Final run on the production path (evidence: `handover-evidence/final-appimage/RESULT.txt`).** This is the released 0.9.16 AppImage, repacked with only `resources/app-update.yml` changed and launched directly, served from the flat 0.9.17 feed. The Tauri install child, which electron-updater runs without `no_new_privs`, schedules a host `/bin/sh` waiter (`d477387`, review follow-up `73ab0e2`). The waiter relaunches the new file only after it sees Electron spawn its `--type=relauncher` helper.
- **Restart & install, `systemd-run` route: PASS.** electron-updater logged `isForceRunAfter: false`.
  - The install child ran with `NoNewPrivs: 0`, `systemd-run` returned in 8 ms, and the waiter ran in `app-vn.io.vif.saiatlas@handover….service`.
  - Electron's helper was seen at +0.159 s and gone at +0.208 s. Electron exited at +0.205 s, so its UI did not freeze, and both old mounts were gone at +0.220 s.
  - The waiter started the new file at +0.273 s. Exactly one Tauri main, runtime, supervisor and sidecar came up, all `NoNewPrivs: 0`, on one mount.
  - The environment is clean, `vi` and both tabs were kept, and the sidecar was Ready.
- **Install on quit: PASS.** The log shows `Auto install update on quit` and the file was replaced. The waiter exited 13 ms after Electron. No relauncher, no Tauri process, no mount and no leftover unit.
- **Direct route, no reachable user manager: PASS.** The route was logged as `direct` with the `systemd-run` failure as the reason, and the waiter had `/dev/null` on its stdio. The install child lived about 33 ms and Electron exited at +0.179 s, so nothing hung. One instance came up with `NoNewPrivs: 0`, a clean environment and the settings kept.
  - The first attempt hid the manager with `XDG_RUNTIME_DIR` under `/tmp`. The relaunched app aborted after 0.44 s. Controls showed that any Tauri launch aborts in WebKit ("Failed to fully launch dbus-proxy") when `XDG_RUNTIME_DIR` is unset or outside `/run/user/<uid>`, with or without the handover (see the follow-ups).
- **Tauri AppImage self-update regression, 0.9.17 to 0.9.18: PASS.** The old mount was gone at +0.51 s, one keepalive pipe was left, the file matches the 0.9.18 artifact, and the sidecar runs with `NoNewPrivs: 0`.
- **Host files unchanged:** `mimeapps.list` md5 `ca1dc4649ef1…`, no handler `.desktop` file, no unit left.
- **Follow-ups, outside the pass conditions:**
  - **Startup aborts without a standard runtime directory.** The app aborts when `XDG_RUNTIME_DIR` is unset or outside `/run/user/<uid>`.
  - **SIGBUS when the unit stops.** Stopping the handover unit signals the AppImage runtime and the app together. The FUSE server dies first, and the app takes a `SIGBUS` instead of a clean shutdown. Logout stops units the same way.
  - **Wrong version in the install child's log.** Its runtime-log line still says `appVersion 0.9.15` (crate version).

**Regression pass after the pre-release batch (bundles at `899ac58`, 2026-10-05; evidence `handover-evidence/regression-899ac58/RESULT.txt`): all four runs PASS, each on the first attempt.**
- **Timings:**
  - `systemd-run` route: Electron gone at +0.221 s, Tauri started at +0.290 s.
  - Install on quit: nothing started, and the unit was collected.
  - Direct route: Electron gone at +0.199 s.
  - Self-update: old mount gone at +0.635 s.
- **Unit stop is now clean:** `systemctl --user stop` took 0.19 s, the journal shows no `status=7/BUS` and no signal failure, the result was success with exit 0, the runtime log ends "shutdown finished", and the mount is gone.
- **Version:** the install child's log line reports `appVersion` 0.9.17.
- **GStreamer:** no `not found` lines anywhere. The registry sits under the app cache (`vn.io.vif.saiatlas/gstreamer-1.0/registry.x86_64.bin`), and the host's `~/.cache/gstreamer-1.0` is unchanged.
- **Known, not new:** the AppImage logs three enchant provider load errors at start, so spell checking likely fails in the AppImage on 26.04.

The history below is kept for the record.

**Earlier production-path run: FAIL (2026-10-05, before `d477387`).**

Re-run on the production path (evidence: `handover-evidence/step3-real/`). The released 0.9.16 AppImage was repacked with only `resources/app-update.yml` changed and launched directly, so the runtime set `APPIMAGE` and `APPDIR`. electron-updater logged `isSilent: false, isForceRunAfter: false`. The copy was replaced by the Tauri 0.9.17 image (sha256 matches the feed), and the old Electron, its mount and its runtime were gone at +0.213 s: PASS. **Then nothing started: no process and no new mount for 2.5 minutes. "Starts without user action" and "exactly one instance" FAIL.** The Tauri binary was never started as Electron's relaunch helper. There are two hypotheses, both in 0.9.16 itself. Either Chromium's relauncher starts the new `.AppImage` with `no_new_privs`, so setuid `fusermount3` cannot mount it, or the helper dies with the old mount. `prefs.json` was unchanged on disk (`vi`, 2 tabs).

Kongming (`kongming-appimage-handover-advice.md`) proved the first hypothesis. Under `setpriv --no-new-privs`, both the Tauri 0.9.17 and the Electron 0.9.16 images exit 127 at the FUSE mount. So every 0.9.x Electron→Electron AppImage update since v0.9.15 has also failed to relaunch; the earlier checks ran the extracted `AppRun` path. The fix that passed above: the Tauri install child, which electron-updater runs without `no_new_privs`, starts a host `/bin/sh` waiter. The waiter relaunches the new image only after it sees Electron spawn its `--type=relauncher` helper, which keeps install-on-quit from reopening the app. The safety net is a release-note line asking the user to start the new file once.

The run below took a non-production path. Running the extracted `squashfs-root/AppRun` does not export `APPDIR`, so electron-updater classified the install as "other". It then spawned the new file through Node (`isForceRunAfter: true`, `APPIMAGE_SILENT_INSTALL=true`, `NoNewPrivs: 0`). A real `.AppImage` launch instead takes `app.relaunch({execPath})` through Chromium's relauncher, the same path that hangs in the `.deb` handover below (kongming, `reports/kongming-deb-handover-advice.md`). The step must be re-run with the real `.AppImage` once the Tauri binary handles the relauncher protocol.

Run unattended on the virtual display (`:99`, GTK scale 2), 2026-10-04 22:13–22:18 KST. Every process ran with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `PI_CODING_AGENT_DIR` in a scratch directory. A wrapper kept the private session bus alive after the first app exited, as a desktop session does. The evidence is in `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/handover-evidence/step3/` (shots, `apply-timeline.txt`, `tauri-environ.txt`, `prefs.pre-apply.json`).

- Baseline: the released `Sai-ATLAS-0.9.16-x86_64.AppImage` (sha256 `a8a44d4d…`), extracted with `--appimage-extract`. `resources/app-update.yml` was set to `provider: generic`, `url: http://127.0.0.1:8765/`, keeping `updaterCacheDirName`. It ran as `squashfs-root/AppRun` with `APPIMAGE` pointing at a copy named `bin/Sai-ATLAS-0.9.16-x86_64.AppImage`. The feed was `bunx serve -l 8765 feed-0.9.17`.
- Seeded before apply: the language was switched to Vietnamese with the sidebar toggle (`language: "vi"`), and Ctrl+T opened a second tab (`tabLayouts`: 2 agent tabs, `activeIndex` 1).
- Banner "Version 0.9.17 is available", then Download update. The differential download fell back to a full one, as expected: the Tauri AppImage has no embedded blockmap. The downloaded file's sha256 `95b271a7…` matches the feed's. Then Restart & install.
- The copy was replaced. electron-updater deleted `Sai-ATLAS-0.9.16-x86_64.AppImage` and moved the Tauri image to `bin/Sai-ATLAS-0.9.17-x86_64.AppImage` (it renames versioned file names), sha256 `95b271a7…`.
- Old Electron main PID 918120 was gone at +0.12 s after the click (100 ms polling).
- Exactly one instance: one AppImage runtime (936700) and one Tauri main (936694, `/tmp/.mount_Sai-ATfpcAIe/usr/bin/sai-atlas`), with its supervisor and one sidecar. It was started by electron-updater (`APPIMAGE_SILENT_INSTALL=true` in its environ), with no user action. Its environ showed `APPIMAGE=…/bin/Sai-ATLAS-0.9.17-x86_64.AppImage` and `APPDIR=/tmp/.mount_Sai-ATfpcAIe`.
- Settings and tabs were intact. The UI came up in Vietnamese, and `prefs.json` kept `language: "vi"`, `rendererStorage.omp.lang: "vi"` and two agent tabs with the same cwd and `activeIndex` 1. The Electron tabs had no messages, so their session files were never written, and Tauri gave those tabs fresh sessions. The sidecar showed "Sẵn sàng" (Ready). Screenshots: `shots/04-tab2.png` (before), `shots/06-tauri-after-handover.png` (after).
- `omp://` was registered only inside the scratch `XDG_DATA_HOME`/`XDG_CONFIG_HOME`. The host was unchanged before and after: `~/.config/mimeapps.list` md5 `ca1dc4649ef1…`, no `sai-atlas-handler.desktop` in `~/.local/share/applications`, and the real `prefs.json` sha256 `46c51456…` (matches `prefs.sha.pre-stage-c`).

deb handover: PASS

**After the dependency split (bundles at `9ef58a9`, 2026-10-05; evidence `deb-handover/run6-9ef58a9/RESULT.txt`): all three gate rows PASS.**
- **Why it was re-run:** the pass at `899ac58` failed. A harness image without `desktop-file-utils` (then a hard Depends) and without apt lists made Electron 0.9.16's `apt-get install -f -y` remove `sai-atlas` (`run5-899ac58/`).
- **The fix:**
  - Depends is now `bubblewrap, xdg-dbus-proxy, libayatana-appindicator3-1 | libappindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`.
  - Recommends is now `desktop-file-utils, xdg-utils, gstreamer1.0-plugins-good, gstreamer1.0-pipewire`.
  - The Tauri updater runs `pkexec apt-get install -y --no-remove -- <deb>` (kongming, `kongming-deb-depends-handover-advice.md`).
- **Row 1, stock desktop without `desktop-file-utils`, no apt lists (gate): PASS.**
  - The update completed in a single `dpkg -i`, with no apt process and one polkit request. Tauri was up at +1.55 s as one instance.
  - Both sessions came back with identical sha256, and `vi` and the two tabs were kept.
  - The app logs the expected `omp://` registration ENOENT, while the existing handler stays the default.
  - Self-update to 0.9.18 used exactly one polkit request, for the new command. The three negative protocol cases pass.
- **Row 2, non-stock machine with apt lists and network (gate): PASS.** `dpkg -i` exited 1, then `apt-get -f` exited 0. apt history has one `Install:` line (95 packages, WebKit among them) and no `Remove:`. One instance ran.
  - Tauri ran on `libappindicator3.so.1`, which proves the tray alternation works.
- **Row 3, mirror unreachable (documented): as predicted.** apt exited 100, 0.9.17 stayed unpacked, and 0.9.16 kept running with its install-failed banner. Nothing was removed, and `apt --fix-broken install` finished the install once online.
- **Row 4, neither WebKitGTK 4.1 nor apt lists (evidence): the package is removed.** This is the residual risk 0.9.16 leaves. The release notes and README will carry the recovery command.
- **Row 5, Tauri update with an uninstallable Depends while offline (gate): PASS.** One polkit request, 0.9.17 still installed and running, and the localized banner with the `sudo apt install <path>` hint in English and Vietnamese. No second prompt.
- **Re-runs of the `9ef58a9` `.deb`:** packaged smoke 8/8, the fake-microphone probe 3/3, the openbox geometry check PASS.
- **Follow-up (`ed9c281`):** a failed install now also writes a runtime-log line with apt's output. It is unit-tested only; the next build carries it.
Tauri self-update relaunch: PASS

**Final regression run on the release-candidate bundles (2026-10-05, `ae1d96e`; evidence `deb-handover/run3/RESULT.txt`): PASS.**
- **Step 4:** both seeded tabs were real tabs this time, so both had to survive the handover, and they did. Language `vi` was kept too.
  - dpkg finished at +1.41 s. The old Electron process was gone and the Tauri main was up at +1.52 s, with no user action; the supervisor and sidecar followed at +1.75 s.
  - Exactly one main, supervisor, sidecar and window ran, and no relauncher process was left.
  - The direct route was taken, and the new main has `/dev/null` on fds 0–2 and leads its own session.
  - Nothing from the AppImage install waiter appears in the `.deb` flow.
- **Step 5:** the handed-over instance (`NoNewPrivs: 1`) showed "quit and reopen", and no `pkexec` ran (polkit log, a 120 s process monitor). After a fresh launch, `pkexec dpkg -i` installed 0.9.18 at +1.56 s, and one instance was back at +1.81 s with the settings kept.
- **Negative cases: 3 of 3.**
  - With a parent that exits, the launch came 0.019 s after it exited.
  - With a parent that never exits, the helper gave up at 60.08 s and started nothing.
  - With fd 3 closed, there was no crash, and the launch came 0.056 s after the parent exited.
- **Unit name, checked by temporarily wrapping `/usr/bin/systemd-run` in the container:** `app-vn.io.vif.saiatlas@handover87745119a1662.service`.
- **Still host-only:** the success path of the `systemd-run` route, and its fallback when systemd-run times out. In the container systemd-run fails immediately rather than hanging.

**Extra `.deb` handover cases (2026-10-05, `ae1d96e` bundles; evidence `deb-handover/run4-extra/{c3,c4}/RESULT.txt`): PASS.**
- **Conversation kept across the handover.** In 0.9.16, two tabs each held a session written by a `!echo` command.
  - After the handover, Tauri reopened both tabs on their exact session files, in the same order and with byte-identical contents, and both transcripts render.
  - Language `vi`, the two tabs and `activeIndex` 1 were kept.
  - A tab whose only action was a `!` command is dropped on restart, but 0.9.16 drops it too, so the migration did not cause it.
- **LevelDB import.** Tauri started on a 0.9.16 profile with `rendererStorage` removed from `prefs.json`. It wrote all four keys back with values identical to the LevelDB. The palette's recent list, which only the import can restore, came back, with no crash and no error line.
  - With the legacy `language`/`themeName` keys also removed, the language still came back. The theme did not, which is by design: the LevelDB theme value only colours the first paint.
  - A successful import logs nothing.

**Re-run after the relauncher fix (2026-10-05, bundles at `2c0d840`; evidence `deb-handover/run2/RESULT.txt`).** The Tauri binary now answers Electron 0.9.16's relauncher protocol (`c5a1f59`). Under `no_new_privs` it refuses to run `pkexec` and asks for a reopen instead (`2c0d840`). The review follow-up is `fa5302f`.
- **deb handover (step 4):** PASS.
  - `dpkg -s` showed 0.9.17, with no other package of ours, and `/opt/Sai ATLAS` holds only the compat link.
  - Electron started its helper as `/opt/Sai ATLAS/sai-atlas --type=relauncher`. The helper wrote the sync byte, waited 50 ms for Electron to exit, then started `/usr/bin/sai-atlas` with no arguments.
  - The old Electron PID was gone at +1.57 s.
  - Exactly one Tauri main, supervisor and sidecar ran. The four Electron variables were absent, there was no `relauncher.cc` error and no hotkey conflict.
  - Language `vi` and the explicitly opened tab were kept. Untouched placeholder tabs are dropped on any restart, by 0.9.16 and Tauri alike.
  - The container has no systemd user manager, so the launch took the direct fallback (logged `route "direct"`), and the new processes carry `NoNewPrivs: 1`.
- **Tauri `.deb` self-update (step 5):** PASS.
  - From the handed-over instance, "Restart & install" showed "quit and reopen Sai ATLAS, then try again". No `pkexec` ran, and the verified package was kept.
  - After a fresh start of `/usr/bin/sai-atlas`, `pkexec /usr/bin/dpkg -i` installed 0.9.18.
  - The old PID was gone at +1.75 s, exactly one instance came back, the window rendered, the sidecar was ready, and settings were kept.
- **Negative protocol cases:** PASS. With a parent that exits after 3 s, the byte arrived and the launch came 0.05 s after the parent exited, with the `omp://` link and extra switches dropped. With a parent that never exits, the helper exited 0 after 60.08 s and started nothing. With fd 3 closed, there was no crash and the launch came after the parent exited.
- **Pending on the host (Phase 11):** the `systemd-run --user` route, which should leave the handed-over app with `NoNewPrivs: 0` so the next `pkexec` prompts in the same session.
- **Small follow-ups:**
  - helper-mode runtime-log lines show the crate version;
  - `omp://` registration fails when `~/.local/share/applications` does not exist;
  - after a reopen the update downloads again.

**Superseded first run (bundles at `e824b79`, before the relauncher fix):**

The `.deb` part ran in a clean `ubuntu:24.04` container instead of on the host, as Task 10.5 step 4 allows. The container had a session bus and system bus, Xvfb, polkitd, and a real `apt install` of the released 0.9.16 (sha256 matches the v0.9.16 asset). A polkit rule grants `pkexec` only to the two updaters' exact `dpkg -i` / `apt-get install -f -y` command lines on a `.deb` under `~/.cache`, standing in for the user's password. The evidence is in `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/deb-handover/` (`RESULT.txt`, `step4/`), and the harness is in `worktrees/stage-c/deb-handover/`.

- `dpkg -s sai-atlas` showed 0.9.17 at +1.29 s after "Restart & install". No older package or alternatives entry was left, and `/opt/Sai ATLAS` holds only the compat link: PASS.
- Settings: `language: "vi"` and both tabs were kept: PASS. The local-assistant onboarding showed again, although "Set up later" had been clicked in Electron.
- **Old Electron PID gone within 10 s: FAIL. Exactly one instance: FAIL.** electron-updater calls `app.relaunch()` after `dpkg -i`. By then `/opt/Sai ATLAS/sai-atlas` is the Tauri binary, so Electron starts Tauri as its relaunch helper (`--type=relauncher --no-sandbox --- …`). Electron then blocks waiting for one byte on fd 3, which Tauri never writes. Electron was still alive at +179 s, next to a full Tauri instance. Stopping Tauri let Electron exit 0.20 s later.
- **Second defect:** a process started that way carries `NoNewPrivs: 1`, because Chromium's process launcher sets it, and so do its supervisor and sidecar. `pkexec` then fails ("must be setuid root", exit 127), which `install.rs` reads as a refusal. The first Tauri `.deb` self-update from a handed-over session would fail until the app restarts.
- Step 5 (the Tauri `.deb` self-update) was not run, per the Failure Protocol.

AppImage part run unattended on the virtual display, 2026-10-04 22:18–22:32 KST, with the same isolation. The evidence is in `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/handover-evidence/step5/` (shots, `apply-timeline.txt`, `old-environ.txt`, `new-environ.txt`, `stale-mount-evidence.txt`, `quit-timeline.txt`). The `.deb` part needs sudo on the host and is left to the user.

- Tauri A was a copy of the 0.9.17 AppImage (sha256 `95b271a7…`, built with `SAI_ATLAS_UPDATE_BASE=http://127.0.0.1:8765`), run directly, so the runtime set `APPIMAGE`. The 0.9.18 feed was served by `bunx serve -l 8765 gh-0.9.18`, with hard links in the GitHub layout the build requests (`feed.rs:31,36`): `latest/download/latest-linux.yml` and `download/v0.9.18/<assets>`. A flat feed directory returns 404 to the Tauri updater.
- Banner "Version 0.9.18 is available", then Download update. The download landed in `<XDG_CACHE_HOME>/@oh-my-pi/omp-gui/updates/` with sha256 `1372976c…`, which matches the feed. Then Restart & install.
- The file at `$APPIMAGE` is the new build. `bin/Sai-ATLAS-0.9.17-x86_64.AppImage` was replaced in place with the same name and now has sha256 `1372976c…`. Settings → Updates shows Current 0.9.18.
- Old PID 962733 was gone at +0.98 s after the click. The runtime log shows "shutdown finished", then "relaunching …", then the new PID 968647 starting 220 ms later.
- Exactly one instance: one main process (968647), one new runtime (968664), the supervisor and one sidecar.
- New environ: `APPIMAGE=…/bin/Sai-ATLAS-0.9.17-x86_64.AppImage` (the replaced file), `APPDIR=/tmp/.mount_Sai-ATOgahla` (the old mount was `/tmp/.mount_Sai-ATLcOBJg`), and no `APPIMAGE_EXIT_AFTER_INSTALL`.
- The window renders, and the header shows "Ready" for the sidecar (`shots/05-tauriB-moved-on-screen.png`, `shots/08-updates.png`). The window came back off-screen at x=-880, the position the test had moved it to, and was moved back with `xdotool windowmove`.
- `omp://` registration stayed in the scratch directories, and the host files were unchanged after the run (same three checks as above).

Defects found here that are outside the pass conditions (kongming reviewed them and does not invoke the Failure Protocol):

- **Old AppImage mount outlives a self-update relaunch (medium, fixed in `1bbf9f5`, re-verified below).** The phase file expected the old `/tmp/.mount_*` to "no longer exist". After the relaunch it was still mounted, served by old runtime PID 962739, whose executable is the deleted 261,691,896-byte image (inode held, 0 links). Cause: `start_pending_relaunch` (`src-tauri/src/lib.rs:263-272`) spawns the new AppImage without closing inherited descriptors. The new app (968647) and its runtime (968664) both hold fd 3, the read end of the old runtime's keepalive pipe (`pipe:[5844798]`), and the type-2 runtime keeps its FUSE server alive while any process holds that end. The relaunch also inherits the old mount as cwd (`PWD`/`OWD=/tmp/.mount_Sai-ATLcOBJg/usr`), and appends old-mount entries to `LD_LIBRARY_PATH`, `GST_PLUGIN_SYSTEM_PATH` and similar variables. The leak lasts only for the session: after a graceful quit (SIGTERM, "shutdown finished"), the app, both FUSE servers and both mounts were gone within 0.52 s. Each update within one session would add another stale mount. Fix shape from kongming:
  - mark inherited fds ≥ 3 close-on-exec at startup in `main.rs`;
  - in `start_pending_relaunch`, set a neutral cwd and remove `$APPDIR` entries from the variables that accumulate them;
  - after the fix, re-run with these extra checks: the old mount and its FUSE PID are gone within 10 s, the new process holds only its own keepalive pipe, `PWD`/`OWD` are not under `/tmp/.mount_*`, and `LD_LIBRARY_PATH` lists no old-mount entries.
- **Main windows open at the wrong size on Linux (high; fixed in `baea5a6` and the review follow-up `e2caf7e`; real-desktop check PENDING-USER).** A fresh window opened at 2800×1800 on a 1920×1080 screen, and after the Electron handover at 2540×1710. The display ran at scale 1; the "GTK scale 2" and "unit mix-up" guesses here were wrong. The cause: tao 0.37.1 seeds its cached outer size with the window's *position* until the first configure event, and `build_main_window` (`src-tauri/src/desktop/windows.rs:730-738`) measures the decoration synchronously after build. The correction therefore yields `2 × target − position`. That matches every observation exactly: `2×1400−260 = 2540` and `2×900−90 = 1710` (Electron's centered window at (260, 90)), 2800/2772/2744 for cascaded windows, and 3840×2160 after a 1920×1080 resize. This affects every Linux session; on GNOME the oversized request is clamped to the work area. Save and restore themselves have no unit bug. The fix, from kongming (`reports/kongming-window-size-advice.md`): measure against the requested size with plausibility ceilings, apply the correction on Linux once on the first `Resized` event, and ignore sub-minimum rects when saving.
  - On the virtual display after the fix (`e2e-hooks` debug build, evidence in `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/winfix-evidence/`), a fresh window opens at 1400×900 at both `GDK_SCALE=1` and `GDK_SCALE=2`. Seeded states {1400×900 at 260,90} and {1300×850 at 40,30} reopen exactly, and three launch/quit cycles leave `window-state.json` byte-identical. A new e2e case in `desktop.e2e.ts` fails with 2560×1670 on the old code and passes on the fix.
  - Under a real reparenting X11 window manager (openbox on Xvfb in a clean `ubuntu:24.04` container, `.deb` installed with apt; harness `worktrees/stage-c/wm-check/`, outputs `out-c623b75/` and `out-e824b79/`). Each run had three launch / close (`wmctrl -c`) cycles on a fresh profile and on a seeded {1300×850 at 40,30}. openbox's frame is 1/1/20/5.
    - Before the fix (`c623b75`), the saved size doubled on every launch: 2802×1825, then 5606×3675, then 11214×7375.
    - After the fix (`e824b79`), the outer footprint is exactly 1400×900 (client 1398×875 plus the frame) and 1300×850 when seeded. `window-state.json` was identical across all three cycles in both cases.
  - A regression from the review follow-ups (`e2caf7e`/`5c1c4ec`) made a window restored at a saved position grow by one openbox frame per launch: 1302×875, then 1304×900, then 1306×925. Cause (kongming, `reports/kongming-window-size-regression-advice.md`): tao reads the outer position and outer size from two live `root_origin()` X queries, which can straddle the window manager's reparent. The main-thread catch-up then measured garbage and disarmed. The fix is in `7b0391a` and `675922c`: the catch-up stays armed on an implausible measurement and is skipped for main-thread builds. The openbox check is committed as `scripts/tauri-wm-geometry-check.sh` (`a115ce2`), with asserted results:
    - PASS at `675922c`: fresh 1400×900 and seeded 1300×850 on every launch, each corrected by the listener;
    - PASS at `e824b79`;
    - FAIL at `c623b75`, as required (8 assertions).
    - PASS at `899ac58` (2026-10-05), identical numbers. The image now preinstalls the new `.deb` depends (`24a8731`).
    - PASS at `ae1d96e` (the final bundles, 2026-10-05): fresh 1400×900 at (99, 37) and seeded 1300×850 at (40, 30), with client plus frame equal to the saved state on all six launches (`winfix-evidence/wm-check/ae1d96e/geometry.txt`).
  - Still for the user, on the real GNOME 50 Wayland desktop at 125 %: the check below, with any Tauri build (`APP=` the unpacked deb's `usr/bin/sai-atlas` or an AppImage). Close the window normally each time. All three printed lines should be identical, and the first window should not fill the screen.
    ```bash
    P=$(mktemp -d); APP=/path/to/sai-atlas
    run() { XDG_CONFIG_HOME=$P/c XDG_DATA_HOME=$P/d XDG_CACHE_HOME=$P/k PI_CODING_AGENT_DIR=$P/a PI_CONFIG_DIR=$P/p "$APP"; }
    for i in 1 2 3; do run; jq -c . "$P/c/@oh-my-pi/omp-gui/window-state.json"; done
    ```
- **The runtime log reports `appVersion` 0.9.15 (cosmetic; fixed in `e824b79`, which logs `context.package_info().version`, the package.json version).** `runtime_log` uses `env!("CARGO_PKG_VERSION")` (`lib.rs:402`, `runtime_log.rs:235`), and `src-tauri/Cargo.toml` was not bumped. `Host::app_version` reads the correct 0.9.17/0.9.18.

### AppImage self-update relaunch, re-run after the fix

AppImage self-update relaunch: PASS (leak fixed)

Run unattended on the virtual display, 2026-10-04 23:15–23:18 KST, against the bundles built in the Ubuntu 24.04 container at `tauri/integration` `c623b75`, which includes `1bbf9f5`. Isolation was the same as above, plus `PI_CONFIG_DIR`. The evidence is in `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/handover-evidence/step5c/` (`RESULT.txt`, `apply-timeline.txt`, `relaunch-evidence.txt`, `quit-timeline.txt`, shots).

- The flow was the banner "Version 0.9.18 is available", then Download update, then "0.9.18 ready — restart to apply", then Restart & install.
- After the click, the old main process and the old mount `/tmp/.mount_Sai-ATceHaoo` were gone at +0.51 s, and the old FUSE runtime at +1.02 s. Exactly one mount remained, the new one.
- The new app holds one keepalive pipe, shared only with its own runtime (app fd 3 and runtime fd 4 on the same pipe).
- `PWD` and `OWD` were the launch directory, and the environment had no reference to the old mount. The process cwd is the new mount's `usr`, which AppRun sets itself.
- The replaced file's sha512 matches the 0.9.18 artifact. The relaunched app fetched the feed again and showed no update banner, and its sidecar was running.
- After SIGTERM, every process of the run and the mount were gone at +1.23 s.
- The host's `omp://` files were unchanged.

Still open from this run:
- GStreamer in the AppImage: `GST_PLUGIN_SYSTEM_PATH_1_0` points at `$APPDIR/usr/lib/gstreamer-1.0`, which the bundle does not contain, and the log prints "GStreamer element appsink not found". This affects dictation in the AppImage.
- Without a window manager, Ctrl+Q sent by `xdotool` does not reach GTK, and the Linux File menu has no Quit item, so the run quit with SIGTERM instead.


## Packaged smoke

Packaged smoke: PASS (8/8, clean Ubuntu 24.04 container)

Run 2026-10-04 by `bash scripts/tauri-deb-smoke.sh` (`tauri/integration` `3f6af10`) against `sai-atlas_0.9.18_amd64.deb`, built in the 24.04 container at `c623b75`. The script installs the package with `apt-get install` in `ubuntu:24.04` (WebKitGTK 2.52.6 from 24.04 updates) and runs `e2e-tauri/packaged-smoke.e2e.ts` (`wdio.packaged.conf.ts`) on a headless weston, so the app runs on GTK's Wayland backend. tauri-driver 2.1.0 is built in the image. The log is in `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/tauri-deb-smoke/run.log`.

| Case | Result |
|---|---|
| boots sandboxed and renders with a ready sidecar (`Seccomp: 2`, nested namespace, `bwrap` parent on every web process) | PASS |
| persists a settings toggle across a relaunch | PASS |
| opens a workspace passed on the command line, cold and warm | PASS |
| opens quick entry from the command line, cold and warm | PASS |
| follows omp:// links, cold and warm | PASS |
| exposes the host platform to the renderer | PASS |
| checks for updates against latest-linux.yml (the real GitHub feed) | PASS |
| a hard kill leaves no sidecar or tool child (S7b: `kill -9` of the shell with `!/usr/bin/sleep 600` running; sleep, stats server, agent and supervisor gone within 10 s) | PASS |

Re-run on the 0.9.18 `.deb` rebuilt at `e824b79` (window-size and runtime-log fixes): 8/8 PASS (`run-e824b79.log`).
Re-run on the final 0.9.18 `.deb` rebuilt at `ae1d96e` (handover, NoNewPrivs and window-regression fixes): 8/8 PASS (`run-ae1d96e.log`, 2026-10-05).
Re-run at `899ac58` (pre-release batch: KillMode, depends, crate version, bundled GStreamer plugins): 8/8 PASS (`run-899ac58.log`).

**Audio probe (fake microphone, `OMP_E2E_FAKE_MIC=1`, `e2e-tauri/fake-mic.probe.ts`), 2026-10-05: PASS.**
- **What it checks:**
  - capture from a PipeWire fake microphone through `pipewire-pulse` into a running AudioContext (one input, rms 0.567);
  - a WAV blob played to the end;
  - every web process sandboxed, with only the audio paths bound.
- **Where it passed:**
  - the 0.9.18 `.deb` (`fake-mic-899ac58.log`), the first test of the `.deb`'s microphone path;
  - the feed AppImage on Ubuntu 24.04 and 26.04 (`appimage-matrix/out-p11-mic-final-*`).
- **Controls (`reports/appimage-container-matrix.md`):** the previous AppImage and the new one with its plugins moved aside both fail the probe.

The Wayland app id `vn.io.vif.saiatlas` was checked from the `WAYLAND_DEBUG` trace. The container needs only `seccomp=unconfined`, `apparmor=unconfined` and `systempaths=unconfined` for bubblewrap, with no `--privileged` and no host devices.

Follow-ups, outside the pass conditions:
- When bubblewrap starts but the sandbox then fails (for example "Can't mount proc on /newroot/proc"), WebKit aborts with "Failed to fully launch dbus-proxy" instead of the app exiting with `SANDBOX_MISSING_EXIT_CODE` (70). The pre-check catches only a missing user namespace. This still fails closed (no unsandboxed web process), but the user gets an abort rather than the explanatory exit.
- The `.deb`'s `Depends` lists `libwebkit2gtk-4.1-0` and `libayatana-appindicator3-1` twice (cosmetic).
