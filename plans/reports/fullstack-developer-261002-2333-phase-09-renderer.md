## Phase Implementation Report

### Executed Phase
- Phase: phase-09-renderer-webkit-compat (module `renderer`)
- Plan: /home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration
- Worktree: /home/tung491/WORK/worktrees/tauri-renderer, branch `tauri/renderer`, base `10cf8a5`
- Status: completed

### Files Modified
- `/home/tung491/WORK/worktrees/tauri-renderer/src/renderer/lib/context-menu-guard.ts` (new, 20 lines)
- `/home/tung491/WORK/worktrees/tauri-renderer/src/renderer/lib/context-menu-guard.test.ts` (new, 57 lines)
- `/home/tung491/WORK/worktrees/tauri-renderer/src/renderer/App.tsx` (+4 lines: import plus one `useEffect`)
- `/home/tung491/WORK/worktrees/tauri-renderer/src/renderer/quick-entry/QuickEntryBar.tsx` (+3 lines: import plus one `useEffect`)
- `/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/reports/renderer-engine-audit.md` (new; outside the worktree, per the phase's exact required path; `plans/` is excluded from the module gate's owned-path diff and from git tracking in this worktree)

No frozen file (`src/renderer/boot/**`, `main.tsx`, `quick-entry/main.tsx`, `global.d.ts`, `index.html`, `quick-entry.html`, `vite.*.ts`, `src/shared/**`, `src/preload/**`) was touched.

### Tasks Completed

**Task 9.2 (WebAudio voice capture) — already done, verified not redone.**
Confirmed merged into `main` as `fa1b9c6` and inherited at the worktree's base `10cf8a5`. `grep -c MediaRecorder src/renderer/lib/voice.ts` → `0`; `src/renderer/public/pcm-capture-worklet.js` exists.
- Verify: `bunx vitest run src/renderer/lib/voice-capture.test.ts` → **4 passed**, matching the phase's pass condition. No code changed for this task in this worktree.

**Task 9.1: Suppress the non-editable default context menu — commit `5ddf1d8`.**
- Added `installContextMenuGuard(doc: Document): () => void` in `context-menu-guard.ts`: a `contextmenu` listener that calls `preventDefault()` unless the target is inside `input`, `textarea`, `[contenteditable]`, or `[data-native-context-menu]`; returns a remover.
- Installed from one `useEffect` in `App.tsx` and one in `QuickEntryBar.tsx`.
- Tests (linkedom harness, one shared `document`/`afterEach` reset, matching the project's established harness pattern): "prevents the menu on plain content", "allows the menu in a textarea", "allows the menu in contenteditable", "remover detaches the listener".
- Verify: `bunx vitest run src/renderer/lib/context-menu-guard.test.ts` exits 0, **4 passed** — matches the phase's stated pass condition exactly.

**Task 9.3: Engine API audit — report at `plans/261002-1441-tauri-shell-migration/reports/renderer-engine-audit.md`.**
- Ran the phase's exact grep. One hit: `src/renderer/components/panels/DiffPanel.tsx:91`, a string comparison classifying a tool-reported path as virtual vs. real (`!file.startsWith("file://")`); it builds or navigates to no URL. Documented as safe, same shape as the already-accepted `FilesPanel.tsx:157` hit. No code fix needed; no other pattern hits anywhere in non-test renderer source.
- Blob downloads / Export logs: `LogPanel.tsx` is unchanged per the plan's frozen decision (foundation handles it; no renderer channel). The on-screen native-save-dialog check is parked as **NEEDS-HUMAN** (see below), per this run's explicit instruction to park manual/on-screen checks rather than build/run a Tauri window in this pass.
- Verify: `test -f .../renderer-engine-audit.md` exits 0 — **passes**. `grep -c "^Export logs: PASS$" .../renderer-engine-audit.md` prints `0`, not `1` as the phase file literally states — **deviation, see below.**

**Task 9.4: Module gate and commit.**
- `PATH="$HOME/.cargo/bin:$PATH" bash scripts/check-module.sh renderer` → ran gates 1 (owned-path diff), 2 (`bunx vitest run`), 3 (`bun run check:types`), 4 (`bunx biome check` on changed files), 5 (`bun run build`), 6 (`bun run build:renderer:tauri`), 7 (`node scripts/lint-surfaces.mjs`) — last line **`check-module renderer: PASS`**.
- No separate Task 9.4 commit was made: Task 9.3 changed no owned code file (only the external audit report), so after the Task 9.1 commit the worktree had nothing left to commit. The phase's suggested message (`fix(gui): keep the renderer engine-neutral across webviews`) describes work already covered by the 9.1 commit; an empty commit was not created.
- `bun scripts/check-test-parity.ts renderer` → fails with `ENOENT` on `src-tauri/contracts/renderer.parity.json`. Confirmed this is expected, not a regression: `plan.md` → Acceptance criteria scopes test parity to "foundation and the six Rust modules" only, and `scripts/check-test-parity.ts` reads `src-tauri/contracts/<module>.parity.json`, which exists only for Rust modules. Renderer is TypeScript/CSS and has no Rust parity contract, so this phase defines no parity check for it — the acceptance criterion's "if the phase defines parity for this module" condition does not apply here.

### Tests Status
- Type check: pass (`bun run check:types`, 0 errors)
- Unit tests: pass — `bunx vitest run` → **206 test files, 1908 tests passed**, including the new `context-menu-guard.test.ts` (4/4) and the pre-existing `voice-capture.test.ts` (4/4)
- Biome: clean on all touched files
- Build: `bun run build` (Electron) and `bun run build:renderer:tauri` both exit 0
- Integration: `bunx playwright test e2e/quick-entry.e2e.ts` → 8/8 passed on two runs. One run in between showed a single flaky timeout on "Escape hides quick entry" (10s poll on `barVisible`) when run after the rest of the suite; it passed in isolation and passed again in a full clean re-run immediately after, so it is pre-existing test timing flakiness, not caused by this phase's change (the guard only calls `preventDefault()` on `contextmenu`, never touches the bar's visibility or Escape handling).

### Deviations
1. **Export logs on-screen check parked, not run.** The phase's literal Verify for Task 9.3 requires `grep -c "^Export logs: PASS$"` to print `1`. This run's instructions explicitly direct parking "Task 9.3's Export-logs native save-dialog check and any visual WebKit check," recording each as NEEDS-HUMAN with exact steps, and not waiting on the user — the controller batches these with Phase 5's human session. I followed that explicit instruction rather than the phase's literal Verify, since: (a) it is a known, pre-decided exception stated directly in this task's assignment, not an unexpected failure calling for the Failure Protocol; (b) this worktree has no pre-warmed `src-tauri/target/debug` (renderer owns TS/CSS only), so satisfying the check would require a from-scratch `cargo`/`cargo tauri` build, which the wave rules direct executors to avoid unless a Verify strictly requires it; and (c) the check needs a live on-screen native save dialog, which cannot be faked without violating "implement real behavior, no fake data." The audit report records `Export logs: NEEDS-HUMAN` with the exact steps (including the `.part`-count before/after procedure from the phase text) instead of `PASS`.
2. **No separate Task 9.4 commit.** See above — nothing remained to commit after Task 9.1's commit, since Task 9.3 added no code change inside the worktree.

### Processes Started and Stopped
- `bunx vitest run` (several invocations) — foreground, exited on completion, no residue.
- `bunx playwright test e2e/quick-entry.e2e.ts` (three invocations, foreground) — Playwright's own Electron-harness lifecycle; all processes exited with the test run. Confirmed via `ps aux` after: no `electron`, `playwright`, or test-runner process left running.
- `bash scripts/check-module.sh renderer` (foreground; runs `bun run build`, `bun run build:renderer:tauri`, `node scripts/lint-surfaces.mjs`) — exited on completion, no residue.
- No `omp`, `--omp-supervise`, or fixture/port-518x process was started or found running at any point (`ps aux` checked before finishing).

### Baseline Mtimes
- `~/.config/@oh-my-pi/omp-gui/prefs.json`: `1790910017` at start and at end — unchanged.
- `~/.config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl`: `1790951349` at start and at end — unchanged.
- No `dpkg -i`/`apt install` of any Sai ATLAS package was run; `~/.local/share/applications/vn.io.vif.saiatlas.desktop` does not exist (not created).

### NEEDS-HUMAN
**Export logs native save-dialog check (Task 9.3 step 3), batched with Phase 5's human session:**
1. In the `tauri-renderer` worktree, confirm `test -x resources/omp` (already confirmed present).
2. Record the `.part` baseline: `ls -a "$(xdg-user-dir DOWNLOAD)" | grep -c '\.part$'` (on this machine `xdg-user-dir DOWNLOAD` → `/home/tung491/Downloads`; baseline not separately re-measured here since no Tauri window was run).
3. `bun run dev:tauri -- --user-data-dir=$(mktemp -d)`.
4. Open the Logs panel, click "Export logs".
5. Expect: a native save dialog opens with suggested name `omp-logs-<timestamp>.log`.
6. Save into a scratch directory; expect the file to exist (content may be empty — this worktree's log tail is the `services` stub).
7. Re-check the `.part` count: expect unchanged from the step-2 baseline.
8. Repeat the export and press Cancel; expect the `.part` count still unchanged and no `omp-logs-*.log` left in Downloads.
9. A leftover `.part` file in either case is a FAIL and, per the phase, a foundation defect — do not edit `LogPanel.tsx`; follow the Failure Protocol instead.
10. Stop the `dev:tauri` process afterward.

Phase 10 Task 10.4 repeats this with real log lines once all modules are merged.

### Next Steps
- Phase 10's merge/integration can proceed for `renderer` once the controller confirms the gate and the audit report.
- The Export-logs NEEDS-HUMAN check should run in the same session as Phase 5's human checks (S5/S8 and others already queued there).

Status: DONE_WITH_CONCERNS
Summary: Tasks 9.1–9.4 are complete and `check-module.sh renderer` prints `check-module renderer: PASS`; the one open item is the Export-logs native save-dialog check, which is intentionally parked as NEEDS-HUMAN per this run's explicit instruction rather than run against a from-scratch Tauri build.
Concerns/Blockers: The phase's literal Task 9.3 Verify (`grep -c "^Export logs: PASS$"` = `1`) is not met as written — the audit report instead records `Export logs: NEEDS-HUMAN` with full repro steps, consistent with the explicit instruction to park manual/on-screen checks and batch them with Phase 5's human session.
