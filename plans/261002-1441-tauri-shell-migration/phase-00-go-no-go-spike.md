---
phase: 0
title: "Go/no-go spike on the Linux reference machine"
status: pending
priority: P1
effort: "3d"
dependencies: []
owner: strongest available executor
---

# Phase 0: Go/no-go spike on the Linux reference machine

## Goal

Prove, on this Ubuntu 26.04 machine (GNOME Wayland, NVIDIA RTX 5080 plus Intel iGPU, WebKitGTK 2.52.6), that a throwaway Tauri shell renders the real renderer, carries the real sidecar traffic and uses materially less memory than Electron. The output is a report with a GO or NO-GO verdict. No file in the repository changes in this phase.

## Context

- The research report is `plans/reports/research-261002-1224-rust-port-footprint.md`. It measured the dev-mode Electron shell at about 480 MB PSS and the `omp` sidecar at about 343 MB PSS per tab.
- Known Linux risks: WebKitGTK with NVIDIA on Wayland can show a blank window or crash with `Error 71` ([Tauri Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/)). `tauri-plugin-global-shortcut` is X11-only on Linux ([tauri #3578](https://github.com/tauri-apps/tauri/issues/3578)). WebKitGTK refuses `getUserMedia` unless the embedder enables media streams and answers `permission-request` ([discussion #8426](https://github.com/orgs/tauri-apps/discussions/8426)). The Linux tray has no left-click event.
- Verified on 2026-10-02: `rustc 1.93.1` is the distro build (no rustup), `cargo tauri` is not installed, `libwebkit2gtk-4.1-dev` is not installed, and runtime `libwebkit2gtk-4.1-0 2.52.6` is installed.

## Files

- Create only inside a scratch worktree: `../worktrees/tauri-spike/` (a `git worktree add` of this repo on branch `spike/tauri`). It is never merged.
- Create: `plans/261002-1441-tauri-shell-migration/reports/spike-report.md` (the deliverable).

## Tasks

### Task 0.1: Install the toolchain
- Goal: the machine can build Tauri apps for Linux and cross-check macOS and Windows targets.
- Target: system packages, `~/.cargo/bin`.
- Steps:
  1. Run `sudo apt-get install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev librsvg2-dev libgtk-3-dev libayatana-appindicator3-dev libxdo-dev build-essential gstreamer1.0-pipewire gstreamer1.0-plugins-good bubblewrap xdg-dbus-proxy`. The user must type the sudo password, so ask them to run it as `! sudo apt-get install ...`.
  2. Install rustup without replacing the distro rustc: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path`, then `~/.cargo/bin/rustup default stable`.
  3. Run `~/.cargo/bin/rustup target add aarch64-apple-darwin x86_64-pc-windows-msvc` and `~/.cargo/bin/rustup toolchain install nightly --profile minimal`.
  4. Run `~/.cargo/bin/cargo install tauri-cli --version "^2" --locked`.
- Success criteria: `pkg-config --modversion webkit2gtk-4.1` prints a version, and `~/.cargo/bin/cargo tauri --version` prints `tauri-cli 2.`.
- Verify: `pkg-config --modversion webkit2gtk-4.1 && ~/.cargo/bin/cargo tauri --version` exits 0, and the output contains `2.52` and `tauri-cli 2.`.

### Task 0.2: Measure the packaged Electron baseline
- Goal: a fair Electron number. The research numbers came from dev mode.
- Target: none in the repo.
- Steps:
  1. Sidecar source: this checkout is not inside the monorepo, so `build:omp*` only works in the monorepo's clone of this repo at `/home/tung491/WORK/oh-my-pi/packages/gui`. There, fetch and check out the same commit as `main`, run `bun run build:omp:linux`, and copy `resources/omp.linux-x64` into the spike worktree's `resources/`. Also copy `/home/tung491/WORK/oh-my-pi-gui/resources/omp` (the host sidecar) into the spike worktree's `resources/`. Run one sidecar build at a time: the build patches the shared monorepo while it runs.
  2. Build the AppImage in the spike worktree with `bun run package:linux -- --publish never`.
  3. Launch it with a throwaway profile: `--user-data-dir=$(mktemp -d)`. Open one tab and wait 60 s.
  4. For every process in the app's process tree, sum `Pss:` from `/proc/<pid>/smaps_rollup`. Record the shell total (excluding `omp`) and the `omp` total separately.
- Success criteria: two numbers are recorded in the report: Electron shell PSS and sidecar PSS.
- Verify: `grep -c "Electron shell PSS" reports/spike-report.md` prints `1`.

### Task 0.3: Build the throwaway Tauri shell
- Goal: a Tauri 2 window loads the real built renderer (`out/renderer/index.html`) on this machine.
- Target: `../worktrees/tauri-spike/spike-tauri/` (a fresh `cargo tauri init` project whose `frontendDist` points at `../out/renderer`).
- Steps:
  1. Run `bun run build` in the spike worktree.
  2. Create the Tauri project with `cargo tauri init --ci` and set `identifier` to `vn.io.vif.saiatlas`.
  3. Add a temporary `window.omp` stub script so the renderer boots. It returns empty results and is spike-only.
  4. Run it with no environment workarounds first. Record what happens. Then retry with `__NV_DISABLE_EXPLICIT_SYNC=1`, then add `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- Success criteria: the main page renders text and the chat layout, and the env vars needed are recorded.
- Verify: you can capture a screenshot of the running window with `gnome-screenshot -w -f /tmp/spike-s1.png` (or the portal equivalent), and the image shows the app UI, not a blank or black window. Record which env vars were set.

### Task 0.4: Run gates S1 to S12 and write the report
- Goal: a verdict backed by measurements.
- Target: `reports/spike-report.md`.
- Steps: for each row below, run the probe in the spike shell and record PASS or FAIL, the command, and the measured value.

| Gate | Kind | Probe | Pass condition |
|---|---|---|---|
| S1 Render | hard | Task 0.3 | UI visible, needing at most `__NV_DISABLE_EXPLICIT_SYNC=1` and/or `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Needing `WEBKIT_DISABLE_COMPOSITING_MODE=1` is a FAIL. |
| S2 Footprint | hard | Same method as Task 0.2: shell processes = Tauri main + WebKitWebProcess + WebKitNetworkProcess, one tab, 60 s idle | Tauri shell PSS ≤ 60% of the Electron shell PSS from Task 0.2 |
| S3 IPC | hard | A Rust loop sends 50 × 2 KB events at 30 Hz for 60 s over one `tauri::ipc::Channel` per page (the Phase 2 design), with the meta CSP removed and the CSP set in `tauri.conf.json`. Then `invoke` returns 16 MB, then 64 MB. | p99 delivery < 50 ms, Rust RSS flat (±10 MB), 16 MB round-trip < 1 s, 64 MB completes. If 64 MB fails, record "chunk large responses" as a required design change; the gate still passes. |
| S7 Sidecar | hard | Spawn `resources/omp --mode rpc-ui` with `tokio::process`, send 1,000 `get_state` commands as NDJSON; then SIGTERM it while idle | No deadlock, 1,000 responses, SIGTERM exits within 5 s with the agent's teardown in its log |
| S7b Orphans | hard | Start a turn that runs a bash tool `sleep 600`, then `kill -9 <shell pid>` | Within 10 s, `pgrep -f 'omp --mode rpc-ui'` and `pgrep -f 'sleep 600'` print nothing. If the agent drains the tool first, record the time it takes and the mitigation (process group kill) as a required design change; the gate passes only if a mitigation is proven in the spike. |
| S14 Sandbox | hard | Enable the WebKitGTK web-process sandbox (`webkit2gtk::WebContext::set_sandbox_enabled(true)`) on the context before its first web process starts (find the hook that works: the default context in `setup`, or a custom context passed to the builder) | `grep Seccomp /proc/$(pgrep -n WebKitWebProces)/status` prints `Seccomp:\t2`, `/proc/<pid>/status` shows a nested `NSpid` (bubblewrap namespace), and the UI from S1 still renders. Record any AppArmor rule Ubuntu 26.04 needed for `bwrap`. |
| S4 Voice | soft | Enable `enable-media-stream` and `enable-webaudio`, answer `permission-request` with allow (webkit2gtk crate), run `src/renderer/lib/voice.ts`'s capture path | `getUserMedia` resolves, `MediaRecorder.isTypeSupported` finds a type, and `decodeAudioData` accepts the recording |
| S5 Shortcut | soft | `ashpd` `GlobalShortcuts` bind with `~/.local/share/applications/vn.io.vif.saiatlas.desktop` installed | The bound chord fires while another app has focus |
| S6 Quick-entry | soft | Frameless, opaque (`#0a1a33`), always-on-top, skip-taskbar window at the quick-entry size from `src/main/quick-entry-core.ts` | Renders above other windows with no white flash and no compositor artifacts |
| S8 Tray | soft | libayatana tray with a 3-item menu | The menu opens and items fire. No left-click event is accepted. |
| S9 Deep link | soft | single-instance + deep-link plugins, `xdg-open omp://new` | The running instance receives the URL; no second instance stays alive |
| S10 Data | soft | Read a copy of `~/.config/@oh-my-pi/omp-gui/prefs.json` | Nested keys such as `welcome.completed` read correctly; the file's sha256 is unchanged after a read-only run |
| S11 Identity | soft | `gdbus`/Looking Glass or `xprop`-equivalent for the Wayland app_id | app_id is `vn.io.vif.saiatlas` |
| S12 Bundle | soft | `cargo tauri build` with `omp` as `externalBin` | AppImage and .deb produced; sizes recorded |

- Success criteria: every row has PASS or FAIL plus evidence. The report ends with one line, `Verdict: GO` or `Verdict: NO-GO`. GO requires S1, S2, S3, S7, S7b and S14 to pass.
- Verify: `grep -E "^Verdict: (GO|NO-GO)$" reports/spike-report.md` prints exactly one line.

### Task 0.5: Hand off the verdict
- Goal: the user decides with evidence.
- Steps:
  1. If NO-GO: stop the plan. Tell the user which hard gate failed and point them to the cheaper levers in the research report (idle-tab sidecar eviction).
  2. If GO with soft-gate failures: list each soft failure, its documented degradation and the extra effort, and ask the user to accept each degradation before Phase 2 starts. Exception: the user decided (2026-10-02) that the Linux cutover is blocked until dictation works. If S4 fails, stop and spawn `kongming` for a plan revision before Phase 2. (Outcome, 2026-10-02: S4 failed as written and kongming chose WebAudio PCM capture in the renderer, which the spike proved; no native capture dependency and no new channel were needed, so Phase 2 freezes nothing for voice and Phase 9 Task 9.2 owns the change.)
  3. Record the env vars from S1, the sandbox hook and AppArmor notes from S14, the S7b mitigation, the S4/S5/S6 outcomes and the S12 sizes. Phase 2 (`main.rs`, `webview.rs`), Phase 3 (supervisor), Phase 5 (bar size, S5/S8 rechecks), Phase 8 (.deb depends, desktop entry) and Phase 9 (voice) carry them as of the 2026-10-02 revision; the report is `reports/spike-report.md`.
- Success criteria: the user's answer is recorded in `plan.md` under `## Validation Log`.
- Verify: no verification needed (a human decision).

## Risk

- WebKitGTK 2.52.6 has a reported blank-window regression on some GPUs. If S1 fails only on the NVIDIA GPU, rerun on the Intel iGPU (`__GLX_VENDOR_LIBRARY_NAME=mesa`, `DRI_PRIME=0`) and report both. The user decides whether iGPU-only rendering is acceptable.

## Rollback

Delete the scratch worktree: `git worktree remove ../worktrees/tauri-spike --force` and `git branch -D spike/tauri`. Nothing in `main` changes.

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
