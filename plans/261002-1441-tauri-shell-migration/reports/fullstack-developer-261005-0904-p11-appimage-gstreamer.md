# AppImage audio: curated GStreamer plugin set (dictation and speech playback)

**Earlier attempt (discarded).** The first try had the AppImage use the host's GStreamer: the finalize step deleted the bundled `libgst*` and `gstreamer_env.rs` stripped `$APPDIR` from the plugin path. It worked on 24.04. On 26.04 the app did not start (`libgstaudio-1.0.so.0: undefined symbol: g_sort_array`): the host's GStreamer 1.28 needs GLib 2.82 and the AppImage puts its bundled GLib 2.80 first, and unbundling GLib only moved the break on to `libmount` and OpenSSL. That patch is kept at `worktrees/.checkpoint-sai-atlas-261004/p11-gstreamer-host-route-wip.patch` and is not part of this branch. The fix below follows `kongming-appimage-gstreamer-advice.md` instead.

**Result.** The AppImage now bundles its own small GStreamer plugin set, matched to the GStreamer core it already carries. Dictation's capture path and speech playback pass in containers on Ubuntu 24.04 and 26.04 with the sandbox on. Both kinds of control fail as expected: the current 0.9.18 AppImage, and the new build with its plugins moved aside. The same probe passes against the `.deb`. The branch is `tauri/p11-gstreamer`, 5 commits on `3cecab3`, not pushed or merged.

One deviation from the advice: the build bundles **11** plugins, not 10. WebKit hands a MediaStream track to WebAudio through `deinterleave`, which is in plugins-good's `interleave` plugin. With only the 10 listed plugins, `pulsesrc` captured but every `MediaStreamAudioSourceNode` read silence (`rms: 0`, app.log: "GStreamer element deinterleave not found"). Dictation's real path (MediaStreamSource into an AudioWorklet) goes through the same provider. The plugin is about 60 KB.

## Phase Implementation Report

### Executed Phase
- Phase: AppImage GStreamer bundling (Phase 11 batch)
- Plan: `plans/261002-1441-tauri-shell-migration`
- Status: completed

### Commits (`worktrees/p11-gstreamer`, branch `tauri/p11-gstreamer`)
- `344294e` feat(appimage): bundle the GStreamer plugins WebKit needs for audio
- `320f96b` feat(appimage): keep the bundled GStreamer registry in the app's cache
- `5c3ff07` fix(appimage): bundle the interleave plugin for MediaStream audio
- `ecf7aad` test(e2e): add an opt-in microphone and playback probe for packaged builds
- `899ac58` build(deb): run the audio probe in the Tauri .deb smoke container

### Files Modified
- `src-tauri/tauri.linux.conf.json`: `bundle.linux.appimage.bundleMediaFramework: true`.
- `scripts/tauri-linux-build/Dockerfile`: installs plugins-base and plugins-good in a separate layer, and stages real copies of the 11 plugins in `/opt/sai-atlas/gstreamer-1.0`.
- `scripts/tauri-linux-build.sh`: passes `-e GSTREAMER_PLUGINS_DIR=/opt/sai-atlas/gstreamer-1.0`.
- `src-tauri/src/gstreamer_env.rs` (new, 6 unit tests): `isolate_registry()`. When `APPDIR` is set and `$APPDIR/usr/lib/gstreamer-1.0` exists, it creates `<cache>/vn.io.vif.saiatlas/gstreamer-1.0/` and sets the unsuffixed `GST_REGISTRY` to `registry.<arch>.bin` there. It leaves a user-set `GST_REGISTRY` or `GST_REGISTRY_1_0` alone, and does nothing outside an AppImage. A missing plugin directory or a directory that cannot be created gets one runtime-log line (a local `RuntimeLog`, so the global log `run()` installs later is not pre-empted). The decision is a pure function, `registry_plan`.
- `src-tauri/src/main.rs`: calls the function first in the Linux block, before `glib::set_prgname`.
- `src-tauri/src/lib.rs`: module registration only.
- `src-tauri/linux/finalize-appimage.ts`: adds `BUNDLED_GSTREAMER_PLUGINS` and `assertMediaFramework()`, run before `assertGlibcFloor`. It requires the plugin directory to hold exactly the allowlist as regular files, requires `usr/lib/libpulse.so.0` and the scanner, and refuses `libc.so*`, `libmvec.so*` or `libpipewire-*.so*` anywhere in the AppDir.
- `scripts/finalize-appimage.test.ts`: 6 new cases.
- `scripts/tauri-packaging-config.test.ts`: 1 new case. `bundleMediaFramework` must be true, the build script's `GSTREAMER_PLUGINS_DIR` must match the Dockerfile's staging directory, and the Dockerfile's plugin loop must equal `BUNDLED_GSTREAMER_PLUGINS`.
- `e2e-tauri/fake-mic.probe.ts` (new): the opt-in probe. The file name keeps it out of the default wdio glob and out of `check-twins.ts`, so neither file needed a change.
- `wdio.packaged.conf.ts`: `OMP_E2E_FAKE_MIC=1` runs the probe instead of the smoke spec.
- `scripts/tauri-deb-smoke/fake-mic.sh` (new): starts PipeWire, WirePlumber and pipewire-pulse, then sets up `fake-out` (null sink) and `fake-mic` (FIFO-fed pipe source with a tone), and checks the tone level.
- `scripts/tauri-deb-smoke/Dockerfile`: adds the audio stack and gst-launch, plus `desktop-file-utils` and `xdg-utils`. The `.deb` gained those two Depends in `1b77c9d`, and without them the index-less install failed (`apt` exit 100).
- `scripts/tauri-deb-smoke/entrypoint.sh` and `scripts/tauri-deb-smoke.sh`: the probe mode, and env pass-through for the probe and `GST_DEBUG`.

Outside the repo, the harness lives in `worktrees/stage-c`:
- `p11-gstreamer-build.sh` is the build driver. Its output is in `p11-gstreamer-build/`, and no `feed-*` or `bundle-*` directory was touched.
- The matrix harness is `appimage-matrix/mic/Dockerfile`, `mic-inside.sh` and `mic-run.sh`, with outputs in `appimage-matrix/out-p11-mic-*`.
- Results are appended to `reports/appimage-container-matrix.md`.

### Tasks Completed
- [x] Turned on `bundleMediaFramework`, staged the curated plugins in the build image and passed `GSTREAMER_PLUGINS_DIR` (11 plugins; see the deviation above).
- [x] Rewrote `gstreamer_env.rs` for registry isolation and wired it into `main.rs` before GTK starts.
- [x] Added the finalize allowlist assertion with tests, and the packaging-config case.
- [x] Built 0.9.18 with `SAI_ATLAS_UPDATE_BASE=http://127.0.0.1:8765`, then restored the versions in `package.json`, `Cargo.toml` and `Cargo.lock`.
  - The AppImage is 256,674,296 bytes, +2,318,336 over 254,355,960, within the 5 MB limit.
  - It holds 11 plugins, the scanner and the libpulse chain, with no libmvec, libc or libpipewire. The glibc floor passed (highest version GLIBC_2.38).
  - The release binary has 0 test-hook strings and 1 baked feed base.
- [x] Probed 24.04 and 26.04 with the sandbox on (B.1–B.7). Both pass. Sandbox evidence: parent `bwrap`, `Seccomp=2`, nested `NSpid`, and `mountinfo` holds the pulse socket, `~/.config/pulse`, the bundled plugin directory and the app's registry directory.
- [x] Negative controls on both rows. The 0.9.18 feed AppImage fails, and so does the new build with its plugins moved aside. Both report `inputs: 0` and `getUserMedia: OverconstrainedError`.
- [x] Shared registry check: unchanged in every new-build row, changed in every control.
- [x] B.8: the probe passes against the new build's `.deb` in the `tauri-deb-smoke` image (24.04, Wayland, no `--privileged`).

### Tests Status
- `cargo test --all-features`: pass (760 lib tests plus integration tests).
- `cargo clippy --all-targets --all-features -- -D warnings`: clean.
- `bunx vitest run`: 211 files, 1976 tests passed.
- `bun run check:types`: clean (both tsconfigs).
- `bunx biome check` on the touched TS files: clean. `finalize-appimage.ts` is outside biome's includes, so it was formatted through `biome format --stdin-file-path`.
- `bun e2e-tauri/check-twins.ts`: 9 spec files, 44 tests, every twin matches.
- Container probes: 3 PASS rows (24.04, 26.04, `.deb`) and 4 expected-FAIL controls. Details are in the matrix report.

### Issues Encountered
- **Seeded build cache pointed at another worktree.** `src-tauri/target-linux-2404` came from `tauri-integration`, so cached build-script outputs named `/home/tung491/WORK/worktrees/tauri-integration/...` and tauri-build failed with "failed to read plugin permissions". I rewrote that prefix to this worktree's path in the text files under this worktree's own `target-linux-2404/**/build/`. Nothing outside this worktree was touched.
- **Harness details, not app behaviour:**
  - Running the extracted `AppRun` without `APPDIR` makes the gstreamer hook expand `${APPDIR}` to nothing. The harness exports `APPDIR`, as the AppImage runtime does.
  - WirePlumber never routes a playback stream into an `Audio/Source/Virtual` by `target-object`.
  - Under PipeWire 1.6.2 (26.04), graph-fed virtual or remap sources stay suspended in a container, so the fake microphone is a pipe source.
  - The literal `GST_PLUGIN_SYSTEM_PATH_1_0=/nonexistent` injection cannot take effect, because the hook and `AppRun.wrapped` always set it again. That control moves the plugin directory aside instead, which is equivalent.
- **Shared image tag.** The `sai-atlas-linux-build` tag is shared between worktrees. Rebuilding it from this branch's Dockerfile adds a cacheable plugin layer, which is harmless for builds without `bundleMediaFramework`.

### Next Steps
- Merge `tauri/p11-gstreamer` into the integration branch. The Phase 11 regression pass should use an AppImage rebuilt from it.
- Host sitting (advice B.9): try dictation once in the AppImage on the 26.04 GNOME Wayland machine, next to the `.deb` dictation check.
- The three user decisions from the advice, section C, still stand: gate versus release note, speech plugins included (they are in this build), and the size increase (+2.3 MB).

## Unresolved questions
- Playback extras WebKit only warns about (`scaletempo`, `fakevideosink`, `subenc`) are not bundled. Speech plays at rate 1, so nothing needs them today. A future playback-rate feature would need `scaletempo` (plugins-good `audiofx`).
- Unrelated to audio and present before this change: on 26.04 the bundled libenchant loads the host's enchant-2 providers and they fail with `undefined symbol: enchant_provider_new`. Spell checking in the AppImage on 26.04 probably does not work, which is the same host/bundle ABI-mix class. It needs its own check.

Status: DONE_WITH_CONCERNS
Summary: The AppImage bundles a curated 11-plugin GStreamer set matched to its core, keeps its registry in the app's own cache dir, and its finalize step enforces the set. A fake-microphone probe passes on Ubuntu 24.04 and 26.04 (sandbox on, rms 0.567, playback ends) and on the .deb, and both kinds of control fail. Five commits on `tauri/p11-gstreamer`, not pushed.
Concerns/Blockers: 11 plugins rather than the advised 10 (`interleave` is required for MediaStream to WebAudio; the evidence is in the matrix report). The real-microphone host check on 26.04 GNOME is still pending. A separate, pre-existing enchant ABI mismatch on 26.04 likely breaks AppImage spell checking.
