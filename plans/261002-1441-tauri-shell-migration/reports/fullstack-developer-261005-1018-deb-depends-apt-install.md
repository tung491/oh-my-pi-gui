# Deb Depends split and single apt-get install

Branch `tauri/p11-depends` (worktree `/home/tung491/WORK/worktrees/p11-depends`), two commits on top of 24a8731, not pushed:

- `6775975 build(deb): keep only start-critical packages in Depends`
- `272b6fe fix(updater): install debs with one apt-get call that cannot remove the app`

## New pkexec command line (the harness polkit rule must match it)

```
/usr/bin/pkexec /usr/bin/apt-get install -y --no-remove -- <absolute package path>
```

polkit sees `/usr/bin/apt-get install -y --no-remove -- <deb>`. This is now the only privileged command in a deb update. There is no `dpkg -i` step and no `apt-get install -f` step, so the updater asks for authentication once.

## What changed

1. `src-tauri/tauri.linux.conf.json`: `deb.depends` is now `["bubblewrap","xdg-dbus-proxy"]`. The new `deb.recommends` is `["desktop-file-utils","xdg-utils","gstreamer1.0-plugins-good","gstreamer1.0-pipewire"]`.
2. `src-tauri/linux/finalize-deb.ts`:
   - Right after `dpkg-deb -R`, it rewrites tauri-cli's `libayatana-appindicator3-1` in `Depends` to `libayatana-appindicator3-1 | libappindicator3-1`. If the token does not appear exactly once, the build fails.
   - The rebuilt package is now written inside the scratch directory. Before it replaces the original, it is checked with `dpkg-deb -f` and `dpkg-deb -e`:
     - `Depends` must be exactly `bubblewrap, xdg-dbus-proxy, libayatana-appindicator3-1 | libappindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`.
     - `Recommends` must be exactly the four soft packages.
     - There must be no `Pre-Depends`.
     - The control archive may hold only `control` and `md5sums`, so no maintainer scripts or triggers.
   - If any check fails, the bundler's original deb is left untouched. The existing invariants are kept: the glibc floor, the desktop entry rename, the `/opt` compat symlink, fresh md5sums and gzip compression.
3. Tests:
   - `scripts/tauri-packaging-config.test.ts` has the new Depends and Recommends expectations, with comments on why the soft packages are Recommends and why the tray is an alternation. The round-trip test now asserts the control fields with `dpkg-deb -f`.
   - New file `scripts/finalize-deb.test.ts` covers the rewrite, field parsing, every assertion, and end-to-end finalize runs. One of those runs gives the deb a `postinst` and checks that it is refused and the original deb is byte-identical afterwards.
4. `src-tauri/src/updater/install.rs`:
   - `DebInstallPlan`, `fix_dependencies` and the `dpkg` constant are gone. They are replaced by `deb_install_command`.
   - Dismissed or not-authorized pkexec prompts still report as before. A blocked pkexec (`NoNewPrivs`) still leads to `ReopenRequired`.
   - The runner now keeps apt's whole stderr. The 400-character tail is cut only for display, so apt's key words are found even when they scroll out of the tail.
   - New `InstallError::UnresolvedDependencies { detail, command }`. It is raised when stderr matches any of these, case-insensitively: "unmet dependencies", "unable to correct problems", "unable to satisfy dependencies", or "packages need to be removed but remove is disabled". `command` is `sudo apt install <path>`, with the path shell-quoted when needed.
   - `src-tauri/src/updater/mod.rs` turns this into an error status with a new optional `manualInstallCommand` field (`src-tauri/src/updater/state.rs`, `src/shared/ipc-types.ts`).
   - `UpdateBanner` and `UpdatesSettingsPage` show `updater.unresolvedDependencies` (new key in both `en.ts` and `vi.ts`) with the command, in place of apt's output.
   - The module docs in `install.rs` and `mod.rs` are updated.

## Choices that differ from the advice

- **Two extra match strings.** The host runs apt 3.2 (Ubuntu 26.04). I ran `apt-get -s install --no-remove -- <deb>` there, and it does not print "Unmet dependencies" (capital U) or "Unable to correct problems". It prints "The following packages have unmet dependencies" and "E: Unable to satisfy dependencies". When `--no-remove` blocks a removal, it prints "E: Packages need to be removed but remove is disabled". I added the last two strings to the match list, and the hint fits both cases.
- **Locale pinned to `C`.** pkexec passes `LANG`, `LANGUAGE` and `LC_*` through to apt (checked with `strings /usr/bin/pkexec`), and apt has a Vietnamese translation. Without a fixed locale, matching would fail for Vietnamese users. The runner now sets `LC_ALL=C` and removes `LANGUAGE`. The polkit command line does not change.
- **Hint wording.** The hint is `sudo apt install /abs/path.deb`, not `./<path>`. The path is always absolute, and apt only needs the path to contain a slash.
- **Where the localized text lives.** The message is built in the renderer (keys in `en.ts`/`vi.ts`), following how the `reopenRequired` message already works. The Rust main-text table is not used for it.

## Checks run

All of these pass:

- `cargo test --all-features`: 765 lib tests plus the integration tests.
- `cargo clippy --all-targets --all-features -D warnings`.
- `bunx vitest run`: 212 files, 1994 tests.
- `bun run check:types`.
- `bunx biome check` on the touched files under `scripts/` and `src/`. Biome's config does not cover `src-tauri/`, and the existing `finalize-deb.ts` already has long lines biome would rewrap.
- The parity loop over all seven contracts.
- `check-module.sh snapshots`. Nothing in the public API changed; all the new items are `pub(crate)`.

The renderer was built once (`build:renderer:tauri`) so that `generate_context!` could compile; its output under `out/` is not tracked by git.

## Check on the real 0.9.18 payload

`finalize-deb.ts` does work on an existing deb, but the feed deb is already finalized: it already has the `/opt` symlink, so a second run would stop at "already exists". So I worked on a copy in the scratchpad instead:

1. Unpacked a copy of `stage-c/feed-0.9.18/sai-atlas_0.9.18_amd64.deb`.
2. Undid the finalize steps (removed the symlink, renamed the desktop entry back).
3. Set the control file to what the bundler will write with the new config.
4. Repacked it and ran `bun src-tauri/linux/finalize-deb.ts` on it.

It passed every check. `dpkg-deb -f` shows the five-entry Depends with the alternation and the four-entry Recommends, and the control archive holds only `control` and `md5sums`. `apt-get -s install -y --no-remove -- <result>` on the host simulated `Inst sai-atlas [0.9.16] (0.9.18 …)` with 0 packages to remove. The feed files were not touched, and the scratch copy is deleted.

## Ollama remedy

`src-tauri/src/ollama/remedy.rs` runs `pkexec systemctl start ollama.service` and `pkexec sh -c "curl -fsSL https://ollama.com/install.sh | sh"`. It never uses `dpkg` or `apt-get -f` and does not install a .deb, so I left it unchanged.

## Notes for later tasks

- The harness `sai-atlas-update.rules.in` needs the command line above, and its old dpkg/apt `-f` lines can be removed.
- The comments in `scripts/tauri-deb-smoke/Dockerfile` and `scripts/tauri-wm-geometry-check/Dockerfile` say "The .deb's Depends". The package lists still preinstall all nine packages, which is now Depends plus Recommends, so the images behave the same; only the comment wording is stale. I did not edit them because they were outside this task.
- README/CHANGELOG: not touched; that is the later docs task.

Status: DONE_WITH_CONCERNS
Summary: The deb now hard-depends only on bwrap, xdg-dbus-proxy, the tray alternation, WebKitGTK and GTK, with the soft packages in Recommends, and finalize-deb.ts refuses to finish any deb that differs. The Tauri updater installs with the single `pkexec apt-get install -y --no-remove --` command and shows a localized `sudo apt install` hint when apt cannot resolve dependencies.
Concerns/Blockers: Beyond the advice's two strings, I added two apt 3 match strings and pinned `LC_ALL=C` on pkexec, both based on what I found on the host. The deb itself was not rebuilt from source (the controller rebuilds after merge); the control fields were checked on a repacked copy of the 0.9.18 payload.
