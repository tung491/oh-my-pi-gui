---
phase: 10
title: "Electron removal: delete and rename"
status: pending
priority: P2
effort: "1.5d"
dependencies: [9]
---

# Phase 10: Electron removal: delete and rename

## Goal

No Electron code, config, dependency or script remains, except the Linux 0.9.16 handover modules (`src-tauri/src/electron_relauncher.rs`, `src-tauri/tests/electron_relauncher.rs`, `src-tauri/tests/appimage_handover.rs`) and "Migrating from Electron" notes. The Tauri scripts carry the plain names. CI and the docs describe one Tauri app.

## Tasks

### Task 10.1 — Delete the Electron tree
- Steps:
  1. `git rm -r src/main src/preload e2e electron.vite.config.ts electron-builder.yml electron-builder.x64.yml playwright.config.ts scripts/after-pack.cjs scripts/check-main-bundle.ts src/renderer/boot/boot-electron.ts resources/entitlements.mac.plist`
  2. `git ls-files | grep -E "electron-builder\.win\.yml"`: remove it if listed.
- Verify: `git ls-files | grep -E "^(src/main|src/preload|e2e)/|electron-builder|electron\.vite|playwright\.config|after-pack|check-main-bundle|boot-electron"` prints nothing.

### Task 10.2 — Retire the cross-shell gates whose other side is gone
- Steps:
  1. In every `src-tauri/contracts/*.parity.json`, delete the entries whose `ts` path no longer exists. Check with `for f in src-tauri/contracts/*.parity.json; do bun -e 'const fs=require("fs");const f=process.argv[1];const e=JSON.parse(fs.readFileSync(f,"utf8"));fs.writeFileSync(f,JSON.stringify(e.filter(x=>fs.existsSync(x.ts)),null,2)+"\n")' "$f"; done`. A file may end as `[]`.
  2. `src-tauri/src/i18n.rs`: delete `MAIN_I18N_TS`, `ts_entries` and the test `mirrors_every_text_key_in_the_typescript_table` (lines 201-230). The Rust table is now the only table. Keep every other i18n test.
  3. `git rm e2e-tauri/check-twins.ts`, and remove its mentions: `grep -rn "check-twins" . --include=*.md --include=*.json --include=*.ts --include=*.yml | grep -v plans/`.
- Verify: `for p in src-tauri/contracts/*.parity.json; do bun scripts/check-test-parity.ts "$(basename "$p" .parity.json)" || exit 1; done` exits 0, and `cargo test --manifest-path src-tauri/Cargo.toml --all-features` exits 0.

### Task 10.3 — One renderer config, one tsconfig set
- Steps:
  1. Fold `vite.renderer.shared.ts` into `vite.tauri.config.ts`: inline the shared config, set the `@boot` alias straight to `src/renderer/boot/boot-tauri.ts`, and delete `BOOT_ELECTRON`. Then `git rm vite.renderer.shared.ts`.
  2. `scripts/check-renderer-chunks.ts`: read `out/renderer-tauri` and update the comments (lines 6, 13, 48) to name `vite.tauri.config.ts`.
  3. `tsconfig.node.json` `include`: `["src/shared/**/*.ts", "scripts/**/*.ts", "vite.tauri.config.ts", "e2e-tauri/**/*.ts"]` (keep whatever is already in `tsconfig.wdio.json` out of here if it covers `e2e-tauri`).
- Verify: `bun run build:renderer:tauri && bun scripts/check-renderer-chunks.ts` exits 0, and `bun run check:types` exits 0.

### Task 10.4 — package.json, scripts, CI
- Steps:
  1. `package.json`:
     - remove the dependencies `electron`, `electron-builder`, `electron-vite`, `electron-store`, `electron-updater`, `electron-log` and `@playwright/test`, the `postinstall: install-electron` script, and `"main"`;
     - remove the scripts `dev`, `build`, `preview`, `package`, `package:mac`, `package:mac:arm64`, `package:mac:x64` and `test:e2e`;
     - rename `dev:tauri` → `dev`, `build:renderer:tauri` → `build:renderer`, `build:tauri` → `build`, `test:e2e:tauri` → `test:e2e`, `test:e2e:tauri:packaged` → `test:e2e:packaged`, `package:tauri:linux` → `package:linux:bundle` (keep `package:linux` = the Docker wrapper), `package:tauri:mac:arm64` → `package:mac`.
     - Keep `check:mac-update-floor`.
  2. For `chokidar`, `yaml` and `zod`: remove each one only if `grep -rn "from \"<pkg>\"" src scripts e2e-tauri vite.tauri.config.ts wdio*.ts` prints nothing.
  3. Fix every caller of a renamed script: `grep -rnE "(dev|build|test:e2e|package):tauri|build:renderer:tauri|test:e2e:tauri" scripts .github src-tauri AGENTS.md README.md README.vi.md tsconfig*.json wdio*.ts src-tauri/tauri.conf.json`. This includes `src-tauri/tauri.conf.json` `beforeBuildCommand`, `scripts/tauri-linux-build.sh`, `scripts/check-module.sh:107` (the `bun run build:renderer:tauri` call) and `scripts/tauri-packaging-config.test.ts:213-217`.
  4. `scripts/check-module.sh`: remove `src/main/packaging-config.test.ts` from line 67 and from the vitest call at line 204.
  5. `.github/workflows/ci.yml`: the `linux` job keeps `check:types`, vitest and `bun run build:renderer`, and drops `electron-vite build` and the Electron steps. Rename the step "Test parity with the Electron suite" to "Rust test parity".
  6. `bun install` to refresh `bun.lock`.
- Verify: `grep -E "\"(electron|electron-builder|electron-vite|electron-store|electron-updater|electron-log|@playwright/test)\"" package.json` prints nothing; `bun install` exits 0; `bunx vitest run` exits 0; `bun run check:types` exits 0; `bun run build` exits 0.

### Task 10.5 — Delete the showcase script (user decision, 2026-10-08: delete)
- Steps: check with `grep -rn "showcase" scripts src e2e-tauri package.json` that nothing outside the showcase files imports them, then `git rm scripts/capture-showcase.ts scripts/showcase-fixture.ts scripts/showcase-data.ts` (remove any `package.json` script that runs them), and delete the README "Reproduce the screenshots" section in both `README.md` and `README.vi.md`. The committed screenshot images stay.
- Verify: `bun run check:types` exits 0, `git ls-files scripts | grep -c showcase` prints `0`, and `grep -c "capture-showcase" README.md README.vi.md` prints `0` for both.

### Task 10.6 — Docs
- Target files: `AGENTS.md`, `README.md`, `README.vi.md`, `CHANGELOG.md`. Read each first, and change only what the removal affects:
  - AGENTS.md "Sidecar & Packaging Rules": "Linux and macOS run the Tauri shell". Drop the "Electron sources remain" clause.
  - Where `APP_ID`, the profile path and the per-model context limits live now: `src-tauri/tauri.conf.json` and `src-tauri/src/product.rs`; `src-tauri/src/paths.rs`; `src-tauri/src/ollama/context_fit_scheduler.rs` only. Remove the `src/main/pin-user-data.ts`, `src/main/sidecar.ts`, `src/main/assistant-pack.ts` and `src/main/ollama/context-fit-scheduler.ts` mentions, and point to `src-tauri/src/omp/manager.rs` and `scripts/assistant-pack.ts` instead.
  - "Build, Test, Release": the renamed scripts. Remove the TS↔Rust parity sentence's Electron framing.
  - "Running the GUI Out of Sight": drop the Electron e2e and dev bullets.
  - Code Conventions: unchanged.
  - CHANGELOG `[Unreleased]` → `### Removed`: "The Electron shell is gone; Linux and macOS both run the Tauri app."
- Verify: `grep -c "electron-builder\|electron-vite\|package:mac:arm64\|src/main/" AGENTS.md README.md` prints `0` for each file, except lines inside a "Migrating" section, which you list by line number in the host log. Every command in README "Build from source" runs successfully (run each and paste the exit codes into the host log).

### Task 10.7 — Final gate and commit
- Steps:
  1. Run the regression gate 1–7.
  2. Run `bun run package:mac && bun scripts/tauri-mac-smoke.ts "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app"`.
  3. In `~/WORK/oh-my-pi/packages/gui` (on this branch), run `bun run build:omp`.
  4. Commit `refactor!: remove the Electron shell` (one commit, so a single revert restores Electron).
  5. Ask the user before pushing.
- Verify: every gate exits 0; the smoke prints `tauri-mac-smoke: PASS`; `build:omp` exits 0; `grep -rlniE "electron-builder|electron-vite|electron-updater|@playwright|from \"electron\"" src scripts e2e-tauri package.json .github` prints nothing. CI is green on the pushed branch: `gh run list --repo tung491/oh-my-pi-gui --branch <branch> --limit 1 --json conclusion --jq '.[0].conclusion'` prints `success`.

## Test matrix

| Gate | Command |
|---|---|
| Rust | clippy, `cargo test --all-features`, parity (reduced), snapshots |
| TS | vitest, check:types, biome |
| Build | `bun run build`, `bun run package:mac`, `build:omp` in the monorepo clone |
| Packaged | `scripts/tauri-mac-smoke.ts` |
| CI | ubuntu `linux` and `tauri-linux` jobs |

## Regression gate

Plan regression gate items 1–7, plus the Task 10.7 builds.

## Rollback

`git revert <removal commit>` restores the whole Electron tree in one step, and `electron-final` marks the last Electron state.

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
