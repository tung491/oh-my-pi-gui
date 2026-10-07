# Kongming advice: closing the Phase 11 pre-release batch

Date: 2026-10-05 (Asia/Seoul). Scope: Phase 11 of `plans/261002-1441-tauri-shell-migration`, `tauri/integration` at `ed9c281` (worktree `/home/tung491/WORK/worktrees/tauri-integration`), bundles under test at `9ef58a9` (deb) and `899ac58` (AppImage). Advisory only; nothing here was applied. Model: Claude Fable 5.1.

## TL;DR

The batch is complete against checklist items 4–10 as later amended: every code item is merged, verified at the commit it was built from, and nothing open blocks Task 11.2. The AppImage evidence at `899ac58` still holds; do not rerun it at `9ef58a9`, but do run one final Electron→Tauri pass on the actual release bundles, because they will differ anyway (upstream sync, version bump, `ed9c281`). Task 11.4 is still gated by the host sitting, by the 7-day precondition (v0.9.15 was published 2026-10-02 17:59 KST, so the earliest tag is 2026-10-09), and by the Task 11.3 docs that carry the residual-risk lines. Of the three new items: ship the AppImage spell-check gap as a release note and fix it in 0.9.18 (fix shape below; the enchant library has no module-path override, so it is a same-length string patch plus two bundled files); leave the bash-only placeholder tab alone for 0.9.17 (it is a product rule shared by both shells, not a migration defect); add the one-line LevelDB import log now (log-only, same class as `ed9c281`).

## Reframed problem

The question is not "did every commit land" but "is the set of evidence that will be true of the published 0.9.17 bundles sufficient, and what must still happen between now and the tag". The bundles tested today are not the bundles that ship: Task 11.4 step 1 syncs upstream and rebuilds the sidecar, step 2 bumps the version, and `ed9c281` (plus any log line you add now) is untested in a bundle. So the useful frame is: which evidence is invariant under those changes (handover protocol, packaging assertions, sandbox, audio plugin set), which must be re-taken on the release bundles (smoke, probes, Electron→Tauri handover), and which can only be taken on the real desktop (the sitting). Non-goals: re-litigating the cutover, the footprint, or the no-bridge decision; macOS and Windows.

## A. Completeness against checklist items 4–10 (as amended)

| # | Item (Phase 10 close) | Amendment | State | Evidence |
|---|---|---|---|---|
| 4 | `KillMode=mixed`, `TimeoutStopSec=15` in `relaunch.rs` plus test | none | Closed | `82bc55b`; `relaunch.rs:405`; host `p11-killmode` (Tauri and Electron controls both die of `SIGBUS` under the default, both stop cleanly under `mixed`); regression run 1 stop: `Result=success`, `shutdown finished`, mount gone |
| 5 | `create_dir_all` for the handler `.desktop` directory | Root cause was the missing `update-desktop-database`, not the directory (the plugin creates it); fixed by declaring `desktop-file-utils`, then moved to `Recommends` by the dependency split | Closed for release; one doc line | `1b77c9d`, `6775975`; run6 row 1: the ENOENT is logged, `xdg-mime query default` unchanged. Upgraders keep `omp://` because both debs install the same desktop id (`usr/share/applications/vn.io.vif.saiatlas.desktop` in `dist/sai-atlas_0.9.16_amd64.deb` and in the Tauri deb) and the Tauri entry carries `MimeType=x-scheme-handler/omp;` (`src-tauri/linux/vn.io.vif.saiatlas.desktop:12`) |
| 6 | Deduplicate `Depends` | Superseded by the split; `finalize-deb.ts` now asserts the exact `Depends` and `Recommends` and refuses `Pre-Depends` or maintainer scripts | Closed | `depends.txt` in run6: `Depends: bubblewrap, xdg-dbus-proxy, libayatana-appindicator3-1 \| libappindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`; `finalize-deb.ts:74` |
| 7 | `Cargo.toml` bump with `package.json` plus guard test | none | Closed; the release bump itself is 11.4 step 2 | `3d164ac`; `src-tauri/Cargo.toml:3` = `0.9.16` = `package.json`; regression run 1 logs `appVersion 0.9.17` |
| 8 | GStreamer decision after the host mic test; README host requirements | Decision taken by the user (gate if green; speak plugins in; +3–4 MB accepted); 11 plugins instead of 10 (`interleave`) | Code closed; **README open (11.3)**; **real-microphone host check open (sitting)** | `344294e`..`899ac58`; matrix rows `new-2404`, `new-2604`, `deb-2404` PASS with rms 0.567, controls red; regression pass: no GStreamer errors, private registry, shared `~/.cache/gstreamer-1.0` untouched |
| 9 | Replace the CI foundation gate | none | Code closed; **never executed on GitHub** (branch unpushed) | `3cecab3`; `ci.yml` `tauri-linux` job; the executor ran the parity loop and `check-module.sh snapshots` locally |
| 10 | Container cases: populated session, LevelDB import | none | Closed | `run4-extra/c3` (byte-identical session files, transcripts render) and `c4` (4 of 4 keys imported, palette recent restored) |

Later-advice checklists: the Depends advice items 1–5 and 7 are done (`6775975`, `272b6fe`, harness rules updated as run6 row 5 proves, deb rebuilt and rows re-run at `9ef58a9`); item 6 (README and release-body lines) is Task 11.3. The GStreamer advice items 1–6 and 8 are done; item 7 (AppImage dictation in the sitting) is open. The Phase 10 close bookkeeping is done: the Task 10.5 grep prints `3`, `plan.md:18` and `:112` record the waiver, the 0.9.15/0.9.16 equivalence note is in the log.

The executor's deviations from my advice are all acceptable and I would not reverse them: `LC_ALL=C` plus `LANGUAGE` removal on the pkexec child (needed for the match strings on a Vietnamese locale), the two apt 3 match strings (`Unable to satisfy dependencies`, `Packages need to be removed but remove is disabled`, observed on the 26.04 host), the absolute-path hint, and the renderer-side localisation.

### Open items and what they block

| Open item | Blocks 11.2 (merge) | Blocks 11.4 (release) |
|---|---|---|
| Host sitting (list in D) — dictation in the `.deb` is the user's own blocker; the AppImage real-mic check is the user's gate | no | **yes** |
| 7-day precondition: earliest tag 2026-10-09 unless the user shortens it in the Validation Log | no | **yes** (calendar) |
| Task 11.3 docs with the residual-risk pre-step and recovery lines, the AppImage reopen line, and the AppImage host requirements | no | **yes** (the release body copies from them) |
| Final pass on the release bundles (smoke, probes, geometry, Electron→Tauri handover rows) | no | **yes** (add to 11.4 step 5) |
| First GitHub run of the `tauri-linux` CI job | no (merge can proceed) | **yes** — CI must be green on `main` before the tag |
| Decision on C(1) spell check: release note (default) or fix now | no | only if "fix now" is chosen |
| C(3) import log line (recommended now) | no | no (rides the release build) |
| C(2) placeholder tab, the repeated "could not register the omp:// scheme" line on machines without `desktop-file-utils`, re-download after "quit and reopen", sandbox abort instead of exit 70 | no | no (backlog) |

### Does the AppImage evidence at `899ac58` still hold?

Yes, for every row that matters, and a rerun at `9ef58a9` would buy nothing.

- `git diff --stat 899ac58..9ef58a9` touches `updater/install.rs`, `updater/mod.rs`, `updater/state.rs`, `finalize-deb.ts`, the deb fields of `tauri.linux.conf.json` (`deb.depends`/`deb.recommends` only), two check-image Dockerfiles, tests, locales and `ipc-types.ts`. It does not touch `relaunch.rs`, `appimage_handover.rs`, `electron_relauncher.rs`, `main.rs`, `gstreamer_env.rs`, `finalize-appimage.ts` or the build image. So runs 1–3 (Electron→Tauri AppImage handover, install on quit, direct route) exercise unchanged code and an unchanged bundle recipe.
- Run 4 (Tauri AppImage self-update) goes through `install_now` → `appimage_target` → `replace_appimage` (`mod.rs:555-558`, `install.rs:215`), both untouched. The diff changed the deb arm (`install_deb` → `deb_install_command`) and the error branch (`UpdateStatus::Error` gained `manual_install_command`, serialised as the optional `manualInstallCommand`). Only the error path of an AppImage self-update is new-but-untested, and it is covered by the Rust unit tests.
- `ed9c281` adds a runtime-log line on the error branch only (`mod.rs:516-525`), unit-tested.

What does need a rerun is the release build, for a different reason: the sidecar changes with the upstream sync, the version string changes, and two commits are untested in any bundle. See D for the subset.

## B. Risks the batch itself introduced that the evidence does not cover

1. **Recommends skipped on the 0.9.16 `dpkg -i` path.** Per package, from the control fields I read directly:
   - `xdg-utils`: zero exposure for upgraders. It is a hard `Depends` of the 0.9.16 deb (`dpkg-deb -f dist/sai-atlas_0.9.16_amd64.deb`: `libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, …`).
   - `desktop-file-utils`: upgraders keep `omp://` (desktop id continuity plus 0.9.16's `mimeapps.list` entry; run6 row 1). Cost is one "could not register the omp:// scheme" line at every start (`desktop/mod.rs:425-429`), observed in c3. A *fresh* `dpkg -i` install on a machine without it has no `omp://` association until `update-desktop-database` runs; `apt install ./deb` installs Recommends by default, so this needs a non-GNOME machine and `dpkg -i` by hand. Document, do not fix.
   - `gstreamer1.0-plugins-good`: Ubuntu's `libwebkit2gtk-4.1-0` depends on it (Depends advice, verified with `apt-cache show`), so it is present wherever the app can start. `gstreamer1.0-pipewire` is inert for WebKit capture.
   - Second-order effect: the Tauri updater's `apt-get install -y --no-remove -- <deb>` installs Recommends by default, which heals these machines on the next self-update but makes that update need the mirror. On a machine with a missing Recommends and an unreachable mirror, apt exits 100 with `Unable to fetch some archives`; that string is not in `apt_could_not_resolve` (`install.rs:73`), so the banner shows apt's tail without the manual-command hint. Non-destructive (apt fails before unpacking). 0.9.18: show the manual command on every apt failure, not only on the four resolve strings. Do not add `--no-install-recommends` or `--fix-missing` now.

2. **`LC_ALL=C` on the pkexec child.** pkexec preserves `LC_ALL` (it is in its saved-variable list; the executor confirmed with `strings`), so apt prints English and the matchers hold. The polkit prompt is not affected: pkexec passes `polkit.gettext_domain` and the session agent translates the prompt in the user's locale, so a Vietnamese user still sees a Vietnamese prompt. That is high-confidence belief, not measured; the containers used a rules file and no agent. The sitting's first `pkexec` prompt (item 3 in D) settles it in one glance. Non-ASCII home paths pass through apt as bytes; the hint shell-quotes the path (`quotes_the_manual_command_s_path_only_when_the_shell_needs_it`). The `N: Download is performed unsandboxed as root` warning apt prints for files under `$HOME` appears in C as well and matches none of the four strings.

3. **Bundled libpulse and the private registry.** libpulse 16.1 against `pipewire-pulse` 1.0.5 and 1.6.2 is proven by the probes; the protocol is designed for skew. The registry is rewritten at every launch because the mount path changes, costs milliseconds for 11 plugins, and does not grow (35,780–35,793 bytes across runs 1, 3 and 4; GStreamer prunes entries whose files vanished). Not covered: a host with no Pulse-compatible socket at all (dictation fails the same way in the `.deb`; nothing to do) and a user-set `PULSE_SERVER` on TCP (WebKit's sandbox binds only the socket; pre-existing, same for the `.deb`). The bundled `libsystemd` (a libpulse dependency) dlopens compression libraries lazily and libpulse never reaches that code. Low.

4. **`KillMode=mixed` on the `.deb` route.** The unit's main PID is `/usr/bin/sai-atlas`; in the AppImage host runs the main PID was also `sai-atlas` (the runtime execs AppRun in place; the FUSE server is parented to the manager), so `p11-killmode` already covers this cgroup shape. `mixed` SIGTERMs only the main, which runs the seven-step shutdown and releases its tabs; once the main exits, systemd SIGKILLs anything left in the cgroup, which is the supervisor and sidecar if the app's own teardown has not reaped them. That is the S7b hard-kill case the packaged smoke covers ("a hard kill leaves no sidecar or tool child"), and strictly gentler on the app than the default. Exposure: one session per install (the handed-over one), at logout. Not covered: a `.deb` instance under the real user manager; it is item 3 of the sitting. Low.

5. **The CI workflow.** `3cecab3` has never run on GitHub (the branch is unpushed). The job installs the pinned stable and nightly toolchains, `cargo-public-api` and `tauri-cli` from source on a cold cache (expect 20–30 minutes the first time), then clippy, `cargo test`, the parity loop and the snapshot gate. Package names match ubuntu-latest (24.04), which is also the build container's base. Treat a red first run as environment, fix the workflow, do not loosen the gates. Push the cutover branch before merging so the first run is not on `main`.

6. **`finalize-deb.ts` hard-asserts the `Depends` string.** A future tauri-cli minor that changes the appended list fails the build loudly. Intended, not a release risk; note it in AGENTS.md so the next person edits `DEB_DEPENDS`/`DEB_RECOMMENDS` instead of the assertion.

7. **`ed9c281` and anything you add now are untested in a bundle.** Log-only, unit-tested; the release build carries them and the final pass in D exercises the binary. Acceptable.

## C. New open items

### C(1) AppImage spell checking on Ubuntu 26.04

Facts, verified now:
- The shell enables spell checking: `webview.rs:647` `context.set_spell_checking_enabled(true)` with the language from the locale (`spell_checking_language`). So this is a feature, not log noise, and the `.deb` and the AppImage on 24.04 have it.
- The bundled `libenchant-2.so.2` (enchant 2.3.3 from the 24.04 image) has the module directory compiled in as `/usr/lib/x86_64-linux-gnu/enchant-2` and consults only `ENCHANT_CONFIG_DIR` (extracted from `feed-0.9.18`'s AppImage with `--appimage-extract`; `strings` shows no `ENCHANT_MODULE_*`). enchant's module lookup is `enchant_relocate(PKGLIBDIR "-2")`, and Ubuntu's build is not relocatable (the evidence shows the compiled-in path being used). There is no environment override.
- The host's providers (enchant 2.8.2) need `enchant_provider_new` / `enchant_provider_get_user_dict_dir`, which 2.3.3 lacks; all three fail to load (`out-p11-mic-final-2604/app.log`). On 24.04 the host providers are 2.3.3 and load. The loader is the UI process, not the sandboxed web process.
- Electron 0.9.16 spell-checked through Chromium's own hunspell with downloaded dictionaries, so this is a regression for AppImage users on 26.04 only.

Recommendation: **release note for 0.9.17, fix in 0.9.18.** The fix is packaging-only and safe to design now:
1. Build image: install `enchant-2` (already pulled by WebKit) and stage `/usr/lib/x86_64-linux-gnu/enchant-2/enchant_hunspell.so` plus `libhunspell-1.7.so.0` for linuxdeploy; the hspell and aspell providers are not needed.
2. `finalize-appimage.ts`: patch the bundled `libenchant-2.so.2` string `/usr/lib/x86_64-linux-gnu/enchant-2` to `././lib/x86_64-linux-gnu/enchant-2` (same length; the same `././` convention WebKit's helper directory already relies on, resolved against the `$APPDIR/usr` working directory AppRun sets, `finalize-appimage.ts:7`), and assert the provider directory holds exactly `enchant_hunspell.so`.
3. Dictionaries stay on the host (`/usr/share/hunspell`, data only; the `.deb` has the same dependency). Document `hunspell-en-us` / `hunspell-vi` as the packages that give red underlines.
4. Verify in the 26.04 matrix row: zero `Error loading plugin` lines and, through the WebDriver probe, a `spelling` marker on a misspelled word; failure mode of a bad patch is "no providers", never a crash, which is today's state.

Why not now: it is a new packaging change after the batch closed; the user's rule was one rebuild and one regression pass, and the AppImage is the secondary package ("Debian package (recommended)"). What would flip it: the sitting shows the user depends on AppImage spell check on their own machine, or the release slips past 2026-10-09 for other reasons and a rebuild happens anyway. Release-note line: "In the AppImage on Ubuntu 26.04, spell checking in text fields is off in this release; the .deb has it."

### C(2) A bash-only startup tab is dropped on restart

Not a migration defect: 0.9.16 clears `placeholder` only on `agent_start` (`sidecar-pool.ts:296-299`), Tauri's `sanitize_persisted_tab_layout` drops any placeholder (`tab_layout.rs:124-146`), and c3's control restart of 0.9.16 showed the same drop. The session file stays on disk and is listed under Recent. Recommendation: **no change in 0.9.17 and no release-note line** (nothing changed). If the user wants the rule changed, the smallest version is "a placeholder becomes explicit when its session gains durable output", applied in both shells where the flag is cleared today, in an ordinary release after the cutover. The decision only the user can make is whether a `!`-only tab is a tab worth restoring; my default is yes, in 0.9.18+.

### C(3) A successful LevelDB import logs nothing

Worth one line, and worth adding now. `legacy_storage::import` (`legacy_storage.rs:113-137`) runs once per profile on exactly the migration path users hit, and a support report today cannot distinguish "imported" from "skipped". Add one `runtime_log::note` after the loop with the key names written and the LevelDB path (never the values), unit-tested the way `ed9c281`'s test reads `runtime_log::path()`. It is log-only, so it joins `ed9c281` in the "untested in a bundle, covered by the release build's final pass" class, and the c4 variant A run shows what the line should contain (4 keys).

## D. What remains before Tasks 11.2, 11.3 and 11.4

### Order

1. Now: C(3) line, then Task 11.1 (`pre-tauri-linux` tag) and Task 11.2 on `tauri/linux-cutover`. Push the branch (one approval) so `tauri-linux` CI runs once before the merge into `main`.
2. Task 11.3 docs in parallel with the CI run.
3. From 2026-10-08: Task 11.4 steps 1–4 produce the release bundles. Then the final container pass on those bundles, then the host sitting with those exact bundles, then steps 5–7 on 2026-10-09 or later.

### Task 11.2 notes

- `package:linux` should point at `bash scripts/tauri-linux-build.sh` (the `ubuntu:24.04` container build that runs `package:tauri:linux` inside, `tauri-linux-build.sh:39`), not at `package:tauri:linux` directly; a bare host build on 26.04 fails the glibc floor by design and wastes twenty minutes.
- `src/main/packaging-config.test.ts`: the `Linux package config` block still starts at line 189 and ends at 252 on today's `main`; the artifact-name loop at 302 iterates `config.linux?.target`, which is simply empty once the file is gone, so only the `package:linux` expectation at 247–249 and the Linux describe block need to go. No `src-tauri/contracts/*.parity.json` references these tests (grepped), so the parity gate is unaffected.
- Keep `e2e/packaged-smoke.e2e.ts`: `check-twins.ts:28` names it as the Playwright twin of the Tauri spec. Delete `scripts/deb-smoke.sh` and `scripts/deb-smoke/` (Electron Linux only; referenced only by AGENTS.md and README, which 11.3 rewrites).
- Add to Verify: `bun run test:e2e:tauri` on the virtual display (`scripts/virtual-display.sh run -- …`, per AGENTS.md), and CI green on the pushed branch.

### Task 11.3 docs content

README (English, and the 中文 section the same way; change only Linux and repo-identity text):
- Install: Ubuntu 24.04+ (glibc floor 2.39). `.deb` installs `/usr/bin/sai-atlas`, the sidecar at `/usr/lib/Sai ATLAS/omp` (off `PATH`), the `omp://` handler, and a compatibility symlink at `/opt/Sai ATLAS/sai-atlas`; no AppArmor profile is shipped or needed (replaces the current line 171). `omp://` registration uses `desktop-file-utils` and `xdg-utils`, installed by `apt install ./…deb`, skipped by `dpkg -i`.
- AppImage: host needs `libwebkit2gtk-4.1-0` (which brings `bubblewrap`, `xdg-dbus-proxy` and Mesa); the WebKit sandbox is always on and needs no AppArmor profile (delete the `sai-atlas-appimage` profile section, lines 175–188, and the troubleshooting row at 347). Dictation and speech playback work in the AppImage through the PulseAudio socket (`pipewire-pulse`, stock). "If Sai ATLAS does not reopen by itself after an update, start the new `.AppImage` once by hand; its file name now carries the version." Known on 26.04: spell checking off in the AppImage.
- Updates: the in-app `.deb` update verifies the SHA-512, asks for your password once, and installs with `apt-get install --no-remove`; if dependencies cannot be resolved it shows the manual command `sudo apt install <path>`. Keep the user-writable-cache caveat (line 173) reworded for the Rust updater. Replace troubleshooting row 350 (password twice / `apt-get -f`).
- **Residual-risk lines (verbatim, also in the release body):** "Updating from 0.9.16 on a desktop without GNOME, or any machine where `dpkg -s libwebkit2gtk-4.1-0` fails: run `sudo apt install libwebkit2gtk-4.1-0` first." and "If Sai ATLAS is missing after the update: `sudo apt --fix-broken install`, or download the package and run `sudo apt install ./sai-atlas_0.9.17_amd64.deb`."
- Startup needs a standard `XDG_RUNTIME_DIR` (`/run/user/<uid>`; any logind session has one). After the first start on Tauri, the local-assistant prompt shows once more and is remembered.
- `--ozone-platform=x11` → `GDK_BACKEND=x11` (lines 188, 190); note that on the `systemd-run` relaunch the app inherits the user manager's environment, not the shell's. Re-verify the input-method sentence in the sitting (item 7 below) before keeping it.
- Build from source: Rust toolchain (`scripts/rust-pins.env`, `src-tauri/rust-toolchain.toml`), Docker for `scripts/tauri-linux-build.sh`, `bun run build:omp:linux` then `scripts/stage-tauri-sidecar.ts`; `bun run dev:tauri`; the dev desktop entry note (line 294) with the Tauri command.
- Release process (line 367–368): Linux step uses `bash scripts/tauri-linux-build.sh`, `bash scripts/tauri-deb-smoke.sh <deb>` (8 cases) and `OMP_E2E_FAKE_MIC=1 bash scripts/tauri-deb-smoke.sh <deb>`, `bun scripts/release-feeds.ts`, `latest-linux.yml` with both packages.

AGENTS.md: Linux packaging rules (Tauri config files, `finalize-deb.ts`/`finalize-appimage.ts` invariants including the `Depends` assertion and the GStreamer allowlist, `stage-tauri-sidecar.ts`, `package:linux` = container build, `updater` feeds and the compiled-in feed base), `src-tauri/` behind clippy and `cargo test`, CI's two jobs, `tauri-deb-smoke.sh` replacing `deb-smoke.sh` (lines 78 and 93), the out-of-sight dev command (`dev:tauri`), the publishing repo.

CHANGELOG 0.9.17: Linux on Tauri 2 / WebKitGTK; sandbox always on, no AppArmor profile; `.deb` layout change with the compat symlink; one-prompt `apt-get` updates; AppImage auto-reopen after the Electron handover plus the manual fallback; dictation and speech in the AppImage; memory statement limited to what `parity-report.md` measured (shell PSS 72–75 % of Electron's, total lower); known: AppImage spell check on 26.04, `XDG_RUNTIME_DIR`, the one-time "set up later" prompt, the update downloads again after a reopen; macOS and Windows unchanged.

Release body: the Mac migration steps on top (AGENTS.md rule until 1.0.0), then the Linux section with the two residual-risk lines, the AppImage reopen line, the AppImage host requirement, the spell-check note, and the monorepo commit.

### Host sitting (user present, with the release bundles)

1. `.deb` handover from the installed 0.9.16 on the `systemd-run` route: swap only `/opt/Sai ATLAS/resources/app-update.yml` to a local generic feed (the technique the AppImage final run used), click Restart & install, expect one `pkexec` prompt in Vietnamese, `dpkg -i` alone (stock desktop), relaunch without user action, `NoNewPrivs 0` on the new main, and the next self-update prompting `pkexec` in the same session. This is the only unproven route and the only outcome that could change the no-bridge decision.
2. Dictation in the installed `.deb` with the real microphone (the user's blocker).
3. Dictation and speak in the AppImage with the real microphone on 26.04 GNOME Wayland (the user's gate from the GStreamer decision).
4. GNOME Wayland window size, three launches, with the script in `parity-report.md`.
5. Tray menu, the Wayland chord while another app has focus, notifications.
6. At the end: `systemctl --user stop` of the handover unit, `journalctl --user -u <unit>` shows a clean stop (the `.deb` shape of the KillMode check).
7. One minute each: Vietnamese input method in the composer on Wayland; a misspelled word in the `.deb` (expect a marker) and in the AppImage (expect none on 26.04, confirming C(1)).

Rollback rehearsal, optional but cheap (5 minutes): after item 1, `sudo apt install --allow-downgrades ./sai-atlas_0.9.16_amd64.deb` and start it once; the profile is shared, so this is the Phase 11 Rollback section rehearsed. Then let the production handover after publishing be the 11.4 Verify.

### Phase 11 file edits

- Preconditions: add "earliest tag 2026-10-09 (v0.9.15 published 2026-10-02 17:59 KST)" and "the pre-release batch regression pass is recorded (Validation Log 2026-10-05)".
- 11.2 step 2: `package:linux` → `bash scripts/tauri-linux-build.sh`; delete `scripts/deb-smoke.sh` and `scripts/deb-smoke/`; keep `e2e/packaged-smoke.e2e.ts` (twin). Step 3: as above. Verify: add the pushed-branch CI run and the virtual-display `test:e2e:tauri`.
- 11.3: add the content list above, in particular the two residual-risk lines and the AppImage reopen line as verbatim strings.
- 11.4 step 1: after the sync, re-run `bun run test:e2e:tauri` (real-core spec) against the rebuilt sidecar before building bundles.
- 11.4 step 2: keep the `Cargo.toml` bump wording and add "`scripts/tauri-packaging-config.test.ts` fails if the two versions differ; `cargo tauri build` rewrites one `Cargo.lock` line, commit it".
- 11.4 step 3: build with `SAI_ATLAS_UPDATE_BASE` unset, then assert the feed base: `strings <sai-atlas binary> | grep -c 'https://github.com/tung491/oh-my-pi-gui/releases'` prints `1` and `grep -c 127.0.0.1` prints `0`, on both the deb's `/usr/bin/sai-atlas` and the AppImage's `usr/bin/sai-atlas` (`feed.rs:14-17` compiles the base in; the test bundles all carried the localhost base). Consider making this an assertion in both finalize scripts; it is TypeScript and changes no bundle.
- 11.4 step 5: the `dpkg -L` grep is correct as written (`dpkg-deb -c` of the Tauri deb lists `./usr/lib/Sai ATLAS/omp`, `./usr/bin/sai-atlas` and only the `/opt` symlink). Add: `dpkg-deb -f <deb> Depends Recommends` equals the two expected strings; `bash scripts/tauri-deb-smoke.sh <deb>` 8/8; `OMP_E2E_FAKE_MIC=1` on the deb and on the AppImage in the 24.04 and 26.04 matrix rows; the openbox geometry check; the Electron→Tauri handover harness on the release bundles (AppImage runs 1–3, deb rows 1–2, local feed via the Electron side's `app-update.yml`). Note that the Tauri self-update rows (AppImage run 4, deb row 5) cannot run against a release binary because its feed base is compiled in; the `899ac58`/`9ef58a9` evidence stands for them.
- 11.4 step 7: create the release as a draft, upload every asset including `latest-linux.yml`, then publish; a partial asset set breaks the Tauri updater's `latest/download` fetch and electron-updater alike.

## What to avoid

- Rerunning the AppImage harness at `9ef58a9`: same code, same recipe, no new information. Spend the time on the release-bundle pass instead.
- Adding more Rust behaviour changes before the release build beyond the C(3) log line. Each one is untested in a bundle until the final pass, and the final pass is a subset.
- Fixing C(1) by unbundling `libenchant-2` so the host's loads: the host library links the host GLib, which is the exact ABI mix that broke GStreamer on 26.04; it would turn a missing-spell-check into a failure to start on some future 26.04 update.
- Changing the updater's apt flags (`--no-install-recommends`, `--fix-missing`) in reaction to B.1; the current behaviour is non-destructive and the hint gap is a 0.9.18 string change.
- Merging into `main` before the `tauri-linux` job has run once anywhere.
- Letting the `.deb` sitting happen on bundles other than the ones you publish.

## Work checklist

1. Add the LevelDB import success line with a unit test (log keys, not values).
2. Task 11.1, then 11.2 on `tauri/linux-cutover` with the notes above; push the branch; wait for both CI jobs.
3. Task 11.3 with the content list; keep the two residual-risk lines and the AppImage reopen line verbatim between README and release body.
4. Record in the Validation Log: this checkpoint, the C(1) decision, C(2) "accepted as is", the AppImage-evidence verdict, and the earliest tag date.
5. 2026-10-08: 11.4 steps 1–4 (sync, re-run real-core e2e, bump both versions, container build without `SAI_ATLAS_UPDATE_BASE`, feeds), feed-base assertion, final container pass.
6. Host sitting on the release bundles (items 1–7), then the optional rollback rehearsal.
7. 2026-10-09 or later: 11.4 steps 5–7 with a draft release; production handover on the maintainer host as the Verify.

## Success metrics

- CI: both jobs green on the pushed cutover branch and on `main` after the merge.
- Final pass on the release bundles: smoke 8/8, three audio probes PASS, geometry PASS, AppImage runs 1–3 and deb rows 1–2 PASS, feed-base grep `1`/`0`, `dpkg-deb -f` strings exact.
- Sitting: one `pkexec` prompt, `systemd-run` route taken, `NoNewPrivs 0`, dictation transcript from both packages, window 1400×900 or the seeded size on GNOME Wayland, clean unit stop.
- After publishing: `latest-linux.yml` reads 0.9.17; the maintainer host lands on 0.9.17 with `dpkg -s sai-atlas` `install ok installed` and no `Remove:` in `/var/log/apt/history.log`; no `SIGBUS`, relauncher hang or removal report in the first week.

## Assumptions

- The published bundles are rebuilt at 11.4 from `main` after the upstream sync, so today's bundles are not the shipped ones (high; the phase file says so).
- pkexec preserves `LC_ALL` and the polkit agent translates the prompt itself (high from polkit's design and the executor's `strings` check; the sitting confirms).
- The AppImage main process keeps `$APPDIR/usr` as its working directory for the life of the process, which the existing WebKit `././` helper path already depends on (high; `finalize-appimage.ts:7`).
- Debian's enchant is not built relocatable, so the only ways to redirect its module directory are a string patch or bundling (high; the host-path error proves the compiled-in path is used).
- `KillMode=mixed` sends SIGKILL to the remaining cgroup members as soon as the main process exits (high from systemd.kill semantics; harmless here because the app tears its children down first and S7b covers the hard-kill case).
- The 7-day precondition counts from the v0.9.15 publication on 2026-10-02 (medium; the Validation Log may set a different period, and the user may shorten it).
- The Validation Log's statement that stock 24.04/26.04 desktops and the user's host carry every hard dependency still holds for the SAI OS images the installed population runs (medium; a stripped image would reopen the Pre-Depends/bridge question, as the Depends advice records).

Runtime note: this run executed on Claude Fable 5.1, as the protocol expects.

Status: DONE_WITH_CONCERNS
Summary: The pre-release batch is complete against items 4–10 as amended and nothing blocks Task 11.2; the AppImage evidence at `899ac58` holds and needs no rerun at `9ef58a9`, but the release bundles need one final container pass plus the host sitting before Task 11.4, which the 7-day precondition places at 2026-10-09 or later. New items: AppImage spell check on 26.04 is a real regression (spell checking is enabled at `webview.rs:647`, the bundled enchant has no module-path override) — release-note it and fix in 0.9.18 with the string-patch-plus-bundled-provider shape; leave the bash-only placeholder tab as is; add the LevelDB import success log line now. Concerns: the `tauri-linux` CI job has never run on GitHub, the Vietnamese pkexec prompt under `LC_ALL=C` is inferred rather than observed, and the Tauri self-update rows cannot be re-run against a release binary because the feed base is compiled in.
