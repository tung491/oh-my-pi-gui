---
phase: 2
title: "A packaged .app with the pack and signed sidecar"
status: pending
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 2: A packaged .app with the pack and signed sidecar

## Goal

`bun run package:tauri:mac:arm64` produces a `.app` whose sidecar `Contents/MacOS/omp` carries only the sidecar entitlements and whose assistant pack sits at `Contents/Resources/assistant-pack`. The GUI finds that pack and the launched app starts a session sidecar. The phase also produces a DMG made from the re-signed app, and removes the Intel macOS scripts.

## Context

- `src-tauri/src/omp/assistant_pack.rs:42-57` `resolve_pack_dir(binary, search_from)` returns `<binary dir>/assistant-pack`, else a walk-up `resources/assistant-pack` from `search_from`. In a packaged build `search_from` is empty (`src-tauri/src/omp/manager.rs:468-474` `pack_search_from`), and the binary is `Contents/MacOS/omp`. So today it resolves `Contents/MacOS/assistant-pack`, which does not exist, and `manager.rs:542-546` refuses every session.
- `src-tauri/macos/sidecar.conf.json` holds `externalBin` only. The Linux overlay also maps `"../resources/assistant-pack/": "assistant-pack/"` (`src-tauri/linux/sidecar.conf.json`).
- `package.json` `package:tauri:mac:arm64` has no `bun run build:pack`, unlike `package:tauri:linux`.
- `scripts/tauri-packaging-config.test.ts:187-190` asserts the macOS overlay has no `resources`, and `:213-217` lists `package:tauri:mac:x64`.
- Tauri signs `externalBin` with the app's entitlements, so the sidecar would get `audio-input` and no JIT.

## Files

- Modify: `src-tauri/src/omp/assistant_pack.rs`, `src-tauri/macos/sidecar.conf.json`, `src-tauri/macos/omp.entitlements` (only if Task 1.7 decided so), `src-tauri/tauri.macos.conf.json`, `package.json` (scripts only), `scripts/stage-tauri-sidecar.ts`, `scripts/tauri-packaging-config.test.ts`
- Create: `src-tauri/macos/finalize-app.ts`, `scripts/finalize-app.test.ts`

## Tasks

### Task 2.1 — Red: the pack is found in Contents/Resources
- Goal: a failing Rust test that describes the macOS bundle layout.
- Target files: `src-tauri/src/omp/assistant_pack.rs`, `mod tests` (after `resolves_the_pack_beside_the_sidecar_binary`, around line 359).
- Steps:
  1. Add the test `resolves_the_pack_in_the_app_bundle_resources`:
     - temp root; `binary = root/Sai ATLAS.app/Contents/MacOS/omp` (`write_file`); `write_pack(root/Sai ATLAS.app/Contents/Resources/assistant-pack, PACK_FILES)`.
     - `assert_eq!(resolve_pack_dir(&binary, &[]), root/Sai ATLAS.app/Contents/Resources/assistant-pack)`.
     - With no pack anywhere (second temp root, same layout, no `write_pack`): `assert_eq!(resolve_pack_dir(&binary2, &[]), root2/…/Contents/Resources/assistant-pack)`, so the missing-file message names where the pack belongs in a bundle.
     - A binary in a folder named `MacOS` whose parent is not `Contents` keeps the beside-binary rule: `assert_eq!(resolve_pack_dir(&root3/MacOS/omp, &[]), root3/MacOS/assistant-pack)`.
- Success criteria: the test compiles and fails on the first assertion.
- Verify (red): `cargo test --manifest-path src-tauri/Cargo.toml --all-features resolves_the_pack_in_the_app_bundle_resources` exits non-zero with an assertion failure (`assertion `left == right` failed`). A pass here is a failure of this task.

### Task 2.2 — Green: the bundle rule in resolve_pack_dir
- Goal: the Task 2.1 test passes, and every existing `resolve_pack_dir` test still passes.
- Target files: `src-tauri/src/omp/assistant_pack.rs` (`resolve_pack_dir`, its doc comment).
- Steps:
  1. Add a private fn `bundle_resources_pack(binary: &Path) -> Option<PathBuf>`. It returns `Some(<binary dir>/../Resources/assistant-pack)`, made absolute and lexically joined without `..` (use `parent()` twice, then `.join("Resources").join(PACK_DIR_NAME)`), when the binary's parent's file name is `MacOS` and its grandparent's file name is `Contents`. Otherwise it returns `None`. The rule is structural, not `cfg`-gated, so it is tested on every OS.
  2. In `resolve_pack_dir`: compute `bundle = bundle_resources_pack(binary)`. If `bundle` is a dir, return it, before the beside-binary check. In the final fallback, prefer `bundle` over `beside`.
  3. Extend the doc comment with one sentence: in a macOS bundle the pack lives in `Contents/Resources`, which the code seal covers.
- Success criteria: green.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features omp::assistant_pack` exits 0 and prints `test result: ok`.

### Task 2.3 — Red: packaging config tests for the macOS overlay and arm64-only scripts
- Goal: failing vitest assertions that pin the new macOS packaging contract.
- Target files: `scripts/tauri-packaging-config.test.ts` (tests at lines 187-190 and 213-217).
- Steps:
  1. Rename the test at line 187 to `the macOS config ships binaries/omp as externalBin and the assistant pack as a resource`. Assert `bundled("macos").bundle?.externalBin` equals `["binaries/omp"]` and `bundled("macos").bundle?.resources` equals `{ "../resources/assistant-pack/": "assistant-pack/" }`.
  2. In the test at line 213, delete the `"package:tauri:mac:x64"` entry. Add assertions that `package.json` scripts have no key `package:tauri:mac:x64` and no key `build:omp:x64`, and that `scripts["package:tauri:mac:arm64"]` starts with `bun run build:pack && ` and contains `bun src-tauri/macos/finalize-app.ts`.
  3. Add the test `the macOS config builds only the app bundle; the finalize step makes the DMG`: `expect(platform("macos").bundle?.targets).toEqual(["app"])`. Change the existing `toEqual(["dmg", "app"])` at line 170 to `["app"]`.
  4. Add the test `the sidecar entitlements hold only what the Bun runtime needs`: read `src-tauri/macos/omp.entitlements`, collect every `<key>…</key>`, and expect exactly `["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]`. The test hard-codes this list and never reads anything under `plans/`. If the host log holds `entitlements: add disable-library-validation` (Task 1.7), you, the executor, write `"com.apple.security.cs.disable-library-validation"` into the expected list here, and Task 2.4 step 5 adds the key to the file in the same commit. Extend the existing exact-dict test at `scripts/tauri-packaging-config.test.ts:546-554` the same way rather than duplicating it if it already covers this file. Read `src-tauri/macos/app.entitlements` the same way and expect exactly `["com.apple.security.device.audio-input"]`.
  5. In `scripts/stage-tauri-sidecar.ts` add nothing yet.
- Success criteria: the suite fails on the new assertions only.
- Verify (red): `bunx vitest run scripts/tauri-packaging-config.test.ts` exits non-zero, and its output names the renamed externalBin test and the `["app"]` assertion as failing. Passing here is a failure of this task.

### Task 2.4 — Green: overlay, config, scripts, entitlements
- Goal: Task 2.3 passes.
- Target files: `src-tauri/macos/sidecar.conf.json`, `src-tauri/tauri.macos.conf.json`, `package.json` (`scripts`), `scripts/stage-tauri-sidecar.ts` (`SIDECAR_SOURCES`), `src-tauri/macos/omp.entitlements` (conditional).
- Steps:
  1. `src-tauri/macos/sidecar.conf.json` → `{ "bundle": { "externalBin": ["binaries/omp"], "resources": { "../resources/assistant-pack/": "assistant-pack/" } } }`
  2. `src-tauri/tauri.macos.conf.json`: `"targets": ["app"]`. Keep `minimumSystemVersion` `13.3`, `signingIdentity` `-` and `entitlements`.
  3. `package.json`:
     - delete the `package:tauri:mac:x64` and `build:omp:x64` scripts;
     - set `package:tauri:mac:arm64` to `bun run build:pack && bun scripts/stage-tauri-sidecar.ts aarch64-apple-darwin && bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo tauri build --target aarch64-apple-darwin --config src-tauri/macos/sidecar.conf.json' && bun src-tauri/macos/finalize-app.ts src-tauri/target/aarch64-apple-darwin/release/bundle`.
  4. `scripts/stage-tauri-sidecar.ts`: remove the `"x86_64-apple-darwin": "resources/omp.x64"` entry.
  5. Only if the host log says `entitlements: add disable-library-validation`: add `<key>com.apple.security.cs.disable-library-validation</key><true/>` to `src-tauri/macos/omp.entitlements`, and extend its comment: "and, ad-hoc signed, loading its own native addon".
  6. `grep -rn "omp.x64\|x86_64-apple-darwin\|build:omp:x64" scripts src-tauri package.json` must now list only lines in `scripts/release-feeds.ts`, `scripts/release-feeds.test.ts` and `src-tauri/src/updater/` (Phase 7 owns the feed script; the updater keeps its x64 rule for completeness).
- Success criteria: green, and `src-tauri/macos/finalize-app.ts` does not exist yet (Task 2.6 creates it).
- Verify: `bunx vitest run scripts/tauri-packaging-config.test.ts` exits 0.

### Task 2.5 — Red: finalize-app tests
- Goal: failing unit tests for the pure parts of the finalize step.
- Target files: `scripts/finalize-app.test.ts` (create; pattern: `scripts/finalize-deb.test.ts` imports from `../src-tauri/linux/finalize-deb`).
- Steps: import `{ finalizePlan, dmgNameFor }` from `../src-tauri/macos/finalize-app`, and write:
  1. `it("signs the sidecar before the app, each with its own entitlements")`: `finalizePlan("/b/macos/Sai ATLAS.app", "/repo")` returns a list of argv arrays whose first two are exactly `["codesign","--force","--sign","-","--options","runtime","--entitlements","/repo/src-tauri/macos/omp.entitlements","/b/macos/Sai ATLAS.app/Contents/MacOS/omp"]` and `["codesign","--force","--sign","-","--options","runtime","--entitlements","/repo/src-tauri/macos/app.entitlements","/b/macos/Sai ATLAS.app"]`, followed by `["codesign","--verify","--strict","--deep","/b/macos/Sai ATLAS.app"]`. No argv contains `--deep` together with `--sign`.
  2. `it("names the DMG the way the Tauri bundler does")`: `dmgNameFor("0.9.18")` is `Sai ATLAS_0.9.18_aarch64.dmg`.
- Verify (red): `bunx vitest run scripts/finalize-app.test.ts` exits non-zero (module not found). Passing is a failure of this task.

### Task 2.6 — Green: src-tauri/macos/finalize-app.ts
- Goal: a finalize script that re-signs and makes the DMG, with the Task 2.5 tests green.
- Target files: `src-tauri/macos/finalize-app.ts` (create).
- Steps:
  1. Header doc comment in the style of `src-tauri/linux/finalize-deb.ts:1-30`. It states why: the bundler signs `externalBin` with the app's entitlements, so the sidecar is re-signed with its own, then the app, and the DMG is built from the re-signed app.
  2. Export `finalizePlan(appPath: string, root: string): string[][]` and `dmgNameFor(version: string): string`, exactly as tested.
  3. `if (import.meta.main)`: argument = the bundle dir (`…/release/bundle`).
     - Find exactly one `*.app` in `<bundle>/macos` (else exit 1 with a message). Read `version` from the repo's `package.json`.
     - Run every `finalizePlan` argv with `Bun.spawnSync`, stopping on the first non-zero exit.
     - Make the DMG: `stage=$(mktemp -d)`, `ditto "<app>" "<stage>/Sai ATLAS.app"`, `ln -s /Applications "<stage>/Applications"`, `mkdir -p <bundle>/dmg`, remove any `*.dmg` there, then `hdiutil create -volname "Sai ATLAS" -srcfolder <stage> -fs HFS+ -format UDZO -ov "<bundle>/dmg/<dmgNameFor(version)>"`.
     - Print `finalized <app>` and `dmg <path>`.
  4. Use only `node:fs`, `node:path`, `node:os` and Bun APIs, with no new dependency.
- Success criteria: tests green, and biome clean.
- Verify: `bunx vitest run scripts/finalize-app.test.ts` exits 0, and `bunx biome check src-tauri/macos/finalize-app.ts scripts/finalize-app.test.ts` exits 0.

### Task 2.7 — Build the package
- Goal: a real finalized `.app` and DMG.
- Steps:
  1. `test -x resources/omp` (else redo Task 1.4).
  2. `bun run package:tauri:mac:arm64 2>&1 | tee "$TMPDIR/package-mac.txt"`
- Success criteria: exit 0; `…/bundle/macos/Sai ATLAS.app` and `…/bundle/dmg/Sai ATLAS_<version>_aarch64.dmg` exist.
- Verify: the command exits 0, and `ls src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app | wc -l` prints `1`, and `ls src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg | wc -l` prints `1`.

### Task 2.8 — Inspect the bundle by hand (the harness automates this in Phase 3)
- Goal: evidence that the layout, signatures and URL scheme are right before building the harness.
- Steps (`A="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app"`):
  1. `ls "$A/Contents/MacOS/omp" "$A/Contents/Resources/assistant-pack/config.yml"`
  2. `codesign -d --entitlements - --xml "$A/Contents/MacOS/omp" 2>/dev/null | plutil -p -` and the same for `"$A"`
  3. `codesign -dv "$A" 2>&1 | grep -E "Identifier=|flags="`
  4. `plutil -extract CFBundleURLTypes json -o - "$A/Contents/Info.plist"`
  5. `bun scripts/check-assistant-pack.ts "$A/Contents/MacOS/omp" "$A/Contents/Resources/assistant-pack"`
  6. Paste all output to the host log under `## First bundle`.
- Success criteria: both files exist; the sidecar shows allow-jit (and no audio-input); the app shows audio-input only; `Identifier=vn.io.vif.saiatlas` and `flags=…(adhoc,runtime)`; the URL types contain `"omp"`; the pack check exits 0.
- Verify: `codesign -d --entitlements - --xml "$A/Contents/MacOS/omp" 2>/dev/null | grep -c audio-input` prints `0`, `codesign -dv "$A" 2>&1 | grep -c "Identifier=vn.io.vif.saiatlas"` prints `1`, `plutil -extract CFBundleURLTypes json -o - "$A/Contents/Info.plist" | grep -c '"omp"'` prints at least `1`, and step 5 exits 0.

### Task 2.9 — First launch with a throwaway profile
- Goal: the packaged app starts a supervised session sidecar with the bundled pack.
- Steps:
  1. `P=$(mktemp -d); mkdir -p "$P/project"; PI_CODING_AGENT_DIR="$P/agent" "$A/Contents/MacOS/sai-atlas" --user-data-dir="$P/profile" "$P/project" & GUI=$!`
  2. Wait up to 30 s: `for i in $(seq 30); do pgrep -f -- "--extension $PWD/$A/Contents/Resources/assistant-pack" >/dev/null && break; sleep 1; done`
  3. `ps -axo pid,ppid,command | grep -E "sai-atlas|omp --mode rpc-ui" | grep -v grep` → host log.
  4. `kill -TERM $GUI`; wait 10 s; `pgrep -f "$PWD/$A" || echo none`.
- Success criteria: a process `…/Contents/MacOS/sai-atlas --omp-supervise …` is a child of `$GUI`, an `omp --mode rpc-ui` process is its child, and the omp argv contains `--extension <abs>/Contents/Resources/assistant-pack`. After TERM nothing under `$A` remains.
- Verify: step 2 ends before 30 s (the loop broke); `cat "$P/profile/logs/gui-runtime.jsonl" 2>/dev/null | grep -ciE "assistant-pack|sidecar-restart"` prints `0` (no refusal or restart was logged); and step 4 prints `none`.

### Task 2.10 — Regression gate and commit
- Steps: regression gate 1–7 with `bunx biome check src-tauri/macos/finalize-app.ts scripts/finalize-app.test.ts scripts/tauri-packaging-config.test.ts scripts/stage-tauri-sidecar.ts`. Commit as `feat(macos): bundle the assistant pack and sign the sidecar with its own entitlements` and `build(macos): drop the Intel macOS build scripts`.
- Verify: all gate commands exit 0.

## Test matrix

| Level | Test | Red before | Green after |
|---|---|---|---|
| Rust unit | `resolves_the_pack_in_the_app_bundle_resources` | 2.1 | 2.2 |
| Vitest | packaging config: overlay resources, `["app"]` target, arm64-only scripts, entitlement key sets | 2.3 | 2.4 |
| Vitest | `scripts/finalize-app.test.ts` | 2.5 | 2.6 |
| Packaged | layout, signatures, URL scheme, pack check | — | 2.8 |
| Packaged | launch → supervised sidecar with bundled pack | — | 2.9 |

## Regression gate

Plan regression gate items 1–7.

## Rollback

Revert the two commits. The Linux overlay and Linux scripts are untouched, so Linux packaging is unaffected.

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

