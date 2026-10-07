# Ultra verdict — side-by-side document preview (best-of-5)

Verifier: kongming (Claude Fable 5.1). Date: 2026-10-07 (Asia/Seoul). Advisory only.
Inputs: evidence packet, rubric, library research, candidates A–E (anonymized, unordered).
Every repo claim below was checked against the working tree on 2026-10-07 (sibling
attachment-cards work uncommitted, present).

## TL;DR

**Winner: A** (weighted 284/320). Runner-up E (270), then B (266), C (259), D (258).
No candidate fails a hard constraint; **rejected_all: no**. **Margin: low** (A leads E by
14 points; by 22 on the deciding criteria C3+C6, under the 1/4-range threshold).
**Unanimous: no** (E tops C2 grounding; B tops C6 simplicity; A ties C4 with C and E).
Confidence: medium-high. Materialize A unchanged; feed the defect list below to the
red-team/validation gate; raise the design forks as user questions, do not merge them.

## Hard constraints

| | H1 JS-only | H2 both shells | H3 CSP | H4 isolation | H5 lazy | H6 advice contract + FP | H7 TDD red-first |
|---|---|---|---|---|---|---|---|
| A | pass | pass (9 twins in `ipc.rs`, parity, snapshot line, channel +1) | pass (git diff gate) | pass (shadow root, link router, altChunks off, base64 URLs, canvas-only PDF) | pass (rules + `LAZY_CHUNKS`, build verify) | pass — 6/6 verbatim FP blocks; every task has Goal/Target/Steps/Success/Verify | pass |
| B | pass | pass (11 twins) | pass (`git diff --quiet`) | pass | pass | pass — 6/6 FP; all tasks complete | pass |
| C | pass | pass (11 twins in new `read_document.rs`) | pass (exact-string grep ×3) | pass (+ `dangerouslySetInnerHTML` grep gate) | pass | pass with note — 5/5 FP; commit tasks (1.8, 2.7, 3.8, 4.6, 5.6) and 4.5 lack Target/Success headings | pass |
| D | pass | pass (13 twins in new `document.rs`) | pass (no change; no explicit diff gate) | pass | pass | pass with note — 6/6 FP; several tasks (2.6, 2.9, 2.11, commit tasks) lack Steps/Success | pass |
| E | pass | pass (13 twins in new `fs_read_document.rs`, snapshot regen script matches `check-module.sh`) | pass (`git diff HEAD~1` gate) | pass | pass | pass with note — 6/6 FP; commit tasks lack Target/Success | pass |

Judgment call: missing Target/Success headings on `git commit` tasks is treated as a C3
deduction, not an H6 failure; the verbatim Failure Protocol and decidable Verify steps
are present everywhere. Failure Protocol occurrences: A 6, B 6, C 5, D 6, E 6 — one per
phase in every candidate.

## Grounding spot-checks (C2)

Verified against the tree (✓ exact or within sibling drift, ✗ wrong):

- **A**: ✓ `src-tauri/src/services/ipc.rs:483` `fs_read_image`; ✓ `fs.rs:7-12` trust contract; ✓ `e2e-tauri/session.ts` `launch` 178 / `awaitBridge` 225 / `collectPageErrors` 465 / `pageErrors` 480 / `until` 430 / `lastExactText` 374 (all exact); ✓ `ipc.ts:104` `cwdFor`, `:241` `resolveWithin`, `:1013` `sniffImageMime`, `:1079` `FS_READ_PDF`; ✓ `services.api.txt` line format (`alloc::rcs::arc::Arc<…>` is really what the snapshot contains); ✓ `scripts/lint-surfaces.mjs` exists; ✓ `global.css:705-713` compact rule uses `width: min(460px, …) !important`, so A's `!important` override is required and correctly placed; ✓ `vite.tauri.config.ts:27-32` spreads `rendererConfig().plugins`, so A's `pdfjsAssets()` reaches both shells. ✗ "`EXPECTED_CHANNEL_COUNT` is 91 when the sibling has landed" — it is **92** (`src-tauri/tests/channels.rs:14`; sibling diff is 90→92); the step instruction "raise by exactly 1 from its value at phase start" is right, the prose number is wrong. ✗ `axis: "row"` in the split test — `SplitAxis` is `"columns" | "rows"` (`tabs.ts:83`); hidden by `as never`. ✗ FilesPanel body "about 214–247" is 227–251 (minor).
- **B**: ✓ `ui.ts:191`, `FilesPanel.tsx:157`, `PanelContainer.tsx:127/130/166`, `output.ts:131` `writeUnique`, `report.ts:229`, `slides.ts:526`, `check-twins.ts:19` `TAURI_ONLY`, `pdf-thumbnail.ts:32-37`, `FilesPanel.tsx:188-189`, `main.omp-workspace-main` (`App.tsx:597`), "Workspace" button text (`panel.title`). ✗ `src/main/ipc.ts:964` for `fs:read-image` (it is 1042). ✗ "91 → 92" (reads current value first, so harmless).
- **C**: ✓ `window.ts:40` (800), `Sidebar.tsx:123` (264), `ipc.ts:125`, `ipc.ts:1042`, `fs-read-pdf.ts:12`, `tauri.conf.json:16`, `tabs.ts:86`, `data-tree-id` (`TreeView.tsx:166`), "Search loaded files by path", `Fakes::default()`, `every_channel_has_one_owner`; ✓ **SHA-256 `8dc73fc3…99fe8` of `xlsx-0.20.3.tgz` verified by download**. ✗ **Task 1.1 gate `grep -c "EXPECTED_CHANNEL_COUNT: usize = 91;"` → 1 fails on the real tree (92), and Task 1.6 hard-codes 92 (should be 93)** — a guaranteed stop at the first task.
- **D**: ✓ `PanelContainer.tsx:25` `TABS`, `en.ts:1273` `panel.tabs.logs`, `voice.ts` `base64ToBytes`, `dangerousDisableAssetCspModification: ["style-src"]`, `build:renderer:tauri`, `check-test-parity services:` success line (`check-test-parity.ts:239`), `mod dialogs;`, `useRuntimeTabId`, `awaitMainWindow`; ✓ "raise by exactly 1 from its current value". ✗ `tabs.ts:129` for `visibleTabIds` (112) minor; attachment call sites "expected InputArea/MessageBubble" correctly marked UNVERIFIED (none exist yet).
- **E**: ✓ `App.tsx:605`, `PanelContainer.tsx:127`, `ipc.ts:733-737` (`shell.openExternal` at 735), `ipc.ts:1005-1010` image comment, `ipc.rs:18` `expand_home` (already `pub(super)`), `ipc.rs:8` `base64::Engine`, `fs.rs:146`, `use-rpc-events.ts:326`, `PanelContainer.test.tsx:28-29,67-68,152,189`, `OfficeFileRenderer.tsx:93-101`, `.test.tsx:67`, `onboarding.e2e.ts:98-102`, `session.ts:28` `BUILD_COMMAND`, `rust-pins.env` vars, snapshot regen command identical to `check-module.sh:103-131`, `@tanstack/react-virtual` in deps, `isEvalSupported` absent from `node_modules/pdfjs-dist/types/src/display/api.d.ts` (true; 0 hits, pdfjs-dist 6.4.299). Note: the sibling's `pdf-thumbnail.ts` already dropped `isEvalSupported` (`:7` comment, `:143`), so E's "removes it" is moot but harmless.

Other facts that matter for all candidates: `<AttachmentCard` has **no non-test call
sites yet** (sibling phase 4 pending); `docx-preview` and `@aiden0z/pptx-renderer` are
not installed (every candidate defers API checks to a grep/type step); the SheetJS CDN
URL returns HTTP 200; `bun run test:e2e:tauri` is `wdio run wdio.conf.ts`, so `-- --spec`
passes through.

## Scores (1–20) and weighted totals

| Criterion (weight) | A | B | C | D | E |
|---|---|---|---|---|---|
| C1 Outcome fit (3) | 18 | 17 | 17 | 18 | 17 |
| C2 Grounding (3) | 18 | 18 | 16 | 17 | 19 |
| C3 Executability (3) | 18 | 18 | 15 | 15 | 16 |
| C4 Security/robustness (2) | 18 | 14 | 18 | 14 | 18 |
| C5 Test design (2) | 19 | 14 | 18 | 17 | 18 |
| C6 Simplicity (2) | 15 | 17 | 14 | 14 | 13 |
| C7 Sibling coordination (1) | 18 | 17 | 15 | 18 | 16 |
| **Weighted total (max 320)** | **284** | **266** | **259** | **258** | **270** |

Rationale in one line each:

- **A** — docks in every layout (split and ≤1000 px with a 50vw rule and sidebar collapse), all formats and entry points, 2 s stat-poll refresh, zip-bomb guard, self-hosted pdf.js data, committed fixtures from the assistant-pack builders, twin e2e in both shells with narrow-window, corrupt-file and on-disk-change tests; most literal task specs (byte constants, exact expected objects, exact verify strings). Costs: routes images through the new command instead of `fs:read-image`, moves `sniffImageMime`, a CSS `!important` override, no manual Reload button.
- **E** — the most precise line references and the best error UX (nine error codes, each localized), conditional `ifChanged` read on `tool_execution_end`, zip budget, virtualized sheets, pixel-level PDF e2e; but keeps the ≤1000 px overlay (packet asked for that case), pushes md/txt through the new byte command (a second text path in `FilesPanel`), and adds more machinery (IntersectionObserver pages, virtualizer).
- **B** — cleanest pure-function layout rules with example tables, strong unit matrix, simplest IPC; but no zip-bomb guard (a 30 s timeout cannot fire on a frozen main thread), Tauri-only e2e (Electron `file://` pdf.js risk unproven), no refresh for hand edits.
- **C** — thoughtful Preview tab, turn-end refresh with stamp dedupe, exact tarball hash, overlay truth table; but its first task's gate is wrong (channel count), it keeps ≤1000 px as overlay when the sidebar is visible, and the `PanelTab` union change ripples into settings and existing tests.
- **D** — complete scope (Preview tab, poll, sidebar hide and restore, both-shell e2e) but compressed task prose (whole components specified in one Target line), no zip-bomb guard, and the same `PanelTab` ripple.

## Winner's material defects for the red-team / validation gate (candidate A)

1. **Channel-count prose is wrong.** `plan.md` D10 and `phase-01` Task 1.5 step 6 say "91 … which makes it 92". `src-tauri/tests/channels.rs:14` is already `92` (sibling diff 90→92). Keep the instruction "raise by exactly 1 from its value at phase start"; delete the numbers so an executor cannot hard-code 92.
2. **Invalid split axis in a test.** `phase-02` Task 2.7 step 1 uses `axis: "row"` cast `as never`; `SplitAxis` is `"columns" | "rows"` (`src/renderer/stores/tabs.ts:83`). Use `"columns"` and drop the cast.
3. **Sidebar collapse is never restored.** `phase-02` Task 2.7 step 2.5 calls `toggleSidebar()` when a preview opens at ≤1000 px but nothing re-opens it on close (`ui.ts:185`; `sidebarVisible` is not persisted, so the damage is per session). Decide: restore on close (D's rule: only if the drawer hid it and it is still hidden) or accept.
4. **Attachment-card call sites do not exist yet.** `phase-05` Task 5.3 step 1 expects exactly `src/renderer/components/chat/MessageBubble.tsx` and `src/renderer/components/layout/InputArea.tsx`; today `grep -rln "<AttachmentCard" src/renderer` returns only the component and its test. The Failure-Protocol stop is correct, but the "Files to Modify" list asserts files that depend on the sibling's phase 4 landing as planned.
5. **Downloaded tarball committed without an integrity check.** `phase-03` Task 3.2 downloads `vendor/xlsx-0.20.3.tgz` and only checks the inner `package.json` version. The real tarball's SHA-256 is `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` (verified 2026-10-07); the gate should require it.
6. **`sniffImageMime` relocation touches the live image path.** `phase-01` Task 1.3 step 2 moves the closure at `src/main/ipc.ts:1013-1038` out of the register function; the `FS_READ_IMAGE` handler at `:1042/:1064` keeps calling it. Validation must run `markdown-image.test.tsx` and the Rust/TS image tests, as A says, and confirm no behavioural diff.
7. **Images duplicated onto the new command.** `plan.md` D2 and `phase-02` Task 2.5 read images via `fs:read-document` (signature `image`) although `fs:read-image` (`ipc.ts:1042`, `ipc.rs:483`) already does sniff + cap + data URL. Not wrong, but a second image path; see fork 4.
8. **Shadow-mount hook spec gap.** `phase-04` Task 4.4 step 1.2 reads `host.clientWidth` inside the `useShadowMount` render callback whose signature is `(mount, root)`; the executor must use `root.host`. Clarify.
9. **pdf.js assets on Electron `file://` are self-declared [UNVERIFIED]** (`plan.md` Risks; `phase-03` Risks). The fixture PDF does not need cMaps, so the e2e cannot detect a broken fetch; add a CJK or non-embedded-font fixture or accept the gap explicitly.
10. **Narrow-window e2e selector is inferred.** `phase-06` Task 6.1 step 5 asserts `!document.querySelector("nav, aside.omp-sidebar")`; `Sidebar.tsx:334` builds its root class with `cx(...)` and there is no `omp-sidebar` class on it as far as grep shows. A tells the executor to grep first — keep that, but the gate should pin the real selector.
11. **Strict `.xls` signature.** `expectedSignature("xls") === "ole"` rejects `.xls` files that are really OOXML/HTML exports (C accepts OLE or ZIP). Minor; see fork 6.
12. **No manual Reload.** A relies solely on the 2 s stat poll; every other candidate offers a Reload button. See fork 1.

## Design forks where a losing candidate chose better (raise as user questions; do not merge)

1. **Refresh strategy.** A/D: 2 s `statOnly` poll while visible (catches WPS hand-edits, costs a stat per 2 s). E: bump on `tool_execution_end` plus a conditional `ifChanged` read (cheap, event-driven, re-renders only when size/mtime moved). C: refresh on turn end (avoids half-written files) plus Reload. B: refresh when a Write/office card for that path finishes, plus Reload. Recommend asking: poll vs event-driven, and whether a Reload button is wanted regardless.
2. **≤1000 px behaviour.** A: dock at 50vw and collapse the sidebar (no restore). D: hide the sidebar and restore it on close, cap chat at 420 px. C: dock only when the sidebar is already hidden, else overlay. B: dock with a 320 px floor (can squeeze chat below 400 px with the sidebar open). E: unchanged overlay. Recommend asking: A's collapse vs D's hide-and-restore vs keep overlay.
3. **Surface.** A/B/E reuse the Files preview mode; C/D add a dedicated **Preview** tab (Files tree stays visible on its own tab; header gains Reload/close; `PanelTab` union change ripples into `SettingsWindow` and existing tests). UX call for the user.
4. **Image transport.** B/C/D/E keep `fs:read-image`; A routes images through `fs:read-document`. The reuse is simpler and avoids moving `sniffImageMime`.
5. **pdf.js cMaps / standard fonts.** A and E self-host (~4 MB, Vite plugin, dev middleware); B/C/D skip them (CJK PDFs without embedded fonts render blank). Product question: is CJK/no-embedded-font fidelity required on SAI OS?
6. **`.xls` container acceptance.** C accepts OLE or ZIP for `.xls`; A requires OLE.
7. **Error messaging.** E enumerates nine error codes with distinct localized messages; A has three generic messages plus "Open in its app". Ask whether specific reasons (not found, outside workspace, content mismatch) should be shown.
8. **Attachment-card entry.** A adds an `onOpen` prop wired at the (future) call sites; B/C/E make the card open the preview itself when it has a `path` (robust to how the sibling wires InputArea/MessageBubble). Ask which the sibling's owner prefers.
9. **Electron e2e.** B marks the spec `TAURI_ONLY`; A/C/D/E run both shells. A's choice is right; noted only because B's omission would hide the Electron `file://` pdf.js risk.

## Assumptions

- The sibling plan lands with `AttachmentCard` rendered from `InputArea.tsx` and `MessageBubble.tsx` as its phase 4 states (medium confidence; A's Task 5.3 stops otherwise).
- `@aiden0z/pptx-renderer` 1.3.0 exposes `PptxViewer.open`, `RECOMMENDED_ZIP_LIMITS`, `lazySlides`, `lazyMedia`, `zipLimits`, `pdfjs`, `destroy` as the research states (medium; not installed; A greps before use).
- H6's task-heading contract is read as applying to substantive tasks; trivial commit tasks missing Target/Success in C/D/E were scored under C3 rather than disqualified (high confidence this is the intended reading; flip to reject C/D/E if the controller wants the literal rule).
- The deciding criteria for the margin note are C3 (executability) and C6 (simplicity), where A and E diverge most; on those A leads by 22 of a 95-point range, so the margin is low.
