## Phase Implementation Report

### Executed Phase
- Phase: phase-03-macos-smoke-harness
- Plan: plans/261008-0341-tauri-macos-cutover
- Status: completed

The harness ran on the Phase 2 bundle without a rebuild. All nine cases passed on two runs in a row, including `hard kill leaves nothing`, which passes before Phase 4. Commit 5cb1b21 (`test(macos): add a packaged smoke check for the macOS app`) holds only the two script files. Nothing was pushed.

### Files Modified
- `scripts/tauri-mac-smoke.ts` (new, about 410 lines): the helpers, the nine cases and `main`.
- `scripts/tauri-mac-smoke.test.ts` (new, about 100 lines): 10 unit tests.
- `reports/macos-host-log.md`: a new `## Phase 3` section at the end.
- `reports/macos-parity.md`: nine `macOS <case>: PASS` lines. The coordinator commits these report files.

### Tasks Completed
- [x] 3.1 Red: `bunx vitest run scripts/tauri-mac-smoke.test.ts` exited 1 because the module did not exist yet.
- [x] 3.2 Green: 10 tests pass, and `bunx biome check` on both files exits 0. A strict ad-hoc `tsc` also passes, because `scripts/` is in no tsconfig.
- [x] 3.3 The harness prints nine PASS lines and `tauri-mac-smoke: PASS` with exit 0. The Verify grep counts 0, and `pgrep` afterwards prints `none`.
- [x] 3.4 Committed. The full `bunx vitest run` exits 0: 2388 tests passed and 9 were skipped.

### Tests Status
- Type check: an ad-hoc `tsc` passes (`check:types` does not cover `scripts/`).
- Unit tests: 10 of 10 pass for the new file, and the full suite is green.
- Packaged run: 9 of 9 cases pass on both runs, in about 29 s per run.

### Issues Encountered
- Deviations, also in the host log:
  - Besides the four helpers the phase asked for, three more are pure, exported and tested: `sameKeys`, `codesignDetails` and `infoPlistProblems`.
  - `ps` runs with `-ww` so long command lines are not cut off.
  - The harness refuses an app path under `/Applications`.
- The hard-kill PASS comes from the supervisor noticing that its control channel closed when the GUI died. It does not cover a tool process that has left omp's process group; Phase 4 has to cover that case.
- No cargo build ran during either run. The `rustc|cargo` matches were unrelated `npm exec` processes whose PATH contains "cargo".
- No Failure Protocol was triggered. Before the Verify step, biome reported a formatting difference in one line, which `biome format` fixed.

### Next Steps
- Phase 6 can reuse `bun scripts/tauri-mac-smoke.ts "<abs app>"` on the integrated bundle once Phases 4 and 5 are merged.

Status: DONE
Summary: The macOS packaged smoke harness and its unit tests are committed as 5cb1b21. All nine cases pass on the Phase 2 bundle, and the hard-kill case passes before Phase 4.
Concerns/Blockers: The hard-kill PASS does not cover a tool process that has escaped omp's process group; that remains Phase 4's job.
