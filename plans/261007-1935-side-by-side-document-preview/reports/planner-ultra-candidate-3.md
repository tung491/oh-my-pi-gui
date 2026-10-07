=== FILE: plan.md ===
---
title: "Side-by-side document preview"
description: "Open a read-only preview of a docx, pptx, xlsx/xls/ods/csv, pdf, image or text file in the docked Workspace drawer next to the chat, for files the assistant made and files the user attached."
status: pending
priority: P2
effort: 27h
branch: main
tags: [frontend, renderer, tauri, electron, ipc, preview, security]
blockedBy: [261007-1931-drop-file-attachment-cards]
blocks: []
created: 2026-10-07
---

# Side-by-side document preview

## Outcome

The user can open a read-only preview of a file inside the Sai ATLAS window,
next to the conversation. The chat stays visible and usable while the preview is open.

- **Formats:** every type the attach dialog accepts (`ATTACH_FILTERS`,
  `src/renderer/components/layout/attach-document.ts:13-18`). That means .docx,
  .pptx, .xlsx, .xls, .ods, .csv, .pdf, .md, .txt, .png, .jpg, .jpeg and .webp,
  plus .gif, .mdx and .markdown, which the Files panel already handles.
- **Output files:** the office tool cards (`office_report`, `office_slides`,
  `office_clean`), files the Write tool card names, and local files linked in
  model markdown.
- **Input files:** the attachment cards in the composer and in the sent bubble
  (from the sibling plan), and files in the Workspace › Files tree.

The preview reuses the existing Workspace drawer (`PanelContainer`) and its Files
preview. That drawer becomes a docked column beside the chat at every width above
1000 px, including in a split workspace. Rendering happens in the renderer with
JS libraries only, and the CSP stays unchanged.

## Decisions

Each decision has a short rationale. "Q" marks a default the user may overrule
(see Unresolved questions).

- **D1. Surface: the existing drawer's Files preview, not a new tab or pane.**
  - All current entry points already call `openFilePreview(path)`
    (`src/renderer/stores/ui.ts:191`, `src/renderer/lib/markdown.tsx:185`,
    `FilesPanel.tsx` tree click), so they gain document previews for free.
  - The drawer already docks as a flex sibling of `<main>` (`src/renderer/App.tsx:605`)
    and is resizable 360–840 px (`PanelContainer.tsx:14-15`).
  - **Gap 1, split workspace.** The drawer overlays at
    `PanelContainer.tsx:127` (`compact || split`). This plan changes the rule:
    while a file preview is open, a split workspace docks the drawer too.
  - **Gap 2, readability.** The default width of 28 % of the viewport
    (`PanelContainer.tsx:20-23`) is too narrow for a page. When a document
    (pdf/docx/pptx/sheet) opens, the drawer widens to at least
    `min(840, round(innerWidth × 0.45))`; it never shrinks.
  - **At ≤ 1000 px nothing changes:** the drawer stays an overlay. The window
    minimum is 800 px (`src/main/window.ts:40`), so docking would leave less than
    440 px of chat with the sidebar open. Q1.
  - One file is previewed at a time, because the drawer holds one
    `filePreviewPath`.
- **D2. Byte transport: one new IPC command, `fs:read-document`.**
  - **It covers** pdf, docx, pptx, xlsx, xls, ods, csv, md/mdx/markdown and txt,
    and returns `{ kind, data (base64), size, mtimeMs }`.
  - **Path policy is the same as `fs:read-image`:** relative paths stay confined
    to the workspace through `tabId`, while absolute and `~/` paths are allowed.
    Absolute paths are needed because office output lives in
    Documents › Sai ATLAS and attachments live anywhere. The bytes only reach a
    local render, the CSP has `connect-src 'self'`, and both shells block
    navigation (`src/main/window.ts:87-93`, `src-tauri/src/webview.rs:287,301`).
  - **Checks:** an extension allowlist, then a content sniff. ZIP formats must
    start with `PK\x03\x04`, xls with the CFB signature, pdf with `%PDF-`, and
    text kinds must have no NUL byte in the first 8 KiB.
  - **Size cap:** 32 MiB, the same as the sibling's `FS_PDF_MAX_BYTES`
    (`src/main/fs-read-pdf.ts:12`), so any PDF that thumbnails also previews.
  - **Conditional read:** an optional `ifChanged {size, mtimeMs}` returns
    `unchanged: true` without the bytes. This makes staleness checks cheap.
  - **Other reads reuse existing commands.** Images go through `fs:read-image`.
    Any other file (code, logs, unknown types) keeps today's `fs:read` text path
    unchanged.
  - **The sibling's `fs:read-pdf` stays** as the PDF thumbnail reader; this plan
    does not change it.
  - **Why not per-format commands:** they would triple the Rust and TS twins,
    the parity tests and the snapshots for the same policy.
- **D3. Isolation.**
  - docx-preview and the pptx renderer write into an **open shadow root**
    (CSS isolation), with a capture-phase link guard on that root.
  - **Link guard:** every anchor click is cancelled. Only `http(s)` links are
    handed to `window.omp.system.openExternal`, which the main process also
    restricts to http(s) (`src/main/ipc.ts:733-737`).
  - **Library options:** docx-preview runs with `renderAltChunks: false` (it
    would otherwise create an unsandboxed `iframe srcdoc`) and
    `useBase64URL: true` (blob: fonts are blocked by `font-src`). The pptx
    renderer runs with `RECOMMENDED_ZIP_LIMITS` and `pdfjs: false`.
  - **Rendering paths:**
    - Sheets and plain text render through React, which escapes them.
    - Markdown renders through `MarkdownRenderer`.
    - PDF draws to canvas only, with no annotation or text layer, so there is no
      link surface. Scripting is off, and `useWasm: false` keeps the CSP intact.
  - **ZIP preflight:** a central-directory budget check (≤ 4000 entries,
    ≤ 512 MiB declared uncompressed) runs before docx/xlsx/ods/pptx parsing,
    because JSZip and SheetJS have no ZIP-bomb limits.
  - **Rejected: a sandboxed iframe.** The libraries need script in the frame, so
    it adds no protection beyond the CSP (research §Cross-cutting security).
- **D4. Libraries: the research recommendations.**
  - pdf: `pdfjs-dist` 6.4.299, already added by the sibling plan.
  - docx: `docx-preview` 0.4.1.
  - pptx: `@aiden0z/pptx-renderer` 1.3.0, pinned exactly.
  - xlsx/xls/ods/csv: SheetJS CE 0.20.3, vendored as `vendor/xlsx-0.20.3.tgz`,
    because npm `xlsx` 0.18.5 has CVE-2023-30533 (Q2).
  - **No secondary renderers** (mammoth, JSZip slide extractor). On a render
    failure the preview shows "Open in system app" instead (Q3).
  - pdf.js uses the modern build (Q4).
- **D5. Entry points.** These open the preview:
  - Files tree and markdown file links (existing).
  - A **Preview** button on the office card.
  - A **Preview** icon on the Write card when the file type is previewable.
  - Clicking an attachment card that has a `path`, in the composer or the sent
    bubble. The card belongs to the sibling plan.
- **D6. Limits and degraded states.**
  - The 32 MiB cap and the ZIP budget apply to every file.
  - Sheets show the first 5000 rows × 100 columns per visible sheet, with
    virtualized rows (`@tanstack/react-virtual`, already a dependency) and a
    "first N of M" note.
  - PDFs show the first 300 pages, each rendered lazily when it scrolls near.
  - Text shows the first 200 KB (today's Files limit).
  - The pptx renderer uses its windowed list.
  - Every failure shows a localized reason plus "Open in system app"
    (`PathLink`). Legacy .doc/.ppt are not in the allowlist, so they show
    "unsupported type" plus the same button.
- **D7. Staleness.**
  - Every successful `tool_execution_end` bumps `useUiStore.previewRefreshSeq`.
  - The open preview then re-reads with `ifChanged`, and re-renders only when the
    size or mtime moved.
  - A **Reload** button in the preview header forces a full read.
  - Images and other text files refresh on Reload; their read commands have no
    mtime.
- **D8. Coordination with the attachment-cards plan.** This plan is
  `blockedBy` it: both edit `ipc-types.ts`, `create-omp-api.ts`, `src/main/ipc.ts`,
  `services/ipc.rs`, `services/mod.rs`, `tests/channels.rs` and the locales, and
  that plan is being implemented now.
  - **What this plan uses from it:** `pdfjs-dist` in `package.json`,
    `src/renderer/lib/pdf-thumbnail.ts` and `AttachmentCard`.
  - **Shared pdf.js setup:** phase 3 moves the pdf.js setup into one shared
    loader, `src/renderer/lib/pdfjs-loader.ts`, and points `pdf-thumbnail.ts`
    at it. That removes `isEvalSupported`, which pdf.js 6 no longer declares
    (absent from `node_modules/pdfjs-dist/types/src/display/api.d.ts`).
  - **If the sibling has not landed,** phase 1's gate fails and work stops.
  - **If it is cancelled,** re-plan. The pieces to re-home are the pdfjs-dist
    dependency, the `?url` module declaration and the attachment-card entry
    point.

## Constraints

- No LibreOffice or headless converter (SAI OS has none). Rendering stays in the
  renderer with JS.
- Both shells:
  - Linux uses Tauri with WebKitGTK; macOS uses Electron. Every new IPC
    command gets a type, a bridge entry, an Electron handler, a Rust handler, a
    scope-table entry and a registration.
  - Rust tests have TS twins (`services.parity.json`). The channel count in
    `src-tauri/tests/channels.rs:14` and the API snapshots are updated.
- The CSP is unchanged in `src/renderer/index.html`, `quick-entry.html` and
  `src-tauri/tauri.conf.json:16`. No `wasm-unsafe-eval`, no CDN.
- Heavy libraries load lazily:
  - Each lives in its own chunk rule in `vite.renderer.shared.ts:20` and is
    listed in `LAZY_CHUNKS` (`scripts/check-renderer-chunks.ts:14`).
  - Views are `React.lazy` modules.
- Untrusted document and model content is never injected as raw HTML into the
  main document.
- i18n: every string goes in both `en.ts` and `vi.ts`.
- Tests:
  - Use the linkedom harness and reset stores through setters.
  - Never `mock.module()`. Test doubles are assigned to `window.omp` or injected
    through props.
- Commits go to this GUI repo, use conventional messages and carry no plan IDs
  in code, test names or commits.

## Non-goals

- Editing, saving, converting or annotating documents.
- Previews for audio, video, archives and legacy .doc/.ppt. These show
  "unsupported type" plus "Open in system app".
- Several previews at once (tabs inside the preview).
- PDF text selection or search, spreadsheet cell styling (a SheetJS Pro
  feature), and docx field recomputation.

## Phases

| # | Phase | Owns | Depends on | Effort |
|---|---|---|---|---|
| 1 | [Document byte transport](phase-01-document-byte-transport.md) | `fs:read-document` in types, bridge, Electron, Rust, parity, snapshots | sibling plan | 5h |
| 2 | [Preview surface and plain formats](phase-02-preview-surface-and-plain-formats.md) | `components/preview/*` core, `FilesPanel.tsx`, `PanelContainer.tsx`, `stores/ui.ts`, `use-rpc-events.ts` | 1 | 6h |
| 3 | [PDF and Word views](phase-03-pdf-and-word-views.md) | `lib/pdfjs-loader.ts`, `PdfView`, `DocxView`, shadow container, chunk rules, pdf.js assets | 2 | 5h |
| 4 | [Slides and spreadsheet views](phase-04-slides-and-spreadsheet-views.md) | `PptxView`, `SheetView`, `sheet-model.ts`, vendored SheetJS, chunk rules | 3 | 5h |
| 5 | [Entry points on cards](phase-05-entry-points-on-cards.md) | `OfficeFileRenderer.tsx`, `WriteRenderer.tsx`, `AttachmentCard.tsx` | 2 (4 for full value) | 2h |
| 6 | [End-to-end in both shells](phase-06-end-to-end-in-both-shells.md) | `e2e/preview-fixtures.ts`, `e2e/document-preview.e2e.ts`, `e2e-tauri/document-preview.e2e.ts` | 1–5 | 4h |

Phases run strictly in order: 3 and 4 both edit `vite.renderer.shared.ts`,
`check-renderer-chunks.ts`, `package.json` and `document-views.ts`, and the
executor is a single agent.

## Shared contracts (fixed in phase 1/2; later phases code against them)

```ts
// src/shared/ipc-types.ts (phase 1)
IPC_COMMANDS.FS_READ_DOCUMENT = "fs:read-document";
export type DocumentKind = "pdf" | "docx" | "pptx" | "xlsx" | "xls" | "ods" | "csv" | "markdown" | "text";
export type IpcFsReadDocumentError =
  | "invalid-path" | "no-workspace" | "outside-workspace" | "not-found" | "not-a-file"
  | "too-large" | "unsupported-type" | "content-mismatch" | "read-failed";
export interface IpcFsDocumentStamp { size: number; mtimeMs: number }
export interface IpcFsReadDocumentPayload { path: string; tabId?: string; ifChanged?: IpcFsDocumentStamp }
export interface IpcFsReadDocumentResult {
  ok: boolean; kind?: DocumentKind; data?: string /* base64 */; unchanged?: boolean;
  size: number; mtimeMs: number; error?: IpcFsReadDocumentError;
}
// OmpApi.fs
readDocument(path: string, tabId?: string, ifChanged?: IpcFsDocumentStamp): Promise<IpcFsReadDocumentResult>;

// src/renderer/components/preview/preview-kind.ts (phase 2)
export type PreviewKind = "pdf" | "docx" | "pptx" | "sheet" | "markdown" | "text" | "image" | "other";
export type DocumentViewKind = "pdf" | "docx" | "pptx" | "sheet";
export function previewKindOf(path: string): PreviewKind;
export function isDocumentViewKind(kind: PreviewKind): kind is DocumentViewKind;

// src/renderer/components/preview/document-views.ts (phase 2 creates, 3–4 fill)
export interface DocumentViewProps { bytes: Uint8Array; documentKind: DocumentKind; onError: (error: unknown) => void }
export type DocumentViews = Partial<Record<DocumentViewKind, ComponentType<DocumentViewProps>>>;
export const DOCUMENT_VIEWS: DocumentViews;

// src/renderer/stores/ui.ts (phase 2)
previewRefreshSeq: number; bumpPreviewRefresh(): void;

// src/renderer/lib/pdfjs-loader.ts (phase 3; also used by the sibling's pdf-thumbnail.ts)
export function loadPdfjs(): Promise<typeof import("pdfjs-dist")>;
export function pdfDocumentOptions(data: Uint8Array, baseUrl?: string): DocumentInitParameters;
```

Data flow: entry point → `openFilePreview(path)` → `FilesPanel` →
`DocumentPreview{path, tabId}` → `loadPreview()` → `window.omp.fs.readDocument` or
`readImage` → main/Rust handler (resolve, stat, cap, sniff, base64) →
`Uint8Array` → ZIP budget check → lazy view (`PdfView`, `DocxView`, `PptxView` or
`SheetView`), or `TextPreview` / `<img>` → user. Staleness: `tool_execution_end`
→ `bumpPreviewRefresh()` → `loadPreview(…, ifChanged)` → `unchanged`, or new bytes
and a re-render.

## Acceptance criteria

1. At 1280, 1440 and 1920 px windows, opening any supported file shows the
   preview in a docked column. The composer `textarea` stays visible, and its
   right edge is ≤ the drawer's left edge (the e2e checks this at the default
   size).
2. In a split workspace wider than 1000 px, opening a preview docks the drawer
   instead of overlaying it. Closing the preview restores the overlay.
3. The assistant-pack generated report (.docx), deck (.pptx), an exceljs
   workbook (.xlsx), a .csv, a PDF, a .md and a .png each render in both shells,
   with no CSP violation and no page error.
4. The office card Preview button, the Write card Preview icon, a markdown file
   link, a Files tree click and an attachment-card click each open the preview
   of that path.
5. A missing, oversized, mismatched, unsupported or corrupt file shows its
   localized reason and an "Open in system app" button. The app does not crash.
6. Rewriting the previewed file and then finishing any tool call, or clicking
   Reload, shows the new content.
7. `bunx vitest run`, `bun run check:types`, biome on touched files, clippy,
   `cargo test`, `bun scripts/check-test-parity.ts services`,
   `bash scripts/check-module.sh snapshots`, `bun run build` (lean entry),
   `bun e2e-tauri/check-twins.ts`, and both e2e specs all pass.

## Risks

| Risk | L×I | Mitigation |
|---|---|---|
| The sibling plan changes the shared IPC files while this plan runs | M×H | `blockedBy` plus the phase-1 gate (tree clean, sibling symbols present) |
| pdf.js worker, cMaps or standard fonts fail to load from `file://` in packaged Electron | M×M | The Electron e2e runs the built `out/` (file://) and asserts a painted canvas. pdf.js falls back to a main-thread worker and system fonts. If the canvas stays blank, STOP via the Failure Protocol |
| SAI OS WebKitGTK is older than pdf.js modern needs (about 2.48) | M×M | Q4; the legacy build switch is a one-line import change in `pdfjs-loader.ts` |
| `@aiden0z/pptx-renderer` has a bus factor of one | M×M | Exact pin; a render failure degrades to "Open in system app" |
| A ZIP bomb or huge sheet freezes the renderer | L×H | 32 MiB cap, central-directory budget, row and column caps, lazy pages |
| A document link navigates the webview | L×H | Capture-phase link guard; both shells already block navigation |
| A vendor chunk is folded into the entry | M×M | `bun run build` runs `check-renderer-chunks`; chunk rules plus `LAZY_CHUNKS` in phases 3–4 |
| Docking in a split at 1280 px leaves about 330 px per pane | M×L | Only while a preview is open; the user can close it or drag it narrower |

Rollback: each phase is one commit or a small series; `git revert` the phase's
commits in reverse order. Phase 1 leaves an unused command if reverted alone.
Phases 3 and 4 revert cleanly to "Open in system app" fallbacks, because
`DOCUMENT_VIEWS` just loses entries.

## Validation commands

```bash
bunx vitest run
bun run check:types
bunx biome check <touched files>
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features
bun scripts/check-test-parity.ts services
bash scripts/check-module.sh snapshots
bun run build
bun e2e-tauri/check-twins.ts
scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts
scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts
```

## Unresolved questions

- **Q1.** At window widths of 1000 px or less the drawer still overlays the chat,
  which is today's compact behaviour. Is that acceptable, or should a preview
  also dock there (the chat would be about 440 px wide with the sidebar open)?
- **Q2.** Is vendoring `vendor/xlsx-0.20.3.tgz` (SheetJS CE, Apache-2.0) into the
  repo acceptable? The alternative is exceljs (263 KB gz, unmaintained since
  2023-10).
- **Q3.** Should a docx or pptx that its renderer cannot draw get a
  lower-fidelity fallback (mammoth for docx, a text-and-images slide list for
  pptx)? This plan defaults to "Open in system app" only.
- **Q4.** What is the WebKitGTK version on SAI OS? Below about 2.48, pdf.js must
  use `pdfjs-dist/legacy/build/*`.
- **Q5.** The drawer widens itself to 45 % when a document opens, and the new
  width persists as the user's panel width. Should the widened width be
  temporary instead?

=== FILE: phase-01-document-byte-transport.md ===
---
phase: 1
title: "Document byte transport"
status: pending
priority: P1
effort: "5h"
dependencies: []
---
# Phase 1: Document byte transport

## Goal

Add one IPC command, `fs:read-document`, to both shells. It returns a document's
bytes (base64) and its kind, and supports a conditional "unchanged" reply. The
policy is identical in Electron (`src/main/fs-read-document.ts`) and Tauri
(`src-tauri/src/services/fs_read_document.rs`), proven by twin tests with
identical names.

Policy order (both shells, exactly this order; the first failing check returns):

1. `path` is not a non-empty string → `invalid-path`.
2. The extension, lower-cased, is not in the table below → `unsupported-type`.
3. `~/` is expanded. A relative path with no workspace → `no-workspace`. A
   relative path that escapes the workspace → `outside-workspace`.
4. `stat` fails with not-found → `not-found`; any other stat error →
   `read-failed`.
5. The path is not a regular file → `not-a-file`.
6. size > `FS_DOCUMENT_MAX_BYTES` (32 MiB = 33554432) → `too-large`.
7. `ifChanged` is given and matches both `size` and `mtimeMs` →
   `{ ok: true, kind, unchanged: true, size, mtimeMs }` (the file is not read).
8. The read fails → `read-failed`.
9. The sniff fails → `content-mismatch`.
10. Otherwise → `{ ok: true, kind, data: base64, size, mtimeMs }`.

The extension table:

| Extensions | kind | sniff |
|---|---|---|
| `pdf` | `pdf` | bytes 0..5 == `%PDF-` |
| `docx` / `pptx` / `xlsx` / `ods` | same as ext | bytes 0..4 == `50 4B 03 04` |
| `xls` | `xls` | bytes 0..8 == `D0 CF 11 E0 A1 B1 1A E1` |
| `csv` | `csv` | no `0x00` in the first 8192 bytes |
| `md` / `mdx` / `markdown` | `markdown` | no `0x00` in the first 8192 bytes |
| `txt` | `text` | no `0x00` in the first 8192 bytes |

Failure shape: `{ ok: false, size: <stat size or 0>, mtimeMs: 0, error: <code> }`.
`mtimeMs` is an integer: `Math.floor(stat.mtimeMs)` in TS and the
milliseconds of `metadata.modified()` since the Unix epoch in Rust.

## Files to Create / Modify

- Precondition (read only): `plans/261007-1931-drop-file-attachment-cards/plan.md`.
- Create:
  - `src/main/workspace-path.ts`
  - `src/main/fs-read-document.ts`
  - `src/main/fs-read-document.test.ts`
  - `src-tauri/src/services/fs_read_document.rs`
- Modify:
  - `src/shared/ipc-types.ts`
  - `src/shared/bridge/create-omp-api.ts`
  - `src/shared/bridge/create-omp-api.test.ts`
  - `src/main/ipc.ts` (move `resolveWithin` at line 241 out, add the handler
    beside `FS_READ_PDF` around line 1080)
  - `src-tauri/src/services/ipc.rs`
  - `src-tauri/src/services/mod.rs` (`mod` list at lines 6-18, `CHANNELS` around
    line 57, `register` around line 89)
  - `src-tauri/tests/channels.rs` (`EXPECTED_CHANNEL_COUNT`, line 14)
  - `src-tauri/contracts/services.parity.json`
  - `src-tauri/contracts/*.api.txt` (regenerated)

## Test Matrix (TDD)

Twin test names. The TS `it("…")` text and the Rust `fn` are the same name,
normalized by `scripts/check-test-parity.ts`.

| # | TS `it(...)` in `src/main/fs-read-document.test.ts` | Rust `#[test] fn` in `fs_read_document.rs` | Expectation |
|---|---|---|---|
| 1 | reads a docx inside the workspace by a relative path | `reads_a_docx_inside_the_workspace_by_a_relative_path` | ok, kind docx, data decodes to the bytes |
| 2 | reads an absolute path outside the workspace | `reads_an_absolute_path_outside_the_workspace` | ok with cwd = None/null |
| 3 | refuses a relative path that escapes the workspace | `refuses_a_relative_path_that_escapes_the_workspace` | `outside-workspace` |
| 4 | refuses a relative path without a workspace | `refuses_a_relative_path_without_a_workspace` | `no-workspace` |
| 5 | refuses a file over the size cap | `refuses_a_file_over_the_size_cap` | `too-large` (cap injected as 16) |
| 6 | refuses an extension it cannot preview | `refuses_an_extension_it_cannot_preview` | `unsupported-type` for `a.exe` |
| 7 | refuses a docx that is not a zip | `refuses_a_docx_that_is_not_a_zip` | `content-mismatch` |
| 8 | refuses a pdf without the pdf signature | `refuses_a_pdf_without_the_pdf_signature` | `content-mismatch` |
| 9 | accepts a legacy xls compound file | `accepts_a_legacy_xls_compound_file` | ok, kind xls |
| 10 | refuses a text file containing a nul byte | `refuses_a_text_file_containing_a_nul_byte` | `content-mismatch` for `notes.md` |
| 11 | reports unchanged when size and mtime match | `reports_unchanged_when_size_and_mtime_match` | `unchanged: true`, no `data` |
| 12 | refuses a directory | `refuses_a_directory` | `not-a-file` for a dir named `x.pdf` |
| 13 | reports a missing file as not found | `reports_a_missing_file_as_not_found` | `not-found` |

Plus bridge test (`create-omp-api.test.ts`): `readDocument` invokes
`fs:read-document` with `{ path, tabId, ifChanged }`. Plus
`src-tauri/tests/channels.rs` (existing): fails while the TS channel has no Rust
owner.

Red state: the TS file fails to import `./fs-read-document` (vitest exit 1); the
Rust tests fail to compile (cargo exit 101); `--test channels` fails (exit 101).
Green: all exit 0.

## Tasks

### Task 1.1 — Precondition gate
- **Goal:** start only on top of the landed attachment-cards plan and a clean tree.
- **Target files and symbols:** `src-tauri/src/services/mod.rs` (`"fs:read-pdf"`), `src/renderer/components/attachments/AttachmentCard.tsx`, `src/renderer/lib/pdf-thumbnail.ts`.
- **Steps:**
  1. Run `git -C /home/tung491/WORK/oh-my-pi-gui status --porcelain -- src src-tauri e2e e2e-tauri scripts package.json | wc -l`.
  2. Run `grep -c '"fs:read-pdf"' src-tauri/src/services/mod.rs`.
  3. Run `test -f src/renderer/components/attachments/AttachmentCard.tsx && test -f src/renderer/lib/pdf-thumbnail.ts; echo $?`.
- **Success criteria:** step 1 prints `0`; step 2 prints `2`; step 3 prints `0`.
- **Verify:** the three outputs are exactly `0`, `2`, `0`.

### Task 1.2 — Red: TS twin tests and bridge test
- **Goal:** write the failing TS tests first.
- **Target files and symbols:** `src/main/fs-read-document.test.ts` (new), `src/shared/bridge/create-omp-api.test.ts` (add one `it`).
- **Steps:**
  1. Create `src/main/fs-read-document.test.ts`.
     - Model it on `src/main/fs-read-pdf.test.ts`: temp dirs from
       `fs.mkdtemp(path.join(os.tmpdir(), "omp-read-document-"))`, removed in
       `afterEach`.
     - Import `readDocumentFile` and `FS_DOCUMENT_MAX_BYTES` from
       `./fs-read-document`.
     - Write the 13 `it` cases from the Test Matrix with the exact titles.
     - Fixture bytes: docx = `PK\x03\x04` followed by any 20 bytes; xls = the
       8-byte CFB signature followed by any bytes; pdf = `%PDF-1.4\n…`.
     - Call shape:
       `readDocumentFile(rawPath, { cwd: string | null, maxBytes?: number, ifChanged?: IpcFsDocumentStamp })`.
     - Case 5 passes `maxBytes: 16`.
     - Case 11 first reads, then reads again with
       `ifChanged: { size: r.size, mtimeMs: r.mtimeMs }`.
  2. In `create-omp-api.test.ts`, add `it("reads a document through fs:read-document", …)`.
     Copy the `readPdf` test (around line 187). Call
     `api.fs.readDocument("/docs/a.docx", "t1", { size: 5, mtimeMs: 9 })` and
     expect `invokes` to equal
     `[{ channel: IPC_COMMANDS.FS_READ_DOCUMENT, args: [{ path: "/docs/a.docx", tabId: "t1", ifChanged: { size: 5, mtimeMs: 9 } }] }]`.
- **Success criteria:** both test files fail.
- **Verify:** `bunx vitest run src/main/fs-read-document.test.ts src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` prints `exit=1`.

### Task 1.3 — Green: TS types, path helper, Electron module, bridge
- **Goal:** make the TS tests pass.
- **Target files and symbols:** `src/shared/ipc-types.ts` (`IPC_COMMANDS.FS_READ_DOCUMENT`, the types in plan.md Shared contracts, `OmpApi.fs.readDocument`); `src/main/workspace-path.ts` (`resolveWithin`); `src/main/ipc.ts` (import it); `src/main/fs-read-document.ts` (`FS_DOCUMENT_MAX_BYTES`, `readDocumentFile`); `src/shared/bridge/create-omp-api.ts` (`fs.readDocument`).
- **Steps:**
  1. In `ipc-types.ts`:
     - Add `FS_READ_DOCUMENT: "fs:read-document",` directly after
       `FS_READ_PDF`, with a doc comment.
     - Add `DocumentKind`, `IpcFsReadDocumentError`, `IpcFsDocumentStamp`,
       `IpcFsReadDocumentPayload` and `IpcFsReadDocumentResult` exactly as in
       plan.md, after `IpcFsReadPdfResult`.
     - Add
       `readDocument(path: string, tabId?: string, ifChanged?: IpcFsDocumentStamp): Promise<IpcFsReadDocumentResult>;`
       after `readPdf` in `OmpApi.fs`.
  2. Move `resolveWithin` (`src/main/ipc.ts:240-246`, body unchanged) into a new
     `src/main/workspace-path.ts` as `export function resolveWithin`. In
     `ipc.ts`, delete the local function and add
     `import { resolveWithin } from "./workspace-path";`.
  3. Write `src/main/fs-read-document.ts`, following the style of
     `src/main/fs-read-pdf.ts`.
     - Export `FS_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024`.
     - Export `async function readDocumentFile(rawPath: unknown, options: { cwd: string | null; homeDir?: string; maxBytes?: number; ifChanged?: IpcFsDocumentStamp }): Promise<IpcFsReadDocumentResult>`.
     - Apply the policy order in the Goal exactly.
     - Map the extension with
       `path.extname(p).slice(1).toLowerCase()`.
     - `ENOENT` → `not-found`.
     - Never throw.
  4. In `create-omp-api.ts`, after `readPdf`, add
     `readDocument: (path, tabId, ifChanged) => port.invoke(IPC_COMMANDS.FS_READ_DOCUMENT, { path, tabId, ifChanged }) as Promise<IpcFsReadDocumentResult>,`
     and import the type.
- **Success criteria:** the TS tests pass; types compile.
- **Verify:** `bunx vitest run src/main/fs-read-document.test.ts src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` prints `exit=0`, then `bun run check:types; echo "exit=$?"` prints `exit=0`.

### Task 1.4 — Electron handler
- **Goal:** serve the command in Electron.
- **Target files and symbols:** `src/main/ipc.ts` (`ipcMain.handle(IPC_COMMANDS.FS_READ_DOCUMENT, …)`).
- **Steps:**
  1. Directly after the `FS_READ_PDF` handler, add a `FS_READ_DOCUMENT` handler.
     It calls
     `readDocumentFile(payload?.path, { cwd: cwdFor(deps, event, payload?.tabId), ifChanged: payload?.ifChanged })`,
     with `payload: IpcFsReadDocumentPayload | undefined`.
  2. Import `readDocumentFile` and the payload type.
- **Success criteria:** the handler is registered once.
- **Verify:** `grep -c "IPC_COMMANDS.FS_READ_DOCUMENT" src/main/ipc.ts` prints `1`; `bun run check:types; echo "exit=$?"` prints `exit=0`.

### Task 1.5 — Red: Rust twin tests and channel ownership
- **Goal:** failing Rust tests with the twin names.
- **Target files and symbols:** `src-tauri/src/services/fs_read_document.rs` (new, test module only plus the `pub(super) const FS_DOCUMENT_MAX_BYTES: u64`); `src-tauri/src/services/mod.rs` (`mod fs_read_document;`).
- **Steps:**
  1. Create `fs_read_document.rs`.
     - Give it a `//!` doc line, the constant, and `#[cfg(test)] mod tests`
       with the 13 `#[test]` functions named in the Test Matrix.
     - Each test uses `tempfile::tempdir()` and calls
       `read_document(raw: &str, cwd: Option<&Path>, if_changed: Option<(u64, u64)>, max_bytes: u64) -> serde_json::Value`
       (not yet written).
     - Each test asserts on `value["ok"]`, `value["error"]`, `value["kind"]`
       and `value["unchanged"]` with `assert_eq!`.
     - Follow `src-tauri/src/services/fs.rs:330-400`.
  2. Add `mod fs_read_document;` to the `mod` list in `services/mod.rs`, in
     alphabetical order.
- **Success criteria:** the crate's tests do not compile (missing `read_document`), and the channel test fails on the new TS channel.
- **Verify:** `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features fs_read_document; echo "exit=$?"` prints `exit=101`.

### Task 1.6 — Green: Rust implementation, handler, registration
- **Goal:** the Rust twin passes and the channel is owned.
- **Target files and symbols:** `fs_read_document.rs` (`pub(super) fn read_document`); `services/ipc.rs` (`pub fn fs_read_document`); `services/mod.rs` (`CHANNELS`, `register`); `tests/channels.rs` (`EXPECTED_CHANNEL_COUNT`).
- **Steps:**
  1. Implement `read_document` in the policy order of the Goal.
     - Use `super::ipc::expand_home` (`ipc.rs:18`) and
       `super::fs::resolve_within` (`fs.rs:146`).
     - `std::io::ErrorKind::NotFound` → `not-found`.
     - Compute mtime with
       `metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))`.
     - Encode with `base64::engine::general_purpose::STANDARD` (already
       imported in `ipc.rs:8`).
     - Build the JSON with `serde_json::json!`, using the field names from
       plan.md (`mtimeMs`, camelCase).
  2. In `services/ipc.rs`, add `pub fn fs_read_document(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply` after `fs_read_image`.
     - Read `path` (str, default `""`), `tabId` and `ifChanged.size` /
       `ifChanged.mtimeMs` (`as_u64`, or `as_f64` floored when the value is a
       float).
     - Compute
       `cwd = ctx.tabs.cwd_for(caller, tab_id).map(PathBuf::from)`.
     - Return `Reply::ok(read_document(…, FS_DOCUMENT_MAX_BYTES))`.
     - Give it a `///` doc comment stating the policy, as `fs_read_image` has at
       `ipc.rs:475-478`.
  3. In `services/mod.rs`, add `("fs:read-document", Scope::Main),` after
     `("fs:read-image", Scope::Main),` in `CHANNELS`, and
     `reg.register("fs:read-document", Scope::Main, ipc::fs_read_document);`
     after the `fs:read-image` registration.
  4. In `src-tauri/tests/channels.rs:14`, increase `EXPECTED_CHANNEL_COUNT` by
     exactly 1 from its current value.
- **Success criteria:** twin tests, channel test and clippy pass.
- **Verify:**
  - `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features fs_read_document; echo "exit=$?"` prints `exit=0`, and the output contains `13 passed`.
  - `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features --test channels; echo "exit=$?"` prints `exit=0`.
  - `PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings; echo "exit=$?"` prints `exit=0`.

### Task 1.7 — Parity mapping
- **Goal:** the parity gate covers the new twins.
- **Target files and symbols:** `src-tauri/contracts/services.parity.json`.
- **Steps:** append `{ "ts": "src/main/fs-read-document.test.ts", "rust": "src-tauri/src/services/fs_read_document.rs" }` as the last array element (2-space JSON indentation as in the file).
- **Success criteria:** the gate passes.
- **Verify:** `bun scripts/check-test-parity.ts services; echo "exit=$?"` prints `exit=0`.

### Task 1.8 — API snapshots
- **Goal:** record the new public handler in the frozen snapshots.
- **Target files and symbols:** `src-tauri/contracts/*.api.txt`.
- **Steps:**
  1. Run:
     ```bash
     source scripts/rust-pins.env
     test -f out/renderer-tauri/index.html || bun run build:renderer:tauri
     SNAP=$(mktemp)
     (cd src-tauri && "$CARGO_HOME_BIN/cargo" "+$PUBLIC_API_TOOLCHAIN" public-api -ss) > "$SNAP"
     for f in src-tauri/contracts/*.api.txt; do s=$(basename "$f" .api.txt); grep "sai_atlas_lib::${s}::" "$SNAP" > "$f" || true; done
     ```
  2. Run `git diff -U0 -- src-tauri/contracts/*.api.txt | grep -E '^[+-][^+-]' | grep -vc fs_read_document`.
- **Success criteria:** the only snapshot changes are lines naming `fs_read_document`.
- **Verify:** step 2 prints `0`; `bash scripts/check-module.sh snapshots; echo "exit=$?"` ends with a line starting `check-module snapshots: PASS` and prints `exit=0`.

### Task 1.9 — Commit
- **Goal:** one focused commit.
- **Steps:**
  1. Run `bunx biome check src/main/fs-read-document.ts src/main/fs-read-document.test.ts src/main/workspace-path.ts src/main/ipc.ts src/shared/ipc-types.ts src/shared/bridge/create-omp-api.ts src/shared/bridge/create-omp-api.test.ts`.
  2. Run `git add` on the phase files, then `git commit -m "feat(fs): read previewable documents as bytes in both shells"`.
- **Verify:** biome prints `exit=0` (append `; echo "exit=$?"`); `git log -1 --format=%s` prints `feat(fs): read previewable documents as bytes in both shells`.

## Verification

- `bunx vitest run src/main src/shared; echo "exit=$?"` → `exit=0`.
- `bun run check:types; echo "exit=$?"` → `exit=0`.
- `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features; echo "exit=$?"` → `exit=0`.
- clippy (Task 1.6) → `exit=0`.
- `bun scripts/check-test-parity.ts services; echo "exit=$?"` → `exit=0`.
- `bash scripts/check-module.sh snapshots; echo "exit=$?"` → `exit=0`.

## Risks & Rollback

- **The twins diverge** (for example in mtime units). Mitigation: both shells
  floor to integer milliseconds, and each test compares only within one shell.
- **Moving `resolveWithin` changes behavior.** Mitigation: the body is
  unchanged, and the existing `src/main` tests run in the Verification step.
- **An absolute-path read widens the read surface.** Mitigation: the extension
  allowlist, the sniff and the cap; the bytes only reach a local render (the
  same rationale as `fs:read-image`, `src/main/ipc.ts:1005-1010`).
- **Rollback:** `git revert <phase-1 commit>`. Nothing calls `readDocument`
  until phase 2.

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

=== FILE: phase-02-preview-surface-and-plain-formats.md ===
---
phase: 2
title: "Preview surface and plain formats"
status: pending
priority: P1
effort: "6h"
dependencies: [1]
---
# Phase 2: Preview surface and plain formats

## Goal

Replace the Files drawer's text-only preview with `DocumentPreview`:

- **Formats rendered in this phase:** markdown and text (any path through
  `fs:read-document`) and images (through `fs:read-image`). Every other file
  keeps today's `fs:read` path.
- **Document kinds** (pdf/docx/pptx/sheet) go through the empty
  `DOCUMENT_VIEWS` table. Until phases 3–4 fill it, they show "unsupported type"
  plus "Open in system app".
- **Error states** carry localized reasons.
- **Reload** sits in the preview header.
- **Staleness:** a successful `tool_execution_end` triggers a conditional
  re-read.
- **ZIP preflight:** the budget check.
- **Link guard:** the helper the views will use.
- **Drawer layout:** it docks beside a split workspace while a preview is open,
  and widens for documents.

## Files to Create / Modify

- Create:
  - `src/renderer/components/preview/preview-kind.ts`
  - `src/renderer/components/preview/preview-kind.test.ts`
  - `src/renderer/components/preview/load-preview.ts`
  - `src/renderer/components/preview/load-preview.test.ts`
  - `src/renderer/components/preview/zip-budget.ts`
  - `src/renderer/components/preview/zip-budget.test.ts`
  - `src/renderer/components/preview/link-guard.ts`
  - `src/renderer/components/preview/link-guard.test.ts`
  - `src/renderer/components/preview/document-views.ts`
  - `src/renderer/components/preview/PreviewErrorBoundary.tsx`
  - `src/renderer/components/preview/TextPreview.tsx`
  - `src/renderer/components/preview/DocumentPreview.tsx`
  - `src/renderer/components/preview/DocumentPreview.test.tsx`
- Modify:
  - `src/renderer/components/panels/FilesPanel.tsx`
  - `src/renderer/components/layout/PanelContainer.tsx` (line 127 overlay rule;
    width effect)
  - `src/renderer/components/layout/PanelContainer.test.tsx` (the markdown-link
    test at line 152 moves to `readDocument`; new docking tests)
  - `src/renderer/stores/ui.ts` (`previewRefreshSeq`, `bumpPreviewRefresh`)
  - `src/renderer/hooks/use-rpc-events.ts` (`tool_execution_end` case, line 326)
  - `src/renderer/hooks/use-rpc-events.test.tsx`
  - `src/renderer/locales/en.ts`
  - `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| `previewKindOf`: `REPORT.DOCX`→docx, `a.pptx`→pptx, `t.xlsx`/`t.xls`/`t.ods`/`t.csv`→sheet, `a.pdf`→pdf, `n.md`/`n.mdx`/`n.markdown`→markdown, `n.txt`→text, `p.PNG`/`p.jpg`/`p.jpeg`/`p.webp`/`p.gif`→image, `x.tar.gz`/`.env`/`dir.v2/file`/`Makefile`→other | `preview-kind.test.ts` | import fails → passes |
| `loadPreview`: markdown bytes decode to text; text over 200000 bytes is truncated with `truncated: true`; docx → `{status:"bytes"}` with a `Uint8Array`; `ok:false` → `{status:"error", code}`; `unchanged` → `{status:"unchanged"}`; image → `readImage` data URL; a thrown IPC error → `read-failed` | `load-preview.test.ts` (stub `window.omp.fs`) | import fails → passes |
| `checkZipBudget`: a JSZip-made docx → `ok`; 5 entries with `maxEntries: 4` → `too-complex`; one 2000-byte entry with `maxTotalUncompressed: 1000` → `too-complex`; random bytes → `corrupt` | `zip-budget.test.ts` | import fails → passes |
| `guardLinks`: an `https:` anchor click → prevented and opened; `file:`, `javascript:` and `#x` → prevented, not opened; a click outside an anchor → not prevented; the remover detaches | `link-guard.test.ts` | import fails → passes |
| `DocumentPreview`: renders a markdown heading; shows a localized `too-large` reason plus an "Open in system app" button; a docx with no registered view shows `unsupported-type`; a docx with an injected view renders it; `bumpPreviewRefresh` re-reads with `ifChanged` and keeps the content on `unchanged`, and swaps it on new data | `DocumentPreview.test.tsx` | import fails → passes |
| The drawer docks in a split while a preview is open; it overlays in a split without one; it widens to 45 % for a `.docx` preview | `PanelContainer.test.tsx` | assertions fail → pass |
| The existing "opens a local markdown link inside the Files drawer" test asserts `readDocument` is called with `docs/report.md` and the `h1` renders | `PanelContainer.test.tsx` | fails (calls `read`) → passes |
| A successful `tool_execution_end` bumps `previewRefreshSeq`; an error one does not | `use-rpc-events.test.tsx` | fails → passes |

## Tasks

### Task 2.1 — Red: pure-module tests
- **Goal:** failing tests for the four pure modules.
- **Target files and symbols:** `preview-kind.test.ts`, `load-preview.test.ts`, `zip-budget.test.ts`, `link-guard.test.ts`.
- **Steps:**
  1. `preview-kind.test.ts`: `it.each` over the cases in the matrix, calling `previewKindOf(path)`.
  2. `load-preview.test.ts`:
     - Assign
       `(window as unknown as { omp: unknown }).omp = { fs: { readDocument: vi.fn(...), readImage: vi.fn(...) } }`.
       In `afterEach`, restore the original (pattern: `PanelContainer.test.tsx:28-29,67-68`).
     - Encode base64 with `Buffer.from(text).toString("base64")`.
     - Signature under test:
       `loadPreview(path: string, tabId: string | null, previous?: IpcFsDocumentStamp): Promise<PreviewSource>`.
     - Assert that the stub received `previous` as its third argument.
  3. `zip-budget.test.ts`:
     - Build zips with
       `new JSZip()…generateAsync({ type: "uint8array", compression: "DEFLATE" })`
       (`jszip` is a devDependency).
     - Signature:
       `checkZipBudget(bytes: Uint8Array, limits?: { maxEntries?: number; maxTotalUncompressed?: number }): "ok" | "too-complex" | "corrupt"`.
  4. `link-guard.test.ts`:
     - Use the linkedom globals (as in `ThinkingBlock.test.tsx`). Create a `div`
       with anchors, then call `guardLinks(div, open)` with
       `open = vi.fn()`.
     - Dispatch
       `new Event("click", { bubbles: true, cancelable: true })` on each anchor.
     - Assert on `event.defaultPrevented` and on the `open` calls.
- **Success criteria:** all four fail because the modules do not exist.
- **Verify:** `bunx vitest run src/renderer/components/preview; echo "exit=$?"` prints `exit=1`.

### Task 2.2 — Green: pure modules
- **Goal:** implement the four modules.
- **Target files and symbols:** `previewKindOf`, `isDocumentViewKind`, `PreviewKind`, `DocumentViewKind`; `loadPreview`, `PreviewSource`, `TEXT_PREVIEW_MAX_BYTES = 200_000`; `checkZipBudget`, `ZIP_MAX_ENTRIES = 4000`, `ZIP_MAX_UNCOMPRESSED = 512 * 1024 * 1024`; `guardLinks`.
- **Steps:**
  1. `preview-kind.ts`: take the last path segment, then the text after its last
     `.` (none when the dot is at index 0 or absent), lower-cased. Map it with a
     `Record<string, PreviewKind>`.
  2. `load-preview.ts`:
     - The `PreviewSource` union:
       - `{status:"text"; markdown: boolean; text; truncated; stamp: IpcFsDocumentStamp}`
       - `{status:"bytes"; kind: DocumentViewKind; documentKind: DocumentKind; bytes: Uint8Array; stamp}`
       - `{status:"image"; dataUrl: string}`
       - `{status:"unchanged"}`
       - `{status:"error"; code: IpcFsReadDocumentError | "image-failed" | "render-failed" | "too-complex"; size: number}`
     - Images call
       `tabId ? readImage(path, tabId) : readImage(path)`.
     - Other kinds call
       `readDocument(path, tabId ?? undefined, previous)`.
     - Decode base64 with `Uint8Array.from(atob(data), c => c.charCodeAt(0))`.
     - Text decodes with `new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES))`.
     - Wrap everything in try/catch → `read-failed`.
  3. `zip-budget.ts`:
     - Find the End Of Central Directory signature `0x06054b50`, scanning
       backwards over at most the last 65557 bytes.
     - Read the entry count (u16 at +10) and the central-directory offset (u32
       at +16).
     - Walk the central-directory headers (signature `0x02014b50`, uncompressed
       size u32 at +24, name/extra/comment lengths at +28/+30/+32) and sum the
       sizes.
     - A missing signature or a walk outside the bounds → `corrupt`. A size
       `0xFFFFFFFF` (ZIP64) or a limit exceeded → `too-complex`.
     - Read with `DataView` little-endian.
  4. `link-guard.ts`:
     - `guardLinks(root: EventTarget, open: (url: string) => void = url => void window.omp.system.openExternal(url)): () => void`.
     - Listen to `click` and `auxclick` with `{ capture: true }`.
     - Find the anchor with
       `(event.target as Element | null)?.closest?.("a")`. If there is none,
       return without preventing.
     - Otherwise call `preventDefault()` and `stopPropagation()`. Read
       `href = getAttribute("href") ?? getAttribute("xlink:href") ?? ""`, and
       call `open(href)` only when `/^https?:\/\//i` matches.
- **Success criteria:** the four test files pass.
- **Verify:** `bunx vitest run src/renderer/components/preview/preview-kind.test.ts src/renderer/components/preview/load-preview.test.ts src/renderer/components/preview/zip-budget.test.ts src/renderer/components/preview/link-guard.test.ts; echo "exit=$?"` prints `exit=0`.

### Task 2.3 — Locale keys
- **Goal:** all phase-2 strings in both locales.
- **Target files and symbols:** `src/renderer/locales/en.ts`, `vi.ts` (add the block after the `filesPanel.*` keys around `en.ts:1147`).
- **Steps:** add these exact key → en / vi pairs:
  - `preview.reload` → "Reload preview" / "Tải lại bản xem trước"
  - `preview.loading` → "Opening preview…" / "Đang mở bản xem trước…"
  - `preview.openInApp` → "Open in system app" / "Mở bằng ứng dụng hệ thống"
  - `preview.error.invalidPath` → "This file path is not valid." / "Đường dẫn tệp không hợp lệ."
  - `preview.error.noWorkspace` → "No workspace is open for this relative path." / "Chưa mở thư mục làm việc nào cho đường dẫn tương đối này."
  - `preview.error.outsideWorkspace` → "This relative path points outside the workspace." / "Đường dẫn tương đối này trỏ ra ngoài thư mục làm việc."
  - `preview.error.notFound` → "The file no longer exists." / "Tệp không còn tồn tại."
  - `preview.error.notAFile` → "This path is a folder, not a file." / "Đường dẫn này là thư mục, không phải tệp."
  - `preview.error.tooLarge` → "This file is larger than {mb} MB, too large to preview." / "Tệp này lớn hơn {mb} MB, quá lớn để xem trước."
  - `preview.error.tooComplex` → "This file unpacks to more data than the preview allows." / "Tệp này giải nén ra nhiều dữ liệu hơn mức bản xem trước cho phép."
  - `preview.error.unsupportedType` → "This file type can't be previewed." / "Không thể xem trước loại tệp này."
  - `preview.error.contentMismatch` → "The file's contents don't match its extension." / "Nội dung tệp không khớp với phần mở rộng của nó."
  - `preview.error.readFailed` → "The file couldn't be read." / "Không đọc được tệp."
  - `preview.error.renderFailed` → "The preview couldn't display this file." / "Không thể hiển thị bản xem trước của tệp này."
  - `preview.error.imageFailed` → "The image couldn't be loaded." / "Không tải được hình ảnh."
- **Success criteria:** locale parity holds.
- **Verify:** `bunx vitest run src/renderer/locales; echo "exit=$?"` prints `exit=0`.

### Task 2.4 — Red: DocumentPreview, store, events, drawer tests
- **Goal:** failing component and integration tests.
- **Target files and symbols:** `DocumentPreview.test.tsx`, `PanelContainer.test.tsx`, `use-rpc-events.test.tsx`.
- **Steps:**
  1. `DocumentPreview.test.tsx`:
     - Use the linkedom harness exactly as in
       `PanelContainer.test.tsx:7-75`, mounting
       `<DocumentPreview path tabId={null} reloadToken={0} views={…} />` inside
       `I18nProvider`.
     - Stub `window.omp.fs.readDocument`.
     - The injected view for the docx case is
       `views={{ docx: ({ bytes }) => <p data-testid="fake-docx">{bytes.length}</p> }}`.
     - The staleness case calls
       `act(() => useUiStore.getState().bumpPreviewRefresh())` and asserts the
       second stub call received
       `{ size, mtimeMs }` as its third argument.
     - In `afterEach`, reset with
       `useUiStore.setState({ previewRefreshSeq: 0 })`.
  2. `PanelContainer.test.tsx`:
     - Change the test at line 152 to stub
       `readDocument: vi.fn(async () => ({ ok: true, kind: "markdown", data: Buffer.from("# Preview heading\n\nRendered body.").toString("base64"), size: 34, mtimeMs: 1 }))`,
       and assert `readDocument.mock.calls[0]?.[0]` is `"docs/report.md"`. Keep
       the `h1` assertion.
     - Add `it("docks beside a split workspace while a file preview is open", …)`:
       set
       `useTabsStore.setState({ split: { axis: "columns", firstTabId: "t0", secondTabId: "t1", ratio: 0.5 } })`
       and `filePreviewPath: "a.md"`, then expect the `aside` className not to
       contain `absolute`.
     - Add `it("overlays a split workspace when no file preview is open", …)`:
       the className contains `absolute`.
     - Add `it("widens to 45 percent of the window for a document preview", …)`:
       with `innerWidth` 1600 and `filePreviewPath: "r.docx"`, expect
       `style.width` to be `720px`.
  3. `use-rpc-events.test.tsx`: add a `describe("useRpcEvents preview refresh")`
     with two `it`s modelled on the `tool_execution_end` test at lines 895-921.
     Use `toolName: "write"`; `isError: false` → `previewRefreshSeq` is 1, and
     `isError: true` → 0.
- **Success criteria:** these tests fail.
- **Verify:** `bunx vitest run src/renderer/components/preview/DocumentPreview.test.tsx src/renderer/components/layout/PanelContainer.test.tsx src/renderer/hooks/use-rpc-events.test.tsx; echo "exit=$?"` prints `exit=1`.

### Task 2.5 — Green: store, events, DocumentPreview, FilesPanel, drawer
- **Goal:** make the Task 2.4 tests pass without breaking the existing ones.
- **Target files and symbols:** `useUiStore` (`previewRefreshSeq`, `bumpPreviewRefresh`); `useRpcEvents` `tool_execution_end`; `DocumentPreview`, `TextPreview`, `PreviewErrorBoundary`, `DOCUMENT_VIEWS`; `FilesPanel`; `PanelContainer`.
- **Steps:**
  1. `ui.ts`:
     - Add `previewRefreshSeq: number` and `bumpPreviewRefresh: () => void` to
       `UiStore`.
     - Initialize with `previewRefreshSeq: 0`, and implement
       `bumpPreviewRefresh: () => set({ previewRefreshSeq: get().previewRefreshSeq + 1 })`.
  2. `use-rpc-events.ts:326`: as the first statement of the
     `case "tool_execution_end": {` block, add
     `if (!event.isError) useUiStore.getState().bumpPreviewRefresh();`. Import
     `useUiStore` if it is not imported yet.
  3. `document-views.ts`: export the `DocumentViewProps` and `DocumentViews`
     types (plan.md contracts) and
     `export const DOCUMENT_VIEWS: DocumentViews = {};`.
  4. `PreviewErrorBoundary.tsx`: a class component with props
     `{ onError: (error: unknown) => void; children: ReactNode }`.
     `componentDidCatch` calls `onError`; once it has failed it renders `null`.
  5. `TextPreview.tsx`: move the markdown and `<pre>` branches of
     `FilesPanel.tsx:233-252` here unchanged, with props
     `{ text: string; markdown: boolean; truncated: boolean }` and the
     `filesPanel.truncated` note (`kb: 200`).
  6. `DocumentPreview.tsx`:
     - Props:
       `{ path: string; tabId: string | null; reloadToken: number; views?: DocumentViews }`,
       where `views` defaults to `DOCUMENT_VIEWS`.
     - **Full load.** On mount, and when `path`/`tabId`/`reloadToken` change,
       call `loadPreview(path, tabId)`. Guard it with a version ref, as in
       `FilesPanel.tsx:58,98-133`.
     - **Refresh.** Watch `useUiStore(s => s.previewRefreshSeq)`. Skip the
       value it had at mount. Then, when the current source is `text` or
       `bytes`, call `loadPreview(path, tabId, source.stamp)`; on `unchanged`
       keep the state, otherwise replace it.
     - **ZIP budget.** For `bytes` with documentKind docx/pptx/xlsx/ods, run
       `checkZipBudget(bytes)`. If it is not `ok`, show the `too-complex` (or
       `render-failed` for `corrupt`) error.
     - **Root element.** Render it with
       `data-preview-kind={previewKindOf(path)}` and
       `data-preview-state="loading" | "ready" | "error"`, as a
       `min-h-0 flex-1 overflow-auto` column.
     - **States:**
       - Loading: `<Spinner size="sm" />` plus `t("preview.loading")`.
       - Error: the message from a
         `Record<code, key>` (`too-large` gets `{ mb: 32 }`), plus
         `<PathLink path={path}>` styled as a button with
         `t("preview.openInApp")`.
       - Text: `<TextPreview>`.
       - Image: `<img alt={basename} src={dataUrl} className="mx-auto block h-auto max-w-full">`.
       - Bytes: `const View = views[kind]`. If it is absent, show
         `unsupported-type`. Otherwise render
         `<Suspense fallback={spinner}><PreviewErrorBoundary onError={() => setRenderFailed(true)}><View key={source.stamp.mtimeMs} bytes={…} documentKind={…} onError={() => setRenderFailed(true)} /></PreviewErrorBoundary></Suspense>`.
       - When `renderFailed` is set, show `render-failed`.
  7. `FilesPanel.tsx`:
     - Add `const [reloadToken, setReloadToken] = useState(0)` and
       `const previewRefreshSeq = useUiStore(s => s.previewRefreshSeq)`.
     - Compute `const previewKind = filePreviewPath ? previewKindOf(filePreviewPath) : "other"`.
     - In the header (after the path `span`, before `PathLink`), add a reload
       `IconButton` (`RefreshCw` size 12, label `t("preview.reload")`). For
       `previewKind !== "other"` it runs `setReloadToken(n => n + 1)`; otherwise
       it runs `void openPreview(filePreviewPath)`.
     - Body: when `previewKind !== "other"`, render
       `<DocumentPreview path={filePreviewPath} tabId={tabId} reloadToken={reloadToken} />`.
       Otherwise keep the existing loading/`<pre>` branch, now through
       `<TextPreview markdown={false} …>`.
     - Make the existing `openPreview` effect (`FilesPanel.tsx:139-145`) run
       only for `previewKind === "other"`, and add `previewRefreshSeq` to its
       dependencies.
  8. `PanelContainer.tsx`:
     - Read
       `const previewOpen = useUiStore(s => s.panelTab === "files" && s.filePreviewPath !== null)`
       and `filePreviewPath`.
     - Change line 127 to
       `compact || (split && !previewOpen) ? "absolute …" : "shrink-0"`.
     - Add an effect on `[filePreviewPath, widthHydrated]`: when
       `widthHydrated` is set and the path's kind satisfies
       `isDocumentViewKind(previewKindOf(path))`, run
       `setWidth(w => Math.max(w, Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.45))))`.
- **Success criteria:** all renderer tests pass and the types compile.
- **Verify:** `bunx vitest run src/renderer; echo "exit=$?"` prints `exit=0`; `bun run check:types; echo "exit=$?"` prints `exit=0`.

### Task 2.6 — Lint and commit
- **Goal:** a clean, focused commit.
- **Steps:**
  1. Run `bunx biome check src/renderer/components/preview src/renderer/components/panels/FilesPanel.tsx src/renderer/components/layout/PanelContainer.tsx src/renderer/components/layout/PanelContainer.test.tsx src/renderer/stores/ui.ts src/renderer/hooks/use-rpc-events.ts src/renderer/hooks/use-rpc-events.test.tsx; echo "exit=$?"`.
  2. Commit with `git commit -m "feat(preview): preview documents beside the chat in the Files drawer"`.
- **Verify:** step 1 prints `exit=0`; `git log -1 --format=%s` prints the message.

## Verification

- `bunx vitest run; echo "exit=$?"` → `exit=0`.
- `bun run check:types; echo "exit=$?"` → `exit=0`.
- `bun run build; echo "exit=$?"` → `exit=0`, and the output contains `index.html entry is lean`.

## Risks & Rollback

- **The existing Files text preview changes.** Mitigation: only the
  md/mdx/markdown/txt/csv and image kinds move to the new path; every other
  extension keeps `fs:read` and the 200 KB cap, and the existing sql test at
  `PanelContainer.test.tsx:189` must stay green.
- **Docking in a split narrows both panes.** Mitigation: it docks only while a
  preview is open, and closing the preview restores the overlay (tested).
- **The refresh fires on every tool end.** Mitigation: `ifChanged` returns no
  bytes when the file is unchanged.
- **Rollback:** `git revert <phase-2 commit>`. Phase 1 stays harmless.

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

=== FILE: phase-03-pdf-and-word-views.md ===
---
phase: 3
title: "PDF and Word views"
status: pending
priority: P1
effort: "5h"
dependencies: [2]
---
# Phase 3: PDF and Word views

## Goal

Render PDF and DOCX in the preview.

- **Shared pdf.js setup.** One loader, `src/renderer/lib/pdfjs-loader.ts`,
  is used by the new `PdfView` and by the sibling's `pdf-thumbnail.ts`. It sets
  the worker from a same-origin `?url` asset, `useWasm: false`, and self-hosted
  cMaps and standard fonts. No scripting, and no annotation or text layer.
- **docx-preview** 0.4.1 renders into an open shadow root with
  `renderAltChunks: false` and `useBase64URL: true`, a link guard, and
  fit-to-width zoom.
- **Lazy chunks.** Both libraries live in lazy chunks, registered in
  `LAZY_CHUNKS`.

## Files to Create / Modify

- Create:
  - `src/renderer/lib/pdfjs-loader.ts`
  - `src/renderer/lib/pdfjs-loader.test.ts`
  - `src/renderer/components/preview/use-shadow-container.ts`
  - `src/renderer/components/preview/PdfView.tsx`
  - `src/renderer/components/preview/docx-options.ts`
  - `src/renderer/components/preview/docx-options.test.ts`
  - `src/renderer/components/preview/DocxView.tsx`
  - `src/renderer/vite-url.d.ts` (only if Task 3.1 finds no `*?url` declaration)
- Modify:
  - `src/renderer/lib/pdf-thumbnail.ts` (sibling file: use `loadPdfjs` and
    `pdfDocumentOptions`)
  - `src/renderer/components/preview/document-views.ts`
  - `vite.renderer.shared.ts` (`VENDOR_CHUNK_RULES` line 20; `plugins` around
    line 74)
  - `scripts/check-renderer-chunks.ts` (`LAZY_CHUNKS` line 14)
  - `package.json`, `bun.lock` (`docx-preview` `0.4.1` exact)
  - `src/renderer/locales/en.ts`, `vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| `pdfDocumentOptions(data, "app://x/index.html")` → `useWasm === false`, `enableXfa === false`, `cMapPacked === true`, `cMapUrl === "app://x/pdfjs/cmaps/"`, `standardFontDataUrl === "app://x/pdfjs/standard_fonts/"`, no `isEvalSupported` key, `data` is the same array | `pdfjs-loader.test.ts` | import fails → passes |
| `DOCX_RENDER_OPTIONS` → `renderAltChunks === false`, `useBase64URL === true`, `className === "docx"`, `inWrapper === true`, `breakPages === true`, `renderComments === false`, `experimental === false` | `docx-options.test.ts` | import fails → passes |
| The sibling's `pdf-thumbnail` tests still pass after the refactor | `src/renderer/lib/pdf-thumbnail.test.ts` (sibling) | green → green |
| The build keeps the entry lean with `pdfjs`, `docx` and `jszip` as lazy chunks | `bun run build` (check-renderer-chunks) | — → output lists the lazy chunks |
| Real rendering in both shells | phase 6 e2e | — |

## Tasks

### Task 3.1 — Precondition: `?url` typing and the sibling loader state
- **Goal:** know which files exist before editing.
- **Steps:**
  1. `grep -rln 'declare module "\*?url"' src/renderer | wc -l`.
  2. `grep -c "pdfjs-dist" src/renderer/lib/pdf-thumbnail.ts`.
- **Success criteria:** both counts are recorded.
- **Verify:** step 2 prints a number ≥ `1` (the sibling's file imports pdf.js). If step 1 prints `0`, Task 3.3 creates `src/renderer/vite-url.d.ts`. If it prints ≥ 1, Task 3.3 skips that file.

### Task 3.2 — Red: option tests
- **Goal:** failing tests for the security-relevant options.
- **Target files and symbols:** `pdfjs-loader.test.ts` (`pdfDocumentOptions`), `docx-options.test.ts` (`DOCX_RENDER_OPTIONS`).
- **Steps:** write the cases in the matrix. The tests import only these two
  modules; neither test imports `pdfjs-dist` or `docx-preview` at runtime.
- **Success criteria:** both fail.
- **Verify:** `bunx vitest run src/renderer/lib/pdfjs-loader.test.ts src/renderer/components/preview/docx-options.test.ts; echo "exit=$?"` prints `exit=1`.

### Task 3.3 — Green: loader, options, dependency
- **Goal:** pass the option tests and install docx-preview.
- **Target files and symbols:** `loadPdfjs`, `pdfDocumentOptions`, `DOCX_RENDER_OPTIONS`.
- **Steps:**
  1. If Task 3.1 step 1 printed `0`, create `src/renderer/vite-url.d.ts`
     containing
     `declare module "*?url" { const url: string; export default url; }`.
  2. `pdfjs-loader.ts`:
     - A module-level `let pending: Promise<typeof import("pdfjs-dist")> | null = null`.
     - `loadPdfjs()` runs
       `pending ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => { lib.GlobalWorkerOptions.workerSrc = worker.default; return lib; })`.
     - `pdfDocumentOptions(data, baseUrl = document.baseURI)` returns
       `{ data, useWasm: false, enableXfa: false, cMapPacked: true, cMapUrl: new URL("pdfjs/cmaps/", baseUrl).href, standardFontDataUrl: new URL("pdfjs/standard_fonts/", baseUrl).href }`,
       typed `DocumentInitParameters` with a type-only import.
  3. `docx-options.ts`:
     `export const DOCX_RENDER_OPTIONS: Partial<Options> = { className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false, renderChanges: false, renderAltChunks: false, useBase64URL: true, experimental: false, trimXmlDeclaration: true, debug: false };`
     with `import type { Options } from "docx-preview"`.
  4. Run `bun add docx-preview@0.4.1 --exact`.
- **Success criteria:** the tests pass; the dependency is pinned.
- **Verify:** `bunx vitest run src/renderer/lib/pdfjs-loader.test.ts src/renderer/components/preview/docx-options.test.ts; echo "exit=$?"` prints `exit=0`; `grep -c '"docx-preview": "0.4.1"' package.json` prints `1`.

### Task 3.4 — Refactor the sibling thumbnail onto the shared loader
- **Goal:** one pdf.js setup (DRY).
- **Target files and symbols:** `src/renderer/lib/pdf-thumbnail.ts`.
- **Steps:**
  1. Replace its own `import("pdfjs-dist")` and worker setup with
     `const pdfjs = await loadPdfjs();`.
  2. Replace its `getDocument({...})` argument with
     `pdfDocumentOptions(bytes)`, which removes any `isEvalSupported` key.
  3. Keep its cache and error behavior unchanged.
- **Success criteria:** the sibling tests are still green and `pdf-thumbnail.ts` no longer mentions `GlobalWorkerOptions`.
- **Verify:** `bunx vitest run src/renderer/lib/pdf-thumbnail.test.ts src/renderer/components/attachments; echo "exit=$?"` prints `exit=0`; `grep -c "GlobalWorkerOptions\|isEvalSupported" src/renderer/lib/pdf-thumbnail.ts` prints `0`.

### Task 3.5 — pdf.js static assets and chunk rules
- **Goal:** cMaps and standard fonts are served from `'self'` in dev and in the build; the libraries sit in lazy chunks.
- **Target files and symbols:** `vite.renderer.shared.ts` (`VENDOR_CHUNK_RULES`, new `pdfjsAssets()` plugin, `rendererConfig().plugins`); `scripts/check-renderer-chunks.ts` (`LAZY_CHUNKS`).
- **Steps:**
  1. Add `function pdfjsAssets(): Plugin` to `vite.renderer.shared.ts`.
     - Resolve
       `const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))`.
     - `configureServer(server)`: register a middleware for URLs starting with
       `/pdfjs/cmaps/` or `/pdfjs/standard_fonts/`. Strip any `?…`, reject
       names containing `/` or `..` after the prefix, and stream the file from
       `pdfjsRoot/<dir>/<name>` with `content-type: application/octet-stream`.
       Otherwise call `next()`.
     - `generateBundle()`: for each file in `pdfjsRoot/cmaps` and
       `pdfjsRoot/standard_fonts`, call
       `this.emitFile({ type: "asset", fileName: "pdfjs/<dir>/<name>", source: fs.readFileSync(...) })`.
     - Add `pdfjsAssets()` to `plugins: [tailwindcss(), pdfjsAssets()]`.
  2. Append these rules to `VENDOR_CHUNK_RULES`:
     - `[/[\\/]node_modules[\\/]pdfjs-dist[\\/]/, "pdfjs"]`
     - `[/[\\/]node_modules[\\/]docx-preview[\\/]/, "docx"]`
     - `[/[\\/]node_modules[\\/](jszip|pako|lie|immediate|setimmediate)[\\/]/, "jszip"]`
  3. Set `LAZY_CHUNKS` to the existing five names plus `"pdfjs", "docx", "jszip"`.
- **Success criteria:** the build passes the lean-entry check, and the assets exist in the output.
- **Verify:**
  - `bun run build; echo "exit=$?"` prints `exit=0`, and the output contains `none of mermaid, codemirror, charts, highlight, xterm, pdfjs, docx, jszip`.
  - `ls out/renderer/pdfjs/cmaps | wc -l` prints a number ≥ `100`.
  - `ls out/renderer/pdfjs/standard_fonts | wc -l` prints a number ≥ `10`.

### Task 3.6 — Shadow container hook, PdfView, DocxView, registration
- **Goal:** the two views, lazy-registered.
- **Target files and symbols:** `useShadowContainer`, `PdfView`, `DocxView`, `DOCUMENT_VIEWS.pdf`, `DOCUMENT_VIEWS.docx`, locale `preview.pdf.morePages`.
- **Steps:**
  1. `use-shadow-container.ts`:
     - `useShadowContainer(hostRef: RefObject<HTMLDivElement | null>): { body: HTMLDivElement; styles: HTMLDivElement } | null`.
     - On mount:
       `const root = host.shadowRoot ?? host.attachShadow({ mode: "open" })`.
       Empty it, append `styles` and `body` divs, and call
       `const unguard = guardLinks(root)`. Put the pair in state.
     - Cleanup: `unguard()`, then empty the root.
  2. `DocxView.tsx` (named export `DocxView(props: DocumentViewProps)`):
     - Render
       `<div ref={hostRef} className="min-h-0 flex-1 overflow-auto bg-(--omp-code-bg)" />`.
     - When the container is ready, run
       `import("docx-preview").then(({ renderAsync }) => renderAsync(bytes, body, styles, DOCX_RENDER_OPTIONS))`
       and send rejections to `props.onError`.
     - Fit: a `ResizeObserver` on the host sets
       `body.style.zoom = String(Math.min(1, host.clientWidth / page.offsetWidth))`,
       where `page = body.querySelector("section.docx")`.
     - Disconnect on unmount, and ignore late results with a cancelled flag.
  3. `PdfView.tsx`:
     - `const pdfjs = await loadPdfjs(); const task = pdfjs.getDocument(pdfDocumentOptions(bytes)); const doc = await task.promise;`.
     - Show `Math.min(doc.numPages, 300)` page placeholders. Each placeholder
       has aspect ratio from `page.getViewport({ scale: 1 })`, fetched when
       intersecting.
     - An `IntersectionObserver` (root = scroll container, `rootMargin: "600px"`)
       renders a page once into a `<canvas>` at
       `scale = (container.clientWidth / viewport.width) * devicePixelRatio`,
       with CSS `width: 100%`.
     - When `doc.numPages > 300`, show
       `t("preview.pdf.morePages", { shown: 300, total: doc.numPages })`.
     - On unmount, call `void task.destroy()`. Send errors to `onError`.
  4. Add the locale key `preview.pdf.morePages` → "Showing the first {shown} of {total} pages." / "Đang hiển thị {shown} trang đầu trong tổng số {total} trang.".
  5. `document-views.ts`: set
     `pdf: lazy(() => import("./PdfView").then(m => ({ default: m.PdfView })))`
     and the same for `docx` with `DocxView`.
- **Success criteria:** types, tests and the lean-entry build pass.
- **Verify:** `bun run check:types; echo "exit=$?"` → `exit=0`; `bunx vitest run src/renderer; echo "exit=$?"` → `exit=0`; `bun run build; echo "exit=$?"` → `exit=0` with `index.html entry is lean`.

### Task 3.7 — Lint and commit
- **Steps:**
  1. Run biome on every file listed in "Files to Create / Modify" (except
     `bun.lock`) with `; echo "exit=$?"`.
  2. Run `git commit -m "feat(preview): render PDF pages and Word documents"`.
- **Verify:** biome prints `exit=0`; `git log -1 --format=%s` matches.

## Verification

- `bunx vitest run; echo "exit=$?"` → `exit=0`.
- `bun run check:types; echo "exit=$?"` → `exit=0`.
- `bun run build; echo "exit=$?"` → `exit=0`, and the output contains `index.html entry is lean` and `quick-entry.html entry is lean`.
- `git diff HEAD~1 -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json | wc -l` → `0` (CSP untouched).

## Risks & Rollback

- **pdf.js worker or asset fetch on Electron `file://`** [UNVERIFIED].
  - pdf.js falls back to a fake worker and to system fonts.
  - Phase 6 proves a painted canvas in the packaged-style `out/` run. On
    failure, the Failure Protocol applies.
- **docx-preview inside a shadow root.** Its styles go to `styles`, inside the
  root (verified API: `renderAsync(data, bodyContainer, styleContainer, options)`
  in `docx-preview.d.ts`).
- **jszip chunk folding.** The build check catches an eager reach.
- **Rollback:** `git revert <phase-3 commit>`. `DOCUMENT_VIEWS` loses pdf and
  docx, which fall back to "Open in system app".

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

=== FILE: phase-04-slides-and-spreadsheet-views.md ===
---
phase: 4
title: "Slides and spreadsheet views"
status: pending
priority: P1
effort: "5h"
dependencies: [3]
---
# Phase 4: Slides and spreadsheet views

## Goal

Render PPTX with `@aiden0z/pptx-renderer` 1.3.0, in an open shadow root with
the link guard and these options: `fitMode: "contain"`, `RECOMMENDED_ZIP_LIMITS`,
lazy slides and media, a windowed list and `pdfjs: false`.

Render xlsx, xls, ods and csv with SheetJS CE 0.20.3, vendored, into a React
table:

- one tab per visible sheet;
- formatted values (`cell.w`);
- a formula without a cached value shown as muted `=FORMULA`;
- rows virtualized with `@tanstack/react-virtual`;
- capped at 5000 rows × 100 columns, with notes when truncated.

## Files to Create / Modify

- Create:
  - `vendor/xlsx-0.20.3.tgz`
  - `src/renderer/components/preview/sheet-model.ts`
  - `src/renderer/components/preview/sheet-model.test.ts`
  - `src/renderer/components/preview/SheetTable.tsx`
  - `src/renderer/components/preview/SheetTable.test.tsx`
  - `src/renderer/components/preview/SheetView.tsx`
  - `src/renderer/components/preview/pptx-options.ts`
  - `src/renderer/components/preview/pptx-options.test.ts`
  - `src/renderer/components/preview/PptxView.tsx`
- Modify:
  - `package.json`, `bun.lock` (`xlsx` from the tarball;
    `@aiden0z/pptx-renderer` `1.3.0` exact)
  - `vite.renderer.shared.ts`
  - `scripts/check-renderer-chunks.ts`
  - `src/renderer/components/preview/document-views.ts`
  - `src/renderer/locales/en.ts`, `vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| An exceljs workbook (header `Region`,`Sales`; three rows; `B5` `{ formula: "SUM(B2:B4)" }` with no result; `B2` numFmt `#,##0.00` value 1234.5) → the first sheet's rows match, `B2` text is `1,234.50`, and `B5` is `{ text: "=SUM(B2:B4)", formula: true }` | `sheet-model.test.ts` (real SheetJS `read(bytes, { type: "array", cellDates: true, cellNF: true, dense: true })`) | import fails → passes |
| A hidden second sheet is excluded | same | ″ |
| 6000 rows → `rows.length === 5000`, `totalRows === 6000`; 150 columns → `rows[0].length === 100`, `totalColumns === 150` | same | ″ |
| The CSV text `a,b\n1,2\n` read with `{ type: "string" }` → `[["a","b"],["1","2"]]` | same | ″ |
| An empty sheet → `rows: []` | same | ″ |
| `SheetTable` renders one `role="tab"` per sheet, switches on click, and shows the more-rows note when `totalRows > rows.length` | `SheetTable.test.tsx` (linkedom) | import fails → passes |
| `pptxOpenOptions(scroll, limits)` → `fitMode "contain"`, `pdfjs === false`, `lazySlides === true`, `lazyMedia === true`, `renderMode "list"`, `listOptions.windowed === true`, `zipLimits === limits`, `scrollContainer === scroll` | `pptx-options.test.ts` | import fails → passes |
| The build keeps `pptx` and `sheets` lazy | `bun run build` | — |

## Tasks

### Task 4.1 — Vendor SheetJS and add the pptx renderer
- **Goal:** pinned dependencies, no npm `xlsx` 0.18.5.
- **Steps:**
  1. `mkdir -p vendor && curl -fsSLo vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
  2. `bun add ./vendor/xlsx-0.20.3.tgz`.
  3. `bun add @aiden0z/pptx-renderer@1.3.0 --exact`.
- **Success criteria:** the installed versions match.
- **Verify:**
  - `grep '"version"' node_modules/xlsx/package.json` prints `  "version": "0.20.3",`.
  - `grep -c '"@aiden0z/pptx-renderer": "1.3.0"' package.json` prints `1`.
  - `grep -c 'vendor/xlsx-0.20.3.tgz' package.json` prints `1`.

### Task 4.2 — Red: model, table and option tests
- **Goal:** failing tests first.
- **Target files and symbols:** `workbookToSheets`, `PreviewSheet`; `SheetTable`; `pptxOpenOptions`.
- **Steps:**
  1. `sheet-model.test.ts`: build workbooks with
     `new ExcelJS.Workbook()` (devDependency `exceljs`). Write them with
     `await wb.xlsx.writeBuffer()`, then pass
     `read(new Uint8Array(buffer), {...})` into
     `workbookToSheets(wb, { maxRows: 5000, maxColumns: 100 })`.
  2. `SheetTable.test.tsx`: use the linkedom harness. Pass
     `sheets: PreviewSheet[]` built by hand (two sheets, `totalRows: 9000`).
  3. `pptx-options.test.ts`: pass `document.createElement("div")` and a plain
     limits object. Import only `./pptx-options`, whose library imports are
     type-only.
- **Success criteria:** they fail.
- **Verify:** `bunx vitest run src/renderer/components/preview/sheet-model.test.ts src/renderer/components/preview/SheetTable.test.tsx src/renderer/components/preview/pptx-options.test.ts; echo "exit=$?"` prints `exit=1`.

### Task 4.3 — Green: model, table, options
- **Goal:** pass the tests.
- **Target files and symbols:** `sheet-model.ts`, `SheetTable.tsx`, `pptx-options.ts`.
- **Steps:**
  1. `sheet-model.ts`:
     - Types:
       `export interface PreviewCell { text: string; formula: boolean }`
       and
       `export interface PreviewSheet { name: string; rows: PreviewCell[][]; totalRows: number; totalColumns: number }`.
     - `workbookToSheets(wb: WorkBook, limits)`:
       - Skip any sheet whose `wb.Workbook?.Sheets?.[i]?.Hidden` is truthy.
       - Get the range with `utils.decode_range(sheet["!ref"])`; a sheet
         without `!ref` gets `rows: []`.
       - Read cells from the dense `sheet["!data"][r]?.[c]`.
       - Text is `cell.w ?? (cell.v !== undefined ? String(cell.v) : cell.f ? "=" + cell.f : "")`.
       - `formula` is `cell.v === undefined && Boolean(cell.f)`.
     - Also export
       `parseSheets(bytes: Uint8Array, documentKind: DocumentKind): PreviewSheet[]`.
       For `csv` it decodes UTF-8 text and calls `read(text, { type: "string", dense: true })`;
       for the others it calls `read(bytes, { type: "array", cellDates: true, cellNF: true, dense: true })`.
  2. `SheetTable.tsx`:
     - A `role="tablist"` row of buttons (`role="tab"`, `aria-selected`).
     - A scroll container with a `<table>`: a sticky header of column letters
       (`utils.encode_col(c)` is not imported here; compute the letters with a
       local 6-line helper), and a row number column.
     - Rows go through
       `useVirtualizer({ count: rows.length, getScrollElement, estimateSize: () => 24, overscan: 20 })`,
       following `ChatStream.tsx`.
     - A formula cell gets `className="text-(--omp-dim)"`.
     - Notes: `preview.sheet.moreRows` and `preview.sheet.moreColumns`.
       `preview.sheet.empty` shows when there are no rows.
  3. `pptx-options.ts`:
     `export function pptxOpenOptions(scrollContainer: HTMLElement, zipLimits: ZipParseLimits) { return { fitMode: "contain" as const, zipLimits, lazySlides: true, lazyMedia: true, pdfjs: false as const, scrollContainer, renderMode: "list" as const, listOptions: { windowed: true, showSlideLabels: true } }; }`,
     with `import type { ZipParseLimits } from "@aiden0z/pptx-renderer"`.
  4. Add these locale keys:
     - `preview.sheet.tabs` → "Sheets" / "Trang tính"
     - `preview.sheet.moreRows` → "Showing the first {shown} of {total} rows." / "Đang hiển thị {shown} hàng đầu trong tổng số {total} hàng."
     - `preview.sheet.moreColumns` → "Showing the first {shown} of {total} columns." / "Đang hiển thị {shown} cột đầu trong tổng số {total} cột."
     - `preview.sheet.empty` → "This sheet is empty." / "Trang tính này trống."
- **Success criteria:** the tests pass.
- **Verify:** `bunx vitest run src/renderer/components/preview src/renderer/locales; echo "exit=$?"` prints `exit=0`.

### Task 4.4 — Views, registration, chunk rules
- **Goal:** lazy `SheetView` and `PptxView`.
- **Target files and symbols:** `SheetView`, `PptxView`, `DOCUMENT_VIEWS.sheet`, `DOCUMENT_VIEWS.pptx`, `VENDOR_CHUNK_RULES`, `LAZY_CHUNKS`.
- **Steps:**
  1. `SheetView.tsx` (named export):
     `const sheets = useMemo(() => { try { return parseSheets(bytes, documentKind); } catch (e) { onError(e); return null; } }, [bytes, documentKind])`,
     then render `<SheetTable sheets={sheets} />` when it is not null.
  2. `PptxView.tsx` (named export):
     - Use `useShadowContainer(hostRef)`. When ready, create an
       `AbortController` and run
       `import("@aiden0z/pptx-renderer").then(({ PptxViewer, RECOMMENDED_ZIP_LIMITS }) => PptxViewer.open(bytes, body, { ...pptxOpenOptions(host, RECOMMENDED_ZIP_LIMITS), signal: controller.signal }))`.
     - Keep the viewer. On unmount, call `controller.abort()` and
       `viewer?.destroy()`. Send rejections to `onError`, except `AbortError`.
  3. `document-views.ts`: add `sheet` and `pptx` entries with the same
     `lazy(... .then(m => ({ default: m.X })))` pattern as phase 3.
  4. Append to `VENDOR_CHUNK_RULES`:
     `[/[\\/]node_modules[\\/]xlsx[\\/]/, "sheets"]` and
     `[/[\\/]node_modules[\\/](@aiden0z|echarts|zrender|mtx-decompressor)[\\/]/, "pptx"]`.
     Append `"sheets", "pptx"` to `LAZY_CHUNKS`.
- **Success criteria:** types and tests pass, and the build keeps the entry lean.
- **Verify:**
  - `bun run check:types; echo "exit=$?"` → `exit=0`.
  - `bunx vitest run src/renderer; echo "exit=$?"` → `exit=0`.
  - `bun run build; echo "exit=$?"` → `exit=0`, and the output contains `pdfjs, docx, jszip, sheets, pptx`.

### Task 4.5 — Lint and commit
- **Steps:**
  1. Run biome on the created and modified TS files with `; echo "exit=$?"`.
  2. Run `git add vendor/xlsx-0.20.3.tgz` plus the phase files, then
     `git commit -m "feat(preview): render slide decks and spreadsheets"`.
- **Verify:** biome prints `exit=0`; `git log -1 --format=%s` matches.

## Verification

- `bunx vitest run; echo "exit=$?"` → `exit=0`.
- `bun run check:types; echo "exit=$?"` → `exit=0`.
- `bun run build; echo "exit=$?"` → `exit=0` with both entries lean.

## Risks & Rollback

- **tslib or another helper folds into the `pptx` chunk and becomes eager.**
  The build check fails, and the Failure Protocol applies.
- **The CDN tarball becomes unavailable during implementation.** Task 4.1's
  Verify fails, and the Failure Protocol applies (Q2 alternative: exceljs).
- **SheetJS `read` of a hostile file.** Version 0.20.3 contains the
  CVE-2023-30533 fix (0.19.3+), and the ZIP budget runs first (phase 2).
- **Rollback:** `git revert <phase-4 commit>`. pptx and sheet fall back to
  "Open in system app".

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

=== FILE: phase-05-entry-points-on-cards.md ===
---
phase: 5
title: "Entry points on cards"
status: pending
priority: P2
effort: "2h"
dependencies: [2]
---
# Phase 5: Entry points on cards

## Goal

Open the preview from the cards that name output and input files:

- The office card (`OfficeFileRenderer.tsx`) gets a **Preview** button before
  **Open**.
- The Write card (`WriteRenderer.tsx:88`) gets a Preview icon button after its
  `PathLink`, when `previewKindOf(openPath) !== "other"`.
- The sibling's `AttachmentCard` opens the preview when the card has a `path`
  and its kind is not `other`. This covers composer cards (paperclip and drop)
  and the sent-bubble cards.

Every entry point calls `useUiStore.getState().openFilePreview(path)`.

## Files to Create / Modify

- Modify:
  - `src/renderer/components/tools/OfficeFileRenderer.tsx`
  - `src/renderer/components/tools/OfficeFileRenderer.test.tsx`
  - `src/renderer/components/tools/WriteRenderer.tsx`
  - `src/renderer/components/tools/WriteRenderer.test.tsx`
  - `src/renderer/components/attachments/AttachmentCard.tsx`
  - `src/renderer/components/attachments/AttachmentCard.test.tsx`
  - `src/renderer/locales/en.ts`, `vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red → Green |
|---|---|---|
| "previews the finished file beside the conversation": clicking the button named `Preview` sets `filePreviewPath` to the result's file, `panelTab` to `files` and `panelVisible` to true; `system.openPath` is not called | `OfficeFileRenderer.test.tsx` | no button → passes |
| "previews a written document from its card": for `path: "/w/notes.md"`, the button labelled `Preview notes.md` sets `filePreviewPath` to the `resolvedPath` or `path` the card opens | `WriteRenderer.test.tsx` | ″ |
| "offers no preview for a file type it cannot show": `path: "/w/build.sh"` → no `Preview build.sh` button | `WriteRenderer.test.tsx` | — → passes |
| "opens the preview from a card with a path": a `report.docx` card with `path` → the button labelled `Preview report.docx` sets `filePreviewPath` | `AttachmentCard.test.tsx` | ″ |
| "keeps a pasted image card without a path inert": no `Preview …` button | `AttachmentCard.test.tsx` | ″ |

In `afterEach`, reset the ui store with
`useUiStore.setState({ filePreviewPath: null, panelVisible: false, panelTab: "files" })`.

## Tasks

### Task 5.1 — Red: card tests
- **Goal:** failing tests for the three entry points.
- **Steps:**
  1. Add the five cases above to the three test files. Follow each file's
     existing mount helper and `window.omp` stub. In `OfficeFileRenderer.test.tsx`,
     reuse the result fixture of the test at line 67.
  2. Run the tests.
- **Success criteria:** the new cases fail. The "offers no preview" and "keeps … inert" cases may already pass.
- **Verify:** `bunx vitest run src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/WriteRenderer.test.tsx src/renderer/components/attachments/AttachmentCard.test.tsx; echo "exit=$?"` prints `exit=1`.

### Task 5.2 — Green: buttons and locale keys
- **Goal:** pass the tests.
- **Target files and symbols:** `OfficeFileRenderer` (button row at lines 93-101), `WriteRenderer` (after the `PathLink` at line 88), `AttachmentCard` (preview area).
- **Steps:**
  1. Add these locale keys:
     - `tools.office.preview` → "Preview" / "Xem trước"
     - `tools.write.preview` → "Preview {name}" / "Xem trước {name}"
     - `input.attachment.open` → "Preview {name}" / "Xem trước {name}"
  2. `OfficeFileRenderer.tsx`: before the Open button, add
     `<button type="button" className={buttonClass} onClick={() => useUiStore.getState().openFilePreview(office.file)}><Eye size={14} aria-hidden />{t("tools.office.preview")}</button>`.
     Import `Eye` from `lucide-react` and `useUiStore` from `../../stores/ui`.
  3. `WriteRenderer.tsx`: after the `PathLink`, when
     `previewKindOf(openPath) !== "other"`, render an `IconButton`
     (`../common`) with `icon={<Eye size={12} />}`,
     `label={t("tools.write.preview", { name: basename(path) })}` and
     `size="sm"`. Its `onClick` calls `event.stopPropagation()` and then
     `useUiStore.getState().openFilePreview(openPath)`.
  4. `AttachmentCard.tsx`: when `path` is set and
     `previewKindOf(path) !== "other"`, wrap the preview area in
     `<button type="button" aria-label={t("input.attachment.open", { name })} onClick={() => useUiStore.getState().openFilePreview(path)} className="block w-full text-left">`.
     Keep the remove button outside that wrapper, so removing never opens.
- **Success criteria:** the tests pass.
- **Verify:** the Task 5.1 command prints `exit=0`; `bunx vitest run src/renderer/locales; echo "exit=$?"` prints `exit=0`; `bun run check:types; echo "exit=$?"` prints `exit=0`.

### Task 5.3 — Lint and commit
- **Steps:**
  1. Run biome on the six modified TS/TSX files plus both locale files with
     `; echo "exit=$?"`.
  2. Run `git commit -m "feat(preview): open previews from office, write and attachment cards"`.
- **Verify:** biome prints `exit=0`; `git log -1 --format=%s` matches.

## Verification

- `bunx vitest run; echo "exit=$?"` → `exit=0`.
- `bun run check:types; echo "exit=$?"` → `exit=0`.

## Risks & Rollback

- **A click on the Write card's disclosure row toggles it.** Mitigation:
  `stopPropagation`, matching `PathLink.tsx`.
- **The attachment-card props differ from the sibling contract**
  (`path?: string`). Task 5.1 fails, and the Failure Protocol applies.
- **Rollback:** `git revert <phase-5 commit>`.

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

=== FILE: phase-06-end-to-end-in-both-shells.md ===
---
phase: 6
title: "End-to-end in both shells"
status: pending
priority: P1
effort: "4h"
dependencies: [1, 2, 3, 4, 5]
---
# Phase 6: End-to-end in both shells

## Goal

Prove in the real shells (Electron on `file://` from `out/`, and the Tauri
`e2e-hooks` debug build on WebKitGTK) that each supported format renders beside
the conversation:

- with the real CSP;
- with no CSP violation and no page error;
- with the composer still visible to the left of the drawer.

Also prove that Reload shows a rewritten file. Both specs share one fixture
writer that produces real files from the assistant-pack office builders, and
they are twins under `e2e-tauri/check-twins.ts`.

## Files to Create / Modify

- Create:
  - `e2e/preview-fixtures.ts`
  - `e2e/document-preview.e2e.ts`
  - `e2e-tauri/document-preview.e2e.ts`

## Test Matrix (TDD)

Both specs contain exactly these two test titles, and the Tauri twin has at
least as many `expect(` calls per test as the Electron spec.

| Test title | Assertions |
|---|---|
| "previews office files, a PDF, a spreadsheet and an image beside the conversation" | For each of `report.docx`, `deck.pptx`, `table.xlsx`, `table.csv`, `sample.pdf`, `notes.md` and `pixel.png`:<br>- `[data-preview-state="ready"]` appears with the right `data-preview-kind`.<br>- **docx:** the shadow root of the host inside it has a `section.docx` whose text contains `Quarterly sales review`.<br>- **pptx:** the shadow root's `textContent` contains `Quarterly sales review`.<br>- **xlsx:** a table cell has the text `Region`.<br>- **csv:** a cell has the text `alpha`.<br>- **pdf:** there is a `canvas` with `width > 0`, and some pixel in its `getImageData` is not white.<br>- **md:** the `h1` text is `Preview notes`.<br>- **png:** an `img` whose `naturalWidth` is 1.<br><br>After the loop:<br>- the composer `textarea` is visible;<br>- `textarea.getBoundingClientRect().right <= aside.getBoundingClientRect().left + 1`;<br>- `window.__previewCspViolations` equals `[]`;<br>- the page errors equal `[]`. |
| "reloads a rewritten report in place" | Open `report.docx`, overwrite it with the Vietnamese report (`notes-vi.md`), and click `Reload preview`. The shadow text contains `Biên bản họp phòng kinh doanh`. |

Red state: before this phase the specs do not exist. Green state: both specs
exit 0, and `bun e2e-tauri/check-twins.ts` exits 0.

## Tasks

### Task 6.1 — Fixture writer
- **Goal:** real files, generated at test time from the code that makes the user's files.
- **Target files and symbols:** `e2e/preview-fixtures.ts` (`writePreviewFixtures(dir: string): Promise<void>`, `writeVietnameseReport(dir: string): Promise<void>`).
- **Steps:**
  1. **docx:**
     `buildReport({ markdown: readFileSync("assistant-pack/test/fixtures/notes-en.md", "utf8"), fallbackTitle: "Report", lang: "en" })`
     (`assistant-pack/src/office/report.ts:229`) → `report.docx`.
  2. **pptx:** `buildSlides({...same})`
     (`assistant-pack/src/office/slides.ts:526`) → `deck.pptx`.
  3. **xlsx:** an exceljs workbook with sheet `Sales`, rows
     `[["Region","Sales"],["North",10],["South",20]]` → `table.xlsx`.
  4. **csv:** `"name,value\nalpha,1\nbeta,2\n"` → `table.csv`.
  5. **md:** `"# Preview notes\n\nBody."` → `notes.md`.
  6. **png:** a 1×1 PNG from the base64
     `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`
     → `pixel.png`.
  7. **pdf:** build `sample.pdf` as a string with correct xref offsets:
     - objects 1 Catalog, 2 Pages, 3 Page (MediaBox 0 0 200 100, Font F1
       Helvetica), 4 content stream `BT /F1 24 Tf 20 40 Td (Hello) Tj ET`;
     - compute each object's byte offset while concatenating;
     - write `xref`, `trailer << /Size 5 /Root 1 0 R >>`, `startxref` and
       `%%EOF`.
  8. `writeVietnameseReport(dir)` writes the `notes-vi.md` report over
     `report.docx`.
- **Success criteria:** the types compile.
- **Verify:** `bun run check:types; echo "exit=$?"` prints `exit=0`.

### Task 6.2 — Electron spec
- **Goal:** the Playwright original.
- **Target files and symbols:** `e2e/document-preview.e2e.ts`.
- **Steps:**
  1. Copy the profile, env and launch block of `e2e/auto-follow.e2e.ts:13-40`
     without `OMP_GUI_TEST_HISTORY`. Call
     `await writePreviewFixtures(project)` before `electron.launch`.
  2. After `textarea` is visible:
     - Add a `securitypolicyviolation` listener with `page.evaluate` that
       pushes into `window.__previewCspViolations`.
     - Click the button titled `Open workspace` (`titlebar.workspace`).
     - For each file, click the `role="treeitem"` with that name, wait for
       `[data-preview-state="ready"]`, run the matrix assertions (use
       `page.evaluate` for the shadow-root queries), then click
       `Back to files`.
  3. Test 2: open `report.docx`, call `writeVietnameseReport(project)`, click
     `Reload preview`, and assert on the shadow text with `expect.poll`.
  4. Quit as in `e2e/onboarding.e2e.ts:98-102`.
- **Success criteria:** the spec passes against the built app.
- **Verify:** `bun run build && scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts; echo "exit=$?"` prints `exit=0`.

### Task 6.3 — Tauri twin
- **Goal:** the same tests on WebKitGTK with the Tauri CSP.
- **Target files and symbols:** `e2e-tauri/document-preview.e2e.ts`.
- **Steps:**
  1. Write the same two `it(...)` titles inside
     `describe("document preview", …)`.
  2. Start each test with
     `await launch({ name: "document-preview", setup: async l => writePreviewFixtures(l.project) })`
     (`e2e-tauri/session.ts:178`), then `await awaitBridge(browser)` and
     `await collectPageErrors(browser)`.
  3. Drive the same clicks with `$()`. Run the shadow-root checks with
     `browser.execute`, as `e2e-tauri/csp.e2e.ts` does. Assert with `expect`
     at least as many times as the Electron spec, and assert `pageErrors`
     equals `[]`.
  4. Build the test binary:
     `PATH="$HOME/.cargo/bin:$PATH" cargo tauri build --debug --features e2e-hooks --no-bundle`
     (`BUILD_COMMAND`, `e2e-tauri/session.ts:28`).
- **Success criteria:** the twin passes and the twin check passes.
- **Verify:**
  - `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` prints `exit=0`.
  - `bun e2e-tauri/check-twins.ts; echo "exit=$?"` prints `exit=0`.

### Task 6.4 — Full gate, cleanup and commit
- **Goal:** every plan-level gate is green, and no process is left running.
- **Steps:**
  1. Run each command in plan.md › Validation commands, appending
     `; echo "exit=$?"` to each.
  2. Run `scripts/virtual-display.sh stop`.
  3. Run `bunx biome check e2e/preview-fixtures.ts e2e/document-preview.e2e.ts e2e-tauri/document-preview.e2e.ts`.
  4. Run `git commit -m "test(preview): render every preview format in both shells"`.
- **Success criteria:** every command prints `exit=0`, and `scripts/virtual-display.sh status` lists nothing still running for this task.
- **Verify:** each command prints `exit=0`; `git log -1 --format=%s` matches.

## Verification

- `bun e2e-tauri/check-twins.ts; echo "exit=$?"` → `exit=0`.
- Both spec commands above → `exit=0`.
- `bunx vitest run; echo "exit=$?"` → `exit=0`.

## Risks & Rollback

- **The Electron `file://` worker or cMap fetch fails** [UNVERIFIED]. The PDF
  pixel assertion fails, and the Failure Protocol applies. The candidate fixes
  for kongming to weigh are a custom `app://` protocol or pdf.js's
  main-thread worker; both are out of scope without counsel.
- **The aiden0z DOM differs from the expected text** [UNVERIFIED]. The
  assertion uses the shadow root's `textContent` only, not the library's
  class names.
- **The wdio `--spec` passthrough** [UNVERIFIED]. If `bun run test:e2e:tauri -- --spec`
  is rejected, run
  `scripts/virtual-display.sh run -- bunx wdio run wdio.conf.ts --spec e2e-tauri/document-preview.e2e.ts`.
  This is the same runner, so it is not a workaround.
- **Rollback:** `git revert <phase-6 commit>`. Only tests are removed.

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
