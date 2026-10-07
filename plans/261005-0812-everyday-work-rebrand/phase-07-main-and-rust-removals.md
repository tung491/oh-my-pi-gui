---
phase: 7
title: "Main-process and Rust removals, Windows"
status: done
priority: P1
effort: "3d"
dependencies: [6]
---

# Phase 7: Main-process and Rust removals, Windows

## Goal

Delete the TypeScript + Rust pairs behind the removed developer surfaces (benchmark, stats server), the developer items in the tray and app menu of both shells, and every Windows build path (R13). Bring the e2e suites back to green against the slimmed UI.

## Context

- Plan index `./plan.md`.
- Pairs and parity rows: `src/main/benchmark-runner.ts` ↔ `src-tauri/src/omp/bench.rs`; `src/main/stats-server.ts` + `stats-restart-policy.ts` + `stats-client.ts` ↔ `src-tauri/src/omp/stats.rs` + `stats_restart_policy.rs`; rows in `src-tauri/contracts/omp.parity.json`. IPC: `BENCH_RUN`, `BENCH_ABORT`, `STATS_FETCH` (`src/shared/ipc-types.ts:140-142`), the `stats`/`bench` bridge entries (`src/shared/bridge/create-omp-api.ts:280-288`), handlers in `src/main/ipc.ts`, `src/main/index.ts`, `src-tauri/src/omp/ipc.rs`, `omp/mod.rs`, and `ports.rs:502`. Public-API snapshot lines in `src-tauri/contracts/ports.api.txt:53-55` (and `omp.api.txt`).
- Tray/menu (both shells keep identical sets):
  - App menu actions sent today (`src/main/menu.ts`, 33 distinct ids; the same set in `src-tauri/src/desktop/menu.rs`). **Delete:** `new-chat-tab`, `open-branch-picker`, `open-context-report`, `open-debug`, `open-extensions`, `open-git`, `open-import`, `open-inventory`, `open-model-roles`, `open-modes`, `open-pr-center`, `open-project`, `open-session-tree`, `open-share-session`, `open-stats`, `open-usage`, `open-workspace-dirs`, and the Handoff item (`menu.ts:222`). **Keep:** `close-tab`, `export-html`, `new-session`, `new-tab`, `open-agent-hub`, `open-capabilities`, `open-command-center`, `open-hotkeys`, `open-jobs`, `open-model-picker`, `open-providers`, `open-session-info`, `open-settings`, `restart-sidecar`, `toggle-panel`, `toggle-sidebar`.
  - Tray: TS `src/main/tray.ts` (Usage :90, Open project :101, Handoff :110, approval radio :127-135 which sends `set-approval` → the renderer's `set_setting tools.approvalMode`, a write to the user's global omp config); Rust `src-tauri/src/desktop/tray.rs` (`ID_USAGE`, `ID_ADD_WORKSPACE`, `ID_HANDOFF` at :20-23 and their items near :210-213; the approval radio at :30, :106-107, :206). Delete all of these; keep the read-only "model · thinking · fast · approval" label (`tray.ts:65-71`).
  - The `MenuAction` union (`src/shared/ipc-types.ts:315-346`) and the `set-approval` event type stay in this phase: Phase 8 removes the renderer handlers in parallel, and Phase 9 Task 9.0 trims the union once both have merged (so no phase breaks another's type check).
  - Labels: `src/main/tray-labels.ts`, `src/main/i18n.ts`, `src-tauri/src/desktop/tray_labels.rs:94-119`, `src-tauri/src/i18n.rs` (`MainTextKey`).
- Windows: `electron-builder.win.yml`, the `win`/`nsis` block of `electron-builder.yml`, `src-tauri/tauri.windows.conf.json`, `src-tauri/windows/`, `package.json` scripts `package:win`, `package:win:dir`, `build:omp:win`, `package:tauri:win`; the nsis.guid rule in `AGENTS.md` "Product identity". Test and script sites that read or assert Windows files (every one must be edited, none may be left reading a deleted file):
  - `src/main/packaging-config.test.ts:156-174` ("Windows package config") and `:233-247` (the config-file list and nsis.guid);
  - `scripts/tauri-packaging-config.test.ts:52, 70-71, 91, 113, 116, 174, 191-195, 208, 219, 274, 472-476`;
  - `scripts/check-module.sh:63-64, 208-217` (Windows paths and the Windows-target `cargo check`);
  - `scripts/release-feeds.ts:6-7, 80, 203` (Windows feed arguments). Leave `win32` branches in shared code (`bundled-omp-path.ts`, `paths.rs`).
- Do not touch `gen:stats` in `scripts/sync-upstream.sh`: the sidecar build embeds omp's own stats archive (`scripts/build-bundled-omp.ts:26-27`); that is omp's feature, not the GUI dashboard.
- Wave C: parallel with Phase 8.

## Ownership

- May modify or delete: `src/main/**` (except `assistant-pack.ts` and its test), `src/shared/ipc-types.ts`, `src/shared/bridge/**`, `src-tauri/src/**` (except `omp/assistant_pack.rs`), `src-tauri/contracts/**`, `src-tauri/tauri.windows.conf.json`, `src-tauri/windows/**`, `electron-builder.win.yml`, `electron-builder.yml` (the `win`/`nsis` block only), `package.json` (Windows scripts only), `scripts/tauri-packaging-config.test.ts`, `scripts/check-module.sh` (Windows lines only), `scripts/release-feeds.ts` (Windows lines only), `e2e/**`, `e2e-tauri/**`, `AGENTS.md`, `plans/261002-1441-tauri-shell-migration/phase-12-macos-windows-cutover-electron-removal.md`, `plans/261002-1441-tauri-shell-migration/plan.md`.
- Must not touch: `src/renderer/**` (Phase 8 owns it), `README.md`, `site/**`, `CHANGELOG.md`.

## Tasks

### Task 7.0 — Worktree
- Steps: `git -C /home/tung491/WORK/oh-my-pi-gui worktree add -b rebrand/p07-main-rust-removals /home/tung491/WORK/worktrees/rebrand-p07 rebrand/everyday-work && cd /home/tung491/WORK/worktrees/rebrand-p07 && bun install && ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64 && ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp && bun run build:pack`
- Verify: `git -C /home/tung491/WORK/worktrees/rebrand-p07 branch --show-current` prints `rebrand/p07-main-rust-removals`.

### Task 7.1 — Tests before (red): tray and menu inventories
- Target files: `src/main/tray-labels.test.ts`, the Rust `#[cfg(test)]` modules of `src-tauri/src/desktop/menu.rs` and `tray_labels.rs`, and a menu test in TS (extend the existing test that covers `menu.ts`; if none exists, create `src/main/menu.test.ts` and add its row to `src-tauri/contracts/desktop.parity.json`).
- Cases (same names on both sides): `tray offers no developer actions` (no `open-usage`, `open-project`, `handoff`); `tray offers no approval choice` (no item sends `set-approval`; the read-only label is present); `app menu offers no developer actions` (none of the Delete ids in Context) `and keeps the everyday actions` (exactly the Keep ids in Context, `open-agent-hub` included).
- Verify (red): `bunx vitest run src/main` and `cargo test` (env prefix from `plan.md`) both exit non-zero in the new cases only; the parity loop exits 0.

### Task 7.2 — Refactor: tray and menu
- Steps: delete the items and their label keys in TS (`tray.ts`, `menu.ts`, `tray-labels.ts`, `i18n.ts`) and Rust (`menu.rs`, `tray.rs`, `tray_labels.rs`, `i18n.rs`), keeping TS and Rust label sets identical. Do not edit `src/renderer/**` or the `MenuAction` union.
- Verify: `bunx vitest run src/main` exits 0; `cargo test` exits 0; the parity loop exits 0; `bun run check:types` exits 0.
- Commit: `refactor(shell): drop developer and approval actions from the tray and app menu`.

### Task 7.3 — Refactor: benchmark and stats pairs
- Steps:
  1. Delete `src/main/benchmark-runner.ts`, `benchmark-runner.test.ts`, `stats-server.ts`, `stats-server.test.ts`, `stats-restart-policy.ts`, `stats-restart-policy.test.ts`, `stats-client.ts`, and `src-tauri/src/omp/bench.rs`, `stats.rs`, `stats_restart_policy.rs`, in one commit with their three rows in `src-tauri/contracts/omp.parity.json`.
  2. Remove `BENCH_RUN`, `BENCH_ABORT`, `STATS_FETCH` and the `IpcBenchmark*` / stats types from `ipc-types.ts`; the `stats` and `bench` entries from `create-omp-api.ts`; the handlers in `ipc.ts`, `index.ts`, `omp/ipc.rs`, `omp/mod.rs`; the stats/benchmark stop in `ports.rs:502` and its implementers.
  3. Regenerate the public-API snapshots: `bash -c 'source scripts/rust-pins.env && cd src-tauri && PATH="$CARGO_HOME_BIN:$PATH" cargo "+$PUBLIC_API_TOOLCHAIN" public-api -ss' > /tmp/rebrand-api.txt`, then for each `src-tauri/contracts/<snap>.api.txt` write `grep "sai_atlas_lib::<snap>::" /tmp/rebrand-api.txt` into it. `git diff src-tauri/contracts/*.api.txt` must show **only removed** lines, each naming `bench`, `stats` or `Benchmark`. Any added or other changed line: STOP.
- Verify: `bun run check:types` → 0; `bunx vitest run` → 0; `cargo clippy … -D warnings` → 0; `cargo test` → 0; the parity loop → 0; `bash scripts/check-module.sh snapshots` → 0; `rg -l "benchmark-runner|stats-server|stats-client|BENCH_RUN|STATS_FETCH" src src-tauri/src` prints nothing.
- Commit: `refactor(shell): remove the benchmark runner and the stats server`.

### Task 7.4 — Refactor: Windows builds
- Steps:
  1. Tests before: in `scripts/tauri-packaging-config.test.ts` and `src/main/packaging-config.test.ts`, remove or rewrite every Windows site listed in Context (a site that reads a Windows file is deleted; a site that checks a cross-platform rule keeps the rule for macOS and Linux only), and add `no windows build config remains`: assert `electron-builder.win.yml`, `src-tauri/tauri.windows.conf.json` and `src-tauri/windows/` do not exist, `electron-builder.yml` has no `win` or `nsis` key, and `package.json` has no script whose name contains `win`. Run: red.
  2. Delete the files and scripts listed in Context; remove the Windows lines of `scripts/check-module.sh` and `scripts/release-feeds.ts`. In `AGENTS.md`, delete the sentence that pins `nsis.guid` and its `packaging-config.test.ts` guard; keep the `appId` rule.
  3. In the Tauri plan (`plans/261002-1441-tauri-shell-migration/phase-12-…md` and its `plan.md` Phase 12 row), add at the top: `Windows is out of scope since 2026-10-05 (everyday-work rebrand, R13): skip every Windows step. The macOS Tauri bundle must ship resources/assistant-pack beside the omp sidecar the way the Linux bundle does (see the rebrand plan's spawn contract) before macOS switches to Tauri.`
- Verify: `bunx vitest run scripts/tauri-packaging-config.test.ts src/main/packaging-config.test.ts` exits 0; `ls electron-builder.win.yml src-tauri/tauri.windows.conf.json src-tauri/windows 2>&1 | grep -c 'No such file'` prints `3`; `rg -n -i 'windows|win32|nsis|\.exe' scripts/check-module.sh scripts/release-feeds.ts` prints nothing; `bash scripts/check-module.sh snapshots` exits 0.
- Commit: `build: drop the Windows builds`.

### Task 7.5 — Bring e2e back to green
- Steps:
  1. Find specs that reference removed UI or behaviour: `rg -n "Session stats|Benchmark|PR Center|Debug console|Live voice|Collab|Share session|Import|Worktree|Diff|Extensions|Inventory|MCP|SSH|Security|Model roles|Compare models|Usage|Modes|New chat|bash\.patterns|set-approval|approvalMode" e2e e2e-tauri`. The `bash.patterns` cases (`e2e/real-core.e2e.ts:196-212`, `e2e-tauri/real-core.e2e.ts:257`) no longer hold: sessions load no bash tool, and the pack's `--config` overlay outranks the global value they write; delete them (the pinned keys are covered by the Phase 1 containment checks and `scripts/check-assistant-pack.ts`).
  2. Delete the cases that only test removed surfaces (`e2e/desktop.e2e.ts` benchmark case near :435, the stats-route case in `e2e/real-core.e2e.ts` and `e2e-tauri/real-core.e2e.ts:58,166`). Keep each spec and its twin in step: `bun e2e-tauri/check-twins.ts` must still exit 0.
  3. `e2e-tauri/packaged-smoke.e2e.ts:365-385`: replace the stats-server child with a second task's sidecar — open a second task with the "New task" button and wait until `below("--mode rpc-ui").length >= 2`; drop `statsServers` and the `"omp stats --host"` pgrep pattern.
  4. Run both suites on the virtual display with a throwaway home: `H=$(mktemp -d); scripts/virtual-display.sh run -- env HOME=$H bunx playwright test` and `scripts/virtual-display.sh run -- env CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup" CARGO_HOME_BIN="$HOME/.cargo/bin" HOME=$H bun run test:e2e:tauri` (the cargo variables keep `wdio.conf.ts` finding `tauri-driver` through `CARGO_HOME_BIN`, which `scripts/rust-pins.env` derives from `$HOME`); then `scripts/virtual-display.sh stop`.
- Verify: `bun e2e-tauri/check-twins.ts` exits 0; both suites show no failure that the same suite does not also show at the base tag `rebrand-wave-b-fixed` (failures from earlier phases' removals belong to Phase 9 Task 9.0, which brings both suites to exit 0; the packaged smoke runs in Phase 9 against the `.deb`). Outcome 2026-10-06: met; per-case table in `plans/reports/fullstack-developer-261006-phase-07-main-rust-removals.md`.
- Commit: `test(e2e): follow the removal of developer surfaces`.

### Task 7.5b — A startup refusal reaches the window (test first)
- Context: in the Tauri shell a sidecar `error` status emitted before the webview subscribes is lost, so the tab shows "Connecting" forever, and the missing-binary and missing-pack refusals are never written to `gui-runtime.jsonl` (`src-tauri/src/runtime_log.rs`). Found during Phase 6 Task 6.7 (`plans/reports/fullstack-developer-261006-phase-06-spawn-wiring.md`); it would hide a real missing-pack failure the same way. Check the Electron shell for the same gap and fix it there too if present.
- Tests before (red): (a) a Rust test that a sidecar whose start is refused (missing binary, and a partial `assistant-pack/`) leaves its last status as `error` with the refusal message, and that a subscriber attaching afterwards receives that status (replay of the latest status per tab, or a status query the renderer calls on subscribe — choose the one matching the existing event plumbing); the replayed status carries the whole payload, including the `refusal` field `rebrand/wave-b-fixes` added (`SidecarRefusal` in `ports.rs`), so a chat tab active at launch shows the "start a new task" refusal instead of the generic failure; (b) a Rust test that both refusals append one entry to the runtime log; (c) the TS twins under the parity contract if Electron has the gap. Then implement.
- Verify: the new tests red first, then `cargo test --manifest-path src-tauri/Cargo.toml --all-features`, `bunx vitest run src/main` and the parity loop exit 0; in a dev run on the virtual display with `resources/omp` removed from the worktree, `scripts/virtual-display.sh shot` shows the refusal message instead of "Connecting", and `grep -c . <profile>/logs/gui-runtime.jsonl` is at least 1; restore the link afterwards.
- Commit: `fix(tauri): show a sidecar start refusal that happens before the window listens`.
- Also in this task, in `AGENTS.md` "Sidecar & Packaging Rules": the sentence naming the patches in `patches/omp/` lists `0002-no-context-files-flag.patch` next to `0001-ollama-native-api-num-ctx.patch`, saying the pack spawn flag `--no-context-files` relies on it. Verify: `grep -c "0002-no-context-files-flag.patch" AGENTS.md` prints 1 or more. Commit with the docs change as `docs: name the context-files patch the assistant pack relies on`.

### Task 7.6 — Gate and merge
- Verify: all commands in Task 7.3's Verify exit 0; `bunx biome check` on touched TS files exits 0.
- Merge: `git -C /home/tung491/WORK/worktrees/rebrand-integration merge --no-ff rebrand/p07-main-rust-removals` (on a conflict with Phase 8, STOP). After both Wave C phases merge, the full gate from `plan.md` "Shared commands" on the integration branch must exit 0; then `git -C /home/tung491/WORK/worktrees/rebrand-integration tag rebrand-wave-c`.

## Risks and rollback

- `ports.rs` is the frozen contract surface of the Tauri port; only the stats/benchmark stop goes, plus whatever Task 7.5b needs to replay the existing status payload. Any other port change is out of scope: STOP. The baseline is the snapshot at `rebrand-wave-b-fixed`, which added `SidecarRefusal` and the optional `refusal` status field.
- Rollback: `git reset --hard rebrand-wave-b` on the integration branch (undoes Phases 7 and 8 together; they are one wave and Phase 9 builds on both).

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
