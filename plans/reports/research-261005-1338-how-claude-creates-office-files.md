# How Claude creates Word, Excel and PowerPoint files, and what Sai ATLAS should copy

Date: 2026-10-05 (Asia/Seoul). Scope: Anthropic's production `docx`, `xlsx` and `pptx` skills, read from the newest local sync (`~/.claude/skills/synced/…_81e58971…/`, manifest dates: xlsx 2026-09-14, docx 2026-09-30, pptx 2026-10-02), compared with the public `anthropics/skills` repo and Anthropic's documentation. Context: the accepted plan `research-261005-1305-non-tech-assistant-rebrand.md`, sections 3.1–3.4 and the appendix. Those decisions are not reopened here.

## Outcome

1. **Claude has no file generator.** A frontier model writes a fresh script for every file (`docx` npm for Word, `openpyxl` for Excel, `pptxgenjs` for PowerPoint) and runs it in a sandbox VM that has Python, Node, LibreOffice, pandoc and Poppler preinstalled. The skill text that loads on demand is mostly a list of the library's pitfalls. The model then **verifies the output with tools**: it renders the file to images and looks at them, recalculates the workbook in LibreOffice, and runs XSD and "would PowerPoint refuse this" validators.
2. **Sai ATLAS's route still holds.** The accepted plan uses deterministic tools in which the small model writes only Markdown. That is the right inversion for Gemma 4 E2B/E4B. Anthropic's own guidance says scripts give "deterministic reliability that only code can provide" (engineering blog, 2025-10-16).
3. **What to copy is the knowledge, not the code.** Copy the quality rules and the library pitfalls by writing them into our own code once, so the model never has to know them. Move verification from the model's eyes into checks the code runs at build time and at run time.
4. **The plan has four gaps to fix:**
   - `create_slides` as specified ("one slide per `##`, bullets") is exactly the plain-bullets deck that Claude's design guide tells it to avoid.
   - `clean_spreadsheet` can corrupt data in two ways. Converting text to numbers destroys leading zeros in phone and ID numbers, and deleting rows breaks formulas already in the source sheet.
   - Fonts are not specified. WPS on Linux may not map Arial to Liberation Sans.
   - Phase 0's acceptance test, "LibreOffice opens it", is too weak. Claude's validator exists because LibreOffice opens files that PowerPoint refuses.
5. **Licensing:** the three skills are proprietary ("source-available, not open source"). Their licence forbids copying, derivative works and distribution. Do not copy any script, schema bundle or skill text. Re-derive each fact from the library docs and our own tests.

## Contents

1. What Claude does for each format
2. The architecture and the model capability it assumes
3. Technique mapping: adopt, adapt or skip
4. Design changes for the three tools, and what the plan gets wrong
5. Licensing
6. Source credibility and limitations
7. Unresolved questions
8. Sources

---

## 1. What Claude does for each format

Each skill starts with a routing table that sends the work down one of three paths: **create**, **edit** or **read**. Each path uses a different tool. All three skills ship an identical `scripts/office/` toolkit (the `validate.py` and `soffice.py` hashes match across the skills).

### 1.1 Word (.docx)

| Path | Tool |
|---|---|
| Create | The model writes a Node script against the `docx` npm package, which is preinstalled. The skill says the model already knows the API and lists only the pitfalls. |
| Edit | Unzip the file, edit `word/document.xml` in place without pretty-printing, then zip it again. `docx` cannot open existing files. A `merge_runs.py` helper first joins text that Word has split across `<w:r>` runs, so that phrases become searchable. Comments go through a helper that writes the six cross-linked parts. Tracked changes are written by hand as `<w:ins>`/`<w:del>`. |
| Read | `pandoc -t markdown`. |

**Verification.** Convert to PDF with LibreOffice (through a wrapper that works around sandbox socket restrictions), rasterize with `pdftoppm`, then have the model look at the page images. Edited files go through `validate.py`. It runs XSD checks against the ISO/ECMA schemas, baselined against the original file. It can auto-repair over-long IDs and missing `xml:space="preserve"`, and with `--author` it reports any edit that is not tracked.

**Pitfalls the skill lists**, paraphrased:
- The default page size is A4.
- Landscape needs portrait dimensions plus an orientation flag.
- Tables need `columnWidths` and a width on every cell, both in DXA, and the widths must add up. Percentage widths break in Google Docs.
- Shading must use `CLEAR`, because `SOLID` renders black.
- Bullets need a numbering configuration, never a literal "•".
- No `\n` inside text runs.
- `PageBreak` belongs inside a `Paragraph`.
- Headings must use the built-in heading levels, or they do not appear in a table of contents.
- Use a paragraph border for a horizontal rule, and a positional tab for dot leaders.

**New in the 2026-09-30 sync.** When the user has not named Word, Claude now builds the document in its own Docs artifact instead, and that artifact exports to Word.

### 1.2 Excel (.xlsx)

| Path | Tool |
|---|---|
| Create or edit | Python `openpyxl` |
| Bulk data | `pandas` |
| Quick look | `markitdown` |
| Reading a model | Two `load_workbook` passes, one for formulas and one for cached values |

**Required for every output.**
- Use one professional font throughout.
- Ship **zero formula errors**.
- **Use formulas, never hardcoded results.**
- Follow the user's spec literally.
- Document every assumption and hardcoded number where the reader will see it.
- A workbook made for someone to fill in gets a legend and one example row.
- When editing, match the file's existing conventions and leave its formulas alone.

**Recalculation is mandatory.** `openpyxl` writes formulas without cached values, so every reader that uses cached values sees blanks. `recalc.py` installs a LibreOffice Basic macro into a throwaway profile, runs `calculateAll()` and saves, and rewrites the file in place. It then scans for the seven Excel error strings and returns JSON (`status`, `total_errors`, `total_formulas`, error locations).
- It refuses to run when external-link cells have lost their cached values, because recalculation would delete those links.
- It detects a "clean exit, file not rewritten" failure.
- The skill also warns that a clean recalculation only proves that formulas **evaluate**, not that they are **right**. The model is told to test two or three formulas before building a whole grid.

**Formula portability.**
- Prefer Excel 2007-era functions.
- A few newer functions need an `_xlfn.` prefix.
- Never use the spilling array functions (XLOOKUP, FILTER, UNIQUE and others). The sandbox's LibreOffice cannot evaluate them, or the file has no spill metadata.

**Conventions for financial models.**
- Input-colour coding.
- Percentages stored as fractions.
- Years stored as text.
- Negatives shown in parentheses.
- Every assumption in its own cell.

There is no XSD validation for xlsx. `validate.py` points to `recalc.py` instead.

### 1.3 PowerPoint (.pptx)

| Path | Tool |
|---|---|
| Create | A `pptxgenjs` script. Since the 2026-10-02 sync it must be a **structured deck** unless the user wants a throwaway (details below). |
| Edit or fill a template | Unzip and edit the slide XML. Helpers `add_slide.py` and `clean.py` handle duplication and orphan removal. `thumbnail.py` builds a labelled grid for choosing template layouts. |
| Read | `markitdown` |

A **structured deck** works like this:
1. Define a theme object with fonts and twelve scheme colours.
2. Use scheme colours everywhere.
3. Create one `defineSlideMaster` layout for each slide frame, with named placeholders.
4. Group slides into sections.
5. Fill text by placeholder name.
6. After `writeFile`, run `apply_theme.js`. It rewrites `<a:clrScheme>` in `ppt/theme/theme1.xml` through JSZip, because pptxgenjs cannot write theme colours, and it refuses any `srgbClr` value that is not six hex digits.

**Pitfalls that corrupt the file:**
- A `#` prefix or an 8-digit hex colour.
- A negative shadow offset.
- `outEnd` data labels on stacked bar charts.
- Secondary axes declared without both `valAxes` and `catAxes`.
- Reordering children of `<p:presentation>`.
- An unescaped `&` in `pres.company` or in a layout title.

**Pitfalls that fail silently:**
- The default canvas is 10" × 5.625", and off-slide coordinates are not clamped.
- Option objects are mutated in place, so they must not be shared between calls.
- `letterSpacing` does nothing; the real option is `charSpacing`.
- Literal bullets render twice.
- A misspelt placeholder name produces a stray box at 0,0.
- Charts render bare unless titles, labels and colours are set.

**Design guidance:**
- One message per slide, often in a pyramid structure.
- A palette chosen for the topic, with one dominant colour.
- Dark title and closing slides.
- Every slide carries a visual element: chart, stat callout, cards, icon or image.
- Varied layouts.
- Safe fonts whose LibreOffice substitutes have identical metrics (Arial, Calibri, Cambria, Times New Roman and a few others), and never Aptos.
- Titles 36–44 pt and body text 14–16 pt, with **a 14 pt floor**. Below it, cut words or split the slide.
- 0.5" margins.
- An explicit "avoid" list: accent lines under titles, edge stripes, centred body text, cream backgrounds, text-only slides and overflow.

**QA (required):**
1. Content QA: run `markitdown` and grep for placeholder text.
2. File QA: run `validate.py`. It does XSD checks, plus checks for the specific chart and slide-XML defects that PowerPoint refuses while LibreOffice and python-pptx accept them.
3. Visual QA: render at 150 dpi and inspect every slide with fresh eyes, ideally through a subagent. The checklist covers overflow, overlap, contrast, alignment, titles drifting between slides, and numbers split from their units.

### 1.4 Version comparison

The public repo was last updated on 2026-07-17 (PR #1447).
- **xlsx:** the local copy is identical to the public one.
- **docx:** the local copy adds the deferral to Docs.
- **pptx:** the local copy adds structured decks, `apply_theme.js`, deck-flow guidance, `isTextBox`, the `&`-escaping pitfall, title and chart-label consistency rules, and the 14 pt floor.

The skills are actively maintained. pptx changed three days before this report.

None of the three local skill sets contains a "slides" skill. "Slides" appears only in pptx's routing text ("a dedicated slide-deck artifact type or a separate slides skill"). The `docs` skill that docx now defers to is six lines long and only sends the model to Anthropic's hosted Docs connector. Neither one generates files, so nothing in them can be reused.

---

## 2. The architecture and the model capability it assumes

**Runtime.** Code runs in an isolated Linux container. The API documentation lists Python 3.11, x86_64, 5 GiB RAM, 1 CPU, no internet, and preinstalled `openpyxl`, `python-docx`, `python-pptx`, `pypdf` and similar packages. The skills also assume Node with `docx`, `pptxgenjs`, `react-icons` and `sharp`, plus LibreOffice, pandoc, Poppler and `markitdown`. Those tools are missing from the API page's list, so the claude.ai/Cowork image is evidently richer than what the API documents. Network access varies by plan on claude.ai and is off on the API. Cowork runs this sandbox on Anthropic's servers, not on the user's machine.

**Progressive disclosure.**
- Only each skill's name and description (about 100 tokens) sit in the system prompt.
- `SKILL.md` (under 5k tokens) is read with bash when the request matches the description.
- Scripts run without their code entering the context window; only their output does.

**Division of labour.** The model composes. Scripts handle what must be exact: recalculation, validation, theme writing and slide bookkeeping.

**What it assumes of the model:**
- Library APIs are known from pretraining. The skill says so explicitly and lists only the pitfalls.
- It can write and debug 100–300-line scripts from tracebacks over several turns.
- It can choose between creating, editing and reading, and route by file type.
- It has reliable vision for critiquing rendered pages: overflow, contrast, alignment.
- It can run a fix-and-re-render loop and stop at the right point.
- It reads around 5k tokens of dense instructions and applies them without being reminded.

Gemma 4 E4B (Tau2 42.2%) and E2B (24.5%) meet none of these reliably, so the plan's inversion is correct.

The Claude for Excel and PowerPoint add-ins (blog post, 2026-03-11) take a third route: they edit inside the Office host, so the host's own calculation and layout engines do the verifying. WPS has no comparable integration in scope.

---

## 3. Technique mapping: adopt, adapt or skip

"Adopt" means it goes into our code unchanged. "Adapt" means the idea is kept but the mechanism changes. "Skip" means it is not used, with the reason given.

| Claude technique | Verdict | How, and why |
|---|---|---|
| Model writes library code per file | **Skip** | Small models cannot write and debug it. This is the plan's route A rationale. |
| Pitfall lists for `docx` and `pptxgenjs` | **Adopt as an implementation checklist** | Engineers apply each pitfall once in tool code and cover it with a unit test. The model never sees them. |
| Read via pandoc or markitdown | **Adopt (already exists)** | omp's `read` uses its own markit converters (`src/markit/converters/{docx,xlsx,pptx}.ts`). |
| Edit existing .docx/.pptx via raw XML | **Skip in v1** | Raw OOXML surgery is multi-step and error-prone even for Claude, and it is not in the user's script. |
| Formulas, not hardcoded results | **Adopt** | Totals stay live formulas, using an Excel Table `totalsRowFunction: 'sum'`, which Excel writes as `SUBTOTAL(109,…)`. |
| Cached values (Claude needs a LibreOffice recalc) | **Adapt** | ExcelJS "cannot process the formula… it must be supplied". Compute in JS and write `{ formula, result }`, plus `totalsRowResult` on table columns, plus `workbook.calcProperties.fullCalcOnLoad = true`. Two facts make the supplied results load-bearing: LibreOffice's default for xlsx is "Never recalculate" on load, and omp's own xlsx converter reads only `<v>` (`xlsx.ts:145-147`), so a missing result would show as blank. |
| `recalc.py` error scan | **Adapt to CI** | No LibreOffice on SAI OS (WPS is the default). In CI and dev, recalculate fixture outputs with headless `soffice` (present on this dev box) and assert that our supplied results equal LibreOffice's. At run time, our JS computes the results, so there is nothing to recalculate. |
| Excel 2007-era functions only | **Adopt** | The only formulas the tool emits are SUBTOTAL and SUM. Keep it that way. |
| Document every assumption | **Adopt** | Add a "Changes" sheet to the cleaned workbook and return the same plain summary. |
| Years as text, percentages as fractions | **Adopt** | These belong in the number-conversion rules (section 4.2). |
| Edits match the file's conventions; leave formulas alone | **Adapt** | The original is never modified (already in the plan). Carry column number formats over, and handle formulas in the source explicitly (section 4.2). |
| Structured deck: theme, layouts, placeholders, sections | **Adopt** | Deterministic code gets this right once. The user can then restyle the deck in WPS or PowerPoint. |
| `apply_theme.js` (write `<a:clrScheme>`) | **Adapt (own code)** | Write our own JSZip step. JSZip is already a `pptxgenjs` dependency. We cannot reuse Anthropic's script. |
| Design guidance: varied layouts, every slide visual, avoid list | **Adapt** | A deterministic layout picker chooses by Markdown shape (section 4.3) and never emits the "avoid" patterns. |
| Topic-specific palette chosen by the model | **Adapt** | Offer a small `style` enum of our own palettes (VIF brand plus two or three more). Free-form hex from a small model risks the `#` and 8-digit corruption. |
| Native charts via `addChart` with labels and titles | **Adopt (narrow)** | Use only for Markdown tables with one label column and numeric columns. Use clustered bars, so the stacked `outEnd` and secondary-axis traps never arise. |
| Icons via `react-icons` + `sharp` | **Skip in v1** | `sharp` is a native addon, which is risky inside a Bun-compiled pack. Cards and stat callouts give the visual weight without icons. |
| Safe-font list | **Adapt** | Name Arial or Times New Roman in files (Windows recipients have them; Debian has the Liberation metric twins). Verify in WPS (section 4.4). |
| 14 pt floor; split slides, never shrink | **Adopt** | Estimate fit from character and line budgets per layout; overflow becomes "(cont.)" slides. Do not rely on `fit: 'shrink'`, which only writes an autofit flag that the viewer has to honour. |
| Render to image + model visual QA | **Skip at run time; adapt for developers** | SAI OS has no headless renderer (WPS is not scriptable here, and LibreOffice is absent). Gemma's visual critique is unreliable. Render fixtures to PNG in CI and review them when the layout code changes. |
| `validate.py` XSD and "PowerPoint refuses" checks | **Adapt** | Run time: cheap checks (zip reopens, every XML part parses, every `srgbClr` is six hex digits, no forbidden chart construct). CI: XSD validation against schemas taken from ECMA-376 itself, not Anthropic's bundle, plus a manual open in Microsoft PowerPoint and WPS for each release. |
| Content QA (markitdown + placeholder grep) | **Adopt** | After writing, the tool re-reads its own output and compares the number of headings, tables and slides with the input. The counts go in the tool result. |
| Progressive-disclosure skills | **Skip in v1** | An extra read hop is where small models fail (plan section 3.1). Short tool descriptions carry the input convention instead. |
| Prefer the in-app artifact unless a format is named | **Adapt** | When no file is requested, answer in chat. The starter cards and file wording are what trigger the tools. |

---

## 4. Design changes for the three tools, and what the plan gets wrong

### 4.1 `create_document`

- **Inputs:** keep `title`, `markdown` and `file_name?`. Fix the page size at A4, which is the `docx` default and the Vietnamese norm. Add no style parameter: one house style.
- **Code checklist**, each item with a unit test:
  - Bullets and numbered lists through a `numbering` config.
  - Strip literal "•" and "- " characters the model types into text.
  - Tables in DXA, with `columnWidths` and every cell width summing to the content width.
  - Header shading `CLEAR`.
  - Soft line breaks split into paragraphs.
  - Built-in `HeadingLevel` (so WPS's navigation pane works).
  - `---` becomes a paragraph bottom border.
  - Page breaks inside paragraphs.
- **Verification:** reopen the zip, parse `word/document.xml`, and check that the counts of headings, tables and list items match the `marked` tokens. Return a summary such as "3 headings, 2 tables, about 2 pages".

### 4.2 `clean_spreadsheet`

- **Keep** the plan's flow (Table, totals row, frozen header, auto widths, original untouched, `decimal_separator`). Add `totalsRowResult` and `fullCalcOnLoad`.
- **Fix: identifier columns.** Never convert a text column to numbers when any value has a leading zero (Vietnamese phone numbers start with 0), more than 15 digits (Excel's precision limit; bank account numbers), or an ID-like header (for example "SĐT", "CCCD", "Mã"). Report those columns as "kept as text".
- **Fix: year and percent columns.** Year-like columns stay without thousands separators. Values such as "15%" become 0.15 with format `0.0%`.
- **Fix: formulas in the source.** Dropping blank or duplicate rows shifts references, so formulas in the source sheet would turn into `#REF!`. The plan does not handle this. Write those cells as their values (ExcelJS exposes `.result`) and log each affected column in the Changes sheet. If any formula cell has no cached result, stop and say so plainly instead of guessing.
- **Fix: merged cells.** Unmerge them, keep the value in the top-left cell, and log it.
- **Output:** a "Changes" sheet (vi: "Thay đổi") lists every action and count. Use one font throughout.

### 4.3 `create_slides`

**What the plan gets wrong.** "One slide per `##` heading, bullets from list items" produces the deck Claude's guide names as its first anti-pattern: plain bullets on white. Keep Markdown as the input, but read its shape:

| Markdown shape | Layout |
|---|---|
| Deck title | Dark title slide |
| `#` | Dark section divider |
| `##` + 2–4 items that each start with **bold text** | Card grid |
| `##` + a line starting with a bold number ("**42%** …") | Big-stat callout |
| `##` + table with a label column and numeric columns | Native clustered bar chart, with title and data labels in theme colours |
| `##` + other table | Native table |
| `##` + bullets | Title and bullets, split into "(cont.)" slides past the per-layout budget, body ≥ 14 pt |
| `> Notes: …` under a slide | Speaker notes (`addNotes`) |

**Code checklist:**
- `LAYOUT_16x9`, set before adding slides.
- Hex colours without `#`.
- A fresh options object for every call.
- `bullet: true` and `isTextBox: true`.
- `margin: 0` where text aligns with shapes.
- One `pptxgen` instance per file.
- Escape `&` in any user string passed to `company` or a layout title.
- Sections and slide numbers on the layouts.
- Our own theme-colour step after `writeFile`.
- No underline accents and no edge stripes.

**Verification.** Run the run-time structural checks from section 3. Check the slide count against the plan, and list which slides were split. Return that summary.

### 4.4 Cross-cutting

- **Fonts.** Arial (body) and Times New Roman or Arial Bold (titles) cover Vietnamese, exist on Windows, and map to Liberation fonts on Debian. One 2021 forum report says WPS on Linux ignores fontconfig aliases. Phase 0 must open a Vietnamese test file in WPS on SAI OS.
- **Phase 0 acceptance.** Replace "LibreOffice opens" with three checks:
  1. WPS on SAI OS opens all three fixtures without a repair prompt.
  2. Microsoft Office opens them without a repair prompt, checked once on Windows because recipients use it.
  3. CI checks pass (LibreOffice recalc parity, XSD, PNG render).
- **Plan section 4 evidence row.** Update it: Claude now builds structured, themed decks, and it defers to its own Docs or slide artifacts when no format is named.

---

## 5. Licensing

The three local `LICENSE.txt` files are identical: "© 2025 Anthropic, PBC. All rights reserved." Use is governed by the user's Anthropic agreement. The additional restrictions forbid:
- reproducing or copying the materials, except for temporary copies made automatically during use;
- creating derivative works;
- distributing them;
- extracting or keeping copies outside the Services;
- making or selling "inventions embodied in these materials".

The public README says these four skills are "source-available, not open source", unlike the repo's Apache-2.0 skills.

**Consequence.** Do not copy any script (`apply_theme.js`, `recalc.py`, the validators, the helpers), the bundled XSD set, the palette table, or skill prose into Sai ATLAS, its prompts or its tool descriptions. Library behaviour (for example, "a `#` prefix corrupts a pptxgenjs colour") is a fact about MIT-licensed libraries. Re-establish each one from the library docs or our own failing test, and cite that source in the code. Write the implementations independently. Take XSDs from ECMA-376 directly. This is not legal advice; the "inventions" clause deserves counsel's view before a commercial release.

---

## 6. Source credibility and limitations

**Credibility.** Primary sources: the skills themselves (production artifacts), Anthropic documentation and blogs, the ExcelJS README, LibreOffice help, and omp source. Secondary sources: third-party articles on the add-ins and Cowork, and one 2021 Manjaro forum thread on WPS fonts (weak; it is the reason for a Phase 0 check, not a conclusion).

**Not covered:**
- No code was run. pptxgenjs and ExcelJS under Bun, WPS rendering, and Gemma's handling of the Markdown conventions are untested.
- The PDF skill and Anthropic's Docs and slides artifacts were not analysed.
- The exact claude.ai container image is undocumented. Its contents were inferred from the skills' dependency lines.

---

## 7. Unresolved questions

1. Does WPS on SAI OS render "Arial" and "Times New Roman" with the Liberation fonts, and with correct Vietnamese diacritics? If not, which font names should files carry?
2. Does WPS honour `fullCalcOnLoad`, or does it display cached results like LibreOffice?
3. Which header words mark identifier columns for Vietnamese users (SĐT, CCCD, MST, Mã …)? Does a native speaker need to review that list?
4. Should `create_slides` take a `style` enum, or ship only the VIF brand palette in v1?
5. Is a Windows machine with Microsoft Office available for the per-release "opens without repair" check?
6. Does the CI image get LibreOffice through apt for the recalc-parity and render jobs, or does that run only on a developer machine?
7. Should the "Changes" sheet be optional for users who share the cleaned file?

---

## 8. Sources

- Local skills (primary): `~/.claude/skills/synced/3ecdcfb7-…_81e58971-…/{docx,xlsx,pptx}/SKILL.md`, `scripts/` and `LICENSE.txt`; `manifest.json` (updatedAt: xlsx 2026-09-14, docx 2026-09-30, pptx 2026-10-02). Read 2026-10-05.
- [anthropics/skills](https://github.com/anthropics/skills): README licence note; last commit to the skills 2026-07-17 (#1447). Accessed 2026-10-05.
- [Claude can now create and edit files](https://claude.com/blog/create-files): Anthropic, 2025-09-09; GA 2025-10-21.
- [Create and edit files with Claude](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude): support article updated 2026-08-06.
- [Code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool): runtime, limits and libraries. Accessed 2026-10-05.
- [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview): progressive disclosure and token costs. Accessed 2026-10-05.
- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills): Anthropic Engineering, 2025-10-16.
- [Advancing Claude for Excel and PowerPoint](https://claude.com/blog/claude-excel-powerpoint-updates): 2026-03-11; [Use Claude for Excel](https://support.claude.com/en/articles/12650343-use-claude-for-excel).
- [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork); [VentureBeat on the Cowork launch](https://venturebeat.com/technology/anthropic-launches-cowork-a-claude-desktop-agent-that-works-in-your-files-no) (secondary).
- [ExcelJS README](https://github.com/exceljs/exceljs): Formula Value, calcProperties, Tables and Totals Functions.
- [PptxGenJS text options](https://gitbrent.github.io/PptxGenJS/docs/api-text/); npm registry for `pptxgenjs` 4.0.1 dependencies (jszip ^3.10.1).
- [LibreOffice Help: Formula options, recalculation on file load](https://help.libreoffice.org/latest/en-US/text/shared/optionen/01060900.html).
- [Manjaro forum: WPS Office ignores compatible font links](https://forum.manjaro.org/t/two-issues-with-wps-office-compatible-fonts-not-linked-to-commonly-specified-families-and-bad-integration-with-dark-theme/53256): 2021-02-12, secondary and weak; [Liberation fonts](https://en.wikipedia.org/wiki/Liberation_fonts).
- Repository: `oh-my-pi/packages/coding-agent/src/markit/converters/xlsx.ts:125-147`; `plans/reports/research-261005-1305-non-tech-assistant-rebrand.md`, sections 3–4 and the appendix.
