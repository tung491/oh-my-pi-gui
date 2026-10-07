---
phase: 11
title: "Linux cutover release (Electron keeps shipping for macOS and Windows)"
status: pending
priority: P1
effort: "3d"
dependencies: [1, 10]
---

# Phase 11: Linux cutover release

## Goal

One release ships the Linux packages (AppImage and .deb) from the Tauri build and the macOS and Windows packages from Electron, as before. Installed Linux Sai ATLAS builds move to Tauri through their own updater. `main` carries both shells: Tauri for Linux, Electron for macOS and Windows until Phase 12.

## Preconditions

- Phase 10 Task 10.6 recorded "cut over Linux" in the Validation Log.
- The Phase 1 mirror release has been live for at least 7 days (or the period the Validation Log sets) on the channel the installed population updates from.
- The earliest tag date is 2026-10-09: v0.9.15 was published 2026-10-02 17:59 KST.
- The pre-release batch regression pass is recorded in the Validation Log (2026-10-05), and the host sitting has passed on the release bundles (Task 11.4 step 4b).
- `test -x resources/omp.linux-x64` succeeds (`plan.md` → Sidecar binaries).
- Every publishing step (push, tag, GitHub Release) needs the user's explicit go-ahead at that moment. Ask, then wait.

## Tasks

### Task 11.1: Rollback point
- Steps: on `main`, before merging, create the local tag `pre-tauri-linux`. Push it only when the user approves.
- Verify: `git rev-parse pre-tauri-linux` prints a commit hash.

### Task 11.2: Merge, and retire only the Linux Electron path
- Goal: `main` builds Linux from Tauri and macOS/Windows from Electron.
- Steps:
  1. `git switch -c tauri/linux-cutover main`, then `git merge --no-ff tauri/integration`.
  2. Delete `electron-builder.linux.yml`, `scripts/deb-smoke.sh` and `scripts/deb-smoke/` (Electron Linux only). Point `package:linux` at the container build `bash scripts/tauri-linux-build.sh`: a bare host build on 26.04 fails the glibc floor by design. Keep every macOS and Windows Electron script and config, and keep `e2e/packaged-smoke.e2e.ts`, which `e2e-tauri/check-twins.ts` names as the Playwright twin.
  3. In `src/main/packaging-config.test.ts`, delete the `Linux package config` describe block (lines 189-252 as of 2026-10-02) and the Linux entries in the artifact-name loop (line 302). The Tauri equivalents live in `scripts/tauri-packaging-config.test.ts`. Keep the macOS, Windows, CSP and CI blocks.
  4. Keep `e2e/` (Playwright, Electron) for macOS/Windows, and `e2e-tauri/` for Linux. `test:e2e` stays Electron; `test:e2e:tauri` is Linux.
- Verify: `bunx vitest run` exits 0, `bun run check:types` exits 0, `bun run build` exits 0 (Electron renderer and main), `bun run build:renderer:tauri` exits 0, `cargo test --manifest-path src-tauri/Cargo.toml --all-features` exits 0, and `scripts/virtual-display.sh run -- bun run test:e2e:tauri` exits 0. Push the cutover branch after approval, so both CI jobs run once (green) before anything merges into `main`. The `tauri-linux` job has never run on GitHub; treat a red first run as an environment problem, fix the workflow, and do not loosen the gates.

### Task 11.3: Docs for the Linux switch
- Targets: `README.md` (Linux install and build from source: Rust toolchain, the Linux packages from Phase 0 Task 0.1, the WebKit sandbox, which is always on and needs no AppArmor rule on Ubuntu 26.04 (S14) but requires `bubblewrap` and `xdg-dbus-proxy` on the host, which the `.deb` depends on and AppImage users must install themselves; replace the Electron `--ozone-platform=x11` advice with `GDK_BACKEND=x11`; update the in-app `.deb` update note, which describes electron-updater, so it describes the Rust updater's verified behavior), `AGENTS.md` (Linux packaging rules: Tauri config, sidecar staging (`scripts/stage-tauri-sidecar.ts`; on Linux the sidecar is a bundle resource installed at `/usr/lib/Sai ATLAS/omp`, off `PATH`; on macOS and Windows it is an `externalBin` beside the executable), `package:tauri:linux`, the `updater` feeds; Rust code lives in `src-tauri/` behind clippy and `cargo test` gates; the publishing repo from the Validation Log), `CHANGELOG.md` (a new version section).
- Content (`reports/kongming-pre-release-batch-close-advice.md` § D lists it in full):
  - **Install and runtime facts:**
    - the 24.04+ glibc floor;
    - the `.deb` layout with the `/opt` compat symlink;
    - `omp://` via the Recommends;
    - the AppImage host requirement `libwebkit2gtk-4.1-0`, and no AppArmor profile;
    - AppImage dictation and speech through the PulseAudio socket;
    - the one-prompt `apt-get install --no-remove` update with its manual-command fallback;
    - the standard `XDG_RUNTIME_DIR`;
    - the one-time "set up later" prompt;
    - `GDK_BACKEND=x11`;
    - build from source, and the release-process smoke and probe commands.
  - **Lines the README and the release body carry verbatim:**
    - "Updating from 0.9.16 on a desktop without GNOME, or any machine where `dpkg -s libwebkit2gtk-4.1-0` fails: run `sudo apt install libwebkit2gtk-4.1-0` first."
    - "If Sai ATLAS is missing after the update: `sudo apt --fix-broken install`, or download the package and run `sudo apt install ./sai-atlas_0.9.17_amd64.deb`."
    - "If Sai ATLAS does not reopen by itself after an update, start the new `.AppImage` once by hand; its file name now carries the version."
  - **`AGENTS.md`:**
    - the `finalize-deb.ts` Depends/Recommends assertion (edit `DEB_DEPENDS`/`DEB_RECOMMENDS`, not the assertion);
    - the GStreamer plugin allowlist;
    - `tauri-deb-smoke.sh` replacing `deb-smoke.sh`.
- Steps: read each file before editing it, change only the Linux and repo-identity sections, and update the translated README sections the same way.
- Verify: `grep -n "ozone-platform" README.md` prints only lines in the macOS/Windows or "Migrating" sections, and every Linux command shown in the README's build section runs successfully on this machine.

### Task 11.4: Release
- Steps (follow AGENTS.md → Release flow; each publishing step waits for the user's go-ahead):
  1. Sync upstream with `bash scripts/sync-upstream.sh`, then rebuild the sidecars in the monorepo clone (`plan.md` → Sidecar binaries). Re-run `scripts/virtual-display.sh run -- bun run test:e2e:tauri` (the real-core spec) against the rebuilt sidecar before building bundles.
  2. Bump `version` in `package.json` and `src-tauri/Cargo.toml` to the version the user chooses (default: next minor). `scripts/tauri-packaging-config.test.ts` fails if the two versions differ, and `cargo tauri build` rewrites one `Cargo.lock` line; commit it. Leave `src-tauri/tauri.conf.json` alone: its `"version": "../package.json"` already follows `package.json`, and that is the version `Host::app_version()` reports and the updater compares. Write the CHANGELOG section.
  3. Build the Tauri Linux packages (`bun run package:linux`, with `SAI_ATLAS_UPDATE_BASE` unset) and, on their hosts as today, the Electron macOS and Windows packages. Check the compiled-in feed base on both the `.deb`'s `/usr/bin/sai-atlas` and the AppImage's `usr/bin/sai-atlas`:
     - `strings <binary> | grep -c 'https://github.com/tung491/oh-my-pi-gui/releases'` prints `1`;
     - `strings <binary> | grep -c 127.0.0.1` prints `0`.
  4. Run `bun scripts/release-feeds.ts`. It writes `latest-linux.yml` from the Tauri bundles and passes the Electron `latest-mac.yml`/`latest.yml` through. Then run `bun run check:mac-update-floor dist-release/latest-mac.yml`.
  4a. Final container pass on the release bundles:
     - `dpkg-deb -f <deb> Depends Recommends` equals the two strings `finalize-deb.ts` asserts;
     - `bash scripts/tauri-deb-smoke.sh <deb>` passes 8/8;
     - `OMP_E2E_FAKE_MIC=1` passes on the `.deb` and on the AppImage in the 24.04 and 26.04 matrix rows;
     - `bash scripts/tauri-wm-geometry-check.sh <deb>` passes;
     - the Electron→Tauri handover harness passes: AppImage runs 1–3 and `.deb` rows 1–2, with a local feed set through the Electron side's `app-update.yml`.
     The Tauri self-update rows cannot run against a release binary, because its feed base is compiled in; the 2026-10-05 evidence stands for them.
  4b. Host sitting with these exact bundles (`reports/kongming-pre-release-batch-close-advice.md` § D, items 1–7):
     - the `.deb` handover on the `systemd-run` route, with one `pkexec` prompt and `NoNewPrivs 0`;
     - dictation in the `.deb`, and dictation and speech in the AppImage, with the real microphone;
     - the GNOME Wayland window size;
     - tray, the Wayland chord and notifications;
     - a clean unit stop;
     - the input method and spell checking.
  5. Smoke-test each package on its OS (sidecar `ready`, `get_settings`, one settings toggle). On Linux, also confirm `Seccomp: 2` on the WebKit web process, and that the installed `.deb` has no `/usr/bin/omp` and runs its sidecar from `/usr/lib/Sai ATLAS/omp` (`dpkg -L sai-atlas | grep -E "bin/omp$|lib/Sai ATLAS/omp$"` prints only the `/usr/lib` line).
  6. Merge into `main`, tag `vX.Y.Z`, and push `main` and the tag to the publishing repo's remote after approval.
  7. After approval, publish the GitHub Release on the publishing repo (`gh release create -R <publishing repo>`) with every file in `dist-release/`, the release notes, and the monorepo commit if it is not upstream `main`. Create it as a draft, upload every asset including `latest-linux.yml`, then publish: a partial asset set breaks both updaters' `latest/download` fetch.
- Verify: after publishing, `curl -sL https://github.com/<publishing repo>/releases/latest/download/latest-linux.yml | grep -c "version: X.Y.Z"` prints `1` (substitute the values), and a baseline Linux install (Validation Log) offers the update and lands on the Tauri build.

## Rollback

If the Tauri Linux packages have a blocking defect, build the Linux Electron packages from `pre-tauri-linux` with a version above the Tauri release, run the normal release flow, and publish. The Rust updater reads the same `latest-linux.yml`, so Tauri installs move back the same way Electron installs moved forward. The profile is shared, so settings carry both ways.

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
