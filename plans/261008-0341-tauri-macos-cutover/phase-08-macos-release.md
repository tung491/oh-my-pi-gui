---
phase: 8
title: "macOS release"
status: pending
priority: P1
effort: "0.5d"
dependencies: [6, 7]
---

# Phase 8: macOS release

## Goal

Release `<V>` (the first version after 0.9.17, normally 0.9.18) is published on `tung491/oh-my-pi-gui`. It carries the Tauri macOS arm64 assets and the same-version Linux assets, with both feeds. Every publishing step waits for the user's explicit go-ahead at that moment.

## Preconditions

- `gh release view v0.9.17 --repo tung491/oh-my-pi-gui` exits 0: Linux 0.9.17 is published. If it is not, STOP and ask the user; this release must come after it.
- Phase 6 has zero FAIL and zero NEEDS-HUMAN rows.
- `<V>` = the user-confirmed version. Ask: "Release version for the macOS Tauri cutover — 0.9.18?"

## Tasks

### Task 8.1 — Upstream sync and sidecar rebuild
- Goal: the DMG's sidecar carries current upstream (AGENTS.md: every release starts with a sync).
- Steps:
  1. In `~/WORK/oh-my-pi/packages/gui` (on this branch's commit, via the Task 1.4 step 3 fetch), run `bash scripts/sync-upstream.sh`. On conflicts, resolve them at the monorepo root, commit there, and re-run with `SKIP_MERGE=1`.
  2. `cp ~/WORK/oh-my-pi/packages/gui/resources/omp resources/omp`, then `bun run build:pack && bun scripts/check-assistant-pack.ts resources/omp resources/assistant-pack`.
  3. Record `git -C ~/WORK/oh-my-pi rev-parse HEAD` in the host log, as the release-notes sidecar commit.
- Verify: the pack check exits 0. Pushing monorepo changes to `nornzach/oh-my-pi` happens only with the user's go-ahead.

### Task 8.2 — Version bump, changelog section, commit
- Target files: `package.json` (`version`), `src-tauri/Cargo.toml` (`version`), `src-tauri/Cargo.lock` (the `sai-atlas` package line), `CHANGELOG.md` (move `[Unreleased]` to `## [<V>] - <date>`), `README.md` and `README.vi.md` install links.
- Steps: edit, run `cargo check --manifest-path src-tauri/Cargo.toml` to refresh the lock line, then commit `chore(release): <V>`.
- Verify: `bunx vitest run scripts/tauri-packaging-config.test.ts` exits 0 (the version-equality test), and `grep -c "^version = \"<V>\"" src-tauri/Cargo.toml` prints `1`.

### Task 8.3 — Build and verify the macOS assets
- Steps:
  1. `bun run package:tauri:mac:arm64`
  2. `bun scripts/tauri-mac-smoke.ts "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app"`
  3. Mount the DMG (`hdiutil attach -nobrowse -readonly <dmg>`), then run `codesign --verify --strict --deep "/Volumes/Sai ATLAS/Sai ATLAS.app"` and `file "/Volumes/Sai ATLAS/Sai ATLAS.app/Contents/MacOS/omp"`, then `hdiutil detach "/Volumes/Sai ATLAS"`.
  4. AGENTS.md smoke on the mounted copy: launch it with a throwaway profile through `open -n … --env … --args --user-data-dir=…`, and ask the user to confirm sidecar ready, Settings opens, and one toggle persists (NEEDS-HUMAN, about 2 minutes).
  5. The Linux assets for `<V>` (user decision, 2026-10-08: the user builds them on the Linux host). Ask the user to build the same tag there with the AGENTS.md Linux flow (`bun run package:linux` with `SAI_ATLAS_UPDATE_BASE` unset, `bash scripts/tauri-deb-smoke.sh <deb>`, the fake-microphone smoke and `bash scripts/tauri-wm-geometry-check.sh <deb>`) and copy the bundle directory to this Mac. STOP and wait; never build or fabricate the Linux assets here.
  6. `bun scripts/release-feeds.ts --version <V> --mac-arm64 src-tauri/target/aarch64-apple-darwin/release/bundle --linux <linux bundle dir>`
  7. `bun run check:mac-update-floor dist-release/latest-mac.yml`
- Success criteria: `dist-release/` holds exactly: `Sai-ATLAS-<V>-arm64.dmg`, `Sai-ATLAS-<V>-arm64.zip`, `omp-<V>-arm64.dmg`, `latest-mac.yml`, `Sai-ATLAS-<V>-x86_64.AppImage`, `sai-atlas_<V>_amd64.deb` and `latest-linux.yml`.
- Verify: the smoke prints `tauri-mac-smoke: PASS`; `codesign --verify` exits 0; `file` prints `arm64`; `check:mac-update-floor` exits 0; `grep -c "url:" dist-release/latest-mac.yml` prints `3`; `grep -c "minimumSystemVersion: 22.4.0" dist-release/latest-mac.yml` prints `1`; `cmp dist-release/Sai-ATLAS-<V>-arm64.dmg dist-release/omp-<V>-arm64.dmg` exits 0; and `ditto -x -k dist-release/Sai-ATLAS-<V>-arm64.zip "$(mktemp -d)"` followed by `codesign --verify --strict --deep` on the extracted app exits 0.

### Task 8.4 — Tag, push, draft, upload, publish (user go-ahead at each step)
- Steps. Ask before each command, quoting it, and run it only after an explicit yes:
  1. `git tag v<V> && git push origin tung491/tauri_macos:main v<V>`. The user decides how the branch reaches `main` (a merge or a PR), so ask first.
  2. `gh release create v<V> --repo tung491/oh-my-pi-gui --draft --title "Sai ATLAS <V>" --notes-file <notes>`. The notes:
     - open with the README Mac migration steps (quit omp, install Sai ATLAS, move `omp.app` to the Trash, re-pin, grant microphone and notification access again) and the "Migrating from 0.9.16 on Linux" lines verbatim;
     - then the CHANGELOG section;
     - then "Apple silicon only; macOS 13.3 or later; the first launch needs Open Anyway in Privacy & Security";
     - then the monorepo commit from Task 8.1.
  3. `gh release upload v<V> dist-release/* --repo tung491/oh-my-pi-gui`
  4. `gh release view v<V> --repo tung491/oh-my-pi-gui --json assets --jq '.assets[].name' | sort` → compare with the seven names in Task 8.3.
  5. `gh release edit v<V> --repo tung491/oh-my-pi-gui --draft=false`
- Verify: after publishing, `curl -fsSL https://github.com/tung491/oh-my-pi-gui/releases/latest/download/latest-mac.yml | grep -c "version: <V>"` prints `1`, and the same for `latest-linux.yml`.

### Task 8.5 — Record the live date
- Steps: write `macOS <V> live: <date>` to the host log, and tell the user that Electron removal (Phase 9) starts only when they confirm the release has no blocking defect.
- Verify: `grep -c "^macOS .* live:" plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md` prints `1`.

## Test matrix

Packaged smoke (automated), DMG and ZIP seals, feed contents, floor check, live feed fetch, human smoke on the mounted copy.

## Regression gate

Task 8.3 Verify in full.

## Rollback

- Before publishing: `gh release delete v<V> --repo tung491/oh-my-pi-gui` (user go-ahead).
- After publishing: with the user's go-ahead, mark the release a pre-release so `latest` falls back to 0.9.17, then fix forward with `<V+1>`.

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

