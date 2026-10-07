# AppImage container matrix — Tauri 0.9.17 (finalized)

Script: `worktrees/stage-c/appimage-matrix/inside.sh` (unchanged between runs). Each row uses a clean container with the listed packages. The AppImage is extracted (no FUSE) and launched on Xvfb with a private session bus and a throwaway profile, and evidence is taken after 35 s.

**Container flags.** Inside Docker, `bwrap` needs `--privileged --security-opt apparmor=unconfined`. The host's `kernel.apparmor_restrict_unprivileged_userns=1` blocks the user namespace without `CAP_SYS_ADMIN` ("Creating new namespace failed: Operation not permitted"). With only `CAP_SYS_ADMIN`, the new network namespace's loopback setup fails ("Failed RTM_NEWADDR"). Both are container limits, not app behavior. On a real desktop, the host's `bwrap-userns-restrict` AppArmor profile grants the namespace.

## Current build: Ubuntu 24.04 container (`tauri/integration` `c623b75`)

Run 2026-10-04 23:10 against `worktrees/stage-c/feed-0.9.17/Sai-ATLAS-0.9.17-x86_64.AppImage` (254,335,480 bytes), built by `scripts/tauri-linux-build.sh` in `ubuntu:24.04`. The finalize step applied: the WebKit library has the two `././` helper paths plus `/usr/bin/bwrap` and `/usr/bin/xdg-dbus-proxy`. The highest glibc symbol version across every bundled ELF is `GLIBC_2.39`, and the glibc floor check passed inside the build. Outputs are in `appimage-matrix/out-{a,c}/`.

| Row | Image and packages | Result | Evidence |
|---|---|---|---|
| (a) | `ubuntu:26.04` + `libwebkit2gtk-4.1-0` (2.52.6; bubblewrap 0.11.1, xdg-dbus-proxy 0.1.7) | **PASS** | App alive after 35 s. `WebKitWebProcess` parent is `bwrap`, with `Seccomp: 2` and `NSpid: 5259 2` (nested). `/usr/bin/xdg-dbus-proxy` runs under `/usr/bin/bwrap`. The sidecar `omp --mode rpc-ui` is running and the onboarding UI renders |
| (c) | `ubuntu:24.04` + `libwebkit2gtk-4.1-0` (2.52.6 from 24.04 updates; bubblewrap 0.9.0, xdg-dbus-proxy 0.1.5) | **PASS** | App alive after 35 s. `WebKitWebProcess` parent is `bwrap`, with `Seccomp: 2` and `NSpid: 5224 2`. The proxy runs under bwrap, the sidecar is running, and the onboarding UI renders (`out-c/screen.png`) |

Row (b) was not re-run: it tests the missing host dependency, and the build host does not change that.

On this build the screenshots show the main window overflowing the 1600×1000 screen. That was the Linux window-size defect, not a container or bundling issue, and it is fixed in `baea5a6`.

**Re-run after the window and log fixes (`e824b79`, 2026-10-04 23:45).** Row (c), `ubuntu:24.04`, on the rebuilt AppImage (254,323,192 bytes, glibc floor passed): **PASS**. The app was alive after 35 s, `WebKitWebProcess` had `Seccomp: 2` and a nested `NSpid`, and the window opened at 1400×900 inside the screen (`out-c/screen.png`). The previous row (c) output is in `prev-c623b75-out-c/`.

## Superseded: Ubuntu 26.04 host build (`6448e2f`)

Run 2026-10-04 22:25–22:33. Outputs are in `appimage-matrix/prev-2604build/out-{a,b,c}/`.

| Row | Image and packages | Result | Evidence |
|---|---|---|---|
| (a) | `ubuntu:26.04` + `libwebkit2gtk-4.1-0` | **PASS** | Sandbox on (`Seccomp: 2`, nested `NSpid`), the proxy runs under bwrap, and the UI renders |
| (b) | `ubuntu:26.04` + `bubblewrap xdg-dbus-proxy libgtk-3-0t64`, no `libwebkit2gtk-4.1-0` | **EXPECTED FAIL** | Exit 127: `libEGL.so.1` missing. The host graphics stack that `libwebkit2gtk-4.1-0` brings is absent |
| (c) | `ubuntu:24.04` + `libwebkit2gtk-4.1-0` | **FAIL** | Exit 1: the bundled libraries needed glibc 2.42/2.43 (``version `GLIBC_2.43' not found (required by …/usr/lib/libglib-2.0.so.0)``) |

## Findings

- With `libwebkit2gtk-4.1-0` installed, the AppImage starts with the WebKit sandbox fully on, on both Ubuntu 24.04 LTS and 26.04, and needs no AppArmor profile of its own.
- The 24.04 failure came from linuxdeploy bundling the build host's GTK, GLib and WebKit stack. It is fixed by building in `ubuntu:24.04` (`scripts/tauri-linux-build.sh`). `src-tauri/linux/glibc-floor.ts` now scans every ELF in the AppImage and the deb and fails the build above `GLIBC_2.39`. The old check inspected only the main binary.
- The `.deb` links the host's libraries. Whether it works against 24.04's own WebKitGTK is checked by the packaged smoke, not here.

## Audio probe: curated GStreamer plugins, fake microphone (`tauri/p11-gstreamer` `899ac58`)

Run 2026-10-05 09:50–10:13 (Asia/Seoul). The AppImage under test is `worktrees/stage-c/p11-gstreamer-build/bundle/appimage/Sai ATLAS_0.9.18_amd64.AppImage` (256,674,296 bytes; the 0.9.18 feed AppImage is 254,355,960, so +2,318,336 bytes). It was built by `scripts/tauri-linux-build.sh` in `ubuntu:24.04` from a tree whose build inputs equal `5c3ff07`. The build had version 0.9.18 and `SAI_ATLAS_UPDATE_BASE=http://127.0.0.1:8765`. Its finalize step passed both the plugin allowlist and the glibc floor, and the highest glibc symbol version among the plugins, the libpulse chain and the scanner is `GLIBC_2.38`.

**Bundle contents** (`unsquashfs -ll`):
- **Plugins:** `usr/lib/gstreamer-1.0/` holds exactly 11 real files: `app`, `audioconvert`, `audioresample`, `autodetect`, `coreelements`, `interleave`, `playback`, `pulseaudio`, `typefindfunctions`, `volume` and `wavparse`.
- **Helpers:** `usr/lib/gstreamer1.0/gstreamer-1.0/` holds `gst-plugin-scanner` and `gst-ptp-helper`.
- **libpulse chain:** `libpulse.so.0`, `libpulsecommon-16.1.so`, `libsndfile`, `libFLAC`, `libvorbis`, `libvorbisenc`, `libopus`, `libogg`, `libmpg123`, `libmp3lame`, `libsystemd`, `libasyncns` and `libapparmor`.
- **Kept out:** no `libmvec`, `libc.so` or `libpipewire`.
- **AppRun:** sources `linuxdeploy-plugin-gstreamer.sh` before the GTK hook.

**Harness.** `appimage-matrix/mic-run.sh <tag> <image> <AppImage> [no-plugins]` builds `mic/Dockerfile` (`ubuntu:24.04` or `ubuntu:26.04` with `libwebkit2gtk-4.1-0`, PipeWire, WirePlumber, pipewire-pulse, pulseaudio-utils, gstreamer1.0-tools/-plugins-base/-pipewire, the WebKit WebDriver package, Xvfb and node). It runs `mic-inside.sh` with the matrix flags plus `seccomp=unconfined` and `--ulimit core=1`, as the host uid:
1. Extract the AppImage (no FUSE).
2. Under `dbus-run-session`, start Xvfb, then `scripts/tauri-deb-smoke/fake-mic.sh`. That script starts PipeWire, WirePlumber and pipewire-pulse, creates `fake-out` (a null sink) and `fake-mic` (a FIFO-fed pipe source playing a 440 Hz `audiotestsrc` tone), and checks the tone reaches `fake-mic` at about −4.9 dB rms.
3. Run `e2e-tauri/fake-mic.probe.ts` through `wdio.packaged.conf.ts` (`OMP_E2E_FAKE_MIC=1`) against the extracted `AppRun`, with `GST_DEBUG=2,GST_REGISTRY:4,GST_PLUGIN_LOADING:4,pulse*:4,webkit*:4` and `GST_DEBUG_NO_COLOR=1`, so the app's output goes to `app.log`.
4. Export `APPDIR` before AppRun, as the AppImage runtime does. Otherwise the gstreamer hook expands `${APPDIR}` to nothing and the scanner path breaks.

**Probe.** It runs `enumerateDevices`, then `getUserMedia` with dictation's constraints (`channelCount: 1`, `echoCancellation`, `noiseSuppression`). The stream feeds an `AnalyserNode`, then a silent gain, then the destination, and the probe samples it for 1 s. Next, a 1 s PCM16 WAV blob plays in `new Audio()` until `ended`. Last, the probe checks each web process's sandbox (parent, `Seccomp`, `NSpid`) and greps its `mountinfo`. Outputs are in `appimage-matrix/out-p11-mic-*/`.

| Row | Build | Result | Evidence |
|---|---|---|---|
| `new-2404` | new, `ubuntu:24.04` (PipeWire 1.0.5, GStreamer 1.24.2) | **PASS** | `inputs: 1` ("fake-mic"), `state: "running"`, `rms: 0.567`. Playback `ended: true`, duration 1 s, with its sink input on `fake-out`. Web process parent `bwrap`, `Seccomp=2`, `NSpid=628 2`. `mountinfo` holds `/run/user/1000/pulse`, `~/.config/pulse`, `$APPDIR/usr/lib/gstreamer-1.0` and `~/.cache/vn.io.vif.saiatlas/gstreamer-1.0`. `app.log` shows the bundled `libgstpulseaudio.so` loaded (by the bundled scanner and in the web process), `gst_pulsesrc_prepare`, and no `undefined symbol` |
| `new-2604` | new, `ubuntu:26.04` (PipeWire 1.6.2, GStreamer 1.28.2 on the host) | **PASS** | `inputs: 1`, `state: "running"`, `rms: 0.567`. Playback `ended: true`. Parent `bwrap`, `Seccomp=2`, `NSpid=625 2`. Same four audio mounts. Bundled pulse plugin loaded, `pulsesrc` prepared, no GStreamer `undefined symbol`. The only `undefined symbol` lines come from the host's enchant-2 providers loaded into the bundled libenchant (spell checking, unrelated to audio) |
| `ctl-old-2404` | feed 0.9.18 AppImage, `ubuntu:24.04` | **FAIL (expected)** | `inputsBefore: 0`, `getUserMedia: OverconstrainedError: Invalid constraint`. `app.log`: "GStreamer element appsink not found", "autoaudiosink not found". Playback then loses the page ("session deleted because of page crash or hang") |
| `ctl-old-2604` | feed 0.9.18 AppImage, `ubuntu:26.04` | **FAIL (expected)** | Same as `ctl-old-2404` |
| `ctl-noplug-2404` | new, plugin directory moved aside | **FAIL (expected)** | `inputs: 0`, `OverconstrainedError`. Host plugins (installed in the image) were not picked up |
| `ctl-noplug-2604` | new, plugin directory moved aside | **FAIL (expected)** | Same as `ctl-noplug-2404` |
| `deb-2404` | new build's `.deb` (`p11-gstreamer-build/bundle/deb/Sai ATLAS_0.9.18_amd64.deb`, host libraries) in the `tauri-deb-smoke` image (weston, Wayland, no `--privileged`) | **PASS** | `OMP_E2E_FAKE_MIC=1 bash scripts/tauri-deb-smoke.sh <deb>`. `inputs: 1`, `state: "running"`, `rms: 0.567`, playback `ended: true`, sandbox checks pass, and `mountinfo` binds the pulse socket and `~/.config/pulse`. The host's `libgstpipewire` provider fails to connect inside the sandbox (`gstpipewirecore.c make_core`) and the pulse provider serves the device. Output in `out-p11-mic-deb-2404/` |

**Control method.** Setting `GST_PLUGIN_SYSTEM_PATH_1_0=/nonexistent` in the launch environment cannot take effect: the gstreamer hook exports the variable unconditionally, and `AppRun.wrapped` prepends `$APPDIR/usr/lib/gstreamer-1.0` again. So the control moves the bundled plugin directory aside in the container's extracted copy. The variable then names a directory that does not exist, and the host directory stays unscanned.

**Shared registry.** In every `new-*` row the host-GStreamer registry `~/.cache/gstreamer-1.0/registry.x86_64.bin` kept the same size, mtime and hash across the app run, which `gst-launch-1.0` wrote before the app started. The app wrote its own `~/.cache/vn.io.vif.saiatlas/gstreamer-1.0/registry.x86_64.bin` (35,780 bytes). In all four controls the shared registry changed, because nothing set `GST_REGISTRY` there.

**Findings.**
- With the curated plugin set, dictation's capture path and speech playback work from the AppImage on 24.04 and 26.04 with the sandbox on. Audio leaves the sandbox only through the PulseAudio socket, as the advice described.
- The advice's 10-plugin list was one short. WebKit feeds a MediaStream track to WebAudio through `deinterleave` (plugins-good `interleave`). Without it, `pulsesrc` captured but every `MediaStreamAudioSourceNode` read silence (`rms: 0`, "GStreamer element deinterleave not found"). The build now stages 11 plugins.
- On 26.04's PipeWire 1.6.2, a virtual source, loopback or remap source fed through the graph stays suspended in a container, and WirePlumber never routes a playback stream into an `Audio/Source/Virtual` by `target-object`. The fake microphone is therefore a pipe source; that is a harness detail, not app behaviour.
- Remaining "not found" lines in the new rows are playback extras WebKit only warns about: `scaletempo` (pitch-preserving rate changes), `fakevideosink` and `subenc`.
