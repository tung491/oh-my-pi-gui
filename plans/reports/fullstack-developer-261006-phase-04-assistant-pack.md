# Phase 4 report: assistant pack

Date: 2026-10-06 (Asia/Seoul). Plan: `plans/261005-0812-everyday-work-rebrand/`, phase file `phase-04-assistant-pack.md`.
Worktree `/home/tung491/WORK/worktrees/rebrand-p04`, branch `rebrand/p04-assistant-pack` from `rebrand/everyday-work`; diffs and commit ranges are against `rebrand-base` (`7677ba1`).
Status: **all tasks done and gated on the branch; not merged, not tagged, not pushed** (the orchestrator merges Wave A and runs the Wave gate).

## Outcome

The pack builds into `resources/assistant-pack/` with exactly the eight files of Phase 6's list (`package.json`, `tools.js`, `system-prompt.md`, `config.yml`, four `SKILL.md`). The compiled sidecar loads it: `scripts/check-assistant-pack.ts` sees the eleven tools, the four skills, the pack's system prompt, no pack agent, and every `config.yml` setting reading back from the `overlay` layer, with no unknown keys. This matches the spike baseline in `loadcheck.v2b.json`. The office tools run through `tools.js` inside the sidecar's own runtime. LibreOffice opens every file they make.

## Tasks, with red and green evidence

Every task's tests were written first and run red before any implementation existed.

| Task | Red run | Green run |
|---|---|---|
| 4.0 Worktree and dependencies | n/a | `test -x resources/omp.linux-x64` 0; five devDependencies print versions; `yaml` is a runtime dependency (see deviation 1); `bun run check:types` 0 |
| 4.1 Output helpers | `output.test.ts`: exit 1, module missing | 21 passed |
| 4.2 Word report | `markdown.test.ts`, `report.test.ts`: exit 1, modules missing | 24 passed |
| 4.3 Spreadsheet clean-up | `clean.test.ts`: exit 1, module missing | 16 of 17 passed first. The `fullCalcOnLoad` probe was wrong (deviation 3); after fixing it, 17 passed |
| 4.4 Slides | `slides.test.ts`: exit 1, module missing | 10 passed. A later rule ("refuse a deck with no slide section") failed 2 cases red, then passed (12) |
| 4.5 Office tools | `office-tools.test.ts`: exit 1, module missing | 24 of 25 passed first. The one failure led to the slide-section rule in 4.4; then 25 passed |
| 4.6 OS tools and extension module | `os-commands.test.ts`, `tools.test.ts`: exit 1, modules missing | 33 passed |
| 4.7 Skills, prompt, config | `pack-files.test.ts`: exit 1, files missing | 14 passed |
| 4.8 Build script | `build-assistant-pack.test.ts`: exit 1, module missing | 6 passed. `bun run build:pack` 0; `ls tools.js config.yml` 0; no `bin/` or `agents/` |
| 4.9 Compiled path, load check, CI | `compiled.test.ts`: 4 failed | 4 passed (not skipped). `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` exits 0. `grep -c SKIP_COMPILED ci.yml` prints 2. `CI_VISUAL=1` `visual.test.ts`: 5 passed locally |
| 4.10 SAI OS command check | n/a | Recorded as `NEEDS-INTEGRATION` (table below). `os-commands.test.ts` exits 0 |
| 4.11 Gate | n/a | See "Gate outputs". Merge and tag are left to the orchestrator |

The negative load-check case fails for the right reason. With `--tools read,glob,write,ask,find`, the sidecar exits 2 with `Built-in tool unavailable in this session: find.`, and the check exits 1 and names `find`.

## Commits (`rebrand-base..rebrand/p04-assistant-pack`)

| Hash | Message |
|---|---|
| `adebfe4` | build(pack): add the office libraries and the assistant-pack source root |
| `4eab338` | feat(pack): add the office output helpers |
| `b391998` | build(pack): lint the assistant-pack sources with the root rules |
| `17abf3b` | feat(pack): build Word reports from Markdown |
| `0dac07b` | feat(pack): clean up spreadsheets into a tidy copy |
| `0556ac6` | feat(pack): build slide decks from Markdown |
| `545162b` | feat(pack): add the office_report, office_slides and office_clean tools |
| `fa96fc7` | feat(pack): add the SAI OS tools and the pack extension module |
| `1857ed4` | feat(pack): add the skills, system prompt and pinned settings |
| `6b55a79` | feat(pack): build the assistant pack into resources/assistant-pack |
| `2515d01` | feat(pack): check that the compiled sidecar loads the pack |
| `0768179` | ci: test the assistant pack and open its files in LibreOffice |

## Gate outputs (worktree, sidecar linked, pack built)

- `bun run check:types`: exit 0.
- `bunx vitest run`: exit 0. 223 files passed and 1 skipped; 2146 tests passed and 5 skipped. The skipped file is `visual.test.ts`, which runs only with `CI_VISUAL=1`.
- `bunx biome check assistant-pack scripts/build-assistant-pack.ts scripts/build-assistant-pack.test.ts`: exit 0, 24 files checked.
- Wave gate rows that concern this branch, run in advance:
  - `bun run build`: exit 0.
  - `git diff --name-only rebrand-base -- '*.ts' '*.tsx' | xargs bunx biome check`: exit 0. It checked all 25 changed files, pack files included.
  - The pack load check: exit 0.
  - `test ! -e resources/assistant-pack/bin && test ! -e resources/assistant-pack/agents`: exit 0.
- CI simulation: `SKIP_COMPILED=1` skips the 4 compiled cases. `bun install --frozen-lockfile` reports no changes.

## Deviations, each with its evidence

1. **Task 4.0 Verify: `.devDependencies.yaml` prints `null`.**
   - Cause: `yaml` is already a runtime dependency (`package.json:86`, `^2.9.1`), imported by `src/main/provider-cleanup.ts` and `src/main/models-config.ts`. `bun add -d yaml@2.9.1` rewrote that entry instead of adding a devDependency.
   - Fix, under the Failure Protocol and on kongming's counsel: the runtime entry is restored unchanged and no devDependency is added; `jq -r '.dependencies.yaml'` prints `^2.9.1`.
2. **Biome did not lint the pack.**
   - Root `biome.json` `files.includes` omits `assistant-pack/**`. As written, the Task 4.11 command would exit 1 ("No files were processed"), and the Wave gate would skip the pack silently.
   - `biome.json` is not owned by this phase, so on kongming's counsel I added `assistant-pack/biome.json` (`root: false`, `extends: "//"`). It sits inside this phase's ownership and applies the root rules to the pack.
   - The orchestrator may later fold `assistant-pack/**/*.ts` into the root `files.includes` in a serial phase.
3. **Task 4.3 rule 7.** The test asserts `fullCalcOnLoad="1"` in the written `xl/workbook.xml`, not through ExcelJS readback, because ExcelJS's reader always resets `calcProperties` to `{}` (`exceljs/lib/xlsx/xform/book/workbook-xform.js:142`). The assertion is just as strong; it probes the written workbook part directly.
4. **Task 4.4 pptxgenjs facts the phase asked to re-check:**
   - **Layout:** `LAYOUT_16x9` is 9144000x5143500. The required `cx="12192000" cy="6858000"` is `LAYOUT_WIDE`, which is also 16:9, so the builder uses `LAYOUT_WIDE`.
   - **Chart file name:** chart part numbers come from a module-level counter (`pptxgen.es.js:1572`), so only a process's first chart is `chart1.xml`. The test therefore requires exactly one `ppt/charts/chartN.xml` per deck.
   - **Speaker notes:** pptxgenjs writes a notes part for every slide, so the test requires exactly one notes slide to carry the notes text.
5. **Additions inside `assistant-pack/**`:**
   - **`src/tools/types.ts`:** shared tool types, which three modules use.
   - **Detached `open_item`:** it launches through an injected detached `launch`, because `cinnamon-settings` blocks until its window closes.
   - **`office_slides` with no slide section:** a deck without any `#`/`##` section after the title is refused with the existing "no slides yet" sentence.
   - **CSV input:** values are read as text, because ExcelJS's default mapper drops leading zeros. A `;` delimiter is detected.
   - **Report style:** paragraph spacing in the report styles.
6. **Build script test seams.** `--entry <module>` makes a bundle fail so the test can prove the previous pack survives. The stray-`.js` check is an exported `strayScripts()` that the test calls directly, instead of a test-only flag.
7. **`diagnose` areas.** The design doc's "diagnose areas" table is not available locally. The checks were written from standard Debian and Cinnamon read-only tools and are listed for the SAI OS check below.

## Task 4.10: NEEDS-INTEGRATION

| Task | Status | Detail |
|---|---|---|
| 4.10 SAI OS command check | NEEDS-INTEGRATION | Per the brief, the user was not blocked on. The proposed `os_setting` argv and `cinnamon-settings` panels ship with tests. The spike report's new "SAI OS commands" section records the list as "awaiting user confirmation" and adds the `diagnose` checks, app ids and helpdesk menu paths to confirm on the same machine. The confirmed list must land before Phase 9 |

## Cleanup

- No sidecar process is left: every load-check run stops its sidecar and removes its scratch folder.
- Nothing was written to `~/Documents/Sai ATLAS`: the tests use temporary homes.
- The LibreOffice instance and the `/tmp/sai-atlas-spike-*` folders on the machine come from the Phase 1 human check and were left alone.

## Unresolved questions

- Should the orchestrator move pack linting into the root `biome.json` (one config) or keep the nested `assistant-pack/biome.json`?
- Who confirms the SAI OS commands, `diagnose` checks and menu paths, and when? This is due before Phase 9.

Status: DONE_WITH_CONCERNS
Summary: Phase 4 is implemented test-first on `rebrand/p04-assistant-pack` (12 commits). Every task's Verify and the Task 4.11 gates pass, and the compiled sidecar loads the pack with every setting from the overlay.
Concerns/Blockers: Task 4.10 waits on the user (NEEDS-INTEGRATION); `yaml` stays a runtime dependency (Verify deviation, on counsel); pack linting relies on a nested Biome config because root `biome.json` is outside this phase's ownership.
