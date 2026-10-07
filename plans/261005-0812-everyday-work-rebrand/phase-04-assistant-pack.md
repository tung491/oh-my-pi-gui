---
phase: 4
title: "Assistant pack"
status: done
priority: P1
effort: "5d"
dependencies: [1]
---

# Phase 4: Assistant pack

## Goal

Build the GUI-owned assistant pack: three office skills backed by three typed office tools (`office_report`, `office_slides`, `office_clean`) that build files in-process, four Linux OS tools, the helpdesk skill, the system prompt and a config overlay that pins every approval-relevant key. A build script writes the loadable pack to `resources/assistant-pack/`. The pack ships no executable, no shell launcher and no agent file.

## Outcome (2026-10-06)

Done and merged (`da001bb`, commits `adebfe4`..`0768179`); the Wave A gate passed and the integration branch was tagged `rebrand-wave-a`. Report: `plans/reports/fullstack-developer-261006-phase-04-assistant-pack.md`. Review: `plans/reports/code-reviewer-261006-wave-a.md`. Deviations from the tasks below, as shipped:

- `yaml` stays a runtime dependency (`package.json` `.dependencies.yaml` is `^2.9.1`, used by `src/main/provider-cleanup.ts` and `src/main/models-config.ts`), so Task 4.0's Verify prints `null` for `.devDependencies.yaml` by design (on kongming's counsel). No follow-up.
- The pack is linted through a nested `assistant-pack/biome.json` (`root: false`, `extends: "//"`) instead of a root `biome.json` `files.includes` edit, which this phase did not own. No follow-up required; folding it into the root config is optional cleanup.
- Task 4.3 rule 7 asserts `fullCalcOnLoad="1"` in the written `xl/workbook.xml`, because ExcelJS's reader resets `calcProperties` on readback.
- Task 4.4: the deck uses `LAYOUT_WIDE` (16:9, `cx="12192000" cy="6858000"`; `LAYOUT_16x9` is smaller); the test requires exactly one `ppt/charts/chartN.xml` (pptxgenjs numbers charts per process) and exactly one notes slide carrying the notes text (pptxgenjs writes a notes part for every slide).
- Additions inside `assistant-pack/**`: shared tool types in `src/tools/types.ts`; `open_item` launches detached (`cinnamon-settings` blocks until its window closes); `office_slides` refuses a deck with no slide section; CSV input is read as text with `;` detection.
- Task 4.10 is `NEEDS-INTEGRATION`: the `os_setting` argv, `cinnamon-settings` panels, `diagnose` checks and helpdesk menu paths await the user's check on SAI OS. `plan.md` carries it as an open question, and Phase 9 Task 9.0 Verify gates on it.
- Repairs from the review land on `rebrand/wave-a-fixes` (`plan.md` "Wave A review fixes"): `open_item` app launches with `gio launch <absolute system path>` instead of `gtk-launch <id>` (M1); input, cell and Markdown size caps plus an abort check in the office tools (M2); the `plan`, `skills.customDirectories`/`includeSkills` and `commands.*` keys in `config.yml` (H2, M3; the Task 4.7 block below already shows them); no partial file on a failed write, linear `truncateToBytes`, a realpath check on the output folder, an approval sentence built only from validated values (L1–L4); a dated helpdesk support note (L8); the load check drops `PI_CONFIG_FILES`, `PI_CONFIG_DIR` and `PI_CODING_AGENT_DIR` from the sidecar env (L9). L5 (LibreOffice possibly outliving its timeout) is unverified and deferred.

## Context

- Plan index `./plan.md` (Decisions "Office route", "Helpers", "Pinned settings and approval rules", "`tools.approval` shape", "Spike gate result").
- Spike report `plans/reports/spike-261005-everyday-work-rebrand.md` (read it first: load-check fixes, containment rows, the two Phase 4 hardening items, the v2b failure modes).
- Starting point (our own spike code, not Anthropic's; branch `rebrand/p01-spike` is never merged, so read it by absolute path and port it test-first): `/home/tung491/WORK/worktrees/rebrand-p01/spike/src/office-core.ts` (builders, `writeUnique`, `documentsDir`, `resolveTitle`), `spike/src/tools-v2b.ts` (office tool schemas and argument checks), `spike/src/tools.ts` (OS tool schemas), `spike/pack-v2b/{config.yml,system-prompt.md,skills/**}`. The spike code lacks the hardening in Tasks 4.1 and 4.5; do not copy it unchanged.
- Office quality rules: `plans/reports/research-261005-1338-how-claude-creates-office-files.md` §4.1–4.4. **Licensing:** copy no script, schema or skill text from Anthropic's skills; write everything from library docs and our own tests (§5).
- omp extension API (`/home/tung491/WORK/oh-my-pi/packages/coding-agent/src/extensibility/extensions/types.ts:667-711`): `pi.registerTool({ name, label, description, parameters, approval, loadMode, execute(toolCallId, params, signal, onUpdate, ctx) })`; `approval` is `"read" | "write" | "exec"` or a function `(args) => ({ tier, reason })` whose `reason` becomes the approval text. Extension tools default to deferred loading; `loadMode: "essential"` keeps one top-level (`types.ts:681`), and every pack tool sets it. Parameters are plain JSON Schema objects, so the bundle imports nothing from `@oh-my-pi` at runtime (as in the spike).
- Tool result shape: `{ content: [{ type: "text", text }], isError? }`. An office tool's success text is one JSON object with exactly `file`, `kind`, `check`; Phase 8's output card parses it.
- omp 18.4.8 facts from the spike: `find` is a semantic search and fails startup when listed in `--tools`, so the file finder is `glob` (`tools/glob.ts:87-89`); an invalid setting value is replaced by its default with only a log-file warning (`config/registry.ts:651-662`), so readbacks check value plus provenance; skills reach the model only through `read` of `skill://<name>` (`system-prompt.ts:919-938`); helpers run headless (`task/executor.ts:4071`), which is why the pack has none.
- Spawn contract and env (`SAI_ATLAS_LANG`, `en` or `vi`, which the office and OS tools read): `./phase-06-spawn-wiring.md` "Spawn contract". Phase 6 copies this phase's output file list into `ASSISTANT_PACK_FILES`; keep the two identical.
- Approval resolution: a `tools.approval` entry from any config layer wins before the mode (`coding-agent/src/tools/approval.ts:286-305`). An overlay wins only for keys it sets, so `config.yml` must set every key below (spike containment row 5: a user config with `write: allow` or `office_report: allow` still produced one approval prompt).
- Wave A: parallel with Phases 2 and 3.

## Ownership

- May create: `assistant-pack/**`, `scripts/build-assistant-pack.ts`, `scripts/build-assistant-pack.test.ts`, `scripts/check-assistant-pack.ts` (Phase 6 Task 6.6 later rewires it to the shells' flag builder).
- May modify: `package.json` (devDependencies, scripts), `bun.lock`, `.gitignore`, `tsconfig.json` (`include` only), `.github/workflows/ci.yml` (one new job).
- Must not touch: `src/**`, `src-tauri/**`, `e2e*/**`, `scripts/sync-upstream.sh`.

## Pack layout

Source (committed):

```text
assistant-pack/
  src/office/output.ts       # Documents/Sai ATLAS (with the ~/Documents fallback), unique names, path containment, the JSON result
  src/office/markdown.ts     # marked lexer and the title rule (title, else the first # heading, else a fallback)
  src/office/report.ts       # Markdown string -> .docx
  src/office/clean.ts        # .xlsx/.xls/.ods/.csv path -> cleaned workbook
  src/office/slides.ts       # Markdown string -> .pptx
  src/office/fonts.ts        # BODY_FONT = "Arial", TITLE_FONT = "Times New Roman"
  src/tools/office-tools.ts  # office_report, office_slides, office_clean: argument checks, build, save
  src/tools/os-commands.ts   # closed lists -> argv arrays (no shell strings)
  src/tools/index.ts         # extension module: registers the seven tools
  skills/word-report/SKILL.md
  skills/spreadsheet-cleanup/SKILL.md
  skills/slides-from-report/SKILL.md
  skills/sai-os-helpdesk/SKILL.md
  system-prompt.md
  config.yml
  test/                      # vitest tests and fixtures
```

Build output (gitignored), the directory passed to `--extension`:

```text
resources/assistant-pack/
  package.json   # {"name":"sai-atlas-assistant-pack","private":true,"omp":{"extensions":["./tools.js"]}}
  tools.js       # the only .js file
  skills/  system-prompt.md  config.yml
```

There is no `bin/`, no `office/` and no `agents/` directory: office jobs run inside the sidecar as extension tools, and helpers are not part of v1.

Write pack code against `node:` modules only (vitest runs tests under Node; the bundle runs under Bun).

## Tasks

### Task 4.0 — Worktree and dependencies
- Steps:
  1. `git -C /home/tung491/WORK/oh-my-pi-gui worktree add -b rebrand/p04-assistant-pack /home/tung491/WORK/worktrees/rebrand-p04 rebrand/everyday-work && cd /home/tung491/WORK/worktrees/rebrand-p04 && bun install`
  2. `bun add -d docx@9.8.1 exceljs@4.4.0 pptxgenjs@4.0.1 marked@18.0.14 yaml@2.9.1 jszip@3.10.2` (the first four are the versions the spike ran; `yaml` and `jszip` serve the tests only; if one is not on npm, STOP).
  3. Add `"assistant-pack/**/*.ts"` to `tsconfig.json` `include` (the pack code and its tests use `node:` modules only). Do not add `scripts/**`: the root config has `types: ["node"]`, and the build and check scripts use `Bun` globals; scripts are not type-checked by `check:types` today, and these follow the same rule. Add `resources/assistant-pack/` to `.gitignore` under the sidecar block.
  4. `ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64` (the sidecar is gitignored, so a new worktree has none).
  5. Nothing to send: the coordinator sent the user the `os_setting` argv table and the `cinnamon-settings` panel list from Task 4.6 on 2026-10-06, asking for a check on a SAI OS (LMDE 7) machine. Task 4.10 records the answer; it does not block the tasks before it.
- Verify: `test -x resources/omp.linux-x64` exits 0; `jq -r '.devDependencies.docx, .devDependencies.exceljs, .devDependencies.pptxgenjs, .devDependencies.marked, .devDependencies.yaml, .devDependencies.jszip' package.json` prints six versions; `bun run check:types` exits 0.

### Task 4.1 — Output helpers (test first)
- Goal: one module owns where files go, how they are named and what counts as inside a folder.
- Target files: `assistant-pack/src/office/output.ts`, `assistant-pack/test/output.test.ts`.
- Tests before (red):
  - `documentsDir({ platform: "linux", home: "/home/u", runXdgUserDir: () => "/home/u/Tài liệu" })` returns `/home/u/Tài liệu/Sai ATLAS`. When `runXdgUserDir` throws, prints an empty line, or prints the home directory itself (`/home/u` or `/home/u/`), it returns `/home/u/Documents/Sai ATLAS`. On `darwin` it returns `<home>/Documents/Sai ATLAS`.
  - `writeUnique(dir, "Q3 report", "docx", bytes)` writes `Q3 report.docx`, then `Q3 report (2).docx` when the first exists, then `(3)`; it opens with `fs.openSync(path, "wx")` and retries the next suffix on `EEXIST` (never check-then-write); two concurrent calls with the same name produce two files.
  - `safeBaseName("a/b:c*?")` strips path separators and the characters `\ / : * ? " < > |`; `safeBaseName("../../escape")` returns `....escape`; a name that strips to nothing returns a non-empty default.
  - `resultLine({ file, kind, check })` returns one line of JSON with exactly those three keys.
  - `isInsideDir(child, parent)` compares `realpathSync` results and tests the **first segment** of the relative path against `..` exactly: `<tmp>/..notes/x.md` (created) is inside `<tmp>`; `<tmp>/../x` is not; a symlink inside `<tmp>` that points outside it is not; `<tmp>` itself is not. A test greps `output.ts` and fails if it contains `startsWith("..")`.
  - `expandHome("~/x", "/home/u")` returns `/home/u/x`; a relative path resolves against the working directory.
- Implementation: `documentsDir` calls `execFileSync("xdg-user-dir", ["DOCUMENTS"])` on Linux; `mkdirSync(dir, { recursive: true })` happens in the tools (Task 4.5), not here.
- Verify: red run of `bunx vitest run assistant-pack/test/output.test.ts` exits non-zero before the code exists, then exits 0 after.

### Task 4.2 — Word report (test first)
- Target files: `assistant-pack/src/office/markdown.ts`, `assistant-pack/src/office/report.ts`, `assistant-pack/test/markdown.test.ts`, `assistant-pack/test/report.test.ts`, fixtures `assistant-pack/test/fixtures/notes-en.md`, `notes-vi.md` (Vietnamese text with accents, a table, nested lists, `---`, typed "•" bullets).
- `buildReport({ markdown, title?, fallbackTitle })` takes the Markdown as a string and returns `{ bytes, check, title }`.
- Tests before (red), each reopening the produced zip (JSZip, already a dependency of `docx`) and parsing `word/document.xml`:
  1. The heading count with `w:pStyle w:val="Heading1|2|3"` equals the Markdown `#`/`##`/`###` count from `marked.lexer` (minus the `#` that became the title).
  2. `w:tbl` count equals the Markdown table count (tables render as real Word tables, never as pipe text); each table's `w:gridCol` widths sum to the content width of A4 with the chosen margins (in DXA).
  3. List items carry `w:numPr` (real numbering); no `w:t` text starts with "•" or "- ".
  4. `w:pgSz` is A4 (`w:w="11906" w:h="16838"`).
  5. `---` becomes a paragraph bottom border (`w:pBdr/w:bottom`).
  6. Fonts: `word/styles.xml` names `Arial` and `Times New Roman`.
  7. The returned `check` string reads like `3 headings, 2 tables, 14 list items`.
  8. Title rule (`markdown.test.ts`, `resolveTitle(markdown, title, fallbackTitle)`): an explicit `title` wins and the body keeps its `#`; without one, the first `#` heading becomes the title and leaves the body; with no `#` heading, `fallbackTitle` is used.
- Implementation: `marked.lexer` → `docx` `Document` with built-in `HeadingLevel`, a `numbering` config for bullets and numbers, header-row shading with `ShadingType.CLEAR`.
- Verify: `bunx vitest run assistant-pack/test/markdown.test.ts assistant-pack/test/report.test.ts` is red first, then exits 0.

### Task 4.3 — Spreadsheet clean-up (test first)
- Target files: `assistant-pack/src/office/clean.ts`, `assistant-pack/test/clean.test.ts`, fixtures built in the test with ExcelJS (no binary fixtures).
- `cleanWorkbook(inPath, { sheet?, totals?, decimal?, lang, convert? })` takes the input path and returns `{ bytes, check }`; it never writes to `inPath`.
- Tests before (red), one `it` per rule:
  1. Whitespace trimmed; fully empty rows dropped; exact duplicate rows dropped.
  2. A column with any value that has a leading zero, more than 15 digits, or a header in `["SĐT","CCCD","CMND","MST","Mã","Số tài khoản","Phone","ID"]` (case-insensitive, accent-sensitive) stays text, and the result lists it as kept as text.
  3. `decimal: "comma"`: `"1.500"` becomes 1500 and `"1,5"` becomes 1.5; `decimal: "dot"`: `"1,500"` becomes 1500. When `decimal` is absent it follows `lang` (`vi` → comma, otherwise dot); the tool passes `SAI_ATLAS_LANG` as `lang`.
  4. `"15%"` becomes 0.15 with number format `0.0%`; a year-like column (all values 1900–2100 integers) has no thousands separator.
  5. Source formulas become their cached values; when any formula cell has no cached result, `cleanWorkbook` throws an error whose message is the plain sentence `This file has formulas without saved results. Open it in your spreadsheet app, save it, then try again.`
  6. Merged ranges are unmerged; the value stays in the top-left cell.
  7. With `totals: true`, the last row holds `SUM` formulas with a cached `result`, and the workbook sets full calculation on load (`workbook.calcProperties.fullCalcOnLoad = true`).
  8. A sheet named `Changes` (`Thay đổi` when `lang` is `vi`) lists every action with counts.
  9. The input file's bytes are unchanged after the run (the output name `<name> (cleaned).xlsx` is set by the tool, Task 4.5).
  10. `.csv` input is accepted.
  11. `.xls` and `.ods` input <!-- Updated: Validation Session 1 - legacy formats through LibreOffice -->: `convertLegacy(path, { run, tmpDir })` runs `soffice --headless -env:UserInstallation=file://<tmpDir>/lo-profile --convert-to xlsx --outdir <tmpDir> <path>` through an injected `execFile` (argv array, 60 s timeout; `libreoffice` is tried when `soffice` is not on `PATH`), and the converted file is cleaned; the output keeps the original base name and the input is untouched. When neither command exists or the conversion fails, `cleanWorkbook` throws the plain sentence `Save this file as .xlsx in your spreadsheet app, then try again.` Tests use a fake `execFile`; `visual.test.ts` (CI_VISUAL) adds one real `.ods` round trip.
- Verify: `bunx vitest run assistant-pack/test/clean.test.ts` red first, then exits 0.

### Task 4.4 — Slides (test first)
- Target files: `assistant-pack/src/office/slides.ts`, `assistant-pack/test/slides.test.ts`, fixture `assistant-pack/test/fixtures/report-shapes.md` that contains one of each shape below.
- `buildSlides({ markdown, title?, fallbackTitle })` takes the Markdown as a string and uses `resolveTitle` from Task 4.2.
- Layout rules, from research §4.3:

  | Markdown shape | Layout |
  |---|---|
  | deck title (`title`, else the first `#`, else the fallback) | dark title slide |
  | `#` | dark section divider |
  | `##` + 2–4 items that each start with **bold** text | card grid |
  | `##` + a line starting with a bold number (`**42%** …`) | big-number callout |
  | `##` + table with a label column and numeric columns | native bar chart |
  | `##` + other table | native table |
  | `##` + bullets | title + bullets; past the per-layout budget, split onto a "(cont.)" slide, never below 14 pt |
  | `> Notes: …` | speaker notes |

- Tests before (red): reopen the pptx with JSZip; slide count equals the expected count for the fixture; `ppt/charts/chart1.xml` exists; one `ppt/notesSlides/` entry exists; no run has `sz` below `1400`; `ppt/presentation.xml` slide size is 16:9 (`cx="12192000" cy="6858000"`); the `check` string names the split slides; without `title`, the first `#` heading becomes the title slide and no divider repeats it.
- Implementation notes (pptxgenjs facts to re-check in its docs and our tests): set `layout = "LAYOUT_16x9"` before adding slides; hex colours without `#`; a fresh options object per call; one `pptxgen` instance per file.
- Verify: `bunx vitest run assistant-pack/test/slides.test.ts` red first, then exits 0.

### Task 4.5 — Office tools (test first)
- Target files: `assistant-pack/src/tools/office-tools.ts`, `assistant-pack/test/office-tools.test.ts`.
- Contract (export `createOfficeTools(env)` returning the three definitions and `registerOfficeTools(pi, env?)`; `env` carries `home`, `platform`, `runXdgUserDir`, `lang` and `convert`, and defaults to the real process values):

  | Tool | Parameters (JSON Schema, `additionalProperties: false`) | Builds |
  |---|---|---|
  | `office_report` | `markdown` (string, required), `title?` (string), `name?` (string) | `.docx` through `buildReport` |
  | `office_slides` | `markdown` (string, required), `title?` (string), `name?` (string) | `.pptx` through `buildSlides` |
  | `office_clean` | `file` (string, required), `sheet?` (string), `totals?` (boolean), `decimal?` (`comma` or `dot`) | `<name> (cleaned).xlsx` through `cleanWorkbook` |

  - Each tool: `approval: "write"`, `loadMode: "essential"`, a plain `label`. The description says what it makes, the Markdown rules (one `#` title line, `##` sections, short paragraphs, `-` list items, `|` tables) and the output rule (saved in Documents > Sai ATLAS, never replaces a file). `office_report` and `office_slides` descriptions also say: `If the content is in a file, read the file first and pass its text, not its path.` Descriptions and parameter descriptions carry no example values (the spike showed models copy them).
  - `execute` checks the arguments at the boundary (types, the `decimal` enum, required keys) and returns a plain error for a bad one. It rejects a `markdown` value that is only a path: trimmed, a single line, and either starting with `/`, `~/`, `./` or `../` or ending in `.md`, `.txt`, `.docx` or `.pdf`; the error text is `Read the file first, then pass its text as markdown.` `name` goes through `safeBaseName`. `title` is optional: the title rule from Task 4.2, with `name` as the fallback, else `Report` or `Slides`. `office_clean` expands `~/` in `file`, uses the input's base name plus ` (cleaned)`, and passes `lang`. Every tool creates `documentsDir()` and saves through `writeUnique`.
  - Success returns one text content whose text is `resultLine(...)`. Any failure returns `isError: true` and a fixed plain sentence, one per error kind; never the input path, file content or a stack trace.
- Tests before (red), with a temp `home`, a fake `runXdgUserDir` that prints the temp home, and real fixtures:
  1. `office_report` with the text of `notes-en.md` and no `title` returns JSON with exactly `file`, `kind`, `check`; `kind` is `docx`; `file` is `<home>/Documents/Sai ATLAS/<first # heading>.docx`.
  2. `office_slides` with the text of `report-shapes.md` and a `title` writes a `.pptx` named after the title.
  3. `office_clean` on an ExcelJS-built `.xlsx` writes `<name> (cleaned).xlsx`; the input bytes are unchanged; with `lang: "vi"` and no `decimal`, `"1.500"` becomes 1500.
  4. `name: "../../escape"` writes `....escape.docx` inside `<home>/Documents/Sai ATLAS`, and a walk of `<home>` finds no other new file.
  5. `markdown` set to `/home/u/notes.md`, `~/notes.md` and `notes.md` each returns `isError` with the read-first sentence and writes no file.
  6. A second `office_report` call with the same `name` writes `<name> (2).docx`.
  7. `office_clean` on a missing file and on a text file renamed `.xlsx` returns `isError`; the message contains neither the `file` value nor `{`.
  8. `totals: "yes"`, `decimal: "x"` and a missing `markdown` each return `isError` with a plain sentence.
  9. Every definition has `loadMode === "essential"`, `approval === "write"` and `parameters.additionalProperties === false`; the `office_report` and `office_slides` descriptions contain `read the file first` (case-insensitive).
- Verify: `bunx vitest run assistant-pack/test/office-tools.test.ts` red first, then exits 0.

### Task 4.6 — OS tools and the extension module (test first)
- Target files: `assistant-pack/src/tools/os-commands.ts`, `assistant-pack/src/tools/index.ts`, `assistant-pack/test/os-commands.test.ts`, `assistant-pack/test/tools.test.ts`.
- Tool contracts (all argv arrays run with `execFile`; never a shell string):

  | Tool | Parameters | Tier | Behaviour |
  |---|---|---|---|
  | `system_status` | none | read | disk (`df -h --output=target,avail,pcent /home`), memory (`free -h`), battery (`upower -i` on the first battery from `upower -e`, if any), network (`nmcli -t -f STATE general`), printers (`lpstat -p -d`); a missing command is reported as "not available" |
  | `diagnose` | `area`: one of `network`, `sound`, `printer`, `storage`, `performance`, `bluetooth`, `display`, `typing`, `updates` | read | runs that area's fixed read-only checks (doc table "diagnose areas") and returns plain findings plus the fixes allowed for that area |
  | `open_item` | `kind`: `file`, `folder`, `app` or `settings`; `value`: string | exec | `file`/`folder`: resolve with `realpathSync`; refuse unless `isInsideDir` (Task 4.1) places it inside the home directory; a folder opens with `xdg-open`; a file opens only when its extension is in `OPENABLE = [docx, xlsx, pptx, odt, ods, odp, pdf, txt, md, csv, png, jpg, jpeg, webp]` and it is not executable, otherwise refuse with `I can only open documents and pictures.`; `app`: `gtk-launch <desktop id>` only when `<id>.desktop` exists under `/usr/share/applications` (never the user's own folder; `gtk-launch` resolves the id through `XDG_DATA_HOME` first, so the Wave A repair runs `gio launch /usr/share/applications/<id>.desktop` instead); `settings`: `cinnamon-settings <panel>` for `network`, `bluetooth`, `display`, `sound`, `printers`, `power`, `keyboard`, `notifications`, `themes` |
  | `os_setting` | `setting`: `dark_mode`, `night_light`, `do_not_disturb`, `volume`, `text_size`; `value`: boolean, or 0–100 for `volume`, or 1.0–2.0 for `text_size` | exec | one argv per setting (below) |

  Proposed Cinnamon commands, all confirmed on a SAI OS image in Task 4.10: `dark_mode` → `gsettings set org.x.apps.portal color-scheme prefer-dark|default`; `night_light` → `gsettings set org.cinnamon.settings-daemon.plugins.color night-light-enabled true|false`; `do_not_disturb` → `gsettings set org.cinnamon.desktop.notifications display-notifications false|true`; `volume` → `pactl set-sink-volume @DEFAULT_SINK@ <n>%`; `text_size` → `gsettings set org.cinnamon.desktop.interface text-scaling-factor <x>`.
- `approval` for `open_item` and `os_setting` is a function returning `{ tier: "exec", reason }` with a plain sentence in the session language (`SAI_ATLAS_LANG`), for example `Turn on night light` / `Bật ánh sáng ban đêm`; for `open_item` file/folder the sentence names the full resolved path. On a platform other than Linux the four OS tools return the text `This works only on SAI OS.` (the office tools work on every platform).
- `index.ts` default export registers the four OS tools with `loadMode: "essential"` and calls `registerOfficeTools(pi)` from Task 4.5.
- Tests before (red): `buildOsSettingArgv("volume", 150)` throws; `buildOsSettingArgv("dark_mode", true)` returns the exact argv above; `buildOpenItemArgv({ kind: "file", value: "/etc/passwd" })` throws; a symlink in home pointing outside it throws; `~/x.sh`, `~/x.desktop` and `~/x.html` throw; `{ kind: "app", value: "calc" }` with only `~/.local/share/applications/calc.desktop` present throws; `{ kind: "settings", value: "rm" }` throws; `diagnose` with `area: "storage"` runs only argv arrays from its list (inject a fake `execFile` and record calls); the default export, called with a fake `pi` that records `registerTool`, registers exactly seven tools — `diagnose`, `system_status`, `open_item`, `os_setting`, `office_report`, `office_slides`, `office_clean` — with the tiers above (`write` for the office tools) and `loadMode: "essential"` on every one.
- Verify: `bunx vitest run assistant-pack/test/os-commands.test.ts assistant-pack/test/tools.test.ts` red first, then exits 0.

### Task 4.7 — Skills, system prompt, config overlay (test first)
- Target files: the four `SKILL.md`, `system-prompt.md`, `config.yml`, `assistant-pack/test/pack-files.test.ts`.
- Content (start from `spike/pack-v2b/`, which scored 17/20 on E4B):
  - Office skills: frontmatter `name` (equal to the directory name) and a one-line `description` that names the job in plain words, in English. Body, in order: when to use it; if the person names a file, read it with `read`; call the matching tool once (`word-report` → `office_report`, `slides-from-report` → `office_slides`, `spreadsheet-cleanup` → `office_clean`), with the Markdown rules for `markdown` and `name` only when the person asked for a file name; for `spreadsheet-cleanup`, `file` is the path on the `User:` line at the end of the message, copied exactly, else the path the person named; tell the person the file name from the tool's result and that it can be opened from the card; on a tool error, say so plainly and fix the input once. No example paths, titles or commands (models copy them).
  - `spreadsheet-cleanup` names the accepted inputs: `.xlsx`, `.xls`, `.ods`, `.csv`.
  - `sai-os-helpdesk`: the doc's "Helpdesk helper" steps rewritten for the main session: when the problem is unclear, ask one short question with `ask`; run `diagnose` for the matching area first (`system_status` for an overall check); explain the finding in one or two plain sentences in the person's language; offer one fix at a time, only with `os_setting` or `open_item` (each one approved by the person); run `diagnose` again and say whether it worked; stop when a fix needs a password or new hardware, or after two failed fixes, and write a short support note with `write` into the Sai ATLAS folder under Documents. Then how-to steps with Cinnamon menu paths for jobs no tool can do (add a printer, connect a projector, pair a Bluetooth device, change the input method).
  - `system-prompt.md`: the doc's draft (section "System prompt") with the spike's changes: open a skill by calling `read` on `skill://word-report`, `skill://spreadsheet-cleanup`, `skill://slides-from-report` or `skill://sai-os-helpdesk`; Word reports, clean-ups and slides are made with `office_report`, `office_clean` and `office_slides` after opening the matching skill; computer problems open `skill://sai-os-helpdesk`; a job with separate parts is done one part at a time, each with its own skill; no helper bullets and no command wording.
  - `config.yml` (every key here is pinned; the setting ids are verified in omp source: `temperature` `session/settings.ts:433`, `shellPath` `exec/settings.ts:80`, `bash.allowCompoundCommands` `:95`, `bash.direnv` `:153-157` (`auto | off`), `fetch.enabled` `tools/settings.ts:670`, `skills.*` `extensibility/settings.ts:29-81`, `commands.*` `extensibility/settings.ts:104-149`, `plan.enabled` and `plan.defaultOnStartup` `plan-mode/settings.ts:12-35`, `mcp.enableProjectConfig` `mcp/settings.ts:10`, `task.disabledAgents` `task/settings.ts:372`; bundled agent names from `task/agents.ts:44-66`):
    ```yaml
    temperature: 0.2
    # No bash tool is loaded: shellPath and bash.* are inert, kept as a deny-all guard
    # for any shell path omp still has.
    shellPath: /bin/sh
    bash:
      patterns:
        - match: "*"
          approval: deny
      allowCompoundCommands: false
      direnv: "off"
    fetch:
      enabled: false
    extensions: []
    skills:
      enablePiUser: false
      enablePiProject: false
      enableAgentsUser: false
      enableAgentsProject: false
      enableClaudeUser: false
      enableClaudeProject: false
      enableCodexUser: false
      customDirectories: []
      includeSkills: []
      ignoredSkills: []
    commands:
      enableClaudeUser: false
      enableClaudeProject: false
      enableOpencodeUser: false
      enableOpencodeProject: false
    plan:
      enabled: false
      defaultOnStartup: false
    mcp:
      enableProjectConfig: false
    # No task tool is loaded; disabledAgents stays as belt-and-braces.
    task:
      disabledAgents: [task, sonic, scout, reviewer, security-reviewer]
    tools:
      approval:
        write: prompt
        open_item: prompt
        os_setting: prompt
        office_report: prompt
        office_slides: prompt
        office_clean: prompt
        edit: deny
        ast_edit: deny
        eval: deny
        browser: deny
        web_search: deny
        github: deny
    ```
    Against the block the spike measured (`spike/pack-v2b/config.yml`), this drops `task.maxConcurrency` and `tools.approval.task` (they configure a tool that is not loaded) and the `office *` allow rule (nothing named `office` ships). `direnv` is quoted so every YAML parser reads the string `off`. The `skills.customDirectories`/`skills.includeSkills` rows and the `commands` and `plan` blocks were added by the Wave A repair (`plan.md` "Wave A review fixes", review H2 and M3): without them a user or project config could add skills or prompt commands to pack sessions, and omp's RPC start arms plan mode when `plan.defaultOnStartup` and `plan.enabled` are true (`modes/rpc/rpc-mode.ts:1710-1720`), with no plan UI left to answer it. Phase 6 Task 6.6 reads every key back with value and provenance; if a key does not read back from the overlay there, STOP (Failure Protocol) — do not drop the key silently.
- Tests before (red):
  - every `SKILL.md` parses with a `name` matching its folder and a non-empty `description`;
  - `word-report` names `office_report`, `slides-from-report` names `office_slides`, `spreadsheet-cleanup` names `office_clean`; no office skill contains `bash`, `$`, `~/.cache`, `~/.local/share` or a line starting with `office `;
  - `sai-os-helpdesk` names `diagnose`, `os_setting` and `open_item`, and does not contain `bash` or `task`;
  - `system-prompt.md` contains each of the four `skill://<name>` paths and each of the three office tool names, contains neither `helper` nor `bash` (case-insensitive), and is under 2,048 bytes;
  - `config.yml` parses (the `yaml` npm package under vitest) to an object deep-equal to the block above, with `bash.direnv === "off"` (a string);
  - `assistant-pack/agents` and `assistant-pack/bin` do not exist.
- Verify: `bunx vitest run assistant-pack/test/pack-files.test.ts` red first, then exits 0.

### Task 4.8 — Build script (test first)
- Target files: `scripts/build-assistant-pack.ts`, `scripts/build-assistant-pack.test.ts`, `package.json`.
- Behaviour: build into a fresh temp directory next to the output (`<out>.tmp-<pid>`), then remove the old output and `rename` the temp directory into place, so a failed build never leaves a partial pack; `Bun.build` `assistant-pack/src/tools/index.ts` → `tools.js` (`target: "bun"`, all dependencies bundled, no `@oh-my-pi/*` imports); copy `skills/`, `system-prompt.md` and `config.yml`; write the `package.json` manifest from the layout above; fail with exit 1 if any `.js` file other than `tools.js` exists in the output afterwards.
- `package.json` scripts: add `"build:pack": "bun scripts/build-assistant-pack.ts"` and prefix `bun run build:pack && ` to `package`, `package:mac`, `package:mac:arm64`, `package:mac:x64` and `package:tauri:linux`.
- Tests before (red): run the script into a temp dir (accept `--out <dir>`); assert the exact file list (the eight paths in Phase 6 "Pack file list"), the manifest JSON, that a build whose `Bun.build` fails leaves the previous output untouched, and that `tools.js` contains no `require("@oh-my-pi` string.
- Verify: `bunx vitest run scripts/build-assistant-pack.test.ts` red first, then exits 0; `bun run build:pack` exits 0, `ls resources/assistant-pack/tools.js resources/assistant-pack/config.yml` exits 0, and `test ! -e resources/assistant-pack/bin && test ! -e resources/assistant-pack/agents` exits 0.

### Task 4.9 — Compiled-path integration test, pack load check and CI job
- Target files: `assistant-pack/test/compiled.test.ts`, `assistant-pack/test/fixtures/call-tool.mjs`, `assistant-pack/test/visual.test.ts`, `scripts/check-assistant-pack.ts`, `.github/workflows/ci.yml`.
- `call-tool.mjs <packDir> <toolName> <params JSON>`: imports `<packDir>/tools.js`, calls its default export with a fake `pi` that records `registerTool`, runs the named tool's `execute("t1", params)` and prints the result as one JSON line.
- `scripts/check-assistant-pack.ts <omp binary> <pack dir> [--tools <comma list>] [--lang en|vi]` (Bun script, ported from `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/loadcheck.ts` and the `Sidecar` client in `spike/harness/rpc.ts`: spawn, newline-delimited JSON, `rpc_chunk` reassembly, `negotiate_protocol` version 2, request/response by id; no suite, scoring or drafts code). It spawns `<omp binary> --mode rpc-ui --no-session --no-extensions --extension <pack> --tools <list> --system-prompt <pack>/system-prompt.md --config <pack>/config.yml --approval-mode always-ask` with `HOME` set to a fresh temp directory, `SAI_ATLAS_LANG` from `--lang` (default `en`), `BASH_ENV` and `ENV` removed, and a 60 s ready timeout. The default `--tools` is the Linux list from Phase 6 "Spawn contract". It exits 1, naming every failed row, unless all of these hold:
  1. `get_active_tools` names equal the `--tools` list exactly (sorted compare);
  2. the `skill:<name>` entries of `get_available_commands` are exactly `sai-os-helpdesk`, `slides-from-report`, `spreadsheet-cleanup`, `word-report` (never `get_skills`, which re-runs discovery);
  3. `get_state().systemPrompt` contains the trimmed text of `<pack>/system-prompt.md`, and the `<skill name="…">` entries in it are the same four names;
  4. `get_agent_definitions` lists no agent whose `source` is the pack;
  5. for every `config.yml` path known to `get_settings_schema` (walk nested maps to schema paths as the spike's `flattenToSchema` does), `get_settings` returns the pack's value and a `provenance.layers` array containing `"overlay"`; for the `record` path `tools.approval` every pack entry reads back; the list of `config.yml` paths the schema does not know is empty;
  6. no `extension_error` frame and no `notice` frame mentioning the pack arrived before the checks ran.

  It prints one row per tool, skill and setting (`path`, value, layers).
- `compiled.test.ts`: `OMP_BIN` is `resources/omp.linux-x64` on Linux or `resources/omp` on macOS. When the binary is missing the suite fails with `sidecar binary missing: <path>` unless `SKIP_COMPILED=1` is set (CI sets it; worktrees link the binary in Task N.0). Cases:
  1. `office_report` through `call-tool.mjs`: `<OMP_BIN> assistant-pack/test/fixtures/call-tool.mjs <abs resources/assistant-pack> office_report '<{"markdown": text of notes-en.md}>'` with env `{ BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", HOME: <temp>, SAI_ATLAS_LANG: "en" }` exits 0, the result is not `isError`, and a `.docx` exists under `<temp>/Documents/Sai ATLAS/` (an installed `xdg-user-dir` prints the temp home because the temp home has no `user-dirs.dirs`, so this also exercises the fallback);
  2. `office_clean` on an ExcelJS-built `.xlsx` → a `(cleaned).xlsx` in the same folder;
  3. `loads the pack into the sidecar`: `execFileSync("bun", ["scripts/check-assistant-pack.ts", OMP_BIN, <abs resources/assistant-pack>], { env: { ...process.env, HOME: <temp> } })` exits 0, and its stdout lists the eleven tools, the four skills and a `bash.direnv` row reading `off` with layers `overlay`;
  4. `refuses a wrong tool list`: the same with `--tools read,glob,write,ask,find` exits 1 and the output names `find` (proves the check is not vacuous).
- CI: new job `assistant-pack` (ubuntu-latest): checkout, setup Bun as the other jobs do, `bun install --frozen-lockfile`, `sudo apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress`, `bun run build:pack`, `SKIP_COMPILED=1 bunx vitest run assistant-pack scripts/build-assistant-pack.test.ts`, then `CI_VISUAL=1 bunx vitest run assistant-pack/test/visual.test.ts`. The existing `linux` job's `bunx vitest run` step gets `env: { SKIP_COMPILED: "1" }` (a clean clone has no sidecar, `AGENTS.md` "CI"). `visual.test.ts` (skipped unless `CI_VISUAL=1`) converts each fixture output with `soffice --headless --convert-to pdf` (exit 0, PDF non-empty) and the cleaned workbook with `--convert-to csv`, then checks the totals row equals the cached results.
- Verify: `bunx vitest run assistant-pack` exits 0 locally with the four compiled cases listed as passed (not skipped); `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` exits 0; `grep -c 'SKIP_COMPILED' .github/workflows/ci.yml` prints at least `2`. (The spike's baseline the port must reproduce: in `spike/results/loadcheck.v2b.json` every setting row reads `{"provenance":{"layers":["overlay"]},"match":true}` and `unknownKeys` is `[]`.)

### Task 4.10 — SAI OS command check (human)
- Superseded 2026-10-06: the user chose Ubuntu GNOME as the only target desktop (`plan.md` Decisions "Target desktop"); the Cinnamon commands below were replaced on `rebrand/ubuntu-gnome`, and the human check moved to Phase 9 Task 9.0's precondition.
- Steps: collect the user's answer to the request sent at Task 4.0 step 5 (which `os_setting` argv and which `cinnamon-settings` panels work on SAI OS). Update `os-commands.ts` and its tests to the confirmed commands only. If the answer has not arrived by Task 4.11, merge with the proposed commands and record a `NEEDS-INTEGRATION` row for Task 4.10 in the Phase 4 report; the confirmed list must land before Phase 9.
- Verify: the confirmed list (or the `NEEDS-INTEGRATION` row) is recorded in `plans/reports/spike-261005-everyday-work-rebrand.md` under "SAI OS commands", and `bunx vitest run assistant-pack/test/os-commands.test.ts` exits 0.

### Task 4.11 — Gate and merge
- Steps: `bun run check:types` → 0; `bunx vitest run` → 0; `bunx biome check assistant-pack scripts/build-assistant-pack.ts scripts/build-assistant-pack.test.ts` → 0; commit in logical units (`feat(pack): …`); then `git -C /home/tung491/WORK/worktrees/rebrand-integration merge --no-ff rebrand/p04-assistant-pack` (on a conflict, STOP). If this is the last of Phases 2, 3 and 4 to merge, run the Wave A gate (`plan.md` "Wave gate") on the integration worktree; only when it passes, `git -C /home/tung491/WORK/worktrees/rebrand-integration tag rebrand-wave-a`.
- Verify: all commands exit 0; the merge commit exists.

## Risks and rollback

- exceljs is stale (last release 2023-10): pinned and covered by tests. If a rule cannot be met, the fallback is SheetJS CE 0.20.3+ from its CDN, never npm 0.18.5 (known CVEs). Switching is a user decision: STOP and ask.
- WPS font aliasing: Arial/Times New Roman map to Liberation fonts; the Phase 1 human checks passed in WPS and Microsoft Office.
- Typed requests where the model skips `read` and sends placeholder Markdown were the spike's remaining failures (3 of 20 on E4B). The read-first description and the path-only rejection (Task 4.5) target them; Phase 9 Task 9.7 creates each file kind from the installed deb.
- The overlay differs from the measured block in three dropped entries (Task 4.7). Task 4.9's `check-assistant-pack.ts` loads the built pack into the real sidecar and reads every key back, so drift is caught inside this phase.
- Rollback: before Phase 6 merges, revert this merge commit and delete `resources/assistant-pack/`. After Phase 6, the shells refuse to spawn without the pack, so Phases 6–8 roll back with it (`git reset --hard` to the tag before the wave being undone, see `plan.md` "Rollback").

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
