=== FILE: plan.md ===
---
title: "Side-by-side document preview"
description: "Open a read-only preview of a docx, pptx, xlsx, csv, pdf, image or text file in the workspace drawer next to the conversation, from tool cards, attachment cards, markdown links and the Files panel."
status: pending
priority: P2
effort: 26h
branch: main
tags: [frontend, renderer, tauri, electron, ipc, preview, tdd]
blockedBy: [261007-1931-drop-file-attachment-cards]
blocks: []
created: 2026-10-07
---

# Side-by-side document preview

## Outcome

Inside the Sai ATLAS window, the user opens a read-only preview of a file in the
right-hand workspace drawer while the conversation stays visible and usable to
its left. Previews open from:

- **Output files:** a **Preview** button on the office cards (`office_report`
  .docx, `office_slides` .pptx, `office_clean` .xlsx) and on the Write tool
  card, plus local-file links in model markdown (these already open the drawer).
- **Input files:** attachment cards (composer and sent bubble) and files in
  the workspace Files panel.

Formats: .docx (laid out by docx-preview), .pptx (laid out by
@aiden0z/pptx-renderer), .xlsx/.xls/.ods/.csv (a table built from SheetJS),
.pdf (pdf.js canvases), images (png, jpg, jpeg, webp, gif, bmp, svg, through the
existing `fs:read-image`), markdown and plain text (today's Files preview). Any
other kind of file (legacy .doc/.ppt, audio, video, archives) shows its type and
an **Open in system app** button.

## Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Surface | Reuse the **Files tab preview** of the existing drawer (`filePreviewPath`), not a new tab or pane. Whenever a file preview is open, the drawer **docks** as a flex sibling. That includes split workspaces and windows ≤1000 px, where it overlays today. On opening, the drawer widens to at least 560 px and is clamped so the conversation keeps ≥400 px. | Every entry point already funnels into `openFilePreview(path)` (`src/renderer/stores/ui.ts:191`, `src/renderer/lib/markdown.tsx:185`, `FilesPanel.tsx:157`). One surface means no second resizable pane, no new persisted pref, and the header already has back, Open externally and @mention. Docking while previewing is what makes the preview side by side in the two layouts where the drawer overlays today (`PanelContainer.tsx:127`). |
| D2 | Byte transport | One new command, **`fs:read-document`**: `{ path, tabId? }` → `{ ok, data(base64), kind: "pdf" \| "zip" \| "ole", size, error? }`. Relative paths are workspace-confined, while absolute and `~/` paths are read as given (the same policy as `fs:read-image` and `fs:read`). The handler checks a magic number (`%PDF-`, `PK\x03\x04`, OLE `D0 CF 11 E0 A1 B1 1A E1`), enforces a 32 MiB cap and never throws. Text and CSV keep using `fs:read`, and images keep using `fs:read-image`. | It is generic, so one command covers every binary format. The kind is sniffed in the main process, so the renderer refuses a misnamed file before any parser sees it. The sibling plan's `fs:read-pdf` (`src/main/fs-read-pdf.ts`) stays as is, because it serves attachment thumbnails with an absolute-only contract the user already accepted; the preview needs workspace-relative paths, which that contract refuses. The 32 MiB cap matches `FS_PDF_MAX_BYTES`. |
| D3 | Isolation | docx and pptx render into an **open shadow root** on a host `<div>`, with hardened library options (docx: `renderAltChunks:false`, `useBase64URL:true`; pptx: `RECOMMENDED_ZIP_LIMITS`, `pdfjs:false`). One capture-phase click interceptor sends only `http`, `https` and `mailto` links to `system.openExternal`; every other link is swallowed. PDF renders canvases only (no annotation or text layer, so it has no links). Sheets render as a React table, so text is escaped. Nothing uses `dangerouslySetInnerHTML`. The CSP is **unchanged**. | The research (§Cross-cutting security) shows a sandboxed iframe adds no script protection beyond `script-src 'self'`, because the libraries need script in the frame, and it complicates sizing. The CSP already blocks inline script, remote images, beacons and remote fonts. `useBase64URL` keeps embedded fonts and images inside `data:`, which `font-src` and `img-src` allow. |
| D4 | Entry points | Office card **Preview** button; Write card **Preview** icon button; attachment card click (the preview area becomes a button when the card has a `path`); markdown file links (already wired); Files panel tree (already wired). | This covers both output and input files, and every entry point calls the one existing store action. |
| D5 | Large, corrupt and unsupported files | Bytes ≤32 MiB (IPC), CSV ≤2 MB (the `fs:read` cap, with a truncation note), PDF ≤300 pages (lazy per-page render), sheets ≤500 rows × 50 columns per sheet (with a note), pptx `lazySlides`. A container that does not match the extension shows "not a valid {format} file". A renderer that throws, or is not ready after 30 s, shows "Couldn't show this file here". Every error and unsupported state carries **Open in system app**. | Each cap bounds memory in a 360–840 px drawer. The DOM never holds 100k table cells, and a zip bomb or a broken file degrades to the system app instead of a frozen window. |
| D6 | Staleness | `filePreviewSeq` in the ui store. `openFilePreview` always bumps it, so clicking Preview again re-reads the file even when the path is unchanged. A **Reload** button in the drawer header bumps it. When a Write call or an office call finishes for the path being previewed, the preview reloads (`refreshFilePreviewFor`). | Office tools never overwrite (`writeUnique`, `assistant-pack/src/office/output.ts:131`), so staleness mostly comes from Write and hand edits. A watcher IPC in both shells would cost far more than these three triggers. |
| D7 | Libraries | `pdfjs-dist` 6.4.299 (already added by the sibling plan), `docx-preview` 0.4.1 (exact pin), `@aiden0z/pptx-renderer` 1.3.0 (exact pin), and SheetJS CE 0.20.3 vendored as `vendor/xlsx-0.20.3.tgz`. Each gets its own lazy chunk: `pdfjs`, `docx-preview`, `pptx`, `xlsx`, `jszip`. No fallback renderers (mammoth, a JSZip slide extractor): a render failure falls back to the system app. | Follows the researcher's recommendations. Dropping the secondary renderers is the research's own KISS option for docx, applied to pptx too; it is flagged below as a question for the user. |
| D8 | Coordination with `261007-1931-drop-file-attachment-cards` | This plan starts **after that plan lands** (blockedBy). Work in progress for it touches the same files: `ipc-types.ts`, `create-omp-api.ts`, `ipc.ts`, `services/ipc.rs`, `services/mod.rs`, `channels.rs`, locales and `package.json`. This plan extracts the sibling's private `loadPdfJs()` from `src/renderer/lib/pdf-thumbnail.ts` into a shared `src/renderer/lib/pdfjs.ts`, so both features configure one worker. It also moves its `decodeBase64` into `src/renderer/lib/base64.ts`. Task 1.1 checks mechanically that the sibling has landed. | Starting earlier would mean parallel edits to the same files. Sharing the loader keeps one pdf.js configuration (worker, `useWasm:false`). |

## Constraints

- JavaScript rendering only; no LibreOffice, soffice or server conversion.
- Both shells: every IPC change lands in `ipc-types.ts`, `create-omp-api.ts`,
  `src/main/ipc.ts`, `src-tauri/src/services/ipc.rs`, `services/mod.rs`
  (scope table and `reg.register`), the `services.api.txt` snapshot,
  `services.parity.json` and `tests/channels.rs` (`EXPECTED_CHANNEL_COUNT`).
- The CSP stays byte-identical in `src/renderer/index.html`,
  `src/renderer/quick-entry.html` and `src-tauri/tauri.conf.json`.
- Heavy libraries are dynamic-imported and get a chunk rule in
  `vite.renderer.shared.ts` (`VENDOR_CHUNK_RULES`) plus an entry in
  `scripts/check-renderer-chunks.ts` (`LAZY_CHUNKS`).
- i18n: every new string in `en.ts` and `vi.ts`. Tests use the linkedom
  harness, reset stores in `afterEach` and never call `mock.module()`.
- Follow the monorepo TS style: no `any`, no inline imports.
- Commits go to this repo with conventional messages; no plan or phase IDs in
  code, test names or commit messages.

## Non-goals

- Editing, annotating, converting or saving documents.
- Previewing audio, video, archives or legacy .doc/.ppt beyond their type and
  Open in system app.
- More than one previewed file at a time; preview tabs.
- A file watcher.
- Text selection or search inside PDF and slide previews.

## Phases

| # | Phase | Owns | Depends on | Status |
|---|---|---|---|---|
| 1 | [Document byte read in both shells](phase-01-document-byte-read.md) | `src/main/fs-read-document.ts` (+test), `src/main/workspace-path.ts`, `src/main/ipc.ts`, `src/shared/ipc-types.ts`, `src/shared/bridge/create-omp-api.ts` (+test), `src-tauri/src/services/{ipc,mod}.rs`, `src-tauri/tests/channels.rs`, `src-tauri/contracts/services.{api.txt,parity.json}` | sibling plan landed | pending |
| 2 | [Drawer docks beside the chat while previewing](phase-02-drawer-docks-while-previewing.md) | `src/renderer/stores/ui.ts`, new `src/renderer/stores/ui-file-preview.test.ts`, new `src/renderer/components/layout/panel-layout.ts` (+test), `PanelContainer.tsx` (+test), `src/renderer/App.tsx` | none (runs in parallel with 1) | pending |
| 3 | [Preview router and Files panel integration](phase-03-preview-router.md) | new `src/renderer/components/preview/{preview-kind,safe-links,use-preview-source}.ts`, `FilePreviewBody.tsx`, `PreviewMessage.tsx` (+tests), `FilesPanel.tsx`, locales | 1, 2 | pending |
| 4 | [PDF and spreadsheet renderers](phase-04-pdf-and-sheet-renderers.md) | `src/renderer/lib/{pdfjs,base64}.ts`, `src/renderer/lib/pdf-thumbnail.ts`, new `preview/{PdfPreview,SheetPreview,SheetTable}.tsx`, `preview/sheet-model.ts` (+tests), `package.json`, `bun.lock`, `vendor/`, `vite.renderer.shared.ts`, `scripts/check-renderer-chunks.ts`, new `e2e-tauri/document-preview.e2e.ts`, `e2e-tauri/check-twins.ts` | 3 | pending |
| 5 | [Word and PowerPoint renderers](phase-05-docx-and-pptx-renderers.md) | new `preview/{DocxPreview,PptxPreview,ShadowHost}.tsx`, `preview/render-options.ts` (+test), `FilePreviewBody.tsx` (renderer map), `package.json`, `bun.lock`, `vite.renderer.shared.ts`, `scripts/check-renderer-chunks.ts`, `e2e-tauri/document-preview.e2e.ts` | 4 | pending |
| 6 | [Entry points, auto-reload and docs](phase-06-entry-points-and-docs.md) | `OfficeFileRenderer.tsx` (+test), `WriteRenderer.tsx` (+test), `AttachmentCard.tsx` (+test), new `src/renderer/hooks/use-refresh-file-preview.ts`, locales, `CHANGELOG.md`, `README.md`, `README.vi.md` | 5 | pending |

Phases 1 and 2 touch disjoint files and may run in parallel. Phases 3 to 6 run
in order.

## Shared contracts (fixed now)

```ts
// src/shared/ipc-types.ts (phase 1)
IPC_COMMANDS.FS_READ_DOCUMENT = "fs:read-document"
export type IpcDocumentKind = "pdf" | "zip" | "ole";
export interface IpcFsReadDocumentPayload { path: string; tabId?: string }
export interface IpcFsReadDocumentResult { ok: boolean; data?: string /* base64 */; kind?: IpcDocumentKind; size: number; error?: string }
// OmpApi["fs"]
readDocument(path: string, tabId?: string): Promise<IpcFsReadDocumentResult>;

// Error strings (identical in Electron and Rust):
// "Invalid path" | "No workspace" | "Path escapes the workspace" | "Not a file"
// | "Document too large" | "Not a supported document" | <io error text>

// src/renderer/stores/ui.ts (phase 2)
filePreviewSeq: number;                          // bumps on every open/reload
refreshFilePreview(): void;
refreshFilePreviewFor(path: string): void;       // bumps only when it names the open preview
export function samePreviewPath(previewPath: string, writtenPath: string): boolean;

// src/renderer/components/layout/panel-layout.ts (phase 2)
export const PANEL_MIN_WIDTH = 360, PANEL_MAX_WIDTH = 840;
export const PREVIEW_MIN_WIDTH = 560, PREVIEW_FLOOR_WIDTH = 320, CHAT_MIN_WIDTH = 400;
export function shouldDockPanel(state: { compact: boolean; split: boolean; previewing: boolean }): boolean;
export function openingPreviewWidth(preferred: number, rowWidth: number): number;
export function fitPreviewWidth(width: number, rowWidth: number): number;

// src/renderer/components/preview (phase 3)
export type PreviewKind = "pdf" | "docx" | "pptx" | "sheet" | "csv" | "image" | "markdown" | "text" | "unsupported";
export function previewKindOf(path: string): PreviewKind;
export const EXPECTED_CONTAINERS: Readonly<Record<"pdf" | "docx" | "pptx" | "sheet", readonly IpcDocumentKind[]>>;
export type PreviewSource = { type: "bytes"; bytes: Uint8Array } | { type: "text"; text: string; truncated: boolean };
export interface DocumentViewProps { source: PreviewSource; path: string; onReady(): void; onError(error: unknown): void }
export type DocumentRenderers = Partial<Record<"pdf" | "docx" | "pptx" | "sheet", ComponentType<DocumentViewProps>>>;
export function safeExternalHref(href: string | null): string | null;          // http, https, mailto only
export function interceptLinks(host: HTMLElement, open: (href: string) => void): () => void;
// DOM contract for e2e: <div data-file-preview data-kind={PreviewKind} data-state="loading"|"ready"|"error">
```

## Acceptance criteria

1. At 1280 and 1920 px wide, with the sidebar shown, opening a preview docks the
   drawer: the composer textarea's right edge ≤ the drawer's left edge, and the
   composer still accepts typing. This also holds with a split workspace and
   at 1000 px (`panel-layout.test.ts` and the e2e geometry check).
2. In the Tauri e2e (embedded assets, real CSP), a generated `report.docx`
   (from `buildReport` on `assistant-pack/test/fixtures/notes-en.md`), a
   `deck.pptx` (from `buildSlides` on `report-shapes.md`), a `table.xlsx`
   (exceljs), `sample.pdf`, `notes.csv` and `pixel.png` each reach
   `data-state="ready"` with their expected content, with zero
   `securitypolicyviolation` events.
3. The office card, Write card, attachment card, markdown link and Files tree
   each open the drawer on that file (unit tests per entry point).
4. A corrupt `.docx` (`PK` signature but no Word parts), a `.docx` that is
   really a PDF, a 33 MiB file and an `.mp3` each show an error or unsupported
   message with a working **Open in system app** button.
5. A Write to the previewed path reloads the preview. The Reload button and
   re-clicking Preview re-read the file (`fs.read` or `fs.readDocument` is
   called again).
6. A document link to `javascript:`, `file:` or a relative URL does nothing; an
   `https:` link goes to `system.openExternal` (`safe-links.test.ts`).
7. `bun run build` passes `check-renderer-chunks` with `pdfjs`, `docx-preview`,
   `pptx`, `xlsx` and `jszip` listed as lazy.
8. Every gate below passes; the CSP strings are unchanged (`git diff --quiet
   -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json`).

## Risks

| Risk | L×I | Mitigation |
|---|---|---|
| A library trips the CSP or needs a newer engine on SAI OS's WebKitGTK | M×H | Each renderer phase runs the Tauri e2e under the real CSP before it is green. pdf.js is configured with `useWasm:false`. Q1 asks for SAI OS's WebKitGTK version (pdf.js legacy build if it is older than about 2.48). |
| `@aiden0z/pptx-renderer` API differs from the research summary | M×M | Task 5.1 checks the installed `.d.ts` for each symbol before any code; a mismatch stops the phase through the Failure Protocol. |
| Base64 over IPC for a 32 MiB file (about 43 MB of JSON) is slow in Tauri | M×L | The cap bounds it; a loading spinner shows; the 30 s render timeout falls back to Open in system app. |
| Zip bomb in docx (docx-preview has no zip limits) | L×M | 32 MiB compressed cap, 30 s timeout, `PanelErrorBoundary` per drawer tab (`PanelContainer.tsx:166`). |
| Sibling plan not landed or cancelled | M×H | Task 1.1 gate. If the sibling is cancelled, see Q5. |
| Docking in a split workspace squeezes the panes | M×L | Only while a preview is open; the user can close or narrow it; `CHAT_MIN_WIDTH` keeps 400 px for the conversation row. |

## Validation commands

```bash
bunx vitest run
bun run check:types
bunx biome check <touched files>
bun run build
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features
bun scripts/check-test-parity.ts services
bash scripts/check-module.sh snapshots
bun e2e-tauri/check-twins.ts
bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo tauri build --debug --features e2e-hooks --no-bundle'
scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec ./e2e-tauri/document-preview.e2e.ts
```

## Unresolved questions (defaults chosen; confirm or override)

1. What WebKitGTK version does SAI OS ship? Default: the modern pdf.js build
   (dev host 2.52.6). If it is older than about 2.48, swap in
   `pdfjs-dist/legacy/build` in `src/renderer/lib/pdfjs.ts`.
2. Is vendoring the SheetJS tarball (`vendor/xlsx-0.20.3.tgz`) acceptable under
   repo policy? Default: yes, because npm only has the vulnerable 0.18.5. The
   alternative is `exceljs` (already a devDependency, styled cells, 263 KB gz,
   unmaintained since 2023).
3. Are styled spreadsheet cells (fills, bold headers) required? Default: no.
   SheetJS CE shows formatted values, merges and formulas without styles.
4. Should docx and pptx keep a secondary renderer (mammoth; a JSZip
   text-and-images slide list) for files the primary library cannot render?
   Default: no. A failure shows Open in system app.
5. If `261007-1931-drop-file-attachment-cards` is cancelled instead of landed,
   this plan must own `pdfjs-dist` and write `lib/pdfjs.ts` fresh, and Task 6.3
   (attachment-card entry point) has no card to attach to. Default: wait for
   the sibling.
6. Should the drawer width the preview widens to (≥560 px) also be remembered
   as the drawer's width after the preview closes? Default: yes, because the
   existing `gui.panelWidth` pref persists whatever width the drawer has.

=== FILE: phase-01-document-byte-read.md ===
---
phase: 1
title: "Document byte read in both shells"
status: pending
priority: P1
effort: "4h"
dependencies: []
---
# Phase 1: Document byte read in both shells

## Goal

Add the `fs:read-document` IPC command to the Electron and Tauri shells with
identical behavior. It returns a binary document's bytes as base64 plus a
sniffed container kind (`pdf`, `zip`, `ole`), confines relative paths to the
workspace, accepts absolute and `~/` paths, and caps the size at 32 MiB.

## Files to Create / Modify

- Create: `src/main/workspace-path.ts`, `src/main/fs-read-document.ts`, `src/main/fs-read-document.test.ts`
- Modify: `src/main/ipc.ts`, `src/shared/ipc-types.ts`, `src/shared/bridge/create-omp-api.ts`, `src/shared/bridge/create-omp-api.test.ts`
- Modify: `src-tauri/src/services/ipc.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/tests/channels.rs`, `src-tauri/contracts/services.api.txt`, `src-tauri/contracts/services.parity.json`

Line numbers below come from the 2026-10-07 working tree. The sibling plan is
still editing these files, so re-grep each symbol before editing.

## Test Matrix (TDD)

| Case (exact test name) | TS file | Rust twin (`src-tauri/src/services/ipc.rs` tests) | Red → Green |
|---|---|---|---|
| reads a docx as a zip document | `src/main/fs-read-document.test.ts` | `reads_a_docx_as_a_zip_document` | module missing → passes |
| reads a pdf as a pdf document | same | `reads_a_pdf_as_a_pdf_document` | same |
| reads an xls as an ole document | same | `reads_an_xls_as_an_ole_document` | same |
| resolves a relative document path inside the workspace | same | `resolves_a_relative_document_path_inside_the_workspace` | same |
| refuses a relative document path that escapes the workspace | same | `refuses_a_relative_document_path_that_escapes_the_workspace` | same |
| refuses a relative document path without a workspace | same | `refuses_a_relative_document_path_without_a_workspace` | same |
| expands a home-relative document path | same | `expands_a_home_relative_document_path` | same |
| refuses an empty document path | same | `refuses_an_empty_document_path` | same |
| refuses a document path that is a directory | same | `refuses_a_document_path_that_is_a_directory` | same |
| refuses a document over the size cap | same | `refuses_a_document_over_the_size_cap` | same |
| refuses a file with no document signature | same | `refuses_a_file_with_no_document_signature` | same |
| reads a document through fs:read-document | `src/shared/bridge/create-omp-api.test.ts` | (bridge only, not parity-mapped) | `api.fs.readDocument` undefined → passes |

## Tasks

### Task 1.1: Confirm the sibling plan has landed
- **Goal:** do not start while `261007-1931-drop-file-attachment-cards` is editing the same files.
- **Target files and symbols:** `src/shared/ipc-types.ts` (`FS_READ_PDF`), `src/renderer/lib/pdf-thumbnail.ts`, `src/renderer/components/attachments/AttachmentCard.tsx`, `src-tauri/src/services/ipc.rs` (`fs_read_pdf`).
- **Steps:**
  1. Run each Verify command.
- **Success criteria:** the sibling's contract exists and its work is committed.
- **Verify:**
  - `grep -c '"fs:read-pdf"' src/shared/ipc-types.ts` prints `1`.
  - `grep -c "pub fn fs_read_pdf" src-tauri/src/services/ipc.rs` prints `1`.
  - `test -f src/renderer/lib/pdf-thumbnail.ts && test -f src/renderer/components/attachments/AttachmentCard.tsx; echo $?` prints `0`.
  - `git status --porcelain -- src src-tauri | wc -l` prints `0`.

### Task 1.2: Write the failing TS tests
- **Goal:** pin the contract before code.
- **Target files and symbols:** create `src/main/fs-read-document.test.ts`, importing `readDocumentFile` and `FS_DOCUMENT_MAX_BYTES` from `./fs-read-document`.
- **Steps:**
  1. Model the file on `src/main/fs-read-pdf.test.ts`: `mkdtemp` under `os.tmpdir()` in `beforeEach`, removed in `afterEach`.
  2. Define the fixtures as byte constants:
     - `ZIP = Buffer.from("PK\x03\x04rest-of-zip", "latin1")`
     - `PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\n", "latin1")`
     - `OLE = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0,0])`
  3. Write the 11 `it(...)` cases with the exact names in the Test Matrix. Expected values:
     - **Success:** `{ ok: true, data: <bytes>.toString("base64"), kind: "zip"|"pdf"|"ole", size: <bytes>.length }`.
     - **Relative path inside:** call `readDocumentFile("docs/a.docx", { cwd: dir })` after writing `dir/docs/a.docx`; expect `ok: true` and `kind: "zip"`.
     - **Escape:** `readDocumentFile("../a.docx", { cwd: dir })` returns `{ ok:false, size:0, error:"Path escapes the workspace" }`.
     - **No workspace:** `readDocumentFile("a.docx", { cwd: null })` returns `{ ok:false, size:0, error:"No workspace" }`.
     - **Home:** `readDocumentFile("~/Documents/a b.docx", { homeDir: dir })` returns `ok: true`.
     - **Empty path:** `readDocumentFile("")` and `readDocumentFile(undefined)` each return `{ ok:false, size:0, error:"Invalid path" }`.
     - **Directory:** returns `{ ok:false, size:0, error:"Not a file" }`.
     - **Over the cap:** write `ZIP` with `maxBytes: 4`; returns `{ ok:false, size:ZIP.length, error:"Document too large" }`.
     - **No signature:** a file containing `hello`; returns `{ ok:false, size:5, error:"Not a supported document" }`.
- **Success criteria:** the file exists with 11 cases and fails because the module does not exist.
- **Verify:** `bunx vitest run src/main/fs-read-document.test.ts; echo "exit=$?"` prints a line containing `fs-read-document` with `FAIL` and ends with `exit=1`.

### Task 1.3: Extract `resolveWithin` and implement `readDocumentFile`
- **Goal:** make the TS tests pass and share the workspace resolver.
- **Target files and symbols:**
  - `src/main/ipc.ts:241` `resolveWithin` (moves).
  - New `src/main/workspace-path.ts`, exporting `resolveWithin`.
  - New `src/main/fs-read-document.ts`, exporting `FS_DOCUMENT_MAX_BYTES`, `sniffDocumentKind` and `readDocumentFile`.
- **Steps:**
  1. **Move the resolver.** Cut the `resolveWithin` function (doc comment plus body, `ipc.ts` lines 240–246) into `src/main/workspace-path.ts` as `export function resolveWithin(root: string, rel: string): string | null`, with `import path from "node:path"`. In `ipc.ts` add `import { resolveWithin } from "./workspace-path";` beside the other `./` imports. Leave every existing caller unchanged.
  2. **Write `fs-read-document.ts`,** mirroring `src/main/fs-read-pdf.ts`:
     - `export const FS_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;`
     - `export function sniffDocumentKind(header: Uint8Array): IpcDocumentKind | null` returns:
       - `"pdf"` when the first 5 bytes are `%PDF-`;
       - `"zip"` when the first 4 bytes are `50 4B 03 04`;
       - `"ole"` when the first 8 bytes are `D0 CF 11 E0 A1 B1 1A E1`;
       - otherwise `null`.
     - `export async function readDocumentFile(rawPath: unknown, options: { cwd?: string | null; homeDir?: string; maxBytes?: number } = {}): Promise<IpcFsReadDocumentResult>` checks in this order:
       1. A non-string or empty path fails with `"Invalid path"`.
       2. Expand `~/` against `options.homeDir ?? os.homedir()`.
       3. If the path is absolute, normalize it. If it is relative and `cwd` is missing, fail with `"No workspace"`; otherwise call `resolveWithin(cwd, raw)`, and a `null` result fails with `"Path escapes the workspace"`.
       4. `stat`; a non-file fails with `"Not a file"`.
       5. A size above `maxBytes ?? FS_DOCUMENT_MAX_BYTES` fails with `"Document too large"` and `size: stat.size`.
       6. `readFile`, then `sniffDocumentKind(bytes.subarray(0, 8))`. `null` fails with `"Not a supported document"` and `size: bytes.length`.
       7. Return `{ ok: true, data: base64, kind, size }`.
       8. Any caught error returns `fail(message)`.
     - Failure objects are `{ ok: false, size, error }`, with no `data` or `kind`.
  3. Add the types (`IpcDocumentKind`, `IpcFsReadDocumentPayload`, `IpcFsReadDocumentResult`) to `src/shared/ipc-types.ts` directly after `IpcFsReadPdfResult` (currently line 750), exactly as in plan.md › Shared contracts.
- **Success criteria:** all 11 TS tests pass and `ipc.ts` still compiles.
- **Verify:**
  - `bunx vitest run src/main/fs-read-document.test.ts; echo "exit=$?"` output contains `11 passed` and ends with `exit=0`.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 1.4: Wire the command through types, bridge and the Electron handler (bridge test first)
- **Goal:** `window.omp.fs.readDocument` reaches the Electron handler.
- **Target files and symbols:**
  - `src/shared/ipc-types.ts`: `IPC_COMMANDS` (after `FS_READ_PDF`, line 190) and `OmpApi["fs"]` (after `readPdf`, line 1316).
  - `src/shared/bridge/create-omp-api.ts:365` (after `readPdf`).
  - `src/shared/bridge/create-omp-api.test.ts:188` (beside the `readPdf` case).
  - `src/main/ipc.ts:1079` (after the `FS_READ_PDF` handler).
- **Steps:**
  1. In `create-omp-api.test.ts`, add `it("reads a document through fs:read-document", …)`, copying the `readPdf` case at line 188. Call `api.fs.readDocument("docs/a.docx", "t1")` and expect the invoke record `{ channel: IPC_COMMANDS.FS_READ_DOCUMENT, args: [{ path: "docs/a.docx", tabId: "t1" }] }`. Run Verify (red).
  2. Add `/** Read a binary document (pdf, OOXML/ODF zip, OLE) as base64 with its sniffed container kind */ FS_READ_DOCUMENT: "fs:read-document",` after `FS_READ_PDF`.
  3. Add `readDocument(path: string, tabId?: string): Promise<IpcFsReadDocumentResult>;` to `OmpApi["fs"]`.
  4. In `create-omp-api.ts` add `readDocument: (path: string, tabId?: string) => port.invoke(IPC_COMMANDS.FS_READ_DOCUMENT, { path, tabId }) as Promise<IpcFsReadDocumentResult>,` and the type import.
  5. In `ipc.ts`:
     - Add `import { readDocumentFile } from "./fs-read-document";` and add `IpcFsReadDocumentPayload` to the type import block.
     - After the `FS_READ_PDF` handler, add `ipcMain.handle(IPC_COMMANDS.FS_READ_DOCUMENT, (event, payload: IpcFsReadDocumentPayload | undefined) => readDocumentFile(payload?.path, { cwd: cwdFor(deps, event, payload?.tabId) }));`, preceded by a one-line comment: "Binary document read for the in-app preview; see fs-read-document.ts for the path, cap and sniff rules."
- **Success criteria:** the bridge test is red before step 2 and green after step 5.
- **Verify:**
  - After step 1: `bunx vitest run src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 5: the same command ends with `exit=0`, and `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 1.5: Rust twin tests first, then `fs_read_document`
- **Goal:** the Tauri shell answers `fs:read-document` exactly like Electron.
- **Target files and symbols:**
  - `src-tauri/src/services/ipc.rs`: `expand_home_in` (line 22), `workspace_fs::resolve_within`, the `read_pdf_file` pattern (lines 521–565) and `mod tests` (line 589).
  - `src-tauri/src/services/mod.rs`: `CHANNELS` (line 58) and `register` (line 91).
- **Steps:**
  1. **Tests first (red).** In `mod tests` of `ipc.rs`, add the 11 `#[test]` functions named in the Test Matrix, using a helper `fn read_document(path: &str, cwd: Option<&std::path::Path>, home: Option<&std::path::Path>, max: u64) -> serde_json::Value { super::read_document_file(path, cwd, home, max) }`. Each asserts the same JSON as its TS twin:
     - success: `json!({ "ok": true, "data": base64(BYTES), "kind": "zip", "size": BYTES.len() })`;
     - failures: `json!({ "ok": false, "size": N, "error": "…" })`.

     Reuse the existing `base64` test helper. Run Verify (red).
  2. **Implement.** Add `const FS_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;` and `fn sniff_document_kind(header: &[u8]) -> Option<&'static str>` with the same three signatures. Then add `fn read_document_file(path: &str, cwd: Option<&Path>, home: Option<&Path>, max_bytes: u64) -> Value`, following the same checks in the same order as the TS module. For relative paths use `workspace_fs::resolve_within(cwd, &raw)`; `None` cwd yields `"No workspace"`.
  3. Add `pub fn fs_read_document(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply`. It reads `path` and `tabId` from the payload, computes `let cwd = ctx.tabs.cwd_for(caller, tab_id);` and returns `Reply::ok(read_document_file(path, cwd.as_deref().map(Path::new), dirs::home_dir().as_deref(), FS_DOCUMENT_MAX_BYTES))`. Give it a doc comment matching the TS module header.
  4. In `services/mod.rs`, add `("fs:read-document", Scope::Main),` after `("fs:read-pdf", Scope::Main),` and `reg.register("fs:read-document", Scope::Main, ipc::fs_read_document);` after the `fs:read-pdf` registration.
  5. In `src-tauri/tests/channels.rs:14`, raise `EXPECTED_CHANNEL_COUNT` by exactly 1 (91 → 92 at time of writing; read the current value first).
  6. In `src-tauri/contracts/services.api.txt`, insert this line directly after the `…::ipc::fs_read(` line, keeping lexical order:
     `pub fn sai_atlas_lib::services::ipc::fs_read_document(&alloc::rcs::arc::Arc<sai_atlas_lib::ctx::AppCtx>, sai_atlas_lib::ports::Caller, alloc::vec::Vec<serde_json::value::Value>) -> sai_atlas_lib::bridge::Reply`
  7. Append `{ "ts": "src/main/fs-read-document.test.ts", "rust": "src-tauri/src/services/ipc.rs" }` to `src-tauri/contracts/services.parity.json`.
- **Success criteria:** the Rust tests fail to compile before step 2 and pass after; channels, parity and snapshot gates pass.
- **Verify:**
  - After step 1: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features _document; echo "exit=$?"` output contains `cannot find function` and ends with `exit=101`.
  - After step 7, the same command shows a line `test result: ok. 11 passed` and ends with `exit=0`.
  - `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features --test channels; echo "exit=$?"` ends with `exit=0`.
  - `bun scripts/check-test-parity.ts services; echo "exit=$?"` ends with `exit=0`.
  - `bash scripts/check-module.sh snapshots; echo "exit=$?"` prints `check-module snapshots: PASS` and ends with `exit=0`.

## Verification

All of these must end with exit code 0:

- `bunx vitest run src/main src/shared`
- `bun run check:types`
- `bunx biome check src/main/workspace-path.ts src/main/fs-read-document.ts src/main/fs-read-document.test.ts src/main/ipc.ts src/shared/ipc-types.ts src/shared/bridge/create-omp-api.ts src/shared/bridge/create-omp-api.test.ts`
- `PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
- `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features`
- `bun scripts/check-test-parity.ts services`
- `bash scripts/check-module.sh snapshots`

Commit: `feat(fs): read binary documents for the in-app preview`.

## Risks & Rollback

- **Risk:** moving `resolveWithin` changes behavior. It is a pure move with no edits; `check:types` and the existing `src/main` tests catch a slip.
- **Risk:** absolute reads widen the IPC surface. This matches `fs:read` and `fs:read-image` (`src/main/ipc.ts:964`). The bytes only reach local renderers under `connect-src 'self'`, and the sniff refuses any non-document.
- **Rollback:** revert the phase commit. No renderer code calls `readDocument` until phase 3.

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

=== FILE: phase-02-drawer-docks-while-previewing.md ===
---
phase: 2
title: "Drawer docks beside the chat while previewing"
status: pending
priority: P1
effort: "3h"
dependencies: []
---
# Phase 2: Drawer docks beside the chat while previewing

## Goal

Whenever the Files tab shows a file preview, the workspace drawer docks as a
flex sibling of `<main>`, even in a split workspace or at ≤1000 px. On opening,
it widens to a readable width without squeezing the conversation below
400 px. The ui store gains the reload counter the later phases use.

## Files to Create / Modify

- Create: `src/renderer/components/layout/panel-layout.ts`, `src/renderer/components/layout/panel-layout.test.ts`, `src/renderer/stores/ui-file-preview.test.ts`
- Modify: `src/renderer/stores/ui.ts`, `src/renderer/components/layout/PanelContainer.tsx`, `src/renderer/components/layout/PanelContainer.test.tsx`, `src/renderer/App.tsx`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| docks while previewing in every layout | `panel-layout.test.ts` | module missing → pass |
| keeps today's overlay rules without a preview | `panel-layout.test.ts` | same |
| widens a narrow drawer to the preview width on opening | `panel-layout.test.ts` | same |
| keeps a wider preferred width on opening | `panel-layout.test.ts` | same |
| leaves the conversation its minimum width | `panel-layout.test.ts` | same |
| never shrinks below the floor width | `panel-layout.test.ts` | same |
| opening a preview bumps the reload counter even for the same path | `ui-file-preview.test.ts` | `filePreviewSeq` undefined → pass |
| refreshFilePreviewFor reloads only the open preview | `ui-file-preview.test.ts` | same |
| matches a relative preview path against an absolute written path | `ui-file-preview.test.ts` | same |
| docks the drawer in a split workspace while a file is previewed | `PanelContainer.test.tsx` | class `absolute` present → absent |
| overlays the drawer in a split workspace without a preview | `PanelContainer.test.tsx` | passes before and after (guards today's behavior) |

Example values for `panel-layout.test.ts` (`rowWidth` = window width minus sidebar):

| `openingPreviewWidth(preferred, rowWidth)` | Expected |
|---|---|
| (403, 1180) | 560 |
| (800, 1660) | 800 |
| (403, 740) | 340 |
| (403, 540) | 320 |

| `fitPreviewWidth(width, rowWidth)` | Expected |
|---|---|
| (700, 1000) | 600 |
| (700, 1500) | 700 |
| (700, 600) | 320 |

## Tasks

### Task 2.1: Layout rules as pure functions (tests first)
- **Goal:** decidable docking and width rules.
- **Target files and symbols:** new `src/renderer/components/layout/panel-layout.ts`; `PanelContainer.tsx:14-15` (`MIN_WIDTH`, `MAX_WIDTH`).
- **Steps:**
  1. Write `panel-layout.test.ts` with the six cases and the example values above:
     - `shouldDockPanel` truth table: previewing → `true` for all four `compact`/`split` combinations; not previewing → `true` only when `compact=false` and `split=false`.
     - Run Verify (red).
  2. Create `panel-layout.ts` exporting:
     - `PANEL_MIN_WIDTH = 360`, `PANEL_MAX_WIDTH = 840`, `PREVIEW_MIN_WIDTH = 560`, `PREVIEW_FLOOR_WIDTH = 320`, `CHAT_MIN_WIDTH = 400`;
     - `shouldDockPanel({ compact, split, previewing }) = previewing || (!compact && !split)`;
     - `openingPreviewWidth(preferred, rowWidth) = Math.max(PREVIEW_FLOOR_WIDTH, Math.min(Math.max(preferred, PREVIEW_MIN_WIDTH), PANEL_MAX_WIDTH, rowWidth - CHAT_MIN_WIDTH))`;
     - `fitPreviewWidth(width, rowWidth) = Math.max(PREVIEW_FLOOR_WIDTH, Math.min(width, rowWidth - CHAT_MIN_WIDTH))`.
  3. In `PanelContainer.tsx`, delete the local `MIN_WIDTH`/`MAX_WIDTH` constants and import `PANEL_MIN_WIDTH as MIN_WIDTH, PANEL_MAX_WIDTH as MAX_WIDTH` from `./panel-layout`.
- **Success criteria:** the tests are red, then green; the existing PanelContainer tests still pass.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/layout/panel-layout.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 3: `bunx vitest run src/renderer/components/layout/panel-layout.test.ts src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=0`.

### Task 2.2: Reload counter in the ui store (tests first)
- **Goal:** one counter that every reload trigger bumps.
- **Target files and symbols:** `src/renderer/stores/ui.ts`:
  - `filePreviewPath` (field at 44, initial value at 172);
  - `openFilePreview` (type at 98, implementation at 191);
  - `closeFilePreview` (192).
- **Steps:**
  1. Write `src/renderer/stores/ui-file-preview.test.ts` with the three store cases; `afterEach` runs `useUiStore.setState({ filePreviewPath: null, filePreviewSeq: 0, panelVisible: false, panelTab: "files" })`.
     - **Same-path reopen:** calling `openFilePreview("a.docx")` twice moves `filePreviewSeq` from 0 to 2.
     - **Targeted reload:** with `/w/a.docx` open, `refreshFilePreviewFor("/w/b.docx")` leaves the counter alone and `refreshFilePreviewFor("/w/a.docx")` bumps it by 1.
     - **Path matching:** `samePreviewPath("docs/a.md", "/work/docs/a.md")` is `true`; `samePreviewPath("/x/a.md", "/y/a.md")` is `false`; `samePreviewPath("a.md", "/w/ba.md")` is `false`.

     Run Verify (red).
  2. In `ui.ts`:
     - Add `filePreviewSeq: number;` with a doc comment ("bumps on every open or reload so the preview re-reads the same path").
     - Add `refreshFilePreview: () => void;` and `refreshFilePreviewFor: (path: string) => void;` to `UiStore`.
     - Initial value `filePreviewSeq: 0`.
     - `openFilePreview: path => set(state => ({ filePreviewPath: path, filePreviewSeq: state.filePreviewSeq + 1, panelTab: "files", panelVisible: true }))`.
     - `refreshFilePreview: () => set(state => ({ filePreviewSeq: state.filePreviewSeq + 1 }))`.
     - `refreshFilePreviewFor: path => { const current = get().filePreviewPath; if (current !== null && samePreviewPath(current, path)) get().refreshFilePreview(); }`.
     - Export `samePreviewPath(previewPath, writtenPath)`: `previewPath === writtenPath`, or (`previewPath` does not start with `/` or `~`, and `writtenPath.endsWith("/" + previewPath)`).
- **Success criteria:** the new tests pass and the existing `ui.test.ts` and `ui-panel-tab.test.ts` stay green.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/stores/ui-file-preview.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 2: `bunx vitest run src/renderer/stores; echo "exit=$?"` ends with `exit=0`.

### Task 2.3: PanelContainer docks and widens while previewing (test first)
- **Goal:** apply the rules in the drawer.
- **Target files and symbols:** `PanelContainer.tsx`:
  - the `split` selector (line 43);
  - the `className` ternary (line 127);
  - `style={{ width }}` (line 130);
  - the `clampToViewport` resize effect (lines 95–102).
- **Steps:**
  1. In `PanelContainer.test.tsx`, add two cases:
     - "docks the drawer in a split workspace while a file is previewed": seed the active tab, set `useTabsStore.setState({ split: { firstTabId: "t0", secondTabId: "t0", axis: "columns", ratio: 0.5 } })` (check the `SplitLayout` fields in `src/renderer/stores/tabs.ts` and use them exactly), set `useUiStore.setState({ panelTab: "files", panelVisible: true, filePreviewPath: "notes.md" })`, and stub `window.omp.fs.read`/`fs.list` as in the existing markdown-link test. Expect `document.querySelector("aside")?.className` not to contain `absolute`.
     - "overlays the drawer in a split workspace without a preview": the same with `filePreviewPath: null`; the className contains `absolute`.

     Run Verify (red for the first).
  2. In `PanelContainer.tsx`:
     - `const previewing = useUiStore(s => s.panelTab === "files" && s.filePreviewPath !== null);`
     - `const sidebarVisible = useUiStore(s => s.sidebarVisible);`
     - Add `function measureRowWidth(): number { const main = document.querySelector("main.omp-workspace-main"); const left = main?.getBoundingClientRect?.().left ?? 0; return Math.max(0, window.innerWidth - left); }` at module scope.
     - Add `const [rowWidth, setRowWidth] = useState(measureRowWidth);`
     - Extend the existing resize effect to also call `setRowWidth(measureRowWidth())`.
     - Add `useEffect(() => { setRowWidth(measureRowWidth()); }, [sidebarVisible, previewing]);`
     - Add `useEffect(() => { if (previewing) setWidth(current => openingPreviewWidth(current, measureRowWidth())); }, [previewing]);`
     - Replace `compact || split ? overlayClasses : "shrink-0"` with `shouldDockPanel({ compact, split, previewing }) ? "shrink-0" : overlayClasses`.
     - Set `style={{ width: previewing ? fitPreviewWidth(width, rowWidth) : width }}`.
- **Success criteria:** both new tests pass; the existing width test ("uses the available window width…", expecting `672px`) still passes because no preview is open.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=1`.
  - After step 2: the same command ends with `exit=0`.

### Task 2.4: Keep an open preview when the window shrinks to compact width
- **Goal:** the auto-hide at ≤1000 px must not close a preview the user is reading.
- **Target files and symbols:** `src/renderer/App.tsx:294` (`hideInspector`).
- **Steps:**
  1. Change the condition to `if (compact.matches && ui.panelVisible && ui.filePreviewPath === null) ui.togglePanel();`.
  2. Update the comment above the effect: "…unless a file preview is open, which docks beside the chat instead."
- **Success criteria:** the condition exists exactly once; types pass. App-level behavior is covered by the phase 4 e2e geometry check.
- **Verify:**
  - `grep -c "ui.filePreviewPath === null" src/renderer/App.tsx` prints `1`.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

## Verification

All of these must end with exit code 0:

- `bunx vitest run src/renderer/stores src/renderer/components/layout`
- `bun run check:types`
- `bunx biome check src/renderer/stores/ui.ts src/renderer/stores/ui-file-preview.test.ts src/renderer/components/layout/panel-layout.ts src/renderer/components/layout/panel-layout.test.ts src/renderer/components/layout/PanelContainer.tsx src/renderer/components/layout/PanelContainer.test.tsx src/renderer/App.tsx`

Commit: `feat(ui): dock the workspace drawer beside the chat while a file is previewed`.

## Risks & Rollback

- **Risk:** `getBoundingClientRect` is missing in linkedom. The optional call (`?.()`) falls back to `0`.
- **Risk:** the widened width persists to `gui.panelWidth` (Unresolved Q6). This is intended by default.
- **Risk:** split panes get narrow while previewing. This applies only while a preview is open.
- **Rollback:** revert the commit. The store fields are additive, and phase 3 is the first reader of `filePreviewSeq`.

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

=== FILE: phase-03-preview-router.md ===
---
phase: 3
title: "Preview router and Files panel integration"
status: pending
priority: P1
effort: "5h"
dependencies: [1, 2]
---
# Phase 3: Preview router and Files panel integration

## Goal

Replace the Files panel's text-only preview body with a router that picks the
reader and the view by file kind:

- text and markdown: today's rendering;
- images: `fs.readImage`;
- CSV text, or document bytes from `fs.readDocument`: handed to a pluggable
  per-kind renderer;
- anything else: a type message with **Open in system app**.

The router owns loading, error, container-mismatch and timeout states, the
reload counter and the `data-file-preview` DOM contract. It also adds the
shared link guard the renderers use. The real document renderers arrive in
phases 4–5. Until then the four document kinds show the unsupported message,
and the tests inject renderers.

## Files to Create / Modify

- Create in `src/renderer/components/preview/`: `preview-kind.ts`, `preview-kind.test.ts`, `safe-links.ts`, `safe-links.test.ts`, `use-preview-source.ts`, `PreviewMessage.tsx`, `FilePreviewBody.tsx`, `FilePreviewBody.test.tsx`
- Modify: `src/renderer/components/panels/FilesPanel.tsx`, `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| classifies office, pdf, sheet, csv, image, markdown, text and unsupported files | `preview-kind.test.ts` | module missing → pass |
| accepts only the containers each document kind can be | `preview-kind.test.ts` | same |
| allows only http, https and mailto links | `safe-links.test.ts` | same |
| routes an allowed link click to the opener and swallows every other link | `safe-links.test.ts` | same |
| renders markdown and reads it with the 200 KB cap | `FilePreviewBody.test.tsx` | module missing → pass |
| renders plain text as code and shows the binary notice | same | same |
| shows an image through fs.readImage | same | same |
| shows the unsupported message with an open-in-app button | same | same |
| hands document bytes to the renderer for its kind | same | same |
| refuses a document whose container does not match its extension | same | same |
| hands csv text to the sheet renderer | same | same |
| shows the read error from the shell | same | same |
| shows the render error when a renderer fails or times out | same | same |
| reads again when the reload counter changes | same | same |
| existing "opens a local markdown link inside the Files drawer" and "decodes an absolute file URL…" | `PanelContainer.test.tsx` | stay green (regression) |

## Tasks

### Task 3.1: `previewKindOf` and container expectations (tests first)
- **Goal:** one decidable mapping from path to preview kind.
- **Target files and symbols:** new `preview-kind.ts`; reuse `fileKindOf` from `src/renderer/components/attachments/file-kind.ts` (sibling; the extension table is at its lines 26–70).
- **Steps:**
  1. Write `preview-kind.test.ts`. Expected `previewKindOf` results:

     | Path | Expected |
     |---|---|
     | `a.docx` | `docx` |
     | `A.DOCX` | `docx` |
     | `deck.pptx` | `pptx` |
     | `t.xlsx` | `sheet` |
     | `t.xls` | `sheet` |
     | `t.ods` | `sheet` |
     | `t.csv` | `csv` |
     | `r.pdf` | `pdf` |
     | `p.png` | `image` |
     | `p.webp` | `image` |
     | `README.md` | `markdown` |
     | `x.mdx` | `markdown` |
     | `n.txt` | `text` |
     | `main.ts` | `text` |
     | `noext` | `text` |
     | `old.doc` | `unsupported` |
     | `old.ppt` | `unsupported` |
     | `w.odt` | `unsupported` |
     | `s.mp3` | `unsupported` |
     | `v.mp4` | `unsupported` |
     | `z.zip` | `unsupported` |

     Expected `EXPECTED_CONTAINERS`: `{ pdf: ["pdf"], docx: ["zip"], pptx: ["zip"], sheet: ["zip", "ole"] }`.

     Run Verify (red).
  2. Implement:
     - If `/\.mdx?$/i` matches, return `markdown`.
     - Otherwise switch on `fileKindOf(path)`:
       - `image` → `image`; `pdf` → `pdf`;
       - `word` → `docx` when the extension is `docx`, else `unsupported`;
       - `slides` → `pptx` when the extension is `pptx`, else `unsupported`;
       - `sheet` → `csv` when the extension is `csv`, else `sheet`;
       - `audio`, `video`, `archive` → `unsupported`;
       - `text`, `code`, `file` → `text`.
     - Export `PreviewKind`, `DocumentPreviewKind = "pdf" | "docx" | "pptx" | "sheet"`, `isDocumentKind(kind)` and `EXPECTED_CONTAINERS`.
- **Success criteria:** the table passes.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/preview/preview-kind.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 2: the same command ends with `exit=0`.

### Task 3.2: Link guard (tests first)
- **Goal:** document links can never navigate the webview.
- **Target files and symbols:** new `safe-links.ts` exporting `safeExternalHref` and `interceptLinks`.
- **Steps:**
  1. Write `safe-links.test.ts` (linkedom globals as in `ThinkingBlock.test.tsx`).
     - `safeExternalHref` returns the href for `https://x.vn/a`, `http://x.vn`, `mailto:a@b.vn`. It returns `null` for `javascript:alert(1)`, ` JAVASCRIPT:alert(1)`, `file:///etc/passwd`, `data:text/html,x`, `#top`, `docs/a.md`, `""` and `null`.
     - `interceptLinks(host, open)`: a click on a nested `<span>` inside `<a href="https://x.vn">` calls `open("https://x.vn")` once and sets `defaultPrevented`. A click on `<a href="javascript:x">` calls nothing and sets `defaultPrevented`. A click outside any anchor does not set `defaultPrevented`. After the returned disposer runs, clicks call nothing.

     Run Verify (red).
  2. Implement:
     - `safeExternalHref`: trim, parse with `new URL(href)` in a try block (relative hrefs throw, giving `null`), and allow only the protocols `http:`, `https:` and `mailto:`.
     - `interceptLinks`: add a capture-phase `click` listener on `host`. Take the path from `event.composedPath?.()`, falling back to `[event.target]`, and find the first element with `tagName === "A"`. If there is none, return. Otherwise call `event.preventDefault()`, then `event.stopPropagation()`, then `const safe = safeExternalHref(anchor.getAttribute("href")); if (safe) open(safe);`. Return the remover.
- **Success criteria:** the tests pass.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/preview/safe-links.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 2: the same command ends with `exit=0`.

### Task 3.3: Locale keys
- **Goal:** every string the preview shows exists in both languages.
- **Target files and symbols:** `src/renderer/locales/en.ts` and `vi.ts`, beside the `filesPanel.*` keys (en.ts line 1135).
- **Steps:**
  1. Add these keys to `en.ts`, and the same keys with these values to `vi.ts`:

     | Key | `en.ts` | `vi.ts` |
     |---|---|---|
     | `filePreview.refresh` | Reload preview | Tải lại bản xem trước |
     | `filePreview.open` | Preview | Xem trước |
     | `filePreview.openNamed` | Preview {name} | Xem trước {name} |
     | `filePreview.openInApp` | Open in system app | Mở bằng ứng dụng của hệ thống |
     | `filePreview.unsupported` | This kind of file can't be previewed here. | Không xem trước được loại tệp này tại đây. |
     | `filePreview.readFailed` | Couldn't read this file: {error} | Không đọc được tệp này: {error} |
     | `filePreview.corrupt` | This file doesn't look like a valid {format} file. | Tệp này có vẻ không phải là tệp {format} hợp lệ. |
     | `filePreview.renderFailed` | Couldn't show this file here. | Không hiển thị được tệp này tại đây. |
     | `filePreview.pdfPages` | Showing {shown} of {total} pages | Đang hiển thị {shown} trên {total} trang |
     | `filePreview.sheetLimit` | Showing the first {rows} of {totalRows} rows and {cols} of {totalCols} columns | Đang hiển thị {rows} trên {totalRows} hàng đầu và {cols} trên {totalCols} cột |
     | `filePreview.sheets` | Sheets | Trang tính |
     | `filePreview.textTruncated` | Only the first {kb} KB of this file are shown | Chỉ hiển thị {kb} KB đầu tiên của tệp này |
- **Success criteria:** the locale parity test passes.
- **Verify:** `bunx vitest run src/renderer/locales; echo "exit=$?"` ends with `exit=0`.

### Task 3.4: `usePreviewSource`, `PreviewMessage` and `FilePreviewBody` (tests first)
- **Goal:** the router with every non-renderer state.
- **Target files and symbols:**
  - new `use-preview-source.ts`, `PreviewMessage.tsx` and `FilePreviewBody.tsx`;
  - reuse `MarkdownRenderer` (`src/renderer/lib/markdown.tsx`), `Spinner` and `Button` (`../common`), `PathLink` (`../tools/PathLink`), and `decodeBase64`;
  - the text logic being moved: `FilesPanel.tsx:103-145` and `:228-251`.
- **Steps:**
  1. **Base64 helper.** Create `src/renderer/lib/base64.ts` exporting `decodeBase64(data: string): Uint8Array`, a verbatim copy of the body of `decodeBase64` in `src/renderer/lib/pdf-thumbnail.ts:32-37`. Phase 4 Task 4.1 removes the copy in `pdf-thumbnail.ts`. Add `src/renderer/lib/base64.test.ts` with one case: "decodes base64 into bytes" (`decodeBase64("UEsDBA==")` equals `Uint8Array.of(0x50,0x4b,3,4)`).
  2. **Router tests.** Write `FilePreviewBody.test.tsx` with the harness from `PanelContainer.test.tsx` (mount through `I18nProvider`; stub `window.omp` per test; restore it in `afterEach`). Cover the 10 cases in the matrix:
     - Mount `<FilePreviewBody path=… seq={1} renderers={…} timeoutMs={50} />`.
     - Injected renderers are small components that call `onReady()` (or `onError(new Error("x"))`) in a `useEffect` and render `<span data-test-renderer>{first byte or text}</span>`.
     - Assertions use `document.querySelector("[data-file-preview]")`: the `data-kind` and `data-state` attributes and its text.
     - The markdown case asserts `read` was called with `("notes.md", 200_000)` when no `tabId` is given (the same two-argument shape as today).
     - The CSV case asserts `read` was called with `("t.csv", 2_000_000)`.
     - The reload case re-renders with `seq={2}` and expects 2 read calls.

     Run Verify (red).
  3. **`use-preview-source.ts`.** `usePreviewSource(path, kind, seq, tabId)` returns `{ status: "loading" } | { status: "ready"; source: PreviewSource; imageUrl?: string; binary?: boolean } | { status: "error"; message: string; corrupt?: boolean }`.
     - Keep a version ref, as `FilesPanel.openPreview` does, so stale reads are ignored.
     - markdown/text: `fs.read(path, 200_000[, tabId])`, passing `tabId` only when it is defined. `binary` → `{ status: "ready", binary: true, source: { type: "text", text: "", truncated: false } }`.
     - csv: `fs.read(path, 2_000_000[, tabId])` → a text source.
     - image: `fs.readImage(path[, tabId])` → `imageUrl`.
     - document kinds: `fs.readDocument(path[, tabId])`. If `!ok`, return the error. If `EXPECTED_CONTAINERS[kind]` does not include `result.kind`, return `{ status: "error", corrupt: true }`. Otherwise return a bytes source built with `decodeBase64(result.data)`.
     - unsupported: no read.
     - Re-run when `path`, `seq` or `tabId` changes.
  4. **`PreviewMessage.tsx`.** Props `{ message: string; path: string }`. Render the message and an `Open in system app` button styled as a `PathLink` with `path`; `PathLink` already resolves relative paths in main.
  5. **`FilePreviewBody.tsx`.** Props `{ path: string; seq: number; tabId?: string; renderers?: DocumentRenderers; timeoutMs?: number }`, with `timeoutMs` defaulting to `PREVIEW_RENDER_TIMEOUT_MS = 30_000`.
     - **Wrapper:** `<div data-file-preview data-kind={kind} data-state={state} className="h-full min-h-0 overflow-auto">`.
     - **Text and markdown:** move today's markdown/`<pre>` JSX and the truncation note from `FilesPanel` (keeping the `filesPanel.truncated` and `filesPanel.binary` keys).
     - **Images:** `<img src={imageUrl} alt="" className="mx-auto block max-w-full" />`.
     - **Unsupported:** `PreviewMessage` with `filePreview.unsupported`.
     - **Read errors:** `filePreview.readFailed` with the error.
     - **Container mismatch:** `filePreview.corrupt` with `format` = the upper-case extension.
     - **Document and csv kinds:**
       - Pick `renderers?.[kind === "csv" ? "sheet" : kind] ?? DEFAULT_RENDERERS[...]`, where `DEFAULT_RENDERERS` is `{}` in this phase; phases 4–5 fill it.
       - With no renderer, show the unsupported message.
       - Render it inside `<Suspense fallback={spinner}>`, keyed by `` `${path}:${seq}` ``, with `onReady` (sets state `ready`) and `onError` (sets state `error`, `filePreview.renderFailed`).
       - Start a `setTimeout(timeoutMs)` when the source is ready. It sets the render error if the state is still `loading`; clear it on ready, error and unmount.
     - **Spinner:** show `filesPanel.reading` while loading.
- **Success criteria:** all router tests pass.
- **Verify:**
  - After step 2: `bunx vitest run src/renderer/components/preview/FilePreviewBody.test.tsx; echo "exit=$?"` ends with `exit=1`.
  - After step 5: `bunx vitest run src/renderer/components/preview src/renderer/lib/base64.test.ts; echo "exit=$?"` ends with `exit=0`.

### Task 3.5: Files panel uses the router and gains Reload
- **Goal:** the drawer shows every preview through the router.
- **Target files and symbols:** `FilesPanel.tsx`:
  - delete `PreviewState` (lines 23–28), `PREVIEW_MAX_BYTES` (21), `preview`/`previewVersion` state, `openPreview` (103–137), the preview effect (139–145), `activePreview`/`previewIsMarkdown` (188–189) and the body JSX (228–251);
  - keep the header (192–226).
- **Steps:**
  1. Add `const filePreviewSeq = useUiStore(s => s.filePreviewSeq);` and `const refreshFilePreview = useUiStore(s => s.refreshFilePreview);`.
  2. In the header, before the `PathLink`, add a button with `aria-label={t("filePreview.refresh")}`, `title` the same and a `RefreshCw` icon (size 12) that calls `refreshFilePreview`. Give it the same classes as the @mention button.
  3. Replace the body `<div className="min-h-0 flex-1 overflow-auto bg-(--omp-code-bg)">…</div>` with `<div className="min-h-0 flex-1 overflow-hidden bg-(--omp-code-bg)"><FilePreviewBody path={filePreviewPath} seq={filePreviewSeq} tabId={tabId ?? undefined} /></div>`.
  4. Remove the now-unused imports (`MarkdownRenderer`, `Spinner` if unused).
- **Success criteria:** the panel and regression tests pass, types are clean, and `FilesPanel.tsx` no longer calls `window.omp.fs.read(`.
- **Verify:**
  - `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx src/renderer/components/panels; echo "exit=$?"` ends with `exit=0`.
  - `grep -c "fs.read(" src/renderer/components/panels/FilesPanel.tsx` prints `0`.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

## Verification

All of these must end with exit code 0:

- `bunx vitest run src/renderer`
- `bun run check:types`
- `bunx biome check src/renderer/components/preview src/renderer/lib/base64.ts src/renderer/lib/base64.test.ts src/renderer/components/panels/FilesPanel.tsx src/renderer/locales/en.ts src/renderer/locales/vi.ts`
- `bun run build` (no new library yet, so the chunk guard is unchanged)

Commit: `feat(preview): route file previews by kind in the workspace drawer`.

## Risks & Rollback

- **Risk:** moving the text preview breaks today's markdown preview. The two existing PanelContainer markdown-link tests guard the exact `read` call shape and the rendered `h1`/`pre`.
- **Risk:** `Suspense` with no lazy child in tests. The injected renderers are plain components, so `Suspense` renders them directly.
- **Rollback:** revert the commit; `FilesPanel` returns to the text-only preview.

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

=== FILE: phase-04-pdf-and-sheet-renderers.md ===
---
phase: 4
title: "PDF and spreadsheet renderers"
status: pending
priority: P1
effort: "5h"
dependencies: [3]
---
# Phase 4: PDF and spreadsheet renderers

## Goal

PDFs, spreadsheets (.xlsx, .xls, .ods) and CSV preview in the drawer:

- **PDF:** pages render lazily to canvases through one shared pdf.js loader,
  which the sibling's thumbnails also use.
- **Spreadsheets and CSV:** a sheet-tabbed React table built from SheetJS,
  capped at 500 rows × 50 columns per sheet, with merges and formulas.

This phase also creates the Tauri e2e spec that proves rendering under the real
CSP and the side-by-side geometry.

## Files to Create / Modify

- **Create:**
  - `src/renderer/lib/pdfjs.ts`
  - `src/renderer/components/preview/PdfPreview.tsx`
  - `src/renderer/components/preview/sheet-model.ts` (+ `sheet-model.test.ts`)
  - `src/renderer/components/preview/SheetTable.tsx` (+ `SheetTable.test.tsx`)
  - `src/renderer/components/preview/SheetPreview.tsx`
  - `vendor/xlsx-0.20.3.tgz`
  - `e2e-tauri/document-preview.e2e.ts`
- **Modify:**
  - `src/renderer/lib/pdf-thumbnail.ts`
  - `src/renderer/components/preview/FilePreviewBody.tsx` (`DEFAULT_RENDERERS`)
  - `package.json`, `bun.lock`
  - `vite.renderer.shared.ts`
  - `scripts/check-renderer-chunks.ts`
  - `e2e-tauri/check-twins.ts`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| builds one view per sheet with formatted values | `sheet-model.test.ts` (exceljs-generated .xlsx) | module missing → pass |
| shows a formula when the cell has no cached value | same | same |
| caps rows and columns and reports the totals | same (600 × 60 sheet) | same |
| lays out merged cells as spans and skips covered cells | same | same |
| reads csv text through the same model | same | same |
| renders a tab per sheet and switches between them | `SheetTable.test.tsx` | module missing → pass |
| shows the limit note only when the sheet was capped | same | same |
| existing pdf-thumbnail tests | `src/renderer/lib/pdf-thumbnail.test.ts` | stay green after the loader extraction |
| previews a pdf, a spreadsheet, a csv and an image beside the chat without CSP violations | `e2e-tauri/document-preview.e2e.ts` | renderer missing → kind `pdf` shows unsupported (red) → `ready` (green) |

## Tasks

### Task 4.1: Share the pdf.js loader
- **Goal:** one pdf.js configuration for thumbnails and preview.
- **Target files and symbols:** `src/renderer/lib/pdf-thumbnail.ts`: `loadPdfJs` (lines 102–117), the `PdfJs` type (99) and `decodeBase64` (32–37).
- **Steps:**
  1. Create `src/renderer/lib/pdfjs.ts`. Move the `PdfJs` type, the module-level `pdfJs` promise and `loadPdfJs` there verbatim, export `loadPdfJs`, and keep the doc comment about the worker and CSP.
  2. Add `export const PDF_DOCUMENT_OPTIONS = { useWasm: false, enableXfa: false } as const;` and use it in `pdf-thumbnail.ts`'s `getDocument` call (`{ data: bytes, ...PDF_DOCUMENT_OPTIONS }`).
  3. In `pdf-thumbnail.ts`, import `loadPdfJs` and `PDF_DOCUMENT_OPTIONS` from `./pdfjs` and `decodeBase64` from `./base64`, then delete the local copies.
- **Success criteria:** the thumbnail tests pass unchanged.
- **Verify:**
  - `bunx vitest run src/renderer/lib/pdf-thumbnail.test.ts src/renderer/lib/base64.test.ts; echo "exit=$?"` ends with `exit=0`.
  - `grep -c "function loadPdfJs\|function decodeBase64" src/renderer/lib/pdf-thumbnail.ts` prints `0`.

### Task 4.2: Vendor SheetJS and add the lazy chunk rules
- **Goal:** the dependency is installed, and every preview library is guarded as lazy.
- **Target files and symbols:** `package.json` `dependencies`; `vite.renderer.shared.ts` `VENDOR_CHUNK_RULES` (lines 20–48); `scripts/check-renderer-chunks.ts:14` `LAZY_CHUNKS`.
- **Steps:**
  1. Download the tarball: `mkdir -p vendor && curl -fsSL -o vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` [UNVERIFIED URL; the SheetJS docs list this form].
  2. Add `"xlsx": "file:./vendor/xlsx-0.20.3.tgz"` to `dependencies` in alphabetical position, then run `bun install`.
  3. Append these rules to `VENDOR_CHUNK_RULES`, each with a one-line comment:
     - `[/[\\/]node_modules[\\/]pdfjs-dist[\\/]/, "pdfjs"]`
     - `[/[\\/]node_modules[\\/]xlsx[\\/]/, "xlsx"]`
     - `[/[\\/]node_modules[\\/]jszip[\\/]/, "jszip"]`
  4. Set `LAZY_CHUNKS` to `["mermaid", "codemirror", "charts", "highlight", "xterm", "pdfjs", "xlsx", "jszip"]`.
- **Success criteria:** SheetJS 0.20.3 resolves, and the build passes the chunk guard.
- **Verify:**
  - `tar -xOzf vendor/xlsx-0.20.3.tgz package/package.json | grep -c '"version": "0.20.3"'` prints `1`.
  - `bun -e 'import("xlsx").then(m => console.log(m.version))'` prints `0.20.3`.
  - `bun run build; echo "exit=$?"` prints `index.html entry is lean` and ends with `exit=0`.

### Task 4.3: Sheet model (tests first)
- **Goal:** a pure transform from a SheetJS workbook to capped table views.
- **Target files and symbols:** new `sheet-model.ts` exporting:
  - `SHEET_MAX_ROWS = 500`, `SHEET_MAX_COLS = 50`;
  - `interface SheetView { name: string; rows: string[][]; formulas: boolean[][]; totalRows: number; totalCols: number; spans: Map<string, { rowSpan: number; colSpan: number }>; covered: Set<string> }`;
  - `sheetViewsFromBytes(bytes: Uint8Array): Promise<SheetView[]>`;
  - `sheetViewsFromText(text: string): Promise<SheetView[]>`;
  - `cellText(cell: { w?: string; v?: unknown; f?: string } | undefined): { text: string; formula: boolean }`.
- **Steps:**
  1. Write `sheet-model.test.ts`.
     - **Fixtures:** build with `exceljs` (devDependency): `const wb = new ExcelJS.Workbook()`; sheet `Regions` with `["Region","Q2","Q3"]`, `["North",120,115]`, `["South",200,240]` and `B4 = { formula: "SUM(B2:B3)" }` with no result; sheet `Notes` with a merge `A1:B1` holding `"Merged"`. Get bytes from `new Uint8Array(await wb.xlsx.writeBuffer())`.
     - **Formatted values:** two views named `Regions` and `Notes`; `rows[1]` is `["North","120","115"]`.
     - **Formula:** `rows[3][1]` is `"=SUM(B2:B3)"` and `formulas[3][1]` is `true`.
     - **Caps:** a 600 × 60 sheet gives `rows.length === 500`, `rows[0].length === 50`, `totalRows === 600` and `totalCols === 60`.
     - **Merges:** `spans.get("0:0")` equals `{ rowSpan: 1, colSpan: 2 }` and `covered.has("0:1")`.
     - **CSV:** `sheetViewsFromText("a,b\n1,2")` gives one view with `rows` equal to `[["a","b"],["1","2"]]`.

     Run Verify (red).
  2. Implement with `const XLSX = await import("xlsx")` (dynamic, so the chunk stays lazy). `read(bytes, { type: "array" })`, or `read(text, { type: "string" })` for CSV.
     - For each `SheetNames[i]`, take `utils.decode_range(ws["!ref"] ?? "A1:A1")`, so `totalRows = e.r - s.r + 1` and likewise for columns.
     - Iterate up to the caps with `ws[utils.encode_cell({ r, c })]`.
     - `cellText`: `w` when it is a string; else `String(v)` when `v` is defined; else `"=" + f` when `f` is set (with `formula: true`); else `""`.
     - Merges come from `ws["!merges"]` (inside the caps): `spans` is keyed `` `${r}:${c}` `` at each merge start, and every other cell in the merge goes into `covered`.
- **Success criteria:** the five cases pass.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/preview/sheet-model.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 2: the same command ends with `exit=0`.

### Task 4.4: `SheetTable` and `SheetPreview` (tests first)
- **Goal:** an escaped React table with sheet tabs.
- **Target files and symbols:** new `SheetTable.tsx` (props `{ sheets: SheetView[] }`) and `SheetPreview.tsx` (`DocumentViewProps`); `PREVIEW_SCROLL_*` tiers in `src/renderer/lib/preview.ts` are not used, because the drawer itself scrolls.
- **Steps:**
  1. Write `SheetTable.test.tsx` (linkedom; build `SheetView` objects by hand).
     - Two sheets render two `button[role="tab"]` inside `[role="tablist"][aria-label="Sheets"]`; clicking the second shows its first cell text.
     - A view with `totalRows: 600` shows the text "Showing the first 500 of 600 rows"; an uncapped view shows no note.
     - A cell holding `<b>x</b>` renders literally (`textContent`), with no `b` element.

     Run Verify (red).
  2. `SheetTable`:
     - Tabs are `role="tab"` buttons with `aria-selected`.
     - The table is `<table className="border-collapse text-omp-sm">`. Each `<td>` takes `rowSpan`/`colSpan` from `spans`, covered cells are skipped, and formula cells get `text-(--omp-dim)`.
     - Text renders as React children only.
     - Show the note `filePreview.sheetLimit` when the sheet was capped.
  3. `SheetPreview`:
     - Call `source.type === "bytes" ? sheetViewsFromBytes(source.bytes) : sheetViewsFromText(source.text)` in an effect.
     - On success, `setSheets`, then `onReady()`; on rejection, `onError(error)`. Ignore results after unmount.
     - When `source.type === "text" && source.truncated`, show `filePreview.textTruncated` with `kb: 2000`.
  4. In `FilePreviewBody.tsx`, set `DEFAULT_RENDERERS.sheet = lazy(() => import("./SheetPreview").then(m => ({ default: m.SheetPreview })))`.
- **Success criteria:** the table tests pass, and the router still passes with injected renderers.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/preview/SheetTable.test.tsx; echo "exit=$?"` ends with `exit=1`.
  - After step 4: `bunx vitest run src/renderer/components/preview; echo "exit=$?"` ends with `exit=0`.

### Task 4.5: Tauri e2e spec, red first
- **Goal:** a real-shell, real-CSP check of the side-by-side layout and the PDF, sheet, CSV and image previews.
- **Target files and symbols:**
  - new `e2e-tauri/document-preview.e2e.ts`;
  - `e2e-tauri/session.ts` (`currentLaunch`, `awaitBridge`, `byRole`, `until`);
  - `e2e-tauri/check-twins.ts` (`TAURI_ONLY`, line 19).
- **Steps:**
  1. Add `"document-preview.e2e.ts"` to `TAURI_ONLY`. The reason: it checks the embedded-assets CSP on WebKitGTK, which only the Tauri build enforces at the protocol level (see `csp.e2e.ts`).
  2. Write the spec: `describe("document preview", …)` with `before`, which writes the fixtures into `currentLaunch().project` with `node:fs/promises`:
     - `table.xlsx`: the exceljs workbook from Task 4.3.
     - `notes.csv`: `"Region,Q3\nNorth,115\n"`.
     - `pixel.png`: `Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")`.
     - `sample.pdf`: the latin1 text below.

       ```
       %PDF-1.4
       1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
       2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
       3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
       4 0 obj<</Length 42>>stream
       BT /F1 18 Tf 20 100 Td (PDF fixture) Tj ET
       endstream endobj
       5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
       trailer<</Root 1 0 R>>
       %%EOF
       ```

     Then `awaitBridge(browser)`. Install a collector:

     ```ts
     browser.execute(() => {
       const sink: string[] = [];
       (window as unknown as Record<string, unknown>).__previewCsp = sink;
       document.addEventListener("securitypolicyviolation", e =>
         sink.push(`${e.effectiveDirective} ${e.blockedURI}`),
       );
     });
     ```

     Click the `Workspace` button (`byRole("button", { name: "Workspace", exact: true })`).
  3. Write the test `it("previews a pdf, a spreadsheet, a csv and an image beside the chat without CSP violations", …)`. For each `[file, kind, check]` row:
     - Click `$('//*[@role="treeitem"][contains(normalize-space(.), "<file>")]')`.
     - `until` `[data-file-preview][data-kind="<kind>"]` has `data-state` `ready` (timeout 30 s).
     - Run the check through `browser.execute`:

       | File | Kind | Check |
       |---|---|---|
       | `sample.pdf` | `pdf` | `querySelector("[data-file-preview] canvas").width > 0` |
       | `table.xlsx` | `sheet` | the preview's `textContent` contains `North` |
       | `notes.csv` | `csv` | the preview's `textContent` contains `North` |
       | `pixel.png` | `image` | `img.naturalWidth === 1` |
     - **Side by side:** `$("main textarea")` is displayed and `textareaRect.right <= previewRect.left + 1`.
     - Click the button labelled `Back to files`.

     At the end, `(window as …).__previewCsp` must equal `[]`.
  4. Build the app and run the spec (red): before Task 4.6 the `pdf` row shows the unsupported message, so `data-state` never becomes `ready`.
- **Success criteria:** the spec runs and fails only on the pdf wait.
- **Verify:**
  - `bun e2e-tauri/check-twins.ts; echo "exit=$?"` ends with `exit=0`.
  - `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo tauri build --debug --features e2e-hooks --no-bundle'; echo "exit=$?"` ends with `exit=0`.
  - `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec ./e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` output contains `data-kind="pdf"` in the failure message and ends with a non-zero exit.

### Task 4.6: `PdfPreview`, green e2e
- **Goal:** lazy page rendering with a page cap.
- **Target files and symbols:** new `PdfPreview.tsx`; `loadPdfJs` and `PDF_DOCUMENT_OPTIONS` (`src/renderer/lib/pdfjs.ts`).
- **Steps:**
  1. Constants: `PDF_MAX_PAGES = 300`, `PDF_PAGE_GAP = 12`.
  2. Effect on mount:
     - If `source.type !== "bytes"`, call `onError(new Error("PDF needs bytes"))`.
     - Otherwise run `const pdfjs = await loadPdfJs(); const task = pdfjs.getDocument({ data: source.bytes, ...PDF_DOCUMENT_OPTIONS }); const doc = await task.promise;`.
     - Read each page's `getViewport({ scale: 1 })` for `min(numPages, PDF_MAX_PAGES)` pages and set placeholder sizes scaled to the container `clientWidth` (minus 24 px padding).
     - Then call `onReady()`.
     - Errors call `onError(error)`.
     - On unmount, call `task.destroy()`.
  3. Render one `<canvas>` per page inside a sized `<div>`. An `IntersectionObserver` (root = the scrolling `[data-file-preview]` element, `rootMargin: "400px"`) renders a page once, on first intersection: `page.render({ canvas, viewport: page.getViewport({ scale: cssWidth / natural.width * devicePixelRatio }) })`, with the canvas CSS width set to `cssWidth`.
  4. When `numPages > PDF_MAX_PAGES`, show `filePreview.pdfPages` with `shown`/`total`.
  5. Do not create an annotation or text layer.
  6. Set `DEFAULT_RENDERERS.pdf = lazy(() => import("./PdfPreview").then(m => ({ default: m.PdfPreview })))`.
- **Success criteria:** the e2e passes, and the build keeps pdfjs lazy.
- **Verify:**
  - `bun run build; echo "exit=$?"` ends with `exit=0`.
  - `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo tauri build --debug --features e2e-hooks --no-bundle'; echo "exit=$?"` ends with `exit=0`.
  - `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec ./e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` output contains `1 passing` and ends with `exit=0`.
  - `scripts/virtual-display.sh stop; echo "exit=$?"` ends with `exit=0`.

## Verification

All of these must end with exit code 0:

- `bunx vitest run`
- `bun run check:types`
- `bunx biome check src/renderer/lib/pdfjs.ts src/renderer/lib/pdf-thumbnail.ts src/renderer/components/preview e2e-tauri/document-preview.e2e.ts e2e-tauri/check-twins.ts vite.renderer.shared.ts scripts/check-renderer-chunks.ts`
- `bun run build`
- `bun e2e-tauri/check-twins.ts`
- the e2e command from Task 4.6

Commit: `feat(preview): show PDFs and spreadsheets in the workspace drawer`.

## Risks & Rollback

- **Risk:** the CDN download fails or the version drifts. The two version checks in Task 4.2 fail before any code uses SheetJS.
- **Risk:** pdf.js needs features WebKitGTK lacks. The e2e on WebKitGTK catches it; Unresolved Q1 covers the legacy build.
- **Risk:** the hand-written PDF has no xref table. pdf.js rebuilds the xref when it is missing. If the pdf row fails for that reason, the Failure Protocol applies.
- **Risk:** stray processes. Stop the virtual display when the phase ends (Task 4.6 Verify, last line).
- **Rollback:** revert the commit (including `vendor/` and the `package.json` line), then run `bun install`.

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

=== FILE: phase-05-docx-and-pptx-renderers.md ===
---
phase: 5
title: "Word and PowerPoint renderers"
status: pending
priority: P1
effort: "5h"
dependencies: [4]
---
# Phase 5: Word and PowerPoint renderers

## Goal

.docx files render through docx-preview and .pptx files through
@aiden0z/pptx-renderer. Each renders inside an open shadow root, with hardened
options and the link guard, in lazy chunks, and is proven by the Tauri e2e
under the real CSP on files the assistant's own office tools generate.

## Files to Create / Modify

- **Create:**
  - `src/renderer/components/preview/render-options.ts` (+ `render-options.test.ts`)
  - `src/renderer/components/preview/ShadowHost.tsx`
  - `src/renderer/components/preview/DocxPreview.tsx`
  - `src/renderer/components/preview/PptxPreview.tsx`
- **Modify:**
  - `src/renderer/components/preview/FilePreviewBody.tsx` (`DEFAULT_RENDERERS`)
  - `package.json`, `bun.lock`
  - `vite.renderer.shared.ts`
  - `scripts/check-renderer-chunks.ts`
  - `e2e-tauri/document-preview.e2e.ts`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| disables altChunk iframes and loads fonts and images as data URLs for Word files | `render-options.test.ts` | module missing → pass |
| turns off pdf.js resolution and lazy-loads slides for PowerPoint files | `render-options.test.ts` | same |
| previews a Word report and a slide deck the assistant made | `e2e-tauri/document-preview.e2e.ts` | rows fail (no renderer, unsupported) → `ready` with the fixture title text |

## Tasks

### Task 5.1: Install the libraries and check their API surface
- **Goal:** pin the versions and confirm every symbol the plan uses before writing code.
- **Target files and symbols:** `package.json` `dependencies`; the installed `.d.ts` files.
- **Steps:**
  1. Run `bun add docx-preview@0.4.1 @aiden0z/pptx-renderer@1.3.0 --exact`.
  2. Run each Verify grep. The symbols come from the research report (§DOCX, §PPTX) and are [UNVERIFIED] until this task passes.
- **Success criteria:** the exact versions are installed, and every symbol exists.
- **Verify:**
  - `grep -c '"docx-preview": "0.4.1"' package.json` prints `1`.
  - `grep -c '"@aiden0z/pptx-renderer": "1.3.0"' package.json` prints `1`.
  - `grep -rlE "renderAltChunks" node_modules/docx-preview/dist/*.d.ts | wc -l` prints a number ≥ `1`, and likewise for `useBase64URL` and `renderAsync`.
  - `grep -rlE "RECOMMENDED_ZIP_LIMITS" node_modules/@aiden0z/pptx-renderer/dist/*.d.ts | wc -l` prints a number ≥ `1`, and likewise for `PptxViewer`, `lazySlides`, `pdfjs` and `destroy`.

### Task 5.2: Hardened options (tests first) and chunk rules
- **Goal:** the security-relevant options live in one tested place.
- **Target files and symbols:** new `render-options.ts` exporting `DOCX_RENDER_OPTIONS` and `PPTX_BASE_OPTIONS`; `VENDOR_CHUNK_RULES`; `LAZY_CHUNKS`.
- **Steps:**
  1. Write `render-options.test.ts`:
     - `DOCX_RENDER_OPTIONS` matches `{ renderAltChunks: false, useBase64URL: true, inWrapper: true, ignoreWidth: true, ignoreHeight: true, breakPages: true, renderComments: false, renderChanges: false, experimental: false }`.
     - `PPTX_BASE_OPTIONS` matches `{ pdfjs: false, lazySlides: true, lazyMedia: true, listOptions: { windowed: true } }`.

     Run Verify (red).
  2. Create `render-options.ts` with those two `as const` objects. Import no library here, so the test never loads one. Add a comment explaining each security option: altChunk renders an unsandboxed iframe; `useBase64URL` keeps fonts under `font-src 'self' data:`; `pdfjs: false` stops pdf.js auto-resolution.
  3. Append to `VENDOR_CHUNK_RULES`:
     - `[/[\\/]node_modules[\\/]docx-preview[\\/]/, "docx-preview"]`
     - `[/[\\/]node_modules[\\/](@aiden0z[\\/]pptx-renderer|echarts|zrender)[\\/]/, "pptx"]`
  4. Append `"docx-preview", "pptx"` to `LAZY_CHUNKS`.
- **Success criteria:** the options test passes.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/preview/render-options.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 2: the same command ends with `exit=0`.

### Task 5.3: e2e rows for Word and PowerPoint (red)
- **Goal:** fixtures the assistant's own tools produce, checked in the real shell.
- **Target files and symbols:**
  - `e2e-tauri/document-preview.e2e.ts`;
  - `buildReport` (`assistant-pack/src/office/report.ts:229`) and `buildSlides` (`assistant-pack/src/office/slides.ts:526`);
  - fixtures `assistant-pack/test/fixtures/notes-en.md` and `report-shapes.md`.
- **Steps:**
  1. In `before`, write `report.docx` with `(await buildReport({ markdown: readFileSync(<notes-en.md>, "utf8"), fallbackTitle: "Report", lang: "en" })).bytes` and `deck.pptx` with `(await buildSlides({ markdown: readFileSync(<report-shapes.md>, "utf8"), fallbackTitle: "Deck", lang: "en" })).bytes`.
  2. Add a new test `it("previews a Word report and a slide deck the assistant made", …)` with two rows:
     - `report.docx`, kind `docx`: `[data-file-preview] [data-shadow-host]`'s `shadowRoot.textContent` contains `Quarterly sales review`, the title `assistant-pack/test/report.test.ts` expects for `notes-en.md`.
     - `deck.pptx`, kind `pptx`: the shadow root's text contains `Third quarter review`, and the first slide element's `getBoundingClientRect().width` ≤ the host's `clientWidth + 1`.

     Repeat the side-by-side and CSP-empty assertions from Task 4.5.
  3. Rebuild and run (red).
- **Success criteria:** the new test fails on the docx wait; the phase 4 test still passes.
- **Verify:** after rebuilding with the Task 4.5 build command, `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec ./e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` output contains `1 passing` and `1 failing` and ends with a non-zero exit.

### Task 5.4: `ShadowHost`, `DocxPreview`, `PptxPreview` (green)
- **Goal:** isolated rendering with links guarded.
- **Target files and symbols:**
  - new `ShadowHost.tsx`, `DocxPreview.tsx`, `PptxPreview.tsx`;
  - `interceptLinks` (phase 3);
  - `window.omp.system.openExternal` (`src/shared/ipc-types.ts:1256`);
  - `DOCX_RENDER_OPTIONS` and `PPTX_BASE_OPTIONS`.
- **Steps:**
  1. **`ShadowHost.tsx`.**
     - It exports `useShadowRoot()`, returning `{ hostRef, shadow }`. On mount it calls `host.attachShadow({ mode: "open" })` once and installs `interceptLinks(host, href => void window.omp.system.openExternal(href))`.
     - On unmount it runs the disposer and `shadow.replaceChildren()`.
     - The host element is `<div data-shadow-host className="min-h-full" />`.
  2. **`DocxPreview.tsx`.**
     - Require `source.type === "bytes"`; otherwise call `onError`.
     - Inside the shadow root, create `const style = document.createElement("div")` and `const body = document.createElement("div")`, then append both.
     - Call `const { renderAsync } = await import("docx-preview")`, then `await renderAsync(source.bytes, body, style, DOCX_RENDER_OPTIONS)`, then `onReady()`.
     - Errors call `onError(error)`.
     - Add one `<style>` element through `document.createElement("style")` with `textContent = ":host{display:block} .docx-wrapper{background:transparent;padding:12px}"`. This is static CSS, not model text.
  3. **`PptxPreview.tsx`.**
     - Require bytes.
     - Call `const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer")`, then `const viewer = await PptxViewer.open(source.bytes.buffer, container, { ...PPTX_BASE_OPTIONS, zipLimits: RECOMMENDED_ZIP_LIMITS })`, where `container` is a `div` appended to the shadow root. Then call `onReady()`.
     - On unmount, call `viewer.destroy()`.
     - If the installed typing in Task 5.1 shows a different argument order or return type, stop under the Failure Protocol instead of adapting.
  4. In `FilePreviewBody.tsx`, set `DEFAULT_RENDERERS.docx` and `.pptx` to `lazy(() => import("./DocxPreview")…)` and `lazy(() => import("./PptxPreview")…)`, the same form as Task 4.4.
- **Success criteria:** both e2e tests pass with zero CSP violations; the chunk guard holds.
- **Verify:**
  - `bunx vitest run src/renderer/components/preview; echo "exit=$?"` ends with `exit=0`.
  - `bun run build; echo "exit=$?"` ends with `exit=0`, and its output does not contain `Lazy vendor chunks are reachable`.
  - After rebuilding, `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec ./e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` output contains `2 passing` and ends with `exit=0`.
  - `scripts/virtual-display.sh stop; echo "exit=$?"` ends with `exit=0`.

## Verification

All of these must end with exit code 0:

- `bunx vitest run`
- `bun run check:types`
- `bunx biome check src/renderer/components/preview e2e-tauri/document-preview.e2e.ts vite.renderer.shared.ts scripts/check-renderer-chunks.ts`
- `bun run build`
- the e2e command from Task 5.4
- `git diff --quiet -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json` (CSP untouched)

Commit: `feat(preview): show Word and PowerPoint files in the workspace drawer`.

## Risks & Rollback

- **Risk:** docx-preview or aiden0z inject styles into `document.head`, so slides appear unstyled inside the shadow root. The e2e width and text checks catch broken output, and the Failure Protocol applies; do not drop the shadow root on your own.
- **Risk:** the `.buffer` of a sliced `Uint8Array`. `decodeBase64` returns a fresh array whose buffer is exactly the file.
- **Risk:** a document hyperlink that navigates. The capture-phase guard runs on the shadow host, and `composedPath()` sees through the shadow boundary.
- **Rollback:** revert the commit and run `bun install`. The docx and pptx kinds then show the unsupported message with Open in system app.

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

=== FILE: phase-06-entry-points-and-docs.md ===
---
phase: 6
title: "Entry points, auto-reload and docs"
status: pending
priority: P2
effort: "4h"
dependencies: [5]
---
# Phase 6: Entry points, auto-reload and docs

## Goal

Output files and input files open the preview from where the user sees them:

- a **Preview** button on the office cards;
- a **Preview** icon on the Write card;
- a click on an attachment card.

A finished Write or office call for the open file reloads it. The README and
CHANGELOG describe the feature. The final gates run.

## Files to Create / Modify

- **Create:** `src/renderer/hooks/use-refresh-file-preview.ts`
- **Modify:**
  - `src/renderer/components/tools/OfficeFileRenderer.tsx` (+ `OfficeFileRenderer.test.tsx`)
  - `src/renderer/components/tools/WriteRenderer.tsx` (+ `WriteRenderer.test.tsx`)
  - `src/renderer/components/attachments/AttachmentCard.tsx` (+ `AttachmentCard.test.tsx`)
  - `CHANGELOG.md`, `README.md`, `README.vi.md`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| previews the finished file in the workspace drawer | `OfficeFileRenderer.test.tsx` | no Preview button → pass |
| reloads the open preview when the office file is written again | `OfficeFileRenderer.test.tsx` | `filePreviewSeq` unchanged → bumped |
| previews the written file in the workspace drawer | `WriteRenderer.test.tsx` | no button → pass |
| reloads the open preview when the same path is written | `WriteRenderer.test.tsx` | unchanged → bumped |
| does not offer a preview for agent:// writes | `WriteRenderer.test.tsx` | passes before and after (guard) |
| opens a card with a path in the preview | `AttachmentCard.test.tsx` | no button → pass |
| a card without a path is not clickable | `AttachmentCard.test.tsx` | passes before and after (guard) |

## Tasks

### Task 6.1: Reload hook
- **Goal:** one hook for "this call wrote `path`".
- **Target files and symbols:** new `src/renderer/hooks/use-refresh-file-preview.ts`; `refreshFilePreviewFor` (phase 2).
- **Steps:**
  1. Create it as `export function useRefreshFilePreview(writtenPath: string | null): void { useEffect(() => { if (writtenPath) useUiStore.getState().refreshFilePreviewFor(writtenPath); }, [writtenPath]); }`, with a doc comment saying it reloads the drawer preview when a finished tool call wrote the file it shows. It also runs once when a historical card mounts, which costs only one extra read of the open file.
- **Success criteria:** the hook compiles; its tests come with the renderer tasks.
- **Verify:** `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 6.2: Office card and Write card (tests first)
- **Goal:** output files open the preview.
- **Target files and symbols:**
  - `OfficeFileRenderer.tsx`: `office` (line 62), the button row (89–98) and `buttonClass` (79).
  - `WriteRenderer.tsx`: `WriteRenderer` (40); the early `ProtocolWriteRenderer` return (44–57); `openPath` (66); the `PathLink` row (88–91).
- **Steps:**
  1. **Office card tests.** In `OfficeFileRenderer.test.tsx`, add:
     - A click on the button with text `Preview` sets `useUiStore.getState()` to match `{ filePreviewPath: REPORT, panelTab: "files", panelVisible: true }`.
     - With `filePreviewPath: REPORT` already set, mounting a finished card bumps `filePreviewSeq` by 1.
     - Reset the ui store fields in `afterEach`.
  2. **Write card tests.** In `WriteRenderer.test.tsx`, add:
     - A click on `button[aria-label="Preview report.md"]` opens the preview on the resolved path. Use the test's existing result shape; when `details.resolvedPath` is present, expect it.
     - The reload case.
     - The `agent://` guard: no such button exists.

     Run Verify (red).
  3. **`OfficeFileRenderer`.**
     - Call `useRefreshFilePreview(office?.file ?? null)` right after `office` is computed and before `if (!office) return`, so the hook order never changes.
     - Add a first button `<button type="button" className={buttonClass} onClick={() => useUiStore.getState().openFilePreview(office.file)}><Eye size={14} aria-hidden />{t("filePreview.open")}</button>`.
  4. **`WriteRenderer`.**
     - Before the early `return`, compute `const writtenPath = !isPartial && !isError && path && !/^(?:agent|proc):\/\//i.test(path) ? (typeof resultDetails(result)?.resolvedPath === "string" ? (resultDetails(result)?.resolvedPath as string) : path) : null;`, then call `useRefreshFilePreview(writtenPath)`.
     - After the `PathLink`, when `!isError && !isPartial`, add `<button type="button" aria-label={t("filePreview.openNamed", { name: basename(path) })} title={…same} onClick={e => { e.stopPropagation(); useUiStore.getState().openFilePreview(openPath); }} className="shrink-0 rounded-sm text-[var(--omp-dim)] hover:text-[var(--omp-accent)]"><Eye size={12} aria-hidden /></button>`.
- **Success criteria:** the new tests pass, and the existing Write and office tests stay green.
- **Verify:**
  - After step 2: `bunx vitest run src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/WriteRenderer.test.tsx; echo "exit=$?"` ends with `exit=1`.
  - After step 4: the same command ends with `exit=0`.

### Task 6.3: Attachment cards open the preview (tests first)
- **Goal:** input files open the preview from the composer and the sent bubble.
- **Target files and symbols:** `src/renderer/components/attachments/AttachmentCard.tsx`: `CardPreview` and the preview `div` (`h-[93px]`).
- **Steps:**
  1. In `AttachmentCard.test.tsx`, add:
     - "opens a card with a path in the preview": render `<AttachmentCard name="a.docx" kind="word" path="/d/a.docx" />`, click `button[aria-label="Preview a.docx"]`, and expect `filePreviewPath` to be `/d/a.docx`.
     - "a card without a path is not clickable": no such button exists.

     Run Verify (red).
  2. When `path` is set, wrap the preview area's content in `<button type="button" aria-label={t("filePreview.openNamed", { name })} onClick={() => useUiStore.getState().openFilePreview(path)} className="block h-full w-full cursor-pointer">`. Without `path`, keep the plain `div`. The remove button stays a sibling, so it never triggers the preview.
- **Success criteria:** the card tests pass; the composer remove behavior is unchanged.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/attachments; echo "exit=$?"` ends with `exit=1`.
  - After step 2: the same command ends with `exit=0`.

### Task 6.4: Docs
- **Goal:** users learn about the preview, and maintainers see the new dependencies.
- **Target files and symbols:** `CHANGELOG.md` (`## [Unreleased]`, line 3); the feature bullets in `README.md` (lines 25–33) and `README.vi.md` (matching section).
- **Steps:**
  1. Under `## [Unreleased]`, add `### Added` above `### Changed` with this bullet: "**Preview files beside the chat**: Word, PowerPoint, Excel, CSV, PDF, image and text files open read-only in the workspace panel next to the conversation, from the Preview button on a finished document, a written file, an attached file or the Files list."
  2. Add this README bullet after "**Slides.**": "**Preview.** Open a report, deck, spreadsheet or PDF beside the conversation without leaving the window." Add the same bullet to `README.vi.md` in Vietnamese: "**Xem trước.** Mở báo cáo, bản trình chiếu, bảng tính hoặc PDF ngay bên cạnh cuộc trò chuyện mà không rời khỏi cửa sổ."
- **Success criteria:** each file holds its line once.
- **Verify:**
  - `grep -c "Preview files beside the chat" CHANGELOG.md` prints `1`.
  - `grep -c "^- \*\*Preview\.\*\*" README.md` prints `1`.
  - `grep -c "Xem trước\.\*\*" README.vi.md` prints `1`.

## Verification

All of these must end with exit code 0:

- `bunx vitest run`
- `bun run check:types`
- `bunx biome check src/renderer/hooks/use-refresh-file-preview.ts src/renderer/components/tools/OfficeFileRenderer.tsx src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/WriteRenderer.tsx src/renderer/components/tools/WriteRenderer.test.tsx src/renderer/components/attachments/AttachmentCard.tsx src/renderer/components/attachments/AttachmentCard.test.tsx`
- `bun run build`
- `PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
- `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features`
- `bun scripts/check-test-parity.ts services`
- `bash scripts/check-module.sh snapshots`
- `bun e2e-tauri/check-twins.ts`
- the e2e command from Task 5.4 (after a rebuild); its output contains `2 passing`. Then run `scripts/virtual-display.sh stop`.

Commit: `feat(preview): open previews from tool and attachment cards`, then a separate `docs: describe the in-app file preview`.

## Risks & Rollback

- **Risk:** adding a hook before the `WriteRenderer` early return changes the hook order. The hook sits above the return, and `writtenPath` is computed from data available there.
- **Risk:** a card button nests inside another button. `AttachmentCard`'s remove button is a sibling of the preview area, not a child.
- **Risk:** reload on mount re-reads a large open file once per historical card of the same path. This is bounded by the open preview, and only an exact path match triggers it.
- **Rollback:** revert the two commits. Previews stay reachable from the Files panel and markdown links.

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
