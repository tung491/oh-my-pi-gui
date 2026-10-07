# Pre-release packaging fixes (Tauri Linux)

Branch `tauri/p11-packaging` (worktree `/home/tung491/WORK/worktrees/p11-packaging`), four commits on `ae1d96e`, not pushed, not merged:

| Commit | Item |
|---|---|
| `82bc55b` fix(relaunch): stop the relaunched app cleanly when its unit stops | 1 |
| `1b77c9d` fix(deb): declare the omp:// registration tools and drop duplicate depends | 2 |
| `3d164ac` fix(tauri): keep the crate version equal to package.json's | 3 |
| `3cecab3` ci(tauri): replace the merge-base module gate with whole-tree checks | 4 |

## 1. KillMode=mixed

`systemd_run_args` now adds `-p KillMode=mixed -p TimeoutStopSec=15`. The doc comment and the args test are updated. I checked this on the host with the virtual display and the real user manager (systemd 259). Evidence is in `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/p11-killmode/` (`RESULT.txt`, one directory per run).

| Run | Journal at `systemctl --user stop` |
|---|---|
| Tauri 0.9.18, default | `Main process exited, code=killed, status=7/BUS`, `Failed with result 'signal'` |
| Tauri 0.9.18, mixed + 15 s | Stopping, then Stopped, with no failure line; stop took 0.13 s |
| Electron 0.9.16, default (control) | `status=7/BUS`, the same as Tauri |
| Electron 0.9.16, mixed + 15 s | clean stop |

The main PID was the app in every run. The FUSE server's parent is the user manager, so it is never the main PID. In every run the mount was gone and no unit process was left 2 s after the stop.

One detail differs from the brief: Tauri logs `shutdown finished` in both runs. In the default run the SIGBUS arrives after that line, while the process exits. So the journal line is the real signal, not the runtime log.

The host was left as it was: mimeapps md5 is `ca1dc4649ef173558754f4d870c961d2` (no restore was needed), no units, no mounts, and the display is stopped.

## 2. .deb Depends

The configured list is now `gstreamer1.0-pipewire, gstreamer1.0-plugins-good, bubblewrap, xdg-dbus-proxy, desktop-file-utils, xdg-utils`. I read the source to see how the final list is built:

- tauri-cli 2.12.1 (`src/interface/rust.rs`, `tauri_config_to_bundle_settings`) appends entries to the configured list. With the `tray-icon` feature on, it adds `libayatana-appindicator3-1` when pkg-config finds ayatana-appindicator3-0.1, which it prefers; otherwise it adds `libappindicator3-1`. It then always adds `libwebkit2gtk-4.1-0` and `libgtk-3-0`.
- tauri-bundler 2.10.1 (`src/bundle/linux/debian.rs:206`) writes the list joined in order and does not remove duplicates.

The build container installs only `libayatana-appindicator3-dev`, so the expected `Depends` is the six entries above followed by `libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`. Rebuilding the .deb to confirm this is left to item 5.

## 3. Crate version

`Cargo.toml` is now 0.9.16. `Cargo.lock` changed by one line, the `sai-atlas` package entry. A new test checks that the Cargo.toml `[package]` version equals package.json's.

There is no in-repo build mechanism that overrides the version. `tauri.conf.json` reads `version: "../package.json"`, and the release bumps package.json by hand. The 0.9.17 and 0.9.18 feeds came from an evidence script outside the repo, `/home/tung491/WORK/worktrees/stage-c/build-bundles.sh`. It edits package.json with `sed` for each bundle and restores it in an `EXIT` trap. It does not touch Cargo.toml, so those test bundles log the crate version (0.9.15) before the Tauri context exists.

If that script is used again for test bundles, it needs the same `sed` on the first `^version = ` line of `src-tauri/Cargo.toml`. It should also restore `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` in its trap, because `cargo tauri build` is not `--locked` and rewrites the lock line. I did not edit it because it is outside my file list. A real release only needs both files bumped, and the new test enforces that.

## 4. CI gate

`check-module.sh` has two kinds of gates:

- **Diff-based (needs BASE):** gate 1 (ownership) and the renderer biome step.
- **Whole-tree but scoped to one module's files:** gates 2, 5 and 6, plus gate 7 (that module's parity).
- **Whole-tree:** gate 3 (API snapshots), gate 4 (clippy), gate 8 (cargo test) and gate 9 (cross-OS check, skipped with a warning without the SDKs).

I moved gate 3 into a function and added a `snapshots` mode. It runs only that gate, over every `contracts/*.api.txt`, with no BASE. The CI step is replaced by:

- a parity loop over every `src-tauri/contracts/*.parity.json`;
- `bash scripts/check-module.sh snapshots`.

The `fetch-depth: 0` setting, which only the merge-base needed, is gone. The clippy and cargo test steps are unchanged. The CI test now asserts the new commands and that no step uses `merge-base`.

## Verify

- `cargo test --all-features`: `754 passed` (lib) plus the integration tests (3, 2, 3 passed), exit 0.
- `cargo clippy --all-targets --all-features -- -D warnings`: exit 0.
- `bunx vitest run`: `Test Files 211 passed`, `Tests 1969 passed`.
- `bun run check:types`: exit 0.
- `bunx biome check` on the touched TS file: clean. The JSON config file is excluded by biome's config.
- Parity loop: all seven modules mirrored (desktop 111, foundation 13, ollama 96, omp 35, services 35, tabs 46, updater 19).
- `check-module.sh snapshots`: `PASS (desktop ollama omp ports services tabs updater)`. A deliberately changed `omp.api.txt` made it fail at gate 3 with exit 1, and I restored the file.

Status: DONE
Summary: All four fixes are committed on tauri/p11-packaging and every verify step passes. The host check shows the default unit stop kills both Tauri and Electron AppImages with SIGBUS, and KillMode=mixed stops them cleanly.
Concerns/Blockers: None for this branch. The out-of-repo `stage-c/build-bundles.sh` does not bump Cargo.toml; test bundles built with it will log the crate version before the Tauri context exists (see item 3).
