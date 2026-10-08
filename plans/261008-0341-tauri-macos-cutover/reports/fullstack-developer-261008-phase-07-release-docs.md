## Phase Implementation Report

### Executed Phase
- Phase: phase-07-release-tooling-docs (Tasks 7.1, 7.2, 7.3, 7.4, 7.5, 7.5b, 7.6; Task 7.2b skipped, done in the main worktree)
- Plan: plans/261008-0341-tauri-macos-cutover
- Worktree: /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos-docs, branch `tung491/tauri_macos-docs` from `0ca87fd`
- Status: completed, with one recorded deviation (the 7.5b Verify grep)

### Files Modified
- `scripts/release-feeds.ts`: arm64-only `assetNames`, `ReleaseInputs` and `buildRelease`. `mergeElectronFeed` and the mutual-exclusion check are gone, `parseArgs` is exported and knows only `version`, `out`, `linux` and `mac-arm64`, and the header comment is rewritten.
- `scripts/release-feeds.test.ts`: arm64-only fixtures and expectations. The Electron-merge test is deleted, and `rejects an Intel macOS bundle` is added. The Linux assertions are unchanged.
- `scripts/mac-update-floor.ts` and its test: `MAC_UPDATE_FLOOR = "22.4.0"`, with a doc comment that cites macOS 13.3 and `tauri.macos.conf.json`. The test gains `rejects macOS 13.0 now that the app needs 13.3`.
- `scripts/tauri-packaging-config.test.ts`: only the asset-name test changed. It now has no x64 keys.
- `AGENTS.md`: the five statements the phase named.
- `README.md`, `README.vi.md`: the Install, Build from source and Release steps 5–7 sections, plus the Troubleshooting row "Intel sidecar exits immediately", which I removed because it contradicts arm64-only.
- `CHANGELOG.md`: added the "**macOS runs on Tauri**" entry in its place under Unreleased → Changed.
- `site/index.html`: removed the Intel buttons, changed the meta text and the JS loop to `["arm64"]`, added "Apple silicon, macOS 13.3 or later", and changed the first-launch note to Open Anyway. Not pushed.
- `reports/macos-host-log.md`: appended a `## Phase 7` section.

### Commits
- `bd1f563 build(release): arm64-only macOS feed from the Tauri bundle`
- `docs: describe the Tauri macOS app` (docs, host log and this report)

### Tasks Completed
- [x] 7.1 Red: exit 1 on the changed expectations
- [x] 7.2 Green: exit 0. The only `x64`/`electron` lines left in release-feeds.ts describe the feed format, none of them a macOS build
- [x] 7.3 Red: exit 1 on the new test. Green: the three-file run exits 0
- [x] 7.4 AGENTS greps: 0 / 3 / 1
- [x] 7.5 README grep 0; README.vi `arm64` count 5; CHANGELOG count 1
- [x] 7.5b passes with the narrowed Verify; see Issues
- [x] 7.6 Gate 5 (`bunx vitest run`) exit 0 with 226 files passed; gate 6 (`check:types`) exit 0; gate 7 (biome on the five touched scripts) exit 0
- [x] `package.json` has no `build:omp:x64` or `package:tauri:mac:x64` (confirmed). `release-feeds.ts` has no `--mac-x64`

### Issues Encountered
1. **7.5b Verify was over-broad.** `grep -c 'x64'` printed 4, and every hit was a Linux x64 label that the arm64-only decision leaves alone. Following the Failure Protocol, kongming advised keeping those labels, since they match README and AGENTS, and narrowing the check to Intel-only references: `grep -c 'data-omp-dmg="x64"\|macOS x64\|arm64 / x64\|"x64"\|[Ii]ntel' site/index.html`. That prints 4 on HEAD and 0 after the edit. The phase file is outside this lane's ownership, so the narrowed Verify is recorded only in the host log.
2. **Gate 5 failed first on a missing sidecar.** The fresh worktree had no `resources/omp`, so `compiled.test.ts` failed. Following kongming's advice I copied the main worktree's sidecar (omp/18.4.8) and ran `build:pack`, and the suite then went green. I did not use `SKIP_COMPILED`.
3. **AGENTS.md wording.** For the release flow I listed the on-screen checks themselves instead of pointing at "this plan's Phase 6", because AGENTS.md is evergreen.
4. **Biome reformatted the assertion I added** to the packaging test. The diff stays within the asset-name test.

### Next Steps
- Merge this lane after Phases 2, 4 and 5, as the plan orders.
- Stale text outside this lane's ownership:
  - `scripts/build-bundled-omp.ts`: a usage comment still names `build:omp:x64`.
  - `scripts/check-mac-update-floor.ts`: the header still says "macOS 12".
  - `site/index.html` `installerUrl`: still has a non-arm64 branch that nothing calls now. The task said not to touch it.
- `tauri-mac-smoke.ts` is named in the docs but is still being built in Phase 3.

### Unresolved questions
- CHANGELOG: if 0.9.17 is cut from `main` before this branch merges, its notes must keep "macOS is unchanged and still runs on Electron", and the macOS Tauri entry belongs to the next version's section. This branch replaced that line under Unreleased.
- Should the phase file's 7.5b Verify be updated to the narrowed grep by its owner?

Status: DONE_WITH_CONCERNS
Summary: Phase 7 (minus 7.2b) is implemented and committed. The feed tooling is arm64-only with floor 22.4.0, and the docs and site describe the Tauri macOS app. Gates 5–7 are green.
Concerns/Blockers: The 7.5b Verify was narrowed on kongming's advice (Linux x64 labels kept). The CHANGELOG Unreleased section needs care if 0.9.17 is cut before merge.
