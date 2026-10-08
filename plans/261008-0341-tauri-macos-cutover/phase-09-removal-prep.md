---
phase: 9
title: "Electron removal: move what stays"
status: pending
priority: P2
effort: "1.5d"
dependencies: [8]
---

# Phase 9: Electron removal: move what stays

## Goal

Every kept file that reads or imports from `src/main/**`, `src/preload/**` or `e2e/**` reads the kept copy instead, while Electron still exists and every gate is green. After this phase, Phase 10 can delete files without breaking a build.

## Preconditions

- Phase 8 is published, and the user has confirmed in this conversation that `<V>` has no blocking defect on macOS. Ask: "Is macOS <V> free of blocking defects, so Electron can be removed?" Record the answer and date in the host log. Without a yes, STOP.

## Inventory of kept code that depends on Electron files (verified 2026-10-08)

| Kept file:line | Depends on | Action (task) |
|---|---|---|
| `scripts/build-bundled-omp.ts:44` | `sidecarOutName` from `src/main/bundled-omp-path.ts` | move into `scripts/sidecar-names.ts` (9.2) |
| `scripts/check-assistant-pack.ts:29` | `src/main/assistant-pack.ts` | move module and its test to `scripts/assistant-pack.ts`, `scripts/assistant-pack.test.ts` (9.3) |
| `src-tauri/src/omp/assistant_pack.rs:462` | `include_str!("../../../src/main/assistant-pack.ts")` | point at `scripts/assistant-pack.ts` (9.3) |
| `src-tauri/src/omp/assistant_pack.rs:538` | the string `from "../src/main/assistant-pack"` | `from "./assistant-pack"` (9.3) |
| `src-tauri/src/desktop/app_icons.rs:14` | `include_str!("../../../src/main/tray-mark.ts")` | generated file moves to `src-tauri/icons/tray-mark.ts` (9.4) |
| `scripts/gen-icons.ts:5, 20, 110` | writes `src/main/tray-mark.ts` | write `src-tauri/icons/tray-mark.ts` (9.4) |
| `src-tauri/src/i18n.rs:201-228` | `include_str!("../../src/main/i18n.ts")` in `ts_entries` and the `mirrors_every_text_key_in_the_typescript_table` test | delete that test and helper in Phase 10 with the TS file; the Rust table is the only table (10.2) |
| `e2e-tauri/onboarding.e2e.ts:4` | `src/main/ollama/test-fake-ollama.ts` | move to `e2e-tauri/fake-ollama.ts` (9.5) |
| `e2e-tauri/{packaged-smoke,deep-audit,real-core}.e2e.ts`, `e2e-tauri/session.ts:23` | `e2e/desktop-prefs.ts` | move to `e2e-tauri/desktop-prefs.ts` (9.5) |
| `e2e-tauri/session.ts:30`, `src-tauri/src/omp/shell_env.rs:359`, `src-tauri/src/omp/manager.rs:1100` | `e2e/sidecar-fixture.ts` | move to `e2e-tauri/sidecar-fixture.ts` (9.5) |
| `e2e/sidecar-fixture.ts:5` | `RPC_MAX_FRAME_BYTES`, `RPC_MAX_REASSEMBLED_BYTES` from `../src/main/rpc-bridge` (`src/main/rpc-bridge.ts:8-9`) | move both constants to a new `src/shared/rpc-limits.ts`; `src/main/rpc-bridge.ts` re-imports them from there until Phase 10 (9.5) |
| `src/main/packaging-config.test.ts:279`, `:285`, `:340` | CSP rules "cannot fetch a remote image for markdown a model wrote", "keeps script execution and network calls inside the app", "the quick-entry page ships the same content security policy" | port into `scripts/tauri-packaging-config.test.ts` (9.6) |
| `scripts/check-module.sh:67`, `:204` | `src/main/packaging-config.test.ts` | drop from the list and the vitest call (10.4) |
| `src-tauri/src/ports.rs:848` | asserts `entry.ts.starts_with("src/main/")` over `contracts/cross-module-calls.json` | **keep unchanged**: it checks recorded metadata strings and reads no file, so it still passes after Phase 10. Do not "fix" it. |
| `src-tauri/contracts/*.parity.json` | 41 entries whose `ts` is under `src/main/` | drop them in Phase 10 (10.2) |
| `e2e-tauri/check-twins.ts` | compares to `e2e/*.e2e.ts` | delete in Phase 10 (10.2) |
| `vite.renderer.shared.ts:2-3, 70, 94`, `src/renderer/boot/boot-electron.ts` | the `@boot` alias's Electron target | fold into `vite.tauri.config.ts` in Phase 10 (10.3) |
| `tsconfig.node.json:7` | includes `src/main/**`, `src/preload/**`, `electron.vite.config.ts` | edit in Phase 10 (10.3) |

Before starting, re-run the grep that produced this table, and add any new hit to the table in the host log:
`grep -rnE "src/main/|src/preload/|\.\./e2e/|\"e2e\"" scripts e2e-tauri src/renderer src/shared src-tauri/src src-tauri/tests vite.tauri.config.ts vite.renderer.shared.ts wdio.conf.ts wdio.packaged.conf.ts tsconfig*.json .github | grep -vE "^\S+:[0-9]+:\s*(//|\*)"`

`src-tauri/tests/electron_relauncher.rs`, `src-tauri/src/electron_relauncher.rs` and `src-tauri/tests/appimage_handover.rs` are Linux 0.9.16 Electron→Tauri handover code, not Electron. They stay.

## Tasks

### Task 9.1 — Tag the last Electron commit
- Steps: `git tag electron-final <current main sha>` locally. Ask the user before `git push origin electron-final`.
- Verify: `git rev-parse electron-final` exits 0.

### Task 9.2 — Move sidecarOutName (red/green)
- Steps:
  1. Red. Create `scripts/sidecar-names.test.ts` with the cases from the `sidecarOutName` tests in `src/main/bundled-omp-path.test.ts` (copy them verbatim), importing from `./sidecar-names`. Verify (red): `bunx vitest run scripts/sidecar-names.test.ts` exits non-zero.
  2. Green. Create `scripts/sidecar-names.ts` exporting `sidecarOutName`, copied verbatim. Change `scripts/build-bundled-omp.ts:44` to `import { sidecarOutName } from "./sidecar-names";`. Keep `src/main/bundled-omp-path.ts` working, by importing from `../../scripts/sidecar-names` only if it still compiles under `tsconfig.node.json`. Otherwise leave its copy until Phase 10 deletes it.
- Verify: `bunx vitest run scripts/sidecar-names.test.ts` exits 0, and `grep -n "src/main" scripts/build-bundled-omp.ts` prints nothing.

### Task 9.3 — Move the assistant-pack module
- Steps:
  1. `git mv src/main/assistant-pack.ts scripts/assistant-pack.ts` and `git mv src/main/assistant-pack.test.ts scripts/assistant-pack.test.ts`. Fix the relative imports inside them, and fix every importer: `grep -rln "assistant-pack\"" src scripts e2e-tauri`, then update each one to the new path (`src/main/sidecar.ts` and others under `src/main/` import `../../scripts/assistant-pack`).
  2. `scripts/check-assistant-pack.ts:29` → `from "./assistant-pack"`.
  3. `src-tauri/src/omp/assistant_pack.rs:462` → `include_str!("../../../scripts/assistant-pack.ts")`, and `:538` → `script.find("from \"./assistant-pack\"")` with an updated expect message.
  4. Update `src-tauri/contracts/omp.parity.json`: the entry `{"ts":"src/main/assistant-pack.test.ts", …}` gets `"ts": "scripts/assistant-pack.test.ts"`.
- Verify: `bunx vitest run scripts/assistant-pack.test.ts` exits 0; `cargo test --manifest-path src-tauri/Cargo.toml --all-features omp::assistant_pack` exits 0; `bun scripts/check-test-parity.ts omp` exits 0; `bun run check:types` exits 0.

### Task 9.4 — Move the tray mark
- Steps:
  1. `scripts/gen-icons.ts`: `trayMarkPath` (line 20) → `path.join(packageRoot, "src-tauri", "icons", "tray-mark.ts")`, with the comments at lines 5 and 110 updated to match.
  2. `git mv src/main/tray-mark.ts src-tauri/icons/tray-mark.ts`. Update every importer from `grep -rln "tray-mark" src scripts` (Electron's `src/main/tray.ts` imports `../../src-tauri/icons/tray-mark` until Phase 10).
  3. `src-tauri/src/desktop/app_icons.rs:14` → `include_str!("../../icons/tray-mark.ts")`, and update the doc line at 5.
  4. Run `bun run gen:icons`. Expect no diff: `git diff --stat src-tauri/icons/tray-mark.ts` prints nothing.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features desktop::app_icons` exits 0, and `bun run check:types` exits 0.

### Task 9.5 — Move the e2e helpers the Tauri suite uses
- Steps:
  1. `git mv e2e/desktop-prefs.ts e2e-tauri/desktop-prefs.ts`, `git mv e2e/sidecar-fixture.ts e2e-tauri/sidecar-fixture.ts`, `git mv src/main/ollama/test-fake-ollama.ts e2e-tauri/fake-ollama.ts`.
  2. Fix the imports in the files listed in the inventory. `e2e-tauri/session.ts:30` becomes `path.join(ROOT, "e2e-tauri", "sidecar-fixture.ts")`. `src-tauri/src/omp/shell_env.rs:359` and `src-tauri/src/omp/manager.rs:1100` become `.join("e2e-tauri").join("sidecar-fixture.ts")`. Fix the imports of any Electron file under `src/main/**` or `e2e/**` that used these too, so the Electron build stays green until Phase 10.
  3. Update the `e2e/sidecar-fixture.ts` mention in the `e2e-tauri/session.ts:10` comment.
  4. Create `src/shared/rpc-limits.ts` exporting `RPC_MAX_FRAME_BYTES = 1_048_576` and `RPC_MAX_REASSEMBLED_BYTES = 67_108_864`, moved verbatim with their doc comments from `src/main/rpc-bridge.ts:8-9`. In `src/main/rpc-bridge.ts`, replace the two declarations with `import { RPC_MAX_FRAME_BYTES, RPC_MAX_REASSEMBLED_BYTES } from "../shared/rpc-limits";` plus `export { RPC_MAX_FRAME_BYTES, RPC_MAX_REASSEMBLED_BYTES };` so its importers keep working. In `e2e-tauri/sidecar-fixture.ts`, change the import to `from "../src/shared/rpc-limits"`.
- Verify: `bun run check:types` exits 0; `cargo test --manifest-path src-tauri/Cargo.toml --all-features omp::` exits 0; `grep -rn "\.\./e2e/\|\"e2e\", \"sidecar\|join(\"e2e\")" e2e-tauri src-tauri/src` prints nothing; `grep -rn "src/main/" e2e-tauri` prints nothing.

### Task 9.6 — Port the CSP rules (red/green)
- Steps:
  1. Read the three tests in `src/main/packaging-config.test.ts`: "cannot fetch a remote image for markdown a model wrote" (line 279), "keeps script execution and network calls inside the app" (line 285) and "the quick-entry page ships the same content security policy" (line 340), with any helpers they call. If the lines moved, find them by title with `grep -n`.
  2. Add three tests with the same titles to `scripts/tauri-packaging-config.test.ts`. They assert the same rules against `src-tauri/tauri.conf.json` `app.security.csp`, which `CSP policy equals the meta CSP in src/renderer/index.html` (line 235) already ties to the page, and against the quick-entry page's CSP.
  3. Red check: temporarily change `img-src 'self' data: blob:` in a local copy of the policy string inside the test (not in config) to include `https:`, and confirm the remote-image test fails. Revert. Verify (red): that temporary run exits non-zero.
- Verify (green): `bunx vitest run scripts/tauri-packaging-config.test.ts` exits 0 with the three new titles in the output (`--reporter=verbose`).

### Task 9.7 — Regression gate and commit
- Steps: regression gate 1–7, plus `bun run build` (Electron still builds) and `bun run build:renderer:tauri`. Commit `refactor: keep shared scripts and fixtures outside the Electron tree`.
- Verify: every command exits 0.

## Test matrix

| Moved item | Guard |
|---|---|
| `sidecarOutName` | `scripts/sidecar-names.test.ts` (red 9.2.1) |
| assistant-pack module | `scripts/assistant-pack.test.ts`, Rust `omp::assistant_pack`, parity `omp` |
| tray mark | `desktop::app_icons` tests, `gen:icons` no-diff |
| fixtures | `check:types`, Rust `omp::` tests |
| CSP rules | three ported tests (red 9.6.3) |

## Regression gate

Plan regression gate items 1–7, plus `bun run build`.

## Rollback

Revert the commit. Nothing is deleted in this phase.

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

