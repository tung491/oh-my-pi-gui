# Phase 8 report: updater, bundles, release feeds, CI (module `updater`)

Phase 8 is complete. `bash scripts/check-module.sh updater` ends with `check-module updater: PASS` on the committed tree. Every Task Verify passes, including the desktop-entry grep the controller corrected. The built `.deb` contains `usr/lib/Sai ATLAS/omp` (`-rwxr-xr-x`), and its Depends lists `bubblewrap, xdg-dbus-proxy`. There are two recorded deviations: the sidecar config overlays and the `.deb` finalize step. Both were taken on kongming counsel, and neither touches a frozen file.

- Worktree: `/home/tung491/WORK/worktrees/tauri-updater`
- Branch: `tauri/updater`, 8 commits on `10cf8a5` (tip `f80c0ee`), tree clean, not pushed

## Per task

### Task 8.1: Updater state machine (`41579b4`)

**What was built:** `src-tauri/src/updater/state.rs` ports every listed function of `updater-state.ts` and its 19 tests, with the same names. It also holds the serde `UpdateStatus`/`UpdateInstallMode` types, tagged `state` with camelCase fields.

**Verify:**
- `cargo test --manifest-path src-tauri/Cargo.toml updater::state` gives `19 passed`.
- `bun scripts/check-test-parity.ts updater` gives `19 tests mirrored across 1 files`.

### Task 8.2: Feeds, download and install (`405bafd`, delegated to Fable)

**What was built:** `feed.rs` (286 lines), `install.rs` (339), `mod.rs` (1396) and `ipc.rs` (67), plus 13 lines in `state.rs`.

**Verify:**
- `cargo test … updater::` gives `66 passed; 0 failed`.
- `grep -c "IpcError::not_ported" src-tauri/src/updater/ipc.rs` prints `0`.
- clippy (`-D warnings -D clippy::unwrap_used -D clippy::expect_used`) is clean.
- No `unsafe`, `todo!`, `unimplemented!` or `#[ignore]` remain in the module.

### Task 8.3: Bundle configuration (`d5a2b27`, `a33ee6a`)

**What was built:**
- `tauri.conf.json`: `bundle.active: true`, the icon list, `category: "DeveloperTool"` and `plugins.deep-link.mobile: []`. Every Phase 2 value is kept.
- `tauri.macos.conf.json`, `tauri.windows.conf.json` and `tauri.linux.conf.json`. The Linux file carries Depends, the `desktopTemplate`, and the `package-type` marker through `deb.files`.
- `Info.plist`, `macos/app.entitlements` (audio-input only), `macos/omp.entitlements` (JIT and unsigned-executable-memory only) and `windows/hooks.nsh`.
- `linux/vn.io.vif.saiatlas.desktop` and `linux/finalize-deb.ts`.
- `scripts/stage-tauri-sidecar.ts`, the four `package:tauri:*` scripts and `gen:icons:tauri`.
- The icons, regenerated with `bunx tauri icon`.

**Verify:** `bun run package:tauri:linux` (run under `nice -n 10`) exits 0. With `$B` = `src-tauri/target/x86_64-unknown-linux-gnu/release/bundle`:

| Check | Result |
|---|---|
| `$B/appimage`, `$B/deb` | one `Sai ATLAS_0.9.15_amd64.AppImage`, one `Sai ATLAS_0.9.15_amd64.deb` |
| `dpkg -c … \| grep -cE "applications/[^/]+$"` (amended Verify) | `1`: `./usr/share/applications/vn.io.vif.saiatlas.desktop` |
| `dpkg -I … \| grep Depends` | `libwebkit2gtk-4.1-0, libayatana-appindicator3-1, gstreamer1.0-pipewire, gstreamer1.0-plugins-good, bubblewrap, xdg-dbus-proxy, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`; `gstreamer1.0-plugins-bad` count `0` |
| `dpkg -c … \| grep -c apparmor` | `0` |
| `dpkg -c … \| grep -cE "usr/bin/omp$"` | `0` |
| `dpkg -c … \| grep "usr/lib/Sai ATLAS/omp$"` | `-rwxr-xr-x root/root 300586464 … ./usr/lib/Sai ATLAS/omp` |
| `/opt` compat link | `lrwxrwxrwx root/root … ./opt/Sai ATLAS/sai-atlas -> /usr/bin/sai-atlas` |
| `dpkg -x` into scratch, then `"…/usr/lib/Sai ATLAS/omp" --version` | `omp/18.4.8`, exit 0 |
| `--appimage-extract` into scratch, then `test -x "squashfs-root/usr/lib/Sai ATLAS/omp"` | exit 0; `--version` prints `omp/18.4.8`, exit 0 |
| AppImage desktop entry | `StartupWMClass=vn.io.vif.saiatlas`, `Exec=sai-atlas %U`, `MimeType=x-scheme-handler/omp;`; no deb marker inside |

The scratch extractions were deleted afterwards. The old literal `grep -c "applications/"` prints `2`, as expected after the `dpkg-deb` repack.

### Task 8.4: Packaging invariant tests (`3e50a27`, extended in `a33ee6a` and `0a4e9a2`)

**What was built:** `scripts/tauri-packaging-config.test.ts`, with one test per product invariant and every test the spec names. Three additions:
- a guard that no base or platform config declares `externalBin` or `resources`, plus a guard that each `package:tauri:*` script stages its triple and passes its overlay;
- a real `dpkg-deb` round-trip test of `finalize-deb.ts`;
- a guard for the `tauri-linux` CI job.

**Verify:** `bunx vitest run scripts/tauri-packaging-config.test.ts` gives 30 passed.

### Task 8.5: Release feeds (`8c5a806`)

**What was built:** `scripts/release-feeds.ts` and its test. It writes the invariant asset names, the `omp-` bridge DMG copies, and `latest-linux.yml`, `latest-mac.yml` (with `minimumSystemVersion: 22.4.0`) and `latest.yml`. For the Linux-first cutover, it merges the Electron `latest-mac.yml`/`latest.yml` unchanged, along with their assets. It refuses any macOS feed that fails `macUpdateFloorError`. `releaseDate` is single-quoted so js-yaml keeps it a string. The feed omits `blockMapSize`, and the 0.9.15 AppImageUpdater then falls back to a full download (`AppImageUpdater.js:66-69`).

**Verify:** `bunx vitest run scripts/release-feeds.test.ts` gives 6 passed: the five named tests plus "merges the Electron feeds unchanged".

### Task 8.6: CI (`0a4e9a2`)

**What was built:** a `tauri-linux` job, with the existing `linux` job left byte-identical.
- Actions are pinned to SHAs (`actions/cache` v4 = `0057852b…`) and checkout uses `persist-credentials: false`.
- It installs the Task 0.1 apt packages, the toolchain from `rust-toolchain.toml`, and `PUBLIC_API_TOOLCHAIN` and `CARGO_PUBLIC_API_VERSION` from `rust-pins.env`, then runs `cargo install tauri-cli --version "^2" --locked`.
- It sets `CARGO_HOME_BIN=/home/runner/.cargo/bin` and caches `src-tauri/target`.
- It then runs bun install, `build:renderer:tauri`, clippy, `cargo test --all-features`, and `BASE="$(git merge-base HEAD origin/main)" bash scripts/check-module.sh foundation`.

**Verify:**
- `bunx vitest run src/main/packaging-config.test.ts` gives 25 passed, with no assertion changed.
- `actionlint .github/workflows/ci.yml` exits 0, using v1.7.12 downloaded to the scratchpad. shellcheck is not installed, so actionlint's embedded shell check did not run.

### Task 8.7: Module gate

**Verify:** `bash scripts/check-module.sh updater` exits 0 and its last line is `check-module updater: PASS`. Gates 1 to 8 pass. Gate 8 ran 140 tests (default) and 141 (`e2e-hooks`), plus the 2 channel tests and vitest at 71/71. Gate 9 printed WARN for both cross targets (platform SDK missing).

**Commit:** each task was committed on its own, so the tree was clean at the gate and no separate `build(gui): package and update the Tauri shell` commit was made. If the controller wants that message, it can be added as an empty commit.

### Completion check

- `git diff 10cf8a5 -- src-tauri/contracts` is empty.
- `cargo test --all-features` gives 141 + 2 passed.
- `check-test-parity.ts updater` passes.
- There is no `todo!`, `unimplemented!`, `#[ignore]` or `tauri_plugin_` call in the module, and no `downcast_ref` other than to `Updater`.

## Task 8.2: delegated result and my review

**Delegation:** the task ran on `fable` as the plan requires. The first delegate died to the rate limit without writing anything. The second wrote about 2,000 lines and died before committing. The third, also on Fable, resumed from that uncommitted tree: it fixed one clippy failure (an unused import) and removed a redundant pre-pkexec hash of the `.deb`, then verified and committed `405bafd`.

**My review of the root-run path:**
- `install.rs` builds `["/usr/bin/pkexec","/usr/bin/dpkg","-i","--",<abs path>]`. Only when that fails with a non-pkexec status does it run `["/usr/bin/pkexec","/usr/bin/apt-get","install","-f","-y"]`. This ports `DebUpdater.js:51-62` without the `/bin/bash -c` wrapper from `LinuxUpdater.js:50`.
- It refuses relative or non-UTF-8 paths and re-checks the SHA-512 immediately before the privileged call.
- pkexec 126/127 (dismissed or not authorized) skips the dependency fix.
- The runner is an injectable `PrivilegedRunner`, so tests record argv and never spawn pkexec. The three required tests exist.
- The TOCTOU window is documented at `install.rs:108-117`.

**My review of `mod.rs`:**
- deb and AppImage installs ask `approve_quit_before_install` first, then arm `relaunch_after_exit` (`/usr/bin/sai-atlas` or `$APPIMAGE`, no arguments) before `exit(0)`. A failure withdraws the approval and reports `updates.installFailed (<detail>)`.
- The AppImage is swapped atomically (copy beside, chmod, rename).
- `shutdown` installs only when `installs_on_quit` holds (never a deb) and does nothing that waits on the main thread.
- The first check (3 s), the 4 h timer and `check_now` go through `spawn_task` and hold a `Weak` context.
- One build-time base constant (`SAI_ATLAS_UPDATE_BASE`) serves both the feed and download URLs.

I accept it.

**Choices it made, for the controller to note:**
- macOS mode is always `manual`, because the Tauri bundle is ad-hoc signed and has no Squirrel flow. `OMP_DEV_UPDATE_MODE` and the codesign probe are dropped.
- Linux and Windows packages download to `~/.cache/@oh-my-pi/omp-gui/updates`, which is cleared before each download except the partial being resumed. A partial left by the Electron build (`~/.cache/sai-atlas-updater/pending`) therefore does not resume.
- On Windows, the NSIS installer starts directly, with `/S` only at quit, and electron-builder's `--updated`/`--force-run` are not passed. Phase 12 verifies this.

## Package sizes against the spike (S12)

| Package | This build | Spike baseline | Change |
|---|---|---|---|
| `.deb` | 178,760,164 B = 170.48 MiB | 169.88 MiB | +0.4% |
| AppImage | 259,930,616 B = 247.89 MiB | 245.73 MiB | +0.9% (Electron: 283 MB) |

Both are within 10% of the baseline, so no explanation is needed. The `sai-atlas` binary is 32.8 MB against the spike's 22.8 MB, because it now contains the real modules.

## Deviations

1. **Sidecar entries live in bundle-only overlays** (kongming counsel). The spec puts them in `tauri.<os>.conf.json`. They are in `src-tauri/{linux,macos,windows}/sidecar.conf.json` instead, passed only by `package:tauri:*` as `cargo tauri build --target <triple> --config <overlay>`.
   - Why: tauri-build copies `externalBin` and `resources` at compile time and fails when they are missing (`tauri-build-2.7.1/src/lib.rs:725-765`, `tauri-utils-2.10.1/src/resources.rs:207`). The spec's placement would break every `cargo build/test/clippy`, the new CI job and gate 9 unless a 300 MB file were staged.
   - Intent is kept: no `/usr/bin/omp`, the sidecar at `lib/Sai ATLAS/omp`, and `externalBin` on macOS and Windows.
   - Plan amendment needed: Task 8.3 steps 1, 3 and 6.
2. **The `.deb` desktop entry and `/opt` symlink come from a repack** (kongming counsel). tauri-bundler always writes `<productName>.desktop` (`freedesktop/mod.rs:98-110`), and `deb.files` can only add files. It also archives symlinks as copies of their targets (`debian.rs:354-378`). So `package:tauri:linux` ends with `src-tauri/linux/finalize-deb.ts`, which runs `dpkg-deb -R`, renames the entry, adds the dpkg-owned symlink, regenerates md5sums, and rebuilds with `dpkg-deb --root-owner-group -Zgzip -b` under the same file name. Plan amendment needed: step 3, "through `deb.files`" becomes "through `finalize-deb.ts`".
3. **The deb carries a `package-type` marker** at `/usr/lib/Sai ATLAS/package-type`, containing `deb`. It gives the ported `package_type_at` a real input, mirroring electron-builder's marker; the AppImage has none.
4. **The desktop-entry grep was corrected by the controller.** This is a plan correction, not a deviation.
5. **No final Task 8.7 commit**, because every task was already committed (see Task 8.7).

## Follow-up after the controller's decisions (`f80c0ee`)

- **Deb metadata:** the controller asked for the values of the approved Electron package. `tauri.linux.conf.json` now sets `publisher` (which the bundler writes as Maintainer, because Cargo.toml has no authors), `homepage`, `shortDescription` and `longDescription` (both the `package.json` description). Keeping them in the Linux config leaves the Windows NSIS publisher and the macOS bundle unchanged. A new test asserts all four values, so they cannot regress.
  - Rebuilt with `nice -n 10 bun run package:tauri:linux`, exit 0.
  - `dpkg-deb -f <deb> Maintainer Homepage Description` prints `Maintainer: Tung Son Do <dosontung007@gmail.com>`, `Homepage: https://github.com/tung491/oh-my-pi-gui` and `Description: Sai ATLAS, the AI assistant for SAI OS: a desktop GUI for the omp coding agent`, followed by the same text as the long description.
  - The layout checks still hold: one `applications/` file, sidecar `-rwxr-xr-x`, the `/opt` symlink. The deb is now 178,760,306 B (170.48 MiB) and the AppImage is unchanged at 259,930,616 B.
  - The gate passes again (`check-module updater: PASS`, vitest 72/72, gate 9 WARN for both cross targets). The packaging tests now number 31.
- **Cache path:** kept at `~/.cache/@oh-my-pi/omp-gui/updates` (controller decision).
- **Empty Task 8.7 commit:** skipped (controller decision).
- **Plan wording** for the two deviations: left to the controller. No plan file was edited.

## Observations, not acted on
- tauri-bundler appends its default Depends, so three dependencies appear twice. dpkg accepts this.
- When the 0.9.15 deb upgrades to this one, the old postrm runs `update-alternatives --remove sai-atlas '/opt/Sai ATLAS/sai-atlas'`. kongming verified in dpkg 1.23.7 (`update-alternatives.c` path-classify guard, present since dpkg 1.15.1) that a master link which has become a regular file is not unlinked, so `/usr/bin/sai-atlas` survives. Nothing extra ships in Phase 8. Phase 10 Task 10.5 should check three things read-only after the real upgrade: `/usr/bin/sai-atlas` is a regular file, `/etc/alternatives/sai-atlas` is absent, and `update-alternatives --query sai-atlas` exits non-zero.
- The Windows portable target has no Tauri equivalent.
- The macOS and Windows configs, `hooks.nsh` and the `cfg(macos|windows)` updater branches were not built on this host (gate 9 WARN). Phase 12 builds and verifies them.

## Processes started and stopped

| Process | How it ran | End state |
|---|---|---|
| `bun run package:tauri:linux` | `nice -n 10`, background shell, ran to exit 0 | exited |
| `bash scripts/check-module.sh updater` | background shell, ran to exit 0 | exited |
| cargo test/check/clippy | foreground | exited |
| vitest | foreground | exited |
| `actionlint` | foreground | exited |
| AppImage `--appimage-extract` and `omp --version` | foreground, scratchpad | exited |

- No dev app, sidecar, supervisor, fixture or port-518x process was started.
- The final `ps` showed none of mine running.
- `resources/omp.linux-x64` is a hard link (gitignored) to the main checkout's copy, which matches the monorepo build at sha256 `248d61a1…`.
- `src-tauri/binaries/` (the staged sidecar) is gitignored.

## Baseline mtimes

| File | Start | End |
|---|---|---|
| `prefs.json` | 1790910017 | 1790910017 |
| `logs/gui-runtime.jsonl` | 1790951349 | 1790951349 |

- `sai-atlas 0.9.15` still reports `install ok installed`.
- `~/.local/share/applications/vn.io.vif.saiatlas.desktop` does not exist.
- Nothing was installed or uninstalled, and pkexec, dpkg -i and apt were never run. Nothing was published, tagged or pushed.

## NEEDS-HUMAN

1. **Publishing (Phase 11):** run `bun scripts/release-feeds.ts --version <v> --linux src-tauri/target/x86_64-unknown-linux-gnu/release/bundle --electron-mac-feed <electron dist>/latest-mac.yml --electron-windows-feed <electron dist>/latest.yml`, then upload `dist-release/*` to a `tung491/oh-my-pi-gui` release. Nothing was published here.
2. **Real self-update (Phase 10 Task 10.5)**, on a disposable VM or the handover machine. With 0.9.15 installed, serve a test build compiled with `SAI_ATLAS_UPDATE_BASE`, then confirm:
   - the deb path ends with `/usr/bin/sai-atlas` running Tauri and settings intact, plus the three alternatives checks above;
   - the AppImage path ends with the new image running and `APPDIR`/`LD_LIBRARY_PATH` reset by its `AppRun`.
3. **Desktop integration:** install the `.deb` on a test machine and check that GNOME shows one "Sai ATLAS" launcher, groups the window under it (`StartupWMClass`), and opens `omp://` links in the app.
4. **CI:** push `tauri/updater` (or the merged integration branch) and confirm the `tauri-linux` job is green on GitHub's runner. This was validated only by actionlint here.

## Open items

- **CI gate base (Phase 10 owns it):** the `tauri-linux` job runs `check-module.sh foundation` with `BASE=$(git merge-base HEAD origin/main)`. On a pull request or branch whose diff from `main` touches any non-foundation path (a module directory, `scripts/`, `.github/`), gate 1 fails with "files outside the module's ownership changed". Pushes to `main` pass, because the merge base is then HEAD.
- **Plan wording (controller):** Task 8.3 steps 1, 3 and 6, and the 8.4 test names, should describe the sidecar overlays and the deb finalize step.

Status: DONE
Summary: Phase 8 is complete on `tauri/updater` (8 commits, tip `f80c0ee`, gate PASS). The Rust yml-feed updater, the Linux bundles (deb 170.48 MiB with the Electron package's Maintainer, Homepage and Description; AppImage 247.89 MiB; sidecar at `usr/lib/Sai ATLAS/omp`; Depends with bubblewrap and xdg-dbus-proxy), the macOS and Windows configs, the release-feed script and the `tauri-linux` CI job are all in place.
Concerns/Blockers: two recorded deviations (sidecar overlays, deb finalize step) need plan amendments; the macOS and Windows builds are not verified on this host; the Windows portable target has no Tauri equivalent; the real self-update, publishing and the GitHub CI run are NEEDS-HUMAN.
