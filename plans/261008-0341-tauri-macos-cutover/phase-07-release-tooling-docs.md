---
phase: 7
title: "arm64-only release tooling and docs"
status: completed
priority: P1
effort: "1d"
dependencies: [2]
---

# Phase 7: arm64-only release tooling and docs

## Goal

The release tooling and docs match the user's decisions:
- `scripts/release-feeds.ts` writes an arm64-only `latest-mac.yml` from the Tauri bundle, with DMG, ZIP, bridge copy and `minimumSystemVersion: 22.4.0`;
- the floor check expects `22.4.0`;
- AGENTS.md, README (en and vi) and CHANGELOG describe the Tauri macOS app, arm64 only, fresh installs only.

## Context

- `scripts/release-feeds.ts`:
  - `assetNames` (70-81) has the x64 names.
  - `buildRelease` (194-260) requires both architectures (223-224) and handles `electronMacFeed` (197-199, 247-249).
  - `parseArgs` knows `mac-x64` and `electron-mac-feed` (271).
  - `macZip` (133-152) zips the `.app` with `ditto`.
- `scripts/release-feeds.test.ts:54-150` expects x64 assets and the Electron merge.
- `scripts/mac-update-floor.ts:15` `MAC_UPDATE_FLOOR = "22.0.0"`. Its test is `scripts/mac-update-floor.test.ts:28-35`.
- `scripts/tauri-packaging-config.test.ts:167-180` asserts the x64 asset names. Phase 2 must be merged first, because both phases edit this file.
- `src-tauri/src/updater/feed.rs:172` `mac_asset` picks the asset by architecture. Its tests stay as they are.

## Files

- Modify: `scripts/release-feeds.ts`, `scripts/release-feeds.test.ts`, `scripts/mac-update-floor.ts`, `scripts/mac-update-floor.test.ts`, `scripts/tauri-packaging-config.test.ts` (asset-name test only), `AGENTS.md`, `README.md`, `README.vi.md`, `CHANGELOG.md`, `site/index.html`

## Tasks

### Task 7.1 — Red: arm64-only feed tests
- Target files: `scripts/release-feeds.test.ts`, `scripts/tauri-packaging-config.test.ts`.
- Steps:
  1. In `bundles()` (the fixture helper in `release-feeds.test.ts`) drop the x64 bundle.
  2. `renames to the invariant asset names` expects exactly `Sai-ATLAS-1.2.3-x86_64.AppImage`, `sai-atlas_1.2.3_amd64.deb`, `Sai-ATLAS-1.2.3-arm64.dmg`, `Sai-ATLAS-1.2.3-arm64.zip`, `omp-1.2.3-arm64.dmg`, `latest-linux.yml` and `latest-mac.yml`.
  3. Rename `lists every DMG in latest-mac.yml` to `lists only the arm64 assets in latest-mac.yml`, expecting `["Sai-ATLAS-1.2.3-arm64.zip","Sai-ATLAS-1.2.3-arm64.dmg","omp-1.2.3-arm64.dmg"]`.
  4. `bridge copies are byte-identical`: keep the arm64 asserts only.
  5. Delete `merges the Electron macOS feed unchanged while that build still ships`.
  6. Add `rejects an Intel macOS bundle`: `parseArgs`-level, through `buildRelease` called with `{ macX64: "x" } as never`, or via the CLI with `--mac-x64 x`. Expect a throw matching `/unknown option --mac-x64|arm64 only/`. Export `parseArgs` if needed.
  7. In `writes minimumSystemVersion`, keep `22.4.0`.
  8. In `tauri-packaging-config.test.ts:167-180`, expect `assetNames` without `macX64Dmg`, `macX64Zip` and `bridgeX64Dmg`.
- Verify (red): `bunx vitest run scripts/release-feeds.test.ts scripts/tauri-packaging-config.test.ts` exits non-zero on the changed expectations. Passing is a failure of this task.

### Task 7.2 — Green: arm64-only feeds
- Target files: `scripts/release-feeds.ts`.
- Steps:
  1. `assetNames`: remove `macX64Dmg`, `macX64Zip` and `bridgeX64Dmg`.
  2. `ReleaseInputs`: remove `macX64` and `electronMacFeed`. Dropping the Electron feed merge is safe because Linux 0.9.17 already ships from `main` before this plan's release (Phase 8 precondition), and no Electron macOS build is ever released again. `buildRelease`: when `inputs.macArm64` is set, place the arm64 DMG, make the arm64 ZIP, place the arm64 bridge copy, and write `latest-mac.yml` with files in the order `[arm64 zip, arm64 dmg, bridge arm64 dmg]`. Delete `mergeElectronFeed` and the mutual-exclusion check.
  3. `parseArgs`: `known = ["version","out","linux","mac-arm64"]`.
  4. Update the header comment (lines 1-20): arm64 only, Tauri bundle.
- Verify: `bunx vitest run scripts/release-feeds.test.ts scripts/tauri-packaging-config.test.ts` exits 0, and `grep -n "x64\|electron" scripts/release-feeds.ts` prints no line about macOS (the Linux `x86_64` AppImage name may remain).

### Task 7.2b — A macOS updater check test
- Goal: a test drives `updater:check` end to end on a Mac against the feed this phase writes. Phase 1 gated the deb-feed updater tests to Linux (host log `gated: updater::tests::…`).
- Target files: `src-tauri/src/updater/mod.rs` (tests).
- Steps: add `#[cfg(target_os = "macos")] check_reports_an_available_manual_update_for_this_mac` with a feed listing `Sai-ATLAS-0.9.16-arm64.zip`, `Sai-ATLAS-0.9.16-arm64.dmg` and `omp-0.9.16-arm64.dmg`, and `Setup { install_mode: Manual, private_downloads: false, kind: None, .. }`. Expect `{"state":"available","version":"0.9.16","notes":"Faster dictation","mode":"manual"}` and `active.asset.name == "Sai-ATLAS-0.9.16-arm64.dmg"`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features check_reports_an_available_manual_update_for_this_mac` on the Mac prints `… ok`.

### Task 7.3 — Red/green: floor 22.4.0
- Target files: `scripts/mac-update-floor.ts`, `scripts/mac-update-floor.test.ts`.
- Steps:
  1. Red. In `mac-update-floor.test.ts`:
     - change `accepts the floor and anything above it` to use `22.4.0`;
     - add `rejects macOS 13.0 now that the app needs 13.3`: `macUpdateFloorError(metadata("minimumSystemVersion: 22.0.0\n"))` is not null.
     - Verify (red): `bunx vitest run scripts/mac-update-floor.test.ts` exits non-zero on the new test.
  2. Green. Set `MAC_UPDATE_FLOOR = "22.4.0"` and rewrite the doc comment: the Tauri app needs macOS 13.3 (Safari 16.4 WebKit; `src-tauri/tauri.macos.conf.json`), and Darwin 22.4 is macOS 13.3. Remove the Electron 44 wording.
- Verify: `bunx vitest run scripts/mac-update-floor.test.ts scripts/tauri-packaging-config.test.ts scripts/release-feeds.test.ts` exits 0.

### Task 7.4 — AGENTS.md
- Goal: AGENTS.md describes the Tauri macOS app, arm64 only.
- Target files: `AGENTS.md`. Read it fully first.
- Steps (change only these statements):
  1. "Sidecar & Packaging Rules", the first paragraph: "Two shells ship it…" becomes "Linux and macOS run the Tauri shell (Rust core in `src-tauri/`; WebKitGTK on Linux, WKWebView on macOS); the Electron sources remain in the tree until their removal."
  2. Replace the `build:omp:x64` sentence ("cross-build Intel…") with "macOS ships arm64 only."
  3. Replace the bullet "Packaging reads the sidecar via `extraResources`… always package Intel with…" with a "macOS (Tauri) packaging" bullet. It covers: `bun run package:tauri:mac:arm64` builds the pack, stages `resources/omp` as `externalBin` (`Contents/MacOS/omp`), ships the pack at `Contents/Resources/assistant-pack`, and runs `src-tauri/macos/finalize-app.ts`, which re-signs the sidecar with `src-tauri/macos/omp.entitlements`, then the app with `src-tauri/macos/app.entitlements` (ad-hoc, hardened runtime), and makes the DMG; then `bun scripts/tauri-mac-smoke.ts "<app>"` checks it.
  4. "Build, Test, Release" → Build: replace the two `package:mac:*` commands with `bun run package:tauri:mac:arm64`.
  5. Release flow, macOS part: "build both DMGs" → "build the arm64 DMG". The assets are `Sai-ATLAS-<v>-arm64.dmg`, the bridge copy `omp-<v>-arm64.dmg` and `Sai-ATLAS-<v>-arm64.zip`. `latest-mac.yml` is written by `bun scripts/release-feeds.ts --version <v> --mac-arm64 src-tauri/target/aarch64-apple-darwin/release/bundle [--linux <dir>]` and lists the arm64 assets only, with `minimumSystemVersion: 22.4.0`. Then run `bun run check:mac-update-floor <latest-mac.yml>`. The smoke is `bun scripts/tauri-mac-smoke.ts`, plus the manual rows from this plan's Phase 6. Remove "0.9.x builds find their update only through the `omp-` names" only if it is false. It stays true for the bridge copy, so keep it. Add: "every release carries both `latest-linux.yml` and `latest-mac.yml`; a release with only one breaks the other OS's update check."
- Verify: `grep -c "package:mac:x64\|build:omp:x64\|electron-builder.x64" AGENTS.md` prints `0`, `grep -c "package:tauri:mac:arm64" AGENTS.md` prints at least `2`, and `grep -c "22.4.0" AGENTS.md` prints at least `1`.

### Task 7.5 — README (en, vi) and CHANGELOG
- Target files: `README.md` (sections "Install & start", "Build from source", "Release process (maintainers)" steps 5–7), `README.vi.md` (the same sections), `CHANGELOG.md` (`## [Unreleased]`).
- Steps:
  1. README:
     - Install: the macOS download is `Sai-ATLAS-<v>-arm64.dmg` (Apple silicon only; macOS 13.3 or later).
     - First open of an ad-hoc signed app: System Settings → Privacy & Security → "Open Anyway" after the first blocked launch.
     - Keep the existing migration steps (quit omp, install Sai ATLAS, trash `omp.app`, re-pin, grant access again).
  2. README release steps 5–7:
     - step 5 builds only `bun run build:omp`;
     - step 6 checks `Contents/MacOS/omp` with `file` and runs `bun scripts/tauri-mac-smoke.ts`;
     - step 7 uses `--mac-arm64 <bundle dir>`, names only the arm64 bridge copy and sets `22.4.0`, and drops `--electron-mac-feed`.
     - In `README.vi.md`, mirror the same facts in Vietnamese.
  3. CHANGELOG `### Changed`, add the entry "**macOS runs on Tauri**: …". It covers: the Mac app now uses the system WebKit (WKWebView) instead of Electron; Apple silicon only; macOS 13.3 or later; the download is a DMG to install by hand next to (and then instead of) `omp.app`; the first launch needs "Open Anyway" in Privacy & Security.
- Verify: `grep -c "electron-mac-feed\|omp-<version>.dmg\|build:omp:x64" README.md` prints `0`, `grep -c "arm64" README.vi.md` prints at least `1`, and `grep -c "macOS runs on Tauri" CHANGELOG.md` prints `1`.

### Task 7.5b — Public site: remove the Intel download
- Goal: `site/index.html` offers only the arm64 DMG, so no button points at an asset that will not exist.
- Target files: `site/index.html` (read it fully first; on 2026-10-08 the Intel references were the `data-omp-dmg="x64"` buttons at lines 390 and 528, the "macOS arm64 / x64" text at line 7, and the `["arm64", "x64"]` loop at line 648).
- Steps:
  1. Delete both `data-omp-dmg="x64"` buttons, change the line-7 text to "macOS arm64 (Apple silicon)", and change the loop to `["arm64"]`.
  2. Add "Apple silicon, macOS 13.3 or later" beside the remaining macOS button, in the page's existing style.
  3. Do not push. A push to `main` touching `site/**` deploys Pages (`.github/workflows/pages.yml`), so it rides with the Phase 8 push, which needs the user's go-ahead.
- Verify: `grep -c 'x64' site/index.html` prints `0`, and `grep -c 'data-omp-dmg="arm64"' site/index.html` prints at least `1`.

### Task 7.6 — Regression gate and commit
- Steps: regression gate items 5–7 (no Rust change), plus `bunx biome check scripts/release-feeds.ts scripts/release-feeds.test.ts scripts/mac-update-floor.ts scripts/mac-update-floor.test.ts scripts/tauri-packaging-config.test.ts`. Commit `build(release): arm64-only macOS feed from the Tauri bundle` and `docs: describe the Tauri macOS app`.
- Verify: all commands exit 0.

## Test matrix

| Test | Red | Green |
|---|---|---|
| release-feeds: asset names, arm64-only feed, bridge copy, Intel rejected | 7.1 | 7.2 |
| packaging-config asset names | 7.1 | 7.2 |
| mac-update-floor: 22.4.0 accepted, 22.0.0 rejected | 7.3.1 | 7.3.2 |
| Docs | — | 7.4/7.5 greps |

## Regression gate

Plan regression gate items 5–7.

## Rollback

Revert the commits. Release tooling is used only at release time (Phase 8).

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

