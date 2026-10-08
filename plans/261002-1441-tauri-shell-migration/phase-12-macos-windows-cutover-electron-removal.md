---
phase: 12
title: "macOS and Windows cutover, then Electron removal"
status: pending
priority: P2
effort: "8d"
dependencies: [11]
---

# Phase 12: macOS and Windows cutover, then Electron removal

> **Superseded on 2026-10-08 by [`plans/261008-0341-tauri-macos-cutover/`](../261008-0341-tauri-macos-cutover/plan.md)** (macOS arm64 only, fresh installs, then Electron removal). Execute that plan, not the tasks below.

> **Windows is out of scope since 2026-10-05 (everyday-work rebrand, R13): skip every Windows step. The macOS Tauri bundle must ship resources/assistant-pack beside the omp sidecar the way the Linux bundle does (see the rebrand plan's spawn contract) before macOS switches to Tauri.**

> **Deferred by the user on 2026-10-05.** Do not start this phase until the user reopens it. macOS and Windows stay on Electron in the meantime.

## Goal

macOS and Windows switch to the Tauri build with their deferred OS-specific behavior ported and verified on real hosts. Electron, electron-builder, electron-vite, the preload and `src/main/**` are then removed, along with every script that depended on them. The docs describe one Tauri app on three OSes.

## Preconditions

- The Linux cutover (Phase 11) has been live for at least one release with no open blocking defect.
- A Mac (arm64, and Intel if Intel stays supported) and a Windows 10/11 VM are available. Without them, stop: this phase cannot pass from Linux alone.
- Every publishing step needs the user's explicit go-ahead at that moment.

## Tasks

### Task 12.1: Port the deferred OS branches
- Goal: no `cfg(target_os = "macos" | "windows")` branch still returns a placeholder.
- Steps:
  1. Proxy (`src-tauri/src/omp/proxy.rs`): macOS reads `scutil --proxy` (HTTPS proxy and port; a PAC-only setup gets no proxy plus one runtime log entry, which the user must accept as a degradation). Windows uses WinHTTP `WinHttpGetIEProxyConfigForCurrentUser` (add the `windows` crate with the needed features now that the wave freeze is over).
  2. GPU name (`src-tauri/src/ollama/hardware.rs`): macOS `system_profiler SPDisplaysDataType -json`, Windows `Get-CimInstance Win32_VideoController` through `powershell -NoProfile`.
  3. Single instance per profile (`src-tauri/src/paths.rs`, `lib.rs`): since Phase 2, `lib.rs` replaces the Tauri identifier with `paths::single_instance_id()` for every non-default profile on every OS (`context.config_mut().identifier`, `lib.rs:385-387`), and passes the same value to the plugin's `dbus_id` (Linux only). On each host, confirm that `tauri-plugin-single-instance` 2.5 keys its lock on that identifier (macOS socket, Windows named mutex); if it does not, give it the profile id there. Add a test with two profiles: two instances on different throwaway profiles both run, and a second instance on the same profile hands off.
  4. Sidecar lifetime on Windows (`src-tauri/src/omp/manager.rs`): no supervisor; the GUI creates one Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` at startup (add the `windows-sys` features for `Win32_System_JobObjects` now that the wave freeze is over), assigns every omp child to it right after the spawn, and keeps the handle for the process lifetime, so a hard kill of the GUI takes omp and its tool children with it. First check that pi-natives does not spawn with `CREATE_BREAKAWAY_FROM_JOB` (grep the monorepo's `packages/natives` for it); if it does, the Job Object must deny breakaway. Orderly stop stays `Child::kill` after the agent's own shutdown request, matching the TS behavior on Windows. Test: `a killed parent takes the job's children` on the Windows host.
  4b. Sidecar lifetime on macOS (`src-tauri/src/omp/supervisor.rs`): add kqueue `EVFILT_PROC`/`NOTE_EXIT` on the GUI pid as a second parent-death signal next to the control channel, and, before killing omp, take a recursive `proc_listchildpids` snapshot of omp's descendants and SIGKILL every survivor after the group kill, because orphans reparent to launchd there and the `/proc` sweep does not exist. Run the Phase 3 Task 3.4b tests on the Mac; they must pass unchanged except for the `/proc` polling helper, which uses `proc_listchildpids` on macOS.
  4c. SIGTERM parity on Windows: handle `CTRL_CLOSE_EVENT`/`CTRL_C_EVENT` through `tokio::signal::windows` so they call `app_handle.exit(0)` like the Unix SIGTERM listener in `lib.rs` (`listen_for_signals`; its `cfg(not(unix))` body is empty until this step).
  5. Quick-entry on macOS: `Cargo.toml` pins `tauri-nspanel = "2"` from crates.io (2.1.0), which no Linux host could compile (gate 9 only ever printed WARN). First run `cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin --all-features` on the Mac; if `tauri-nspanel` 2.1.0 does not build against Tauri 2.12, fall back to the plain always-on-top window that Phase 5 Task 5.4 records and note it. Then verify the panel (or the fallback) floats over a full-screen app without activating Sai ATLAS.
  6. Cross-target compile on the real hosts: every `check-module.sh` gate 9 run before this phase printed WARN on the Linux host (no Apple or MSVC toolchain, and its WARN pattern matches almost any cross-target failure), so no `cfg(target_os = "macos" | "windows")` code has been compiled yet. On the Mac and on the Windows VM, run `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` and fix every error before the checks below.
- Verify: `grep -rn "is not implemented on this OS" src-tauri/src` prints nothing, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` exits 0 on the Mac and on the Windows VM, `cargo test --manifest-path src-tauri/Cargo.toml --all-features` exits 0 on Linux, macOS and Windows, and on each of the Mac and the Windows VM a `kill -9`/`taskkill /F` of the running app leaves no `omp` process behind within 10 s (`pgrep -f "omp --mode rpc-ui"` or `tasklist | findstr omp` prints nothing).

### Task 12.2: macOS build and checks
- Steps:
  1. On the Mac: `bun run build:omp && bun run package:tauri:mac:arm64` (and `:x64` with `build:omp:x64` for Intel).
  2. Check, and record PASS/FAIL in `reports/parity-report.md` under `macOS`: the AGENTS.md smoke (sidecar `ready`, `get_settings`, one settings toggle); microphone with the TCC prompt; quick-entry panel over a full-screen app; global shortcut; tray click; `omp://` link; the quit guard; `codesign -d --entitlements - "Sai ATLAS.app"` shows only `audio-input`, while the sidecar (`Contents/MacOS/omp`, the `externalBin` from Phase 8) shows only `allow-jit` and `allow-unsigned-executable-memory`; WKWebView visual pass (the same list as Phase 10 Task 10.4).
  3. Floor: confirm 13.3 (Safari 16.4 WebKit) is right for the renderer's CSS, or adjust after testing on the oldest supported macOS. Then raise `MAC_UPDATE_FLOOR` in `scripts/mac-update-floor.ts` to the matching Darwin version (22.4.0 for 13.3), together with its test.
  4. DMG handover: install the current Electron macOS build, serve `dist-release/` (with a Tauri `latest-mac.yml` from `scripts/release-feeds.ts`) locally, use `OMP_DEV_UPDATE_CHECK=1` with a `dev-app-update.yml` pointing at it (or the packaged equivalent), and confirm the manual DMG flow installs the Tauri app with settings intact.
- Verify: `grep -cE "^macOS [a-z -]+: PASS$" plans/261002-1441-tauri-shell-migration/reports/parity-report.md` prints at least `10`, and the same grep for `: FAIL$` prints `0`.

### Task 12.3: Windows build and checks
- Steps:
  1. On the Windows VM: `bun run build:omp:win && bun run package:tauri:win`.
  2. Install the current Electron NSIS build, then install the Tauri NSIS build over it. The hook removes the old entry from "Apps & features" and the profile survives. Then run the same smoke as macOS, plus the WebView2 visual pass.
  3. Record the Electron portable target as dropped, or ship a zipped `sai-atlas.exe` if the user wants a portable build.
- Verify: `grep -cE "^Windows [a-z -]+: PASS$" plans/261002-1441-tauri-shell-migration/reports/parity-report.md` prints at least `6`, and the same grep for `: FAIL$` prints `0`.

### Task 12.4: Electron removal
- Goal: no Electron code, config, dependency or script reference remains.
- Steps:
  1. Tag the last Electron commit `electron-final` (push only after approval).
  2. Move what kept scripts still import out of `src/main/` before deleting it:
     - `sidecarOutName` from `src/main/bundled-omp-path.ts` into `scripts/sidecar-names.ts`, imported by `scripts/build-bundled-omp.ts:45`;
     - the tray mark: `scripts/gen-icons.ts:20` writes `src/main/tray-mark.ts`, which `src-tauri/src/desktop/tray.rs` reads. Make gen-icons write `src-tauri/icons/tray-mark.rgba` instead, load it with `include_bytes!`, and keep the source-hash check.
  3. Port the CSP rules in `src/main/packaging-config.test.ts:361-437` ("cannot fetch a remote image…", "keeps script execution…", "quick-entry page ships the same CSP") into `scripts/tauri-packaging-config.test.ts`.
  4. Delete: `src/main/**`, `src/preload/**`, `electron.vite.config.ts`, `electron-builder.yml`, `electron-builder.x64.yml`, `electron-builder.win.yml`, `scripts/after-pack.cjs`, `scripts/check-main-bundle.ts`, `src/renderer/boot/boot-electron.ts`, `e2e/*.e2e.ts`, `playwright.config.ts`. Keep `src/shared/bridge/**`: `src/renderer/boot/boot-tauri.ts` builds `window.omp` with `createOmpApi(port, platform)` and the bar's API with `createQuickEntryApi(port, platform)`, `platform` coming from `window.__OMP_BOOTSTRAP__`; the deleted preload was only their Electron caller. Move `e2e/sidecar-fixture.ts` and `e2e/desktop-prefs.ts` into `e2e-tauri/` and fix the imports. Port `scripts/capture-showcase.ts` to WebdriverIO, or delete it if the user agrees.
  5. Make `vite.tauri.config.ts` the only renderer config: fold `vite.renderer.shared.ts` into it, and point `scripts/check-renderer-chunks.ts` at `out/renderer-tauri`.
  6. `package.json`: remove `electron`, `electron-builder`, `electron-vite`, `electron-store`, `electron-updater`, `electron-log` and `@playwright/test`, plus the `postinstall: install-electron` script. Remove `chokidar`, `yaml` and `zod` only when `grep -rn "from \"<pkg>\"" src scripts e2e-tauri` finds no import. Rename the Tauri scripts to the plain names (`dev`, `build`, `package:*`, `test:e2e`).
  7. CI: drop the Electron build steps and keep `check:types`, vitest and the Tauri job.
- Verify: `grep -rlniE "electron|_electron|@playwright|src/main/" src scripts e2e-tauri package.json .github` lists no file, except lines in a "Migrating from Electron" note. `bun install`, `bunx vitest run`, `bun run check:types`, `cargo test --manifest-path src-tauri/Cargo.toml --all-features`, `bun run build` and `bun run test:e2e` each exit 0, and `bun run build:omp` runs successfully in the monorepo clone.

### Task 12.5: Docs
- Targets: `README.md` (install and build on all three OSes, the release process), `AGENTS.md` ("Sidecar & Packaging Rules", "Build, Test, Release", Code Conventions; restate where `APP_ID`, the profile path and the NSIS GUID now live: `src-tauri/tauri.conf.json`, `src-tauri/src/paths.rs`, `src-tauri/windows/hooks.nsh`), `CHANGELOG.md`.
- Steps: read each file before editing it, and change only what the removal affects.
- Verify: `grep -c "electron-builder" README.md AGENTS.md` prints `0` for both files (or only "Migrating" lines), and every command in the README's build section runs successfully.

### Task 12.6: Release
- Steps: the Phase 11 Task 11.4 flow. All three OSes now come from Tauri, and `scripts/release-feeds.ts` writes every feed.
- Verify: after publishing, each feed (`latest-mac.yml`, `latest-linux.yml`, `latest.yml`) on the publishing repo lists the new version, and an installed Electron macOS build and Windows build each offer the update.

## Rollback

Build Electron from `electron-final` with a higher version and publish it. The feeds and the profile are shared, so Tauri installs move back the same way.

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
