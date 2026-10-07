# Kongming counsel: .deb Depends, the 0.9.16 handover removal, and the Tauri updater's install command

Date: 2026-10-05 (KST). Worktree `/home/tung491/WORK/worktrees/tauri-integration` at 24a8731. Advisory only; no project file was changed. Model: Claude Fable 5.1.

## TL;DR

Shrink the Tauri .deb's `Depends` to what the binary cannot start without (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `bubblewrap`, `xdg-dbus-proxy`, and the tray library as the alternation `libayatana-appindicator3-1 | libappindicator3-1`), move `desktop-file-utils`, `xdg-utils`, `gstreamer1.0-plugins-good` and `gstreamer1.0-pipewire` to `Recommends`, and switch the Tauri updater from `dpkg -i` + `apt-get install -f -y` to a single `pkexec apt-get install -y --no-remove -- <package>`. With that, every stock Ubuntu 24.04/26.04 desktop that runs 0.9.16 configures 0.9.17 at `dpkg -i` time with no apt call at all (every remaining hard dependency is in the stock desktop manifests and on the user's host), networked non-stock machines still succeed through 0.9.16's `apt-get -f`, and the Tauri updater can never again leave a package unconfigured or remove it. No bridge Electron release and no `Pre-Depends`: both trade the common online case for the rare offline one, and the evidence does not justify that.

## Reframed problem

The decision is not "which dependency caused run5 to fail" but "what is the largest set of 0.9.16 machines on which the released, unchangeable electron-updater 6.8.9 path (`pkexec bash -c 'dpkg -i <deb>'`, then on failure `pkexec bash -c 'apt-get install -f -y'`; `node_modules/electron-updater/out/DebUpdater.js:57-66`) ends with 0.9.17 configured, and how is the destructive branch (apt removes the half-installed package) made unreachable or at least non-silent". Requirements: 0.9.16 cannot change; the sandbox (bwrap + xdg-dbus-proxy) is mandatory; the Tauri updater's future updates must not inherit the same hazard. Non-goals: supporting Ubuntu 22.04 (0.9.16's README floor is 24.04+), bundling WebKit into the deb.

## Evidence (verified)

**electron-updater 6.8.9.** `DebUpdater.installWithCommandRunner` runs `dpkg -i` first; any non-zero exit (including "dependency problems - leaving unconfigured") triggers `apt-get install -f -y`. If that second command exits non-zero, `doInstall` dispatches an error and returns false, and `BaseUpdater.quitAndInstall` (`out/BaseUpdater.js:13-27`) does **not** quit. 0.9.16's own `src/main/updater.ts` (tag v0.9.16, lines 346-362) captures that error and shows the banner `updates.installFailed (…)`. If the second command exits 0, Electron quits and relaunches `/opt/Sai ATLAS/sai-atlas` whether or not the package survived. Nothing in the feed (`latest-linux.yml`) or the package can change these commands; the only levers are the package's control fields and its payload.

**Container runs (this session, throwaway containers, all removed).**

| Case | Command sequence | Result |
|---|---|---|
| ubuntu:24.04, lists present, network up, 0.9.16 installed with `apt install ./deb` (7 of 8 Tauri deps missing, only `xdg-utils` present) | `dpkg -i` → unpacked, exit 1; `apt-get install -f -y` | 123 packages installed, `Setting up sai-atlas (0.9.17)`, status `install ok installed`; **apt also removed `libappindicator3-1`** (dry run: `Remv libappindicator3-1 … [sai-atlas:amd64]`) because 0.9.16's deb carries `Recommends: libappindicator3-1` (`dpkg-deb -f dist/sai-atlas_0.9.16_amd64.deb`) and Ubuntu's `libayatana-appindicator3-1` declares `Conflicts: libappindicator3-1` |
| same image, lists present, mirror unreachable (`-o Acquire::http::Proxy=http://127.0.0.1:9/`; stale-list analogue) | `dpkg -i`; `apt-get install -f -y` | `E: Unable to fetch some archives`, exit 100; package stays `install ok unpacked 0.9.17`; `/usr/bin/sai-atlas` and the `/opt` symlink exist; **nothing removed**. Under 0.9.16 this is the banner-and-stay-running path |
| handover image (no lists, `desktop-file-utils` missing) | `dpkg -i`; `apt-get install -f -y` | removal (reproduces run5) |
| handover image (no lists) | `apt-get install -y /abs/path.deb` and `apt-get install -y -- /abs/path.deb` | `E: Unable to correct problems, you have held broken packages.` exit 100; **0.9.16 stays `install ok installed`**; `--` is accepted |
| ubuntu:24.04 networked, pkexec-like `env -i`, file under a 0700 home | `apt-get install -y /home/ubuntu/.cache/pending/….deb` | configured in one command; only debconf frontend warnings (no tty); re-running on the installed version is a no-op, exit 0 |
| handover image (no lists), repacked deb with the proposed split | `apt-get install -y --no-remove -- deb` | `Recommended packages: …` skipped, `Setting up sai-atlas (0.9.17)`, exit 0; and `dpkg -i` of the same package from 0.9.16 configures at once, exit 0 |
| handover image, repacked deb with `Pre-Depends: desktop-file-utils` unmet | `dpkg -i`; `apt-get install -f -y` | dpkg: `pre-dependency problem - not installing sai-atlas`, exit 1, 0.9.16 untouched and still configured; apt: nothing to do, exit 0 (Electron would then relaunch 0.9.16 silently) |

**Where the dependencies come from.** tauri-cli 2.12.1 appends `libayatana-appindicator3-1` (tray feature), `libwebkit2gtk-4.1-0` and `libgtk-3-0` to the configured list (`~/.cargo/registry/src/*/tauri-cli-2.12.1/src/interface/rust.rs:1405,1422-1423`). The bundler writes `Depends:` from `deb.depends` and `Recommends:` from `deb.recommends` (`tauri-bundler-2.10.1/src/bundle/linux/debian.rs:204-215`); `recommends` is a real config key (`tauri-utils-2.10.1/src/config.rs:344`). There is no `Pre-Depends` support, but `src-tauri/linux/finalize-deb.ts` already repacks the control directory (`dpkg-deb -R` … `-b`), so any control field can be rewritten there.

**What each dependency does at runtime.**
- `libwebkit2gtk-4.1-0`: linked; the binary cannot start without it. On both 24.04 and 26.04 the Ubuntu package itself `Depends:` on `bubblewrap (>= 0.3.1)`, `xdg-dbus-proxy`, `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, `libgtk-3-0t64` (`apt-cache show` in the 24.04 container and on the host). Listing bwrap/xdg-dbus-proxy explicitly is redundant on Ubuntu and costs nothing.
- Tray: `libappindicator-sys 0.9.0` dlopens `libayatana-appindicator3.so.1`, then `libappindicator3.so.1`, and **panics** if neither loads (`src/lib.rs:13-54`, a `Lazy<Library>`). `src-tauri/Cargo.toml` sets no `panic = "abort"` and `TrayController::install` (`src-tauri/src/desktop/tray.rs:124-134`) handles `Err`, not a panic, so the tray library must stay a hard dependency; but either library satisfies the loader, hence the alternation.
- `desktop-file-utils`, `xdg-utils`: used by `tauri-plugin-deep-link`'s Linux `register`; failure is logged and ignored (`src-tauri/src/desktop/mod.rs:425-429`). For upgraders the `omp://` handler already exists in `~/.config/mimeapps.list` written by 0.9.16 (run5 `pre-apply/scheme-handler.before.txt`), and `desktop-file-utils` has a dpkg trigger on `/usr/share/applications`, so the desktop database is refreshed at install time wherever it is present.
- `gstreamer1.0-plugins-good`: provides `pulsesrc`, which WebKit's sandboxed capture uses; without it dictation fails with `voice.mic.failed` (`src/renderer/lib/voice.ts:159-162`) and the app continues. It arrives with WebKit on Ubuntu anyway. `gstreamer1.0-pipewire` is inert for WebKit capture (see `tauri-appimage-gstreamer-counsel`).

**Population.** 0.9.16's README states Linux x64 (Ubuntu 24.04+). The Ubuntu 24.04.3 and 26.04.1 desktop manifests (releases.ubuntu.com) contain every Tauri dependency: `libwebkit2gtk-4.1-0`, `libgtk-3-0t64`, `bubblewrap`, `xdg-dbus-proxy`, `gstreamer1.0-pipewire`, `gstreamer1.0-plugins-good`, `libayatana-appindicator3-1`, `desktop-file-utils`, `xdg-utils` (and `yelp`, which depends on WebKitGTK 4.1). The user's host (Ubuntu 26.04.1, GNOME) has all of them installed and `libappindicator3-1` not installed. Run2-4 passed because the image modelled exactly this; run5 failed because `desktop-file-utils` was the one dependency the image did not model, and because the image deletes `/var/lib/apt/lists`, a state a real desktop almost never has (update-notifier refreshes lists daily).

**polkit.** `pkexec` without a product policy uses `org.freedesktop.policykit.exec`, whose implicit authorisations are `auth_admin` on the host (`/usr/share/polkit-1/actions/org.freedesktop.policykit.policy`), not `auth_admin_keep`: today's two-command Tauri sequence means two password prompts whenever `dpkg -i` fails. The harness allowlist (`stage-c/deb-handover/image/sai-atlas-update.rules.in`) matches exact command lines and must learn the new one.

## A. Dependency classes

Keep as `Depends` (the app cannot start, or crashes, without them):
- `libwebkit2gtk-4.1-0`, `libgtk-3-0` (tauri-cli adds both; `libgtk-3-0` is satisfied by `libgtk-3-0t64`'s `Provides`, exactly as for 0.9.16).
- `bubblewrap`, `xdg-dbus-proxy` (configured; the sandbox is mandatory; redundant with WebKit's own Depends on Ubuntu, so zero marginal risk).
- The tray library, rewritten by `finalize-deb.ts` from tauri-cli's `libayatana-appindicator3-1` to `libayatana-appindicator3-1 | libappindicator3-1`. This removes the only forced package *swap* in the handover: a 0.9.16 machine that got `libappindicator3-1` through 0.9.16's Recommends satisfies the alternation at `dpkg -i` time, and the loader falls back to `libappindicator3.so.1`.

Move to `Recommends` (`bundle.linux.deb.recommends`): `desktop-file-utils`, `xdg-utils`, `gstreamer1.0-plugins-good`, `gstreamer1.0-pipewire`. Behaviour when absent: `omp://` registration logs "could not register the omp:// scheme" and the app runs (upgraders keep the handler 0.9.16 wrote; fresh `apt install ./deb` users get the Recommends installed by default); dictation shows "Dictation failed" if `pulsesrc` is missing (practically never on Ubuntu, since WebKit depends on plugins-good); the pipewire plugin changes nothing for WebKit. `dpkg -i` and `apt-get -f` ignore Recommends, verified above.

## B. Removal risk during the 0.9.16 handover, and mitigations

After the A changes, the branch "dpkg -i fails" is reached only on a machine without WebKitGTK 4.1 (or both tray libraries). Stock Ubuntu GNOME 24.04/26.04 and the user's host are outside that set. Inside it:
- lists present + network: `apt-get -f` installs WebKit and configures 0.9.17 (verified). Risk: apt may remove conflicting packages with `-y`; after the alternation the only such conflict known today is gone.
- lists present + mirror unreachable/stale: exit 100, package stays unpacked, 0.9.16 shows the install-failed banner and keeps running from deleted inodes; the next launch is the Tauri binary, which cannot start without WebKit; `sudo apt --fix-broken install` once online finishes it. Not destructive, but "no app until the user runs one command".
- no lists at all (or the dependency not in any enabled repository): silent removal, as in run5. This is a container/odd-server state, not a desktop state.

Mitigations that work without touching 0.9.16, in order of value: (1) the A split and alternation, which make the failing branch unreachable on the documented platform; (2) README + release body: "updating from 0.9.16 on a desktop without GNOME: run `sudo apt install libwebkit2gtk-4.1-0` first; if the app is missing after an update: `sudo apt --fix-broken install` or `sudo apt install ./sai-atlas_0.9.17_amd64.deb`" (the 0.9.x update screen shows no notes, so this reaches only readers of GitHub); (3) the harness rows in D so the three apt states are recorded evidence.

Rejected: `Pre-Depends: libwebkit2gtk-4.1-0` (verified to protect 0.9.16, but it also defeats the networked success path: electron-updater's `apt-get -f` has nothing to fix after a refused unpack, Electron relaunches 0.9.16 silently, and the user loops forever). A `preinst` that fails when WebKit is absent has the same trade-off and would add maintainer scripts the deb deliberately has none of. Shipping `/etc/apt/apt.conf.d/*` with `APT::Get::Remove "false"` would technically be read by the subsequent `apt-get -f` (files are unpacked before it runs) but alters the user's system-wide apt behaviour; unacceptable.

Bridge Electron 0.9.17: still not warranted, and this stays the user's call. The earlier reason holds (electron-updater installs the newest release, so a bridge helps only users who update during a deliberately staged window), and the new evidence narrows the exposed population to non-GNOME offline machines. It would flip if SAI OS ships images without WebKitGTK 4.1 (no yelp, no evolution-data-server UI) or if a meaningful share of installs is offline; the check is `dpkg -s libwebkit2gtk-4.1-0` on a representative SAI OS image.

## C. The Tauri updater's own installs

Switch `install.rs` to one privileged command: `/usr/bin/pkexec /usr/bin/apt-get install -y --no-remove -- <absolute package path>`, and delete `fix_dependencies` and `-f` from the updater entirely. Why: apt resolves dependencies before touching dpkg, so a package is never left unpacked-unconfigured and never removed (exit 100 with the old version intact, verified offline); networked installs finish in one step (verified); one pkexec prompt instead of up to two; `--no-remove` turns "apt wants to remove other packages to satisfy this" into a loud failure, which is the right posture for an unattended `-y` command running as root (an interactive `sudo apt install ./deb` can show the user what it would remove). The absolute path requirement already exists; `--` is accepted. Implications: the harness rules.in needs a new allowed line (`^/usr/bin/apt-get install -y --no-remove -- <deb>$`); the `uses_absolute_dpkg_path` / `runs_dpkg_then_the_dependency_fix_only_after_a_dpkg_failure` tests become a single-command plan; the doc comments that cite electron-updater's sequence change. Map the common failure (`stderr` containing "Unmet dependencies" or "Unable to correct problems") to a localized message that includes the manual command `sudo apt install ./<path>`; the existing `InstallError::Failed(detail)` banner (`updater/mod.rs:518`) already carries apt's stderr tail. Expect debconf frontend warnings in that tail when run without a tty; they are noise, not failures. Optional follow-up, not for 0.9.17: on startup, if `dpkg-query -W -f='${Status}' sai-atlas` is not `install ok installed`, offer a one-time "Finish setup" that runs `pkexec apt-get install -f -y --no-remove`.

## D. Verification plan (container harness)

Keep one Dockerfile but parameterise the dependency set and the apt state; every row keeps the `--security-opt` trio and pkexec via polkitd.

1. **Stock desktop (gate).** Preinstall 0.9.16's Depends plus the hard Tauri set (`libwebkit2gtk-4.1-0 libayatana-appindicator3-1 bubblewrap xdg-dbus-proxy`) and **deliberately omit** `desktop-file-utils`; delete lists as today. Expect: a single `dpkg -i` in `apply-timeline.txt` (no `apt-get` process), 0.9.17 `install ok installed`, relaunch, one instance, prefs and sessions intact, `gui-runtime.jsonl` either silent or containing the "could not register the omp:// scheme" line, `xdg-mime query default x-scheme-handler/omp` still `vn.io.vif.saiatlas.desktop`.
2. **Non-stock, networked (gate).** 0.9.16's Depends only (apt-installed, so `libappindicator3-1` is present), lists kept, network on. Expect: `dpkg -i` exit 1, `apt-get install -f -y` exit 0, `apt-history.log` shows `Install:` with WebKit and **no `Remove:` line**, 0.9.17 configured, relaunch succeeds.
3. **Non-stock, stale mirror (documented behaviour, not a gate).** Row 2's image with `-o Acquire::http::Proxy` unavailable to electron-updater; instead start the container with `--network none` after `apt-get update` at build time. Expect: apt exit 100, 0.9.17 `unpacked`, 0.9.16 still running with the `updates.installFailed` banner (screenshot), nothing removed; then reconnect and run `apt --fix-broken install` → configured.
4. **No lists (evidence only).** Today's run5 state; expect removal; keep as the recorded negative that motivated this change.
5. **Tauri 0.9.17 → 0.9.18 (gate).** Rows 1 and 2 with the new command: exactly one `org.freedesktop.policykit.exec` request in `polkitd.log`, `apt-get install -y --no-remove -- …` configures 0.9.18; plus a dependency-missing offline variant (repack 0.9.18 with an uninstallable Depends) expecting exit 100, 0.9.17 intact, the error banner shown, and no second prompt.
6. **Repack checks** in `tauri-packaging-config.test.ts` / a finalize-deb test: `dpkg-deb -f … Depends` equals `bubblewrap, xdg-dbus-proxy, libayatana-appindicator3-1 | libappindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0` (order as the bundler emits), `Recommends` equals the four soft packages, no `Pre-Depends`, no maintainer scripts.

What to tell the user: run5 failed on a dependency class error, not on the relauncher; stock Ubuntu desktops never reach the failing branch after the split; networked non-stock machines succeed; the only destructive path left needs a machine with neither WebKitGTK 4.1 nor working apt lists, and the README now carries the one-line recovery. The Tauri updater stops using `dpkg -i` and cannot remove the app.

## What to avoid

- Adding `desktop-file-utils` to the harness image to make run5 pass; that hides the class of failure instead of fixing the package.
- Any Depends entry that is "nice to have"; each one is a potential removal trigger under an updater you cannot change.
- `Pre-Depends`, `preinst` guards, apt.conf payloads, or a bridge release as the fix for this incident (see B).
- Keeping `apt-get install -f` anywhere in product code; `-f` is a repair tool whose resolver is allowed to remove the package it is repairing.
- Using `apt` (not `apt-get`) under pkexec; its CLI is not stable and it prints a warning to stderr that would land in the banner.

## Alternatives and trade-offs

1. **Keep Depends as-is and document.** Zero code change; leaves a silent-removal path open on any non-stock machine and a tray-library swap that removes third-party packages. Weaker.
2. **Pre-Depends on WebKit (never destructive policy).** Protects offline non-GNOME machines; makes every online non-GNOME machine loop silently on 0.9.16 forever. Choose only if "never destructive" outranks "usually succeeds"; evidence says the online case is the common one.
3. **Bridge Electron 0.9.17 that installs with `apt-get install ./deb`.** Correct behaviour, but a release cycle, a staged window, and no guarantee users pass through it. Reserve for the flip condition in B.

## Work checklist

1. `src-tauri/tauri.linux.conf.json`: `deb.depends` → `["bubblewrap","xdg-dbus-proxy"]`; add `deb.recommends` → `["desktop-file-utils","xdg-utils","gstreamer1.0-plugins-good","gstreamer1.0-pipewire"]`.
2. `src-tauri/linux/finalize-deb.ts`: after `dpkg-deb -R`, rewrite the control `Depends` token `libayatana-appindicator3-1` to `libayatana-appindicator3-1 | libappindicator3-1`; assert the result with `dpkg-deb -f`.
3. `scripts/tauri-packaging-config.test.ts` (lines 288-324) and a finalize-deb test: new Depends/Recommends expectations; no `Pre-Depends`; no scripts.
4. `src-tauri/src/updater/install.rs`: single-command plan `pkexec apt-get install -y --no-remove -- <package>`; drop `fix_dependencies`; keep the pkexec dismissed/blocked handling; update the four deb tests and the module doc; add a mapped message for unmet dependencies with the manual `sudo apt install ./<path>` hint (new locale keys in `en.ts` and `vi.ts`).
5. Harness: `sai-atlas-update.rules.in` new allowed line; Dockerfile parameterised per D; add rows 1-3 and 5; keep row 4 as evidence.
6. README Linux section and the 0.9.17 release body: non-GNOME pre-step and the recovery command; note that the Tauri updater installs with `apt-get`.
7. Rebuild the deb, rerun the handover harness rows, then the host cutover per the Phase 11 plan.

## Success metrics

- Row 1 timeline shows one `dpkg -i` and no `apt-get`; 0.9.17 configured; relaunch and data checks pass.
- Row 2 ends configured with no `Remove:` in apt history.
- Row 5 shows exactly one polkit exec request per install, and the dependency-missing variant leaves 0.9.17 installed with a visible error.
- `dpkg-deb -f` of the shipped 0.9.17 shows the five-entry Depends with the alternation and the four-entry Recommends.
- Host: `dpkg -s sai-atlas` reports 0.9.17 `install ok installed` after the in-app update from 0.9.16, with no package removed (`grep Remove /var/log/apt/history.log`).

## Assumptions

- The supported population is Ubuntu 24.04+ desktops as the README states, GNOME-like, with apt lists maintained by update-notifier (high). A SAI OS image that strips WebKitGTK 4.1 or runs offline would reopen B's bridge/Pre-Depends question.
- `libappindicator3.so.1` from Ubuntu's `libappindicator3-1` renders the tray through `libappindicator-sys`'s fallback (high from code; not exercised in a container this session).
- The bundler inside tauri-cli 2.12.1 honours `deb.recommends` as tauri-bundler 2.10.1 does (high; the field exists in tauri-utils 2.10.1 and the CLI's embedded bundler is newer).
- Debconf frontend warnings under pkexec are harmless (high; dpkg configured the package in that state).
- The "1 to remove" in the networked runs was `libappindicator3-1` only (verified by `apt-get -s`); other conflicts on real machines are unknown (medium), which is why `--no-remove` is on the Tauri command.

Status: DONE_WITH_CONCERNS
Summary: Split the deb into a minimal hard Depends (WebKit, GTK, bwrap, xdg-dbus-proxy, tray library as an alternation) plus Recommends, and move the Tauri updater to one `apt-get install -y --no-remove -- <deb>` call; stock 24.04/26.04 desktops then configure at `dpkg -i` time and the updater can no longer remove the app. Concerns: two user decisions stay open with a recommended default of "no" (bridge release; Pre-Depends), and the host-side single-prompt behaviour and tray fallback library are inferred from code, not yet exercised outside containers.
