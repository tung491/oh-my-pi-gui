=== FILE: plan.md ===
---
title: "Side-by-side document preview"
description: "Open a read-only preview of docx, pptx, xlsx/xls/ods, csv, pdf, images and text next to the chat, from the office card, the Write card, markdown links, the Files panel and attachment cards."
status: pending
priority: P2
effort: 24h
branch: main
tags: [frontend, renderer, tauri, electron, ipc, preview, tdd]
blockedBy: [261007-1931-drop-file-attachment-cards]
blocks: []
created: 2026-10-07
---

# Side-by-side document preview

## Outcome

Inside the Sai ATLAS window the user opens a read-only preview of a file in the
right-hand workspace drawer while the conversation stays visible and usable
beside it. The drawer docks beside the chat in every layout, including a split
workspace and windows of 1000 px or less, where it used to float over the chat.

The preview opens from five places:

- **Office output card** (`office_report`, `office_slides`, `office_clean`): a new **Preview** button.
- **Write tool card**: a new preview icon next to the path.
- **Model markdown links to local files**: already routed to the drawer. Office, PDF and image files now render instead of showing "binary".
- **Files panel tree**: already routed to the drawer, now with rich formats.
- **Attachment cards** in the composer and in the sent user bubble (from the attachment-cards plan): clicking a card opens it.

It renders these formats:

| Format | How it renders |
|---|---|
| .docx | Laid out as pages |
| .pptx | Slides |
| .xlsx, .xls, .ods, .csv | A sheet table with sheet tabs |
| .pdf | Page canvases |
| png/jpg/jpeg/webp/gif/svg/bmp/avif | An image |
| md | Markdown, as today |
| Other text | Plain text, as today |

Any other file shows its type with **Open in its app**. A preview refreshes by itself when the file changes on disk.

## Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Surface | Reuse the inspector drawer's existing Files preview mode. While a file is previewed (`panelTab === "files"` and `filePreviewPath !== null`) the drawer **docks** as a flex sibling of `<main>`, even when the workspace is split or the window is ≤1000 px. Entering the preview widens the drawer to `max(current, 40 % of the window)`. At ≤1000 px it docks at `50vw`, and the left sidebar collapses so the chat keeps about half the window. | The drawer is already the one right-hand surface. `openFilePreview` already routes markdown links and the tree into it, so a new pane or tab would duplicate the resize, persistence and error-boundary code. The overlay rules (`PanelContainer.tsx:125`, `global.css:705`) are the only reason it is not side by side today. Changing those rules is the smallest fix. |
| D2 | Byte transport | One new channel, `fs:read-document` `{path, tabId?, statOnly?}`. Absolute and `~/` paths are read as given and relative paths stay workspace-confined, the same as `fs:read-image` (`src-tauri/src/services/ipc.rs:483`). Cap 32 MiB, the same value as `fs:read-pdf`. The bytes are returned only when they start with a known signature: `%PDF-`, ZIP `PK\x03\x04`, OLE `D0 CF 11 E0 A1 B1 1A E1`, or an image (the existing `sniffImageMime` / `sniff_image_mime`). `statOnly` returns `{size, mtimeMs}` for any regular file and drives refresh. Text, markdown and csv keep `fs:read`, unchanged. | This follows the trust contract in `src-tauri/src/services/fs.rs:7-12`: absolute paths are read as given, and the renderer is trusted. The signature allowlist keeps binary bytes limited to document types, mirroring the image rule. A single command covers every binary format. Per-format commands would repeat path resolution, caps and parity tests six times. |
| D3 | Relation to sibling `fs:read-pdf` | `fs:read-pdf` stays as the sibling built it (absolute only, used by the card thumbnails). The preview reads PDFs through `fs:read-document`, because Files-panel paths are workspace-relative and `fs:read-pdf` rejects relative paths. Both plans share one pdf.js loader, `src/renderer/lib/pdfjs.ts`, which Phase 3 extracts from the sibling's `pdf-thumbnail.ts`, and one `decodeBase64` (`src/renderer/lib/preview/document-bytes.ts`). | This avoids a second pdf.js setup or worker. Retiring `fs:read-pdf` is not requested (see Unresolved questions). |
| D4 | Isolation | docx-preview and the pptx renderer render into an **open shadow root**, so document CSS cannot reach the app and app CSS cannot reach the document. One capturing click router sends `http`, `https` and `mailto` links to `system.openExternal` and swallows every other link. docx-preview is hardened with `renderAltChunks: false` (no unsandboxed `srcdoc` iframe) and `useBase64URL: true` (fonts and images as `data:`, which the CSP allows). The pptx renderer is hardened with `RECOMMENDED_ZIP_LIMITS` and `pdfjs: false`. PDFs render to canvas only, with no text or annotation layer, so a PDF has no links and no scripting. Sheets render as React text. Images render through `<img>`. Markdown keeps `MarkdownRenderer`. **The CSP is unchanged.** | A sandboxed iframe adds no script protection beyond `script-src 'self'`, because the libraries need script inside the frame, and it complicates sizing (research report, "Cross-cutting security"). With the shadow root, the CSP and the link router, document content never reaches the main document unsanitized and has no path to execute script. |
| D5 | Zip bombs | Before any ZIP-based renderer runs, `checkZipBounds(bytes)` reads the central directory and refuses more than 256 MiB uncompressed, more than 5000 entries, ZIP64, or a broken directory. | docx-preview, JSZip and SheetJS have no ZIP limits of their own (research report). |
| D6 | Libraries | PDF uses `pdfjs-dist` 6.4.x, already a dependency added by the sibling, with `useWasm: false`, self-hosted `cmaps/` and `standard_fonts/`, and the module worker from `?url`/`new URL`. DOCX uses `docx-preview` 0.4.1, pinned. PPTX uses `@aiden0z/pptx-renderer` 1.3.0, pinned. XLSX, XLS, ODS and CSV use SheetJS CE 0.20.3, vendored as `vendor/xlsx-0.20.3.tgz`. There is **no** mammoth and **no** JSZip pptx-fallback extractor: any render failure goes to **Open in its app**. **Default chosen; see Unresolved questions 1–2.** | These follow the research recommendations. Skipping the fallbacks is the KISS option the research accepts. exceljs cannot read .xls or .ods, and the npm `xlsx` package is the vulnerable 0.18.5. |
| D7 | Entry points | Office card **Preview** button. Write card preview icon (only when the write is neither partial nor an error). Markdown links (existing route, no change). Files panel (existing route). `AttachmentCard` gains `onOpen`, wired in the composer and the user bubble. | These cover every input and output surface named in the request. The Read card is not an entry point, because the request names attached and workspace files as inputs. |
| D8 | Limits | Read cap 32 MiB. PDF: the first 50 pages, plus a "pages not shown" note. Sheets: 500 rows × 50 columns per sheet, hidden sheets skipped, plus a "showing first N" note. Text: 200 KB, and CSV 2 MB, the existing `fs:read` behaviour. Legacy .doc and .ppt, audio, video, archives and unknown binaries show "not available" with **Open in its app**. A corrupt file shows "could not be shown" with **Open in its app**. A file that does not match its extension's signature (e.g. a text file named `.docx`) is treated as corrupt. | Each cap bounds memory and time in the renderer, and each failure leaves a working way out. |
| D9 | Staleness | While a preview is mounted and the page is visible, the preview polls `fs.readDocument(path, {statOnly: true})` every 2000 ms. A changed `mtimeMs` or `size` re-reads and re-renders. When the bridge has no `readDocument` (older test doubles), it does not poll. | The poll is shell-neutral and costs one `stat` per 2 s only while a preview is open. A partially written file that fails to render recovers on the next change. |
| D10 | Sibling plan | This plan is `blockedBy` `261007-1931-drop-file-attachment-cards` and starts only when that plan's changes are committed. Phase 1 checks this mechanically. Without the sibling, Phases 1–4 could run if Phase 3 added `pdfjs-dist` itself and created `lib/pdfjs.ts` fresh. Phase 5 Task 5.3, the attachment-card entry, cannot run, because the cards do not exist yet. | Both plans edit `ipc-types.ts`, the bridge, `ipc.rs`, `mod.rs`, `channels.rs`, the locales and `package.json`. Running them sequentially avoids merge conflicts in shared contract files. |

## Constraints

- Rendering happens in the renderer with JS only. Nothing runs LibreOffice or any converter at run time.
- Every new IPC change lands in both shells:
  - the type in `src/shared/ipc-types.ts`;
  - the bridge in `src/shared/bridge/create-omp-api.ts`;
  - the Electron handler in `src/main/ipc.ts`;
  - the Rust handler in `src-tauri/src/services/ipc.rs`, registered twice in `src-tauri/src/services/mod.rs`;
  - Rust twins of every TS test (`src-tauri/contracts/services.parity.json`);
  - the API snapshot (`src-tauri/contracts/services.api.txt`) and the channel count (`src-tauri/tests/channels.rs`).
- The CSP stays byte-identical in `src/renderer/index.html`, `src/renderer/quick-entry.html` and `src-tauri/tauri.conf.json`. No `'wasm-unsafe-eval'` and no remote hosts.
- New renderer libraries load through dynamic `import()` only. Each gets a `VENDOR_CHUNK_RULES` entry (`vite.renderer.shared.ts:20`) and a `LAZY_CHUNKS` entry (`scripts/check-renderer-chunks.ts:13`).
- Every user-visible string goes through `useT()`, with keys in both `en.ts` and `vi.ts`.
- Tests use the linkedom harness. Stores are reset with `setState`/`reset()` and never `mock.module()`. There is no `any` and no inline imports.
- Commits are made in this GUI repo only, use conventional commit format, and carry no plan IDs in code, test names or commit messages.
- Run Rust commands with `PATH="$HOME/.cargo/bin:$PATH"`: `/usr/bin/cargo` shadows rustup's cargo on this machine.

## Non-goals

- Editing, converting, saving or annotating documents.
- Previews for audio, video, archives, `.doc`, `.ppt`, `.odt` or `.odp`. These show their type and **Open in its app**.
- Several previewed files at once, or tabs inside the preview.
- Styled spreadsheet cells, charts in sheets, PDF text selection or search, and DOCX field recomputation.
- Changing `fs:read-pdf`, `fs:read`, `fs:read-image` or the CSP.

## Phases

| # | Phase | Owns (files) | Depends on | Status |
|---|---|---|---|---|
| 1 | [Document byte channel](phase-01-document-byte-channel.md) | `ipc-types.ts`, bridge (+test), `src/main/fs-read-document.ts` (+test), `src/main/ipc.ts`, `services/ipc.rs`, `services/mod.rs`, `tests/channels.rs`, `contracts/services.{api.txt,parity.json}` | sibling plan committed | pending |
| 2 | [Preview shell and docking](phase-02-preview-shell-and-docking.md) | `lib/preview/{document-kind,document-bytes,zip-guard}.ts` (+tests), `components/preview/{DocumentPreview,use-file-version,renderers}.tsx/ts` (+test), `FilesPanel.tsx`, `PanelContainer.tsx` (+test), `App.tsx`, `global.css`, locales | 1 | pending |
| 3 | [PDF and sheet renderers](phase-03-pdf-and-sheet-renderers.md) | fixture generator + `e2e/fixtures/document-preview/*`, `lib/pdfjs.ts` (+test), `lib/pdf-thumbnail.ts`, `lib/preview/sheet-model.ts` (+test), `components/preview/{PdfPreview,SheetPreview}.tsx`, `renderers.ts`, `vite.renderer.shared.ts`, `check-renderer-chunks.ts`, `package.json`, `bun.lock`, `vendor/`, locales | 2 | pending |
| 4 | [DOCX and PPTX renderers](phase-04-docx-and-pptx-renderers.md) | `lib/preview/safe-links.ts` (+test), `components/preview/{shadow-mount.ts,DocxPreview.tsx,PptxPreview.tsx,office-render-options.ts}` (+test), `renderers.ts`, `vite.renderer.shared.ts`, `check-renderer-chunks.ts`, `package.json`, `bun.lock` | 3 | pending |
| 5 | [Entry points](phase-05-entry-points.md) | `OfficeFileRenderer.tsx` (+test), `WriteRenderer.tsx` (+test), `AttachmentCard.tsx` (+test), the `<AttachmentCard` call sites, `PanelContainer.test.tsx` (markdown docx case), locales | 4 | pending |
| 6 | [End-to-end in both shells and docs](phase-06-e2e-and-docs.md) | `e2e-tauri/document-preview.e2e.ts`, `e2e/document-preview.e2e.ts`, `CHANGELOG.md` | 5 | pending |

The phases run strictly in order. Phases 3 and 4 both edit `package.json`,
`vite.renderer.shared.ts`, `check-renderer-chunks.ts` and `renderers.ts`, so
they must not run in parallel.

## Shared contracts (fixed now; later phases code against them)

```ts
// src/shared/ipc-types.ts (phase 1)
IPC_COMMANDS.FS_READ_DOCUMENT = "fs:read-document"
export type IpcDocumentSignature = "pdf" | "zip" | "ole" | "image";
export type IpcFsReadDocumentError =
  "invalid-path" | "no-workspace" | "outside-workspace" | "not-a-file" | "too-large" | "unsupported";
export interface IpcFsReadDocumentPayload { path: string; tabId?: string; statOnly?: boolean }
export interface IpcFsReadDocumentResult {
  ok: boolean;
  size: number;       // bytes on disk; 0 when unknown
  mtimeMs: number;    // Math.floor(ms since epoch); 0 when unknown
  data?: string;      // base64 of the whole file; absent for statOnly and failures
  signature?: IpcDocumentSignature;
  mime?: string;      // only when signature === "image"
  error?: string;     // an IpcFsReadDocumentError code, or an OS error message
}
// OmpApi["fs"]
readDocument(path: string, options?: { tabId?: string; statOnly?: boolean }): Promise<IpcFsReadDocumentResult>;

// src/renderer/lib/preview/document-kind.ts (phase 2)
export type PreviewKind = "pdf" | "docx" | "pptx" | "sheet" | "csv" | "image" | "markdown" | "text" | "unsupported";
export function previewKindOf(path: string): PreviewKind;
export function expectedSignature(path: string): IpcDocumentSignature | null;

// src/renderer/components/preview/renderers.ts (phase 2; filled by phases 3–4)
export interface PreviewRendererProps { bytes: Uint8Array; kind: "pdf" | "docx" | "pptx" | "sheet" | "csv"; path: string; onError(error: unknown): void }
export type PreviewRenderers = Partial<Record<"pdf" | "docx" | "pptx" | "sheet", ComponentType<PreviewRendererProps>>>;
export const DEFAULT_PREVIEW_RENDERERS: PreviewRenderers;   // csv uses the "sheet" entry

// src/renderer/components/preview/DocumentPreview.tsx (phase 2)
export function DocumentPreview(props: { path: string; tabId: string | null; renderers?: PreviewRenderers }): ReactElement;
// root element carries data-preview-kind="<PreviewKind>" and data-preview-state="loading|text|rich|image|error"

// src/renderer/lib/pdfjs.ts (phase 3) — shared with the sibling's pdf-thumbnail.ts
export function loadPdfJs(): Promise<typeof import("pdfjs-dist")>;
export function pdfDocumentOptions(bytes: Uint8Array, baseUri: string): { data: Uint8Array; useWasm: false; enableXfa: false; cMapUrl: string; cMapPacked: true; standardFontDataUrl: string };
export function openPdfDocument(bytes: Uint8Array): Promise<{ document: PDFDocumentProxy; destroy(): Promise<void> }>;

// src/renderer/lib/preview/safe-links.ts (phase 4)
export function safeExternalHref(href: string): string | null;
export function routeDocumentLinkClicks(root: ShadowRoot | HTMLElement, open: (href: string) => void): () => void;

// src/renderer/components/attachments/AttachmentCard.tsx (phase 5)
AttachmentCardProps.onOpen?: () => void;
```

Data flow: an entry point calls `useUiStore.getState().openFilePreview(path)`
(`src/renderer/stores/ui.ts:191`). That sets `filePreviewPath`,
`panelTab: "files"` and `panelVisible: true`. `PanelContainer` then docks, and
`FilesPanel` renders `DocumentPreview`. `DocumentPreview` works out the kind
with `previewKindOf`. Text, markdown and csv are read with `fs.read`. Every
other supported kind is read with `fs.readDocument`. Before rendering, the
signature is checked against `expectedSignature`, and ZIP bytes are checked
with `checkZipBounds`. The bytes then go to the lazy renderer for the kind,
which draws into a canvas, a shadow root or a React table. `useFileVersion`
polls `statOnly` and bumps a version, which re-runs the read.

## Acceptance criteria

1. **Side by side at 1440×900** (Tauri and Electron e2e): the preview drawer's computed `position` is not `absolute`, its width is at least `0.4 × innerWidth − 1`, the `<main>` element is at least 400 px wide, and the composer `textarea` is enabled.
2. **Split workspace**: with `useTabsStore.split` set and a file previewed, the drawer has no `absolute` class (unit test in `PanelContainer.test.tsx`).
3. **Narrow window, 900×700**: the drawer is docked (`position` is not `absolute`), its width is `round(0.5 × innerWidth) ± 1`, and `useUiStore.sidebarVisible === false` (e2e).
4. **Fixtures render** (e2e, in both shells):
   - `report.docx`: the preview's shadow root has at least 1 `section.docx`.
   - `deck.pptx`: the shadow root has at least 1 element and `data-preview-state="rich"`.
   - `table.xlsx`: a `td` with the exact text `Region`, and sheet tabs `Sales` and `Notes` but not `Hidden`.
   - `table.csv`: a `td` with the exact text `North`.
   - `one-page.pdf`: one `canvas` with `width > 0`.
   - `pixel.png`: an `img` with `naturalWidth === 1`.
5. `not-a-docx.docx` shows `data-preview-state="error"` with an **Open in its app** control.
6. After the e2e rewrites `table.csv` on disk, a `td` with the text `West` appears within 6000 ms.
7. No `securitypolicyviolation` event and no page error while the previews in criteria 4–6 render (e2e).
8. The office card, Write card, markdown link and attachment card each set `filePreviewPath` to their file (unit tests in Phase 5).
9. `git diff <plan-start-commit> -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json src/main/packaging-config.test.ts` prints nothing.
10. `bunx vitest run`, `bun run check:types`, biome on the touched files, `node scripts/lint-surfaces.mjs`, clippy, `cargo test`, `bun scripts/check-test-parity.ts services`, `bash scripts/check-module.sh snapshots`, `bun run build` and `bun e2e-tauri/check-twins.ts` all exit 0.

## Risks

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| The sibling plan is still uncommitted (its files are in the working tree on 2026-10-07) | High × High | Task 1.1 refuses to start unless `src/main/fs-read-pdf.ts`, `src/renderer/lib/pdf-thumbnail.ts` and `src/renderer/components/attachments/AttachmentCard.tsx` are tracked and `git status --porcelain src src-tauri` is empty. |
| pdf.js loads `cmaps`/`standard_fonts` from `file://` under Electron [UNVERIFIED] | Medium × Low | The fixture PDF does not need them, so rendering is unaffected. Only CJK PDFs and PDFs without embedded fonts degrade. This is listed as an unresolved question. Tauri serves them from `tauri://localhost`. |
| `@aiden0z/pptx-renderer` API differs from the research (`PptxViewer.open`, `RECOMMENDED_ZIP_LIMITS`, `destroy`) [UNVERIFIED] | Medium × Medium | Task 4.4 greps the installed `.d.ts` first. A missing symbol triggers the Failure Protocol. |
| Vendored tarball install with bun (`file:vendor/…tgz`) [UNVERIFIED] | Low × Medium | Task 3.2 verifies it with `bun install --frozen-lockfile` and a version check. |
| A new chunk rule pulls a shared dependency (e.g. `tslib`) into a lazy chunk, which the entry then imports | Medium × Medium | `bun run build` runs `check-renderer-chunks.ts`, which names the offending file. Rules list only package roots that the renderer uses nowhere else. |
| WebKitGTK on SAI OS is older than pdf.js 6 needs [UNVERIFIED] | Low × Medium | This is an unresolved question. The fallback is to swap to `pdfjs-dist/legacy/build/*` inside `lib/pdfjs.ts` only. |
| A large docx renders slowly (no page cap) | Medium × Low | The 32 MiB read cap and the ZIP bounds limit it. The renderer is lazy and the chat stays usable, because the drawer is a sibling of the chat. |
| The 2 s poll keeps firing in a background window | Low × Low | It is skipped while `document.visibilityState !== "visible"` and cleared on unmount. |

**Rollback.** Each phase is one commit, or a few, and reverts on its own in
reverse order. Phase 1 is inert until Phase 2 calls it. Phases 3–4 only add
renderers: without them the shell shows "not available". Phase 5 only adds
buttons. Phase 6 only adds tests and a changelog line.

## Validation commands

```bash
bunx vitest run
bun run check:types
bunx biome check <touched files>
node scripts/lint-surfaces.mjs
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features
bun scripts/check-test-parity.ts services
bash scripts/check-module.sh snapshots
bun run build
bun e2e-tauri/check-twins.ts
scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts
scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts
```

## Unresolved questions

1. **Spreadsheets.** Is vendoring `vendor/xlsx-0.20.3.tgz`, the SheetJS CE tarball, acceptable repo policy? The default is yes. The alternative is exceljs, which is already a devDependency, but it cannot read .xls or .ods and has not been released since 2023.
2. **Fallbacks.** Is going straight to **Open in its app** acceptable when docx-preview or the pptx renderer fails? The default is yes: no mammoth and no JSZip slide-text extractor. Adding them is about 90 KB lazy plus 150 lines.
3. **Narrow windows.** At ≤1000 px, may opening a preview collapse the left sidebar? The default is yes, so the chat keeps about half the window.
4. **macOS PDFs.** Do CJK and non-embedded-font PDFs need to render on macOS (Electron `file://`)? If they do, Phase 3 needs a custom pdf.js data factory.
5. **SAI OS WebKitGTK.** Which WebKitGTK version does SAI OS ship? It decides between the modern and legacy pdf.js builds.
6. **`fs:read-pdf`.** Should the sibling's `fs:read-pdf` later fold into `fs:read-document`? It is not done here.
7. **Write card.** Should the Write card's preview icon show for every written file? The default is every file: text renders as today.

=== FILE: phase-01-document-byte-channel.md ===
---
phase: 1
title: "Document byte channel"
status: pending
priority: P1
effort: "4h"
dependencies: []
---
# Phase 1: Document byte channel

## Goal

Add `fs:read-document` to both shells. It returns the base64 bytes, size, mtime
and signature of a PDF, ZIP (OOXML/ODF), OLE (legacy .xls) or image file, and
`{size, mtimeMs}` alone when `statOnly` is set. The bytes are capped at 32 MiB.
Both shells return byte-identical JSON shapes, with Rust twins for every TS test.

## Files to Create / Modify

- Create: `src/main/fs-read-document.ts`, `src/main/fs-read-document.test.ts`
- Modify:
  - `src/shared/ipc-types.ts`: `IPC_COMMANDS` after `FS_READ_PDF`, about line 190; new types after `IpcFsReadPdfResult`, about line 757; `OmpApi["fs"]`, about line 1316.
  - `src/shared/bridge/create-omp-api.ts`: the `fs:` block, about line 359.
  - `src/shared/bridge/create-omp-api.test.ts`
  - `src/main/ipc.ts`: move `sniffImageMime` (about line 1013) into the new module; add a handler after `FS_READ_PDF`, about line 1079.
  - `src-tauri/src/services/ipc.rs`: a new handler after `read_pdf_file`, about line 565; new tests in `mod tests`.
  - `src-tauri/src/services/mod.rs`: the `CHANNELS` table, about line 58, and `register`, about line 91.
  - `src-tauri/tests/channels.rs`: `EXPECTED_CHANNEL_COUNT`, line 14.
  - `src-tauri/contracts/services.api.txt`
  - `src-tauri/contracts/services.parity.json`

## Test Matrix (TDD)

| Case | Test file | Red (before code) | Green |
|---|---|---|---|
| `document read returns a docx as base64 with the zip signature` | `src/main/fs-read-document.test.ts` | vitest exit 1, "Failed to resolve import" | pass |
| `document read returns a legacy xls with the ole signature` | same | exit 1 | pass |
| `document read returns a pdf with the pdf signature` | same | exit 1 | pass |
| `document read returns a png with the image signature and mime` | same | exit 1 | pass |
| `document read rejects bytes with no known signature as unsupported` | same | exit 1 | pass |
| `document read rejects a file over the size cap as too large` | same | exit 1 | pass |
| `document read rejects a directory as not a file` | same | exit 1 | pass |
| `document read reports a missing file as not ok` | same | exit 1 | pass |
| `document stat only returns size and mtime without data for any file` | same | exit 1 | pass |
| The same 9 names in snake_case | `src-tauri/src/services/ipc.rs` `mod tests` | `cargo test … document` fails to compile (exit 101) | pass |
| `reads a document over its own channel with tab and stat options` | `src/shared/bridge/create-omp-api.test.ts` | exit 1, `readDocument is not a function` | pass |
| Channel count and scope parity | `src-tauri/tests/channels.rs` | fails once the TS command exists without a Rust registration | pass |

## Tasks

### Task 1.1 — Precondition: the sibling plan is committed
- **Goal:** Never edit shared contract files while the attachment-cards work is uncommitted.
- **Target files and symbols:** none modified.
- **Steps:**
  1. Run `git ls-files --error-unmatch src/main/fs-read-pdf.ts src/renderer/lib/pdf-thumbnail.ts src/renderer/components/attachments/AttachmentCard.tsx`.
  2. Run `git status --porcelain src src-tauri e2e e2e-tauri | wc -l`.
  3. Record `git rev-parse HEAD` as the plan-start commit. The final phase's CSP check compares against it.
- **Success criteria:** All three files are tracked, and the tree under those dirs is clean.
- **Verify:**
  - Step 1 exits 0.
  - Step 2 prints exactly `0`.

### Task 1.2 — Red: TS tests for the document reader
- **Goal:** Pin the result shape before writing the code.
- **Target files and symbols:** create `src/main/fs-read-document.test.ts`, importing `readDocumentFile` and `FS_DOCUMENT_MAX_BYTES` from `./fs-read-document`.
- **Steps:**
  1. Copy the harness from `src/main/fs-read-pdf.test.ts`: a `mkdtempSync` dir in `beforeEach` and `rmSync` in `afterEach`.
  2. Define these byte constants:
     - `ZIP = Buffer.from([0x50,0x4b,0x03,0x04,0x14,0,0,0])`
     - `OLE = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0,0])`
     - `PDF = Buffer.from("%PDF-1.7\n%âã\n", "latin1")`
     - `PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")`
  3. Write the 9 `it(...)` cases with the exact titles from the Test Matrix, under `describe("readDocumentFile", …)`. Expected values:
     - **docx:** `{ ok: true, data: ZIP.toString("base64"), size: ZIP.length, mtimeMs: Math.floor(statSync(file).mtimeMs), signature: "zip" }` (use `toEqual`).
     - **xls:** the same shape with `signature: "ole"`.
     - **pdf:** the same shape with `signature: "pdf"`.
     - **png:** the same shape with `signature: "image"` and `mime: "image/png"`.
     - **plain text `"hello"` named `a.docx`:** `{ ok: false, size: 5, mtimeMs: <floor>, error: "unsupported" }`.
     - **10 bytes with `maxBytes: 4`:** `{ ok: false, size: 10, mtimeMs: <floor>, error: "too-large" }`.
     - **directory:** `{ ok: false, size: 0, mtimeMs: 0, error: "not-a-file" }`.
     - **missing file:** `ok === false`, `size === 0`, and `typeof error === "string"`.
     - **statOnly on `notes.txt` ("hello"):** `{ ok: true, size: 5, mtimeMs: <floor> }`, and `"data" in result === false`.
  4. Run the tests.
- **Success criteria:** The test file exists, and it fails only because the module is missing.
- **Verify:** `bunx vitest run src/main/fs-read-document.test.ts; echo "exit=$?"` prints a line containing `Failed to resolve import "./fs-read-document"` and ends with `exit=1`.

### Task 1.3 — Green: the TS document reader
- **Goal:** One pure, absolute-path reader that the Electron handler calls.
- **Target files and symbols:**
  - Create `src/main/fs-read-document.ts` with these exports: `FS_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024`, `sniffImageMime(header: Buffer): string | null`, `documentSignature(header: Buffer): { signature: IpcDocumentSignature; mime?: string } | null`, and `readDocumentFile(abs: string, options?: { statOnly?: boolean; maxBytes?: number }): Promise<IpcFsReadDocumentResult>`.
  - `src/shared/ipc-types.ts`: the types from plan.md "Shared contracts".
- **Steps:**
  1. Add the plan.md contract types and `FS_READ_DOCUMENT: "fs:read-document"` to `src/shared/ipc-types.ts`. Give the constant a one-line doc comment in the style of `FS_READ_PDF`: "Read a document's bytes (PDF, ZIP, OLE or image signature; size cap) or only its size and mtime, for the in-app preview".
  2. Move `sniffImageMime` verbatim from `src/main/ipc.ts` (the closure at about lines 1013–1038) into the new module as an export. In `ipc.ts`, delete the closure and add `import { readDocumentFile, sniffImageMime } from "./fs-read-document";`. The `FS_READ_IMAGE` handler keeps calling `sniffImageMime(...)` unchanged.
  3. Implement `documentSignature(header)` with these checks, in order:
     - `%PDF-` → `pdf`;
     - `50 4b 03 04` → `zip`;
     - `d0 cf 11 e0 a1 b1 1a e1` → `ole`;
     - `sniffImageMime(header)` non-null → `{ signature: "image", mime }`;
     - otherwise `null`.
  4. Implement `readDocumentFile`:
     1. `fsp.stat`. On a throw, return `{ ok: false, size: 0, mtimeMs: 0, error: <message> }`.
     2. If it is not a file, return `{ ok: false, size: 0, mtimeMs: 0, error: "not-a-file" }`.
     3. Set `mtimeMs = Math.floor(stat.mtimeMs)`.
     4. If `statOnly`, return `{ ok: true, size, mtimeMs }`.
     5. If `size > (maxBytes ?? FS_DOCUMENT_MAX_BYTES)`, return `{ ok: false, size, mtimeMs, error: "too-large" }`.
     6. `fsp.readFile`, then run `documentSignature(bytes.subarray(0, 512))`. If it is null, return `{ ok: false, size, mtimeMs, error: "unsupported" }`.
     7. Otherwise return `{ ok: true, data: base64, size, mtimeMs, signature, ...(mime ? { mime } : {}) }`.
     8. Wrap the whole function in a try/catch, so it never throws.
  5. Run the tests.
- **Success criteria:** All 9 cases pass, and the existing image handler still compiles.
- **Verify:**
  - `bunx vitest run src/main/fs-read-document.test.ts; echo "exit=$?"` ends with `exit=0`.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 1.4 — Electron handler and bridge (red, then green)
- **Goal:** Expose the reader as `window.omp.fs.readDocument` in Electron.
- **Target files and symbols:** `src/shared/bridge/create-omp-api.test.ts` (a new `it`); `create-omp-api.ts` `fs.readDocument`; `OmpApi["fs"].readDocument`; `src/main/ipc.ts` `ipcMain.handle(IPC_COMMANDS.FS_READ_DOCUMENT, …)`.
- **Steps:**
  1. **Red.** Add `it("reads a document over its own channel with tab and stat options", …)`, using the existing `fakePort` helper. It calls `api.fs.readDocument("docs/a.docx", { tabId: "t1", statOnly: true })` and expects `invokes` to equal `[{ channel: IPC_COMMANDS.FS_READ_DOCUMENT, args: [{ path: "docs/a.docx", tabId: "t1", statOnly: true }] }]`. Run it; it must fail.
  2. **Green.** In `create-omp-api.ts`, add `readDocument: (path: string, options: { tabId?: string; statOnly?: boolean } = {}) => port.invoke(IPC_COMMANDS.FS_READ_DOCUMENT, { path, tabId: options.tabId, statOnly: options.statOnly }) as Promise<IpcFsReadDocumentResult>` after `readPdf`. Add the method to `OmpApi["fs"]` in `ipc-types.ts`.
  3. In `src/main/ipc.ts`, after the `FS_READ_PDF` handler, add an async handler `(event, payload: IpcFsReadDocumentPayload | undefined)` that does the following:
     1. If `payload?.path` is not a non-empty string, return `{ ok: false, size: 0, mtimeMs: 0, error: "invalid-path" }`.
     2. Expand a leading `~/` with `os.homedir()`.
     3. If the path is absolute, use `path.normalize(raw)`.
     4. Otherwise get `cwdFor(deps, event, payload.tabId)` (`ipc.ts:104`). If it is null, return `error: "no-workspace"`.
     5. Then `resolveWithin(cwd, raw)` (`ipc.ts:241`). If it is null, return `error: "outside-workspace"`.
     6. Return `readDocumentFile(abs, { statOnly: payload.statOnly === true })`.
- **Success criteria:** The bridge test passes, and the types compile.
- **Verify:**
  - `bunx vitest run src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` ends with `exit=1` after step 1, and with `exit=0` after step 3.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 1.5 — Rust handler with twin tests (red, then green)
- **Goal:** Byte-identical behaviour in the Tauri shell.
- **Target files and symbols:** `src-tauri/src/services/ipc.rs`: `pub fn fs_read_document(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply`, private `fn read_document_file(abs: &Path, stat_only: bool, max_bytes: u64) -> Value`, private `fn document_signature(header: &[u8]) -> Option<(&'static str, Option<&'static str>)>`, and `const FS_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;`.
- **Steps:**
  1. **Red.** In `mod tests` (about line 589), add 9 `#[test]` functions whose names are the snake_case of the TS titles, for example `document_read_returns_a_docx_as_base64_with_the_zip_signature`.
     - Each writes the same bytes into a `tempfile::tempdir()`, calls `super::read_document_file(&path, false, super::FS_DOCUMENT_MAX_BYTES)` and asserts `assert_eq!` on the same `json!` shape as the TS test.
     - The too-large case passes `4` as `max_bytes`. The stat-only case passes `true`.
     - Compute `mtimeMs` as `std::fs::metadata(&p).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64`.
     - Run the tests.
  2. **Green.** Implement `document_signature`. It uses the same order as TS and calls `workspace_fs::sniff_image_mime(&header[..header.len().min(512)])` for images.
  3. Implement `read_document_file`. It mirrors Task 1.3 step 4 and returns `json!` objects. `"mime"` is present only for images, and `"data"` only on a successful full read.
  4. Implement `fs_read_document`:
     1. Parse `path`, `tabId` and `statOnly` from the payload.
     2. If `path` is empty, return the `"invalid-path"` shape.
     3. Run `expand_home(path)`.
     4. If the result is absolute, use it as is.
     5. Otherwise, if `ctx.tabs.cwd_for(caller, tab_id)` is None, return `"no-workspace"`.
     6. Otherwise, if `workspace_fs::resolve_within` is None, return `"outside-workspace"`.
     7. Return `Reply::ok(read_document_file(&abs, stat_only, FS_DOCUMENT_MAX_BYTES))`.
  5. In `src-tauri/src/services/mod.rs`, add `("fs:read-document", Scope::Main),` after `("fs:read-pdf", Scope::Main),` in `CHANNELS`, and `reg.register("fs:read-document", Scope::Main, ipc::fs_read_document);` after the `fs:read-pdf` registration.
  6. In `src-tauri/tests/channels.rs`, raise `EXPECTED_CHANNEL_COUNT` by exactly 1 from its value at phase start. It is 91 when the sibling has landed, which makes it 92.
- **Success criteria:** The Rust tests pass, and the channel test passes.
- **Verify:**
  - After step 1: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib document; echo "exit=$?"` ends with `exit=101`.
  - After step 6: the same command ends with `exit=0`, and its output contains `9 passed`, or more if other `document` tests exist.
  - After step 6: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features --test channels; echo "exit=$?"` ends with `exit=0`.

### Task 1.6 — Parity, snapshot, clippy
- **Goal:** Keep the port gates green.
- **Target files and symbols:** `src-tauri/contracts/services.parity.json`, `src-tauri/contracts/services.api.txt`.
- **Steps:**
  1. Append `{ "ts": "src/main/fs-read-document.test.ts", "rust": "src-tauri/src/services/ipc.rs" }` to `services.parity.json`, matching its two-space formatting.
  2. In `services.api.txt`, insert this exact line directly after the `fs_read(` line: `pub fn sai_atlas_lib::services::ipc::fs_read_document(&alloc::rcs::arc::Arc<sai_atlas_lib::ctx::AppCtx>, sai_atlas_lib::ports::Caller, alloc::vec::Vec<serde_json::value::Value>) -> sai_atlas_lib::bridge::Reply`
  3. Run the gates.
- **Success criteria:** Parity, snapshots and clippy all pass.
- **Verify:**
  - `bun scripts/check-test-parity.ts services; echo "exit=$?"` ends with `exit=0`.
  - `bash scripts/check-module.sh snapshots` exits 0, and its last line starts with `check-module snapshots: PASS`.
  - `PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings; echo "exit=$?"` ends with `exit=0`.

### Task 1.7 — Phase commit
- **Goal:** One revertable commit.
- **Target files and symbols:** every file listed in this phase.
- **Steps:**
  1. Run `bunx biome check src/main/fs-read-document.ts src/main/fs-read-document.test.ts src/main/ipc.ts src/shared/ipc-types.ts src/shared/bridge/create-omp-api.ts src/shared/bridge/create-omp-api.test.ts`.
  2. Run `git add` on the phase files.
  3. Run `git commit -m "feat(fs): read document bytes for the in-app preview in both shells"`.
- **Success criteria:** Biome is clean, and the commit exists.
- **Verify:**
  - The biome command exits 0.
  - `git log -1 --format=%s` prints `feat(fs): read document bytes for the in-app preview in both shells`.

## Verification

- `bunx vitest run src/main src/shared` exits 0.
- `bun run check:types` exits 0.
- `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features` exits 0.
- `bun scripts/check-test-parity.ts services` exits 0.
- `bash scripts/check-module.sh snapshots` prints a last line starting `check-module snapshots: PASS`.

## Risks & Rollback

- **Moving `sniffImageMime` could change `fs:read-image` behaviour.** Mitigation: the move is verbatim, and the png test exercises it. The existing `markdown-image.test.tsx` keeps running in the full suite.
- **Electron and Rust disagree on `mtimeMs` rounding.** Both floor to whole milliseconds, and each shell's tests compare against that shell's own `stat`.
- **Rollback:** `git revert <phase commit>`. No caller exists until Phase 2.

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

=== FILE: phase-02-preview-shell-and-docking.md ===
---
phase: 2
title: "Preview shell and docking"
status: pending
priority: P1
effort: "5h"
dependencies: [1]
---
# Phase 2: Preview shell and docking

## Goal

The Files panel's preview body becomes `DocumentPreview`. That component works
out the kind, reads the file through the right channel, validates the
signature and ZIP bounds, shows the loading, error and unsupported states with
**Open in its app**, renders text, markdown and images itself, hands other
kinds to injectable lazy renderers (filled in by Phases 3–4), and refreshes
when the file changes. The drawer docks beside the chat while a file is
previewed, including in a split workspace and at ≤1000 px.

## Files to Create / Modify

- **Create:**
  - `src/renderer/lib/preview/document-kind.ts`, `src/renderer/lib/preview/document-kind.test.ts`
  - `src/renderer/lib/preview/document-bytes.ts`
  - `src/renderer/lib/preview/zip-guard.ts`, `src/renderer/lib/preview/zip-guard.test.ts`
  - `src/renderer/components/preview/DocumentPreview.tsx`, `src/renderer/components/preview/DocumentPreview.test.tsx`
  - `src/renderer/components/preview/use-file-version.ts`
  - `src/renderer/components/preview/renderers.ts`
- **Modify:**
  - `src/renderer/components/panels/FilesPanel.tsx`: remove `PreviewState`, `openPreview` (about lines 102–136) and the preview effect (about lines 138–144). Replace the preview body (about lines 214–247) with `<DocumentPreview>`.
  - `src/renderer/components/layout/PanelContainer.tsx` and `PanelContainer.test.tsx`
  - `src/renderer/App.tsx`: the compact auto-hide effect, about lines 289–299.
  - `src/renderer/styles/global.css`: the `@media (max-width: 1000px)` block, about line 705.
  - `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `previewKindOf` maps docx, pptx, xlsx/xls/ods, csv, pdf, png/jpg/jpeg/webp/gif/svg/bmp/avif, md/mdx, `.ts` → text, and doc/ppt/odt/odp/zip/mp3/mp4 → unsupported (case-insensitive) | `document-kind.test.ts` | vitest exit 1 (missing module) | pass |
| `expectedSignature`: docx/pptx/xlsx/ods → zip, xls → ole, pdf → pdf, image → image, md → null | same | exit 1 | pass |
| `checkZipBounds` accepts a real fixture-sized zip, refuses more than 5000 entries, refuses more than 256 MiB total uncompressed, refuses ZIP64 markers, and refuses a truncated buffer as corrupt | `zip-guard.test.ts` | exit 1 | pass |
| Markdown path: calls `fs.read(path, 200_000)` and renders `h1` (the existing behaviour) | `DocumentPreview.test.tsx` | exit 1 | pass |
| docx path with a stub renderer: calls `readDocument(path, {})`, and the stub receives `bytes.length` | same | exit 1 | pass |
| Signature mismatch (`.docx` with `signature: "pdf"`): `data-preview-state="error"` and an **Open in its app** button | same | exit 1 | pass |
| `error: "too-large"` shows the too-large message | same | exit 1 | pass |
| `.zip` path: unsupported message, and neither `read` nor `readDocument` is called | same | exit 1 | pass |
| Staleness: a `statOnly` mtime change after 2000 ms (fake timers) makes a second full read | same | exit 1 | pass |
| No `readDocument` on the bridge: no poll and no throw | same | exit 1 | pass |
| Split workspace + previewing: the aside has no `absolute` class | `PanelContainer.test.tsx` | the assertion fails (the class is present) | pass |
| Split workspace without a preview: the aside keeps `absolute` (regression) | same | passes before and after | pass |
| Previewing at innerWidth 1440: the aside width becomes `576px` | same | fails (`403px`) | pass |
| Compact (matchMedia true) + previewing: `sidebarVisible` becomes `false`, and `data-docked-preview` is present | same | fails | pass |
| Existing tests "opens a local markdown link…" and "decodes an absolute file URL…" | same | stay green | pass |

## Tasks

### Task 2.1 — Red then green: kind detection and byte decoding
- **Goal:** Pure helpers that the shell and the entry points share.
- **Target files and symbols:**
  - `document-kind.ts`: `PreviewKind`, `previewKindOf(path)` and `expectedSignature(path)` (contracts in plan.md).
  - `document-bytes.ts`: `decodeBase64(data: string): Uint8Array`, the same body as the private one in `src/renderer/lib/pdf-thumbnail.ts`.
- **Steps:**
  1. Write `document-kind.test.ts` with `it.each` tables covering every extension in the matrix. Run it (red).
  2. Implement the module. It takes the extension from the last `.` after the last `/`, lowercased. The maps are:

     | Kind | Extensions |
     |---|---|
     | pdf | `pdf` |
     | docx | `docx` |
     | pptx | `pptx` |
     | sheet | `xlsx`, `xls`, `ods` |
     | csv | `csv` |
     | image | `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `bmp`, `avif` |
     | markdown | `md`, `mdx` |
     | unsupported | `doc`, `ppt`, `odt`, `odp`, `rtf`, `zip`, `tar`, `gz`, `tgz`, `7z`, `rar`, `xz`, `mp3`, `wav`, `m4a`, `ogg`, `flac`, `opus`, `mp4`, `mov`, `mkv`, `webm` |
     | text | everything else, including no extension |

     For `expectedSignature`: `xls` → `"ole"`; other sheet extensions, `docx` and `pptx` → `"zip"`; `pdf` → `"pdf"`; image kinds → `"image"`; everything else → `null`.
  3. Write `document-bytes.ts`: `decodeBase64`, plus `readDocumentBytes(path: string, tabId: string | null)`. It calls `window.omp.fs.readDocument(path, tabId ? { tabId } : {})` and returns either `{ ok: true; bytes; data; signature; mime?; size; mtimeMs }` or `{ ok: false; error: string }`. Here `data` is the base64 string as received, so images can build a data URL without encoding again.
- **Success criteria:** All the table cases pass.
- **Verify:** `bunx vitest run src/renderer/lib/preview/document-kind.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after it.

### Task 2.2 — Red then green: ZIP bounds guard
- **Goal:** Refuse zip bombs before JSZip or SheetJS inflate anything.
- **Target files and symbols:** `zip-guard.ts`: `export const ZIP_MAX_ENTRIES = 5000`, `export const ZIP_MAX_UNCOMPRESSED = 256 * 1024 * 1024`, and `export function checkZipBounds(bytes: Uint8Array): { ok: true } | { ok: false; reason: "too-large" | "corrupt" }`.
- **Steps:**
  1. In the test, build ZIP buffers in code with `jszip`, which is already a devDependency and is test-only here: one file → `ok`; 5001 empty files → `too-large`.
  2. For the uncompressed-size case, hand-patch one central-directory entry's uncompressed-size field (offset 24 of the `PK\x01\x02` record) to `0x7fffffff` in each of 3 entries. Expect `too-large`.
  3. ZIP64: patch the EOCD entry count (EOCD offset 10) to `0xffff`. Expect `too-large`.
  4. Corrupt: `bytes.subarray(0, 30)`. Expect `corrupt`. Run (red).
  5. Implement the guard:
     1. Scan backwards from the end, up to 65 557 bytes, for the EOCD signature `0x06054b50`. If it is missing, return `corrupt`.
     2. Read the total entries (u16 at +10), the central-directory size (u32 at +12) and offset (u32 at +16). If the entry count is `0xffff` or the offset is `0xffffffff`, return `too-large`.
     3. If the entry count is more than `ZIP_MAX_ENTRIES`, return `too-large`.
     4. Walk the central directory, checking for `0x02014b50` at each record. Sum the uncompressed size (u32 at +24) and advance by `46 + nameLen(+28) + extraLen(+30) + commentLen(+32)`.
     5. If any read goes out of bounds or a signature mismatches, return `corrupt`. If the sum exceeds the limit, return `too-large`.
     6. Use `DataView` little-endian reads.
- **Success criteria:** All 5 cases pass.
- **Verify:** `bunx vitest run src/renderer/lib/preview/zip-guard.test.ts; echo "exit=$?"` ends with `exit=1` before step 5, and with `exit=0` after it.

### Task 2.3 — Locale keys
- **Goal:** Every new string exists in both languages.
- **Target files and symbols:** `src/renderer/locales/en.ts` and `vi.ts`. Add these keys next to the `filesPanel.*` block (about line 1147):

  | Key | en | vi |
  |---|---|---|
  | `preview.loading` | "Opening preview…" | "Đang mở bản xem trước…" |
  | `preview.failed` | "This file could not be shown here." | "Không thể hiển thị tệp này tại đây." |
  | `preview.unsupported` | "Preview is not available for this type of file." | "Chưa hỗ trợ xem trước loại tệp này." |
  | `preview.tooLarge` | "This file is too large to preview here." | "Tệp quá lớn để xem trước tại đây." |
  | `preview.openInApp` | "Open in its app" | "Mở bằng ứng dụng" |

- **Steps:** Add the 5 keys to both files in the same order.
- **Success criteria:** The locale parity test passes.
- **Verify:** `bunx vitest run src/renderer/locales; echo "exit=$?"` ends with `exit=0`.

### Task 2.4 — Red: DocumentPreview behaviour tests
- **Goal:** Pin the shell's states and channels before the code exists.
- **Target files and symbols:** `src/renderer/components/preview/DocumentPreview.test.tsx`.
- **Steps:**
  1. Copy the linkedom harness from `src/renderer/components/layout/PanelContainer.test.tsx` lines 7–56, including `flush()`, the `ompWindow` save and restore, and mounting inside `I18nProvider`.
  2. Define `stubRenderers: PreviewRenderers = { docx: ({ bytes }) => <div data-stub>{bytes.length}</div>, sheet: ({ bytes, kind }) => <div data-stub>{kind}:{bytes.length}</div> }`.
  3. Write the eight `DocumentPreview.test.tsx` cases from the Test Matrix.
     - Mock `window.omp.fs.readDocument` with `vi.fn` returning `{ ok: true, data: btoa("PK\u0003\u0004abcd"), size: 8, mtimeMs: 1, signature: "zip" }`.
     - Because `checkZipBounds` would reject those 8 bytes as corrupt, the docx-stub case uses the real zip bytes from `new JSZip().file("a","b").generateAsync({ type: "uint8array" })`, encoded with `Buffer.from(bytes).toString("base64")`.
     - Use `vi.useFakeTimers()` and `await vi.advanceTimersByTimeAsync(2000)` for staleness. Set `document.visibilityState` with `Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })`.
     - Assert on `[data-preview-state]`, `[data-stub]` text, the button text `Open in its app`, and the `vi.fn` call args.
  4. Run the tests.
- **Success criteria:** The file fails only because `./DocumentPreview` is missing.
- **Verify:** `bunx vitest run src/renderer/components/preview; echo "exit=$?"` output contains `Failed to resolve import "./DocumentPreview"` and ends with `exit=1`.

### Task 2.5 — Green: DocumentPreview, the version hook and the renderer registry
- **Goal:** Implement the shell.
- **Target files and symbols:** `renderers.ts`: `PreviewRendererProps`, `PreviewRenderers`, and `DEFAULT_PREVIEW_RENDERERS = {}` (Phases 3–4 fill it). `use-file-version.ts`: `export const PREVIEW_POLL_MS = 2000` and `export function useFileVersion(path: string, tabId: string | null, enabled: boolean): number`. `DocumentPreview.tsx`: `DocumentPreview`.
- **Steps:**
  1. **`useFileVersion`.** The effect returns early when `!enabled` or when `typeof window.omp?.fs?.readDocument !== "function"`.
     - On mount it calls `readDocument(path, { ...(tabId ? { tabId } : {}), statOnly: true })` and stores `{ size, mtimeMs }`.
     - Every `PREVIEW_POLL_MS` it calls again, but only when `document.visibilityState === "visible"`. When `ok` is true and `size` or `mtimeMs` differ from the stored values, it stores them and increments the returned version.
     - It clears the interval on unmount or when `path` changes, and ignores results that arrive after cleanup (a `cancelled` flag).
  2. **`DocumentPreview`.**
     1. Set `kind = previewKindOf(path)` and `version = useFileVersion(path, tabId, kind !== "unsupported")`.
     2. An effect keyed on `[path, tabId, version]` loads the file, with a request counter that drops stale results, as in `FilesPanel`'s `previewVersion` ref:

        | Kind | Read | Result |
        |---|---|---|
        | `unsupported` | none | error `unsupported` |
        | `markdown` or `text` | `tabId ? fs.read(path, 200_000, tabId) : fs.read(path, 200_000)` | State `text` with `{ content, truncated, markdown: kind === "markdown" }`. When `binary` is true, show the existing `filesPanel.binary` text; when not ok, show the existing `filesPanel.readFailed` text. |
        | `csv` | the same `fs.read` with `2_000_000` | State `rich` with `bytes = new TextEncoder().encode(content)` |
        | `pdf`, `docx`, `pptx`, `sheet`, `image` | `readDocumentBytes(path, tabId)` | See the checks below |

     3. For the `readDocumentBytes` kinds:
        - When not ok: `too-large` → error `too-large`; any other error → error `failed`.
        - When `signature !== expectedSignature(path)` → error `failed`.
        - When the signature is `zip` and `checkZipBounds(bytes)` is not ok → error `too-large` or `failed`, matching its `reason`.
        - Image → state `image` with `dataUrl = \`data:${mime};base64,${data}\``, built from the `data` field that `readDocumentBytes` returns.
        - Otherwise → state `rich`.
     4. Render into a root `<div className="h-full min-h-0 overflow-auto" data-preview-kind={kind} data-preview-state={state.status}>`:

        | State | Renders |
        |---|---|
        | `loading` | `Spinner` + `t("preview.loading")` |
        | `text` | Exactly the markup in `FilesPanel.tsx` lines about 221–246: `MarkdownRenderer` for markdown, `<pre>` otherwise, with the `filesPanel.truncated` note |
        | `image` | `<img src={dataUrl} alt="" className="mx-auto max-w-full object-contain p-3">` |
        | `rich` | `const Renderer = renderers[kind === "csv" ? "sheet" : kind]`. If it is missing, error `unsupported`. Otherwise `<PanelErrorBoundary key={\`${path}:${version}\`}><Suspense fallback={<Spinner size="sm" />}><Renderer bytes kind path onError={() => setState({ status: "error", reason: "failed" })} /></Suspense></PanelErrorBoundary>` |
        | `error` | A centred message from `preview.unsupported`, `preview.tooLarge` or `preview.failed`, and below it `<PathLink path={path} className="…">{t("preview.openInApp")}</PathLink>` (`src/renderer/components/tools/PathLink.tsx`) |

  3. Run the tests.
- **Success criteria:** All `DocumentPreview.test.tsx` cases pass.
- **Verify:** `bunx vitest run src/renderer/components/preview; echo "exit=$?"` ends with `exit=0`.

### Task 2.6 — FilesPanel delegates to DocumentPreview
- **Goal:** One preview implementation.
- **Target files and symbols:** `src/renderer/components/panels/FilesPanel.tsx`.
- **Steps:**
  1. Delete `PREVIEW_MAX_BYTES`, `PreviewState`, the `preview` state, `previewVersion`, `openPreview`, the `filePreviewPath` effect, `activePreview` and `previewIsMarkdown`.
  2. Keep the header block (back, path, `PathLink` open externally, insert mention) unchanged.
  3. Replace the `<div className="min-h-0 flex-1 overflow-auto bg-(--omp-code-bg)">…</div>` body with `<div className="min-h-0 flex-1 overflow-hidden bg-(--omp-code-bg)"><DocumentPreview path={filePreviewPath} tabId={tabId} /></div>`.
  4. Remove the imports that are now unused (`MarkdownRenderer`, and `Spinner` if unused).
- **Success criteria:** The existing PanelContainer preview tests still pass unchanged.
- **Verify:**
  - `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=0`.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 2.7 — Red then green: docking beside the chat
- **Goal:** The preview is never an overlay.
- **Target files and symbols:** `PanelContainer.tsx`: a new `previewing` value, the className condition at about line 125, a new widen effect and a new compact-sidebar effect. `global.css`: a new `.omp-inspector[data-docked-preview]` rule. `App.tsx`: the `hideInspector` condition.
- **Steps:**
  1. **Red.** Add four `it(...)` cases to `PanelContainer.test.tsx`, as listed in the Test Matrix.
     - **Split:** `useTabsStore.setState({ split: { firstTabId: "t0", secondTabId: "t1", axis: "row", ratio: 0.5 } as never })`. Before writing it, check the field names with `grep -n "interface SplitLayout" -A6 src/renderer/stores/tabs.ts` and use exactly those fields.
     - **Width:** innerWidth is 1440; `useUiStore.setState({ filePreviewPath: "a.pdf", panelTab: "files", panelVisible: true })`; expect `aside.style.width === "576px"`.
     - **Compact:** set `window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })` and restore it in `afterEach`. Seed `sidebarVisible: true` and a preview, then expect `useUiStore.getState().sidebarVisible === false` and `aside.hasAttribute("data-docked-preview")`. In `afterEach`, also add `useUiStore.setState({ sidebarVisible: true })`.
     - Run (red).
  2. **Green.** In `PanelContainer`:
     1. Add `const filePreviewPath = useUiStore(s => s.filePreviewPath);` and `const previewing = panelTab === "files" && filePreviewPath !== null;`.
     2. Change the overlay condition to `(compact || split) && !previewing ? "absolute inset-y-0 right-0 z-30 shadow-[var(--omp-shadow-lg)]" : "shrink-0"`.
     3. Add `data-docked-preview={previewing ? "" : undefined}` to the `<aside>`.
     4. Add `useEffect(() => { if (!previewing || compact || !widthHydrated) return; const target = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.4), Math.max(MIN_WIDTH, window.innerWidth - 56)); setWidth(current => Math.max(current, target)); }, [previewing, compact, widthHydrated]);`
     5. Add `useEffect(() => { if (!compact || !previewing) return; const ui = useUiStore.getState(); if (ui.sidebarVisible) ui.toggleSidebar(); }, [compact, previewing]);`
  3. In `global.css`, inside the existing `@media (max-width: 1000px)` block and after the `.omp-inspector` rule, add:
     ```css
     .omp-inspector[data-docked-preview] {
     	position: relative;
     	inset-block: auto;
     	right: auto;
     	z-index: auto;
     	width: 50vw !important;
     	box-shadow: none;
     }
     ```
  4. In `App.tsx`'s `hideInspector`, change the condition to `compact.matches && ui.panelVisible && !(ui.panelTab === "files" && ui.filePreviewPath !== null)`.
- **Success criteria:** The four new tests pass, and every existing PanelContainer test still passes.
- **Verify:** `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=1` after step 1, and with `exit=0` after step 4.

### Task 2.8 — Phase gate and commit
- **Goal:** A clean, revertable phase.
- **Target files and symbols:** all the files of this phase.
- **Steps:**
  1. Run `bunx vitest run`.
  2. Run `bun run check:types`.
  3. Run `bunx biome check src/renderer/lib/preview src/renderer/components/preview src/renderer/components/panels/FilesPanel.tsx src/renderer/components/layout/PanelContainer.tsx src/renderer/components/layout/PanelContainer.test.tsx src/renderer/App.tsx src/renderer/locales/en.ts src/renderer/locales/vi.ts`.
  4. Run `node scripts/lint-surfaces.mjs`.
  5. Commit with `git commit -m "feat(preview): dock a document preview beside the chat"`.
- **Success criteria:** All the gates pass.
- **Verify:** Each of the four commands in steps 1–4 exits 0, and `git log -1 --format=%s` prints `feat(preview): dock a document preview beside the chat`.

## Verification

- `bunx vitest run` exits 0.
- `bun run check:types` exits 0.
- `node scripts/lint-surfaces.mjs` exits 0.
- `bun run build` exits 0. The renderer is not yet lazy-split for new libraries, because Phase 2 adds none.

## Risks & Rollback

- **The existing preview tests depend on the exact `fs.read(path, 200_000)` call.** Task 2.5 keeps that exact call, and Task 2.6 verifies it.
- **Fake timers and React `act` can deadlock.** Use `advanceTimersByTimeAsync` inside `act`. If they deadlock, apply the Failure Protocol rather than switching to real sleeps.
- **The narrow-window rule reflows the chat.** It applies only while a file is previewed. Closing the preview with Back restores the old overlay behaviour.
- **Rollback:** `git revert <phase commit>` restores the old in-panel text preview.

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

=== FILE: phase-03-pdf-and-sheet-renderers.md ===
---
phase: 3
title: "PDF and sheet renderers"
status: pending
priority: P1
effort: "5h"
dependencies: [2]
---
# Phase 3: PDF and sheet renderers

## Goal

Commit realistic fixtures, then add the PDF renderer and the sheet renderer for
xlsx, xls, ods and csv. PDF uses the shared pdf.js loader, which is extracted
from the sibling's `pdf-thumbnail.ts` and gains self-hosted cmaps and standard
fonts. Sheets use vendored SheetJS CE. Both renderers load lazily in their own
chunks.

## Files to Create / Modify

- **Create:**
  - `scripts/gen-preview-fixtures.ts`
  - `e2e/fixtures/document-preview/{report.docx,deck.pptx,table.xlsx,table.csv,one-page.pdf,pixel.png,not-a-docx.docx,notes.md}`
  - `vendor/xlsx-0.20.3.tgz`
  - `src/renderer/lib/pdfjs.ts`, `src/renderer/lib/pdfjs.test.ts`
  - `src/renderer/lib/preview/sheet-model.ts`, `src/renderer/lib/preview/sheet-model.test.ts`
  - `src/renderer/components/preview/PdfPreview.tsx`
  - `src/renderer/components/preview/SheetPreview.tsx`
- **Modify:**
  - `src/renderer/lib/pdf-thumbnail.ts`: use the shared loader and `decodeBase64`.
  - `src/renderer/components/preview/renderers.ts`
  - `vite.renderer.shared.ts`: `VENDOR_CHUNK_RULES`, plus a new `pdfjsAssets()` plugin in `rendererConfig().plugins`.
  - `scripts/check-renderer-chunks.ts`: `LAZY_CHUNKS`.
  - `package.json`, `bun.lock`
  - `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `pdfDocumentOptions` returns `useWasm: false`, `enableXfa: false`, `cMapPacked: true`, `cMapUrl` = `file:///app/out/renderer/pdfjs/cmaps/` and `standardFontDataUrl` = `file:///app/out/renderer/pdfjs/standard_fonts/` for base `file:///app/out/renderer/index.html` | `src/renderer/lib/pdfjs.test.ts` | vitest exit 1 | pass |
| The sibling's thumbnail cache tests stay green after the extraction | `src/renderer/lib/pdf-thumbnail.test.ts` | green before | green after |
| `table.xlsx` → sheet names `["Sales","Notes"]` (`Hidden` skipped); `rows[0]` = `["Region","Revenue"]`; `rows[1]` = `["North","120"]`; cell `[4][1]` = `"=SUM(B2:B4)"` and `formulaCells.has("4:1")` | `sheet-model.test.ts` | exit 1 | pass |
| CSV bytes `"Region,Revenue\nNorth,120\n"` → rows `[["Region","Revenue"],["North","120"]]` | same | exit 1 | pass |
| A synthetic 600×60 sheet → 500 rows × 50 columns, `totalRows: 600`, `totalCols: 60` | same | exit 1 | pass |
| A `.xls` (biff8) and an `.ods` written by SheetJS in the test read back the same first row | same | exit 1 | pass |
| The build keeps the `pdfjs` and `sheetjs` chunks lazy and emits the `pdfjs/cmaps` and `pdfjs/standard_fonts` assets | `bun run build` + `ls` | fails before the rules exist (no chunk name) | pass |

## Tasks

### Task 3.1 — Fixture generator and committed fixtures
- **Goal:** Deterministic, realistic inputs for the unit and e2e tests, produced by the repo's own office writers.
- **Target files and symbols:** `scripts/gen-preview-fixtures.ts`; the `e2e/fixtures/document-preview/*` files.
- **Steps:**
  1. Write the script. With `OUT = path.resolve(import.meta.dirname, "../e2e/fixtures/document-preview")` and `mkdirSync(OUT, { recursive: true })`, it creates:

     | File | Content |
     |---|---|
     | `report.docx` | `(await buildReport({ markdown: readFileSync("assistant-pack/test/fixtures/notes-en.md","utf8"), fallbackTitle: "Report", lang: "en" })).bytes`, from `../assistant-pack/src/office/report` |
     | `deck.pptx` | The same with `buildSlides`, from `../assistant-pack/src/office/slides` |
     | `table.xlsx` | Written with `exceljs`: sheet `Sales` with `A1 "Region"`, `B1 "Revenue"`, rows `North 120`, `South 95`, `East 143`, and `B5` = `{ formula: "SUM(B2:B4)" }` with no `result`; sheet `Notes` with `A1 "Prepared by Sai ATLAS"`; sheet `Hidden` with `state = "hidden"` and `A1 "secret"` |
     | `table.csv` | `"Region,Revenue\nNorth,120\nSouth,95\n"` |
     | `one-page.pdf` | A one-page PDF built as a string. Objects: 1 Catalog, 2 Pages, 3 Page (MediaBox 0 0 300 200), 4 content stream `BT /F1 24 Tf 40 100 Td (Preview fixture) Tj ET`, 5 Font Type1 Helvetica. The xref table offsets are computed from the string with `Buffer.byteLength`, followed by the trailer and `startxref`. |
     | `pixel.png` | `Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")` |
     | `not-a-docx.docx` | `"just text, not a document\n"` |
     | `notes.md` | `"# Fixture notes\n\nPlain markdown.\n"` |

  2. Run `bun scripts/gen-preview-fixtures.ts`.
- **Success criteria:** All 8 files exist, and the PDF, docx and png signatures are right.
- **Verify:**
  - `ls e2e/fixtures/document-preview | wc -l` prints `8`.
  - `head -c 5 e2e/fixtures/document-preview/one-page.pdf` prints `%PDF-`.
  - `head -c 2 e2e/fixtures/document-preview/report.docx` prints `PK`.
  - `file e2e/fixtures/document-preview/pixel.png` contains `PNG image data, 1 x 1`.

### Task 3.2 — Dependencies: vendored SheetJS; pdf.js present
- **Goal:** Runtime libraries are installed reproducibly.
- **Target files and symbols:** `vendor/xlsx-0.20.3.tgz`; `package.json` `dependencies`; `bun.lock`.
- **Steps:**
  1. Run `mkdir -p vendor && curl -fsSL -o vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. The URL follows the SheetJS-documented pattern [UNVERIFIED].
  2. Run `bun add ./vendor/xlsx-0.20.3.tgz`. Confirm that `package.json` `dependencies` now has `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`, or the `./`-prefixed form bun writes.
  3. Confirm `pdfjs-dist` is already in `dependencies`. The sibling added it.
- **Success criteria:** A frozen install succeeds, and version 0.20.3 is resolved.
- **Verify:**
  - `tar -xOzf vendor/xlsx-0.20.3.tgz package/package.json | grep -c '"version": "0.20.3"'` prints `1`.
  - `bun install --frozen-lockfile; echo "exit=$?"` ends with `exit=0`.
  - `grep -c '"pdfjs-dist"' package.json` prints `1`.

### Task 3.3 — Red then green: shared pdf.js loader
- **Goal:** One pdf.js setup for the card thumbnails and the preview.
- **Target files and symbols:** `src/renderer/lib/pdfjs.ts`: `loadPdfJs`, `pdfDocumentOptions` and `openPdfDocument`. `src/renderer/lib/pdf-thumbnail.ts`: delete its private `loadPdfJs`, its `decodeBase64`, and the `getDocument({…})` call.
- **Steps:**
  1. Write `pdfjs.test.ts` for `pdfDocumentOptions`, exactly as in the matrix. Import only `pdfDocumentOptions`, so pdf.js itself never loads. Run it (red).
  2. Create `pdfjs.ts`.
     - Move `loadPdfJs` verbatim from `pdf-thumbnail.ts` (module worker via `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` and the retry-on-failure reset). Keep its doc comment about the CSP.
     - Add `pdfDocumentOptions(bytes, baseUri)`, which returns the contract object with `new URL("pdfjs/cmaps/", baseUri).href` and `new URL("pdfjs/standard_fonts/", baseUri).href`.
     - Add `openPdfDocument(bytes)`: `const pdfjs = await loadPdfJs(); const task = pdfjs.getDocument(pdfDocumentOptions(bytes, document.baseURI)); return { document: await task.promise, destroy: () => task.destroy() };`.
     - Use only `import type` for pdf.js types at the top level.
  3. In `pdf-thumbnail.ts`, add `import { openPdfDocument } from "./pdfjs";` and `import { decodeBase64 } from "./preview/document-bytes";`. Replace the `getDocument` and `try/finally` usage in `rasterizeFirstPage` with `const { document, destroy } = await openPdfDocument(bytes); try { …same page-1 code… } finally { await destroy(); }`.
- **Success criteria:** The new test passes, and the thumbnail tests stay green.
- **Verify:**
  - `bunx vitest run src/renderer/lib/pdfjs.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after step 3.
  - `bunx vitest run src/renderer/lib/pdf-thumbnail.test.ts src/renderer/components/attachments; echo "exit=$?"` ends with `exit=0`.

### Task 3.4 — Self-hosted pdf.js data and lazy chunks
- **Goal:** pdf.js finds its cmaps and fonts from `'self'`, and the new libraries never land in the entry chunk.
- **Target files and symbols:** `vite.renderer.shared.ts`: a new `function pdfjsAssets(): Plugin`, added to the `plugins: [tailwindcss(), pdfjsAssets()]` array in `rendererConfig`, and two new `VENDOR_CHUNK_RULES` entries. `scripts/check-renderer-chunks.ts`: `LAZY_CHUNKS`.
- **Steps:**
  1. **`pdfjsAssets()`.**
     1. Resolve the package dir with `path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))`.
     2. Set `DIRS = ["cmaps", "standard_fonts"]`.
     3. `generateBundle()`: for each dir and each file in `readdirSync(join(root, dir))`, call `this.emitFile({ type: "asset", fileName: \`pdfjs/${dir}/${file}\`, source: readFileSync(join(root, dir, file)) })`.
     4. `configureServer(server)`: `server.middlewares.use("/pdfjs", (req, res, next) => { … })`. It splits `req.url` into `/<dir>/<file>`, calls `next()` unless `dir` is in `DIRS` and `file` matches `/^[\w.+-]+$/`, and otherwise sets `Content-Type: application/octet-stream` and `res.end(readFileSync(...))`.
     5. Import `Plugin` as a type from `vite`.
  2. Append to `VENDOR_CHUNK_RULES`: `[/[\\/]node_modules[\\/]pdfjs-dist[\\/]/, "pdfjs"]` and `[/[\\/]node_modules[\\/]xlsx[\\/]/, "sheetjs"]`.
  3. Set `LAZY_CHUNKS = ["mermaid", "codemirror", "charts", "highlight", "xterm", "pdfjs", "sheetjs"]`.
- **Success criteria:** The build passes the chunk guard, and the assets are emitted.
- **Verify:**
  - `bun run build; echo "exit=$?"` ends with `exit=0`, and its output contains `index.html entry is lean` and `none of mermaid, codemirror, charts, highlight, xterm, pdfjs, sheetjs`.
  - `ls out/renderer/pdfjs/cmaps | wc -l` prints a number greater than `100`.
  - `ls out/renderer/pdfjs/standard_fonts | grep -c -i "foxit\|liberation"` prints a number greater than `0`.

### Task 3.5 — Red then green: sheet model
- **Goal:** A pure, capped table model shared by xlsx, xls, ods and csv.
- **Target files and symbols:** `sheet-model.ts`: `SHEET_MAX_ROWS = 500`, `SHEET_MAX_COLS = 50`, `interface SheetView { name: string; rows: string[][]; formulaCells: ReadonlySet<string>; totalRows: number; totalCols: number }`, and `workbookToSheets(bytes: Uint8Array, format: "sheet" | "csv"): SheetView[]`.
- **Steps:**
  1. Write `sheet-model.test.ts`, covering the five matrix rows. Read `e2e/fixtures/document-preview/table.xlsx` with `readFileSync`. Build the 600×60 sheet, the biff8 file and the ods file with `XLSX.utils.aoa_to_sheet` and `XLSX.write(wb, { bookType, type: "array" })`. Run it (red).
  2. Implement `workbookToSheets`:
     1. Read the workbook. For `csv`: `read(new TextDecoder().decode(bytes), { type: "string", dense: true })`. For `sheet`: `read(bytes, { type: "array", dense: true, cellDates: true, cellNF: true })`.
     2. Skip sheets whose `wb.Workbook?.Sheets?.[i]?.Hidden` is truthy.
     3. For each remaining sheet, decode `!ref` with `utils.decode_range`. Set `totalRows = e.r - s.r + 1` and `totalCols = e.c - s.c + 1`.
     4. Build `rows` for the first `min(totalRows, 500)` rows and the first `min(totalCols, 50)` columns. Each cell's text is `cell.w ?? (cell.v !== undefined ? String(cell.v) : cell.f ? \`=${cell.f}\` : "")`, and a formula with no value adds `"r:c"` to `formulaCells`.
     5. Trim trailing empty columns from every row, so that `rows[0]` is `["Region","Revenue"]`.
- **Success criteria:** All five cases pass.
- **Verify:** `bunx vitest run src/renderer/lib/preview/sheet-model.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after it.

### Task 3.6 — PdfPreview and SheetPreview components, registry and locale keys
- **Goal:** Renderers the shell can lazy-load.
- **Target files and symbols:** `PdfPreview.tsx` (default export), `SheetPreview.tsx` (default export), and `renderers.ts` (`DEFAULT_PREVIEW_RENDERERS`). Add these locale keys to `en.ts` and `vi.ts`:

  | Key | en | vi |
  |---|---|---|
  | `preview.pagesNotShown` | "Pages not shown here: {count}. Open the file to see them." | "Số trang không hiển thị ở đây: {count}. Mở tệp để xem." |
  | `preview.sheetTruncated` | "Showing the first {rows} rows and {cols} columns." | "Đang hiển thị {rows} hàng và {cols} cột đầu tiên." |
  | `preview.sheets` | "Sheets" | "Trang tính" |
  | `preview.formula` | "Formula without a saved value" | "Công thức chưa có giá trị đã lưu" |

- **Steps:**
  1. **`PdfPreview({ bytes, onError })`.**
     - An effect calls `openPdfDocument(bytes)` and sets `pages = Math.min(document.numPages, PDF_MAX_PAGES = 50)`.
     - For `i` from 1 to `pages`, sequentially, it renders `page.render({ canvas, viewport })` into one `<canvas>` per page. The viewport scale is `(container.clientWidth - 24) * devicePixelRatio / page.getViewport({ scale: 1 }).width`, and the CSS width is `100%`.
     - It stops if unmounted (a `cancelled` flag), calls `destroy()` in cleanup, and calls `onError(error)` on any throw.
     - When `numPages > 50`, it shows `t("preview.pagesNotShown", { count: numPages - 50 })`.
     - It renders no text layer and no annotation layer.
  2. **`SheetPreview({ bytes, kind, onError })`.**
     - `useMemo(() => workbookToSheets(bytes, kind === "csv" ? "csv" : "sheet"))` inside a try that calls `onError` on a throw.
     - It renders a `role="tablist"` row with `aria-label={t("preview.sheets")}` and one `<button role="tab" aria-selected>` per sheet.
     - The table is `<table className="border-collapse text-omp-sm">` with `<td>` text cells. Formula cells get `className="text-(--omp-muted)"` and `title={t("preview.formula")}`.
     - When a sheet has more rows or columns than shown, it adds the `preview.sheetTruncated` note.
  3. In `renderers.ts`, set `DEFAULT_PREVIEW_RENDERERS = { pdf: lazy(() => import("./PdfPreview")), sheet: lazy(() => import("./SheetPreview")) }`.
- **Success criteria:** The types compile, the build stays lean, and every test stays green.
- **Verify:**
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.
  - `bunx vitest run; echo "exit=$?"` ends with `exit=0`.
  - `bun run build` output contains `none of mermaid, codemirror, charts, highlight, xterm, pdfjs, sheetjs`.

### Task 3.7 — Commit
- **Goal:** One revertable commit.
- **Target files and symbols:** this phase's files.
- **Steps:**
  1. Run biome on the touched `.ts` and `.tsx` files, plus `vite.renderer.shared.ts`, `scripts/check-renderer-chunks.ts` and `scripts/gen-preview-fixtures.ts`.
  2. Run `node scripts/lint-surfaces.mjs`.
  3. Run `git commit -m "feat(preview): show PDF pages and spreadsheet tables beside the chat"`.
- **Success criteria:** The commit exists.
- **Verify:**
  - Biome exits 0.
  - lint-surfaces exits 0.
  - `git log -1 --format=%s` matches the message.

## Verification

- `bunx vitest run` exits 0.
- `bun run check:types` exits 0.
- `bun run build` exits 0 and its output lists `pdfjs, sheetjs` as lazy.
- `bun install --frozen-lockfile` exits 0.

## Risks & Rollback

- **The SheetJS reading of a formula without a cached value is [UNVERIFIED].** If the formula case fails, apply the Failure Protocol; do not weaken the assertion.
- **The `file://` fetch of the cmaps in Electron is [UNVERIFIED].** The fixture PDF needs neither cmaps nor standard fonts, so its render is unaffected (see plan.md Unresolved question 4).
- **Rollback:** `git revert <phase commit>`. The shell then shows "not available" for pdf and sheet kinds, and `pdf-thumbnail.ts` returns to its private loader.

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

=== FILE: phase-04-docx-and-pptx-renderers.md ===
---
phase: 4
title: "DOCX and PPTX renderers"
status: pending
priority: P1
effort: "4h"
dependencies: [3]
---
# Phase 4: DOCX and PPTX renderers

## Goal

Render .docx with docx-preview and .pptx with `@aiden0z/pptx-renderer`, each
inside an open shadow root. The hardened options are pinned by tests, and every
link inside a document goes through one allowlisted opener. Both libraries load
lazily.

## Files to Create / Modify

- **Create:**
  - `src/renderer/lib/preview/safe-links.ts`, `src/renderer/lib/preview/safe-links.test.ts`
  - `src/renderer/components/preview/shadow-mount.ts`
  - `src/renderer/components/preview/office-render-options.ts`, `src/renderer/components/preview/office-render-options.test.ts`
  - `src/renderer/components/preview/DocxPreview.tsx`
  - `src/renderer/components/preview/PptxPreview.tsx`
- **Modify:**
  - `src/renderer/components/preview/renderers.ts`
  - `vite.renderer.shared.ts`: `VENDOR_CHUNK_RULES`
  - `scripts/check-renderer-chunks.ts`: `LAZY_CHUNKS`
  - `package.json`, `bun.lock`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `safeExternalHref` keeps `https://example.com/a`, `http://x.y`, `mailto:a@b.c` | `safe-links.test.ts` | exit 1 | pass |
| `safeExternalHref` returns null for `javascript:alert(1)`, `file:///etc/passwd`, `data:text/html,x`, `vbscript:x`, `#frag`, `relative/path` and `` | same | exit 1 | pass |
| `routeDocumentLinkClicks`: a click on an `https` anchor is `defaultPrevented` and `open` is called once with its href | same | exit 1 | pass |
| A click on a `javascript:` anchor, or a nested `<span>` inside a `file:` anchor, is `defaultPrevented` and `open` is not called | same | exit 1 | pass |
| `auxclick` on an `https` anchor is also routed and prevented | same | exit 1 | pass |
| The returned disposer removes the listeners (a later click is not prevented) | same | exit 1 | pass |
| `DOCX_RENDER_OPTIONS` has `renderAltChunks: false`, `useBase64URL: true`, `inWrapper: true` and `className: "docx"` | `office-render-options.test.ts` | exit 1 | pass |
| `pptxViewerOptions(limits)` has `pdfjs: false`, `lazySlides: true`, `lazyMedia: true` and `zipLimits === limits` | same | exit 1 | pass |
| The build keeps the `docx`, `pptx` and `jszip` chunks lazy | `bun run build` | rule missing | pass |

## Tasks

### Task 4.1 — Red then green: link routing
- **Goal:** No document link can navigate the webview, and only web and mail links open, through the system.
- **Target files and symbols:** `safe-links.ts`: `safeExternalHref` and `routeDocumentLinkClicks`.
- **Steps:**
  1. Write the tests with the linkedom harness (`parseHTML`), building anchors with `document.createElement("a")`. Dispatch `new Event("click", { bubbles: true, cancelable: true })` and the same for `"auxclick"`. Run them (red).
  2. Implement `safeExternalHref(href)`: return null when `href.trim()` is empty. Otherwise parse with `new URL(href)` inside a try (relative URLs throw, and that gives null) and return `href` only when `url.protocol` is `http:`, `https:` or `mailto:`.
  3. Implement `routeDocumentLinkClicks(root, open)`:
     1. Define a handler `(event: Event) => { … }`.
     2. In it, set `path = typeof event.composedPath === "function" ? event.composedPath() : []`. When `path` is empty, walk from `event.target` through `parentNode`.
     3. Find the first element whose `tagName` is `"A"` and that has an `href` attribute. If there is none, return.
     4. Call `event.preventDefault()` and `event.stopPropagation()`. Then `const safe = safeExternalHref(anchor.getAttribute("href") ?? "")`, and if it is truthy, call `open(safe)`.
     5. Register it with `root.addEventListener("click", handler, true)` and the same for `"auxclick"`, and return a disposer that removes both.
- **Success criteria:** All the safe-links cases pass.
- **Verify:** `bunx vitest run src/renderer/lib/preview/safe-links.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after step 3.

### Task 4.2 — Install the libraries and confirm their APIs
- **Goal:** Pinned versions, and the option names this plan relies on actually exist.
- **Target files and symbols:** `package.json` `dependencies`; `bun.lock`.
- **Steps:**
  1. Run `bun add docx-preview@0.4.1 @aiden0z/pptx-renderer@1.3.0 --exact`.
  2. Run `grep -rl "renderAltChunks" node_modules/docx-preview/dist | head -1`.
  3. Run `grep -rl "useBase64URL" node_modules/docx-preview/dist | head -1`.
  4. Run `grep -rho "RECOMMENDED_ZIP_LIMITS\|lazySlides\|lazyMedia\|zipLimits\|pdfjs" node_modules/@aiden0z/pptx-renderer/dist/*.d.ts | sort -u`.
  5. Run `grep -rhoE "(static )?(async )?open\(|destroy\(" node_modules/@aiden0z/pptx-renderer/dist/*.d.ts | sort -u`.
  6. Run `ls node_modules/@aiden0z/pptx-renderer/dist | grep -i "\.css$"`, and record the result for Task 4.4.
- **Success criteria:** Both versions are installed exactly, and every grep finds what it looks for.
- **Verify:**
  - `grep -c '"docx-preview": "0.4.1"' package.json` prints `1`.
  - `grep -c '"@aiden0z/pptx-renderer": "1.3.0"' package.json` prints `1`.
  - Steps 2 and 3 each print one path.
  - Step 4 prints all five names: `RECOMMENDED_ZIP_LIMITS`, `lazyMedia`, `lazySlides`, `pdfjs`, `zipLimits`.
  - Step 5 prints at least one `open(` and one `destroy(`.
  - If any name is missing, apply the Failure Protocol.

### Task 4.3 — Red then green: pinned render options and the shadow mount
- **Goal:** The hardening cannot be removed silently.
- **Target files and symbols:** `office-render-options.ts`: `DOCX_RENDER_OPTIONS` and `pptxViewerOptions(zipLimits)`. `shadow-mount.ts`: `useShadowMount(render: (mount: HTMLDivElement, root: ShadowRoot) => Promise<() => void>, deps: unknown[]): RefObject<HTMLDivElement | null>`.
- **Steps:**
  1. Write `office-render-options.test.ts` for the matrix rows. Import only `office-render-options.ts`, which must not import either library at runtime. Run it (red).
  2. Implement `DOCX_RENDER_OPTIONS = { className: "docx", inWrapper: true, breakPages: true, renderAltChunks: false, useBase64URL: true, experimental: false } as const`.
  3. Implement `pptxViewerOptions(zipLimits) => ({ zipLimits, lazySlides: true, lazyMedia: true, listOptions: { windowed: true }, pdfjs: false })`.
  4. Implement `useShadowMount`. It keeps a host `ref`. Its effect:
     1. Gets `root = host.shadowRoot ?? host.attachShadow({ mode: "open" })` and calls `root.replaceChildren()`.
     2. Creates `mount = document.createElement("div")` and appends it.
     3. Calls `const unroute = routeDocumentLinkClicks(root, href => void window.omp.system.openExternal(href))`.
     4. Awaits `render(mount, root)` and keeps the returned disposer.
     5. Cleans up by calling the disposer and `unroute()`, then `root.replaceChildren()`.
     6. Ignores a resolved render after cleanup (a `cancelled` flag).
- **Success criteria:** The options tests pass.
- **Verify:** `bunx vitest run src/renderer/components/preview/office-render-options.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after step 4.

### Task 4.4 — DocxPreview and PptxPreview
- **Goal:** Real renders inside the shadow roots.
- **Target files and symbols:** `DocxPreview.tsx` (default export) and `PptxPreview.tsx` (default export), both `(props: PreviewRendererProps) => ReactElement`.
- **Steps:**
  1. **DocxPreview.**
     1. `useShadowMount(async mount => { const { renderAsync } = await import("docx-preview"); await renderAsync(bytes, mount, mount, DOCX_RENDER_OPTIONS); … }, [bytes])`. Wrap the body in a try/catch that calls `onError`.
     2. After rendering, fit the page to the drawer: `const page = mount.querySelector<HTMLElement>("section.docx"); if (page) mount.style.zoom = String(Math.min(1, (host.clientWidth - 24) / page.offsetWidth));`.
     3. Recompute the zoom with a `ResizeObserver` on the host, and disconnect it in the disposer.
     4. Render `<div ref={hostRef} className="h-full w-full overflow-auto bg-(--omp-code-bg) p-3" data-preview-host="docx" />`.
  2. **PptxPreview.**
     1. `useShadowMount(async mount => { const lib = await import("@aiden0z/pptx-renderer"); const viewer = await lib.PptxViewer.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mount, pptxViewerOptions(lib.RECOMMENDED_ZIP_LIMITS)); return () => viewer.destroy(); }, [bytes])`, with a try/catch that calls `onError`.
     2. If Task 4.2 step 5 showed a different call shape (for example a constructor plus `open`), use the shape from the `.d.ts`. The options object stays exactly `pptxViewerOptions(...)`.
     3. If Task 4.2 step 6 found a CSS file, import it with `?inline`. Then, inside the render callback before opening, run `const style = document.createElement("style"); style.textContent = css; root.prepend(style);`.
     4. Render `<div … data-preview-host="pptx" />`.
  3. Update `renderers.ts` to add `docx: lazy(() => import("./DocxPreview"))` and `pptx: lazy(() => import("./PptxPreview"))`.
- **Success criteria:** The types compile, and no unit test regresses. The real render is verified in Phase 6.
- **Verify:**
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.
  - `bunx vitest run; echo "exit=$?"` ends with `exit=0`.

### Task 4.5 — Lazy chunks for docx, pptx and jszip
- **Goal:** These libraries stay out of the entry chunk.
- **Target files and symbols:** `VENDOR_CHUNK_RULES` and `LAZY_CHUNKS`.
- **Steps:**
  1. Append these rules to `VENDOR_CHUNK_RULES`, before the `xterm` rule's comment or at the end of the array:
     - `[/[\\/]node_modules[\\/]docx-preview[\\/]/, "docx"]`
     - `[/[\\/]node_modules[\\/](@aiden0z[\\/]pptx-renderer|echarts|zrender)[\\/]/, "pptx"]`
     - `[/[\\/]node_modules[\\/](jszip|pako)[\\/]/, "jszip"]`
  2. Add `"docx", "pptx", "jszip"` to `LAZY_CHUNKS`.
  3. Run the build.
- **Success criteria:** The chunk guard passes with all the lazy names.
- **Verify:** `bun run build; echo "exit=$?"` ends with `exit=0`, and its output contains `none of mermaid, codemirror, charts, highlight, xterm, pdfjs, sheetjs, docx, pptx, jszip`.

### Task 4.6 — Commit
- **Goal:** One revertable commit.
- **Target files and symbols:** this phase's files.
- **Steps:**
  1. Run biome on the touched files.
  2. Run `node scripts/lint-surfaces.mjs`.
  3. Run `git commit -m "feat(preview): show Word documents and slide decks beside the chat"`.
- **Success criteria:** The commit exists.
- **Verify:**
  - Biome exits 0.
  - lint-surfaces exits 0.
  - `git log -1 --format=%s` matches the message.

## Verification

- `bunx vitest run` exits 0.
- `bun run check:types` exits 0.
- `bun run build` exits 0 with the ten lazy chunk names listed.
- `git diff <plan-start-commit> -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json` prints nothing.

## Risks & Rollback

- **A transitive dependency such as `tslib` or `lodash` lands in the `pptx` chunk and is also used eagerly**, so the entry imports `pptx`. The chunk guard names the file. Remove that package from the rule; do not add it to the rule.
- **docx-preview renders too wide for a narrow drawer.** The CSS `zoom` fit handles it, and it is checked in the Phase 6 e2e.
- **Rollback:** `git revert <phase commit>`. Docx and pptx then show "not available" with **Open in its app**.

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
dependencies: [4]
---
# Phase 5: Entry points

## Goal

The user can open a preview from:

- the office output card;
- the Write tool card;
- a model markdown link to a local document;
- attachment cards, both in the composer and in the sent user bubble.

All of them call `useUiStore.getState().openFilePreview(path)`
(`src/renderer/stores/ui.ts:191`).

## Files to Create / Modify

- **Modify:**
  - `src/renderer/components/tools/OfficeFileRenderer.tsx` and `OfficeFileRenderer.test.tsx`
  - `src/renderer/components/tools/WriteRenderer.tsx` and `WriteRenderer.test.tsx`
  - `src/renderer/components/attachments/AttachmentCard.tsx` and `AttachmentCard.test.tsx`
  - every non-test file that renders `<AttachmentCard`. Per the sibling plan's phase 4 these are `src/renderer/components/layout/InputArea.tsx` and `src/renderer/components/chat/MessageBubble.tsx`; Task 5.3 confirms them.
  - `src/renderer/components/layout/PanelContainer.test.tsx` (a markdown docx-link case)
  - `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| A successful report card shows a **Preview** button; clicking it sets `filePreviewPath === REPORT`, `panelVisible === true` and `panelTab === "files"`, and does not call `openPath` | `OfficeFileRenderer.test.tsx` | no button → exit 1 | pass |
| An error or partial office card shows no **Preview** button (it falls back to `GenericRenderer`) | same | passes before (regression) | pass |
| A finished Write card has a button with aria-label `Preview notes.md`; clicking it sets `filePreviewPath` to `details.resolvedPath` when present, otherwise to `args.path` | `WriteRenderer.test.tsx` | exit 1 | pass |
| A partial or error Write card has no preview button | same | exit 1 (the button exists before the guard) | pass |
| `AttachmentCard` with `onOpen` exposes a button labelled `Preview report.pdf`, and a click calls `onOpen` once; without `onOpen` there is no such button; the remove button does not call `onOpen` | `AttachmentCard.test.tsx` | exit 1 | pass |
| A markdown link `[r](file:///home/u/Documents/Sai%20ATLAS/r.docx)` opens the drawer with `filePreviewPath === "/home/u/Documents/Sai ATLAS/r.docx"` and calls `fs.readDocument` | `PanelContainer.test.tsx` | fails (`readDocument` not called) only if Phase 2 regressed; otherwise green (a guard test) | pass |

## Tasks

### Task 5.1 — Locale keys
- **Goal:** The labels exist in both languages.
- **Target files and symbols:** `en.ts` and `vi.ts`, next to the `preview.*` keys from Phase 2.

  | Key | en | vi |
  |---|---|---|
  | `preview.openButton` | "Preview" | "Xem trước" |
  | `preview.open` | "Preview {name}" | "Xem trước {name}" |

- **Steps:** Add the 2 keys to both files.
- **Success criteria:** Locale parity holds.
- **Verify:** `bunx vitest run src/renderer/locales; echo "exit=$?"` ends with `exit=0`.

### Task 5.2 — Office card and Write card (red, then green)
- **Goal:** Output files open beside the chat.
- **Target files and symbols:** `OfficeFileRenderer`, inside its button row at about lines 91–98. `WriteRenderer`, after the `<PathLink path={openPath} …>` at about line 88.
- **Steps:**
  1. **Red.** Add the four tool-card cases from the matrix to the two existing test files. Reuse their harnesses and `REPORT`. Reset with `useUiStore.setState({ filePreviewPath: null, panelVisible: false, panelTab: "files" })` in `afterEach`. Run them.
  2. **Green, office card.** Before the **Open** button, add `<button type="button" className={buttonClass} onClick={() => useUiStore.getState().openFilePreview(office.file)}><Eye size={14} aria-hidden />{t("preview.openButton")}</button>`. Import `Eye` from `lucide-react` and `useUiStore` from `../../stores/ui`.
  3. **Green, Write card.** After the `PathLink`, when `!isPartial && !isError && openPath`, render `<button type="button" aria-label={t("preview.open", { name: basename(path) })} title={t("preview.open", { name: basename(path) })} onClick={event => { event.stopPropagation(); useUiStore.getState().openFilePreview(openPath); }} className="shrink-0 rounded-sm p-0.5 text-[var(--omp-dim)] hover:text-[var(--omp-accent)]"><Eye size={12} aria-hidden /></button>`.
- **Success criteria:** All the tool-card cases pass.
- **Verify:** `bunx vitest run src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/WriteRenderer.test.tsx; echo "exit=$?"` ends with `exit=1` after step 1, and with `exit=0` after step 3.

### Task 5.3 — Attachment cards (red, then green)
- **Goal:** Input files that the user attached open beside the chat.
- **Target files and symbols:** `AttachmentCardProps.onOpen?: () => void` in `AttachmentCard.tsx`, and the call sites.
- **Steps:**
  1. Run `grep -rln "<AttachmentCard" src/renderer --include=*.tsx | grep -v "\.test\.tsx$" | sort`. The expected output is exactly the two lines `src/renderer/components/chat/MessageBubble.tsx` and `src/renderer/components/layout/InputArea.tsx`. Any other output triggers the Failure Protocol, because it means the sibling plan's integration differs.
  2. **Red.** Add the three `AttachmentCard` cases to `AttachmentCard.test.tsx` and run them.
  3. **Green.** When `onOpen` is set, wrap the preview `div` and the `figcaption` in `<button type="button" onClick={onOpen} aria-label={t("preview.open", { name })} className="flex min-h-0 w-full flex-1 flex-col text-left">…</button>`. Without `onOpen`, keep today's markup. The remove button stays outside the wrapper.
  4. At each call site from step 1, pass `onOpen={path ? () => useUiStore.getState().openFilePreview(path) : undefined}`, where `path` is the card's `path` prop expression already passed at that site.
- **Success criteria:** The card tests pass, and the full suite stays green.
- **Verify:**
  - Step 1 prints exactly the two expected lines.
  - `bunx vitest run src/renderer/components/attachments; echo "exit=$?"` ends with `exit=1` after step 2, and with `exit=0` after step 4.
  - `bunx vitest run; echo "exit=$?"` ends with `exit=0`.

### Task 5.4 — Markdown link guard test
- **Goal:** Lock in the existing markdown route for documents.
- **Target files and symbols:** `PanelContainer.test.tsx`, a new `it("opens a local Word document link in the side-by-side preview", …)`, reusing `FileLinkHarness`.
- **Steps:**
  1. Mock `fs.readDocument` as `vi.fn(async () => ({ ok: false, size: 0, mtimeMs: 0, error: "unsupported" }))`.
  2. Mount `<FileLinkHarness content="[r](file:///home/u/Documents/Sai%20ATLAS/r.docx)" />` and click the link.
  3. Expect `filePreviewPath === "/home/u/Documents/Sai ATLAS/r.docx"` and that `readDocument` was called with `"/home/u/Documents/Sai ATLAS/r.docx"` as its first argument.
- **Success criteria:** The test passes.
- **Verify:** `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=0`.

### Task 5.5 — Gate and commit
- **Goal:** One revertable commit.
- **Target files and symbols:** this phase's files.
- **Steps:**
  1. Run `bun run check:types`.
  2. Run biome on the touched files.
  3. Run `node scripts/lint-surfaces.mjs`.
  4. Run `git commit -m "feat(preview): open files beside the chat from tool cards and attachments"`.
- **Success criteria:** The commit exists.
- **Verify:**
  - All three commands in steps 1–3 exit 0.
  - `git log -1 --format=%s` matches the message.

## Verification

- `bunx vitest run` exits 0.
- `bun run check:types` exits 0.

## Risks & Rollback

- **The sibling plan's card call sites differ from its plan.** Task 5.3 step 1 stops the phase.
- **A button nested inside a `<figure role="listitem">`:** the remove button stays a sibling, never nested inside the open button.
- **Rollback:** `git revert <phase commit>`. The previews stay reachable from the Files panel and from markdown links.

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

=== FILE: phase-06-e2e-and-docs.md ===
---
phase: 6
title: "End-to-end in both shells and docs"
status: pending
priority: P1
effort: "4h"
dependencies: [5]
---
# Phase 6: End-to-end in both shells and docs

## Goal

Prove that the real renders, the docking, the refresh and the CSP behave
correctly in the Tauri shell (WebKitGTK, embedded assets, real CSP) and in the
Electron shell (Chromium, `file://`), using twin specs that `check-twins.ts`
accepts. Record the feature in the changelog.

## Files to Create / Modify

- Create: `e2e-tauri/document-preview.e2e.ts`, `e2e/document-preview.e2e.ts`
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section)

## Test Matrix (TDD)

The same test titles appear in both specs. The product code already exists,
so the red state of this phase is the twin gate: while only the Tauri spec
exists, `bun e2e-tauri/check-twins.ts` must exit 1 and name
`document-preview.e2e.ts`. Writing the Electron twin turns it green. The
behavioural red states for every render path were already asserted by the unit
tests in Phases 2–5.

| Case (title) | Tauri spec | Electron spec | Red | Green |
|---|---|---|---|---|
| `previews office files, PDFs, sheets and images beside the chat` | yes | yes | `bun e2e-tauri/check-twins.ts` exit 1 while only one twin exists | the spec passes |
| `keeps the preview docked in a narrow window` | yes | yes | same | pass |
| `shows a way out for a file that is not what its name says` | yes | yes | same | pass |
| `refreshes the preview when the file changes on disk` | yes | yes | same | pass |

## Tasks

### Task 6.1 — Tauri spec
- **Goal:** Real renders under the real CSP on WebKitGTK.
- **Target files and symbols:** `e2e-tauri/document-preview.e2e.ts`. It uses `launch`, `awaitBridge`, `collectPageErrors`, `pageErrors`, `until` and `lastExactText` from `./session` (`e2e-tauri/session.ts:178,225,465,480,430,374`).
- **Steps:**
  1. Inside `describe("document preview", …)`, every `it` starts with:
     ```ts
     await launch({
       name: "document-preview",
       setup: async l => {
         for (const f of await fsp.readdir(FIXTURES)) {
           await fsp.copyFile(path.join(FIXTURES, f), path.join(l.project, f));
         }
       },
     });
     ```
     where `FIXTURES = path.resolve(import.meta.dirname, "../e2e/fixtures/document-preview")`. Then call `await awaitBridge(browser); await collectPageErrors(browser); await browser.setWindowSize(1440, 900);`.
  2. A helper `openFromTree(name)`:
     1. If `$('aside.omp-inspector')` is not displayed, click `$('button[title="Open workspace"]')`.
     2. If the preview is open, click `$('button[aria-label="Back to files"]')`.
     3. Click the `[role="treeitem"]` whose text is exactly `name`, using `lastExactText(name, "aside")`.
     4. Wait until `[data-preview-state]` is not `loading`.
  3. A helper `shadowCount(selector)`: `browser.execute(sel => document.querySelector("[data-preview-host]")?.shadowRoot?.querySelectorAll(sel).length ?? 0, selector)`.
  4. **`previews office files, PDFs, sheets and images beside the chat`:**
     1. Register a CSP listener: `browser.execute(() => { (window as never as { __csp: string[] }).__csp = []; document.addEventListener("securitypolicyviolation", e => (window as never as { __csp: string[] }).__csp.push(e.effectiveDirective)); })`.
     2. `openFromTree("report.docx")`, then expect `await until(() => shadowCount("section.docx"), n => n >= 1)` to be at least 1.
     3. `deck.pptx`: expect `[data-preview-state]` to equal `rich`, and `shadowCount("*")` to be greater than 0 within 15000 ms.
     4. `table.xlsx`: expect a `td` with exact text `Region`, tab buttons `Sales` and `Notes`, and no tab `Hidden`.
     5. `table.csv`: expect a `td` `North`.
     6. `one-page.pdf`: expect a `canvas` with `width > 0`.
     7. `pixel.png`: expect an `img` inside `[data-preview-kind="image"]` with `naturalWidth === 1`.
     8. Layout checks, in the page:
        - `getComputedStyle(aside).position !== "absolute"`;
        - `aside.getBoundingClientRect().width >= 0.4 * innerWidth - 1`;
        - `document.querySelector("main").getBoundingClientRect().width >= 400`;
        - `document.querySelector("textarea").disabled === false`.
     9. Finally, expect `__csp` to equal `[]` and `await pageErrors(browser)` to equal `[]`.
  5. **`keeps the preview docked in a narrow window`:** `openFromTree("table.csv")`, then `browser.setWindowSize(900, 700)`. Then expect:
     - `getComputedStyle(aside).position !== "absolute"`;
     - `Math.abs(aside.getBoundingClientRect().width - Math.round(innerWidth * 0.5)) <= 1`;
     - the `td` `North` is still displayed;
     - `browser.execute(() => !document.querySelector("nav, aside.omp-sidebar"))`. Before writing this assertion, confirm the sidebar root selector with `grep -n "className=" src/renderer/components/layout/Sidebar.tsx | head -3`, and use that root element's distinguishing class.
  6. **`shows a way out for a file that is not what its name says`:** `openFromTree("not-a-docx.docx")`, then expect `[data-preview-state="error"]` and a `button` whose text is `Open in its app`.
  7. **`refreshes the preview when the file changes on disk`:** `openFromTree("table.csv")`, then `fsp.writeFile(path.join(launch.project, "table.csv"), "Region,Revenue\nWest,77\n")`. Expect `await until(() => exactTextCount("West", "[data-preview-kind]"), n => n >= 1, 6000)` to be at least 1.
- **Success criteria:** All four tests pass on the virtual display.
- **Verify:** `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` ends with `exit=0`. Passing `--spec` through `bun run` is [UNVERIFIED]. If wdio ignores it, the same command with `bunx wdio run wdio.conf.ts --spec e2e-tauri/document-preview.e2e.ts` must end with `exit=0`.

### Task 6.2 — Electron twin (red twin check, then green)
- **Goal:** The same behaviour on Chromium with `file://` loading.
- **Target files and symbols:** `e2e/document-preview.e2e.ts`. It uses the Playwright launch pattern of `e2e/runtime.e2e.ts:8-31` (a temp profile, `writeDesktopPrefs`, `OMP_BUNDLED_OMP` set to `e2e/sidecar-fixture.ts`, and `electron.launch({ args: [out/main/index.js, project, --user-data-dir=…] })`).
- **Steps:**
  1. **Red.** Run `bun e2e-tauri/check-twins.ts; echo "exit=$?"` while only the Tauri spec exists.
  2. **Green.** Write the four `test(...)` blocks with the exact same titles and at least as many `expect(` calls as each Tauri test:
     1. Copy the fixtures into `project` before launch.
     2. Resize with `app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))`, and later `setSize(900, 700)`.
     3. Use `page.locator(...)` and `page.evaluate(...)` for the same DOM and shadow-root checks.
     4. Collect `pageerror` into `errors`.
     5. Close the app in `finally`.
  3. Run `bun run build` first, because the spec launches `out/main/index.js`.
- **Success criteria:** The twin check passes, and the Electron spec passes.
- **Verify:**
  - Step 1 ends with `exit=1`, and its output names `document-preview.e2e.ts`.
  - `bun e2e-tauri/check-twins.ts; echo "exit=$?"` ends with `exit=0`.
  - `bun run build && scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts; echo "exit=$?"` ends with `exit=0`.

### Task 6.3 — Changelog
- **Goal:** User-visible behaviour is documented in the existing owning surface.
- **Target files and symbols:** `CHANGELOG.md`, under `## [Unreleased]`. Add an `### Added` heading if none exists there; otherwise reuse it.
- **Steps:** Add one bullet:
  > - **Preview files beside the chat**: Word documents, slide decks, spreadsheets (xlsx, xls, ods, csv), PDFs and images open in the workspace drawer next to the conversation from the office card's **Preview** button, the Write card, links in answers, the Files panel and attachment cards. Previews are read-only, refresh when the file changes, and offer **Open in its app** for anything they cannot show.
- **Success criteria:** The bullet exists exactly once.
- **Verify:** `grep -c "Preview files beside the chat" CHANGELOG.md` prints `1`.

### Task 6.4 — Full gate, cleanup and commit
- **Goal:** Every acceptance gate passes, and no process is left running.
- **Target files and symbols:** none new.
- **Steps:**
  1. Run each command under plan.md "Validation commands".
  2. Run `git diff <plan-start-commit> -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json src/main/packaging-config.test.ts`.
  3. Run `scripts/virtual-display.sh stop`.
  4. Run `git commit -m "test(preview): render every preview format in both shells"` for the spec files, and `git commit -m "docs(changelog): note the side-by-side file preview"` for the changelog.
- **Success criteria:** All gates pass, the CSP files are unchanged, and the virtual display is stopped.
- **Verify:**
  - Every command in step 1 ends with exit code 0.
  - Step 2 prints nothing.
  - `scripts/virtual-display.sh status` reports that nothing is running.
  - `git log -2 --format=%s` lists both commit messages.

## Verification

- Both e2e specs exit 0.
- `bun e2e-tauri/check-twins.ts` exits 0.
- The full validation list in plan.md exits 0.
- The CSP diff is empty.

## Risks & Rollback

- **The docx or pptx renderers throw on WebKitGTK only.** The spec fails at the first assertion with the page error captured. Apply the Failure Protocol; this is the evidence the research could not produce statically.
- **A `securitypolicyviolation` fires** (for example `font-src` from a document font). The CSP must not be loosened. Report it through the Failure Protocol.
- **The Playwright Electron run needs a display.** It always runs through `scripts/virtual-display.sh run`.
- **Rollback:** revert the test commit and the docs commit. The product code is unaffected.

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
