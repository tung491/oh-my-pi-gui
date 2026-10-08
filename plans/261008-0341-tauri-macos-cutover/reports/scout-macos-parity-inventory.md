# Scout: macOS inventory, Electron shell vs Tauri core (2026-10-08)

Paths are relative to the repo root `/Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos`. Status is PORTED, PARTIAL, MISSING, or UNVERIFIED (code present, behavior not checked). No `cfg(target_os = "macos")` code has ever been compiled: every earlier gate ran on Linux.

## 1. Electron macOS behavior and Tauri counterpart

| Electron (src/main) | What it does on mac | Tauri counterpart | Status |
|---|---|---|---|
| index.ts:70-71 `app.dock.setIcon` | Dev-time dock icon | Bundle `icon.icns` | PORTED (bundle) |
| index.ts:526-531 `window-all-closed` skips quit on darwin | Stay in dock | desktop/lifecycle.rs:36, 59, 75, 101, 107 | PORTED |
| window.ts:421 `app.dock.setBadge` | Run-state badge | desktop/windows.rs:1146-1151 `set_badge_label` | PORTED |
| menu-template.ts:25-36 app menu | macOS app menu | desktop/menu.rs:31-45 | PORTED |
| menu-template.ts:157 "Bring All to Front" | Window menu | menu.rs:97-100 (Maximize only) | PARTIAL |
| deep-link.ts:21 `open-url`, :31 `open-file` | `omp://` and `open -a` a folder | desktop/deep_link.rs:20-27, 119-127 | PORTED (UNVERIFIED in a built .app) |
| app-quit.ts:44 `before-quit` gate | Quit guard | app_quit.rs:66-72; lib.rs:485-491 | PORTED |
| index.ts:456 `globalShortcut` | Global chord | desktop/shortcut.rs (plugin on macOS) | PORTED (UNVERIFIED) |
| quick-entry.ts:245-259 `type:"panel"`, `hiddenInMissionControl` | Floating non-activating panel | windows.rs:1022-1035 nspanel style mask + hides_on_deactivate; no Mission Control collection behavior | PARTIAL |
| quick-entry-core.ts:112-113 `isBlockedMenuChord` | Blocks Cmd chords in the bar | not found in Rust | MISSING (verify) |
| quick-entry.ts:363 `app.focus({steal:true})` | Focus steal | no steal-specific call | UNVERIFIED |
| tray.ts:28-34 `setTemplateImage` | Template menu-bar icon | tray.rs:225-230 `icon_as_template` | PORTED |
| ipc.ts:766 `showItemInFolder` | Reveal in Finder | only open_path | PARTIAL |
| ipc.ts:817, 1163-1185 `Notification` | Notifications | tauri-plugin-notification; services/system.rs:19-42 | PORTED (permission prompt UNVERIFIED) |
| Electron default media grant | Mic in renderer | webview.rs:707-712 `connect_permission_request` is webkit2gtk-only | MISSING on macOS (WKWebView mic) |
| updater.ts:85-95 `detectInstallMode` | auto vs manual | updater/mod.rs:120 Manual on macOS | PORTED (always manual) |
| updater.ts:119-123 `showItemInFolder` + `openPath` | Reveal then open DMG | updater/mod.rs:449-453 only `host.open_path` | PARTIAL |
| shell-env.ts:80-83 login-shell PATH probe | PATH for Finder launches | omp/shell_env.rs:81-82 | PORTED |
| ollama/hardware.ts:122 unified memory; ollama/probe.ts:76 install check | Ollama detection | ollama/hardware.rs, probe.rs | UNVERIFIED |
| GPU name | — | ollama/hardware.rs:109 "GPU name lookup is not implemented on this OS" | PLACEHOLDER |
| System proxy | — | omp/proxy.rs:104 "system proxy lookup is not implemented on this OS" | PLACEHOLDER |
| Sidecar lifetime | — | omp/supervisor.rs: Linux uses prctl + /proc sweep; macOS branch (kqueue NOTE_EXIT, proc_listchildpids) not written | MISSING |
| after-pack.cjs:9-22 rewrites ATS | Electron-only | src-tauri/Info.plist sets ATS | N/A |

## 2. Renderer
- `-webkit-app-region` in global.css:208-212 and TitleBar.tsx:195 is inert in both shells (native title bars). No `isMac` branches.

## 3. Packaging
| Item | Evidence | Status |
|---|---|---|
| tauri.macos.conf.json: dmg+app, minimumSystemVersion 13.3, signingIdentity "-", entitlements macos/app.entitlements | src-tauri/tauri.macos.conf.json | written, never built |
| Mac sidecar overlay ships externalBin only, no assistant-pack | src-tauri/macos/sidecar.conf.json vs src-tauri/linux/sidecar.conf.json:4-7 | MISSING |
| `package:tauri:mac:*` skip `build:pack` | package.json:17-18 vs :16 | MISSING |
| Pack lookup: `assistant-pack/` beside the binary (Contents/MacOS) then walk-up | omp/assistant_pack.rs:32-58 | packaged app would fail with missing-pack; resources belong in Contents/Resources, not Contents/MacOS (code-signing seal) |
| Sidecar candidates on darwin: Contents/Resources first, then Contents/MacOS | paths.rs:223-234 | PORTED |
| `omp.entitlements` (JIT, unsigned memory) | src-tauri/macos/omp.entitlements | referenced by no config |
| Hardened runtime | electron-builder.yml:46 `hardenedRuntime: true`; none in tauri.macos.conf.json | UNVERIFIED |
| `omp://` CFBundleURLTypes | tauri.conf.json plugins.deep-link schemes | UNVERIFIED in built .app |
| Feeds: `Sai-ATLAS-<v>-arm64.dmg/.zip`, `omp-` bridge copies, minimumSystemVersion | scripts/release-feeds.ts:72-79, 225-246, 46-48 (13.3→22.4.0) | PORTED; Tauri bundler makes no ZIP — the ZIP must be produced (ditto) |
| Profile dir `~/Library/Application Support/@oh-my-pi/omp-gui` | paths.rs:16, 84-87 | PORTED |

## 4. e2e
- wdio.conf.ts:45, 64-66, 159-161 use `/usr/bin/WebKitWebDriver` and `ss`: Linux only. tauri-driver does not support WKWebView. macOS has no automated GUI e2e today except Electron Playwright.

## 5. Cargo
- `tauri-nspanel = "2"` under `cfg(target_os="macos")` (Cargo.toml:65-66), used at windows.rs:1029-1033. Never compiled.
- No `objc2`/`cocoa`, no `macos-private-api`.

## Top gaps by risk
1. Packaged macOS build ships no assistant pack; every session would fail.
2. Signed sidecar under hardened runtime: omp.entitlements unwired.
3. No macOS e2e harness.
4. WKWebView microphone permission unhandled.
5. Quick-entry panel parity (Mission Control, blocked Cmd chords, focus steal).
6. `omp://` registration in a built .app unverified.
7. Minor: Show-in-Finder for the DMG, Bring All to Front, floor 13.0 → 13.3.
