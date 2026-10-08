---
title: "Side-by-side document preview"
description: "Open a read-only preview of docx, pptx, xlsx/xls/ods, csv, pdf, images and text next to the chat, from the office card, the Write card, markdown links, the Files panel and attachment cards."
status: completed
priority: P2
effort: 35h
branch: main
tags: [frontend, renderer, tauri, electron, ipc, preview, tdd]
blockedBy: [261007-1931-drop-file-attachment-cards]
blocks: []
created: 2026-10-07
---

# Side-by-side document preview

## Outcome

Inside the Sai ATLAS window the user opens a read-only preview of a file in the
right-hand workspace drawer while the conversation stays visible beside it. The
drawer docks beside the chat in every layout, including a split workspace and
windows of 1000 px or less, where it used to float over the chat.

The preview opens from five places:

- **Office output card** (`office_report`, `office_slides`, `office_clean`): a new **Preview** button.
- **Write tool card**: a new preview icon next to the path.
- **Model markdown links to local files**: already routed to the drawer. Office, PDF and image files now render instead of showing "binary".
- **Files panel tree**: already routed to the drawer, now with rich formats.
- **Attachment cards** in the composer and in the sent user bubble (from the attachment-cards plan): clicking a card opens it. Images without a file on disk (pasted or sent images) open from their in-memory data. <!-- Validation: path-less images -->

It renders these formats:

| Format | How it renders |
|---|---|
| .docx | Laid out as pages |
| .pptx | Slides |
| .xlsx, .xls, .ods, .csv | A sheet table with sheet tabs |
| .pdf | Page canvases, drawn as they scroll into view |
| png/jpg/jpeg/webp/gif/svg/bmp/avif | An image |
| md | Markdown, as today |
| Other text | Plain text, as today |

Any other file shows that it cannot be previewed and points to the header's
existing **Open externally** control. A preview refreshes by itself when a
`write` or office tool call that wrote the file finishes, and a **Reload**
button re-reads it on demand. Nothing polls.
<!-- Validation: refresh --> <!-- Red team: R14 -->

## Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Surface | Reuse the inspector drawer's Files preview mode. While a target is previewed (`panelTab === "files"` and `filePreview !== null`) the drawer **docks** as a flex sibling of `<main>`, even when the workspace is split or the window is ≤1000 px. The preview width is derived, `max(width, 40 % of the window)`, and never written to the persisted `gui.panelWidth`. <!-- Shipped: the derived width is capped by the drawer's `MAX_WIDTH` (840 px, `PanelContainer.tsx`), so `≥ 0.4 × innerWidth` holds at 1440×900 as tested, not on very wide windows --> At ≤1000 px it docks at `50vw` and hides the left sidebar, which is restored on close when the preview hid it. A focus change between the two panes of a split keeps the preview open and pinned to the tab that opened it. <!-- Red team: R8, R12, K3 --> <!-- Validation: narrow window --> | The drawer is already the one right-hand surface, and `openFilePreview` already routes markdown links and the tree into it. The overlay rules (`PanelContainer.tsx:127`, `global.css:705-713`) are the only reason it is not side by side today. `switchTab` clears overlays, the preview included, on every pane click today (`tabs.ts:446-456`, `ui.ts:277`). |
| D2 | Byte transport | One new channel, `fs:read-document` `{path, tabId?, ifChanged?}`. Absolute and `~/` paths are read as given and relative paths stay workspace-confined, as `fs:read-image` does (`src-tauri/src/services/ipc.rs:483`). The read opens once and reads at most 32 MiB + 1 byte, so a file growing after `fstat` is refused. Bytes come back only for a `%PDF-`, ZIP, OLE or HTML-table signature. A matching `ifChanged` stamp returns `unchanged` without bytes. <!-- Shipped: the path is normalized inside `readDocumentFile` / `read_document_file` (`path.normalize` / `workspace_fs::normalize`); reads are chunked (first chunk `fstat` size + 1, then 64 KiB) and bound at cap + 1; Electron also times out after 30 s with `timed-out`, as Tauri's `settle_document_read` does --> The Tauri handler returns `Reply::Later` and reads on a blocking thread with a 30 s timeout. **Images keep `fs:read-image`**; text, markdown and csv keep `fs:read`. There is no stat-only mode. <!-- Red team: R4, K6, K7, K11 --> <!-- Validation: refresh --> | This follows the trust contract in `src-tauri/src/services/fs.rs:7-12`. The Tauri bridge runs `Reply::Ready` handlers inline in the window's ordered queue (`src-tauri/src/bridge.rs:5-9`), so a slow read would stall prompt and abort calls; the sibling's `fs_read_pdf` already uses `Reply::Later` + `spawn_blocking` and a bounded read. |
| D3 | Relation to sibling `fs:read-pdf` | `fs:read-pdf` stays as the sibling built it (absolute only, used by the card thumbnails). The preview reads PDFs through `fs:read-document`, because Files-panel paths are workspace-relative. Both plans share one pdf.js opener, `src/renderer/lib/pdfjs.ts`, extracted in Phase 3 from the sibling's `pdf-thumbnail.ts`: **one worker per open document**, a 20 s load timeout and a cancel handle returned before the load resolves. <!-- Shipped: `PDFWorker.create({ port })` (the 6.4.299 typings forbid `port` in the constructor; `create` on a fresh port builds a private worker). `destroy()` waits at most 1 s for pdf.js teardown, then terminates the port, and never rejects; the thumbnail does not await it. --> The thumbnail keeps its own 20 s draw bound. <!-- Red team: R1 --> | With the global worker port, every document shares one cached `PDFWorker`, and one `loadingTask.destroy()` tears it down for all (`pdf.mjs`, `PDFWorker.create` and `PDFDocumentLoadingTask.destroy`). An explicit per-document port is never terminated by pdf.js, so each document owns and ends its own. |
| D4 | Isolation | docx-preview and the pptx renderer render into an **open shadow root** whose host sits in a containment frame (`relative`, `overflow: clip`, `isolation: isolate`, `contain: strict`, `transform`), and the docked aside keeps its own stacking context. One capturing click router sends `http`, `https` and `mailto` links (HTML and SVG anchors, `href` or `xlink:href`) to `system.openExternal` and swallows every other link; pptx shape hyperlinks go through the viewer's `onNavigate` to the same check. <!-- Shipped: 1.3.0's `ViewerOptions` has no `onNavigate`. `pptxViewerOptions(zipLimits)` returns `{ zipLimits, lazySlides: true, lazyMedia: true, pdfjs: false }`, and `installPptxNavigation(viewer, open)` replaces the viewer instance's `handleNavigate` before `viewer.open(bytes, { renderMode: "list", listOptions: { windowed: true }, signal })`. `openDocumentLink(href)` is exported from `shadow-mount.ts`. A bump-guard test in `office-render-options.test.ts` asserts version 1.3.0, a prototype `handleNavigate` and that the bundle's only `window.open(` is inside it. In-document `#id` anchors scroll inside the shadow root; every other non-web link is swallowed. --> `system:open-external` accepts `mailto:` in both shells; <!-- Shipped: it sanitizes `mailto:` to the address plus `subject`, `body`, `cc` and `bcc` only (TS `sanitizeExternalUrl`, Rust `sanitize_external_url`) and refuses an address holding an encoded `?` --> the agent's `gui_open_url` tool stays http/https only. docx-preview runs with `renderAltChunks: false` and `useBase64URL: true`; the pptx renderer with `RECOMMENDED_ZIP_LIMITS` and `pdfjs: false`. PDFs render to canvas only. Sheets render as React text. Images render through `<img>`. Markdown keeps `MarkdownRenderer`. **The CSP is unchanged.** <!-- Red team: R6, R15 --> <!-- Validation: mailto --> | docx-preview concatenates font names into its stylesheet unescaped, so a document can write `:host` rules; the frame keeps them inside the drawer. A sandboxed iframe adds no script protection beyond `script-src 'self'`. |
| D5 | Zip bombs | Before any ZIP-based renderer runs, `inspectZip(bytes)` refuses more than 5000 entries, ZIP64, a broken directory, more than 64 MiB declared, and any entry whose **real** inflated size (counted through `DecompressionStream("deflate-raw")`, stopped one byte past the declared size) exceeds its declared size or the 64 MiB total. <!-- Shipped: also requires the central directory to end exactly at the end record with exactly `count` records (JSZip scans records and shifts offsets; SheetJS trusts `count`), and refuses duplicate names, a truncated last end-record signature, local-vs-central size mismatches (except bit 3 with zero local sizes) and ZIP64 extra fields whose sizes differ from the declared ones --> <!-- Red team: R3 --> | The declared sizes are written by the attacker, and JSZip compares real and declared length only after inflating the whole entry. Once every entry's real size equals its declared size, JSZip's own inflate is bounded by the same budget. |
| D6 | Libraries | PDF uses `pdfjs-dist` 6.4.x (the **modern** build, already a dependency from the sibling) with `useWasm: false`, self-hosted `cmaps/` and `standard_fonts/`, and the module worker from `new URL`. DOCX uses `docx-preview` 0.4.1, pinned. PPTX uses `@aiden0z/pptx-renderer` 1.3.0, pinned. XLSX, XLS, ODS and CSV use SheetJS CE 0.20.3, vendored as `vendor/xlsx-0.20.3.tgz` and verified against SHA-256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`. There is **no** mammoth and **no** JSZip pptx-fallback extractor. <!-- Validation: spreadsheets --> <!-- Validation: pdf.js build --> <!-- Red team: K5 --> | SAI OS ships WebKitGTK 2.48 or newer (user). The packaged Ubuntu 24.04 smoke test probes the APIs the modern build calls without polyfills (Phase 6). exceljs cannot read .xls or .ods, and the npm `xlsx` package is the vulnerable 0.18.5. |
| D7 | Entry points | Office card **Preview** button. Write card preview icon (only when the write is neither partial nor an error). Markdown links (existing route, now passing the tab). Files panel (existing route, now passing the tab). `AttachmentCard` gains `onOpen`, wired at all five call sites except the image still being read; path-less images open through `openImagePreview`. <!-- Shipped: `OmpApi.system.openPath(path, { tabId? })`: Open externally from a pinned preview resolves in that tab (`src/main/open-path-resolve.ts`, Rust `services::system::resolve_open_path`), and an unknown tab is refused rather than borrowing another's workspace. Insert mention from the preview goes to the pinned tab. --> <!-- Validation: path-less images --> | These cover every input and output surface named in the request. |
| D8 | Limits | Read cap 32 MiB. docx and sheets above 10 MiB show "too large" (they parse on the main thread). PDF: the first 50 pages, drawn only near the viewport, each canvas capped at 16 777 216 pixels, off-screen canvases freed, pages with an aspect ratio above 20 skipped with a note, plus a "pages not shown" note. Sheets: SheetJS reads at most 501 rows per sheet (`sheetRows`), then 500 rows × 50 columns are shown, hidden sheets skipped, formulas without a saved value shown as `=…`, plus "showing first N" and "file truncated" notes. Text: 200 KB, and CSV 2 MB, the existing `fs:read` behaviour. Legacy .doc and .ppt, audio, video, archives and unknown binaries show "not available". A corrupt file, or one whose bytes do not match its extension, shows "could not be shown". <!-- Red team: R5, R7, R10, R14 --> | Each cap bounds memory or main-thread time, and each failure leaves the header's **Open externally** as a working way out. |
| D9 | Staleness | Event-driven. When a `write` or office tool call that wrote the previewed file finishes (`tool_execution_end`, not an error), the preview re-reads with its `ifChanged` stamp and re-renders **in place**, keyed on the target, never on a version, so scroll, sheet and page survive. Unchanged content changes nothing. A **Reload** button re-reads in full. No timer, no polling. <!-- Validation: refresh --> <!-- Red team: K12 --> | User decision. A stat per 2 s queued behind other calls on slow mounts; edits made outside the assistant's tools are covered by Reload. |
| D10 | Sibling plan | This plan is `blockedBy` `261007-1931-drop-file-attachment-cards` and starts only when that plan's changes are committed. Phase 1 checks this mechanically and records the channel count it finds; the plan never states the number. Phase 5 Task 5.3, the attachment-card entry, needs the sibling's cards. <!-- Red team: K1 --> | Both plans edit `ipc-types.ts`, the bridge, `ipc.rs`, `mod.rs`, `channels.rs`, the snapshots, the locales and `package.json`. The sibling's code was still changing on 2026-10-07 (its `fs_read_pdf` gained `Reply::Later` during this review), so line numbers here are approximate and tasks name symbols first. |

## Constraints

- Rendering happens in the renderer with JS only. Nothing runs LibreOffice or any converter at run time.
- Every new IPC change lands in both shells:
  - the type in `src/shared/ipc-types.ts`;
  - the bridge in `src/shared/bridge/create-omp-api.ts`;
  - the Electron handler in `src/main/ipc.ts`;
  - the Rust handler in `src-tauri/src/services/ipc.rs`, registered twice in `src-tauri/src/services/mod.rs`;
  - Rust twins of every TS test (`src-tauri/contracts/services.parity.json`);
  - **both** API snapshots, `src-tauri/contracts/services.api.txt` and `src-tauri/contracts/ports.api.txt`, and the channel count (`src-tauri/tests/channels.rs`). <!-- Red team: R2 -->
- The CSP stays byte-identical in `src/renderer/index.html`, `src/renderer/quick-entry.html` and `src-tauri/tauri.conf.json`. No `'wasm-unsafe-eval'` and no remote hosts.
- New renderer libraries load through dynamic `import()` only. Each gets a `VENDOR_CHUNK_RULES` entry (`vite.renderer.shared.ts:20`) and a `LAZY_CHUNKS` entry (`scripts/check-renderer-chunks.ts`).
- Every user-visible string goes through `useT()`, with keys in both `en.ts` and `vi.ts`. No second key for an action or label that already has one. <!-- Red team: R14 -->
- Tests use the linkedom harness. Stores are reset with `setState`/`reset()` and never `mock.module()`. There is no `any` and no inline imports.
- Commits are made in this GUI repo only, use conventional commit format, and carry no plan IDs in code, test names or commit messages.
- Run Rust commands with `PATH="$HOME/.cargo/bin:$PATH"`: `/usr/bin/cargo` shadows rustup's cargo on this machine.

## Non-goals

- Editing, converting, saving or annotating documents.
- Previews for audio, video, archives, `.doc`, `.ppt`, `.odt` or `.odp`. These say so and point to **Open externally**.
- Several previewed files at once, or tabs inside the preview.
- Styled spreadsheet cells, charts in sheets, PDF text selection or search, and DOCX field recomputation.
- Automatic refresh for edits made outside the assistant's `write` and office tools; **Reload** covers them.
- Changing `fs:read-pdf`, `fs:read`, `fs:read-image` or the CSP. `system:open-external` changes only to accept `mailto:`.

## Phases

| # | Phase | Owns (files) | Depends on | Status |
|---|---|---|---|---|
| 1 | [Document byte channel and mailto opener](phase-01-document-byte-channel.md) | `ipc-types.ts`, bridge (+test), `src/main/fs-read-document.ts` (+test), `src/main/external-url.ts` (+test), `src/main/ipc.ts`, `services/ipc.rs`, `services/system.rs`, `services/host_tools.rs`, `services/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/testing.rs`, `tests/channels.rs`, `contracts/{services.api.txt,ports.api.txt,services.parity.json}` | sibling plan committed | completed |
| 2 | [Preview shell, refresh and docking](phase-02-preview-shell-and-docking.md) | `lib/preview/{document-kind,document-bytes,zip-guard}.ts` (+tests), `components/preview/{DocumentPreview.tsx,file-writes.ts,renderers.ts}` (+tests), `stores/{ui,tabs}.ts` (+tests), `lib/markdown.tsx`, `hooks/use-rpc-events.ts` (+test), `FilesPanel.tsx`, `PanelContainer.tsx` (+test), `App.tsx`, `global.css`, locales | 1 | completed |
| 3 | [PDF and sheet renderers](phase-03-pdf-and-sheet-renderers.md) | fixture generator + `e2e/fixtures/document-preview/*`, `lib/pdfjs.ts` (+test), `lib/pdf-thumbnail.ts`, `lib/preview/{pdf-layout,sheet-model}.ts` (+tests), `components/preview/{PdfPreview,SheetPreview}.tsx`, `renderers.ts`, `vite.renderer.shared.ts`, `check-renderer-chunks.ts`, `package.json`, `bun.lock`, `vendor/`, locales | 2 | completed |
| 4 | [DOCX and PPTX renderers](phase-04-docx-and-pptx-renderers.md) | `lib/preview/safe-links.ts` (+test), `components/preview/{shadow-mount.ts,DocxPreview.tsx,PptxPreview.tsx,office-render-options.ts}` (+tests), `renderers.ts`, `vite.renderer.shared.ts`, `check-renderer-chunks.ts`, `package.json`, `bun.lock` | 3 | completed |
| 5 | [Entry points](phase-05-entry-points.md) | `OfficeFileRenderer.tsx` (+test), `WriteRenderer.tsx` (+test), `AttachmentCard.tsx` (+test), `InputArea.tsx`, `MessageBubble.tsx` (+ `InputArea.drop.test.tsx`, `MessageBubble.test.tsx`), `PanelContainer.test.tsx` (markdown docx case), locales | 4 | completed |
| 6 | [End-to-end in both shells, packaged pdf.js check and docs](phase-06-e2e-and-docs.md) | `e2e-tauri/document-preview.e2e.ts`, `e2e/document-preview.e2e.ts`, `e2e/sidecar-fixture.ts`, `e2e-tauri/packaged-smoke.e2e.ts`, `CHANGELOG.md` | 5 | completed |

The phases run strictly in order. Phases 2, 3 and 5 all edit the locales and
`PanelContainer.test.tsx` or `renderers.ts`, and Phases 3 and 4 both edit
`package.json`, `vite.renderer.shared.ts`, `check-renderer-chunks.ts` and
`renderers.ts`, so no two phases run in parallel.

## Shared contracts (fixed now; later phases code against them)

```ts
// src/shared/ipc-types.ts (phase 1)
IPC_COMMANDS.FS_READ_DOCUMENT = "fs:read-document"
export type IpcDocumentSignature = "pdf" | "zip" | "ole" | "html";
export type IpcFsReadDocumentError =
  "invalid-path" | "no-workspace" | "outside-workspace" | "not-a-file" | "too-large" | "unsupported" | "timed-out";
export interface IpcFsReadDocumentStamp { size: number; mtimeMs: number }
export interface IpcFsReadDocumentPayload { path: string; tabId?: string; ifChanged?: IpcFsReadDocumentStamp }
export interface IpcFsReadDocumentResult {
  ok: boolean;
  size: number;          // bytes on disk (or read); 0 when unknown
  mtimeMs: number;       // Math.floor(ms since epoch); 0 when unknown
  resolvedPath?: string; // the absolute path read; absent when the path never resolved
  unchanged?: true;      // ifChanged matched size and mtime; no data
  data?: string;         // base64 of the whole file; only on a full successful read
  signature?: IpcDocumentSignature;
  error?: string;        // an IpcFsReadDocumentError code, or an OS error message
}
// OmpApi["fs"]
readDocument(path: string, options?: { tabId?: string; ifChanged?: IpcFsReadDocumentStamp }): Promise<IpcFsReadDocumentResult>;
// <!-- Shipped: system.openPath(path: string, options?: { tabId?: string }): Promise<IpcOpenPathResult> — resolves a relative path in that tab's workspace; an unknown tab is refused -->
// Bounded read (cap + 1 byte), opened once. Tauri: Reply::Later + spawn_blocking + 30 s timeout.

// src/main/external-url.ts (phase 1); Rust twin services::system::allowed_external_url
export function isAllowedExternalUrl(url: unknown): url is string; // http:, https:, mailto:
// <!-- Shipped: replaced by `sanitizeExternalUrl(url: unknown): string | null` (Rust `services::system::sanitize_external_url`): http(s) unchanged, `mailto:` reduced to the address plus subject/body/cc/bcc, encoded `?` in the address refused. `allowed_web_url` stays for `gui_open_url`. -->

// src/renderer/stores/ui.ts (phase 2)
export type PreviewTarget =
  | { kind: "path"; path: string; tabId: string | null }
  | { kind: "image"; id: number; dataUrl: string; name: string };
filePreview: PreviewTarget | null;
openFilePreview(path: string, tabId?: string | null): void;
openImagePreview(dataUrl: string, name: string): void;
closeFilePreview(): void;
closeSessionOverlays(options?: { keepFilePreview?: boolean }): void;

// src/renderer/lib/preview/document-kind.ts (phase 2)
export type PreviewKind = "pdf" | "docx" | "pptx" | "sheet" | "csv" | "image" | "markdown" | "text" | "unsupported";
export function previewKindOf(path: string): PreviewKind;
export function expectedSignatures(path: string): readonly IpcDocumentSignature[];

// src/renderer/lib/preview/zip-guard.ts (phase 2)
export function inspectZip(bytes: Uint8Array): Promise<{ ok: true } | { ok: false; reason: "too-large" | "corrupt" }>;

// src/renderer/components/preview/file-writes.ts (phase 2)
export function writtenPathOf(toolName: string, args: unknown, result: unknown): string | null;
export function writeMatchesPreview(write: { tabId: string; path: string }, target: { path: string; tabId: string | null }, resolvedPath: string | null): boolean;
export function notifyFileWritten(tabId: string, path: string): void;
export function subscribeFileWrites(listener: (write: { tabId: string; path: string }) => void): () => void;

// src/renderer/components/preview/renderers.ts (phase 2; filled by phases 3–4)
export type PreviewContent = { bytes: Uint8Array } | { text: string; truncated: boolean };
export interface PreviewRendererProps { content: PreviewContent; kind: "pdf" | "docx" | "pptx" | "sheet" | "csv"; path: string; onError(error: unknown): void }
export type PreviewRenderers = Partial<Record<"pdf" | "docx" | "pptx" | "sheet", ComponentType<PreviewRendererProps>>>;
export const DEFAULT_PREVIEW_RENDERERS: PreviewRenderers;   // csv uses the "sheet" entry

// src/renderer/components/preview/DocumentPreview.tsx (phase 2)
export function DocumentPreview(props: { target: PreviewTarget; reloadToken: number; renderers?: PreviewRenderers }): ReactElement;
// root carries data-preview-kind="<PreviewKind>" and data-preview-state="loading|text|rich|image|error";
// the renderer boundary is keyed on the target (path + tab, or image id), never on a version.

// src/renderer/lib/pdfjs.ts (phase 3) — shared with the sibling's pdf-thumbnail.ts
export function loadPdfJs(): Promise<typeof import("pdfjs-dist")>;   // never sets the global worker port
export function pdfDocumentOptions(bytes: Uint8Array, baseUri: string): { data: Uint8Array; useWasm: false; enableXfa: false; cMapUrl: string; cMapPacked: true; standardFontDataUrl: string };
export const PDF_OPEN_TIMEOUT_MS = 20_000;
export interface PdfDocumentHandle { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> } // destroy is idempotent and works before the load resolves
export function openPdfDocument(bytes: Uint8Array, options?: { timeoutMs?: number }): PdfDocumentHandle; // own worker port + PDFWorker per document; bytes copied

// src/renderer/lib/preview/safe-links.ts (phase 4)
export function safeExternalHref(href: string): string | null;
export function routeDocumentLinkClicks(root: ShadowRoot | HTMLElement, open: (href: string) => void): () => void;

// src/renderer/components/preview/shadow-mount.ts and office-render-options.ts (phase 4)
export function useShadowMount(render: (mount: HTMLDivElement, root: ShadowRoot, signal: AbortSignal) => Promise<() => void>, deps: unknown[]): RefObject<HTMLDivElement | null>;
export const PREVIEW_FRAME_CLASS: string;
export function pptxViewerOptions(zipLimits: unknown, open: (href: string) => void): /* the viewer's options type */ object;
// <!-- Shipped: `pptxViewerOptions(zipLimits: ZipParseLimits): ViewerOptions` (no `open`, no `onNavigate`) plus `installPptxNavigation(viewer, open)`; `openDocumentLink(href)` is exported from shadow-mount.ts -->

// src/renderer/components/attachments/AttachmentCard.tsx (phase 5)
AttachmentCardProps.onOpen?: () => void;   // ignored while `loading`
```

Data flow: an entry point calls `openFilePreview(path, tabId)` or
`openImagePreview(dataUrl, name)` (`src/renderer/stores/ui.ts`). That sets
`filePreview`, `panelTab: "files"` and `panelVisible: true`. `PanelContainer`
then docks with a derived width, and `FilesPanel` renders `DocumentPreview`
with the target and its Reload counter. An image target renders at once. For a
path target `DocumentPreview` works out the kind with `previewKindOf`: text,
markdown and csv are read with `fs.read`, images with `fs.readImage`, and the
other kinds with `fs.readDocument`, always with the target's own `tabId`.
Before rendering, the signature is checked against `expectedSignatures`, the
docx/sheet parse cap is applied, and ZIP bytes go through `inspectZip`. The
content then goes to the lazy renderer for the kind, which draws into canvases,
a framed shadow root or a React table. When `use-rpc-events.ts` sees a `write`
or office tool call finish, it calls `notifyFileWritten`; a matching preview
re-reads with `ifChanged` and re-renders in place only when the file changed.

## Acceptance criteria

1. **Side by side at 1440×900** (Tauri and Electron e2e): the preview drawer's computed `position` is not `absolute`, its width is at least `0.4 × innerWidth − 1`, the `<main>` element is at least 400 px wide, and the composer `textarea` is enabled. A unit test shows the widened width is never written to `gui.panelWidth`. <!-- Shipped: the width is capped by the drawer's `MAX_WIDTH` (840 px), so the 0.4 bound holds at 1440×900 as tested, not on very wide windows --> <!-- Red team: R12 -->
2. **Split workspace** (unit tests): with `useTabsStore.split` set and a file previewed, the drawer has no `absolute` class; moving focus to the other pane keeps the preview open, does not read the file again, and keeps the opener's `tabId`. <!-- Red team: R8 -->
3. **Narrow window, 900×700** (e2e): the drawer is docked, its width is `round(0.5 × innerWidth) ± 1`, and `aside.omp-session-sidebar` is gone; after **Back to files** it is back. <!-- Red team: K3, K10 -->
4. **Fixtures render** (e2e, in both shells):
   - `report.docx`: the host is `data-rendered="true"` and its shadow root has at least 1 `section.docx`.
   - `deck.pptx`: the host is `data-rendered="true"`, its shadow root has more than 1 element, and `data-preview-state` is still `rich` 1 s later. <!-- Red team: R9 --> <!-- Shipped: body children (the toast stack aside) are unchanged after closing the docx and the pptx preview; the narrow test also asserts the composer is enabled -->
   - `table.xlsx`: a `td` with the exact text `Region`, a `td` with `=SUM(B2:B4)`, and sheet tabs `Sales` and `Notes` but not `Hidden`. <!-- Red team: R10 -->
   - `table.csv`: a `td` with the exact text `North`.
   - `one-page.pdf`: one `canvas` with `width > 0`. `sixty-pages.pdf`: the "Pages not shown here: 10" note and fewer than 10 drawn canvases. <!-- Red team: R7 -->
   - `cjk.pdf`: a drawn canvas, and `pdfjs/cmaps/UniJIS-UCS2-H.bcmap` and a standard font load through `XMLHttpRequest` with more than 0 bytes. <!-- Red team: K9 -->
   - `pixel.png`: an `img` with `naturalWidth === 1`.
5. `not-a-docx.docx` shows `data-preview-state="error"` with the "could not be shown" text, and the header's **Open externally** control is present. <!-- Red team: R14 -->
6. **Refresh** (e2e, both shells): after the fixture's `write` tool call rewrites `table.csv`, a `td` with `West` appears within 6000 ms; after a rewrite with no tool event, nothing changes for 3 s; after **Reload**, the new row appears within 6000 ms. <!-- Validation: refresh -->
7. `injected-font.docx` (e2e): its `:host` rule is present in the shadow style, yet the host stays inside its frame and does not cover the window corner. <!-- Red team: R6 -->
8. No `securitypolicyviolation` event and no page error while the previews in criteria 4–7 render (e2e).
9. The office card, Write card, markdown link and every attachment card except a loading one set `filePreview` (unit tests in Phase 5); a sent or pasted image without a path opens an image target. <!-- Validation: path-less images -->
10. `system:open-external` opens `mailto:` in both shells and the agent's `gui_open_url` still refuses it (twin unit tests in Phase 1). <!-- Validation: mailto -->
11. The installed `.deb` in the Ubuntu 24.04 container passes `scripts/tauri-deb-smoke.sh` with the pdf.js API probe. <!-- Validation: pdf.js build -->
12. `git diff <plan-start-commit> -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json src/main/packaging-config.test.ts` prints nothing.
13. Every command under "Validation commands" exits 0.

## Risks

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| The sibling plan is still uncommitted, and its code was still changing on 2026-10-07 | High × High | Task 1.1 refuses to start unless `src/main/fs-read-pdf.ts`, `src/renderer/lib/pdf-thumbnail.ts` and `src/renderer/components/attachments/AttachmentCard.tsx` are tracked and `git status --porcelain src src-tauri e2e e2e-tauri` is empty. Tasks name symbols before line numbers. |
| The modern pdf.js build calls `Map.prototype.getOrInsertComputed`, `Math.sumPrecise` and `Uint8Array.fromBase64` without polyfills, and WebKitGTK 2.48 may lack some of them [UNVERIFIED] | Medium × High | The packaged smoke in the Ubuntu 24.04 container probes them (Phase 6 Task 6.4). A failed probe stops the plan and goes to the user; the executor does not switch builds. The dev host's WebKitGTK is 2.52.6. <!-- Shipped: resolved. `Map.prototype.getOrInsertComputed` first shipped in WebKitGTK 2.52, so the `.deb` requires `libwebkit2gtk-4.1-0 (>= 2.52)` (`finalize-deb.ts`, `WEBKIT_REQUIREMENT`) and the packaged smoke probes it (`packaged-smoke.e2e.ts`); the modern build stays. See the 2026-10-08 Validation Log row. --> |
| pdf.js loads `cmaps`/`standard_fonts` from `file://` under Electron through `XMLHttpRequest` [UNVERIFIED] | Medium × Low | `cjk.pdf` and an XHR probe check it in both shells (Phase 6). A failure answers Unresolved question 2. <!-- Shipped: resolved. The Electron e2e loads `pdfjs/cmaps/UniJIS-UCS2-H.bcmap` and a standard font through `XMLHttpRequest` from `file://` (`e2e/document-preview.e2e.ts`) --> |
| `@aiden0z/pptx-renderer` does not let `onNavigate` replace its `window.open` for shape hyperlinks [UNVERIFIED] | Medium × Medium | Task 4.2 checks the installed bundle and stops on a mismatch. <!-- Shipped: resolved. 1.3.0 has no `onNavigate`; `installPptxNavigation` replaces the instance's `handleNavigate`, and a bump-guard test fails if a version change moves that hook -->  The hosts' new-window handlers still allow only http/https (`src/main/window.ts:87-90`, `src-tauri/src/webview.rs:231-234`). |
| A crafted docx, pptx or xlsx inflates far beyond its size | Medium × High | `inspectZip` counts the real inflated bytes and stops one byte past each declared size, under a 64 MiB total (D5). |
| A large docx or sheet freezes the window, which is one JS thread for chat and preview | Medium × Medium | The 10 MiB parse cap, SheetJS `sheetRows`, the parse moved into an effect after a yield, and the real-inflate budget bound the work. Being a layout sibling of the chat gives no CPU isolation, so a brief pause on a large file remains possible. <!-- Red team: R5 --> |
| A crafted PDF exhausts canvas memory | Low × High | Pages draw only near the viewport, each canvas is capped at 16 777 216 pixels, off-screen canvases are freed, and extreme aspect ratios are skipped (D8). |
| A read on a hung network mount | Low × Medium | Tauri reads behind `Reply::Later` on a blocking thread with a 30 s timeout; Electron reads asynchronously; reads happen only on open, Reload and matching writes. |
| Vendored tarball install with bun (`file:vendor/…tgz`) | Low × Medium | Task 3.2 checks the SHA-256, `bun install --frozen-lockfile` and the version. |
| A new chunk rule pulls a shared dependency (e.g. `tslib`) into a lazy chunk, which the entry then imports | Medium × Medium | `bun run build` runs `check-renderer-chunks.ts`, which names the offending file. Rules list only package roots that the renderer uses nowhere else. |

**Rollback.** Each phase is one commit, or a few, and reverts on its own in
reverse order. Phase 1 is inert until Phase 2 calls it, apart from `mailto:`
reaching the mail app, which reverts with it. Phase 2 restores the old
in-panel text preview and the old `filePreviewPath` store field when reverted.
Phases 3–4 only add renderers: without them the shell shows "not available".
Phase 5 only adds buttons. Phase 6 only adds tests, a fixture command, a smoke
probe and a changelog line.

## Validation commands

```bash
bunx vitest run
bun run check:types
bunx biome check <touched files>
node scripts/lint-surfaces.mjs
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features
bun scripts/check-test-parity.ts services
bash scripts/check-module.sh snapshots   # every contracts/*.api.txt, services and ports included
grep -c "services::ipc::fs_read_document(" src-tauri/contracts/services.api.txt src-tauri/contracts/ports.api.txt   # 1 in each
bun run build
bun e2e-tauri/check-twins.ts
scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts
scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts
bash scripts/tauri-deb-smoke.sh <the .deb from bun run package:linux>
```

## Red Team Review

### Session 2026-10-07

15 findings, 15 accepted, 0 rejected. Severity: 2 Critical, 10 High, 3 Medium.
Sources: `reports/red-team-security.md`, `reports/red-team-failure-modes.md`,
`reports/red-team-assumptions.md`, `reports/red-team-scope-contracts.md`,
deduplicated in `reports/red-team-adjudication.md`. The verifier's defects
K1–K12 (`reports/kongming-261007-ultra-verdict.md`) were applied as well.

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| R1 | Shared pdf.js worker destroyed per document; transferred bytes; lost 20 s timeout; no cancel handle | Critical | Accepted | D3, Shared contracts, Phase 3 Task 3.3, Task 3.6 |
| R2 | API snapshot gate also checks `ports.api.txt` | Critical | Accepted | Constraints, Phase 1 files and Task 1.7, Validation commands |
| R3 | Zip guard trusts declared sizes | High | Accepted | D5, Phase 2 Task 2.2, Risks |
| R4 | Synchronous Tauri handler in the window queue; unbounded read after stat | High | Accepted | D2, Phase 1 Tasks 1.3 and 1.5 |
| R5 | Main-thread parse of large files; parse in `useMemo` | High | Accepted | D8, Phase 2 Task 2.7, Phase 3 Tasks 3.5–3.6, Phase 4 risks, Risks |
| R6 | docx-preview CSS injection through `:host`; docked aside without a stacking context | High | Accepted | D4, Phase 2 Task 2.8 (CSS), Phase 3 fixture, Phase 4 Tasks 4.3–4.4, Phase 6 test, criterion 7 |
| R7 | PDF renders every page eagerly with no pixel cap | High | Accepted | D8, Phase 3 Tasks 3.1 and 3.6, criterion 4 |
| R8 | Split-pane focus change remounts or clears the preview and resolves against the wrong tab | High | Accepted | D1, Shared contracts, Phase 2 Tasks 2.4 and 2.8, Phase 5, criterion 2 |
| R9 | pptx e2e passes before the renderer runs | High | Accepted | Phase 4 Task 4.3 (`data-rendered`), Phase 6 Task 6.1, criterion 4 |
| R10 | SheetJS drops formula cells without a cached value | High | Accepted | D8, Phase 3 Task 3.5, criterion 4 |
| R11 | Broken gate commands (Task 4.2 path, Task 5.3 grep, Task 6.1 spec, Task 6.2 twin rule) | High | Accepted | Phase 4 Task 4.2, Phase 5 Task 5.3, Phase 6 Tasks 6.1–6.2 |
| R12 | Preview widening writes the persisted `gui.panelWidth` | High | Accepted | D1, Phase 2 Task 2.8, criterion 1 |
| R13 | Renders resolving after cleanup are never disposed | Medium | Accepted | Phase 4 Task 4.3 |
| R14 | CSV ignores `binary`/`!ok`/`truncated`; duplicate open action and loading string | Medium | Accepted | Outcome, Constraints, Phase 2 Tasks 2.3 and 2.7, Phase 3 Tasks 3.5–3.6, criterion 5 |
| R15 | Link guard misses pptx shape hyperlinks and SVG anchors; `mailto:` dropped by both shells | Medium | Accepted | D4, Phase 1 Task 1.6, Phase 4 Tasks 4.1–4.3 |

Verifier defects: K1 channel-count numbers removed (Phase 1 Tasks 1.1/1.5, D10);
K2 `SplitAxis` `"columns"` without a cast (Phase 2 Tasks 2.4/2.8); K3 sidebar
restored on close (D1, Phase 2 Task 2.8, criterion 3); K4 call-site list
verified (Phase 5 files); K5 SHA-256 pin (D6, Phase 3 Task 3.2); K6 the image
sniffer is no longer moved and the image tests still run as a guard (Phase 1
Task 1.8); K7 images keep `fs:read-image` (D2, Phase 2 Task 2.7); K8
`root.host` (Phase 4 Task 4.4); K9 cmaps e2e check (Phase 3 Task 3.1, Phase 6
Task 6.1); K10 real sidebar selector `aside.omp-session-sidebar` (Phase 6);
K11 `.xls` accepts OLE, ZIP or HTML (Phase 1, Phase 2 Task 2.1, Phase 3);
K12 Reload button (D9, Phase 2 Task 2.7).

### Whole-Plan Consistency Sweep

Checked on 2026-10-07 by grepping `plan.md` and every phase file:

- `statOnly`, `2 s`, `poll`, `PREVIEW_POLL`, `useFileVersion`: no instruction remains to poll or to use a stat-only mode; the remaining mentions say that nothing polls (Phase 2 Goal and Task 2.7 Verify, Phase 6 refresh test, D9).
- `setWidth(` in the widen context: removed; Phase 2 Task 2.8 derives `effectiveWidth` and states that `setWidth` is never called for the preview.
- `dist/*.d.ts`: replaced by `dist/types` in Phase 4 Task 4.2.
- `launch.project`: replaced by `run.project` from `const run = await launch(...)`; `until(…, 6000)` replaced by `{ timeout: 6_000 }`; `exactTextCount` added to the imports (Phase 6 Task 6.1).
- `91` / `92`: no channel count is stated; Phase 1 records and raises the current value.
- `axis: "row"` and `as never` on the split: replaced by `axis: "columns"` without a cast.
- `mailto`: allowed by the router (Phase 4), opened by both shells (Phase 1 Task 1.6), refused by the agent tool (Phase 1); no contradiction left.
- "chat stays usable because sibling": removed from Risks; the Risks row now says layout gives no CPU isolation.
- `isEvalSupported`: no mention in any plan file (the sibling's loader already dropped it, `pdf-thumbnail.ts:6-7`).
- `legacy`: the only remaining uses are "legacy .xls/.doc/.ppt" file formats. No instruction swaps to the legacy pdf.js build; a failing API probe goes to the user.
- `Open in its app`, `preview.openInApp`, `preview.loading`: replaced by the header's existing **Open externally** and `filesPanel.reading`.
- `filePreviewPath`: only as the field Phase 2 replaces, with a Verify grep that it is gone afterwards.
- `sniffImageMime`: no longer moved; images stay on `fs:read-image`.

Unresolved contradictions: none. One evidence-based risk is open for the user,
not a contradiction: the modern pdf.js build's unpolyfilled APIs on WebKitGTK
2.48 (Unresolved question 3).

## Validation Log

### Session 2026-10-07 — user decisions after the red-team review

| # | Question | Answer | Phases affected |
|---|---|---|---|
| 1 | Apply the red-team findings? | Apply all 15 (and the verifier's K1–K12). | 1–6, plan.md |
| 2 | Refresh strategy: poll or event-driven? | Event-driven: re-check with an `ifChanged` stamp only when a `write` or office tool call that wrote this path finishes, plus a **Reload** button. No polling. Keep scroll, sheet and page when unchanged; on change, re-render in place keyed on the path, not a version. | 1 (no `statOnly`, `ifChanged`), 2 (bus, `DocumentPreview`, Reload), 3–4 (in-place re-render), 6 (e2e) |
| 3 | ≤1000 px behaviour? | Dock at 50vw, hide the left sidebar while the preview is open, restore its previous visibility on close. | 2, 6 |
| 4 | Spreadsheets library? | Vendor the SheetJS CE 0.20.3 tarball under `vendor/`, SHA-256 pinned and verified in a task. | 3 |
| 5 | pdf.js build? | Modern build (SAI OS WebKitGTK ≥ 2.48); add a check in the Ubuntu 24.04 container smoke test. | 3, 6 |
| 6 | `mailto:` links? | Widen `system:open-external` to accept `mailto:` in both shells (`src/main/ipc.ts:734`, `src-tauri/src/services/system.rs:16`) with twin tests. | 1, 4 |
| 7 | Path-less images? | Preview in-memory images too: the preview state accepts a file path or an image data URL. | 2, 5 |

### Session 2026-10-08 — user decision during delivery

| # | Question | Answer | Phases affected |
|---|---|---|---|
| 1 | Keep the modern pdf.js build on WebKitGTK, and what floor? | Keep it. `Map.prototype.getOrInsertComputed` first shipped in WebKitGTK 2.52, so the `.deb` requires `libwebkit2gtk-4.1-0 (>= 2.52)`. | 3, 6 |

## Unresolved questions

1. **Fallbacks.** Is going straight to "could not be shown" (with **Open externally**) acceptable when docx-preview or the pptx renderer fails? The default is yes: no mammoth and no JSZip slide-text extractor. Adding them is about 90 KB lazy plus 150 lines.
2. **Electron PDFs with CJK or non-embedded fonts.** <!-- Shipped: resolved. Electron `file://` XHR loads cmaps and standard fonts (e2e). --> If the Phase 6 cmaps probe fails under Electron `file://`, do these PDFs need to render on macOS? If so, a custom pdf.js data factory is follow-up work.
3. **Modern pdf.js on WebKitGTK 2.48.** <!-- Shipped: resolved by user decision (2026-10-08): keep the modern build; the `.deb` requires `libwebkit2gtk-4.1-0 (>= 2.52)` because `Map.prototype.getOrInsertComputed` first shipped in WebKitGTK 2.52. --> The modern build calls `Map.prototype.getOrInsertComputed`, `Math.sumPrecise` and `Uint8Array.fromBase64` without polyfills. If the Ubuntu 24.04 smoke probe fails, should the plan keep the modern build (and require a newer WebKitGTK) or switch builds? Either choice is the user's.
4. **`fs:read-pdf`.** Should the sibling's `fs:read-pdf` later fold into `fs:read-document`? It is not done here.
5. **Write card.** Should the Write card's preview icon show for every written file? The default is every file: text renders as today. <!-- Shipped: the icon shows for every finished, non-error write (`!isPartial && !isError`). -->

## Ultra Selection

Best-of-5 candidates verified by kongming; winner materialized unchanged before the red-team and validation gates. Ranking: `reports/ultra-ranking-appendix.md`; verdict: `reports/kongming-261007-ultra-verdict.md`.

ultra: picked=4/5 margin=low unanimous=no rejected_all=no

## Follow-ups

- The `edit` tool and edits made outside the assistant do not refresh a preview by themselves (D9); **Reload** or re-opening the file covers them.
- PDF pages do not redraw when the drawer is resized.
- pptx shapes with hyperlinks have no keyboard activation.
