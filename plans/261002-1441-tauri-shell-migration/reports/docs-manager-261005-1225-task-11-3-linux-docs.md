# Task 11.3: docs for the Linux switch to Tauri

Worktree `/home/tung491/WORK/worktrees/linux-docs`, branch `tauri/linux-docs` (based on `01cdfc0`). Three commits, not pushed:
- `1e5c0a6` README
- `3a87b5d` AGENTS.md
- `c8cb938` CHANGELOG

## What changed

**README.md (English, and the 中文 section the same way; it is the only translation)**
- **Install:**
  - Ubuntu 24.04+ (glibc 2.39).
  - `.deb` layout: `/usr/bin/sai-atlas`, the agent at `/usr/lib/Sai ATLAS/omp` off `PATH`, the `/opt/Sai ATLAS/sai-atlas` compat link.
  - `bubblewrap` and `xdg-dbus-proxy` are Depends. The sandbox is always on and no AppArmor profile ships.
  - `omp://` needs `desktop-file-utils` and `xdg-utils`, which are Recommends: `apt install` adds them, `dpkg -i` skips them.
- **`.deb` update note, rewritten for the Rust updater:**
  - It downloads to the user cache, checks the SHA-512, asks once and installs with `apt-get install --no-remove`.
  - When dependencies cannot be resolved, it keeps the installed version and shows `sudo apt install <path>`.
  - The user-writable-cache caveat is kept.
- **AppImage:**
  - Host needs `libwebkit2gtk-4.1-0`, which brings `bubblewrap` and `xdg-dbus-proxy` (checked with `apt-cache depends` on this 26.04 host).
  - No AppArmor profile. The profile block and the `~/Applications` fixed path are removed.
  - Audio goes through the PulseAudio socket.
  - It registers `omp://` for itself at startup.
  - Spell checking does not work in the AppImage on 26.04.
- **Display and startup:** `GDK_BACKEND=x11` replaces `--ozone-platform=x11`. The `XDG_RUNTIME_DIR` requirement is stated.
- **New block "Migrating from 0.9.16 on Linux":**
  - the three verbatim lines;
  - the welcome screen showing once more;
  - the ozone→GDK note, plus the systemd-user-session environment;
  - how to remove the old AppArmor profile.
- **Build from source:**
  - `package:linux` = the container build (11.2 end state), with its output directory;
  - sidecar staging;
  - Rust toolchain plus the Phase 0 Task 0.1 apt list;
  - `dev:tauri` with a throwaway profile;
  - the Electron dev `userns` profile, moved here as its own block because the troubleshooting row pointed at the deleted AppImage profile.
- **Troubleshooting:**
  - Removed: the `--no-sandbox` row, the password-twice row and the `--gtk-version=3` row.
  - Added: missing `libEGL.so.1` (matrix row b), `Failed to fully launch dbus-proxy` (`XDG_RUNTIME_DIR`), the "can't ask for administrator access" reopen, and the manual `sudo apt install` banner.
- **Release process:**
  - bump `Cargo.toml` with `package.json`;
  - Linux step: `package:linux` with `SAI_ATLAS_UPDATE_BASE` unset, `tauri-deb-smoke.sh`, the `OMP_E2E_FAKE_MIC=1` run and `tauri-wm-geometry-check.sh`;
  - `release-feeds.ts` writes `dist-release/` and `latest-linux.yml`;
  - publish as a draft first.
- **Intro line:** every package bundles the agent, not only "the Electron app".

**AGENTS.md** (same structure; macOS and Windows Electron text untouched)
- **Repo identity:** the publishing repo now covers both updaters (`feed.rs`), and the commit-example comment now says `tung491/oh-my-pi-gui` (it said `nornzach`, which was wrong).
- **New "Linux (Tauri) packaging" subsection:**
  - the config files and `sidecar.conf.json`;
  - staging to `/usr/lib/Sai ATLAS/omp` and `$APPDIR/...`, versus `externalBin` on macOS and Windows;
  - `package:linux` = `tauri-linux-build.sh`, with the glibc floor;
  - the `finalize-deb.ts` assertion: edit `DEB_DEPENDS`/`DEB_RECOMMENDS`, never the assertion;
  - the `finalize-appimage.ts` GStreamer allowlist and the Dockerfile kept in step with it;
  - the updater's single apt command and the compiled-in feed base.
- **Build/Test/Release:**
  - Rust clippy, `cargo test`, the parity and snapshot gates;
  - `test:e2e:tauri`;
  - the Linux build line;
  - the release flow: the Cargo bump, the Tauri smoke/probe/geometry/feeds steps, publish as a draft first, and the release body copying the Migrating lines;
  - CI's two jobs.
- **Out of sight:** the Tauri e2e and `dev:tauri` commands, and `tauri-deb-smoke.sh` replacing `deb-smoke.sh`.

**CHANGELOG.md**
- The file's convention for an unreleased version is the `## [Unreleased]` heading; the release commit renames it to `## [x.y.z] - date` (see `618fcf5`). The entries went there, not under a new `0.9.17` heading.
- Sections: Changed (Linux items plus "macOS and Windows are unchanged"), Removed (AppArmor profiles) and a new "Known issues" heading. The file never used that heading before.
- Known issues: the two residual-risk lines, the 26.04 spell-check note, `XDG_RUNTIME_DIR`, the welcome screen showing once more, and the update downloading again after a reopen.
- The memory line states only what `parity-report.md` measured: idle shell PSS is 72–75 % of Electron's, and the total is lower in every row.

## Verify

- `grep -n "ozone-platform" README.md` prints lines 187 and 562. Both are in the "Migrating from 0.9.16 on Linux" block (English, and the Chinese heading that also carries the English title). **PASS.**
- The three verbatim lines each appear exactly once in README (English) and CHANGELOG, matching the phase file byte for byte (`grep -cF`).
- Every documented path and script name exists in the worktree. `package:linux` still points at electron-builder here; the docs describe the Task 11.2 end state (`bash scripts/tauri-linux-build.sh`), as instructed.
- **Ran on this machine:**
  - `bun install --frozen-lockfile`: the worktree had no `node_modules`; this is a local install only, and the lockfile is unchanged.
  - `bun run build:renderer:tauri`: exit 0.
  - `bun scripts/stage-tauri-sidecar.ts`: prints its usage, exit 2.
  - `bun scripts/stage-tauri-sidecar.ts x86_64-unknown-linux-gnu`: the expected "resources/omp.linux-x64 is missing" error. Building the sidecar needs the monorepo, and this worktree is not inside it.
  - `bun scripts/release-feeds.ts`: "--version is required".
  - `bun run dev:tauri` without a profile: the expected refusal, with the documented throwaway-profile hint.
  - `bash -n` on `tauri-linux-build.sh`, `tauri-deb-smoke.sh` and `tauri-wm-geometry-check.sh`: syntax OK.
  - `cargo tauri --version`: 2.12.1. `rustup show active-toolchain`: stable.
  - `dpkg -s` on every package in the apt line: all installed.
  - `docker --version`: present.
  - vitest on `ChangelogDialog.test.tsx` (it renders the bundled CHANGELOG) and `launchable-path.test.ts`: 20/20.
- **Verified that they exist, not run:**
  - `bun run package:linux` / `tauri-linux-build.sh`: a full container build of about 20 minutes. It has no `--help`, and an argument is taken as the target directory.
  - `tauri-deb-smoke.sh`, the `OMP_E2E_FAKE_MIC=1` run and `tauri-wm-geometry-check.sh`: they need a built `.deb`.
  - `build:omp:linux`: needs the monorepo.
  - `dev:tauri` with a profile: a long-running cargo build plus the app.
  - The rustup install, `cargo install tauri-cli` and `sudo apt-get install`: these install software. The resulting tools are already present.
  - The clippy and `cargo test` gates: cited from `ci.yml` and `tauri-packaging-config.test.ts`.

## Not verifiable now

- The input-method sentence ("try `GDK_BACKEND=x11` if ibus/fcitx5 fails on native Wayland") is kept but narrowed to a fallback. Kongming asked for it to be re-checked in host sitting item 7 before the release.
- "The copy that reopens by itself after the update can take its environment from your systemd user session": source evidence only (`relaunch.rs`). The systemd-run `.deb` route is sitting item 1.
- AppImage `omp://` self-registration: source evidence only (`desktop/deep_link.rs` gate plus `tauri-plugin-deep-link` 2.6.1 `register` using `$APPIMAGE`). No container row observed it.
- `src-tauri/target-linux-2404/` and `dist-release/` are not gitignored (`git check-ignore` prints nothing for them). This is outside docs scope; flagged for the 11.2 or 11.4 owner.

Status: DONE_WITH_CONCERNS
Summary: README (English and Chinese), AGENTS.md and CHANGELOG now describe the Tauri Linux packages, the 11.2 end state of `package:linux`, and the three verbatim migration lines. The ozone grep passes and the cheap build-section commands ran.
Concerns/Blockers: the input-method and systemd-environment sentences wait on the host sitting; the CHANGELOG uses `[Unreleased]` per the file's convention, plus a new "Known issues" heading; two build output directories are not gitignored.
