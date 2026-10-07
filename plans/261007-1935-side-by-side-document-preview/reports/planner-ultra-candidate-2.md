=== FILE: plan.md ===
---
title: "Side-by-side document preview"
description: "A Preview tab in the workspace drawer shows docx, pptx, xlsx/xls/ods/csv, pdf, images and text beside the chat, opened from office cards, Write cards, markdown links, the Files panel and attachment cards."
status: pending
priority: P2
effort: 26h
branch: main
tags: [frontend, renderer, tauri, electron, ipc, preview]
blockedBy: [261007-1931-drop-file-attachment-cards]
blocks: []
created: 2026-10-07
---

# Side-by-side document preview

## Outcome

Inside the Sai ATLAS window the user opens a read-only preview of a file and keeps
chatting next to it. The preview is a third tab, **Preview**, of the existing
workspace drawer (`src/renderer/components/layout/PanelContainer.tsx`). While that
tab is active the drawer always docks beside the conversation: also in a split
workspace (where it overlays today), and at windows of 1000 px or less, where it
hides the sidebar for as long as the preview stays open.

- **Output files**: the office card (`office_report` .docx, `office_slides` .pptx,
  `office_clean` .xlsx) gets a **Preview** button; the Write tool card gets a
  preview icon; file links in model markdown already call `openFilePreview` and
  now land in the Preview tab.
- **Input files**: clicking a file in the Files panel, or an attachment card in the
  composer or in a sent user bubble, opens it in the Preview tab.
- **Formats**: .docx (docx-preview), .pptx (@aiden0z/pptx-renderer), .xlsx .xls
  .ods .csv (SheetJS CE into a React table), .pdf (pdf.js canvases), png/jpg/
  jpeg/webp/gif (existing `fs:read-image`), markdown and text (the existing Files
  preview code, moved). Anything else, and every load failure, shows a message and
  **Open in app** (system app).
- The preview reloads by itself when the file changes on disk (agent overwrite or
  the user saving in WPS), and on the Refresh button.

## Decisions

Each open design question from the evidence packet, resolved.

1. **Surface: a `preview` tab in the existing drawer, docked whenever it is active.**
   The drawer already has resizing, width persistence, the error boundary and the
   tab strip; a second pane would duplicate all of it. Side by side is guaranteed by
   the placement rule `inspectorPlacement(tab, compact, split)`: `preview` always
   docks; `files`/`logs` keep today's overlay rule. When the Preview tab opens the
   drawer widens to at least 40 % of the window (never past the drag limit,
   `min(840, 55 %)`): 512 px at 1280, 576 px at 1440, 768 px at 1920. At 1000 px or
   less the sidebar (264 px default) is hidden while the preview is docked and
   restored when it closes, and the drawer is capped so the chat keeps 420 px. At
   the 800 px Electron minimum that is a 380 px preview next to a 420 px chat.
   `App.tsx`'s auto-hide on shrink skips the Preview tab.
2. **Byte transport: one new command, `fs:read-document`.** It returns base64 bytes
   plus a sniffed `kind` for pdf, docx, pptx, xlsx, xls, ods and csv, and with
   `statOnly: true` returns only `size` and `mtimeMs` for any regular file, which
   drives the staleness check. Path policy mirrors `fs:read-image`: a relative path
   is confined to the tab's workspace (`resolve_within` / `resolveWithin`), an
   absolute or `~/` path is read as given (the bytes only reach a local render;
   same rationale as `fs:read-image` and the sibling's `fs:read-pdf`). Cap 32 MiB
   (same number as `FS_PDF_MAX_BYTES`), checked before reading. The extension picks
   the kind and the first bytes must match it: `%PDF-` for pdf, `PK\x03\x04` for
   docx/pptx/xlsx/ods, the OLE header `D0 CF 11 E0 A1 B1 1A E1` for xls, no NUL in
   the first 8192 bytes for csv. Images and text keep `fs:read-image` and `fs:read`.
   The sibling's `fs:read-pdf` stays as is (absolute-only, used by thumbnails);
   preview cannot reuse it because Files-panel paths are workspace-relative.
3. **Isolation.** docx-preview and the pptx renderer draw into an open shadow root
   on a host `<div>`, so document CSS cannot reach the app. docx-preview runs with
   `renderAltChunks: false` (no unsandboxed `iframe srcdoc`) and `useBase64URL: true`
   (fonts and images as `data:` URLs, which `font-src`/`img-src` allow). One link
   guard (`installLinkGuard`) on every preview root cancels every anchor click and
   opens only `http:`, `https:` and `mailto:` through `window.omp.system.openExternal`.
   Sheets and text render through React (escaped); PDFs render to canvas only (no
   annotation or text layer, so no link layer and no PDF JavaScript). No iframe: it
   adds no script protection beyond the CSP (the libraries need scripts in the
   frame) and complicates sizing (research report, "Cross-cutting security"). The
   CSP is not changed.
4. **Entry points**: office card **Preview** button (before Open), Write card
   preview icon, markdown local-file links (existing `ExternalLink` path), Files
   panel tree click (existing), attachment cards in the composer and the sent user
   bubble (new `onOpen` prop on the sibling's `AttachmentCard`).
5. **Large, unsupported, corrupt.** 32 MiB IPC cap ("too large, N MB limit");
   PDFs render the first 30 pages with a "first 30 of N pages" note; sheets render
   the first 1000 rows and 100 columns per sheet with a note; hidden sheets are
   skipped; text keeps the 200 KB cap of today. Audio, video, archives, `.doc`,
   `.ppt`, `.odp`, `.odt`, `.rtf` show "can't be previewed here". A library throw
   shows "could not be shown". Every non-success state has **Open in app**.
6. **Staleness.** While the Preview tab shows a file and the page is visible, the
   renderer polls `fs:read-document` with `statOnly` every 2 s and reloads when
   `size` or `mtimeMs` changes. Reopening the same path from a card bumps
   `filePreviewNonce`, which also reloads. A Refresh button reloads on demand.

Library choices follow the research report (`plans/reports/researcher-261007-1935-in-app-office-preview-libs.md`):
pdfjs-dist 6.4.299 (already added by the sibling plan), docx-preview 0.4.1,
@aiden0z/pptx-renderer 1.3.0, SheetJS CE 0.20.3 from a vendored tarball. Each is
dynamically imported, gets its own `VENDOR_CHUNK_RULES` rule and a `LAZY_CHUNKS`
entry. Deviations from the report: no mammoth fallback and no JSZip pptx extractor
(the report accepts "Open with system app" as the KISS fallback); no self-hosted
cMaps/standard fonts in this plan (Electron loads the renderer from `file://`,
where pdf.js asset fetching is unproven; pdf.js falls back to system fonts). Both
are listed as questions.

## Constraints

- Linux ships the Tauri shell, macOS Electron; one renderer. Every IPC change lands
  in `src/shared/ipc-types.ts`, `src/shared/bridge/create-omp-api.ts`,
  `src/main/ipc.ts`, `src-tauri/src/services/ipc.rs`, `src-tauri/src/services/mod.rs`
  (CHANNELS table and `register`), `src-tauri/tests/channels.rs`
  (`EXPECTED_CHANNEL_COUNT`), Rust twins of the TS tests
  (`src-tauri/contracts/services.parity.json`) and `src-tauri/contracts/services.api.txt`.
- CSP unchanged (`src/renderer/index.html`, `quick-entry.html`,
  `src-tauri/tauri.conf.json`; `dangerousDisableAssetCspModification: ["style-src"]`
  already keeps `'unsafe-inline'` working for docx-preview's `<style>` blocks).
- No LibreOffice or any conversion; render with JS in the renderer only.
- Every string through `useT()` with keys in `en.ts` and `vi.ts`; linkedom tests;
  stores reset with setters, never `mock.module()`; no `any`.
- Commits in this GUI repo only, conventional messages, no plan ids in code, test
  names or commits.

## Non-goals

- Editing, converting or writing documents; printing; search inside a preview.
- Previews for audio, video, archives and legacy `.doc`/`.ppt`/`.odt`/`.odp`/`.rtf`
  (message plus Open in app).
- More than one previewed file at a time (no tabs inside the preview).
- PDF text selection or clickable PDF links.

## Phases

| # | Phase | Owns | Depends on | Status |
|---|---|---|---|---|
| 1 | [Document byte IPC](phase-01-document-byte-ipc.md) | `fs:read-document` in both shells, `src/main/workspace-path.ts`, `src/main/fs-read-document.ts`, `src-tauri/src/services/document.rs`, contracts | sibling plan landed | pending |
| 2 | [Preview tab and surface](phase-02-preview-tab-and-surface.md) | `stores/ui.ts`, `PanelContainer.tsx`, `App.tsx`, `FilesPanel.tsx`, `components/preview/*` (shell, kinds, links, polling, registry), `lib/base64.ts`, locales | 1 | pending |
| 3 | [PDF and spreadsheet views](phase-03-pdf-and-spreadsheet-views.md) | `lib/pdfjs.ts`, `lib/pdf-thumbnail.ts`, `PdfView`, `SheetView`, `sheet-model.ts`, `vendor/`, `package.json`, chunk rules | 2 | pending |
| 4 | [DOCX and PPTX views](phase-04-docx-and-pptx-views.md) | `DocxView`, `PptxView`, `shadow-host.ts`, `package.json`, chunk rules | 3 | pending |
| 5 | [Entry points](phase-05-entry-points.md) | `OfficeFileRenderer.tsx`, `WriteRenderer.tsx`, `AttachmentCard.tsx`, the files that render `<AttachmentCard>` | 2 (may run beside 3 and 4 in a separate worktree) | pending |
| 6 | [End-to-end and release gates](phase-06-end-to-end-and-release-gates.md) | `e2e/document-preview.e2e.ts`, `e2e-tauri/document-preview.e2e.ts`, `e2e/preview-fixtures.ts`, `CHANGELOG.md` | 3, 4, 5 | pending |

Phases run in order 1 → 2 → 3 → 4 → 6. Phase 5 touches no file of phases 3 and 4
and may run in parallel with them only in its own git worktree; in a single
working tree run it after phase 4.

### Coordination with `261007-1931-drop-file-attachment-cards`

That plan is being implemented in this working tree right now (uncommitted
`fs:read-pdf`, `src/main/fs-read-pdf.ts`, `src/renderer/lib/pdf-thumbnail.ts`,
`src/renderer/components/attachments/*`, `pdfjs-dist` in `package.json`). Both plans
edit `ipc-types.ts`, `create-omp-api.ts`, `ipc.ts`, `ipc.rs`, `mod.rs`,
`channels.rs`, `services.parity.json`, `services.api.txt` and `package.json`, so
this plan is `blockedBy` it and Phase 1 Task 1.1 refuses to start until it is
committed. What this plan reuses from it, and how:

| Sibling artifact | Use here |
|---|---|
| `pdfjs-dist` dependency | reused, not re-added |
| `loadPdfJs` in `src/renderer/lib/pdf-thumbnail.ts` | moved to `src/renderer/lib/pdfjs.ts` (Phase 3) and imported by both thumbnail and `PdfView`: one pdf.js loader, one worker |
| `decodeBase64` in `pdf-thumbnail.ts` | moved to `src/renderer/lib/base64.ts` (Phase 2), imported by both |
| `fileKindOf` in `components/attachments/file-kind.ts` | `previewKindOf` builds on it |
| `AttachmentCard` | gains an optional `onOpen` prop (Phase 5) |
| `expand_home_in` in `ipc.rs` | made `pub(super)` and reused by `document.rs` |
| `fs:read-pdf` | untouched (see Decision 2) |

If that plan is abandoned instead of landing, Task 1.1 stays red; the user then
decides between finishing it or re-scoping this plan (Unresolved question 5).

## Shared contracts

```ts
// src/shared/ipc-types.ts (Phase 1)
IPC_COMMANDS.FS_READ_DOCUMENT = "fs:read-document"
export const FS_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;
export type PreviewDocumentKind = "pdf" | "docx" | "pptx" | "xlsx" | "xls" | "ods" | "csv";
export const FS_DOCUMENT_ERRORS = {
  tooLarge: "Document too large",
  unsupported: "Unsupported document type",
  mismatch: "File content does not match its type",
} as const;
export interface IpcFsReadDocumentPayload { path: string; tabId?: string; statOnly?: boolean }
export interface IpcFsReadDocumentResult {
  ok: boolean;
  kind?: PreviewDocumentKind;   // absent for statOnly and failures
  data?: string;                // base64; absent for statOnly and failures
  size: number;                 // bytes; the real size also on "too large"
  mtimeMs: number;              // integer ms since the epoch; 0 on failure
  error?: string;
}
// OmpApi.fs
readDocument(path: string, options?: { tabId?: string; statOnly?: boolean }): Promise<IpcFsReadDocumentResult>;

// src/renderer/stores/ui.ts (Phase 2)
export type PanelTab = "files" | "logs" | "preview";
filePreviewNonce: number;      // bumped by every openFilePreview call
openFilePreview(path) -> { filePreviewPath: path, filePreviewNonce: +1, panelTab: "preview", panelVisible: true }
closeFilePreview() -> { filePreviewPath: null, panelTab: "files" }

// src/renderer/components/preview/views.ts (Phase 2 creates, 3 and 4 fill)
export type ViewKind = "pdf" | "docx" | "pptx" | "sheet";
export interface PreviewViewProps { bytes: Uint8Array; kind: PreviewDocumentKind; name: string; onError(error: unknown): void }
export type PreviewViews = Partial<Record<ViewKind, ComponentType<PreviewViewProps>>>;
export const PREVIEW_VIEWS: PreviewViews;   // React.lazy entries only

// src/renderer/components/preview/preview-links.ts (Phase 2)
export function installLinkGuard(root: HTMLElement | ShadowRoot, openExternal: (url: string) => void): () => void;

// src/renderer/lib/pdfjs.ts (Phase 3)
export function loadPdfJs(): Promise<typeof import("pdfjs-dist")>;
export function pdfDocumentOptions(data: Uint8Array): { data: Uint8Array; useWasm: false; enableXfa: false };

// src/renderer/components/attachments/AttachmentCard.tsx (Phase 5)
AttachmentCardProps.onOpen?: () => void;
```

## Data flow

```
entry point (office card | Write card | markdown link | Files tree | attachment card)
  -> useUiStore.openFilePreview(path)            panelTab="preview", nonce+1
  -> PanelContainer docks (inspectorPlacement)   widens to >=40 %, hides sidebar if <=1000 px
  -> DocumentPreview(path, tabId, nonce)
       previewKindOf(path)
         markdown|text -> fs.read(path, 200_000[, tabId])   -> MarkdownRenderer | <pre>
         image         -> fs.readImage(path[, tabId])       -> <img src=data:>
         pdf|docx|pptx|sheet
                       -> fs.readDocument(path, {tabId})    -> base64ToBytes
                       -> PREVIEW_VIEWS[kind] (lazy chunk)  -> canvas | shadow root | React table
         unsupported   -> message + Open in app
       useFileRevision(path, tabId): every 2 s fs.readDocument(path, {tabId, statOnly}) -> revision+1 on change -> reload
main/Rust: resolve path (workspace for relative, as given for absolute/~) -> stat -> cap -> read -> sniff -> base64
```

## Acceptance criteria

1. At 1280, 1440 and 1920 px windows, opening a preview leaves the conversation
   visible and usable to its left (drawer docked, `aside` left edge at or right of
   `main`'s right edge, `main` at least 420 px wide), in a single and in a split
   workspace; at 800–1000 px the sidebar hides while the preview is open and comes
   back when it closes.
2. A report, deck and cleaned spreadsheet made by the office tools, and a PDF, CSV,
   PNG, markdown and text file, each render in the Preview tab in both shells;
   `e2e-tauri/document-preview.e2e.ts` and `e2e/document-preview.e2e.ts` pass.
3. The office card's Preview button, the Write card's preview icon, a markdown file
   link, a Files-panel click and a click on an attachment card (composer and sent
   bubble) each open the Preview tab on that file.
4. Overwriting the open file updates the preview within 6 s without user action.
5. A file over 32 MiB, a corrupt .docx, an .mp3 and a `.doc` each show their message
   and an **Open in app** button; no exception reaches the error boundary.
6. No `securitypolicyviolation` event fires while any fixture renders; no anchor in a
   preview navigates the webview.
7. `bun run build` prints that the entry is lean with `pdfjs`, `sheetjs`, `jszip`,
   `docx-preview` and `pptx` in its lazy list.
8. `bunx vitest run`, `bun run check:types`, biome on touched files, clippy,
   `cargo test`, `bun scripts/check-test-parity.ts services`,
   `bash scripts/check-module.sh snapshots`, `bun e2e-tauri/check-twins.ts` all pass.

## Risks

| Risk | L x I | Mitigation |
|---|---|---|
| Sibling plan still uncommitted or changes its contract | High x High | Task 1.1 precondition gate; this plan starts only on a clean, committed tree |
| `@aiden0z/pptx-renderer` API differs from the research summary (`PptxViewer.open`, `RECOMMENDED_ZIP_LIMITS`) | Med x Med | Task 4.3 greps the installed `.d.ts` before coding; mismatch triggers the Failure Protocol |
| pdf.js modern build needs a newer WebKitGTK than SAI OS ships | Med x High | dev host is WebKitGTK 2.52.6; Unresolved question 3 asks for one SAI OS smoke; switching to `pdfjs-dist/legacy/build/pdf.min.mjs` is a one-line change in `lib/pdfjs.ts` |
| A new chunk rule catches a module the entry also needs, so `check-renderer-chunks` fails | Med x Med | narrow rules (`jszip|pako|lie|immediate|setimmediate` only); `bun run build` is a Verify step in Phases 3 and 4 |
| The pptx renderer injects global styles or ignores the shadow root | Low x Med | e2e checks the deck text inside the host's shadow root; style leakage is cosmetic, not a script path |
| 2 s stat polling cost | Low x Low | statOnly reads no bytes; polling stops when the tab is hidden, the page is hidden or no file is open |
| SheetJS tarball host unavailable at install time | Low x Med | the tarball is vendored into `vendor/` and committed once; CI never downloads it |

## Rollback

Each phase is one or more commits on `main`; reverting a phase's commits restores
the previous behaviour. Phase 2 is the only phase that changes existing UX (Files
preview moves into the Preview tab); reverting it also requires reverting 3–6,
which depend on it. Phase 1 is inert until Phase 2 calls it.

## Validation commands

```bash
bunx vitest run
bun run check:types
bunx biome check <touched files>
test -f out/renderer-tauri/index.html || bun run build:renderer:tauri
bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings'
bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features'
bun scripts/check-test-parity.ts services
bash scripts/check-module.sh snapshots
bun run build
bun e2e-tauri/check-twins.ts
scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts
scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts
scripts/virtual-display.sh stop
```

## Unresolved questions

Defaults are chosen so work can proceed; each is a question for the user.

1. **Compact windows (≤1000 px)**: default hides the sidebar while a preview is
   open. Alternative: keep the overlay there and accept that the preview covers
   the chat at small sizes.
2. **SheetJS from a vendored tarball** (`vendor/xlsx-0.20.3.tgz`, Apache-2.0,
   ~120 KB gz lazy): default yes. Alternative: exceljs 4.4 (already a devDependency;
   styled cells, but no `.xls`/`.ods`/`.csv` in the browser and no release since 2023).
3. **SAI OS WebKitGTK version**: decides pdf.js modern vs legacy build. Default
   modern; one smoke on a SAI OS machine is needed.
4. **No fallback renderers** (mammoth for docx, a JSZip text extractor for pptx):
   default none, a failure offers Open in app. Ship cMaps and standard fonts for
   pdf.js (about 4 MB, CJK PDFs without embedded fonts)? Default no.
5. **Sibling `fs:read-pdf`**: default keep it beside `fs:read-document`. Folding the
   thumbnail onto `fs:read-document` would remove one channel later.
6. **Width growth**: the drawer width is one persisted value (`gui.panelWidth`), so
   widening it for a preview also widens the Files tab afterwards. Default accept.

=== FILE: phase-01-document-byte-ipc.md ===
---
phase: 1
title: "Document byte IPC"
status: pending
priority: P2
effort: "4h"
dependencies: []
---
# Phase 1: Document byte IPC

## Goal

Add `fs:read-document` to both shells: base64 bytes plus a sniffed kind for pdf,
docx, pptx, xlsx, xls, ods and csv; `statOnly` returns size and mtime for any
regular file. Same results, same error strings, same tests in TypeScript and Rust.

## Files to Create / Modify

Create:
- `src/main/workspace-path.ts` (the `resolveWithin` helper moved out of `src/main/ipc.ts:241`)
- `src/main/fs-read-document.ts`
- `src/main/fs-read-document.test.ts`
- `src-tauri/src/services/document.rs`

Modify:
- `src/main/ipc.ts` (import `resolveWithin`; register the handler beside `FS_READ_PDF`)
- `src/shared/ipc-types.ts` (`IPC_COMMANDS.FS_READ_DOCUMENT`, constants, payload/result types, `OmpApi.fs.readDocument`)
- `src/shared/bridge/create-omp-api.ts`, `src/shared/bridge/create-omp-api.test.ts`
- `src-tauri/src/services/ipc.rs` (`expand_home_in` to `pub(super)`; `fs_read_document` handler)
- `src-tauri/src/services/mod.rs` (`mod document;`, CHANNELS row, `reg.register`)
- `src-tauri/tests/channels.rs` (`EXPECTED_CHANNEL_COUNT` + 1)
- `src-tauri/contracts/services.parity.json`, `src-tauri/contracts/services.api.txt`

## Test Matrix (TDD)

All cases live in `src/main/fs-read-document.test.ts` (`describe("readDocumentFile")`)
with a Rust twin of the normalized name in `src-tauri/src/services/document.rs`
`#[cfg(test)] mod tests`. Red first: TS fails to import the module; Rust fails to compile.

| # | Test name (identical in both) | Input | Expected |
|---|---|---|---|
| 1 | reads a docx as base64 with its kind | `a.docx` = `PK\x03\x04` + 20 bytes | `ok: true, kind: "docx", data: base64(bytes), size: 24, mtimeMs > 0` |
| 2 | reads each supported kind when its signature matches | pdf `%PDF-1.7`, pptx/xlsx/ods `PK\x03\x04`, xls OLE header, csv `a,b\n1,2` | `ok: true` and `kind` = extension for each |
| 3 | refuses an extension it cannot preview | `a.mp3` with any bytes | `ok: false, error: "Unsupported document type"` |
| 4 | refuses a file whose bytes do not match its extension | `a.docx` = `%PDF-1.7` | `ok: false, error: "File content does not match its type"` |
| 5 | refuses a csv that contains a NUL byte | `a.csv` = `a,b\0` | `ok: false, error: "File content does not match its type"` |
| 6 | refuses a file above the size cap | 11-byte `a.pdf`, `maxBytes` 10 | `ok: false, error: "Document too large", size: 11` |
| 7 | resolves a relative path inside the workspace | `cwd = dir`, path `docs/a.csv` | `ok: true, kind: "csv"` |
| 8 | refuses a relative path that escapes the workspace | `cwd = dir/ws`, path `../a.csv` | `ok: false, error: "Path escapes the workspace"` |
| 9 | refuses a relative path without a workspace | `cwd = null`, path `a.csv` | `ok: false, error: "No workspace"` |
| 10 | expands a home relative path | home = dir, path `~/Docs/a b.csv` | `ok: true, kind: "csv"` |
| 11 | returns size and modification time without data when only stat is asked | `song.mp3`, `statOnly` | `ok: true, size: n, mtimeMs > 0`, no `kind`, no `data` |
| 12 | refuses a directory | path of a directory | `ok: false, error: "Not a file"` |
| 13 | reports a missing file without throwing | absent absolute path | `ok: false`, `error` non-empty, no throw/panic |

Bridge: `src/shared/bridge/create-omp-api.test.ts` adds "reads a document through fs:read-document"
(invoke channel and args `{ path, tabId, statOnly }`).

Rust handler (extra, no twin needed): `dispatches_fs_read_document_for_a_relative_path` in
`ipc.rs` tests, using `fakes.tabs.cwds` like `new_window_fakes` (`ipc.rs` tests module).

## Tasks

### Task 1.1 — Precondition: the attachment-card plan is committed
- **Goal**: never edit files another plan is still changing.
- **Target files and symbols**: read-only checks.
- **Steps**:
  1. Run each Verify command below.
- **Success criteria**: all five outputs match.
- **Verify**:
  - `test -f src/renderer/lib/pdf-thumbnail.ts && test -f src/renderer/components/attachments/AttachmentCard.tsx && test -f src/main/fs-read-pdf.ts && echo present` → prints `present`
  - `grep -c '"fs:read-pdf"' src-tauri/src/services/mod.rs` → prints `2`
  - `grep -c "fn expand_home_in" src-tauri/src/services/ipc.rs` → prints `1`
  - `grep -rln --include=*.tsx "<AttachmentCard" src/renderer/components | grep -v "/attachments/" | wc -l` → prints a number ≥ `1`
  - `git status --porcelain -- src src-tauri e2e e2e-tauri scripts package.json bun.lock vite.renderer.shared.ts | wc -l` → prints `0`

### Task 1.2 — Move `resolveWithin` into its own module
- **Goal**: let the document reader resolve workspace paths without importing `ipc.ts` (which imports electron).
- **Target files and symbols**: `src/main/ipc.ts` `resolveWithin` (line ~241); new `src/main/workspace-path.ts`.
- **Steps**:
  1. Create `src/main/workspace-path.ts` exporting `resolveWithin(root: string, rel: string): string | null` with the body and doc comment copied verbatim from `src/main/ipc.ts`.
  2. Delete the function from `ipc.ts` and add `import { resolveWithin } from "./workspace-path";`.
- **Success criteria**: no behaviour change; every existing call site compiles.
- **Verify**:
  - `grep -c "function resolveWithin" src/main/ipc.ts` → `0`
  - `grep -c "export function resolveWithin" src/main/workspace-path.ts` → `1`
  - `bun run check:types; echo "exit=$?"` → last line `exit=0`

### Task 1.3 — Shared types and constants
- **Goal**: one contract both shells and the renderer compile against.
- **Target files and symbols**: `src/shared/ipc-types.ts`: `IPC_COMMANDS` (add after `FS_READ_PDF`, line ~190), new exports `FS_DOCUMENT_MAX_BYTES`, `PreviewDocumentKind`, `FS_DOCUMENT_ERRORS`, `IpcFsReadDocumentPayload`, `IpcFsReadDocumentResult` (after `IpcFsReadPdfResult`, line ~750), `OmpApi.fs.readDocument` (after `readPdf`, line ~1316).
- **Steps**:
  1. Add `/** Read a document (pdf, docx, pptx, xlsx, xls, ods, csv) as base64 for the in-app preview, or stat any file (statOnly) */ FS_READ_DOCUMENT: "fs:read-document",`.
  2. Add the constants and interfaces exactly as in plan.md "Shared contracts", each with a one-line doc comment stating the path policy (relative = workspace, absolute/`~/` = as given) and the cap.
  3. Add `readDocument(path: string, options?: { tabId?: string; statOnly?: boolean }): Promise<IpcFsReadDocumentResult>;` to `OmpApi["fs"]`.
- **Success criteria**: types exported; `check:types` fails only on the bridge (not yet implemented).
- **Verify**: `bun run check:types 2>&1 | grep -c "readDocument"` → a number ≥ `1` (red: the bridge lacks the member).

### Task 1.4 — Bridge (test first)
- **Goal**: `window.omp.fs.readDocument` invokes the new channel in both shells.
- **Target files and symbols**: `src/shared/bridge/create-omp-api.ts` `fs` block (line ~365); `create-omp-api.test.ts` (pattern of the `readPdf` case at line ~188).
- **Steps**:
  1. Add test "reads a document through fs:read-document": call `api.fs.readDocument("docs/a.csv", { tabId: "t1", statOnly: true })`; expect `invokes` to equal `[{ channel: IPC_COMMANDS.FS_READ_DOCUMENT, args: [{ path: "docs/a.csv", tabId: "t1", statOnly: true }] }]`.
  2. Run it: red.
  3. Add `readDocument: (path, options) => port.invoke(IPC_COMMANDS.FS_READ_DOCUMENT, { path, tabId: options?.tabId, statOnly: options?.statOnly }) as Promise<IpcFsReadDocumentResult>,` and the type import.
- **Success criteria**: test green; `check:types` green.
- **Verify**:
  - red: `bunx vitest run src/shared/bridge/create-omp-api.test.ts -t "fs:read-document"; echo "exit=$?"` → `exit=1` before step 3
  - green: same command → `exit=0`; `bun run check:types; echo "exit=$?"` → `exit=0`

### Task 1.5 — TypeScript reader (test first)
- **Goal**: `readDocumentFile` implements the policy; never throws.
- **Target files and symbols**: new `src/main/fs-read-document.ts` exporting `readDocumentFile(rawPath: unknown, options: ReadDocumentOptions): Promise<IpcFsReadDocumentResult>` with `ReadDocumentOptions { cwd: string | null; homeDir?: string; maxBytes?: number; statOnly?: boolean }`; test file `src/main/fs-read-document.test.ts` (structure of `src/main/fs-read-pdf.test.ts`: `mkdtempSync`, `rmSync` in `afterEach`).
- **Steps**:
  1. Write the 13 tests of the matrix; build fixture bytes with `Buffer.from([...])`.
  2. Run: red.
  3. Implement in this order: non-string/empty → `"Invalid path"`; `~/` → `path.join(homeDir ?? os.homedir(), rest)`; absolute → `path.normalize`; relative → `cwd === null` → `"No workspace"`, `resolveWithin(cwd, raw) === null` → `"Path escapes the workspace"`; `fsp.stat` (catch → `ok:false`, message); not a file → `"Not a file"`; `mtimeMs = Math.floor(stat.mtimeMs)`; `statOnly` → `{ ok: true, size, mtimeMs }`; extension (lowercase text after the last `.` of the base name) not a `PreviewDocumentKind` → `FS_DOCUMENT_ERRORS.unsupported`; `size > (maxBytes ?? FS_DOCUMENT_MAX_BYTES)` → `FS_DOCUMENT_ERRORS.tooLarge` with real `size`; read the file; signature check per Decision 2 (csv: no `0x00` in `bytes.subarray(0, 8192)`) else `FS_DOCUMENT_ERRORS.mismatch`; success `{ ok: true, kind, data: bytes.toString("base64"), size, mtimeMs }`. Every failure carries `mtimeMs: 0`.
- **Success criteria**: 13 tests green.
- **Verify**:
  - red: `bunx vitest run src/main/fs-read-document.test.ts; echo "exit=$?"` → output contains `fs-read-document` and last line `exit=1`
  - green: same → `Tests  13 passed` and `exit=0`

### Task 1.6 — Electron handler
- **Goal**: the macOS shell serves the channel.
- **Target files and symbols**: `src/main/ipc.ts`, beside the `IPC_COMMANDS.FS_READ_PDF` handler (line ~1078).
- **Steps**:
  1. Import `readDocumentFile` and `IpcFsReadDocumentPayload`.
  2. Add `ipcMain.handle(IPC_COMMANDS.FS_READ_DOCUMENT, (event, payload: IpcFsReadDocumentPayload | undefined) => readDocumentFile(payload?.path, { cwd: cwdFor(deps, event, payload?.tabId) ?? null, statOnly: payload?.statOnly === true }));` with a two-line comment on the path policy.
- **Success criteria**: compiles.
- **Verify**: `grep -c "IPC_COMMANDS.FS_READ_DOCUMENT" src/main/ipc.ts` → `1`; `bun run check:types; echo "exit=$?"` → `exit=0`

### Task 1.7 — Rust reader (test first)
- **Goal**: identical behaviour in the Tauri shell.
- **Target files and symbols**: new `src-tauri/src/services/document.rs` with `pub(super) const FS_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;`, error-string consts equal to `FS_DOCUMENT_ERRORS`, and `pub(super) fn read_document(raw: &str, cwd: Option<&Path>, home: Option<&Path>, max_bytes: u64, stat_only: bool) -> serde_json::Value`; `src-tauri/src/services/mod.rs` add `mod document;` (alphabetical, after `mod dialogs;`); `src-tauri/src/services/ipc.rs` change `fn expand_home_in` to `pub(super) fn expand_home_in`.
- **Steps**:
  1. Write `#[cfg(test)] mod tests` with the 13 functions named exactly like the normalized TS names (lowercase, non-alphanumerics → `_`), e.g. `reads_a_docx_as_base64_with_its_kind`, using `tempfile::tempdir()`; each asserts on the returned `Value` fields.
  2. Add `mod document;` and a `read_document` that returns `serde_json::Value::Null` so only the tests fail.
  3. Run: red (assertions fail).
  4. Implement the same order as Task 1.5: `super::ipc::expand_home_in(raw, home)`; relative paths through `super::fs::resolve_within`; `std::fs::metadata`; `modified()` → `duration_since(UNIX_EPOCH)` → `as_millis() as u64`; extension via `Path::extension()` lowercased; signature checks; `base64::engine::general_purpose::STANDARD.encode`. Never panic; every error is `json!({ "ok": false, "size": size, "mtimeMs": 0, "error": msg })`.
- **Success criteria**: 13 Rust tests green; clippy clean.
- **Verify**:
  - red: `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features document::'; echo "exit=$?"` → output contains `FAILED` and `exit=101`
  - green: same → output contains `test result: ok. 13 passed` and `exit=0`

### Task 1.8 — Rust handler, registration, channel count
- **Goal**: Tauri dispatches `fs:read-document`.
- **Target files and symbols**: `src-tauri/src/services/ipc.rs` new `pub fn fs_read_document(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply` after `fs_read_image`; `src-tauri/src/services/mod.rs` CHANNELS row `("fs:read-document", Scope::Main),` after `("fs:read-pdf", Scope::Main),` and `reg.register("fs:read-document", Scope::Main, ipc::fs_read_document);` after the `fs:read-pdf` line; `src-tauri/tests/channels.rs` `EXPECTED_CHANNEL_COUNT`.
- **Steps**:
  1. Add test `dispatches_fs_read_document_for_a_relative_path` in the `ipc.rs` tests module: write `docs/a.csv` under a tempdir, insert the tempdir into `fakes.tabs.cwds` for `WindowId(1)`, dispatch `"fs:read-document"` with `{ "path": "docs/a.csv" }`, assert `ok == true` and `kind == "csv"`. Red: unknown channel.
  2. Handler: read `path` (string, default `""`), `tabId`, `statOnly` (bool, default false); `let cwd = ctx.tabs.cwd_for(caller, tab_id);` and `Reply::ok(super::document::read_document(path, cwd.as_deref().map(Path::new), dirs::home_dir().as_deref(), super::document::FS_DOCUMENT_MAX_BYTES, stat_only))`.
  3. Register in both places; raise `EXPECTED_CHANNEL_COUNT` by exactly 1 from its current value.
- **Success criteria**: handler test and `tests/channels.rs` green.
- **Verify**:
  - `grep -c '"fs:read-document"' src-tauri/src/services/mod.rs` → `2`
  - `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features'; echo "exit=$?"` → no line contains `FAILED`, last line `exit=0`

### Task 1.9 — Parity mapping and API snapshot
- **Goal**: the contract gates know the new file and function.
- **Target files and symbols**: `src-tauri/contracts/services.parity.json`; `src-tauri/contracts/services.api.txt`.
- **Steps**:
  1. Append `{ "ts": "src/main/fs-read-document.test.ts", "rust": "src-tauri/src/services/document.rs" }` to the JSON array.
  2. Insert this line directly after the `...::ipc::fs_read(` line and before the `...::ipc::fs_read_image(` line:
     `pub fn sai_atlas_lib::services::ipc::fs_read_document(&alloc::rcs::arc::Arc<sai_atlas_lib::ctx::AppCtx>, sai_atlas_lib::ports::Caller, alloc::vec::Vec<serde_json::value::Value>) -> sai_atlas_lib::bridge::Reply`
- **Success criteria**: both gates pass.
- **Verify**:
  - `bun scripts/check-test-parity.ts services; echo "exit=$?"` → output contains `check-test-parity services:` and `exit=0`
  - `bash scripts/check-module.sh snapshots 2>&1 | tail -1` → starts with `check-module snapshots: PASS`

### Task 1.10 — Phase gate and commit
- **Goal**: one green commit.
- **Steps**: run the Verification block; `bunx biome check` on the touched TS files; commit `feat(fs): read documents for the in-app preview in both shells`.
- **Verify**: `git log -1 --format=%s` → `feat(fs): read documents for the in-app preview in both shells`

## Verification

| Command | Pass condition |
|---|---|
| `bunx vitest run src/main src/shared` | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx biome check src/main/workspace-path.ts src/main/fs-read-document.ts src/main/fs-read-document.test.ts src/main/ipc.ts src/shared/ipc-types.ts src/shared/bridge/create-omp-api.ts src/shared/bridge/create-omp-api.test.ts` | exit 0 |
| `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings'` | exit 0 |
| `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features'` | exit 0, no `FAILED` |
| `bun scripts/check-test-parity.ts services` | exit 0 |
| `bash scripts/check-module.sh snapshots` | last line `check-module snapshots: PASS ...` |

If `cargo test` complains that `out/renderer-tauri` is missing, run `bun run build:renderer:tauri` once first.

## Risks & Rollback

- Absolute paths are readable (same trust contract as `fs:read`, documented in
  `src-tauri/src/services/fs.rs` header): bounded by the extension allowlist, the
  signature sniff and the cap; bytes stay in the renderer. Medium/low.
- `mtimeMs` resolution differs by filesystem; the renderer compares equality only. Low.
- Rollback: `git revert` the phase commit; nothing calls `readDocument` before Phase 2.

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

=== FILE: phase-02-preview-tab-and-surface.md ===
---
phase: 2
title: "Preview tab and surface"
status: pending
priority: P2
effort: "6h"
dependencies: [1]
---
# Phase 2: Preview tab and surface

## Goal

The drawer gets a **Preview** tab that docks beside the chat, owns every file
preview (the Files panel's text/markdown preview moves here), shows images,
unsupported and error states with Open in app, guards links, reloads when the file
changes, and hosts a lazy view registry that Phases 3 and 4 fill. All locale keys
of the feature are added here.

## Files to Create / Modify

Create (all under `src/renderer/`):
- `lib/base64.ts`, `lib/base64.test.ts`
- `components/preview/preview-kind.ts`, `components/preview/preview-kind.test.ts`
- `components/preview/preview-links.ts`, `components/preview/preview-links.test.ts`
- `components/preview/use-file-revision.ts`, `components/preview/use-file-revision.test.tsx`
- `components/preview/views.ts`
- `components/preview/DocumentPreview.tsx`, `components/preview/DocumentPreview.test.tsx`

Modify:
- `src/renderer/stores/ui.ts` (`PanelTab`, `filePreviewNonce`, `openFilePreview`, `closeFilePreview`)
- `src/renderer/stores/ui-panel-tab.test.ts`
- `src/renderer/components/layout/PanelContainer.tsx`, `PanelContainer.test.tsx`
- `src/renderer/App.tsx` (compact auto-hide, line ~291)
- `src/renderer/components/panels/FilesPanel.tsx` (remove the preview branch)
- `src/renderer/lib/pdf-thumbnail.ts` (import `base64ToBytes` instead of its local `decodeBase64`)
- `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red state | Green |
|---|---|---|---|
| `base64ToBytes("JVBERi0=")` equals bytes of `%PDF-` | `lib/base64.test.ts` | import fails | pass |
| `previewKindOf`: `a.md`→markdown, `a.mdx`→markdown, `a.txt`→text, `a.ts`→text, `noext`→text, `a.PNG`→image, `a.gif`→image, `a.pdf`→pdf, `a.docx`→docx, `a.doc`→unsupported, `a.pptx`→pptx, `a.ppt`→unsupported, `a.odp`→unsupported, `a.xlsx`/`a.xls`/`a.ods`/`a.csv`→sheet, `a.mp3`/`a.mp4`/`a.zip`→unsupported | `preview-kind.test.ts` | import fails | pass |
| link guard: click on `<a href="https://x.test">` calls `openExternal("https://x.test")` and `defaultPrevented` true | `preview-links.test.ts` | import fails | pass |
| link guard: `javascript:alert(1)`, `file:///etc/passwd`, `#top` are cancelled and `openExternal` not called | same | — | pass |
| link guard: cleanup removes the listener (second click after dispose not cancelled) | same | — | pass |
| `useFileRevision`: same stat twice → revision 0; changed `mtimeMs` → 1; page hidden → no call; path change resets baseline | `use-file-revision.test.tsx` (fake timers) | import fails | pass |
| store: `openFilePreview("a")` sets `panelTab: "preview"`, `panelVisible: true`, nonce +1; `closeFilePreview()` sets path null and `panelTab: "files"`; `panelTabFromPref("preview")` is `null` | `ui-panel-tab.test.ts` | assertions fail | pass |
| `DocumentPreview`: empty state text when no path | `DocumentPreview.test.tsx` | import fails | pass |
| markdown path → `fs.read("docs/r.md", 200_000)` and an `h1` | same | — | pass |
| image path → `fs.readImage` and `<img src="data:image/png;base64,…">` | same | — | pass |
| `views={{ docx: FakeView }}`: `fs.readDocument` called with `{ tabId: undefined }`, FakeView receives 4 bytes | same | — | pass |
| `views={{}}` + `.docx` → unsupported text, `readDocument` not called | same | — | pass |
| `readDocument` → `{ ok:false, error:"Document too large" }` → text "too large to preview (32 MB limit)" and an Open in app button | same | — | pass |
| FakeView calling `onError` → "could not be shown" + Open in app | same | — | pass |
| `song.mp3` → unsupported text, no read | same | — | pass |
| Refresh button → read called twice | same | — | pass |
| drawer lists `Files, Logs, Preview` | `PanelContainer.test.tsx` (existing test updated) | `toEqual` fails | pass |
| markdown link opens the **Preview** tab (two existing tests: `panelTab: "files"` → `"preview"`) | `PanelContainer.test.tsx` | `toMatchObject` fails | pass |
| preview docks in a split workspace (`useTabsStore.setState({ split })` with a `SplitLayout` value whose `firstTabId`/`secondTabId` are two seeded tabs, see `visibleTabIds` in `src/renderer/stores/tabs.ts:129`; aside class has no `absolute`) | `PanelContainer.test.tsx` | class contains `absolute` | pass |
| opening a preview at `innerWidth` 1440 widens the aside to `576px` | `PanelContainer.test.tsx` | `403px` | pass |
| compact (stubbed `matchMedia` matches) preview hides the sidebar and unmount restores it | `PanelContainer.test.tsx` | sidebar stays visible | pass |
| `inspectorPlacement` and `previewWidth` table (exported pure helpers) | `PanelContainer.test.tsx` | import fails | pass |
| locale key parity | `src/renderer/locales/locales.test.ts` (existing) | — | pass |

## Tasks

### Task 2.1 — Locale keys (all of the feature)
- **Goal**: every string the feature shows exists in both languages before any component uses it.
- **Target files and symbols**: `src/renderer/locales/en.ts` (next to `"panel.tabs.logs"`, line ~1273) and `vi.ts` (same keys).
- **Steps**: add these keys with these values.

| Key | en | vi |
|---|---|---|
| `panel.tabs.preview` | Preview | Xem trước |
| `preview.empty` | Choose a file to preview: a file in Files, a file the assistant made, or a file you attached. | Chọn một tệp để xem trước: tệp trong mục Tệp, tệp trợ lý đã tạo hoặc tệp bạn đính kèm. |
| `preview.loading` | Opening preview… | Đang mở bản xem trước… |
| `preview.refresh` | Reload preview | Tải lại bản xem trước |
| `preview.openInApp` | Open in app | Mở bằng ứng dụng |
| `preview.unsupported` | This kind of file can't be previewed here. | Không thể xem trước loại tệp này tại đây. |
| `preview.tooLarge` | This file is too large to preview ({mb} MB limit). | Tệp này quá lớn để xem trước (giới hạn {mb} MB). |
| `preview.failed` | This file could not be shown. It may be damaged or use features the preview does not support. | Không thể hiển thị tệp này. Tệp có thể bị hỏng hoặc dùng tính năng mà bản xem trước chưa hỗ trợ. |
| `preview.readFailed` | Could not read the file: {error} | Không đọc được tệp: {error} |
| `preview.pdfPagesLimited` | Showing the first {shown} of {total} pages. | Đang hiển thị {shown} trên {total} trang đầu tiên. |
| `preview.sheetLimited` | Showing the first {rows} rows and {cols} columns. | Đang hiển thị {rows} hàng và {cols} cột đầu tiên. |
| `preview.sheetEmpty` | This sheet is empty. | Trang tính này trống. |
| `preview.sheetTabs` | Sheets | Các trang tính |
| `preview.open` | Preview | Xem trước |
| `preview.openNamed` | Preview {name} | Xem trước {name} |

- **Success criteria**: parity test green.
- **Verify**: `bunx vitest run src/renderer/locales; echo "exit=$?"` → `exit=0`; `grep -c '"preview\.' src/renderer/locales/en.ts` → `14`; same command on `vi.ts` → `14`

### Task 2.2 — `base64ToBytes` (test first)
- **Goal**: one decoder for preview and thumbnails.
- **Target files and symbols**: new `src/renderer/lib/base64.ts` `export function base64ToBytes(data: string): Uint8Array<ArrayBuffer>` (body of `decodeBase64` in `src/renderer/lib/pdf-thumbnail.ts`, with a fresh `ArrayBuffer` like `voice.ts` `base64ToBytes`); `pdf-thumbnail.ts` uses it and loses `decodeBase64`.
- **Steps**: write the test (red), create the module, switch `pdf-thumbnail.ts` to the import.
- **Success criteria**: base64 test and the existing `pdf-thumbnail.test.ts` green.
- **Verify**: red `bunx vitest run src/renderer/lib/base64.test.ts; echo "exit=$?"` → `exit=1`; green `bunx vitest run src/renderer/lib/base64.test.ts src/renderer/lib/pdf-thumbnail.test.ts; echo "exit=$?"` → `exit=0`; `grep -c "function decodeBase64" src/renderer/lib/pdf-thumbnail.ts` → `0`

### Task 2.3 — `previewKindOf` (test first)
- **Goal**: choose a renderer from a file name.
- **Target files and symbols**: new `components/preview/preview-kind.ts`: `export type PreviewKind = "markdown" | "text" | "image" | "pdf" | "docx" | "pptx" | "sheet" | "unsupported";` and `export function previewKindOf(path: string): PreviewKind`, built on `fileKindOf` from `src/renderer/components/attachments/file-kind.ts`.
- **Steps**: tests from the matrix (red); implement: `/\.mdx?$/i` → markdown first; then by `fileKindOf(baseName)`: image → image; pdf → pdf; word → `docx` only when the extension is `docx`, else unsupported; slides → `pptx` only for `pptx`, else unsupported; sheet → sheet; text and code → text; audio, video, archive → unsupported; file → text (`fs.read` reports binary).
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/preview-kind.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 2.4 — Link guard (test first)
- **Goal**: no anchor inside a preview can navigate the webview.
- **Target files and symbols**: new `components/preview/preview-links.ts` `installLinkGuard(root, openExternal)`; constant `ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"])`.
- **Steps**: tests (red). Implement: one capture-phase listener for `click` and `auxclick` on `root`; find the anchor through `event.composedPath()` (first `HTMLAnchorElement` with an `href` attribute); if none, return; always `preventDefault()` and `stopPropagation()`; parse with `new URL(href, "about:blank")` inside try/catch; call `openExternal(url.href)` only for an allowed protocol. Return a disposer removing both listeners.
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/preview-links.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 2.5 — `useFileRevision` (test first)
- **Goal**: detect on-disk changes cheaply.
- **Target files and symbols**: new `components/preview/use-file-revision.ts`: `export const PREVIEW_POLL_MS = 2000; export function useFileRevision(path: string | null, tabId: string | null): number`.
- **Steps**: tests with `vi.useFakeTimers()` and a stub assigned to `window.omp = { fs: { readDocument } }` (restore in `afterEach`), rendered through the linkedom harness. Implement: `setInterval(PREVIEW_POLL_MS)` while `path` is set; skip a tick when `document.visibilityState === "hidden"`; call `readDocument(path, { tabId: tabId ?? undefined, statOnly: true })`; ignore `ok: false`; key `${size}:${mtimeMs}`; first key is the baseline; a different key bumps the revision and becomes the baseline; path change resets baseline and revision; clear the interval on unmount.
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/use-file-revision.test.tsx; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 2.6 — View registry
- **Goal**: one place where lazy viewers are registered.
- **Target files and symbols**: new `components/preview/views.ts` with the `ViewKind`, `PreviewViewProps`, `PreviewViews` types from plan.md and `export const PREVIEW_VIEWS: PreviewViews = {};` plus a comment: "entries are `lazy(() => import(\"./XView\"))` only; a static import here would pull a vendor chunk into the entry".
- **Verify**: `bun run check:types; echo "exit=$?"` → `exit=0`

### Task 2.7 — Store changes (test first)
- **Goal**: `openFilePreview` targets the Preview tab.
- **Target files and symbols**: `src/renderer/stores/ui.ts`: `PanelTab` (line 9), `UiStore` adds `filePreviewNonce: number`, initial `filePreviewNonce: 0`, `openFilePreview` (line ~191), `closeFilePreview` (line ~192). `panelTabFromPref` unchanged. Tests in `src/renderer/stores/ui-panel-tab.test.ts`.
- **Steps**: add tests "openFilePreview opens the preview tab and bumps the nonce", "closeFilePreview returns to the files tab", "a persisted preview tab is not restored" (red); implement per plan.md contract; extend `afterEach` reset with `filePreviewPath: null, filePreviewNonce: 0`.
- **Verify**: red/green `bunx vitest run src/renderer/stores/ui-panel-tab.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 2.8 — `DocumentPreview` (test first)
- **Goal**: the Preview tab's content.
- **Target files and symbols**: new `components/preview/DocumentPreview.tsx` `export function DocumentPreview({ views = PREVIEW_VIEWS }: { views?: PreviewViews })`; moved code from `FilesPanel.tsx` lines 103–138 (`openPreview`) and 191–245 (header and text/markdown body) including `PREVIEW_MAX_BYTES = 200_000`.
- **Steps**:
  1. Write `DocumentPreview.test.tsx` with the matrix cases (harness of `ThinkingBlock.test.tsx`; `window.omp` test double with `fs.read`, `fs.readImage`, `fs.readDocument`, `system.openPath`, `system.openExternal`; reset `useUiStore.setState({ filePreviewPath: null, filePreviewNonce: 0 })` in `afterEach`). Red.
  2. Implement. Inputs: `filePreviewPath`, `filePreviewNonce` from `useUiStore`; `tabId` from `useRuntimeTabId()`; `revision` from `useFileRevision`; local `reload` counter. One load effect keyed on `[path, nonce, revision, reload, tabId]` with the `previewVersion` ref pattern of `FilesPanel` to drop stale results. Branch on `previewKindOf(path)`:
     - markdown/text: `tabId ? fs.read(path, PREVIEW_MAX_BYTES, tabId) : fs.read(path, PREVIEW_MAX_BYTES)`; render exactly as `FilesPanel` did (binary → `filesPanel.binary`).
     - image: `tabId ? fs.readImage(path, tabId) : fs.readImage(path)`; `<img alt={name} src={dataUrl} className="mx-auto max-w-full">`.
     - pdf/docx/pptx: view key = kind; sheet: view key `"sheet"`. No view in `views` → unsupported state without reading. Else `fs.readDocument(path, { tabId: tabId ?? undefined })`; `ok: false` with `FS_DOCUMENT_ERRORS.tooLarge` → `preview.tooLarge` with `mb: FS_DOCUMENT_MAX_BYTES / 1024 / 1024`; other `ok: false` → `preview.readFailed`; success → `<Suspense fallback={loading}><View bytes={base64ToBytes(data)} kind={kind} name={baseName} onError={setFailed} /></Suspense>` inside `PanelErrorBoundary` (from `../common`) keyed by `path:nonce:revision:reload`.
     - unsupported: `preview.unsupported`.
     - Every non-success state renders a button `preview.openInApp` that calls `window.omp.system.openPath(path)` and toasts `tools.path.openFailed` on failure (same handling as `PathLink`).
  3. Header (from `FilesPanel`): back button (`filesPanel.back`, calls `closeFilePreview`), file icon, path, refresh `IconButton` (`preview.refresh`, increments `reload`), `PathLink` "Open externally", insert-@mention button (the `omp:insert-mention` event as before). No path → `preview.empty`.
- **Success criteria**: all `DocumentPreview` cases green.
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/DocumentPreview.test.tsx; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 2.9 — Files panel keeps only the tree
- **Goal**: one preview surface.
- **Target files and symbols**: `src/renderer/components/panels/FilesPanel.tsx`: delete `PREVIEW_MAX_BYTES`, `PreviewState`, `previewVersion`, `preview` state, `openPreview`, the `filePreviewPath` effect, `insertMention`, `activePreview`, `previewIsMarkdown` and the `if (filePreviewPath)` branch, and the imports that become unused (`ArrowLeft`, `AtSign`, `ExternalLinkIcon`, `MarkdownRenderer`, `PathLink`, `closeFilePreview`, `filePreviewPath`). Tree click still calls `openFilePreview`.
- **Verify**: `grep -c "filePreviewPath" src/renderer/components/panels/FilesPanel.tsx` → `0`; `bunx biome check src/renderer/components/panels/FilesPanel.tsx; echo "exit=$?"` → `exit=0`

### Task 2.10 — Drawer: tab, docking, width, compact sidebar (test first)
- **Goal**: the Preview tab sits beside the chat at every width.
- **Target files and symbols**: `src/renderer/components/layout/PanelContainer.tsx`: `TABS` (line 25) add `{ id: "preview", labelKey: "panel.tabs.preview", icon: Eye }` (lucide `Eye`); new exports `export function inspectorPlacement(tab: PanelTab, compact: boolean, split: boolean): "dock" | "overlay"` (preview → dock; else `compact || split` → overlay; else dock), `export function previewWidth(current: number, viewport: number): number` (= `Math.max(current, Math.min(Math.min(MAX_WIDTH, Math.round(viewport * 0.55)), Math.round(viewport * 0.4)))`), const `PREVIEW_CHAT_MIN_WIDTH = 420`; the `<aside>` class uses `inspectorPlacement`; an effect on `panelTab === "preview"` runs `setWidth(current => previewWidth(current, window.innerWidth))`; style width in compact preview is `Math.min(width, Math.max(MIN_WIDTH, window.innerWidth - PREVIEW_CHAT_MIN_WIDTH))`; a hook `useCompactPreviewSidebar(active)` where `active = compact && panelTab === "preview"`: on activation, if `useUiStore.getState().sidebarVisible`, call `toggleSidebar()` and remember it in a ref; the effect cleanup (deactivation or unmount) calls `toggleSidebar()` only when the ref says it hid the sidebar and the sidebar is still hidden. Body: `{panelTab === "preview" && <DocumentPreview />}`.
  `PanelContainer.test.tsx`: update the tab-list expectation to `[["Files","true"],["Logs","false"],["Preview","false"]]`, change `panelTab: "files"` to `"preview"` in the two markdown-link tests, add the matrix cases; reset `sidebarVisible: true, filePreviewNonce: 0` in `afterEach`.
- **Steps**: tests first (red), then implement.
- **Verify**: red/green `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 2.11 — App keeps a compact preview open
- **Goal**: shrinking the window does not close a preview.
- **Target files and symbols**: `src/renderer/App.tsx` `hideInspector` (line ~292): condition becomes `compact.matches && ui.panelVisible && ui.panelTab !== "preview"`.
- **Verify**: `grep -c 'ui.panelTab !== "preview"' src/renderer/App.tsx` → `1`

### Task 2.12 — Phase gate and commit
- **Steps**: Verification block; commit `feat(preview): open files in a preview tab beside the chat`.
- **Verify**: `git log -1 --format=%s` → `feat(preview): open files in a preview tab beside the chat`

## Verification

| Command | Pass condition |
|---|---|
| `bunx vitest run` | exit 0 (full suite: catches other tests that relied on the Files preview) |
| `bun run check:types` | exit 0 |
| `bunx biome check src/renderer/lib/base64.ts src/renderer/lib/base64.test.ts src/renderer/lib/pdf-thumbnail.ts src/renderer/components/preview src/renderer/stores/ui.ts src/renderer/stores/ui-panel-tab.test.ts src/renderer/components/layout/PanelContainer.tsx src/renderer/components/layout/PanelContainer.test.tsx src/renderer/App.tsx src/renderer/components/panels/FilesPanel.tsx src/renderer/locales/en.ts src/renderer/locales/vi.ts` | exit 0 |
| `bun run build` | exit 0; output contains `index.html entry is lean` |
| `grep -rn "dangerouslySetInnerHTML" src/renderer/components/preview` | no output |

## Risks & Rollback

- Moving the text preview changes where Files-panel clicks land (now the Preview
  tab with a Back button). Intended; covered by the updated tests.
- Sidebar toggled by the drawer could fight the user's own toggle: the restore only
  runs when the drawer hid it and it is still hidden. Low.
- Rollback: revert the phase commit (and Phases 3–6 if they landed).

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
priority: P2
effort: "5h"
dependencies: [2]
---
# Phase 3: PDF and spreadsheet views

## Goal

Register lazy viewers for PDF (pdf.js canvases, shared loader with the thumbnail)
and for xlsx/xls/ods/csv (SheetJS CE into a React table), each in its own lazy
chunk that the chunk guard enforces.

## Files to Create / Modify

Create:
- `vendor/xlsx-0.20.3.tgz`
- `src/renderer/lib/pdfjs.ts`, `src/renderer/lib/pdfjs.test.ts`
- `src/renderer/components/preview/pdf-layout.ts`, `pdf-layout.test.ts`
- `src/renderer/components/preview/PdfView.tsx`
- `src/renderer/components/preview/sheet-model.ts`, `sheet-model.test.ts`
- `src/renderer/components/preview/SheetView.tsx`, `SheetView.test.tsx`

Modify:
- `package.json`, `bun.lock` (`"xlsx": "file:vendor/xlsx-0.20.3.tgz"` in `dependencies`)
- `src/renderer/lib/pdf-thumbnail.ts` (use `loadPdfJs`, `pdfDocumentOptions` from `lib/pdfjs.ts`)
- `src/renderer/components/preview/views.ts` (`pdf`, `sheet` entries)
- `vite.renderer.shared.ts` (`VENDOR_CHUNK_RULES`), `scripts/check-renderer-chunks.ts` (`LAZY_CHUNKS`)

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `pdfDocumentOptions(bytes)` equals `{ data: bytes, useWasm: false, enableXfa: false }` | `lib/pdfjs.test.ts` | import fails | pass |
| existing thumbnail cache/error cases unchanged | `lib/pdf-thumbnail.test.ts` | — | pass |
| `PDF_PAGE_LIMIT` is 30; `pagesToRender(12)` = 12, `pagesToRender(80)` = 30; `pdfPageScale(400, 612, 2)` = `400*2/612` | `pdf-layout.test.ts` | import fails | pass |
| xlsx written by exceljs (sheet "Doanh thu", header row `Tỉnh, Q1`, row `Hà Nội, 120`, merged `A5:B5` with text "Tổng", formula `=SUM(B2:B3)` without a cached value, second sheet hidden) → one sheet; cells `Hà Nội`, `120`; merge `{ r:4, c:0, rowSpan:1, colSpan:2 }`; formula cell text `=SUM(B2:B3)` with `formula: true` | `sheet-model.test.ts` | import fails | pass |
| 1500-row workbook → 1000 rows, `truncatedRows: true`, `totalRows: 1500` | same | — | pass |
| 150-column sheet → 100 columns, `truncatedCols: true` | same | — | pass |
| csv `Mã,Tên\n1,Hà Nội` (kind `csv`, UTF-8 bytes) → cell `Hà Nội` | same | — | pass |
| `.xls` and `.ods` bytes written by `XLSX.write(wb, { bookType: "biff8" \| "ods", type: "array" })` → same cell values | same | — | pass |
| empty sheet → `rows: []` | same | — | pass |
| `SheetView` with a two-sheet model: renders a table, a tablist labelled `Sheets`, clicking tab 2 shows its cell; limited sheet shows `preview.sheetLimited` text; empty sheet shows `preview.sheetEmpty` | `SheetView.test.tsx` (pure render of `SheetTable` with a model prop) | import fails | pass |
| build: entry lean, `pdfjs` and `sheetjs` listed lazy | `bun run build` output | rule missing → no `pdfjs` in list | pass |

## Tasks

### Task 3.1 — Vendor SheetJS
- **Goal**: install SheetJS CE 0.20.3 without depending on the CDN at build time.
- **Target files and symbols**: `vendor/xlsx-0.20.3.tgz`, `package.json` `dependencies`.
- **Steps**:
  1. `mkdir -p vendor && curl -fsSLo vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` [UNVERIFIED URL form; it is the one SheetJS documents for 0.20.x].
  2. `bun add ./vendor/xlsx-0.20.3.tgz` (writes `"xlsx": "file:vendor/xlsx-0.20.3.tgz"` or the `./vendor/...` form; either is fine).
- **Success criteria**: installed version 0.20.3.
- **Verify**: `node -p "require('./node_modules/xlsx/package.json').version"` → `0.20.3`; `tar -tzf vendor/xlsx-0.20.3.tgz | head -1` → `package/package.json` or another `package/` path

### Task 3.2 — Shared pdf.js loader (test first)
- **Goal**: one loader and one option set for thumbnails and the viewer.
- **Target files and symbols**: new `src/renderer/lib/pdfjs.ts` exporting `loadPdfJs()` (moved verbatim from `pdf-thumbnail.ts`, including the `workerPort` setup with `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` and the retry-on-failure reset) and `pdfDocumentOptions(data)`; `pdf-thumbnail.ts` `rasterizeFirstPage` calls `pdfjs.getDocument(pdfDocumentOptions(bytes))`.
- **Steps**: test (red); move; switch the thumbnail.
- **Verify**: red/green `bunx vitest run src/renderer/lib/pdfjs.test.ts src/renderer/lib/pdf-thumbnail.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`; `grep -c "function loadPdfJs" src/renderer/lib/pdf-thumbnail.ts` → `0`

### Task 3.3 — PDF layout helpers and `PdfView`
- **Goal**: render up to 30 pages at fit width on canvases.
- **Target files and symbols**: `pdf-layout.ts` (`PDF_PAGE_LIMIT = 30`, `pagesToRender(total)`, `pdfPageScale(cssWidth, pageWidth, dpr)`); `PdfView.tsx` default export `PdfView(props: PreviewViewProps)`.
- **Steps**:
  1. Layout tests (red), implement (green).
  2. `PdfView`: container `ref`; on mount `loadPdfJs()` then `getDocument(pdfDocumentOptions(props.bytes))`; read `numPages`; for `i` in `1..pagesToRender(numPages)`, sequentially: `getPage(i)`, viewport at `pdfPageScale(container.clientWidth || 600, page.getViewport({ scale: 1 }).width, devicePixelRatio || 1)`, create a `<canvas>` with CSS width `100%`, `page.render({ canvas, viewport }).promise`, append. Stop when unmounted (a `cancelled` flag) and `await task.destroy()` in cleanup. Any throw → `props.onError(error)`. Render `preview.pdfPagesLimited` with `shown` and `total` when `numPages > PDF_PAGE_LIMIT`. No text layer, no annotation layer.
- **Verify**: `bunx vitest run src/renderer/components/preview/pdf-layout.test.ts; echo "exit=$?"` → `exit=0`; `grep -c "AnnotationLayer\|TextLayer" src/renderer/components/preview/PdfView.tsx` → `0`

### Task 3.4 — Sheet model (test first)
- **Goal**: a bounded, escaped table model from any workbook.
- **Target files and symbols**: `sheet-model.ts`: `SHEET_ROW_LIMIT = 1000`, `SHEET_COL_LIMIT = 100`, `interface SheetCell { text: string; formula: boolean }`, `interface SheetMerge { r: number; c: number; rowSpan: number; colSpan: number }`, `interface SheetModel { name: string; rows: SheetCell[][]; merges: SheetMerge[]; totalRows: number; totalCols: number; truncatedRows: boolean; truncatedCols: boolean }`, `export function readSheets(bytes: Uint8Array, kind: PreviewDocumentKind): SheetModel[]`. This module statically imports `xlsx`; only `SheetView.tsx` and its test may import it.
- **Steps**:
  1. Tests from the matrix; build fixtures in-test with `exceljs` (`new ExcelJS.Workbook()`, `wb.xlsx.writeBuffer()`) and `xlsx` (`XLSX.utils.aoa_to_sheet`, `XLSX.write`). Red.
  2. Implement: csv → `XLSX.read(new TextDecoder("utf-8").decode(bytes), { type: "string", dense: true })`; others → `XLSX.read(bytes, { type: "array", cellDates: true, cellNF: true, dense: true })`; skip sheets whose `wb.Workbook?.Sheets?.[index]?.Hidden` is truthy; range from `XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1")`; cell from `ws["!data"]?.[r]?.[c]`: text = `cell.w ?? (cell.v === undefined && cell.f ? `=${cell.f}` : String(cell.v ?? ""))`, `formula = cell.v === undefined && Boolean(cell.f)`; merges from `ws["!merges"]` clipped to the limits.
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/sheet-model.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 3.5 — `SheetView` (test first)
- **Goal**: sheet tabs plus a plain, escaped table.
- **Target files and symbols**: `SheetView.tsx`: named export `SheetTable({ sheets }: { sheets: SheetModel[] })` (pure, tested) and default export `SheetView(props: PreviewViewProps)` that calls `readSheets(props.bytes, props.kind)` in `useMemo` inside try/catch (throw → `props.onError`).
- **Steps**: tests (red). `SheetTable`: `role="tablist"` with `aria-label={t("preview.sheetTabs")}` when more than one sheet, one `role="tab"` button per sheet; a `<table>` with `<td rowSpan colSpan>` from merges and covered cells skipped; formula cells in `text-(--omp-muted)`; row/column limit note (`preview.sheetLimited`) and empty note (`preview.sheetEmpty`). Text only through JSX.
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/SheetView.test.tsx; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 3.6 — Register views and chunk rules
- **Goal**: the views load lazily in their own chunks.
- **Target files and symbols**: `views.ts` `PREVIEW_VIEWS` gets `pdf: lazy(() => import("./PdfView"))`, `sheet: lazy(() => import("./SheetView"))`; `vite.renderer.shared.ts` `VENDOR_CHUNK_RULES` append `[/[\\/]node_modules[\\/]pdfjs-dist[\\/]/, "pdfjs"]` (skip if a pdfjs rule already exists) and `[/[\\/]node_modules[\\/]xlsx[\\/]/, "sheetjs"]`; `scripts/check-renderer-chunks.ts` `LAZY_CHUNKS` append `"pdfjs"`, `"sheetjs"`.
- **Verify**:
  - `bun run build 2>&1 | grep "index.html entry is lean"` → one line that contains `pdfjs, sheetjs`
  - `grep -rln --include=*.ts --include=*.tsx "sheet-model" src/renderer | sort` → exactly `src/renderer/components/preview/SheetView.test.tsx`, `src/renderer/components/preview/SheetView.tsx`, `src/renderer/components/preview/sheet-model.test.ts`

### Task 3.7 — Phase gate and commit
- **Steps**: Verification block; commit `feat(preview): show PDFs and spreadsheets in the preview`.
- **Verify**: `git log -1 --format=%s` → `feat(preview): show PDFs and spreadsheets in the preview`

## Verification

| Command | Pass condition |
|---|---|
| `bunx vitest run` | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx biome check src/renderer/lib/pdfjs.ts src/renderer/lib/pdfjs.test.ts src/renderer/lib/pdf-thumbnail.ts src/renderer/components/preview vite.renderer.shared.ts scripts/check-renderer-chunks.ts` | exit 0 |
| `bun run build` | exit 0; both pages report `entry is lean` with `pdfjs, sheetjs` in the list |

## Risks & Rollback

- pdf.js modern build on an older SAI OS WebKitGTK (Unresolved question 3):
  switch the import in `lib/pdfjs.ts` to `pdfjs-dist/legacy/build/pdf.min.mjs` and
  the worker to `legacy/build/pdf.worker.min.mjs`.
- SheetJS CE shows no cell styling (Pro feature). Accepted; read-only values.
- Rollback: revert the commit; remove `vendor/xlsx-0.20.3.tgz`; `bun install`.

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
priority: P2
effort: "5h"
dependencies: [3]
---
# Phase 4: DOCX and PPTX views

## Goal

Register lazy viewers for .docx (docx-preview) and .pptx (@aiden0z/pptx-renderer),
each drawing into a shadow root with the link guard installed and hardened options,
scaled to the drawer width.

## Files to Create / Modify

Create:
- `src/renderer/components/preview/shadow-host.ts`, `shadow-host.test.ts`
- `src/renderer/components/preview/docx-options.ts`, `docx-options.test.ts`
- `src/renderer/components/preview/DocxView.tsx`
- `src/renderer/components/preview/pptx-options.ts`, `pptx-options.test.ts`
- `src/renderer/components/preview/PptxView.tsx`

Modify:
- `package.json`, `bun.lock` (`docx-preview` `0.4.1`, `@aiden0z/pptx-renderer` `1.3.0`, exact pins; move `jszip` `3.10.2` from `devDependencies` to `dependencies`)
- `src/renderer/components/preview/views.ts` (`docx`, `pptx`)
- `vite.renderer.shared.ts`, `scripts/check-renderer-chunks.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `fitZoom(400, 800)` = 0.5; `fitZoom(900, 800)` = 1; `fitZoom(400, 0)` = 1 | `shadow-host.test.ts` | import fails | pass |
| `DOCX_RENDER_OPTIONS` has `renderAltChunks: false`, `useBase64URL: true`, `inWrapper: true`, `breakPages: true`, `experimental: false` | `docx-options.test.ts` | import fails | pass |
| `pptxOpenOptions()` has `lazySlides: true`, `lazyMedia: true`, `pdfjs: false`, `zipLimits` equal to the package's `RECOMMENDED_ZIP_LIMITS` | `pptx-options.test.ts` | import fails | pass |
| real rendering of `buildReport` / `buildSlides` output, CSS isolation and link guard in a real engine | Phase 6 e2e (both shells) | — | pass |
| build: `jszip`, `docx-preview`, `pptx` lazy | `bun run build` | not listed | pass |

Rendering is verified in real engines (Phase 6), not linkedom: both libraries need
layout and canvas APIs linkedom does not provide.

## Tasks

### Task 4.1 — Install and confirm the APIs
- **Goal**: pin the libraries and prove the exported names before coding.
- **Target files and symbols**: `package.json`.
- **Steps**:
  1. `bun add --exact docx-preview@0.4.1 @aiden0z/pptx-renderer@1.3.0`
  2. Move `"jszip": "3.10.2"` from `devDependencies` to `dependencies` (same version) and run `bun install`.
- **Success criteria**: the exports the views use exist.
- **Verify**:
  - `grep -c "renderAsync" node_modules/docx-preview/dist/docx-preview.d.ts` → ≥ `1`
  - `grep -c "renderAltChunks\|useBase64URL" node_modules/docx-preview/dist/docx-preview.d.ts` → ≥ `2`
  - `grep -rlc "PptxViewer" node_modules/@aiden0z/pptx-renderer/dist --include=*.d.ts | wc -l` → ≥ `1`
  - `grep -rl "RECOMMENDED_ZIP_LIMITS" node_modules/@aiden0z/pptx-renderer/dist --include=*.d.ts | wc -l` → ≥ `1`
  [UNVERIFIED: the `.d.ts` file names; if a grep finds nothing, that is a Verify failure, not a cue to guess another API.]

### Task 4.2 — Shadow host helpers (test first)
- **Goal**: one way to create the isolated root and scale content.
- **Target files and symbols**: `shadow-host.ts`: `export function ensureShadowRoot(host: HTMLElement): ShadowRoot` (`host.shadowRoot ?? host.attachShadow({ mode: "open" })`); `export function fitZoom(containerWidth: number, contentWidth: number): number` (`contentWidth <= 0 ? 1 : Math.min(1, containerWidth / contentWidth)`).
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/shadow-host.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 4.3 — DOCX options and `DocxView` (test first)
- **Goal**: render Word documents safely.
- **Target files and symbols**: `docx-options.ts` `export const DOCX_RENDER_OPTIONS` (type `Partial<Options>` from `docx-preview`) = `{ className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderAltChunks: false, useBase64URL: true, experimental: false }`; `DocxView.tsx` default export.
- **Steps**:
  1. Options test (red, green).
  2. `DocxView`: a host `<div data-preview-kind="docx" className="h-full overflow-auto">`; on mount `ensureShadowRoot(host)`; inside it a `<style>` element and a body `<div>`; `await renderAsync(props.bytes, body, style, DOCX_RENDER_OPTIONS)`; `installLinkGuard(root, url => void window.omp.system.openExternal(url))`; after render measure the first `section.docx` `offsetWidth` and set `body.style.zoom = String(fitZoom(host.clientWidth, width))`, recomputed by a `ResizeObserver` on the host; cleanup disconnects the observer, disposes the guard, empties the root. Throw → `props.onError`.
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/docx-options.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`; `grep -c "renderAltChunks: false" src/renderer/components/preview/docx-options.ts` → `1`

### Task 4.4 — PPTX options and `PptxView` (test first)
- **Goal**: render slide decks safely.
- **Target files and symbols**: `pptx-options.ts` `export function pptxOpenOptions()` returning `{ zipLimits: RECOMMENDED_ZIP_LIMITS, lazySlides: true, lazyMedia: true, listOptions: { windowed: true }, pdfjs: false }` (names as confirmed in Task 4.1); `PptxView.tsx` default export.
- **Steps**:
  1. Options test (red, green).
  2. `PptxView`: host `<div data-preview-kind="pptx" className="h-full overflow-auto">`; `ensureShadowRoot(host)`; a container `<div>` in it; `PptxViewer.open(props.bytes.buffer, container, pptxOpenOptions())` (await if it returns a promise); `installLinkGuard(root, …)` as in DocxView; the same `fitZoom` scaling against the first slide element's width; cleanup calls the viewer's dispose/destroy method if the `.d.ts` declares one (record which in the commit body), disposes the guard, empties the root. Throw → `props.onError`.
- **Verify**: red/green `bunx vitest run src/renderer/components/preview/pptx-options.test.ts; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 4.5 — Register views and chunk rules
- **Goal**: lazy, separate chunks.
- **Target files and symbols**: `views.ts` adds `docx: lazy(() => import("./DocxView"))`, `pptx: lazy(() => import("./PptxView"))`; `VENDOR_CHUNK_RULES` append `[/[\\/]node_modules[\\/](jszip|pako|lie|immediate|setimmediate)[\\/]/, "jszip"]`, `[/[\\/]node_modules[\\/]docx-preview[\\/]/, "docx-preview"]`, `[/[\\/]node_modules[\\/](@aiden0z[\\/]pptx-renderer|echarts|zrender|tslib)[\\/]/, "pptx"]`; `LAZY_CHUNKS` append `"jszip"`, `"docx-preview"`, `"pptx"`.
- **Verify**: `bun run build 2>&1 | grep "index.html entry is lean"` → one line containing `pdfjs, sheetjs, jszip, docx-preview, pptx`

### Task 4.6 — Phase gate and commit
- **Steps**: Verification block; commit `feat(preview): show Word documents and slide decks in the preview`.
- **Verify**: `git log -1 --format=%s` → `feat(preview): show Word documents and slide decks in the preview`

## Verification

| Command | Pass condition |
|---|---|
| `bunx vitest run` | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx biome check src/renderer/components/preview vite.renderer.shared.ts scripts/check-renderer-chunks.ts` | exit 0 |
| `bun run build` | exit 0; both pages `entry is lean`, lazy list ends with `jszip, docx-preview, pptx` |
| `grep -rn "innerHTML" src/renderer/components/preview` | no output |

## Risks & Rollback

- `tslib` in the pptx rule: if the entry also needs `tslib`, the build guard fails
  (Verify), and the Failure Protocol applies; removing `tslib` from the rule is the
  expected advice.
- aiden0z is a young, single-maintainer project; pinned exactly; a render failure
  falls back to Open in app.
- docx-preview pagination is approximate and fields show cached text; accepted for
  a read-only preview.
- Rollback: revert the commit; `bun install`.

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

=== FILE: phase-05-entry-points.md ===
---
phase: 5
title: "Entry points"
status: pending
priority: P2
effort: "2h"
dependencies: [2]
---
# Phase 5: Entry points

## Goal

Output and input files open in the preview from where the user sees them: the
office card, the Write card and attachment cards in the composer and the sent
bubble. (Markdown links and Files-panel clicks already route there since Phase 2.)

## Files to Create / Modify

Modify:
- `src/renderer/components/tools/OfficeFileRenderer.tsx`, `OfficeFileRenderer.test.tsx`
- `src/renderer/components/tools/WriteRenderer.tsx`, `WriteRenderer.test.tsx`
- `src/renderer/components/attachments/AttachmentCard.tsx`, `AttachmentCard.test.tsx`
- every non-test file under `src/renderer/components` that renders `<AttachmentCard` (listed by Task 5.3 step 1; expected the composer in `src/renderer/components/layout/InputArea.tsx` and the bubble in `src/renderer/components/chat/MessageBubble.tsx`) [UNVERIFIED: exact files depend on how the sibling plan's Phase 4 landed]

No locale edits (keys `preview.open`, `preview.openNamed` exist since Phase 2).

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| office card shows a `Preview` button before `Open`; click sets `filePreviewPath` to the card's file, `panelTab: "preview"`, `panelVisible: true` | `OfficeFileRenderer.test.tsx` | button missing | pass |
| a rejected result (not in `Sai ATLAS/`) still renders the generic card without Preview | same (existing cases) | — | pass |
| Write card has a button labelled `Preview <basename>`; click opens the preview of the written path | `WriteRenderer.test.tsx` | button missing | pass |
| `AttachmentCard` with `onOpen`: a button labelled `Preview <name>` covers preview area and name; click calls `onOpen`; the remove button still calls only `onRemove` | `AttachmentCard.test.tsx` | button missing | pass |
| `AttachmentCard` without `onOpen` renders no open button (existing transcript-only snapshot unchanged) | same | — | pass |

## Tasks

### Task 5.1 — Office card Preview button (test first)
- **Goal**: preview the file an office tool made.
- **Target files and symbols**: `OfficeFileRenderer.tsx` `OfficeFileRenderer`, the button row (`<div className="flex shrink-0 items-center gap-1.5">`).
- **Steps**: test (red); add as the first button `<button type="button" className={buttonClass} onClick={() => useUiStore.getState().openFilePreview(office.file)}><Eye size={14} aria-hidden />{t("preview.open")}</button>`; reset the ui store in the test's `afterEach` with `useUiStore.setState({ filePreviewPath: null, filePreviewNonce: 0, panelTab: "files", panelVisible: false })`.
- **Verify**: red/green `bunx vitest run src/renderer/components/tools/OfficeFileRenderer.test.tsx; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 5.2 — Write card preview icon (test first)
- **Goal**: preview a file the assistant wrote.
- **Target files and symbols**: `WriteRenderer.tsx` header row (the `<PathLink path={openPath} …>` at line ~88).
- **Steps**: test (red); after the `PathLink`, add an `IconButton` (from `../common`) with `icon={<Eye size={12} />}`, `label={t("preview.openNamed", { name: basename(path) })}`, `size="sm"`, `onClick` that calls `event.stopPropagation()` when the handler receives the event, then `useUiStore.getState().openFilePreview(openPath)`. [UNVERIFIED: `IconButton`'s onClick signature; if it passes no event, omit `stopPropagation`.]
- **Verify**: red/green `bunx vitest run src/renderer/components/tools/WriteRenderer.test.tsx; echo "exit=$?"` → `exit=1` then `exit=0`

### Task 5.3 — Attachment cards open the preview (test first)
- **Goal**: preview a file the user attached, before and after sending.
- **Target files and symbols**: `AttachmentCard.tsx` `AttachmentCardProps` (add `onOpen?: () => void`), `AttachmentCard`.
- **Steps**:
  1. `grep -rln --include=*.tsx "<AttachmentCard" src/renderer/components | grep -v "/attachments/"` and write the list into the commit body.
  2. Tests (red). In `AttachmentCard`, when `onOpen` is set, wrap the preview `<div>` and the `<figcaption>` in one `<button type="button" aria-label={t("preview.openNamed", { name })} onClick={onOpen} className="flex min-h-0 flex-1 flex-col text-left">`; keep the remove button outside it.
  3. In each listed file, pass `onOpen={card.path ? () => useUiStore.getState().openFilePreview(card.path) : undefined}` using that file's variable for the card (path is optional in `AttachmentCardProps`; cards without a path get no open action).
- **Verify**:
  - red/green `bunx vitest run src/renderer/components/attachments/AttachmentCard.test.tsx; echo "exit=$?"` → `exit=1` then `exit=0`
  - `grep -rn --include=*.tsx "<AttachmentCard" src/renderer/components | grep -v "/attachments/" | grep -vc "onOpen"` → `0` (every non-test render passes `onOpen`; if a call spans several lines and this grep misreports, check those lines by hand and record them in the commit body)

### Task 5.4 — Phase gate and commit
- **Steps**: Verification block; commit `feat(preview): open office, written and attached files in the preview`.
- **Verify**: `git log -1 --format=%s` → `feat(preview): open office, written and attached files in the preview`

## Verification

| Command | Pass condition |
|---|---|
| `bunx vitest run` | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx biome check src/renderer/components/tools/OfficeFileRenderer.tsx src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/WriteRenderer.tsx src/renderer/components/tools/WriteRenderer.test.tsx src/renderer/components/attachments <files from Task 5.3 step 1>` | exit 0 |

## Risks & Rollback

- A nested button inside the card would break keyboard semantics; the open button
  and the remove button are siblings, never nested (test asserts both).
- Rollback: revert the commit; the cards and tool cards return to open-externally only.

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

=== FILE: phase-06-end-to-end-and-release-gates.md ===
---
phase: 6
title: "End-to-end and release gates"
status: pending
priority: P2
effort: "4h"
dependencies: [3, 4, 5]
---
# Phase 6: End-to-end and release gates

## Goal

Prove in both real engines (WebKitGTK through Tauri, Chromium through Electron)
that real office-tool output, a PDF and a CSV render beside the chat under the
shipped CSP, that a changed file reloads, and that a corrupt file falls back.
Record the feature in the changelog.

## Files to Create / Modify

Create:
- `e2e/preview-fixtures.ts` (shared fixture writer)
- `e2e/document-preview.e2e.ts` (Playwright, Electron)
- `e2e-tauri/document-preview.e2e.ts` (WebdriverIO twin: same file name, same titles, at least as many `expect(`)

Modify:
- `CHANGELOG.md` (`## [Unreleased]` → `### Changed`... add one bullet under a new `### Added` heading placed before `### Changed`)

## Test Matrix (TDD)

Titles identical in both specs (`bun e2e-tauri/check-twins.ts` enforces it):

| Title | Steps | Expected |
|---|---|---|
| a generated report opens beside the chat from the Files panel | open Workspace, click `report.docx` | host `[data-preview-kind="docx"]` exists; its `shadowRoot.textContent` contains `Quarterly sales review`; `aside.getBoundingClientRect().left >= main.getBoundingClientRect().right - 1`; `main` width ≥ 420 |
| slides, spreadsheets, csv and pdf render without CSP violations | click `deck.pptx`, `sheet.xlsx`, `table.csv`, `paper.pdf` in turn | pptx shadow text contains `Quarterly sales review`; a `td` with text `Hà Nội` for xlsx and csv; ≥ 1 `canvas` with `width > 0` for pdf; the recorded `securitypolicyviolation` list is empty |
| an overwritten file refreshes the open preview | open `table.csv`; rewrite it with `Mã,Tên\n2,Đà Nẵng` | within 6 s a `td` with `Đà Nẵng` |
| a damaged document offers to open it in the app | click `broken.docx` | text `This file could not be shown` and a button `Open in app` |

Red state: before Task 6.2 the specs fail at the first `expect` (no Preview tab
content for `.docx` without Phase 4, or no spec file at all → twin check fails).

## Tasks

### Task 6.1 — Fixture writer
- **Goal**: real tool output as test input, written into the launch's project folder.
- **Target files and symbols**: `e2e/preview-fixtures.ts` `export async function writePreviewFixtures(dir: string): Promise<void>`.
- **Steps**: write
  - `report.docx` = `(await buildReport({ markdown: readFileSync("assistant-pack/test/fixtures/notes-en.md", "utf8"), fallbackTitle: "Report", lang: "en" })).bytes` (`assistant-pack/src/office/report.ts`);
  - `deck.pptx` = `buildSlides` with the same input (`assistant-pack/src/office/slides.ts`);
  - `sheet.xlsx` via `exceljs`: sheet `Doanh thu`, rows `[["Tỉnh","Q1"],["Hà Nội",120]]`;
  - `table.csv` = `Mã,Tên\n1,Hà Nội\n` (UTF-8);
  - `paper.pdf` = a one-page PDF built by a local `minimalPdf(text)` helper that writes objects (catalog, pages, page, content stream drawing `text` with `/Helvetica`, font) and an `xref` table with byte offsets computed from the assembled buffer;
  - `broken.docx` = `PK\x03\x04` followed by 64 bytes of `0x00`.
- **Verify**: `bun -e 'import("./e2e/preview-fixtures.ts").then(async m => { const d = require("node:fs").mkdtempSync("/tmp/pf-"); await m.writePreviewFixtures(d); console.log(require("node:fs").readdirSync(d).sort().join(",")); })'` → `broken.docx,deck.pptx,paper.pdf,report.docx,sheet.xlsx,table.csv`

### Task 6.2 — Electron spec
- **Goal**: Chromium proof.
- **Target files and symbols**: `e2e/document-preview.e2e.ts`; launch block copied from `e2e/desktop.e2e.ts` (profile, `project`, `userData`, `agent` dirs and `electron.launch` args, lines ~28–60), calling `writePreviewFixtures(project)` before launch. Before the first click, `page.evaluate` installs a `securitypolicyviolation` listener that pushes `effectiveDirective` into `window.__previewCspViolations`. Open the drawer with the title-bar button named `Workspace`; click file names with `page.getByText(name, { exact: true })`; read shadow text with `page.evaluate(() => document.querySelector('[data-preview-kind="docx"]')?.shadowRoot?.textContent ?? "")` polled with `expect.poll`.
- **Verify**: `bun run build && scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts; echo "exit=$?"` → output contains `4 passed` and `exit=0`

### Task 6.3 — Tauri twin
- **Goal**: WebKitGTK proof under the Tauri CSP.
- **Target files and symbols**: `e2e-tauri/document-preview.e2e.ts`; `launch({ name: "document-preview", setup: async l => writePreviewFixtures(l.project) })` from `e2e-tauri/session.ts`; `awaitMainWindow(browser)`; clicks via `lastExactText(name)` (`session.ts`); same CSP listener and shadow-text polling through `browser.execute` and `browser.waitUntil`; same titles and at least the same number of `expect(` per test as the Electron spec.
- **Verify**:
  - `bun e2e-tauri/check-twins.ts; echo "exit=$?"` → `exit=0`
  - `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` → output contains `4 passing` and `exit=0` [UNVERIFIED: WebdriverIO forwards `--spec` through `bun run`; if not, run `scripts/virtual-display.sh run -- bunx wdio run wdio.conf.ts --spec e2e-tauri/document-preview.e2e.ts`]

### Task 6.4 — Changelog
- **Goal**: users learn about the feature.
- **Target files and symbols**: `CHANGELOG.md` `## [Unreleased]`.
- **Steps**: add `### Added` before `### Changed` with: `- **Preview files beside the chat**: Word documents, slide decks, spreadsheets (including .xls, .ods and .csv), PDFs, images and text open in a Preview tab next to the conversation, from the office cards, the Files panel, links in answers and attached files. The preview updates when the file changes; anything it cannot show opens in its app.`
- **Verify**: `grep -c "Preview files beside the chat" CHANGELOG.md` → `1`

### Task 6.5 — Full gate, cleanup, commit
- **Goal**: everything green; nothing left running.
- **Steps**: run the Verification block in order; `scripts/virtual-display.sh stop`; commit `test(preview): cover document previews in both shells` (specs, fixtures) and `docs(changelog): note the document preview` (changelog).
- **Verify**: `scripts/virtual-display.sh status` → reports nothing running on the display; `git status --porcelain -- src src-tauri e2e e2e-tauri CHANGELOG.md | wc -l` → `0`

## Verification

| Command | Pass condition |
|---|---|
| `bunx vitest run` | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx biome check e2e/preview-fixtures.ts e2e/document-preview.e2e.ts e2e-tauri/document-preview.e2e.ts` | exit 0 |
| `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings'` | exit 0 |
| `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features'` | exit 0 |
| `bun scripts/check-test-parity.ts services` | exit 0 |
| `bash scripts/check-module.sh snapshots` | last line `check-module snapshots: PASS ...` |
| `bun run build` | exit 0, both pages `entry is lean` |
| `bun e2e-tauri/check-twins.ts` | exit 0 |
| Tauri and Electron spec commands from Tasks 6.2 and 6.3 | `4 passed` / `4 passing` |

## Risks & Rollback

- The e2e harness runs Tauri with a throwaway `HOME`; `scripts/rust-pins.env`
  derives `CARGO_HOME_BIN` from `$HOME`, so pass `CARGO_HOME`, `RUSTUP_HOME` and
  `CARGO_HOME_BIN` from the real home if the debug build step cannot find cargo.
- Electron loads the renderer from `file://`; the pdf.js worker is a same-origin
  module URL there. If the PDF case fails only in Electron, that is a Verify
  failure for kongming, not a reason to change the CSP.
- Process hygiene: the virtual display and app processes are stopped in Task 6.5.
- Rollback: revert the test and changelog commits; no runtime effect.

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
