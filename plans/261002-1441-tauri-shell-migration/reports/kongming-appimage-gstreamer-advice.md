# Kongming counsel: AppImage dictation (GStreamer) after the P11 block

Date: 2026-10-05 (Asia/Seoul). Advisory only. Evidence from `worktrees/tauri-integration` @ `3cecab3`, the WIP in `worktrees/p11-gstreamer`, the P11 container outputs, the AppDir of `appimage-matrix/app.AppImage`, tauri-bundler 2.10.1 sources, and WebKit `main` plus the `webkitglib/2.52` branch (line numbers below are `main`; the 2.52 branch has the same code one or two lines off, checked).

## TL;DR

Take option 2, narrowly: bundle a curated GStreamer plugin set that matches the bundled 1.24 core (`bundleMediaFramework: true` plus a staged plugin directory, 10 plugin files, the libpulse client chain, roughly 7.5 MB uncompressed and 3–4 MB in the squashfs), give the AppImage its own GStreamer registry file, and verify with a PipeWire fake microphone in the 24.04 and 26.04 container rows with the sandbox on. Drop the WIP's "use host GStreamer" direction entirely: it mixes two GLib/GStreamer builds and the 26.04 failure is structural, not a bug to fix. Do not take option 3 for 0.9.17. Shipping option 1 (release-note "dictation needs the .deb") is a regression against the Electron AppImage, whose dictation uses Chromium's own audio client against the host's libpulse, so whether that regression is acceptable in 0.9.17 is the user's call; my recommendation is to land the fix in the Phase 11 batch and keep option 1 only as the tag-day fallback.

## Reframed problem

The question is not "how do we make the bundled WebKit find GStreamer plugins" but "which GStreamer build and which audio client may the sandboxed web process use, on a host whose GLib may be newer than the bundle's". Hard constraints, all verified:

- The AppImage bundles GLib 2.80, GTK, libsoup, WebKitGTK 2.52.6 and the `libgst*-1.0` core libraries from the 24.04 build container, and those are first on `LD_LIBRARY_PATH` (`AppRun.wrapped` strings). Anything loaded into the web process must be linked against that GLib. Host GStreamer 1.28 needs GLib 2.82+ (`g_sort_array`, `BIND_NOW`), so host plugins and host core are both out (`out-p11-start-a`, `out-p11-abi-a`).
- The web-process sandbox is always on (`webview.rs:644-655` exits when it is off). Inside it, audio reaches the host only through PulseAudio: WebKit's launcher binds `$XDG_RUNTIME_DIR/pulse` read-write (`BubblewrapLauncher.cpp:282-316`, `bindPulse`), the sandbox's `XDG_RUNTIME_DIR` is a fresh directory (`:800-801`), and nothing binds `pipewire-0` (the `FIXME: We should move to Pipewire` at `:936`). WebKit's `pipewiresrc` path is the camera portal only (`GStreamerCapturer.cpp:151-157`; `GStreamerAudioCaptureSource.cpp:52` "there is no audio desktop portal yet"). Microphone capture is therefore `GstDeviceMonitor("Audio/Source")` → `pulsedeviceprovider` → `gst_device_create_element` → `pulsesrc` (`GStreamerCaptureDeviceManager.cpp:329`, `GStreamerCapturer.cpp:166`), talking to `pipewire-pulse` on both Ubuntu desktops. This is also how the `.deb` works today; its `gstreamer1.0-pipewire` dependency is inert for dictation.
- What the web process can see: `/usr/lib` and `/lib` of the host read-only (`:816-819`), every `LD_LIBRARY_PATH` entry (`:882`, so `$APPDIR/usr/lib` and everything under it), every `GST_PLUGIN_SYSTEM_PATH_1_0` / `GST_PLUGIN_PATH_1_0` entry (`:416-420`), the parent of `GST_REGISTRY` read-write (`:422-426`, note: the unsuffixed name), and `GST_PLUGIN_SCANNER` (`:445`). The environment is inherited, not cleared. The matrix rows already prove the AppDir mount under `/tmp` is reachable despite the sandbox's `--tmpfs /tmp` (`:798`): the binds come later in the argument list.
- The renderer's capture path (`voice.ts:159-215`) is `getUserMedia({audio})` → `AudioContext` → `AudioWorklet` → silent gain → `context.destination`. The destination is not decorative: `AudioDestinationGStreamer.cpp:71-91,168` opens an `Audio/Sink` device via `autoaudiosink`, and if no sink element exists the context never runs and no PCM arrives. So the plugin set must cover a sink too.
- `voice.ts:319` also plays TTS output with `new Audio(blobUrl)` (WAV). That is WebKit's media player (`playbin3`, typefind, `wavparse`), broken in the AppImage today for the same reason. It is outside the user's dictation rule but is the same defect class and costs 0.85 MB to cover.

Goals: dictation (and, recommended, speak) work in the AppImage on Ubuntu 24.04 and 26.04 with the sandbox on; no new host requirement beyond what the AppImage already needs. Non-goals: pipewire-native capture, video, codecs, a thin AppImage.

## A. Route, rationale and fix shape

### Why option 2 and not the others

- Option 2 keeps one GLib and one GStreamer build inside the AppDir (all from the 24.04 container), which is exactly the invariant the 26.04 failure violated. The only cross-boundary traffic is the PulseAudio native protocol over a Unix socket, which is designed for client/server version skew and is what every Flatpak WebKit app does.
- The WIP (`gstreamer_env.rs::use_host_plugins`, `removeBundledGStreamer`) is the opposite invariant and cannot be rescued: the executor's variant B shows the conflict chain continues through `libmount` and OpenSSL. Discard both pieces; keep the module name only if you repurpose it as described below.
- Option 3 is sound in principle (the `.deb` is that configuration, and the tray library is `dlopen`ed by `libappindicator-sys` 0.9.0 via `libloading`, so a missing `libayatana-appindicator3` would degrade rather than crash), but three things make it wrong for 0.9.17. First, its premise is overstated: the AppImage does not require the host's `libwebkit2gtk-4.1-0`; it requires what that package drags in (Mesa `libEGL`, `bwrap`, `xdg-dbus-proxy`), and row (b) failed on `libEGL.so.1`, which every real desktop has. Going thin would turn WebKit into a real hard dependency and give up the pinned renderer. Second, tauri-bundler always runs linuxdeploy with the GTK plugin (`linuxdeploy.rs:181-190`), so "thin" means `finalize-appimage.ts` deleting about 150 libraries plus the GTK AppRun hook consistently; a half-stripped AppDir is precisely the ABI-mix failure you just hit. Third, it invalidates the handover, window-size and matrix evidence collected on the current artifact days before the cutover. Park it as a 0.9.18+ consideration with the honest note that "bundled WebKit plus a host WebKit-stack requirement" is an awkward middle that will have to be resolved one way or the other.
- Option 1 is a regression against Electron. Verified: the 0.9.16 Electron AppImage (`dist/Sai-ATLAS-0.9.16-x86_64.AppImage`) contains 15 shared libraries and none of them is libpulse, ALSA or GStreamer, so Chromium opens the host's `libpulse.so.0` by `dlopen` as it always does on Linux. The Electron build's dictation already ran through the WebAudio capture (`CHANGELOG.md:21`). Nothing in the repo records a Linux Electron dictation run, so "Electron AppImage dictation works" is a high-confidence belief, not a measured fact; a one-minute host run of the 0.9.16 AppImage settles it.

### Fix shape (least moving parts)

1. `src-tauri/tauri.linux.conf.json` (owned by the packaging-fixes agent; one line, sequence after their commit): add `"appimage": { "bundleMediaFramework": true }` under `bundle.linux`. tauri-bundler then passes `--plugin gstreamer` (`linuxdeploy.rs:186-188`) and writes its embedded `linuxdeploy-plugin-gstreamer.sh`.

2. `scripts/tauri-linux-build/Dockerfile`: install `gstreamer1.0-plugins-base gstreamer1.0-plugins-good` (the latter brings `libpulse0`), then stage a curated directory the plugin script will copy from, for example `/opt/sai-atlas/gstreamer-1.0/`, with real copies (not symlinks) of exactly:
   - dictation: `libgstcoreelements.so` (capsfilter, queue, valve, clocksync, tee; from `libgstreamer1.0-0`), `libgstapp.so` (appsink/appsrc), `libgstaudioconvert.so`, `libgstaudioresample.so` (plugins-base), `libgstautodetect.so`, `libgstpulseaudio.so` (plugins-good; `pulsesrc`, `pulsesink`, `pulsedeviceprovider`);
   - speak (recommended): `libgstplayback.so`, `libgsttypefindfunctions.so`, `libgstvolume.so` (plugins-base), `libgstwavparse.so` (plugins-good).
   The script copies every file in `GSTREAMER_PLUGINS_DIR`, re-runs linuxdeploy so their dependencies are deployed, and patches each plugin's RUNPATH to `$ORIGIN/..:$ORIGIN` (`linuxdeploy-plugin-gstreamer.sh:77-83,101-117`). Leave `GSTREAMER_HELPERS_DIR` at its default so `gst-plugin-scanner` (15 KB) is bundled with RUNPATH `$ORIGIN/../..`; `gst-ptp-helper` (535 KB) rides along, harmless.
   Measured on 24.04: the 10 plugins total about 1.5 MB; the libpulse chain the second linuxdeploy pass adds is `libpulse.so.0` 0.33 MB, `libpulsecommon-16.1.so` 0.51, `libsndfile` 0.55 with `libFLAC` 0.41, `libvorbisenc` 0.69, `libvorbis` 0.18, `libopus` 0.39, `libogg` 0.03, `libmpg123` 0.38, `libmp3lame` 0.30, plus `libsystemd` 0.91, `libasyncns` 0.03, `libapparmor` 0.08. `libX11`, `libxcb`, `libX11-xcb` and `libmvec` are on linuxdeploy's exclude list (`excludelist:14-17`) and stay on the host, which matters: `libmvec` is glibc's and must never be bundled. Total about 7.5 MB uncompressed, 3–4 MB in the squashfs, on a 254 MB image.

3. `scripts/tauri-linux-build.sh`: pass `-e GSTREAMER_PLUGINS_DIR=/opt/sai-atlas/gstreamer-1.0` in `env_args`. `cargo tauri build` inherits it, tauri-bundler's `Command` inherits it, linuxdeploy hands its environment to plugins.

4. Environment at run time: nothing to add for the plugin path. The plugin's AppRun hook exports `GST_PLUGIN_SYSTEM_PATH_1_0`, `GST_PLUGIN_PATH_1_0`, `GST_PLUGIN_SCANNER_1_0`, `GST_PTP_HELPER_1_0` and `GST_REGISTRY_REUSE_PLUGIN_SCANNER=no` (`linuxdeploy-plugin-gstreamer.sh:141-151`); linuxdeploy regenerates `AppRun` to source both hooks (it already wraps tauri's `AppRun-x86_64` as `AppRun.wrapped` for the GTK hook). `AppRun.wrapped` then prepends the same directory once more; a duplicated path entry is harmless. Setting `GST_PLUGIN_SYSTEM_PATH_1_0` is also the guard: GStreamer stops scanning its compiled-in directory, so the host's visible-but-incompatible `/usr/lib/x86_64-linux-gnu/gstreamer-1.0` is never read. Never append host directories to that variable.

5. `src-tauri/src/gstreamer_env.rs` (repurpose, do not keep the current body): when `APPDIR` is set and `$APPDIR/usr/lib/gstreamer-1.0` exists, set `GST_REGISTRY` (unsuffixed, because that is the name WebKit binds at `BubblewrapLauncher.cpp:425`; GStreamer honors it when `GST_REGISTRY_1_0` is unset) to a file under the app's own cache directory, creating the directory first so `bindIfExists` succeeds. Reason: GStreamer purges cache entries for plugins a scan did not touch, so every AppImage launch would rewrite the user's shared `~/.cache/gstreamer-1.0/registry.x86_64.bin` to the bundle's 10 plugins and every host GStreamer app would rebuild it on next start; the AppImage's own mount path also changes per launch. Ten plugins rescan in milliseconds, so correctness does not depend on this, but it is three lines and avoids a visible side effect on the host. Do nothing outside an AppImage, do nothing when the plugin directory is missing except one `runtime_log` note. Call it where the WIP calls `use_host_plugins()` in `main.rs`, before GTK initializes. Keep the unit-test style of the WIP.

6. `src-tauri/linux/finalize-appimage.ts`: replace `removeBundledGStreamer` with an assertion in the same spirit as `patchWebKitLibrary`'s guards: `usr/lib/gstreamer-1.0` holds exactly the allowlisted plugin files, `usr/lib/libpulse.so.0` and the scanner exist, no `libmvec` or `libc.so` anywhere, then `assertGlibcFloor` as today. Add the cases to `scripts/finalize-appimage.test.ts`, and a `tauri-packaging-config.test.ts` case that `bundleMediaFramework` is `true`, so a bundler or config change cannot silently drop the plugins again.

7. Docs: README Linux requirements for the AppImage stay as they are (no new host package). Release notes gain nothing if the fix lands; otherwise the option 1 line.

### What the web process sees, concretely

`$APPDIR/usr/lib` read-only (via `LD_LIBRARY_PATH`), `$APPDIR/usr/lib/gstreamer-1.0` read-only again (via `GST_PLUGIN_SYSTEM_PATH_1_0`), the bundled scanner, the per-app registry directory read-write, `$XDG_RUNTIME_DIR/pulse` read-write, `~/.config/pulse` read-only, host `/usr/lib` read-only but unscanned. Verify from outside with `grep -E 'gstreamer-1.0|/pulse' /proc/<WebKitWebProcess pid>/mountinfo`. SHM: the sandbox's `/dev/shm` is private, so libpulse negotiates memfd or copy mode with `pipewire-pulse`; that is the Flatpak norm and the fake-mic run proves it.

## B. Verification without a real microphone

Run both rows (`ubuntu:24.04`, `ubuntu:26.04`) with the matrix container flags (`--privileged --security-opt apparmor=unconfined`, seccomp unconfined), packages `libwebkit2gtk-4.1-0 pipewire pipewire-pulse wireplumber gstreamer1.0-tools gstreamer1.0-pipewire xvfb dbus`, and the finalized AppImage extracted (no FUSE), as `inside.sh` already does.

1. Audio stack in the container (under `dbus-run-session`, `XDG_RUNTIME_DIR` mode 0700): start `pipewire`, `wireplumber`, `pipewire-pulse`; wait for `$XDG_RUNTIME_DIR/pulse/native`; `pactl info` must report "PulseAudio (on PipeWire …)". This mirrors both target desktops rather than a legacy `pulseaudio` daemon.
2. Fake devices: `pactl load-module module-null-sink sink_name=fake-out` (the `Audio/Sink` the AudioContext destination needs) and `pactl load-module module-null-sink media.class=Audio/Source/Virtual sink_name=fake-mic channel_map=mono`. The virtual source carries no `device.class=monitor`, so WebKit's filter (`GStreamerCaptureDeviceManager.cpp:202-203`) keeps it; a null sink's `.monitor` would be dropped, so do not use that. Feed a tone with the container's own GStreamer: `gst-launch-1.0 audiotestsrc is-live=true wave=sine freq=440 ! audio/x-raw,rate=48000,channels=1 ! pipewiresink target-object=fake-mic &`.
3. Launch with `GST_DEBUG=2,GST_REGISTRY:4,GST_PLUGIN_LOADING:4,pulse*:4,webkit*:4 GST_DEBUG_NO_COLOR=1`; the web process inherits stderr, so `app.log` must show the bundled `libgstpulseaudio.so` loading, "Device provider(s) successfully started", a `pulsesrc` source element, and no `not found` / `undefined symbol`. Do not use `GST_DEBUG_FILE`: several processes would clobber one file.
4. Page probe through the existing wdio packaged harness (`OMP_GUI_TEST_APP` → `squashfs-root/AppRun`, env via `e2e-tauri/launch-app.sh`): one `browser.execute` that runs `enumerateDevices()` (expect ≥ 1 `audioinput`), `getUserMedia({audio:true})`, an `AudioContext` with `createMediaStreamSource` → `AnalyserNode` → silent gain → destination, resumes the context, samples time-domain data for one second, and returns `{ state, sampleRate, inputs, rms }`. Assert `state === "running"` and `rms > 0.01`. Make it an opt-in spec (for example `OMP_E2E_FAKE_MIC=1`) so Xvfb runs without the audio stack keep passing. This exercises the same engine path as `recordAndTranscribe` minus STT, which the containers cannot provide anyway (`plan.md:191`).
5. Controls, so the probe is known to be sensitive: the current 0.9.17 AppImage must fail the probe (`getUserMedia` rejects or `inputs === 0`); the new build with `GST_PLUGIN_SYSTEM_PATH_1_0=/nonexistent` injected must fail the same way.
6. Sandbox evidence as in the matrix (`WebKitWebProcess` parent `bwrap`, `Seccomp: 2`, nested `NSpid`) plus the `mountinfo` grep from section A.
7. Speak, if included: `browser.execute` creates a 1 s PCM16 WAV blob, `new Audio(url).play()`, and awaits `ended`; `pactl list sink-inputs` or the `ended` event is the evidence.
8. Bonus with real payoff: add the same fake-mic probe to `scripts/deb-smoke.sh` (its image currently installs `libasound2t64`, a Chromium-era leftover). The `.deb`'s `pulsesrc`-under-sandbox path has never run against any microphone, fake or real, and the host sitting is still PENDING-USER; a green container row lowers that risk before the user sits down.
9. Host (user present, same sitting as the `.deb` dictation check): dictation once in the AppImage on the 26.04 GNOME Wayland machine, which is exactly the row that failed in P11.

## C. Blocker or not, and what to put to the user

- Under the cutover rule as the user accepted it in Task 10.6 (dictation in the Tauri build, scoped to the `.deb`), AppImage dictation is not a cutover blocker. The decision to switch Linux to Tauri in 0.9.17 stands.
- It is a regression for AppImage users relative to 0.9.16, with the evidence above, and the user's own machine is the 26.04 case. The plan already lists `appimage` as a shipped artifact with auto-reopen, so the regression would be visible, not theoretical.
- Recommendation: put the fix in the Phase 11 batch (one rebuild, one regression pass, which the batch needs anyway). It is additive and self-contained, so its failure mode is "the probe stays red", not "the AppImage breaks". The 7-day precondition (earliest tag 2026-10-09) leaves room. Keep option 1 as the explicit fallback: if the container rows are not green when the batch closes, ship 0.9.17 with the release-note line and fix in 0.9.18.

Decisions only the user can make (present together, recommend the defaults):

1. Is AppImage dictation a release gate for 0.9.17, or a release-note item with the fix in 0.9.18? Default: gate if green by the Phase 11 regression pass, otherwise release-note. Evidence that would flip it: a host run showing 0.9.16's AppImage dictation never worked on Linux (then there is no regression and option 1 costs nothing).
2. Include the four speak-playback plugins (+0.85 MB) in the same change? Default: yes, same defect class, same verification run.
3. Accept an AppImage about 3–4 MB larger. Default: yes.

Not a user decision but a coordination point: `tauri.linux.conf.json` belongs to the packaging-fixes agent; sequence the one-line change after their commit, or hand it to them.

## What to avoid

- Any mix of host and bundled GLib/GStreamer in either direction. The `use_host_plugins` module and `removeBundledGStreamer` go.
- Bundling `libpipewire` and its SPA/module directories: the sandbox cannot reach `pipewire-0`, so it would be dead weight with extra env (`SPA_PLUGIN_DIR`, `PIPEWIRE_MODULE_DIR`) to get wrong.
- Letting the gstreamer plugin copy the whole `/usr/lib/x86_64-linux-gnu/gstreamer-1.0` of the build image (the default without `GSTREAMER_PLUGINS_DIR`): plugins-good alone drags in libvpx, taglib, libshout, libdv, v4l and more, tens of MB for nothing.
- Pointing `GST_REGISTRY_1_0` somewhere WebKit does not bind; use the unsuffixed `GST_REGISTRY`.
- Weakening or bypassing the sandbox to debug audio.
- Shipping option 1 silently; it needs the user's acceptance because it is a regression.

## Work checklist

1. Discard the WIP edits to `finalize-appimage.ts` and `main.rs`; keep `gstreamer_env.rs` as a file and rewrite it for registry isolation (section A.5) with unit tests.
2. Dockerfile: packages plus the staged plugin directory (A.2). Build script: the env var (A.3). Config: `bundleMediaFramework` (A.1, coordinated).
3. Finalize: allowlist assertion and tests (A.6); packaging-config test for the flag.
4. Build with `scripts/tauri-linux-build.sh`; confirm `unsquashfs -ll` shows the 10 plugins, scanner, libpulse chain, no `libmvec`; glibc floor passes.
5. Container rows 24.04 and 26.04 with the fake mic (B.1–B.6), plus the two negative controls; file results in `reports/appimage-container-matrix.md`.
6. Extend `deb-smoke.sh` with the same probe (B.8).
7. Host sitting adds "dictation in the AppImage" next to the `.deb` item.
8. Present the three user decisions from section C; record the outcome in `plan.md`'s Validation Log and, if option 1 is taken, the release-note line.

## Success metrics

- Both container rows: probe `state === "running"`, `rms > 0.01`, `inputs ≥ 1`, sandbox evidence intact, no `undefined symbol` in `app.log`; both controls red.
- The user's shared `~/.cache/gstreamer-1.0/registry.*.bin` is untouched by an AppImage launch (mtime unchanged).
- AppImage growth ≤ 5 MB; glibc floor unchanged at `GLIBC_2.39`.
- Host sitting: a transcript arrives from the AppImage on 26.04 GNOME Wayland.

## Assumptions

- Ubuntu's WebKitGTK 2.52.6 matches upstream `webkitglib/2.52` in `BubblewrapLauncher.cpp` (same lines found at `:292`, `:420-423`, `:443`, `:881`, `:937`). High. A distro patch binding `pipewire-0` would only widen what works.
- Target desktops run `pipewire-pulse` (Ubuntu GNOME 24.04 and 26.04 defaults). High. A host with no Pulse-compatible socket has no dictation in the `.deb` either.
- libpulse 16.1 (24.04) speaks to `pipewire-pulse` 1.0.5 and 1.4.x without issue, including memfd fallback across a private `/dev/shm`. High (this is the Flatpak norm); the container run is the proof.
- linuxdeploy's second pass deploys the plugins' dependencies and passes its environment to plugin scripts; tauri-bundler's `Command` inherits the environment. High (script design, Rust default).
- GStreamer purges registry entries not seen during a scan, hence the registry isolation. Medium-high; if wrong, A.5 is merely unnecessary, never harmful.
- Electron AppImage dictation works on Linux hosts (Chromium `dlopen`s host libpulse; the AppImage bundles no audio client). High-confidence belief, not repo-measured; one host run of 0.9.16 settles it and is the only fact that could make option 1 cost-free.
- `gst_device_monitor_start` tolerates one provider failing to start (relevant to the `.deb`, where the host's pipewire provider cannot connect inside the sandbox). Medium; the deb-smoke probe (B.8) tests it directly.

Status: DONE_WITH_CONCERNS
Summary: Bundle a curated 10-plugin GStreamer set matching the bundled 1.24 core (`bundleMediaFramework` + `GSTREAMER_PLUGINS_DIR` staging, libpulse client, private `GST_REGISTRY`), because the WebKit sandbox only exposes the Pulse socket and any host/bundled GLib mix is structurally broken on 26.04; verify with a PipeWire virtual microphone in both container rows and the wdio packaged harness. Not a cutover blocker under the accepted rule, but a regression against the Electron AppImage, so gate-versus-release-note for 0.9.17, the speak-plugin inclusion, and the size increase go to the user. Concerns: the Electron-AppImage-dictation and pipewire-pulse interop claims are high-confidence beliefs until the host run and the container probe confirm them.
