# Phase 7 Implementation Report: main-process and Rust removals, Windows

## Executed Phase
- Phase: phase-07-main-and-rust-removals
- Plan: /home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand
- Worktree / branch: /home/tung491/WORK/worktrees/rebrand-p07, `rebrand/p07-main-rust-removals`, based on `rebrand-wave-b-fixed` (4492062)
- Status: DONE_WITH_CONCERNS. Nothing was merged, tagged or pushed.

Commits on the branch, oldest first:

| Commit | Task | Message |
|---|---|---|
| 079bdd3 | 7.1, 7.2 | refactor(shell): drop developer and approval actions from the tray and app menu |
| 560564d | 7.3 | refactor(shell): remove the benchmark runner and the stats server |
| 1ec6d16 | 7.4 | build: drop the Windows builds |
| a9080f1 | 7.5b | fix(tauri): show a sidecar start refusal that happens before the window listens |
| b84cbcf | 7.5b docs | docs: name the context-files patch the assistant pack relies on |
| 45ee6dd | 7.5 | test(e2e): follow the removal of developer surfaces |
| 9682a87 | 7.5b | fix(shell): file sidecar start refusals under a listed runtime log source |

## Tasks

### 7.0 Setup
- I created the worktree and ran `bun install`.
- `resources/omp` and `resources/omp.linux-x64` are symlinks to the main checkout's `omp.linux-x64`.
- I ran `build:pack` and `build:renderer:tauri`.

### 7.1 / 7.2 Tray and app menu (079bdd3)
- Electron:
  - The menu is now a pure template, `src/main/menu-template.ts` (`appMenuTemplate`). `menu.ts` only binds Electron to it.
  - The tray's template moved into `tray-labels.ts` (`trayMenuTemplate`). It drops Usage, Add workspace, Open project, Handoff and the approval radio.
  - 18 developer menu keys are removed from `src/main/i18n.ts`.
- Rust: `desktop/menu.rs`, `tray.rs`, `tray_labels.rs` and `i18n.rs` are trimmed the same way.
- Tests:
  - New TS tests:
    - "tray offers no developer actions" and "tray offers no approval choice".
    - "app menu offers no developer actions and keeps the everyday actions" (new `src/main/menu.test.ts`).
  - One test was renamed to "maps each approval mode to the label the header shows".
  - The same tests exist in Rust, plus a new parity row for `menu.test.ts` in `desktop.parity.json`.
- Red then green: the new tests failed against the old menus and pass now. The tray and menu gates are green (see 7.6).

### 7.3 Benchmark runner and stats server (560564d)
- TS: deleted the benchmark-runner, stats-server, stats-restart-policy and stats-client files, plus their IPC channels, types, API entries and `index.ts` wiring.
- Rust: deleted `omp/bench.rs`, `stats.rs`, `stats_restart_policy.rs` and `omp/ipc.rs`.
  - The `omp` module now has no channels.
  - `OmpPort::shutdown`, which existed only to stop stats and bench, is removed from `ports.rs` (allowed by the spec), along with its step in the frozen shutdown order in `lib.rs`.
- Snapshots: `omp.api.txt` and `ports.api.txt` lose 10 lines and gain none.
- Verify: every command passed (see 7.6). The rg check prints nothing.
- Failure Protocol, used once:
  - 4 removed snapshot lines did not literally name bench or stats: the `omp::ipc` module, `Omp::shutdown` (x2) and `OmpPort::shutdown`.
  - kongming hit a 429 rate limit, so a `planner` on opus stood in.
  - Its counsel: proceed. Those lines are the spec'd stats/bench stop, and the plan owner should reword that Verify.

### 7.4 Windows (1ec6d16)
- Deleted:
  - `electron-builder.win.yml`
  - `src-tauri/tauri.windows.conf.json`
  - `src-tauri/windows/`
  - the win and nsis blocks in `electron-builder.yml`
  - the Windows `package.json` scripts
  - the Windows lines in `check-module.sh` and `release-feeds.ts`
- Rewrote the Windows sites in `tauri-packaging-config.test.ts`. New test: "no windows build config remains".
- `packaging-config.test.ts`: the Windows describe and the NSIS GUID test are removed. AGENTS.md is updated to match ("Windows is not a target").
- The Windows-out-of-scope note was added to the Tauri plan's phase 12 file and the plan.md row, as the phase spec says.

### 7.5 e2e (45ee6dd)
- Changes:
  - The stats mode is removed from `e2e/sidecar-fixture.ts`: 73 lines deleted, the rest is de-indentation.
  - The `OMP_GUI_TEST_STATS_BINARY` env lines are removed from four specs.
  - The benchmark case is deleted in both shells.
  - In real-core, the Session stats and `bash.patterns` steps are deleted in both shells, and the case is renamed "real bundled sidecar persists settings and sessions".
  - packaged-smoke now opens a second task with "New task" and waits for two `--mode rpc-ui` sidecars. `statsServers` and the stats pgrep are gone.
- Static checks: check-twins exits 0, tsc 0, biome clean.
- **Verify not met as written.** Both suites exit 1, because of failures that already exist at the base tag.
  - I ran both suites at `rebrand-wave-b-fixed` in a throwaway worktree.
  - Both suites used a throwaway HOME and display :99.
  - Both shells' e2e binaries were rebuilt with `cargo tauri build --debug --features e2e-hooks --no-bundle`.
- Electron (`bunx playwright test`): the branch has 11 failed / 23 passed.
  - The base fails the same 10 cases at the same assertions.
  - The base also fails the benchmark case (deleted here) and real-core at the "Session stats" button (removed here). The branch's real-core now gets further and fails at the settings page check.
- Tauri (`bun run test:e2e:tauri`): the branch has 5 of 9 spec files passed.
  - Base, specs run one at a time: every case that fails on the branch fails there with the same first assertion, plus the benchmark case.
  - The base's full-suite run also timed out creating sessions for 6 spec files. Onboarding, performance and runtime pass on the branch.
- Failure Protocol: I asked kongming (it answered). Its counsel was option A, conditional on per-case Tauri parity, which then held. So: commit the Phase 7 scoped spec changes, leave the earlier-phase failures to Phase 9 Task 9.0 step 3, and do not rewrite specs against a renderer Phase 8 is changing.

Failure manifest (the same assertion at the base tag for every row):

| Case (both shells unless noted) | First failing assertion | Cause | Phase 9 Task 9.0 action |
|---|---|---|---|
| opening sharing … | no "Upload and create link" button | sharing removed | drop a step that drives a removed control |
| settings expose eight groups … | settings-nav-group-label count is not 8 | settings groups removed | rewrite an expectation that counts removed surfaces |
| security distinguishes … scans | "Permissions & security" button | security page removed | drop or rewrite |
| voice and side question … | modal not visible (Electron); click intercepted (Tauri) | voice/side question removed | drop |
| real bundled sidecar persists settings and sessions | dialog lacks "Quyền hạn & Bảo mật" | settings page removed | rewrite the expectation |
| quick entry sends a new chat / sends from the Send button | tab kind is "chat" (Electron); 60 s timeout (Tauri) | chat target | follows 9.0 step 2a |
| quick entry agent target opens the Work workspace | no "Agent" button | target picker changed | follows 9.0 step 2a |
| quick entry leaves shell commands unsent | textarea value is not "!echo hi" | earlier-phase quick-entry change | investigate in 9.0 |
| deep GUI audit | about 27 nested settings controls | removed settings rows | rewrite |
| auto-follow (Electron only) | gap at line 64 | same failure at the base tag | investigate in 9.0 |
| Tauri desktop: Escape cancels…, math…, themes…, logo tone…, uncertain delivery…, repeated lifecycles…, narrow windows…, settings search… | "element click intercepted" | follows from the settings dialog that the eight-groups case leaves open | should clear once the settings cases are fixed |

### 7.5b A start refusal reaches the window (a9080f1, 9682a87, b84cbcf)
- Changes:
  - `SidecarHandle::status_payload()` was added to `ports.rs`. It is the only change to the port beyond the spec'd stats/bench stop, and the snapshot gains exactly that one line.
  - Both managers keep the whole last status (message, restart progress, refusal).
  - `sidecar:status-get` returns that whole status, with the window's cwd, in both shells.
  - Refusals for a missing binary or a partial pack call a refusal reporter, which writes one `gui-runtime.jsonl` entry. The source is `child-process`: the log files any unlisted source as `unknown`.
  - Electron had the same gap and got the same fix.
- Tests:
  - Rust: `keeps_the_whole_refused_start_status_for_a_window_that_subscribes_late`, `writes_each_refused_start_to_the_runtime_log_once` and `the_status_query_replays_the_whole_last_status_to_a_late_subscriber`.
  - TS twins in `sidecar.test.ts`.
- Red, then green:
  - Red: Rust 759 passed and 3 failed, exactly the new ones. TS had 2 failed (the new ones) and 14 passed.
  - Green: Rust 762/762, vitest `src/main` 399/399, the parity loop exits 0.
  - The new chat fixtures first lacked the title line that real session files carry, and the chat-stamp check reads its header from the second line. I fixed the fixture, not the check.
- AGENTS.md now names `0002-no-context-files-flag.patch` and says the `--no-context-files` spawn flag relies on it. `grep -c` prints 1.
- Dev-run Verify, with `resources/omp` removed and a throwaway profile:
  - `grep -c . <profile>/logs/gui-runtime.jsonl` prints 3, including `{"source":"child-process","message":"Built-in omp not found. …"}`. **Met.**
  - The screenshot still shows "Connecting". **Not met, and the cause is in the renderer.**
- I traced the main side with temporary eprintln logging (since removed):
  - `sidecar:status` was pushed while the window was fully wired.
  - Both `sidecar:status-get` calls returned `{status: Error, message: "Built-in omp not found…", cwd}`.
  - The tab marker turns red (from `tab:status`), but the session store stays at `starting`.
- The renderer change Phase 8 needs to make (it owns `src/renderer/**`):
  - The cause is in `src/renderer/hooks/use-rpc-events.ts` (around lines 642–666). The hook takes its boot snapshot when it mounts, before `useTabsStore.hydrate` (`stores/tabs.ts:262–333`) has set `activeTabId`. So `snapshotTabId` is `""` and `snapshotRuntime` is `null`.
  - When `getStatus()` resolves, one of two things happens:
    - `focusedTabId() !== snapshotTabId` is true, so the snapshot is discarded.
    - Or `handleStatus(status, "")` writes into the fallback session store. `ensureTabRuntime` then replaces that store with a fresh runtime whose status is `starting`.
  - The early push is lost the same way: its tab runtime does not exist yet.
  - Fix: when the snapshot is taken with no focused tab (or its tab has no runtime yet), do not discard it. Re-read `window.omp.sidecar.getStatus()` once the focused session runtime first appears. One way is to subscribe with `onFocusedSessionRuntimeChange`, from `stores/session-runtime-context.tsx`. Then apply it with `handleStatus(status, focusedTabId())`, unless a newer push for that tab has already arrived (the `statusVersion` guard).
  - Add a linkedom test: the tabs list resolves after `getStatus`, `getStatus` returns `{status: "error", message}`, and the session store must end at `error` with `sidecarError` set.

### 7.6 Gate (all commands exit 0)
- `bun run check:types`: 0
- `bunx vitest run`: 0 (199 files passed, 1 skipped; 1926 tests passed, 5 skipped)
- clippy `--all-targets --all-features -D warnings`: 0
- `cargo test --all-features`: 0 (762 passed)
- parity loop: 0
- `bash scripts/check-module.sh snapshots`: 0
- the rg check for `benchmark-runner|stats-server|stats-client|BENCH_RUN|STATS_FETCH`: prints nothing
- `bunx biome check` on the 26 TS files touched since the base: 0

## Deviations outside the ownership list
- `src-tauri/tests/channels.rs`: `EXPECTED_CHANNEL_COUNT` changed from 94 to 90 for the removed stats and bench channels. The opus stand-in approved it.
- `scripts/release-feeds.test.ts`: Windows expectations removed, to follow `release-feeds.ts`.
- Tauri plan files (`plans/261002-1441-tauri-shell-migration/phase-12-…md`, `plan.md`): the Windows note was added there because the phase spec lists them. That conflicts with the orchestrator's "never edit plan files". Revert it if that instruction wins.

## Cleanup
- Every process I started is stopped: the e2e runs, the three dev launches, and one orphaned dbus-daemon from my second launch.
- Display :99 is stopped. Its status listed only my Xvfb.
- The baseline worktree `/home/tung491/WORK/worktrees/p07-baseline` is removed, and the throwaway HOMEs and profiles are deleted.
- `resources/omp` is restored in the worktree.

## Unresolved questions
1. Task 7.5's Verify ("both suites exit 0") cannot be met from `rebrand-wave-b-fixed`. Kongming suggests rewording it to a phase-scoped condition: every Phase 7 removal case is gone, check-twins is 0, and the branch's failures are a per-assertion subset of the base tag's. It also suggests widening Phase 9 Task 9.0 step 3 to allow "rewrite an expectation that counts or names removed surfaces"; otherwise a literal 9.0 run hits "Any other failure: STOP". Does the plan owner accept both edits?
2. The 7.5b screenshot criterion needs the renderer change above. Does Phase 8 take it, or does it go to a follow-up after the Wave C merge?
3. The existing sidecar crash reports use the unlisted `sidecar-restart` source and are filed as `unknown` in both shells. This predates this phase and I left it alone. Should it be fixed later by switching to `child-process` or by adding sidecar sources to `RuntimeErrorSource`?
4. Windows leftovers outside ownership: the triple and `.exe` in `scripts/stage-tauri-sidecar.ts` and `scripts/build-bundled-omp.ts`, the "loopback stats server" comment in the `electron-builder.yml` mac block, and the Windows mentions in README and `plan/04-tech-stack.md`.

Status: DONE_WITH_CONCERNS
Summary: Tasks 7.1–7.5b are committed on rebrand/p07-main-rust-removals and every Task 7.6 gate exits 0. The e2e suites still fail only on failures already present at the base tag (the same assertions, per case), and the 7.5b on-screen refusal needs a renderer change that Phase 8 owns.
Concerns/Blockers: Task 7.5's e2e Verify cannot be met as written (plan edits proposed). The 7.5b screenshot criterion needs the renderer change specified in this report. There are three ownership deviations, listed above.
