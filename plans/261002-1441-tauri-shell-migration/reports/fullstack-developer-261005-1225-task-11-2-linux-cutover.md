# Task 11.2 — Linux cutover (branch `tauri/linux-cutover`)

Linux now builds only from Tauri, while macOS and Windows still build from Electron. Every Verify gate passes. Nothing has been pushed or merged, and no tags were created.

## Commits (on top of merge 01cdfc0)

- `789e129` build(linux): package Linux with the Tauri container build only
  - Deleted `electron-builder.linux.yml`, `scripts/deb-smoke.sh` and `scripts/deb-smoke/`.
  - `package:linux` is now `bash scripts/tauri-linux-build.sh`. The script already defaults its target dir to `src-tauri/target-linux-2404` (overridable by `$SAI_ATLAS_LINUX_TARGET` or the first argument), so the script itself is unchanged.
  - `src/main/packaging-config.test.ts`:
    - Removed the `Linux package config` block, the `package:linux` expectation, the Linux entries in the artifact-name loop (it now covers `win.target` only) and the unused Linux config types.
    - Lowered the config-count floor from 4 to 3.
    - Kept the `desktopName` = `${APP_ID}.desktop` guard, moved into the product-identity block, because Electron still uses it on Linux in dev and in the Playwright suite.
    - Added one guard: `package:linux` is the container build and no `electron-builder*.yml` has a `linux` key.
  - Comment-only reference fixes in `electron-builder.yml` and `src/main/bundled-omp-path.ts`.
  - Kept every macOS and Windows script and config, `build:omp:linux` (the Tauri build stages that sidecar), `e2e/` with `e2e/packaged-smoke.e2e.ts`, `test:e2e` (Electron) and `test:e2e:tauri`.
  - CI: no change needed. The `linux` job runs only check:types, vitest and build (no Electron Linux packaging), and `tauri-linux` is unchanged.
- `805c40e` test(e2e): settle the composer to idle after aborting the running task
  - Fixes a race in a test-file outside the nominal scope. Details under Deviation.

## Verify (worktree `/home/tung491/WORK/worktrees/linux-cutover`)

| Gate | Result |
|---|---|
| `bunx vitest run` | 212 files, 1990 tests passed |
| `bun run check:types` | exit 0 |
| `bun run build` | exit 0 (main bundle self-contained, entries lean) |
| `bun run build:renderer:tauri` | exit 0 |
| `cargo test --all-features` | exit 0 (765 + 3 + 2 + 3 passed) |
| `cargo clippy --all-targets --all-features -D warnings` | exit 0 |
| parity loop | all 7 contracts pass, exit 0 |
| `check-module.sh snapshots` | PASS (desktop ollama omp ports services tabs updater) |
| `virtual-display.sh run -- bun run test:e2e:tauri` | `Spec Files: 9 passed, 9 total`, exit 0, on two consecutive runs after the fix |
| `bunx biome check` on touched TS files | clean |
| `bun e2e-tauri/check-twins.ts` | 9 spec files, 44 tests, every twin matches |

The e2e binary was built first with `cargo tauri build --debug --features e2e-hooks --no-bundle`. The display was stopped afterwards and none of the processes I started are still running. `resources/omp*` were copied from the integration worktree; they are gitignored and were not committed.

## Deviation: the e2e fix

The first two full `test:e2e:tauri` runs both failed on one test, `desktop › long approval remains complete and Enter is neutral` (WebDriver "Stale element" at `desktop.e2e.ts:50`, `$(SEND)` inside `command()`).

I escalated to kongming under the Failure Protocol. Its diagnosis:
- The previous test ended right after clicking Abort, before the `agent_end` re-render.
- `InputArea.tsx` renders Send at two tree positions, so the Send node is replaced when the run ends.
- WebdriverIO's find step has no stale-element retry. The Playwright twin is immune because its locators re-resolve.

The fix is one wait, `await expect($(ABORT)).not.toBeExisting()`, at the end of `a running task keeps both send and stop reachable`. It is the same idiom `runtime.e2e.ts` and `auto-follow.e2e.ts` already use. No retry settings or renderer changes were added.

## Not done here

- `plan/04-tech-stack.md:131` still shows an old `package:linux` example. It is a historical planning doc under `plan/`, so I left it to the docs task.
- README, AGENTS.md and CHANGELOG still mention `deb-smoke.sh` and `electron-builder.linux.yml`; Task 11.3 owns those.
- Still needed before the merge into `main`: push the branch (needs approval) so the `tauri-linux` job runs on GitHub for the first time.

Status: DONE_WITH_CONCERNS
Summary: The Linux Electron packaging path is retired, `package:linux` runs the ubuntu:24.04 Tauri container build, and all Verify gates pass, including two consecutive green full Tauri e2e runs.
Concerns/Blockers: Getting the e2e gate green needed a one-line fix in `e2e-tauri/desktop.e2e.ts`, which is outside the listed file scope; it is a separate commit made on kongming's advice. The `tauri-linux` CI job has still never run on GitHub.
