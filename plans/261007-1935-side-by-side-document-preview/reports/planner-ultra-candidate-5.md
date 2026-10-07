=== FILE: plan.md ===
---
title: "Side-by-side document preview"
description: "Open a read-only preview of a docx, pptx, xlsx/xls/ods, csv, pdf, image or text file in a docked pane beside the chat, from office cards, Write cards, markdown links, the Files panel and attachment cards."
status: pending
priority: P2
effort: 25h
branch: main
tags: [frontend, renderer, tauri, electron, ipc, preview, office]
blockedBy: [261007-1931-drop-file-attachment-cards]
blocks: []
created: 2026-10-07
---

# Side-by-side document preview

## Outcome

Inside the Sai ATLAS window the user clicks **Preview** on a file and it opens in a
**Preview** tab of the right-hand inspector, docked beside the conversation, which stays
visible and usable. The preview is read-only and covers:

- **Output files**: the office cards (`office_report` → .docx, `office_slides` → .pptx,
  `office_clean` → .xlsx), the file a Write card names, and local files linked in model
  markdown.
- **Input files**: attachment cards in the composer and in the sent user bubble (from the
  blocking attachment-card plan), and files clicked in the Files panel.
- **Formats**: .docx (paged layout), .pptx (slides), .xlsx/.xls/.ods and .csv (one table per
  sheet), .pdf (pages), images, markdown and other text. Everything else (audio, video,
  archives, .doc/.ppt/.odt/.odp/.rtf) shows "Preview isn't available" with **Open externally**.

When the agent finishes a turn the open preview re-reads its file, so an overwritten
report shows its new content.

## Decisions

Each open design question from the evidence packet, resolved:

1. **Surface: a `preview` tab in the existing inspector drawer, which docks beside the chat.**
   The drawer (`src/renderer/components/layout/PanelContainer.tsx:126`) already resizes
   (360–840 px), persists `gui.panelWidth`, and is the place the Files preview and markdown
   links open today (`src/renderer/stores/ui.ts:191`). The drawer becomes an overlay today
   when `compact || split` (`PanelContainer.tsx:129`). The preview tab changes that rule: it
   **docks in split workspaces** and docks at ≤1000 px whenever the left sidebar is hidden.
   With the sidebar visible at ≤1000 px it stays an overlay, because the window minimum is
   800 px (`src/main/window.ts:40`) and 800 − 264 px sidebar (`Sidebar.tsx:123`) − 360 px
   preview leaves 176 px of chat. At 1280–1920 px it is always docked, so the chat stays
   beside it. The rule lives in one pure function, `inspectorOverlays`, used by
   `PanelContainer` and by the compact auto-hide in `App.tsx:289-298`. The Files tab keeps
   its tree; clicking a file opens it in the Preview tab instead of replacing the tree.
   Only one file is previewed at a time.
2. **Byte transport: one new command, `fs:read-document`, and only for binary containers.**
   Text, markdown and CSV keep using `fs:read` (Files-panel behaviour today: 200 KB for text,
   2 MB for CSV through `FS_READ_MAX_BYTES_CAP`, `src/main/ipc.ts:125`). Images keep using
   `fs:read-image` (25 MB, sniffed, `src/main/ipc.ts:1042`). `fs:read-document` returns base64
   bytes plus the sniffed container (`pdf` | `zip` | `ole`), size and mtime. It applies the
   same path policy as `fs:read-image`: relative paths resolve inside the tab's workspace,
   while absolute and `~/` paths are allowed because the bytes only reach a local render and
   `connect-src 'self'` leaves no exfiltration channel. It is tighter than `fs:read-image` in
   two ways. The extension must be one of `pdf docx pptx xlsx xls ods`, and the first bytes
   must match it (`%PDF-`, `PK\x03\x04`, or for .xls the OLE header `D0 CF 11 E0 A1 B1 1A E1`
   or a zip). The size cap is 32 MiB, the same as the sibling plan's `FS_PDF_MAX_BYTES`
   (`src/main/fs-read-pdf.ts:12`). The sibling's `fs:read-pdf` stays as it is for page-1
   thumbnails (absolute paths only). Folding it into `fs:read-document` would change a
   just-landed public contract for no user gain.
3. **Isolation: shadow root plus the existing CSP plus a link guard. No iframe.**
   docx-preview and the pptx renderer build their DOM with `createElement`/`textContent`
   (research report § DOCX/PPTX). Each renders inside an open shadow root (`ShadowFrame`), so
   document CSS cannot reach the app and Tailwind's preflight cannot distort the document.
   docx-preview runs with `renderAltChunks: false` (its only `<iframe srcdoc>` path) and
   `useBase64URL: true` (blob fonts are blocked by `font-src`). The pptx renderer runs with
   `zipLimits: RECOMMENDED_ZIP_LIMITS` and `pdfjs: false`. The CSP is **unchanged**:
   `script-src 'self'` blocks inline handlers and `javascript:` URLs, and `img-src`/
   `connect-src 'self'` blocks beacons. A capture-phase `guardLinks` on every shadow root
   cancels every `<a href>` click and opens only `http(s)` URLs through
   `window.omp.system.openExternal`. The shells already deny navigation and send
   `window.open` http(s) to the browser (`src/main/window.ts:87-93`,
   `src-tauri/src/webview.rs:287-307`), so that is the backstop. Spreadsheets render through
   React (escaped text; SheetJS `cell.h` HTML is never read). PDFs render to `<canvas>` only:
   no text or annotation layer, `useWasm: false`, `enableXfa: false`, scripting off.
4. **Entry points**: Office card **Preview** button; Write card **Preview** icon; markdown
   local-file links (already call `openFilePreview`, `src/renderer/lib/markdown.tsx:185`);
   Files panel file click; attachment cards (composer and sent user bubble) open the preview
   when clicked. All of them call the single `useUiStore.getState().openFilePreview(path)`.
5. **Large, unsupported or corrupt files**: there are hard caps before parsing (32 MiB bytes,
   and for zip containers a central-directory budget of 4000 entries and 256 MiB declared
   uncompressed size, `checkZipBudget`). There is partial rendering after parsing: PDF first
   50 pages, sheets first 1000 rows × 50 columns per sheet with a "Showing N of M" note, pptx
   windowed lazy slides. Errors show one fallback panel (too large / couldn't be shown /
   unsupported) with **Open externally**. No mammoth and no home-made pptx extractor (see
   Unresolved questions 3).
6. **Staleness**: the preview re-reads when (a) the focused session's `isStreaming` goes from
   true to false (turn end), (b) `openFilePreview` is called again for the same path
   (`filePreviewRevision` bump), or (c) the user presses **Reload**. A binary re-read whose
   `size:mtimeMs` stamp is unchanged keeps the current render (no flicker), and so does a
   text re-read with the same content.
7. **Libraries** (research report recommendations, pinned exactly): `pdfjs-dist` 6.4.299
   (already added by the sibling plan), `docx-preview` 0.4.1, `@aiden0z/pptx-renderer` 1.3.0,
   SheetJS CE 0.20.3 vendored as `vendor/xlsx-0.20.3.tgz` (sha256
   `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`, checked 2026-10-07).
   SheetJS reads .xls and .ods, which exceljs cannot. Each library is dynamic-imported and
   gets a named chunk in `VENDOR_CHUNK_RULES` plus an entry in `LAZY_CHUNKS`.
8. **Coordination with `plans/261007-1931-drop-file-attachment-cards`**: this plan is
   **blocked by it** (frontmatter `blockedBy`). That plan is being implemented right now in
   this working tree (uncommitted edits to `ipc-types.ts`, `create-omp-api.ts`, `ipc.ts`,
   `ipc.rs`, `mod.rs`, `channels.rs`, `package.json`, locales). Running both at once would put
   two writers on the same seven files. Phase 1 Task 1.1 is a mechanical gate that STOPs
   unless that plan is committed. After it lands, this plan reuses its `pdfjs-dist`
   dependency and its `fileKindOf`, and adds `onOpen` behaviour to its `AttachmentCard`. It
   also moves its private `loadPdfJs`/`decodeBase64` (`src/renderer/lib/pdf-thumbnail.ts`)
   into shared `src/renderer/lib/pdfjs.ts` and `src/renderer/lib/base64.ts`, so thumbnails
   and previews share one pdf.js loader and one worker. If that plan is cancelled instead,
   this plan must not be started as written. The user then chooses between (a) adding
   `pdfjs-dist` here and dropping the attachment-card entry point, or (b) reviving the
   sibling plan (Unresolved question 8).

## Constraints

- No LibreOffice or other run-time converter; everything renders in the renderer with JS
  (`plans/reports/research-261005-1338-how-claude-creates-office-files.md` lines 192, 205).
- Both shells: the new command has types (`src/shared/ipc-types.ts`), bridge
  (`src/shared/bridge/create-omp-api.ts`), Electron handler (`src/main/ipc.ts`), Rust handler
  (`src-tauri/src/services/ipc.rs`) registered twice in `src-tauri/src/services/mod.rs`
  (scope table and `reg.register`), Rust tests with TS twins (`services.parity.json`), the
  channel count in `src-tauri/tests/channels.rs`, and the API snapshot
  `src-tauri/contracts/services.api.txt`.
- CSP unchanged in `src/renderer/index.html`, `src/renderer/quick-entry.html` and
  `src-tauri/tauri.conf.json:16`; no `'wasm-unsafe-eval'`, no CDN.
- Heavy libraries are dynamic-imported and listed in `LAZY_CHUNKS`
  (`scripts/check-renderer-chunks.ts:14`).
- Every string through `useT()`, keys added to both `src/renderer/locales/en.ts` and `vi.ts`.
- Tests: vitest with the linkedom harness. Stores are reset with `setState`/`reset()`, never
  `mock.module()`. Heavy libraries never load in linkedom component tests: views are injected.
- Test names, comments and commits carry no plan or phase IDs; conventional commits in this
  repo only.
- `cargo` means `~/.cargo/bin/cargo` (`/usr/bin/cargo` shadows it, `scripts/rust-pins.env`).

## Non-goals

- Editing, annotating, converting or saving documents.
- Previews for audio, video, archives and legacy .doc/.ppt/.odt/.odp/.rtf (they get
  "Open externally").
- More than one previewed file at a time (no preview tabs).
- PDF text selection, search, PDF links; slide animations; spreadsheet cell styling, charts
  and merged-cell layout (values only).
- Changing `fs:read-pdf`, `fs:read-image` or `fs:read`.

## Phases

| # | Phase | Owns (files) | Depends on | Effort | Status |
|---|---|---|---|---|---|
| 1 | [Read-document IPC in both shells](phase-01-read-document-ipc.md) | `src/main/fs-read-document*.ts`, `src/main/ipc.ts`, `src/shared/ipc-types.ts`, `src/shared/bridge/create-omp-api*.ts`, `src-tauri/src/services/{read_document.rs,ipc.rs,mod.rs}`, `src-tauri/contracts/services.*`, `src-tauri/tests/channels.rs` | sibling plan landed | 4h | pending |
| 2 | [Preview pane, text and image](phase-02-preview-pane-text-and-image.md) | `stores/ui.ts` (+tests), `PanelContainer.tsx` (+test), `inspector-layout.ts`, `FilesPanel.tsx`, `App.tsx`, `styles/global.css`, `components/preview/{DocumentPreview,preview-kind,preview-views,zip-budget}*`, `lib/base64*`, locales | 1 | 6h | pending |
| 3 | [PDF and spreadsheet views](phase-03-pdf-and-spreadsheet-views.md) | `vendor/xlsx-0.20.3.tgz`, `package.json`, `bun.lock`, `lib/pdfjs*`, `lib/pdf-thumbnail.ts`, `components/preview/{PdfView,SheetView,sheet-model}*`, `preview-views.ts`, `vite.renderer.shared.ts`, `scripts/check-renderer-chunks.ts`, `e2e/preview-fixtures.ts`, `e2e/document-preview.e2e.ts`, `e2e-tauri/document-preview.e2e.ts`, locales | 2 | 6h | pending |
| 4 | [DOCX and PPTX views](phase-04-docx-and-pptx-views.md) | `package.json`, `bun.lock`, `components/preview/{ShadowFrame,DocxView,PptxView,link-guard,office-options}*`, `preview-views.ts`, `vite.renderer.shared.ts`, `scripts/check-renderer-chunks.ts`, both e2e specs, `e2e/preview-fixtures.ts` | 3 | 5h | pending |
| 5 | [Entry points and release gate](phase-05-entry-points-and-release-gate.md) | `OfficeFileRenderer.tsx` (+test), `WriteRenderer.tsx` (+test), `attachments/AttachmentCard.tsx` (+test), locales, `CHANGELOG.md` | 4 | 4h | pending |

The phases run strictly in order. Phases 3 and 4 both edit `vite.renderer.shared.ts`,
`scripts/check-renderer-chunks.ts`, `package.json`, `preview-views.ts` and the e2e specs, so
they must not run in parallel.

## Shared contracts

```ts
// src/shared/ipc-types.ts (phase 1)
IPC_COMMANDS.FS_READ_DOCUMENT = "fs:read-document"
export type IpcDocumentContainer = "pdf" | "zip" | "ole";
export interface IpcFsReadDocumentPayload { path: string; tabId?: string }
export interface IpcFsReadDocumentResult {
  ok: boolean;
  data?: string;                    // whole file, base64
  container?: IpcDocumentContainer; // sniffed from the first bytes
  size: number;                     // bytes; 0 when unknown
  mtimeMs?: number;                 // integer ms since epoch
  error?: string;                   // exact strings listed in phase 1
}
// OmpApi.fs
readDocument(path: string, tabId?: string): Promise<IpcFsReadDocumentResult>;

// src/renderer/stores/ui.ts (phase 2)
export type PanelTab = "files" | "logs" | "preview";
filePreviewRevision: number;
openFilePreview(path): sets { filePreviewPath: path, filePreviewRevision: +1, panelTab: "preview", panelVisible: true }
closeFilePreview(): sets { filePreviewPath: null, panelTab: panelTab === "preview" ? "files" : panelTab }
reloadFilePreview(): sets { filePreviewRevision: +1 }
panelTabFromPref("preview") === null   // never restored from prefs

// src/renderer/components/layout/inspector-layout.ts (phase 2)
export function inspectorOverlays(s: { tab: PanelTab; compact: boolean; split: boolean; sidebarVisible: boolean }): boolean;

// src/renderer/components/preview/preview-kind.ts (phase 2)
export type PreviewKind = "markdown" | "text" | "image" | "csv" | "pdf" | "sheet" | "docx" | "pptx" | "unsupported";
export function previewKindOf(path: string): PreviewKind;

// src/renderer/components/preview/preview-views.ts (phase 2 creates, 3 and 4 fill)
export type PreviewViewKind = "pdf" | "sheet" | "docx" | "pptx";
export interface DocumentViewProps {
  data: Uint8Array | string;        // string only for CSV text
  onRendered(info: { shown: number; total: number }): void;
  onFailed(error: unknown): void;
}
export type PreviewViews = Partial<Record<PreviewViewKind, ComponentType<DocumentViewProps>>>;
export const PREVIEW_VIEWS: PreviewViews;   // React.lazy(() => import("./PdfView")) etc.

// DOM contract used by tests and e2e (phase 2)
// [data-preview-kind=<PreviewKind>][data-preview-state="loading"|"rendering"|"ready"|"failed"]
// with data-preview-shown / data-preview-total once ready.
```

## Acceptance criteria

1. At a 1440×900 window with a split workspace, clicking **Preview** on an office card
   docks the preview to the right. The `<aside class="omp-inspector">` has no `absolute`
   class, and both session panes keep their composers usable (Phase 2 test plus Phase 5
   manual check).
2. In both e2e specs (Tauri on WebKitGTK, Electron), previews of a .docx and a .pptx built
   by `buildReport`/`buildSlides` from `assistant-pack/test/fixtures/notes-en.md`, an exceljs
   .xlsx, a .csv with Vietnamese text, a one-page PDF and a PNG reach
   `data-preview-state="ready"`. No `securitypolicyviolation` event fires during the run.
3. A .zip renamed to .docx, a 33 MiB .pdf and an .mp3 each show the fallback panel with
   **Open externally**, and nothing throws (unit tests).
4. After the agent's turn ends, an open preview whose file changed on disk shows the new
   content without user action (unit test with `isStreaming` true → false).
5. Office card, Write card, markdown link, Files panel click and attachment card all set
   `filePreviewPath` and `panelTab: "preview"` (unit tests).
6. `bun run build` passes and prints `index.html entry is lean`; `LAZY_CHUNKS` contains
   `pdfjs`, `sheetjs`, `jszip`, `docx`, `pptx`.
7. `bunx vitest run`, `bun run check:types`, biome on touched files, clippy, `cargo test`,
   test parity (`services`) and API snapshots all exit 0.

## Risks

| Risk | L × I | Mitigation |
|---|---|---|
| Sibling plan not landed / partially landed when work starts | High × High | Phase 1 Task 1.1 gate STOPs; `blockedBy` in frontmatter |
| pdf.js modern build needs a newer WebKitGTK than SAI OS ships | Med × High | Same build the sibling thumbnails use; e2e on the dev host's WebKitGTK; Unresolved question 6 (legacy build swap is a one-line import change in `lib/pdfjs.ts`) |
| Zip bombs in docx/xlsx (docx-preview, JSZip, SheetJS have no limits) | Med × Med | `checkZipBudget` before any parser; aiden0z's own `RECOMMENDED_ZIP_LIMITS`; 32 MiB byte cap in both shells |
| Document links navigating the webview | Low × High | `guardLinks` (capture phase) + existing navigation locks in both shells |
| pptx renderer (single maintainer) breaks on a file | Med × Low | `onFailed` → fallback panel with Open externally; exact version pin |
| Embedded pptx fonts registered in `document.fonts` shadow an app font name | Low × Low | App fonts are `@fontsource` families; accepted and noted |
| 32 MiB base64 over IPC stalls the renderer | Low × Med | Cap; one read per open/turn end; mtime stamp skips re-render |
| Docking the preview in split mode squeezes two panes | Med × Low | Panes keep `min-w-0`; drawer min 360 px, user can resize; only the preview tab docks |

## Validation commands

```bash
bunx vitest run
bun run check:types
bunx biome check <touched files>
~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --all-features
bun scripts/check-test-parity.ts services
bash scripts/check-module.sh snapshots
bun run build
scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts
scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts
```

## Unresolved questions

Each has a chosen default; the plan proceeds with the default unless the user says otherwise.

1. ≤1000 px window with the sidebar visible: the preview stays an overlay (default). The
   alternative is auto-hiding the sidebar when a preview opens there.
2. SheetJS is vendored as a 2.4 MB tarball under `vendor/` (default, as the research
   recommends; npm's `xlsx` is stuck at vulnerable 0.18.5). Is a vendored tarball acceptable
   under repo policy? The fallback is exceljs, which is already a devDependency but cannot
   read .xls or .ods.
3. No mammoth (DOCX) and no home-made JSZip slide extractor (PPTX) fallback (default, KISS).
   A file either renderer cannot show goes to "Open externally". Add them only if real files
   fail often.
4. PDF CMaps and standard-font data are not bundled (default). pdf.js falls back to system
   fonts for non-embedded fonts. PDFs that rely on predefined CJK CMaps would show blank
   glyphs, which is rare for Vietnamese and English users. Bundling them costs about 4 MB.
5. Caps: 32 MiB file, 50 PDF pages, 1000 rows × 50 columns per sheet, zip 4000 entries /
   256 MiB. Are these right for SAI OS machines?
6. pdf.js modern versus legacy build depends on SAI OS's WebKitGTK version (unknown). The
   default is modern, matching the sibling thumbnails.
7. Refresh on turn end (default) versus after each tool call. Turn end is simpler and avoids
   re-reading half-written files.
8. If the attachment-card plan is cancelled rather than landed: add `pdfjs-dist` here and
   drop the attachment entry point, or revive that plan?

=== FILE: phase-01-read-document-ipc.md ===
---
phase: 1
title: "Read-document IPC in both shells"
status: pending
priority: P1
effort: "4h"
dependencies: []
---
# Phase 1: Read-document IPC in both shells

## Goal

Add `fs:read-document`, which returns the bytes of a pdf/docx/pptx/xlsx/xls/ods file as
base64 with its sniffed container, size and mtime, behind the same path policy as
`fs:read-image`. It must work identically in Electron and Tauri, with TS tests that have
Rust twins, an updated channel count and an updated API snapshot. Nothing in the UI calls it
yet.

## Files to Create / Modify

Create:
- `src/main/fs-read-document.ts` — pure reader `readDocumentFile` (Electron side)
- `src/main/fs-read-document.test.ts`
- `src-tauri/src/services/read_document.rs` — pure reader `read_document_file` + `#[cfg(test)] mod tests`

Modify:
- `src/shared/ipc-types.ts` — `IPC_COMMANDS.FS_READ_DOCUMENT` (after `FS_READ_PDF`), `IpcDocumentContainer`, `IpcFsReadDocumentPayload`, `IpcFsReadDocumentResult`, `OmpApi.fs.readDocument`
- `src/shared/bridge/create-omp-api.ts` — `fs.readDocument` (after `readPdf`, ~line 365)
- `src/shared/bridge/create-omp-api.test.ts` — one new case
- `src/main/ipc.ts` — handler after the `FS_READ_PDF` handler (~line 1074)
- `src-tauri/src/services/ipc.rs` — `pub fn fs_read_document` after `fs_read_pdf` (~line 529); `expand_home_in` becomes `pub(super)`; dispatch test in `mod tests`
- `src-tauri/src/services/mod.rs` — `mod read_document;`, scope-table row after `("fs:read-pdf", Scope::Main)` (~line 58), `reg.register` after line 91
- `src-tauri/contracts/services.parity.json` — one entry
- `src-tauri/contracts/services.api.txt` — one line
- `src-tauri/tests/channels.rs` — `EXPECTED_CHANNEL_COUNT` 91 → 92

## Test Matrix (TDD)

The TS test names and Rust fn names are twins: the Rust names are the normalized TS names
(`scripts/check-test-parity.ts` `normalizeTestName`). Every name includes "document" so it
can never collide with the `fs-read-pdf` twins in `ipc.rs`.

| # | TS `it(...)` in `src/main/fs-read-document.test.ts` | Rust fn in `read_document.rs` | Red (before code) | Green |
|---|---|---|---|---|
| 1 | returns a docx document as base64 with its container size and mtime | `returns_a_docx_document_as_base64_with_its_container_size_and_mtime` | import / unresolved fn fails | `{ok:true,data,container:"zip",size}` + `mtimeMs` integer > 0 |
| 2 | returns a pdf document with the pdf container | `returns_a_pdf_document_with_the_pdf_container` | fails | `container:"pdf"` |
| 3 | accepts a legacy xls document in either container | `accepts_a_legacy_xls_document_in_either_container` | fails | OLE bytes → `"ole"`, zip bytes → `"zip"` |
| 4 | matches the document extension case-insensitively | `matches_the_document_extension_case_insensitively` | fails | `REPORT.DOCX` → ok |
| 5 | expands a home-relative document path | `expands_a_home_relative_document_path` | fails | ok with `homeDir`/`home` override |
| 6 | rejects a relative document path | `rejects_a_relative_document_path` | fails | `{ok:false,size:0,error:"Path must be absolute"}` |
| 7 | rejects a missing or empty document path | `rejects_a_missing_or_empty_document_path` | fails | `{ok:false,size:0,error:"Invalid path"}` |
| 8 | rejects a document extension the preview does not render | `rejects_a_document_extension_the_preview_does_not_render` | fails | `.txt` → `{ok:false,size:0,error:"Unsupported document type"}` |
| 9 | rejects document content that does not match its extension | `rejects_document_content_that_does_not_match_its_extension` | fails | `.docx` with `%PDF-` bytes → `{ok:false,size:<n>,error:"Content does not match the file type"}`, no `data` |
| 10 | rejects a document over the size cap | `rejects_a_document_over_the_size_cap` | fails | `{ok:false,size:<n>,error:"File too large"}` |
| 11 | rejects a document directory and a missing document | `rejects_a_document_directory_and_a_missing_document` | fails | dir → `{ok:false,size:0,error:"Not a file"}`; missing → ok false, non-empty error |

Extra checks (no twin needed):
- `create-omp-api.test.ts`: "reads a document over its own channel with the tab id". Red:
  `api.fs.readDocument` is not a function. Green: invokes
  `[{ channel: IPC_COMMANDS.FS_READ_DOCUMENT, args: [{ path: "docs/a.docx", tabId: "t1" }] }]`.
- `ipc.rs` `mod tests`: `dispatches_fs_read_document_without_a_workspace`. Red: channel not
  registered. Green: the reply equals `{"ok": false, "size": 0, "error": "No workspace"}` for
  `{"path": "notes/a.docx"}` with `Fakes::default()`.
- `src-tauri/tests/channels.rs`: `every_channel_has_one_owner` stays green after the count
  bump.

## Tasks

### Task 1.1 — Gate: the attachment-card plan has landed and the tree is clean
- **Goal**: never share files with the sibling plan's in-flight edits.
- **Target files and symbols**: `src/main/fs-read-pdf.ts`, `src/renderer/components/attachments/AttachmentCard.tsx`, `src/renderer/components/chat/MessageBubble.tsx`, `src-tauri/tests/channels.rs` (`EXPECTED_CHANNEL_COUNT`).
- **Steps**: run the four Verify commands from the repo root `/home/tung491/WORK/oh-my-pi-gui`. Change nothing.
- **Success criteria**: all four outputs match.
- **Verify**:
  - `git log --oneline -1 -- src/main/fs-read-pdf.ts | wc -l` → `1`
  - `grep -c "AttachmentCard" src/renderer/components/chat/MessageBubble.tsx` → a number ≥ `1`
  - `git status --porcelain -- src src-tauri e2e e2e-tauri package.json bun.lock | wc -l` → `0`
  - `grep -c "EXPECTED_CHANNEL_COUNT: usize = 91;" src-tauri/tests/channels.rs` → `1`

### Task 1.2 — Write the failing TS tests (red)
- **Goal**: pin the reader's contract before it exists.
- **Target files and symbols**: create `src/main/fs-read-document.test.ts`; append one `it` to `src/shared/bridge/create-omp-api.test.ts`.
- **Steps**:
  1. Copy the harness of `src/main/fs-read-pdf.test.ts` (tmp dir per test with
     `mkdtempSync`, `rmSync` in `afterEach`). Import
     `{ readDocumentFile, FS_DOCUMENT_MAX_BYTES } from "./fs-read-document"`.
  2. Constants: `ZIP = Buffer.from([0x50,0x4b,0x03,0x04,0x14,0,0,0])`,
     `OLE = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0,0])`,
     `PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "latin1")`.
  3. Write the 11 cases of the matrix with exactly those names. For #1, assert
     `result.ok === true`, `result.data === ZIP.toString("base64")`,
     `result.container === "zip"`, `result.size === ZIP.length`, and
     `Number.isInteger(result.mtimeMs) && (result.mtimeMs ?? 0) > 0`. For #10 pass
     `{ maxBytes: ZIP.length - 1 }` and expect
     `{ ok: false, size: ZIP.length, error: "File too large" }`. For #5 pass
     `{ homeDir: dir }` with `"~/Documents/a b.xlsx"`.
  4. In `create-omp-api.test.ts`, add "reads a document over its own channel with the tab id"
     using the existing `fakePort` helper, exactly like the `readPdf` case added by the
     sibling plan.
- **Success criteria**: both files fail for the missing module/member only.
- **Verify**: `bunx vitest run src/main/fs-read-document.test.ts src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` → last line `exit=1`.

### Task 1.3 — Implement the TS reader, contract and bridge (green)
- **Goal**: make Task 1.2 green.
- **Target files and symbols**: `src/main/fs-read-document.ts` (`readDocumentFile`, `FS_DOCUMENT_MAX_BYTES`, `ReadDocumentOptions`); `src/shared/ipc-types.ts`; `src/shared/bridge/create-omp-api.ts`.
- **Steps**:
  1. In `ipc-types.ts`, add `FS_READ_DOCUMENT: "fs:read-document"` with the doc comment
     `/** Read a pdf/docx/pptx/xlsx/xls/ods file as base64 for the in-app preview (container sniff, size cap) */`
     directly after `FS_READ_PDF`. Add the three types from plan.md "Shared contracts" after
     `IpcFsReadPdfResult`, and `readDocument(path: string, tabId?: string): Promise<IpcFsReadDocumentResult>;`
     after `readPdf` in `OmpApi.fs`.
  2. In `create-omp-api.ts`, add `readDocument: (path: string, tabId?: string) => port.invoke(IPC_COMMANDS.FS_READ_DOCUMENT, { path, tabId }) as Promise<IpcFsReadDocumentResult>,`
     after `readPdf`, and import the type.
  3. `fs-read-document.ts`, modelled on `fs-read-pdf.ts`:
     `export const FS_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;`
     `const CONTAINERS: Record<string, readonly IpcDocumentContainer[]> = { pdf: ["pdf"], docx: ["zip"], pptx: ["zip"], xlsx: ["zip"], ods: ["zip"], xls: ["ole", "zip"] };`.
     Run the checks in this order:
     - not a non-empty string → `Invalid path`;
     - expand `~/` against `options.homeDir ?? os.homedir()`;
     - not absolute → `Path must be absolute`;
     - lowercased extension (`path.extname(abs).slice(1).toLowerCase()`) not in
       `CONTAINERS` → `Unsupported document type`;
     - `fsp.stat`; not a file → `Not a file`;
     - `stat.size > maxBytes` → `File too large` with `size: stat.size`;
     - `fsp.readFile`;
     - sniff with `%PDF-` → `"pdf"`, `50 4B 03 04` → `"zip"`, `D0 CF 11 E0 A1 B1 1A E1` →
       `"ole"`, else null;
     - null or not in `CONTAINERS[ext]` → `Content does not match the file type` with
       `size: bytes.length`;
     - success → `{ ok: true, data: bytes.toString("base64"), container, size: bytes.length, mtimeMs: Math.floor(stat.mtimeMs) }`.
     Any thrown error → `{ ok: false, size: 0, error: message }`. The function never throws.
- **Success criteria**: Task 1.2 green; types compile.
- **Verify**: `bunx vitest run src/main/fs-read-document.test.ts src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` → `exit=0`; `bun run check:types; echo "exit=$?"` → `exit=0`.

### Task 1.4 — Electron handler
- **Goal**: expose the reader on `fs:read-document` with workspace resolution for relative paths.
- **Target files and symbols**: `src/main/ipc.ts`, after the `IPC_COMMANDS.FS_READ_PDF` handler; reuse `cwdFor` (`ipc.ts:104`) and `resolveWithin` (`ipc.ts:241`).
- **Steps**: import `readDocumentFile` and `IpcFsReadDocumentPayload`. Add:
  `ipcMain.handle(IPC_COMMANDS.FS_READ_DOCUMENT, (event, payload: IpcFsReadDocumentPayload | undefined) => {`.
  - `raw = typeof payload?.path === "string" ? payload.path : ""`.
  - If `raw === "" || raw.startsWith("~/") || path.isAbsolute(raw)`, return
    `readDocumentFile(raw)`.
  - Else `cwd = cwdFor(deps, event, payload?.tabId)`; when it is null return
    `{ ok: false, size: 0, error: "No workspace" }`.
  - Then `within = resolveWithin(cwd, raw)`; when it is null return
    `{ ok: false, size: 0, error: "Path escapes the workspace" }`.
  - Otherwise return `readDocumentFile(within)`.
  - Add a two-line comment above the handler giving the same rationale as the
    `fs:read-image` comment.
- **Success criteria**: types and biome clean.
- **Verify**: `bun run check:types; echo "exit=$?"` → `exit=0`; `bunx biome check src/main/ipc.ts src/main/fs-read-document.ts src/main/fs-read-document.test.ts src/shared/ipc-types.ts src/shared/bridge/create-omp-api.ts src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` → `exit=0`.

### Task 1.5 — Rust twins first (red)
- **Goal**: the Rust side's tests exist before its code.
- **Target files and symbols**: create `src-tauri/src/services/read_document.rs` holding only the test module plus `pub(super) fn read_document_file(path: &str, home: Option<&Path>, max_bytes: u64) -> Value { unimplemented!() }` and `pub(super) const FS_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;`; `src-tauri/src/services/mod.rs` (`mod read_document;` in the alphabetic `mod` list, after `mod provider_cleanup;`); `src-tauri/contracts/services.parity.json`.
- **Steps**:
  1. Write the 11 `#[test]` fns named in the matrix, mirroring the `read_pdf` tests in
     `ipc.rs:720-792` (`tempfile::tempdir()`, base64 helper, `json!` equality). For #1
     assert `result["mtimeMs"].as_u64().is_some_and(|ms| ms > 0)` and compare the other
     keys individually.
  2. Append `{ "ts": "src/main/fs-read-document.test.ts", "rust": "src-tauri/src/services/read_document.rs" }`
     to `services.parity.json`.
- **Success criteria**: tests compile and panic on `unimplemented!`.
- **Verify**: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --all-features read_document; echo "exit=$?"` → `exit=101`.

### Task 1.6 — Rust reader, handler and registration (green)
- **Goal**: make Task 1.5 green and serve the channel.
- **Target files and symbols**: `read_document.rs` (`read_document_file`); `ipc.rs` (`expand_home_in` → `pub(super) fn`, new `pub fn fs_read_document(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply`); `mod.rs`; `src-tauri/tests/channels.rs`.
- **Steps**:
  1. `read_document_file`: same order and exact error strings as Task 1.3, using
     `super::ipc::expand_home_in`, `std::fs::metadata`, `std::fs::read`, and
     `metadata.modified()` → `duration_since(UNIX_EPOCH)` → `as_millis() as u64` for
     `mtimeMs`. Use the same container table.
  2. `fs_read_document`:
     - read `path` (default `""`);
     - if the path is empty, starts with `~/` or `Path::new(&path).is_absolute()`, reply
       `read_document_file(&path, dirs::home_dir().as_deref(), read_document::FS_DOCUMENT_MAX_BYTES)`;
     - else resolve with `ctx.tabs.cwd_for(caller, tab_id)` + `workspace_fs::resolve_within`
       exactly as `fs_read_image` does (`ipc.rs:491-499`), replying
       `{"ok": false, "size": 0, "error": "No workspace"}` /
       `"Path escapes the workspace"` on failure;
     - wrap the result in `Reply::ok(...)`;
     - add a doc comment like `fs_read_image`'s.
  3. In `mod.rs`, add `("fs:read-document", Scope::Main),` after `("fs:read-pdf", Scope::Main),`
     and `reg.register("fs:read-document", Scope::Main, ipc::fs_read_document);` after the
     `fs:read-pdf` registration.
  4. In `ipc.rs` `mod tests`, add `dispatches_fs_read_document_without_a_workspace` next to
     `dispatches_fs_read_pdf_without_throwing`.
  5. `channels.rs`: `EXPECTED_CHANNEL_COUNT: usize = 92;`.
- **Success criteria**: all Rust tests, clippy and parity green.
- **Verify**:
  - `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --all-features; echo "exit=$?"` → `exit=0`
  - `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings; echo "exit=$?"` → `exit=0`
  - `bun scripts/check-test-parity.ts services; echo "exit=$?"` → `exit=0`

### Task 1.7 — API snapshot
- **Goal**: freeze the new public handler in `services.api.txt`.
- **Target files and symbols**: `src-tauri/contracts/services.api.txt`.
- **Steps**:
  1. Run `bash scripts/check-module.sh snapshots`. It fails and prints a unified diff whose
     only `+` line is
     `+pub fn sai_atlas_lib::services::ipc::fs_read_document(&alloc::rcs::arc::Arc<sai_atlas_lib::ctx::AppCtx>, sai_atlas_lib::ports::Caller, alloc::vec::Vec<serde_json::value::Value>) -> sai_atlas_lib::bridge::Reply`.
  2. Insert that line (without the `+`) into `services.api.txt` at the position the diff
     shows.
  3. If the diff shows any other `+` or `-` line, that is a failure: follow the Failure
     Protocol.
- **Success criteria**: snapshot gate passes.
- **Verify**: `bash scripts/check-module.sh snapshots 2>&1 | tail -1` → `check-module snapshots: PASS`.

### Task 1.8 — Commit
- **Goal**: one focused commit.
- **Steps**: `git add` the files listed under "Files to Create / Modify";
  `git commit -m "feat(ipc): read office and PDF documents for the in-app preview"`.
- **Verify**: `git status --porcelain -- src src-tauri | wc -l` → `0`.

## Verification

All must hold at the end of the phase:
- `bunx vitest run src/main src/shared; echo "exit=$?"` → `exit=0`
- `bun run check:types; echo "exit=$?"` → `exit=0`
- `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --all-features; echo "exit=$?"` → `exit=0`
- `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings; echo "exit=$?"` → `exit=0`
- `bun scripts/check-test-parity.ts services; echo "exit=$?"` → `exit=0`
- `bash scripts/check-module.sh snapshots 2>&1 | tail -1` → `check-module snapshots: PASS`
- `grep -c '"fs:read-document"' src-tauri/src/services/mod.rs` → `2`

## Risks & Rollback

- **Risk (Med × Low)**: `pub(super)` on `expand_home_in` is not visible from a sibling
  module. `read_document` is a child of `services`, and `ipc` is `pub mod ipc` inside
  `services`, so `super::ipc::expand_home_in` resolves. If the compiler disagrees, that is a
  Failure Protocol stop; do not move the reader into `ipc.rs` on your own.
- **Risk (Low × Med)**: the channel count already differs from 91 (another plan added a
  channel). Task 1.1 catches it.
- **Rollback**: `git revert <phase commit>`. Nothing calls `readDocument` until Phase 2, so
  the revert is self-contained.

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

=== FILE: phase-02-preview-pane-text-and-image.md ===
---
phase: 2
title: "Preview pane, text and image"
status: pending
priority: P1
effort: "6h"
dependencies: [1]
---
# Phase 2: Preview pane, text and image

## Goal

Add a **Preview** tab to the inspector that docks beside the chat (also in split
workspaces), and the `DocumentPreview` component: header, read/reload/staleness logic, the
fallback panel, and the text, markdown and image renderers moved out of `FilesPanel`. The
heavy formats (pdf, sheet, docx, pptx) are wired through an injectable view registry that
is empty after this phase; Phases 3 and 4 fill it. Clicking a file in the Files panel and a
local markdown link now open the Preview tab.

## Files to Create / Modify

Create:
- `src/renderer/components/layout/inspector-layout.ts`, `inspector-layout.test.ts`
- `src/renderer/components/preview/preview-kind.ts`, `preview-kind.test.ts`
- `src/renderer/components/preview/zip-budget.ts`, `zip-budget.test.ts`
- `src/renderer/components/preview/preview-views.ts` (types + `PREVIEW_VIEWS = {}`)
- `src/renderer/components/preview/DocumentPreview.tsx`, `DocumentPreview.test.tsx`
- `src/renderer/lib/base64.ts`, `base64.test.ts`

Modify:
- `src/renderer/stores/ui.ts` (`PanelTab`, `filePreviewRevision`, `openFilePreview`, `closeFilePreview`, `reloadFilePreview`), `src/renderer/stores/ui.test.ts`
- `src/renderer/components/layout/PanelContainer.tsx`, `PanelContainer.test.tsx`
- `src/renderer/components/panels/FilesPanel.tsx` (remove the in-tab preview branch)
- `src/renderer/App.tsx` (compact auto-hide, lines 289-298)
- `src/renderer/styles/global.css` (media rule at line 705)
- `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `openFilePreview` selects `preview`, opens the drawer, bumps the revision | `stores/ui.test.ts` | `panelTab` is `"files"` | `"preview"`, revision +1 |
| `closeFilePreview` returns from `preview` to `files`, keeps `logs` | `stores/ui.test.ts` | stays `preview` | `files` / `logs` |
| `reloadFilePreview` bumps only the revision | `stores/ui.test.ts` | not a function | +1 |
| `panelTabFromPref("preview")` is null | `stores/ui.test.ts` | — (passes today; guard) | null |
| overlay rule table (8 rows, see Task 2.2) | `inspector-layout.test.ts` | module missing | all rows |
| extension → kind (md, mdx, txt, sql, csv, pdf, xlsx, xls, ods, docx, pptx, png, mp3, zip, doc, ppt, no extension) | `preview-kind.test.ts` | module missing | table |
| zip budget: accepts small; too many entries; over size; not a zip; truncated | `zip-budget.test.ts` | module missing | reasons match |
| base64 → bytes (`"JVBERi0="` → `[37,80,68,70,45]`) | `base64.test.ts` | module missing | equal |
| markdown renders sanitized (`h1` "Title"), state `ready` | `DocumentPreview.test.tsx` | module missing | as stated |
| other text in `<pre>` with truncation note | same | missing | `filesPanel.truncated` text present |
| binary text read shows `filesPanel.binary` | same | missing | text present |
| image shows `<img src=dataUrl>` via `fs.readImage` | same | missing | `src` equals stub dataUrl |
| docx bytes reach the injected docx view as `Uint8Array` | same | missing | stub received length 8 |
| a `.docx` whose bytes are not a zip in budget → `preview.renderFailed` + Open externally | same | missing | text present, `data-preview-state="failed"` |
| `File too large` → `preview.tooLarge` with MB numbers | same | missing | contains `40` and `32` |
| `.mp3` → `preview.unsupported`, no read calls | same | missing | both reads 0 calls |
| no registered view for a kind → `preview.unsupported` | same | missing | text present |
| turn end (`isStreaming` true→false) re-reads | same | missing | `read` called twice |
| same path opened again re-reads | same | missing | `read` called twice |
| unchanged `size:mtimeMs` keeps the mounted view | same | missing | stub mounted once |
| view `onFailed` → fallback panel | same | missing | `preview.renderFailed` |
| `@mention` button dispatches `omp:insert-mention` | same | missing | event detail path |
| markdown link opens the Preview tab (existing test renamed/updated) | `PanelContainer.test.tsx` | expects `files` | expects `preview`, `h1` present |
| Preview tab only listed while a file is previewed | `PanelContainer.test.tsx` | no tab | tab present / absent |
| split workspace + preview → `<aside>` docked (no `absolute`, has `omp-inspector-docked`) | `PanelContainer.test.tsx` | has `absolute` | docked |
| `panelTab: "preview"` with null path renders the Files tab | `PanelContainer.test.tsx` | blank | Files tree shown |

## Tasks

### Task 2.1 — Red: store, layout, kind, zip budget, base64 tests
- **Goal**: failing unit tests for every pure piece of this phase.
- **Target files and symbols**: the five test files in the matrix (`stores/ui.test.ts` extended; four new).
- **Steps**:
  1. `stores/ui.test.ts`: add a `describe("file preview", …)` with the four store cases.
     Reset with `useUiStore.setState({ panelTab: "files", panelVisible: false, filePreviewPath: null, filePreviewRevision: 0 })`
     in `afterEach`.
  2. `inspector-layout.test.ts`: `it.each` over rows
     `[tab, compact, split, sidebarVisible, expected]`:
     `["files",false,false,true,false]`, `["files",false,true,true,true]`,
     `["files",true,false,true,true]`, `["logs",false,true,false,true]`,
     `["preview",false,true,true,false]`, `["preview",false,false,true,false]`,
     `["preview",true,false,true,true]`, `["preview",true,true,false,false]`.
  3. `preview-kind.test.ts`: `it.each` of `[path, kind]`:
     `docs/a.md`→markdown, `a.MDX`→markdown, `notes.txt`→text, `q.sql`→text,
     `Makefile`→text, `t.csv`→csv, `r.pdf`→pdf, `b.xlsx`→sheet, `b.xls`→sheet, `b.ods`→sheet,
     `/home/u/Documents/Sai ATLAS/Report.docx`→docx, `deck.pptx`→pptx, `p.png`→image,
     `p.JPEG`→image, `song.mp3`→unsupported, `a.zip`→unsupported, `old.doc`→unsupported,
     `old.ppt`→unsupported, `x.odt`→unsupported.
  4. `zip-budget.test.ts`: build archives with `new JSZip()` (`jszip` devDependency) and
     `generateAsync({ type: "uint8array" })`. Cases:
     - "accepts a small archive" → `{ ok: true }`;
     - "rejects an archive with too many entries" (4 files, `{ maxEntries: 3, maxTotalBytes: 1e9 }`)
       → `{ ok: false, reason: "tooManyEntries" }`;
     - "rejects an archive whose declared size is over the cap" (one 100-byte file,
       `{ maxEntries: 10, maxTotalBytes: 10 }`) → `reason: "tooLarge"`;
     - "rejects bytes that are not a zip" (`%PDF-1.7` bytes) → `reason: "notZip"`;
     - "rejects a truncated archive" (valid zip with the central directory cut:
       `bytes.subarray(0, bytes.length - 30)`) → `reason` is `"notZip"` or `"corrupt"`;
       assert `ok === false` only.
  5. `base64.test.ts`: "turns base64 into bytes".
- **Success criteria**: every new test fails for a missing module/member.
- **Verify**: `bunx vitest run src/renderer/stores/ui.test.ts src/renderer/components/layout/inspector-layout.test.ts src/renderer/components/preview src/renderer/lib/base64.test.ts; echo "exit=$?"` → `exit=1`.

### Task 2.2 — Green: store, layout rule, kind, zip budget, base64
- **Goal**: implement the pure pieces.
- **Target files and symbols**: `ui.ts`, `inspector-layout.ts` (`inspectorOverlays`), `preview-kind.ts` (`PreviewKind`, `previewKindOf`), `zip-budget.ts` (`checkZipBudget`, `DEFAULT_ZIP_BUDGET`, `ZipBudget`, `ZipBudgetResult`), `base64.ts` (`bytesFromBase64`).
- **Steps**:
  1. `ui.ts`:
     - `export type PanelTab = "files" | "logs" | "preview";` and leave `panelTabFromPref`
       unchanged;
     - add `filePreviewRevision: number` (initial `0`) and `reloadFilePreview: () => void`
       to `UiStore`;
     - `openFilePreview: path => set({ filePreviewPath: path, filePreviewRevision: get().filePreviewRevision + 1, panelTab: "preview", panelVisible: true })`;
     - `closeFilePreview: () => set({ filePreviewPath: null, panelTab: get().panelTab === "preview" ? "files" : get().panelTab })`;
     - `reloadFilePreview: () => set({ filePreviewRevision: get().filePreviewRevision + 1 })`.
  2. `inspector-layout.ts`:
     `export function inspectorOverlays({ tab, compact, split, sidebarVisible }: InspectorLayoutState): boolean { return tab === "preview" ? compact && sidebarVisible : compact || split; }`
     with a doc comment carrying the 800 − 264 − 360 px rationale from plan.md Decision 1.
  3. `preview-kind.ts`:
     - take the base name (text after the last `/`) and `fileKindOf(base)` from
       `../attachments`;
     - `audio`/`video`/`archive` → `"unsupported"`; `image` → `"image"`;
     - otherwise switch on the lowercased extension (text after the last `.` of the base;
       none → `""`): `md`, `mdx` → markdown; `csv` → csv; `pdf` → pdf; `xlsx`, `xls`, `ods`
       → sheet; `docx` → docx; `pptx` → pptx; `doc`, `ppt`, `odt`, `odp`, `rtf` →
       unsupported; default → text.
  4. `zip-budget.ts`: `DEFAULT_ZIP_BUDGET = { maxEntries: 4000, maxTotalBytes: 256 * 1024 * 1024 }`.
     `checkZipBudget(bytes, budget = DEFAULT_ZIP_BUDGET)`:
     - not starting with `50 4B 03 04` → `notZip`;
     - find the end-of-central-directory signature `0x06054b50` scanning backwards from
       `length - 22` to `max(0, length - 22 - 65535)` with a little-endian `DataView`; none →
       `corrupt`;
     - read entries (u16 at +10), central-directory size (u32 at +12) and offset (u32 at
       +16); `entries === 0xffff` or `entries > maxEntries` → `tooManyEntries`;
       `offset + size > length` → `corrupt`;
     - walk the entries: signature `0x02014b50` else `corrupt`; uncompressed u32 at +24,
       `0xffffffff` → `tooLarge`; add it to the total and return `tooLarge` once the total
       passes `maxTotalBytes`; name/extra/comment lengths u16 at +28/+30/+32; next =
       p + 46 + n + e + c; out of bounds → `corrupt`;
     - else `{ ok: true }`.
     Doc comment: declared sizes can lie; this bounds honest bombs and the byte cap bounds
     the rest.
  5. `base64.ts`: move the body of `decodeBase64` from `src/renderer/lib/pdf-thumbnail.ts`
     into `export function bytesFromBase64(data: string): Uint8Array` (Phase 3 switches
     `pdf-thumbnail.ts` to it; do not edit that file now).
- **Success criteria**: Task 2.1 suites green.
- **Verify**: the Task 2.1 command → `exit=0`.

### Task 2.3 — Red: DocumentPreview component tests
- **Goal**: pin the pane's behaviour with injected views and a `window.omp` double.
- **Target files and symbols**: `src/renderer/components/preview/DocumentPreview.test.tsx`; `preview-views.ts` (types only, created now so the test compiles).
- **Steps**:
  1. Create `preview-views.ts` with the `PreviewViewKind`, `DocumentViewProps`,
     `PreviewViews` types from plan.md and `export const PREVIEW_VIEWS: PreviewViews = {};`.
  2. Test harness: copy the linkedom globals, `mount`, `flush` and `afterEach` of
     `src/renderer/components/layout/PanelContainer.test.tsx:1-60`. In `afterEach`, also run
     `useUiStore.setState({ filePreviewPath: null, filePreviewRevision: 0, panelTab: "files" })`
     and `useSessionStore.setState({ isStreaming: false })`.
  3. The `window.omp` double has `fs.read`, `fs.readImage` and `fs.readDocument` as
     `vi.fn` stubs, `system.openPath` and `system.openExternal`.
  4. Stub views: `const docx = vi.fn((props: DocumentViewProps) => { useEffect(() => props.onRendered({ shown: 1, total: 1 }), []); return <div data-stub="docx" />; })`.
     Count mounts with a `useEffect(() => { mounts += 1 }, [])`. Mount with
     `<DocumentPreview views={{ docx: Docx }} />` after
     `useUiStore.getState().openFilePreview(path)`.
  5. Write one `it` per DocumentPreview row of the matrix. Use these test double values:
     - "bytes reach the docx view": build a real one-file zip in the test
       (`new JSZip().file("word/document.xml", "<w:document/>").generateAsync({ type: "uint8array" })`).
       `readDocument` returns
       `{ ok: true, data: Buffer.from(zip).toString("base64"), container: "zip", size: zip.length, mtimeMs: 1 }`.
       Assert the stub view received `data` as a `Uint8Array` whose `length === zip.length`.
     - "not a zip in budget": `readDocument` returns
       `{ ok: true, data: "JVBERi0xLjc=", container: "zip", size: 8, mtimeMs: 1 }`
       (`%PDF-1.7` bytes labelled as a zip).
     - too large: `{ ok: false, size: 40 * 1024 * 1024, error: "File too large" }`.
     - turn end: set `useSessionStore.setState({ isStreaming: true })`, flush, then
       `{ isStreaming: false }`, flush; expect `fs.read` called 2 times.
     - unchanged stamp: `readDocument` returns the same object twice; call
       `reloadFilePreview()`; expect `mounts === 1` and `readDocument` called 2 times.
- **Success criteria**: the suite fails because `DocumentPreview` does not exist.
- **Verify**: `bunx vitest run src/renderer/components/preview/DocumentPreview.test.tsx; echo "exit=$?"` → `exit=1`.

### Task 2.4 — Green: DocumentPreview
- **Goal**: implement the pane so Task 2.3 passes.
- **Target files and symbols**: `src/renderer/components/preview/DocumentPreview.tsx` (`DocumentPreview`), locales.
- **Steps**:
  1. Props: `{ views?: PreviewViews }`, defaulting to `PREVIEW_VIEWS`. It reads
     `filePreviewPath` and `filePreviewRevision` from `useUiStore`, `tabId` from
     `useRuntimeTabId()`, and `isStreaming` from `useSessionStore`. It returns null when the
     path is null.
  2. The local state type `Body` is exactly the union in this phase's "State" block below.
     `kind = previewKindOf(path)`. Keep a `stamp` ref (`string | null`) that is reset when
     `path` changes.
  3. Turn end: a `useRef(isStreaming)`. When the previous value was true and the current one
     is false, increment a local `tick`.
  4. The load effect runs on `[path, kind, tabId, filePreviewRevision, tick]` with a
     `version` ref guarding stale results, as `FilesPanel.openPreview` does
     (`FilesPanel.tsx:101-137`):
     - `markdown`/`text`: `tabId ? fs.read(path, 200_000, tabId) : fs.read(path, 200_000)`.
       `!ok` → failed `read` with the error; `binary` → failed `binary`; otherwise text. If
       the content equals the current text content, do nothing.
     - `image`: `fs.readImage(path, tabId ?? undefined)`. `!ok` → failed `read`; otherwise
       image.
     - `csv`: `fs.read(path, 2_000_000[, tabId])` → `view` with `view: "sheet"`,
       `data: content` and `truncated`; binary → failed `binary`.
     - `pdf`/`sheet`/`docx`/`pptx`: `fs.readDocument(path, tabId ?? undefined)`.
       - `!ok && error === "File too large"` → failed `tooLarge` with `size`; other `!ok` →
         failed `read`.
       - `stamp = ${size}:${mtimeMs}`; equal to the current stamp → do nothing.
       - `bytes = bytesFromBase64(data)`. If `container === "zip"` and
         `checkZipBudget(bytes)` is not ok → failed `render` with the reason as detail.
       - Otherwise `view` with `view: kind`.
     - `unsupported` → failed `unsupported` (no read).
     - A `view` whose kind has no entry in `views` → failed `unsupported`.
  5. Render. The root is
     `<section className="flex h-full flex-col" data-preview-kind={kind} data-preview-state={state} data-preview-shown={…} data-preview-total={…}>`.
     - **Header** (copy the FilesPanel header classes, `FilesPanel.tsx:193-229`): a `File`
       icon, the path (`title=path`, truncate), a Reload `IconButton` (`RefreshCw`,
       `t("preview.reload")`) calling `reloadFilePreview`, a `PathLink` with
       `t("filesPanel.openExternal")`, the insert-@mention button (same event as FilesPanel:
       `omp:insert-mention` with `{ path, tabId }`), and a close `IconButton` (`X`,
       `t("preview.close")`) calling `closeFilePreview`.
     - **Body**:
       - loading → `Spinner` + `t("filesPanel.reading")`;
       - markdown → `MarkdownRenderer`;
       - text → `<pre>` with the FilesPanel classes; the truncation note uses
         `t("filesPanel.truncated", { kb: 200 })`;
       - image → `<img alt={baseName} className="mx-auto max-w-full" src={dataUrl} />`;
       - view → `<Suspense fallback={spinner + t("preview.rendering")}><View key={stamp ?? path} data={…} onRendered={…} onFailed={…} /></Suspense>`,
         with `onRendered` setting state `ready` plus shown/total, and `onFailed` setting
         failed `render`;
       - failed → a centred message (`preview.tooLarge` with
         `{ size: (size / 1048576).toFixed(1), limit: 32 }`, `preview.renderFailed`,
         `preview.unsupported`, `filesPanel.binary`, or `filesPanel.readFailed` with
         `{ error }`) and a `PathLink` "Open externally" button.
     - `data-preview-state`: loading → `loading`; view before `onRendered` → `rendering`;
       text, image and view after `onRendered` → `ready`; failed → `failed`.
       `data-preview-shown`/`data-preview-total` are `1`/`1` for text and image.
  6. Locales: add to both files (en / vi):
     - `panel.tabs.preview`: "Preview" / "Xem trước"
     - `preview.reload`: "Reload preview" / "Tải lại bản xem trước"
     - `preview.close`: "Close preview" / "Đóng bản xem trước"
     - `preview.rendering`: "Preparing preview…" / "Đang chuẩn bị bản xem trước…"
     - `preview.tooLarge`: "This file is too large to preview ({size} MB, limit {limit} MB)." / "Tệp này quá lớn để xem trước ({size} MB, giới hạn {limit} MB)."
     - `preview.unsupported`: "Preview isn't available for this type of file." / "Chưa xem trước được loại tệp này."
     - `preview.renderFailed`: "This file couldn't be shown. It may be damaged, or use features the preview doesn't support." / "Không hiển thị được tệp này. Tệp có thể bị hỏng hoặc dùng tính năng mà bản xem trước chưa hỗ trợ."

  State block (use verbatim as the `Body` type):
  ```ts
  type Body =
    | { status: "loading" }
    | { status: "text"; content: string; truncated: boolean; markdown: boolean }
    | { status: "image"; dataUrl: string }
    | { status: "view"; view: PreviewViewKind; data: Uint8Array | string; truncated: boolean; rendered: { shown: number; total: number } | null }
    | { status: "failed"; reason: "read" | "binary" | "tooLarge" | "unsupported" | "render"; detail?: string; size?: number };
  ```
- **Success criteria**: Task 2.3 green; locale parity test green.
- **Verify**: `bunx vitest run src/renderer/components/preview src/renderer/locales; echo "exit=$?"` → `exit=0`.

### Task 2.5 — Red: PanelContainer preview tab and docking
- **Goal**: failing drawer tests.
- **Target files and symbols**: `src/renderer/components/layout/PanelContainer.test.tsx`.
- **Steps**:
  1. Rename "opens a local markdown link inside the Files drawer" to "opens a local markdown
     link in the Preview tab" and change its expected `panelTab` to `"preview"`. Keep
     `expect(read).toHaveBeenCalledWith("docs/report.md", 200_000)` and the `aside h1` check.
  2. In "decodes an absolute file URL and renders non-Markdown text as code", change any
     `panelTab: "files"` expectation to `"preview"`. The `fs` double gains
     `readImage: vi.fn()` and `readDocument: vi.fn()`.
  3. Add:
     - "lists the Preview tab only while a file is previewed": no path → no button named
       `Preview`; after `openFilePreview("a.md")` → a button whose `aria-label` is `Preview`.
     - "docks the preview beside the chat in a split workspace":
       `useTabsStore.setState({ split: { firstTabId: "t0", secondTabId: "t1", axis: "columns", ratio: 0.5 } })`
       (`SplitLayout`, `src/renderer/stores/tabs.ts:86`),
       then preview a file; `aside.className` does not contain `absolute` and contains
       `omp-inspector-docked`. Then `setPanelTab("files")`; the class contains `absolute`.
     - "shows the Files tab when the previewed file is cleared":
       `useUiStore.setState({ panelTab: "preview", filePreviewPath: null, panelVisible: true })`
       → the files search input (`aria-label` "Search loaded files by path") is present.
- **Success criteria**: new and updated cases fail.
- **Verify**: `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` → `exit=1`.

### Task 2.6 — Green: PanelContainer, FilesPanel, App, CSS
- **Goal**: wire the tab and the docking rule; move preview out of FilesPanel.
- **Target files and symbols**: `PanelContainer.tsx` (`TABS`, className at line 129, body at lines 165-169), `FilesPanel.tsx`, `App.tsx` (`hideInspector`, lines 291-295), `global.css` (line 706).
- **Steps**:
  1. `PanelContainer.tsx`:
     - read `filePreviewPath` and `sidebarVisible` from `useUiStore`;
     - `const tab = panelTab === "preview" && !filePreviewPath ? "files" : panelTab`;
     - visible tabs = `TABS` plus `{ id: "preview", labelKey: "panel.tabs.preview", icon: Eye }`
       when `filePreviewPath`;
     - `const overlay = inspectorOverlays({ tab, compact, split: split !== null, sidebarVisible })`;
     - the className uses `overlay ? "absolute inset-y-0 right-0 z-30 shadow-[var(--omp-shadow-lg)]" : "shrink-0 omp-inspector-docked"`;
     - the body adds `{tab === "preview" && <DocumentPreview />}` and the boundary key uses
       `tab`;
     - the active-tab highlight compares against `tab`.
  2. `FilesPanel.tsx`:
     - delete the `if (filePreviewPath) { … }` branch, `PreviewState`, `preview` state,
       `previewVersion`, `openPreview`, its effect, `activePreview`, `previewIsMarkdown`,
       `PREVIEW_MAX_BYTES`, `insertMention` and `closeFilePreview`;
     - remove the now-unused imports (`ArrowLeft`, `AtSign`, `ExternalLinkIcon`,
       `MarkdownRenderer`, `PathLink`);
     - keep `openFilePreview` for tree clicks;
     - update the header comment ("in-drawer preview" → "file clicks open the Preview tab").
  3. `App.tsx`: in `hideInspector`, change the condition to
     `if (compact.matches && ui.panelVisible && inspectorOverlays({ tab: ui.panelTab, compact: true, split: false, sidebarVisible: ui.sidebarVisible })) ui.togglePanel();`
     and import `inspectorOverlays`.
  4. `global.css` line 706: change the selector `.omp-inspector {` inside
     `@media (max-width: 1000px)` to `.omp-inspector:not(.omp-inspector-docked) {`.
- **Success criteria**: drawer, Files and preview suites green; type check green.
- **Verify**:
  - `bunx vitest run src/renderer/components/layout src/renderer/components/panels src/renderer/components/preview src/renderer/stores; echo "exit=$?"` → `exit=0`
  - `bun run check:types; echo "exit=$?"` → `exit=0`
  - `grep -c "filePreviewPath" src/renderer/components/panels/FilesPanel.tsx` → `0`

### Task 2.7 — Commit
- **Steps**: `bunx biome check` on every file in "Files to Create / Modify" (must exit 0);
  then `git commit -m "feat(preview): dock a file preview tab beside the chat"`.
- **Verify**: `git status --porcelain -- src | wc -l` → `0`.

## Verification

- `bunx vitest run; echo "exit=$?"` → `exit=0`
- `bun run check:types; echo "exit=$?"` → `exit=0`
- `bunx biome check src/renderer/components/preview src/renderer/components/layout/PanelContainer.tsx src/renderer/components/layout/inspector-layout.ts src/renderer/components/panels/FilesPanel.tsx src/renderer/App.tsx src/renderer/stores/ui.ts src/renderer/lib/base64.ts src/renderer/locales; echo "exit=$?"` → `exit=0`
- `bun run build 2>&1 | grep -c "index.html entry is lean"` → `1`

## Risks & Rollback

- **Risk (Med × Low)**: other tests assume `openFilePreview` selects `files`.
  `grep -rn "panelTab: \"files\"" src/renderer --include=*.test.tsx` lists them. Only
  assertions made after an `openFilePreview` call change; anything else is a Failure
  Protocol stop.
- **Risk (Low × Med)**: `SettingsWindow`'s `defaultPanelTab` radio shows no selection while
  `preview` is active. That is acceptable: the pref is only written from that radio
  (`SettingsWindow.tsx:391`) and `panelTabFromPref` never restores `preview`.
- **Rollback**: `git revert <phase commit>` restores the Files-tab preview. Phase 1 stays
  harmless.

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

=== FILE: phase-03-pdf-and-spreadsheet-views.md ===
---
phase: 3
title: "PDF and spreadsheet views"
status: pending
priority: P1
effort: "6h"
dependencies: [2]
---
# Phase 3: PDF and spreadsheet views

## Goal

Render PDFs (first 50 pages on canvases) and spreadsheets: .xlsx/.xls/.ods through SheetJS,
and .csv through the same table, with 1000 rows × 50 columns per sheet. Share one pdf.js
loader with the attachment thumbnails, give both libraries lazy chunks, and add the two e2e
specs (Tauri and Electron) with their fixture builder.

## Files to Create / Modify

Create:
- `vendor/xlsx-0.20.3.tgz`
- `src/renderer/lib/pdfjs.ts`, `pdfjs.test.ts`
- `src/renderer/components/preview/sheet-model.ts`, `sheet-model.test.ts`
- `src/renderer/components/preview/SheetView.tsx`, `SheetView.test.tsx`
- `src/renderer/components/preview/PdfView.tsx`
- `e2e/preview-fixtures.ts`
- `e2e/document-preview.e2e.ts` (Electron, Playwright)
- `e2e-tauri/document-preview.e2e.ts` (Tauri, WebdriverIO)

Modify:
- `package.json`, `bun.lock` (`xlsx` from the vendored tarball)
- `src/renderer/lib/pdf-thumbnail.ts` (use `lib/pdfjs.ts` and `lib/base64.ts`)
- `src/renderer/components/preview/preview-views.ts` (`pdf`, `sheet`)
- `vite.renderer.shared.ts` (`VENDOR_CHUNK_RULES`)
- `scripts/check-renderer-chunks.ts` (`LAZY_CHUNKS`)
- `src/renderer/locales/en.ts`, `vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| pdf.js options never enable wasm or XFA | `lib/pdfjs.test.ts` | module missing | `PDF_DOCUMENT_OPTIONS` equals `{ useWasm: false, enableXfa: false }` |
| existing thumbnail loader cases keep passing | `lib/pdf-thumbnail.test.ts` | — | green after refactor |
| lists visible sheets in workbook order and skips hidden ones | `sheet-model.test.ts` | module missing | `["Sales","Big"]` |
| shows formatted values and a formula without a cached value | same | missing | `"50%"`, `"=SUM(B2:B2)"` with `formula: true` |
| caps rows and reports the full row count | same | missing | 1000 rows, `totalRows` 1205 |
| caps columns and reports the full column count | same | missing | 50 cols, `totalCols` 60 |
| reads CSV text without converting values | same | missing | `"007"`, `"01/02/2026"` |
| returns an empty model for an empty sheet | same | missing | rows `[]`, totals 0 |
| SheetView renders the CSV table and reports rows | `SheetView.test.tsx` | module missing | cell `Hà Nội`, `onRendered({shown:1,total:1})` |
| SheetView switches sheets from its tab buttons | same | missing | second sheet's cell visible |
| SheetView reports a parse failure | same | missing | `onFailed` called for `Uint8Array([1,2,3])` |
| Tauri e2e: pdf, xlsx, csv, png reach `ready`; no CSP violation | `e2e-tauri/document-preview.e2e.ts` | exit ≠ 0 (pdf/xlsx/csv `unsupported`) | exit 0 |
| Electron e2e: same four | `e2e/document-preview.e2e.ts` | exit ≠ 0 | exit 0 |

## Tasks

Execution order (test first): 3.1 → 3.2 → 3.7 steps 1–4 (author both e2e specs and run
them red) → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 step 5 (green run) → 3.8.

### Task 3.1 — Vendor SheetJS and confirm it loads
- **Goal**: a pinned, offline SheetJS dependency.
- **Target files and symbols**: `vendor/xlsx-0.20.3.tgz`, `package.json` `dependencies.xlsx`.
- **Steps**:
  1. `mkdir -p vendor && curl -fsSLo vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
  2. `sha256sum vendor/xlsx-0.20.3.tgz` (see Verify).
  3. `bun add xlsx@file:vendor/xlsx-0.20.3.tgz`
- **Success criteria**: hash matches; the module loads.
- **Verify**:
  - `sha256sum vendor/xlsx-0.20.3.tgz | cut -d' ' -f1` → `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
  - `bun -e 'import("xlsx").then(m => console.log(m.version))'` → `0.20.3`
  - `grep -c '"xlsx": "file:vendor/xlsx-0.20.3.tgz"' package.json` → `1`

### Task 3.2 — Red: pdfjs options, sheet model, SheetView
- **Goal**: failing unit tests.
- **Target files and symbols**: `lib/pdfjs.test.ts`, `preview/sheet-model.test.ts`, `preview/SheetView.test.tsx`.
- **Steps**:
  1. `pdfjs.test.ts`: "never lets pdf.js load WebAssembly or XFA" imports
     `PDF_DOCUMENT_OPTIONS` from `./pdfjs`.
  2. `sheet-model.test.ts`:
     - import `* as XLSX from "xlsx"`, `ExcelJS from "exceljs"`, and
       `{ readWorkbook, buildSheetModels, SHEET_LIMITS } from "./sheet-model"`;
     - build the workbook with exceljs in a `beforeAll`:
       - "Sales": rows `["Region","Revenue","Share"]` and `["Hà Nội",1200,0.5]` with
         `C2.numFmt = "0%"`, and `B3.value = { formula: "SUM(B2:B2)" }`;
       - "Secret" with `state = "hidden"`;
       - "Big" with 1205 rows of `[i]`;
       - "Wide" with one row of 60 numbers;
       - "Empty" with no cells;
     - `bytes = new Uint8Array(await wb.xlsx.writeBuffer())`;
     - `models = buildSheetModels(XLSX, readWorkbook(XLSX, bytes))`;
     - write the matrix cases with those names. The CSV case is
       `readWorkbook(XLSX, "id,date\n007,01/02/2026\n")`.
  3. `SheetView.test.tsx` (linkedom harness): mount `<SheetView data={"Region,Revenue\nHà Nội,1200\n"} onRendered={spy} onFailed={fail} />`,
     flush until `spy` is called (the component awaits `import("xlsx")`; use
     `await vi.waitFor(() => expect(spy).toHaveBeenCalled())`). For the tab test, pass
     exceljs bytes with two visible sheets and click the second tab button
     (`button[aria-pressed="false"]`).
- **Success criteria**: all three suites fail for missing modules.
- **Verify**: `bunx vitest run src/renderer/lib/pdfjs.test.ts src/renderer/components/preview/sheet-model.test.ts src/renderer/components/preview/SheetView.test.tsx; echo "exit=$?"` → `exit=1`.

### Task 3.3 — Green: shared pdf.js loader
- **Goal**: one loader, one worker, one option set for thumbnails and previews.
- **Target files and symbols**: `src/renderer/lib/pdfjs.ts` (`loadPdfJs`, `PDF_DOCUMENT_OPTIONS`, `openPdf`); `src/renderer/lib/pdf-thumbnail.ts` (`loadPdfJs`, `decodeBase64`, `rasterizeFirstPage`).
- **Steps**:
  1. Move `type PdfJs`, `let pdfJs` and `function loadPdfJs()` verbatim from
     `pdf-thumbnail.ts` into `pdfjs.ts`, together with its doc comment about the bundled
     worker and the CSP, and export `loadPdfJs`.
  2. Add `export const PDF_DOCUMENT_OPTIONS = { useWasm: false, enableXfa: false } as const;`
     and `export async function openPdf(bytes: Uint8Array) { const pdfjs = await loadPdfJs(); return pdfjs.getDocument({ data: bytes, ...PDF_DOCUMENT_OPTIONS }); }`
     (returns the loading task; callers `await task.promise` and `await task.destroy()`).
     Doc comment: pdf.js transfers `bytes` to its worker; callers must not reuse them.
  3. In `pdf-thumbnail.ts`:
     - delete the moved code and `decodeBase64`;
     - import `bytesFromBase64` from `./base64` (use it in `readPdfBytes`) and `openPdf`
       from `./pdfjs`;
     - in `rasterizeFirstPage`, replace the two lines that load pdf.js and call
       `getDocument` with `const task = await openPdf(bytes);`.
- **Success criteria**: pdfjs and thumbnail tests green.
- **Verify**: `bunx vitest run src/renderer/lib/pdfjs.test.ts src/renderer/lib/pdf-thumbnail.test.ts src/renderer/components/attachments; echo "exit=$?"` → `exit=0`.

### Task 3.4 — Green: sheet model
- **Goal**: a pure workbook → table model.
- **Target files and symbols**: `src/renderer/components/preview/sheet-model.ts` (`SHEET_LIMITS`, `SheetCell`, `SheetModel`, `readWorkbook`, `buildSheetModels`).
- **Steps**:
  1. `import type * as Xlsx from "xlsx"` (type-only, so this module never pulls SheetJS
     into a chunk). `export const SHEET_LIMITS = { rows: 1000, cols: 50 } as const;`.
  2. `readWorkbook(xlsx: typeof Xlsx, data: Uint8Array | string)`:
     - a string →
       `xlsx.read(data, { type: "string", raw: true, dense: true })` (no `sheetRows`: CSV
       has no `!fullref`, verified with 0.20.3);
     - bytes →
       `xlsx.read(data, { type: "array", cellDates: true, cellNF: true, dense: true, sheetStubs: true, sheetRows: SHEET_LIMITS.rows })`.
  3. `buildSheetModels(xlsx: typeof Xlsx, workbook: Xlsx.WorkBook): SheetModel[]`:
     - for each `name` of `workbook.SheetNames` at `index`, skip it when
       `workbook.Workbook?.Sheets?.[index]?.Hidden` is truthy;
     - `ws = workbook.Sheets[name]`; when `ws["!ref"]` is undefined push
       `{ name, rows: [], totalRows: 0, totalCols: 0 }` and continue;
     - full range `{ s, e } = xlsx.utils.decode_range(ws["!fullref"] ?? ws["!ref"])`
       (`!fullref` is set by `sheetRows` for xlsx, verified with 0.20.3);
     - otherwise `totalRows = e.r - s.r + 1` and `totalCols = e.c - s.c + 1`;
     - iterate `r` over `s.r … min(e.r, s.r + rows - 1)` and `c` over
       `s.c … min(e.c, s.c + cols - 1)`, reading `ws["!data"]?.[r]?.[c]`;
     - `cellText(cell)`: undefined/null → `""`; `cell.t === "z"` →
       `typeof cell.f === "string" ? "=" + cell.f : ""` with `formula: true` when `f` is set;
       else `cell.w ?? (cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v ?? ""))`.
       Never read `cell.h` (HTML) or `cell.r` (rich-text XML).
- **Success criteria**: sheet-model suite green.
- **Verify**: `bunx vitest run src/renderer/components/preview/sheet-model.test.ts; echo "exit=$?"` → `exit=0`.

### Task 3.5 — Green: SheetView and PdfView
- **Goal**: the two lazy views.
- **Target files and symbols**: `SheetView.tsx` (default export), `PdfView.tsx` (default export, `PDF_PAGE_LIMIT = 50`), `preview-views.ts`, locales.
- **Steps**:
  1. `SheetView({ data, onRendered, onFailed }: DocumentViewProps)`:
     - an effect does `const xlsx = await import("xlsx")` and runs `readWorkbook` and
       `buildSheetModels`; any throw calls `onFailed(error)`; a cancelled flag guards
       unmount;
     - state `{ models, active }`; call `onRendered({ shown: models[active]?.rows.length ?? 0, total: models[active]?.totalRows ?? 0 })`
       after the first build;
     - render:
       - a row of `<button type="button" aria-pressed={i === active}>` with the sheet
         names, inside `<div role="group" aria-label={t("preview.sheet.tabs")}>`, shown only
         when there are 2 or more sheets;
       - a `<div className="overflow-auto">` with a `<table className="border-collapse text-omp-sm">`;
       - a header row of column letters (`xlsx.utils.encode_col(c)`, kept in state from the
         effect) and a first column of row numbers;
       - cell text as React children, formula cells with `className="text-(--omp-dim)"`
         and `title={t("preview.sheet.formula")}`;
       - `t("preview.sheet.empty")` for an empty sheet;
       - `t("preview.sheet.partial", { rows, totalRows, cols, totalCols })` when capped.
  2. `PdfView({ data, onRendered, onFailed })`:
     - a container ref; the effect runs `task = await openPdf(data as Uint8Array)`,
       `doc = await task.promise`, `total = doc.numPages`,
       `shown = Math.min(total, PDF_PAGE_LIMIT)`;
     - `width = Math.max(1, container.clientWidth) * Math.max(1, devicePixelRatio || 1)`;
     - for each page 1..shown, unless cancelled: `page = await doc.getPage(i)`,
       `viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width })`;
       create a `<canvas>` with `width`/`height` from the viewport (ceil) and
       `style.width = "100%"`, `style.height = "auto"`, append it inside a `<div class="mb-3 shadow">`
       and `await page.render({ canvas, viewport }).promise`;
     - then `onRendered({ shown, total })`; a throw calls `onFailed`; cleanup sets cancelled
       and runs `void task?.destroy()`;
     - render `<div ref className="p-3 bg-(--omp-bg-tertiary)" />` plus
       `t("preview.pdf.partial", { shown, total })` when `shown < total`. No text layer, no
       annotation layer.
  3. `preview-views.ts`: `PREVIEW_VIEWS = { pdf: lazy(() => import("./PdfView")), sheet: lazy(() => import("./SheetView")) }`.
  4. Locales (en / vi):
     - `preview.pdf.partial`: "Showing the first {shown} of {total} pages." / "Đang hiển thị {shown} trang đầu trong tổng số {total} trang."
     - `preview.sheet.partial`: "Showing {rows} of {totalRows} rows and {cols} of {totalCols} columns." / "Đang hiển thị {rows}/{totalRows} hàng và {cols}/{totalCols} cột."
     - `preview.sheet.empty`: "This sheet is empty." / "Trang tính này trống."
     - `preview.sheet.tabs`: "Sheets" / "Các trang tính"
     - `preview.sheet.formula`: "Formula; its value is calculated when the file is opened in a spreadsheet app." / "Công thức; giá trị được tính khi mở tệp bằng ứng dụng bảng tính."
- **Success criteria**: Task 3.2 suites green.
- **Verify**: `bunx vitest run src/renderer/components/preview src/renderer/lib src/renderer/locales; echo "exit=$?"` → `exit=0`.

### Task 3.6 — Lazy chunks
- **Goal**: pdf.js and SheetJS never reach the entry chunk.
- **Target files and symbols**: `vite.renderer.shared.ts` `VENDOR_CHUNK_RULES` (line 17); `scripts/check-renderer-chunks.ts` `LAZY_CHUNKS` (line 14).
- **Steps**:
  1. Append `[/[\\/]node_modules[\\/]pdfjs-dist[\\/]/, "pdfjs"],` and
     `[/[\\/]node_modules[\\/]xlsx[\\/]/, "sheetjs"],` with one comment line each.
  2. Set `LAZY_CHUNKS` to
     `["mermaid", "codemirror", "charts", "highlight", "xterm", "pdfjs", "sheetjs"]`.
- **Success criteria**: the build passes its chunk gate and emits both chunks.
- **Verify**:
  - `bun run build 2>&1 | grep -c "index.html entry is lean"` → `1`
  - `ls out/renderer/assets | grep -cE '^(pdfjs|sheetjs)-.*\.js$'` → a number ≥ `2`

### Task 3.7 — E2E fixtures and specs (written first, then run red, then green)
- **Goal**: prove real rendering under the real CSP in both shells.
- **Target files and symbols**: `e2e/preview-fixtures.ts` (`minimalPdf`, `writePreviewFixtures`), `e2e/document-preview.e2e.ts`, `e2e-tauri/document-preview.e2e.ts`.
- **Steps** (steps 1–4 run right after Task 3.2, step 5 after Task 3.6; see the execution
  order above):
  1. `preview-fixtures.ts` exports `writePreviewFixtures(dir: string): Promise<void>`, which
     writes:
     - `sample.pdf` (`minimalPdf("Preview PDF")`, the generator below);
     - `sample.xlsx`: exceljs sheet "Sales" with `["Region","Revenue"]` and
       `["Hà Nội",1200]`;
     - `sample.csv` = `"Region,Revenue\nHà Nội,1200\n"`;
     - `sample.png` = base64
       `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`.

     ```ts
     export function minimalPdf(text: string): Uint8Array {
       const stream = `BT /F1 24 Tf 72 760 Td (${text}) Tj ET`;
       const objects = [
         "<< /Type /Catalog /Pages 2 0 R >>",
         "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
         "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
         "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
         `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
       ];
       let body = "%PDF-1.4\n";
       const offsets: number[] = [];
       objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
       const xref = body.length;
       body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
       for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
       body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
       return new TextEncoder().encode(body);
     }
     ```
  2. `e2e-tauri/document-preview.e2e.ts`:
     - `before`: `await awaitBridge(browser)`, then
       `await writePreviewFixtures(currentLaunch().project)`;
     - install a violation collector with `browser.execute(() => { (window as unknown as { __cspViolations: string[] }).__cspViolations = []; document.addEventListener("securitypolicyviolation", e => (window as unknown as { __cspViolations: string[] }).__cspViolations.push(e.effectiveDirective)); })`;
     - click `$('button[title="Open workspace"]')`;
     - for each `[file, kind]` of `[["sample.pdf","pdf"],["sample.xlsx","sheet"],["sample.csv","csv"],["sample.png","image"]]`:
       click `$('[data-tree-id="file:' + file + '"]')`, then poll with `until` (timeout
       30 000 ms) reading
       `document.querySelector('[data-preview-kind]')?.getAttribute("data-preview-state")`
       and `…getAttribute("data-preview-kind")`;
     - expect kind = expected and state = `"ready"`; then click the Files tab
       (`$('button[aria-label="Files"]')`) before the next file;
     - extra checks: pdf → `data-preview-total` is `"1"`; xlsx and csv → the preview's text
       contains `Hà Nội`;
     - final `it`: `__cspViolations` equals `[]`.
  3. `e2e/document-preview.e2e.ts`: copy `beforeAll`/`afterAll` from `e2e/desktop.e2e.ts`
     lines 29-65, with the profile prefix `omp-gui-preview-`. Call
     `await writePreviewFixtures(project)` before `electron.launch`. Run the same steps with
     Playwright locators (`page.locator('button[title="Open workspace"]')`,
     `page.locator('[data-tree-id="file:sample.pdf"]')`,
     `expect(page.locator('[data-preview-kind="pdf"][data-preview-state="ready"]')).toBeVisible({ timeout: 30_000 })`)
     and the same CSP collector through `page.evaluate`.
  4. Red run (no pdf/sheet view is registered yet). Build first:
     `bun run build && PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH" cargo tauri build --debug --features e2e-hooks --no-bundle`.
     Then run both specs (commands in Verify); each must exit non-zero.
  5. Green run after Task 3.6: rebuild with the same two commands and run both specs again.
- **Success criteria**: red exits non-zero, green exits 0.
- **Verify**:
  - red: `scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts; echo "exit=$?"` → `exit=1`; `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` → a line `exit=` with a non-zero number
  - green: the same two commands → `exit=0` each
  - afterwards: `scripts/virtual-display.sh stop; echo "exit=$?"` → `exit=0`

### Task 3.8 — Commit
- **Steps**: biome on touched files (exit 0); commit
  `feat(preview): show PDFs and spreadsheets in the preview pane`.
- **Verify**: `git status --porcelain -- src e2e e2e-tauri vendor package.json bun.lock vite.renderer.shared.ts scripts | wc -l` → `0`.

## Verification

- `bunx vitest run; echo "exit=$?"` → `exit=0`
- `bun run check:types; echo "exit=$?"` → `exit=0`
- `bun run build 2>&1 | grep -c "index.html entry is lean"` → `1`
- Both e2e commands from Task 3.7 → `exit=0`

## Risks & Rollback

- **Risk (Med × High)**: pdf.js fails on WebKitGTK (engine floor). The Tauri e2e shows it as
  pdf state `failed`. That is a Failure Protocol stop; kongming decides whether to switch to
  `pdfjs-dist/legacy/build/pdf.mjs` in `lib/pdfjs.ts` only.
- **Risk (Low × Med)**: `bun add xlsx@file:…` rewrites `bun.lock` broadly. Check with
  `git diff --stat bun.lock` that only `xlsx` entries change; anything else is a stop.
- **Risk (Low × Low)**: the thumbnail refactor changes the sibling's behaviour. Its tests
  run in Task 3.3.
- **Rollback**: `git revert <phase commit>`. Pdf and sheet kinds fall back to
  `preview.unsupported` because `PREVIEW_VIEWS` loses their entries; thumbnails keep their
  pre-refactor code through the revert.

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

=== FILE: phase-04-docx-and-pptx-views.md ===
---
phase: 4
title: "DOCX and PPTX views"
status: pending
priority: P1
effort: "5h"
dependencies: [3]
---
# Phase 4: DOCX and PPTX views

## Goal

Render .docx with docx-preview (paged, fitted to the pane width) and .pptx with
`@aiden0z/pptx-renderer` (slide list, windowed, lazy media), each inside an isolated shadow
root with a link guard. The hardened options live in one tested module, and the e2e specs
are extended to both formats using fixtures built by the assistant pack's own office
builders.

## Files to Create / Modify

Create:
- `src/renderer/components/preview/link-guard.ts`, `link-guard.test.ts`
- `src/renderer/components/preview/office-options.ts`, `office-options.test.ts`
- `src/renderer/components/preview/ShadowFrame.tsx`, `ShadowFrame.test.tsx`
- `src/renderer/components/preview/DocxView.tsx`
- `src/renderer/components/preview/PptxView.tsx`

Modify:
- `package.json`, `bun.lock` (`docx-preview` 0.4.1, `@aiden0z/pptx-renderer` 1.3.0, exact)
- `src/renderer/components/preview/preview-views.ts` (`docx`, `pptx`)
- `vite.renderer.shared.ts`, `scripts/check-renderer-chunks.ts`
- `e2e/preview-fixtures.ts`, `e2e/document-preview.e2e.ts`, `e2e-tauri/document-preview.e2e.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| opens an http link through the system browser and keeps the page in place | `link-guard.test.ts` | module missing | `open` called with `https://example.com/`, `defaultPrevented` true |
| drops a javascript link without opening anything | same | missing | `open` not called, prevented |
| drops file and relative links | same | missing | not called, prevented |
| ignores clicks that are not on a link | same | missing | not prevented |
| stops guarding once disposed | same | missing | not prevented after dispose |
| never renders embedded HTML chunks and inlines assets as data URLs | `office-options.test.ts` | missing | `renderAltChunks: false`, `useBase64URL: true`, `inWrapper: true` |
| keeps slide decks inside zip limits and away from pdf.js | same | missing | `pdfjs: false`, `zipLimits` passed through, `lazyMedia`/`lazySlides` true |
| mounts into an open shadow root and guards its links | `ShadowFrame.test.tsx` | missing | `host.shadowRoot` set; anchor click prevented |
| cleans up its mount when unmounted | same | missing | disposer called once |
| Tauri e2e: docx and pptx reach `ready`; docx text visible in the shadow root; no CSP violation | `e2e-tauri/document-preview.e2e.ts` | exit ≠ 0 | exit 0 |
| Electron e2e: same | `e2e/document-preview.e2e.ts` | exit ≠ 0 | exit 0 |

## Tasks

Execution order (test first): 4.1 → 4.2 → 4.3 → 4.5 step 1 (e2e red) → 4.4 → 4.5 step 2
(e2e green) → 4.6.

### Task 4.1 — Red: link guard, options, ShadowFrame; extend e2e
- **Goal**: failing tests for every hardening rule before any library is installed.
- **Target files and symbols**: the three unit test files; `e2e/preview-fixtures.ts` (`writePreviewFixtures`); both e2e specs.
- **Steps**:
  1. `link-guard.test.ts` (linkedom globals as in `PanelContainer.test.tsx`):
     - build `<div><a href="https://example.com/">x</a><a href="javascript:alert(1)">j</a><a href="file:///etc/passwd">f</a><a href="other.docx">r</a><span>s</span></div>`;
     - `dispose = guardLinks(div, open)`;
     - dispatch `new Event("click", { bubbles: true, cancelable: true })` on each element
       and assert `event.defaultPrevented` and the `open` calls per the matrix.
  2. `office-options.test.ts`: import `{ DOCX_RENDER_OPTIONS, pptxViewerOptions }` from
     `./office-options`. Assert the listed keys, with `pptxViewerOptions({ maxEntries: 1 })`
     → `zipLimits` deep-equal `{ maxEntries: 1 }`.
  3. `ShadowFrame.test.tsx`:
     - mount `<ShadowFrame onMount={mount} />` where `mount` is a `vi.fn` that appends
       `<a href="https://example.com/">` to `parts.body` and returns `dispose`;
     - stub `window.omp = { system: { openExternal: vi.fn() } }`;
     - assert `document.querySelector("[data-preview-host]").shadowRoot` is not null;
     - a click on the anchor is prevented and `openExternal` is called with the URL;
     - unmount → `dispose` called once.
  4. `preview-fixtures.ts`: also write
     - `sample.docx` = `(await buildReport({ markdown: readFileSync("assistant-pack/test/fixtures/notes-en.md", "utf8"), fallbackTitle: "Report", lang: "en" })).bytes`;
     - `sample.pptx` = `(await buildSlides({ … same input … })).bytes`;
     - imports come from `../assistant-pack/src/office/report` and `../assistant-pack/src/office/slides`.
  5. Both e2e specs: add `[["sample.docx","docx"],["sample.pptx","pptx"]]` to the file list.
     For docx, also read
     `document.querySelector("[data-preview-host]")?.shadowRoot?.textContent ?? ""` and
     expect it to contain `Quarterly sales review` (the notes-en title,
     `assistant-pack/test/report.test.ts:17`). For pptx expect `data-preview-total` ≥ `1`.
- **Success criteria**: unit suites fail for missing modules; e2e not run yet.
- **Verify**: `bunx vitest run src/renderer/components/preview/link-guard.test.ts src/renderer/components/preview/office-options.test.ts src/renderer/components/preview/ShadowFrame.test.tsx; echo "exit=$?"` → `exit=1`.

### Task 4.2 — Green: link guard, options, ShadowFrame
- **Goal**: the isolation primitives.
- **Target files and symbols**: `guardLinks`, `DOCX_RENDER_OPTIONS`, `pptxViewerOptions`, `ShadowFrame`, `ShadowParts`.
- **Steps**:
  1. `link-guard.ts`: `export function guardLinks(root: HTMLElement | ShadowRoot, open: (url: string) => void): () => void`.
     The handler for `click` and `auxclick` (capture: true):
     - `anchor = (event.target as Element | null)?.closest?.("a[href]")`; none → return;
     - `event.preventDefault(); event.stopPropagation();`;
     - `try { url = new URL(anchor.getAttribute("href") ?? "") } catch { return }`;
     - when `url.protocol` is `"http:"` or `"https:"`, `open(url.href)`;
     - return a function removing both listeners;
     - doc comment citing the shells' own navigation locks as the backstop.
  2. `office-options.ts` (type-only imports from `docx-preview` and
     `@aiden0z/pptx-renderer`):
     - `DOCX_RENDER_OPTIONS = { className: "docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false, renderAltChunks: false, useBase64URL: true, renderComments: false, renderChanges: false, experimental: false } satisfies Partial<Options>`;
     - `pptxViewerOptions(zipLimits: ZipParseLimits) => ({ fitMode: "contain" as const, zipLimits, lazyMedia: true, lazySlides: true, pdfjs: false as const, renderMode: "list" as const, listOptions: { windowed: true, showSlideLabels: true } })`;
     - comment each hazard (altChunk iframe, blob fonts blocked by `font-src`, pdf.js
       auto-resolution).
  3. `ShadowFrame.tsx`: `export interface ShadowParts { root: ShadowRoot; body: HTMLDivElement; style: HTMLDivElement }`.
     `export function ShadowFrame({ onMount }: { onMount: (parts: ShadowParts) => () => void })`:
     - renders `<div data-preview-host className="min-h-0 flex-1 overflow-auto" ref={host} />`;
     - a `useEffect([onMount])` does
       `root = host.shadowRoot ?? host.attachShadow({ mode: "open" })`,
       `root.replaceChildren()`, then appends `style` (a div), a `<style>` with
       `:host{display:block;background:var(--omp-bg-tertiary)} .preview-body{min-height:100%}`,
       and `body` (div `.preview-body`);
     - `unguard = guardLinks(root, url => void window.omp.system.openExternal(url))`;
     - `dispose = onMount(parts)`;
     - the cleanup runs `dispose(); unguard(); root.replaceChildren();`.
- **Success criteria**: Task 4.1 unit suites green.
- **Verify**: the Task 4.1 vitest command → `exit=0`.

### Task 4.3 — Install libraries and add lazy chunks
- **Goal**: pinned dependencies that never reach the entry chunk.
- **Target files and symbols**: `package.json`, `bun.lock`, `VENDOR_CHUNK_RULES`, `LAZY_CHUNKS`.
- **Steps**:
  1. `bun add --exact docx-preview@0.4.1 @aiden0z/pptx-renderer@1.3.0`
  2. Append to `VENDOR_CHUNK_RULES`:
     `[/[\\/]node_modules[\\/]jszip[\\/]/, "jszip"]`,
     `[/[\\/]node_modules[\\/]docx-preview[\\/]/, "docx"]`,
     `[/[\\/]node_modules[\\/](@aiden0z|echarts|zrender|mtx-decompressor)[\\/]/, "pptx"]`.
  3. Append `"jszip", "docx", "pptx"` to `LAZY_CHUNKS`.
- **Success criteria**: installed versions exact; no new peer warning besides pdfjs (already
  satisfied by 6.4.299).
- **Verify**:
  - `grep -cE '"(docx-preview|@aiden0z/pptx-renderer)": "(0\.4\.1|1\.3\.0)"' package.json` → `2`
  - `bun run check:types; echo "exit=$?"` → `exit=0`

### Task 4.4 — Green: DocxView and PptxView
- **Goal**: the two lazy views on top of `ShadowFrame`.
- **Target files and symbols**: `DocxView.tsx` (default export), `PptxView.tsx` (default export), `preview-views.ts`.
- **Steps**:
  1. `DocxView({ data, onRendered, onFailed })` renders `<ShadowFrame onMount={mount} />`,
     with `mount` memoized via `useCallback([data])`:
     - start an async block with a `cancelled` flag:
       `const { renderAsync } = await import("docx-preview"); await renderAsync(data as Uint8Array, parts.body, parts.style, DOCX_RENDER_OPTIONS);`;
     - if not cancelled, `fit()` and
       `onRendered({ shown: count, total: count })` with
       `count = parts.body.querySelectorAll("section.docx").length`;
     - `catch(error => !cancelled && onFailed(error))`;
     - `fit()`: `wrapper = parts.body.querySelector<HTMLElement>(".docx-wrapper")`;
       `parts.body.style.zoom = String(Math.min(1, (parts.root.host as HTMLElement).clientWidth / Math.max(1, wrapper?.scrollWidth ?? 1)))`;
     - a `ResizeObserver` on the host calls `fit()`;
     - return a disposer setting `cancelled` and disconnecting the observer.
  2. `PptxView({ data, onRendered, onFailed })`, same shape:
     - `const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");`
     - `const controller = new AbortController();`
     - `viewer = await PptxViewer.open(data as Uint8Array, parts.body, { ...pptxViewerOptions(RECOMMENDED_ZIP_LIMITS), signal: controller.signal });`
     - then `onRendered({ shown: viewer.slideCount, total: viewer.slideCount })`;
     - the disposer runs `controller.abort(); viewer?.destroy();`.
  3. `preview-views.ts`: add `docx: lazy(() => import("./DocxView"))` and
     `pptx: lazy(() => import("./PptxView"))`.
- **Success criteria**: unit suites still green; the build passes its chunk gate.
- **Verify**:
  - `bunx vitest run src/renderer/components/preview; echo "exit=$?"` → `exit=0`
  - `bun run build 2>&1 | grep -c "index.html entry is lean"` → `1`
  - `ls out/renderer/assets | grep -cE '^(docx|pptx|jszip)-.*\.js$'` → a number ≥ `3`

### Task 4.5 — E2E red then green
- **Goal**: real docx/pptx rendering under the CSP in both shells.
- **Steps**:
  1. Red (after Task 4.3, before Task 4.4): rebuild with
     `bun run build && PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH" cargo tauri build --debug --features e2e-hooks --no-bundle`
     and run both specs. The docx/pptx cases fail with state `failed` (no view registered).
  2. Green (after Task 4.4): rebuild with the same command and run both specs again.
- **Verify**:
  - red: `scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts; echo "exit=$?"` → `exit=1`; `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` → a non-zero `exit=` value
  - green: both commands → `exit=0`
  - `scripts/virtual-display.sh stop; echo "exit=$?"` → `exit=0`

### Task 4.6 — Commit
- **Steps**: biome on touched files (exit 0); commit
  `feat(preview): show Word documents and slide decks in the preview pane`.
- **Verify**: `git status --porcelain -- src e2e e2e-tauri package.json bun.lock vite.renderer.shared.ts scripts | wc -l` → `0`.

## Verification

- `bunx vitest run; echo "exit=$?"` → `exit=0`
- `bun run check:types; echo "exit=$?"` → `exit=0`
- `bun run build 2>&1 | grep -c "index.html entry is lean"` → `1`
- `grep -c "renderAltChunks: false" src/renderer/components/preview/office-options.ts` → `1`
- `grep -rc "dangerouslySetInnerHTML" src/renderer/components/preview | grep -v ":0" | wc -l` → `0`
- Both e2e commands → `exit=0`

## Risks & Rollback

- **Risk (Med × Med)**: the pptx renderer's `IntersectionObserver` or `fitMode: "contain"`
  misbehaves inside a shadow root. The e2e shows `failed` or `total` 0. That is a Failure
  Protocol stop; do not drop the shadow root on your own (isolation is a hard constraint).
- **Risk (Low × Med)**: `docx-preview` CSS (`.docx-wrapper` padding and grey background)
  looks off in the dark theme. Cosmetic; only the `:host` background is ours.
- **Risk (Low × Low)**: `zoom` on the shadow body is non-standard, but both engines support
  it. If the e2e shows overflow, it is still readable (horizontal scroll).
- **Rollback**: `git revert <phase commit>`. docx/pptx fall back to `preview.unsupported`.

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

=== FILE: phase-05-entry-points-and-release-gate.md ===
---
phase: 5
title: "Entry points and release gate"
status: pending
priority: P2
effort: "4h"
dependencies: [4]
---
# Phase 5: Entry points and release gate

## Goal

Make every output and input file one click from the preview: a **Preview** button on office
cards, a Preview icon on Write cards, and click-to-preview on attachment cards (composer and
sent bubble). Markdown links and the Files panel were already wired in Phase 2. Then record
the feature in the changelog and run the full gate, including a manual side-by-side check on
the virtual display.

## Files to Create / Modify

Modify:
- `src/renderer/components/tools/OfficeFileRenderer.tsx`, `OfficeFileRenderer.test.tsx`
- `src/renderer/components/tools/WriteRenderer.tsx`, `WriteRenderer.test.tsx`
- `src/renderer/components/attachments/AttachmentCard.tsx`, `AttachmentCard.test.tsx`
- `src/renderer/locales/en.ts`, `vi.ts`
- `CHANGELOG.md` (`## [Unreleased]` → new `### Added`)

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| previews the finished file beside the chat | `OfficeFileRenderer.test.tsx` | no `Preview` button | store has `filePreviewPath === REPORT`, `panelTab === "preview"`, `panelVisible` |
| existing "opens the file, and its folder, through the shell" | same | — | still green (buttons found by text) |
| previews the written file | `WriteRenderer.test.tsx` | no button labelled `Preview a.md` | store path equals the resolved path |
| offers no preview for a file type the pane cannot show | same | — | no such button for `song.mp3` |
| opens a previewable attachment in the preview pane | `AttachmentCard.test.tsx` | no button | store path equals card path |
| offers no preview for an unsupported attachment | same | — | no button for `a.zip` |
| offers no preview without a path | same | — | no button |

## Tasks

### Task 5.1 — Red: entry-point tests
- **Goal**: failing tests for the three new buttons.
- **Target files and symbols**: the three test files.
- **Steps**:
  1. In each file, add to `afterEach`:
     `useUiStore.setState({ filePreviewPath: null, filePreviewRevision: 0, panelTab: "files", panelVisible: false })`.
  2. Office: mount `getToolRenderer("office_report")` with `reportResult()` (existing
     helpers), find the `button` whose `textContent === "Preview"`, click it, and assert the
     store.
  3. Write: mount the Write renderer with `args: { path: "a.md", content: "# A" }` (follow
     the existing cases' props) and find
     `button[aria-label="Preview a.md"]`. Then `song.mp3` → `null`.
  4. AttachmentCard: `<AttachmentCard name="r.docx" kind="word" path="/home/u/r.docx" />` →
     `button[aria-label="Preview r.docx"]`; click → store. `name="a.zip" kind="archive" path="/x/a.zip"`
     → no such button. `name="r.docx"` without a path → no button.
- **Success criteria**: new cases fail; existing cases pass.
- **Verify**: `bunx vitest run src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/WriteRenderer.test.tsx src/renderer/components/attachments/AttachmentCard.test.tsx; echo "exit=$?"` → `exit=1`.

### Task 5.2 — Green: the three entry points
- **Goal**: wire the buttons to `openFilePreview`.
- **Target files and symbols**: `OfficeFileRenderer` (button row at lines 89-96), `WriteRenderer` (after the `PathLink` at ~line 88), `AttachmentCard` (`CardPreview` area, lines 61-63), locales.
- **Steps**:
  1. Office: before the Open button add
     `<button type="button" className={buttonClass} onClick={() => useUiStore.getState().openFilePreview(office.file)}><Eye size={14} aria-hidden />{t("tools.office.preview")}</button>`.
     `Open` and `Show in folder` stay unchanged.
  2. Write: after the `PathLink`, when `previewKindOf(openPath) !== "unsupported"`, render an
     icon button `aria-label={t("tools.write.preview", { name: basename(path) })}`,
     `title` the same, `Eye size={12}`, with `onClick={event => { event.stopPropagation(); useUiStore.getState().openFilePreview(openPath); }}`
     and the same classes as the chevron toggle.
  3. AttachmentCard: when `path && previewKindOf(name) !== "unsupported"`, wrap the
     `<div className="h-[93px] …">` preview area in
     `<button type="button" aria-label={t("input.attachment.open", { name })} title={t("input.attachment.open", { name })} onClick={() => useUiStore.getState().openFilePreview(path)} className="block w-full text-left">`.
     The remove button stays a sibling (not nested).
  4. Locales (en / vi):
     - `tools.office.preview`: "Preview" / "Xem trước"
     - `tools.write.preview`: "Preview {name}" / "Xem trước {name}"
     - `input.attachment.open`: "Preview {name}" / "Xem trước {name}"
- **Success criteria**: Task 5.1 green; locales parity green.
- **Verify**: `bunx vitest run src/renderer/components/tools src/renderer/components/attachments src/renderer/locales; echo "exit=$?"` → `exit=0`.

### Task 5.3 — Changelog
- **Goal**: record the user-visible feature in its owning surface.
- **Target files and symbols**: `CHANGELOG.md` `## [Unreleased]`.
- **Steps**: add a `### Added` heading above `### Changed` with one bullet:
  `- **Preview files beside the chat**: Preview on a Word report, slide deck or spreadsheet card, a written file, an attached file or a file in the Files panel opens it read-only in a pane next to the conversation. It shows .docx, .pptx, .xlsx/.xls/.ods, .csv, .pdf, images and text, refreshes when the assistant finishes a turn, and offers Open externally for anything else.`
- **Verify**: `grep -c "Preview files beside the chat" CHANGELOG.md` → `1`.

### Task 5.4 — Full gate
- **Goal**: every repository gate passes on the finished feature.
- **Steps**: run each Verify command in order; stop at the first mismatch.
- **Verify**:
  - `bunx vitest run; echo "exit=$?"` → `exit=0`
  - `bun run check:types; echo "exit=$?"` → `exit=0`
  - `bunx biome check src/renderer/components/preview src/renderer/components/tools/OfficeFileRenderer.tsx src/renderer/components/tools/WriteRenderer.tsx src/renderer/components/attachments/AttachmentCard.tsx src/renderer/components/layout/PanelContainer.tsx src/renderer/components/layout/inspector-layout.ts src/renderer/components/panels/FilesPanel.tsx src/renderer/stores/ui.ts src/renderer/lib src/main/fs-read-document.ts src/main/ipc.ts src/shared e2e/preview-fixtures.ts e2e/document-preview.e2e.ts e2e-tauri/document-preview.e2e.ts vite.renderer.shared.ts scripts/check-renderer-chunks.ts; echo "exit=$?"` → `exit=0`
  - `~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings; echo "exit=$?"` → `exit=0`
  - `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --all-features; echo "exit=$?"` → `exit=0`
  - `bun scripts/check-test-parity.ts services; echo "exit=$?"` → `exit=0`
  - `bash scripts/check-module.sh snapshots 2>&1 | tail -1` → `check-module snapshots: PASS`
  - `bun run build 2>&1 | grep -c "index.html entry is lean"` → `1`
  - CSP untouched: `grep -lF "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:" src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json | wc -l` → `3` (each file matched once on 2026-10-07)

### Task 5.5 — Manual side-by-side check (virtual display)
- **Goal**: confirm the docked layout at a common width in the Tauri shell.
- **Steps**:
  1. `export WORKDIR=$(mktemp -d) && bun -e 'import("./e2e/preview-fixtures.ts").then(m => m.writePreviewFixtures(process.env.WORKDIR))'`
     → `ls "$WORKDIR"` lists `sample.docx`.
  2. Start the app with the harness's background facility (note the PID):
     `scripts/virtual-display.sh run -- bun run dev:tauri -- --user-data-dir=$(mktemp -d) "$WORKDIR"`.
     [UNVERIFIED] the trailing positional argument opens `$WORKDIR` as the project, as it
     does for the e2e launcher (`e2e-tauri/session.ts` `LaunchOptions.args`). If it does
     not, open `$WORKDIR` through the app's project picker.
  3. Open a second tab, split the workspace (tab menu → split right), open the workspace
     drawer (title-bar button "Open workspace") and click `sample.docx` in Files.
  4. `scripts/virtual-display.sh shot test-results/preview-split.png`.
  5. Close the app, stop the process you started, and run `scripts/virtual-display.sh stop`.
- **Success criteria**: the screenshot shows both chat panes and the docked preview with
  rendered pages; the preview does not cover any composer.
- **Verify**: `scripts/virtual-display.sh status; echo "exit=$?"` lists nothing still
  running for this task; record the screenshot path in the phase report. The visual result
  is the user's acceptance call: report it, do not judge it yourself.

### Task 5.6 — Commit
- **Steps**: commit `feat(preview): open files in the preview from cards and attachments`.
- **Verify**: `git status --porcelain -- src CHANGELOG.md | wc -l` → `0`.

## Verification

All Task 5.4 commands pass, and the Task 5.5 screenshot is attached to the phase report.

## Risks & Rollback

- **Risk (Low × Low)**: a button inside `AttachmentCard`'s `<figure role="listitem">`
  changes keyboard order. The remove button stays reachable; the new button comes first,
  which is the natural order.
- **Risk (Low × Med)**: the Write card's new icon competes with the disclosure toggle.
  `stopPropagation` keeps the toggle from firing.
- **Rollback**: `git revert <phase commit>` removes only the entry points. The pane still
  opens from the Files panel and markdown links.

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
