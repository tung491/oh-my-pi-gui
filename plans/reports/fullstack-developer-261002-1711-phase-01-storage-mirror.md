# Phase 1 (Tasks 1.1-1.6): storage mirror and feed repoint

Status: blocked on one test file outside ownership. Tasks 1.1-1.5 are done and verified. Task 1.6 is done apart from one stale assertion in a file this phase does not own. Nothing is committed.

## Files changed
- Created `src/shared/renderer-storage.ts`, `src/renderer/lib/persisted-storage.ts`, `src/renderer/lib/persisted-storage.test.ts`
- Write sites now call `writePersisted`: `src/renderer/lib/i18n.tsx`, `src/renderer/lib/themes.ts`, `src/renderer/stores/updater.ts`, `src/renderer/components/chat/dock/WorkspaceDock.tsx`, `src/renderer/components/dialogs/CommandPalette.tsx`. Their try/catch blocks and read sites are unchanged.
- `src/renderer/main.tsx` calls `mirrorAllToPrefs()` once, before the root renders.
- Feed: `src/main/updater.ts` (`RELEASE_DOWNLOAD_BASE`), `publish.owner: tung491` in all four `electron-builder*.yml`, `src/main/packaging-config.test.ts` publish assertion.
- `AGENTS.md`: the Repository Identity bullet and the table row for this repo now name `tung491/oh-my-pi-gui` as the publishing repo, with `nornzach/oh-my-pi-gui` as the upstream it tracks.
- `CHANGELOG.md`: the spec line, under Unreleased, in the Added list.

## Line-number drift
None. Every line number in the phase Context table and Files list matched the current source. `localStorage.setItem` had exactly the five listed write sites.

## Verify results
| Verify | Result |
|---|---|
| 1.3: grep for `localStorage.setItem` | Pass. Prints only `src/renderer/lib/persisted-storage.ts`. |
| 1.4: `bunx vitest run src/renderer/lib/persisted-storage.test.ts` | Pass. `4 passed`. |
| 1.5: `grep -rn "nornzach/oh-my-pi-gui/releases" src/main/updater.ts` | Pass. Prints nothing. |
| 1.5: `grep -c "owner: tung491" electron-builder*.yml` | Pass. Prints `1` for each of the four files. |
| 1.5: `bunx vitest run src/main/packaging-config.test.ts` | Pass. 25 passed. |
| 1.6: `bun run check:types` | Pass. Exit 0. |
| 1.6: the listed `bunx biome check …` | Pass. Exit 0, 9 files checked. |
| 1.6: `bun run build` | Pass. Exit 0. |
| 1.6: `bunx vitest run` | **Fail.** Exit 1: 19 files failed, 200 passed; 1 test failed, 1877 passed. |

## The vitest failure (kongming consulted, as the Failure Protocol requires)
- **A, environment (18 files):** the failing files are all tool scripts under the untracked `.claude/` and `.agentkit/` directories ("No test suite found", "process.exit unexpectedly called"). These directories were present before this phase started. The repo has no vitest config that excludes them, and a clean CI checkout would not contain them. Running `bunx vitest run --exclude '.claude/**' --exclude '.agentkit/**'` gives 1 file failed, 200 passed; 1 test failed, 1877 passed. The one remaining failure is B.
- **B, caused by this change (1 test):** `src/renderer/components/common/LangSwitcher.test.tsx:138`, in the test "hydrates a main-process preference without overwriting it from the inferred renderer language", asserts `expect(writes).toEqual([])`. The test now receives `[{ key: "rendererStorage.omp.lang", value: "vi" }]`. This is the intended mirror: the startup path that loads the language pref also writes `omp.lang` to localStorage, and that write now mirrors. The test's real intent is that the `language` pref is not overwritten, and that still holds.
- **Fix kongming recommends (not applied, because the file is outside ownership):** change line 138 to `expect(writes.filter(write => write.key === "language")).toEqual([]);`. Do not change `i18n.tsx`; skipping the mirror at startup would leave exactly the gap this phase closes. Kongming also recommends landing this change in the `feat(gui): mirror window-only settings into the profile` commit. The phase Files list should also gain this test file.

## Follow-ups outside this phase
- Add a `vitest.config.ts` whose `test.exclude` adds `.claude/**` and `.agentkit/**` to vitest's default excludes, so `bunx vitest run` is green locally when those tool directories are present.
- `AGENTS.md` line 8 still says `origin` = `nornzach/oh-my-pi-gui`, but the real `origin` is `git@github.com:tung491/oh-my-pi-gui.git`. The table's Push column also still describes the old layout. I left both alone because my edit was limited to the release-publishing lines.
