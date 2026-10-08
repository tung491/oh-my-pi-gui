---
phase: 3
title: "PDF and sheet renderers"
status: completed
priority: P1
effort: "7h"
dependencies: [2]
---
# Phase 3: PDF and sheet renderers

## Goal

Commit realistic fixtures, then add the PDF renderer and the sheet renderer for
xlsx, xls, ods and csv. PDF uses one pdf.js loader shared with the sibling's
`pdf-thumbnail.ts`. Each open document gets **its own worker**, a load timeout
and a cancel handle that works while the document is still loading, so
destroying one document never touches another and a worker that never starts
cannot spin forever. The PDF renderer draws only the pages near the viewport,
caps every canvas's pixel count and frees off-screen canvases. Sheets use
vendored, hash-pinned SheetJS CE with formula cells kept, a row limit applied
during parsing, and the parse moved out of render. Both renderers load lazily
in their own chunks, and pdf.js gets self-hosted cmaps and standard fonts.
<!-- Red team: R1, R5, R7, R10 --> <!-- Validation: spreadsheets -->

## Files to Create / Modify

- **Create:**
  - `scripts/gen-preview-fixtures.ts`
  - `e2e/fixtures/document-preview/{report.docx,deck.pptx,table.xlsx,table.csv,one-page.pdf,cjk.pdf,sixty-pages.pdf,pixel.png,not-a-docx.docx,injected-font.docx,notes.md}` <!-- Red team: R6, R7, K9 -->
  - `vendor/xlsx-0.20.3.tgz`
  - `src/renderer/lib/pdfjs.ts`, `src/renderer/lib/pdfjs.test.ts`
  - `src/renderer/lib/preview/pdf-layout.ts`, `src/renderer/lib/preview/pdf-layout.test.ts` <!-- Red team: R7 -->
  - `src/renderer/lib/preview/sheet-model.ts`, `src/renderer/lib/preview/sheet-model.test.ts`
  - `src/renderer/components/preview/PdfPreview.tsx`
  - `src/renderer/components/preview/SheetPreview.tsx`
- **Modify:**
  - `src/renderer/lib/pdf-thumbnail.ts`: use the shared opener and `decodeBase64`; keep its 20 s draw race (`pdf-thumbnail.ts:141-158`). <!-- Red team: R1 -->
  - `src/renderer/components/preview/renderers.ts`
  - `vite.renderer.shared.ts`: `VENDOR_CHUNK_RULES` (`:20`), plus a new `pdfjsAssets()` plugin in `rendererConfig().plugins` (`:74`).
  - `scripts/check-renderer-chunks.ts`: `LAZY_CHUNKS` (about `:14`).
  - `package.json`, `bun.lock`
  - `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `pdfDocumentOptions` returns `useWasm: false`, `enableXfa: false`, `cMapPacked: true`, `cMapUrl` = `file:///app/out/renderer/pdfjs/cmaps/` and `standardFontDataUrl` = `file:///app/out/renderer/pdfjs/standard_fonts/` for base `file:///app/out/renderer/index.html` | `src/renderer/lib/pdfjs.test.ts` | vitest exit 1 | pass |
| A never-resolving load rejects with a timeout after `timeoutMs`, and destroys its task, its `PDFWorker` and its worker port exactly once <!-- Red team: R1 --> | same (fake pdf.js, fake timers) | exit 1 | pass |
| Two documents open; destroying the first leaves the second's task, `PDFWorker` and port untouched, and each got its own port <!-- Red team: R1 --> | same | exit 1 | pass |
| `destroy()` called before pdf.js has loaded still destroys the task once it is created, and the promise rejects | same | exit 1 | pass |
| pdf.js receives a copy of the bytes: the caller's array keeps its length after the open | same | exit 1 | pass |
| The sibling's thumbnail cache tests stay green after the extraction | `src/renderer/lib/pdf-thumbnail.test.ts` | green before | green after |
| `pdfPageScale`: an A4 page at 816 CSS px and dpr 2 renders at `816 * 2 / 595`; a 14400×14400 page is scaled down to at most 16 777 216 pixels; a 1×14400 page (aspect over 20) returns null <!-- Red team: R7 --> | `pdf-layout.test.ts` | exit 1 | pass |
| `pagesNear(new Set([5]), 50)` is `{4,5,6}`; `pagesNear(new Set([1]), 1)` is `{1}` (lazy pages) | same | exit 1 | pass |
| `table.xlsx` → sheet names `["Sales","Notes"]` (`Hidden` skipped); `rows[0]` = `["Region","Revenue"]`; `rows[1]` = `["North","120"]`; cell `[4][1]` = `"=SUM(B2:B4)"` and `formulaCells.has("4:1")` <!-- Red team: R10 --> | `sheet-model.test.ts` | exit 1 | pass |
| SheetJS's default read of `table.xlsx` (no `sheetStubs`) has no row 5, which pins why the options are needed | same | passes once SheetJS is installed (a guard test) | pass |
| CSV text `"Region,Revenue\nNorth,120\n"` → rows `[["Region","Revenue"],["North","120"]]` <!-- Red team: R14 --> | same | exit 1 | pass |
| A synthetic 600×60 sheet → 500 rows × 50 columns, `totalRows: 600`, `totalCols: 60`, parsed with `sheetRows` <!-- Red team: R5 --> | same | exit 1 | pass |
| A `.xls` (biff8), an HTML-table `.xls` and an `.ods` written by SheetJS in the test read back the same first row <!-- Red team: K11 --> | same | exit 1 | pass |
| The build keeps the `pdfjs` and `sheetjs` chunks lazy and emits the `pdfjs/cmaps` and `pdfjs/standard_fonts` assets | `bun run build` + `ls` | fails before the rules exist (no chunk name) | pass |

## Tasks

### Task 3.1 — Fixture generator and committed fixtures
<!-- Red team: R6, R7, K9 -->
- **Goal:** Deterministic, realistic inputs for the unit and e2e tests, produced by the repo's own office writers, including a CJK PDF that needs a packed CMap, a 60-page PDF and a docx whose font name tries to inject CSS.
- **Target files and symbols:** `scripts/gen-preview-fixtures.ts`; the `e2e/fixtures/document-preview/*` files.
- **Steps:**
  1. Write the script. With `OUT = path.resolve(import.meta.dirname, "../e2e/fixtures/document-preview")` and `mkdirSync(OUT, { recursive: true })`, it creates the files below. One local `buildPdf(objects: string[]): Buffer` writes the header, the numbered objects, an xref table with offsets from `Buffer.byteLength`, the trailer and `startxref`; all three PDFs use it.

     | File | Content |
     |---|---|
     | `report.docx` | `(await buildReport({ markdown: readFileSync("assistant-pack/test/fixtures/notes-en.md","utf8"), fallbackTitle: "Report", lang: "en" })).bytes`, from `../assistant-pack/src/office/report` (`report.ts:229`) |
     | `deck.pptx` | The same with `buildSlides`, from `../assistant-pack/src/office/slides` (`slides.ts:526`) |
     | `table.xlsx` | Written with `exceljs`: sheet `Sales` with `A1 "Region"`, `B1 "Revenue"`, rows `North 120`, `South 95`, `East 143`, and `B5` = `{ formula: "SUM(B2:B4)" }` with no `result` (exceljs writes `<f>` without `<v>`); sheet `Notes` with `A1 "Prepared by Sai ATLAS"`; sheet `Hidden` with `state = "hidden"` and `A1 "secret"` |
     | `table.csv` | `"Region,Revenue\nNorth,120\nSouth,95\n"` |
     | `one-page.pdf` | Objects: 1 Catalog, 2 Pages, 3 Page (MediaBox 0 0 300 200), 4 content stream `BT /F1 24 Tf 40 100 Td (Preview fixture) Tj ET`, 5 Font Type1 Helvetica |
     | `cjk.pdf` | One page whose font is `<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [<CIDFontType0 with /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> and a FontDescriptor without an embedded font>] >>`, content `BT /F1 24 Tf 40 100 Td <3042> Tj ET`. Rendering it makes pdf.js load `cmaps/UniJIS-UCS2-H.bcmap` (present in `node_modules/pdfjs-dist/cmaps/`). |
     | `sixty-pages.pdf` | 60 Page objects in one Pages node, sharing the `one-page.pdf` content stream and font |
     | `pixel.png` | `Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")` |
     | `not-a-docx.docx` | `"just text, not a document\n"` |
     | `injected-font.docx` | `report.docx` reopened with `jszip` (devDependency; script only). In `word/styles.xml`, set the first `w:ascii` value of a `<w:rFonts …>` to `INJECT = "x;}:host{position:fixed!important;inset:0!important;z-index:2147483647!important;background:red!important}.y{a:b"`, or insert `<w:rFonts w:ascii="INJECT" w:hAnsi="INJECT"/>` after the first `<w:rPr>` when there is none. The script throws if the written `styles.xml` does not contain `INJECT`. |
     | `notes.md` | `"# Fixture notes\n\nPlain markdown.\n"` |

  2. Run `bun scripts/gen-preview-fixtures.ts`.
- **Success criteria:** All 11 files exist, and the PDF, docx and png signatures are right.
- **Verify:**
  - `ls e2e/fixtures/document-preview | wc -l` prints `11`.
  - `head -c 5 e2e/fixtures/document-preview/one-page.pdf e2e/fixtures/document-preview/cjk.pdf e2e/fixtures/document-preview/sixty-pages.pdf | grep -c "%PDF-"` prints `3`.
  - `head -c 2 e2e/fixtures/document-preview/report.docx` prints `PK`.
  - `unzip -p e2e/fixtures/document-preview/injected-font.docx word/styles.xml | grep -c ":host{position:fixed"` prints `1`.
  - `file e2e/fixtures/document-preview/pixel.png` contains `PNG image data, 1 x 1`.

### Task 3.2 — Dependencies: vendored, hash-pinned SheetJS; pdf.js present
<!-- Red team: K5 --> <!-- Validation: spreadsheets -->
- **Goal:** Runtime libraries are installed reproducibly, and the vendored tarball is the exact one the user approved.
- **Target files and symbols:** `vendor/xlsx-0.20.3.tgz`; `package.json` `dependencies`; `bun.lock`.
- **Steps:**
  1. Run `mkdir -p vendor && curl -fsSL -o vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. The URL returned HTTP 200 on 2026-10-07 (verifier).
  2. Run `sha256sum vendor/xlsx-0.20.3.tgz`. It must print `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`. Any other hash: delete the file and apply the Failure Protocol.
  3. Run `bun add ./vendor/xlsx-0.20.3.tgz`. Confirm that `package.json` `dependencies` now has `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`, or the `./`-prefixed form bun writes.
  4. Confirm `pdfjs-dist` is already in `dependencies` (`package.json:73`). The sibling added it.
- **Success criteria:** The hash matches, a frozen install succeeds, and version 0.20.3 is resolved.
- **Verify:**
  - `sha256sum vendor/xlsx-0.20.3.tgz | cut -d" " -f1` prints `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`.
  - `tar -xOzf vendor/xlsx-0.20.3.tgz package/package.json | grep -c '"version": "0.20.3"'` prints `1`.
  - `bun install --frozen-lockfile; echo "exit=$?"` ends with `exit=0`.
  - `grep -c '"pdfjs-dist"' package.json` prints `1`.

### Task 3.3 — Red then green: shared pdf.js loader with one worker per document, a timeout and a cancel handle
<!-- Red team: R1 --> <!-- Validation: pdf.js build -->
- **Goal:** One pdf.js setup for the card thumbnails and the preview, where no document's destroy can break another, a stuck worker always ends in a rejection, and a load can be cancelled before it resolves.
- **Target files and symbols:** `src/renderer/lib/pdfjs.ts`: `loadPdfJs`, `pdfDocumentOptions`, `PDF_OPEN_TIMEOUT_MS = 20_000`, `interface PdfDocumentHandle { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> }`, `createPdfOpener(deps)` and `openPdfDocument(bytes, options?)`. `src/renderer/lib/pdf-thumbnail.ts`: delete its private `loadPdfJs` (`:102-121`), its `decodeBase64` (`:32-37`), and the `getDocument({…})` call (`:143`).
- **Background (verified in `node_modules/pdfjs-dist/build/pdf.mjs`, 6.4.299):** with `GlobalWorkerOptions.workerPort` set, every `getDocument` reuses one cached `PDFWorker` (`PDFWorker.create`, about `:16349-16357`), and each `loadingTask.destroy()` marks it `_pendingDestroy` and destroys it (about `:15557-15575`), which breaks every other open document. A `PDFWorker` built with an explicit `port` never terminates that port itself (`destroy()`, about `:16340-16347`), and a `worker` passed to `getDocument` is not destroyed by the task (`task._worker` is set only when pdf.js created the worker, about `:15458-15463`). pdf.js also transfers the `data` buffer to the worker.
- **Steps:**
  1. **Red.** Write `pdfjs.test.ts`. The options case imports only `pdfDocumentOptions`. The other four cases use `createPdfOpener({ load: async () => fakePdfJs, createPort: () => fakePort() })`, where `fakePdfJs` has a `PDFWorker` class recording `destroy` calls, and a `getDocument(params)` returning `{ promise, destroy: vi.fn(async () => {}) }` with a `promise` the test controls (never-resolving for the timeout case). `fakePort()` returns `{ terminate: vi.fn() }`. Use `vi.useFakeTimers()` and `advanceTimersByTimeAsync(PDF_OPEN_TIMEOUT_MS)`. Run (red).
  2. **Green.** Create `pdfjs.ts`.
     - `loadPdfJs()`: the sibling's lazy `import("pdfjs-dist")` with the retry-on-failure reset, keeping its doc comment about the CSP and `script-src 'self'`, **without** setting the global worker port (write comments about it without the literal `GlobalWorkerOptions.workerPort`, which the Verify grep counts).
     - `pdfDocumentOptions(bytes, baseUri)` returns `{ data: bytes, useWasm: false, enableXfa: false, cMapUrl: new URL("pdfjs/cmaps/", baseUri).href, cMapPacked: true, standardFontDataUrl: new URL("pdfjs/standard_fonts/", baseUri).href }`.
     - `createPdfOpener({ load, createPort })` returns `open(bytes, { timeoutMs = PDF_OPEN_TIMEOUT_MS } = {}): PdfDocumentHandle`, synchronously:
       1. Copy the input once: `const data = bytes.slice()`.
       2. `promise` = `(async () => { const pdfjs = await load(); if (destroyed) throw cancelled; port = createPort(); worker = new pdfjs.PDFWorker({ port }); <!-- Shipped: `PDFWorker.create({ port })`. The 6.4.299 typings forbid `port` in the constructor, and `create` on a fresh port finds no cached worker, so it builds a private one --> task = pdfjs.getDocument({ ...pdfDocumentOptions(data, document.baseURI), worker }); return task.promise; })()`, raced against a timer that rejects with `new Error("The PDF took too long to open")` and calls `destroy()`.
       3. `destroy()` is idempotent (`destroyed` flag, one shared promise): clear the timer, then `await task?.destroy()`, `worker?.destroy()`, `port?.terminate()`, each once. A `destroy()` before `load()` resolves makes step 2 throw and create nothing. <!-- Shipped: `destroy()` waits at most 1 s (`DESTROY_GRACE_MS`) for pdf.js to release the task, then destroys the worker and terminates the port regardless, and never rejects; callers fire it from cleanups without awaiting, and the thumbnail does not await it (`void handle.destroy()`) -->
     - `openPdfDocument = createPdfOpener({ load: loadPdfJs, createPort: () => new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" }) }).open`.
     - Use only `import type` for pdf.js types at the top level.
  3. In `pdf-thumbnail.ts`, add `import { openPdfDocument } from "./pdfjs";` and `import { decodeBase64 } from "./preview/document-bytes";`. `drawFirstPage` takes `Promise<PDFDocumentProxy>` instead of the task. `rasterizeFirstPage` becomes `const handle = openPdfDocument(bytes); …same RENDER_TIMEOUT_MS race over drawFirstPage(handle.promise, pixelWidth)…; finally { clearTimeout(timer); await handle.destroy(); }`. The 20 s bound and its comment stay.
- **Success criteria:** The new tests pass, and the thumbnail tests stay green.
- **Verify:**
  - `bunx vitest run src/renderer/lib/pdfjs.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after step 3.
  - `bunx vitest run src/renderer/lib/pdf-thumbnail.test.ts src/renderer/components/attachments; echo "exit=$?"` ends with `exit=0`.
  - `grep -c "GlobalWorkerOptions.workerPort" src/renderer/lib/pdfjs.ts src/renderer/lib/pdf-thumbnail.ts` prints exactly `src/renderer/lib/pdfjs.ts:0` and `src/renderer/lib/pdf-thumbnail.ts:0`.
  - `grep -c "RENDER_TIMEOUT_MS" src/renderer/lib/pdf-thumbnail.ts` prints a number greater than `1`.

### Task 3.4 — Self-hosted pdf.js data and lazy chunks
- **Goal:** pdf.js finds its cmaps and fonts from `'self'`, and the new libraries never land in the entry chunk.
- **Target files and symbols:** `vite.renderer.shared.ts`: a new `function pdfjsAssets(): Plugin`, added to the `plugins: [tailwindcss(), pdfjsAssets()]` array in `rendererConfig`, and two new `VENDOR_CHUNK_RULES` entries. `scripts/check-renderer-chunks.ts`: `LAZY_CHUNKS`. `vite.tauri.config.ts` spreads `rendererConfig().plugins` (`:27-32`), so both shells get the plugin.
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
  - `ls out/renderer/pdfjs/cmaps | wc -l` prints a number greater than `100`, and `ls out/renderer/pdfjs/cmaps/UniJIS-UCS2-H.bcmap` exits 0.
  - `ls out/renderer/pdfjs/standard_fonts | grep -c -i "foxit\|liberation"` prints a number greater than `0`.

### Task 3.5 — Red then green: sheet model
<!-- Red team: R5, R10, R14, K11 -->
- **Goal:** A pure, capped table model shared by xlsx, xls, ods and csv that keeps formulas without a saved value and never parses more rows than it shows.
- **Target files and symbols:** `sheet-model.ts`: `SHEET_MAX_ROWS = 500`, `SHEET_MAX_COLS = 50`, `interface SheetView { name: string; rows: string[][]; formulaCells: ReadonlySet<string>; totalRows: number; totalCols: number }`, and `workbookToSheets(input: Uint8Array | string): SheetView[]` (a string is CSV text from `fs:read`; bytes are a workbook).
- **Steps:**
  1. Write `sheet-model.test.ts`, covering the matrix rows. Read `e2e/fixtures/document-preview/table.xlsx` with `readFileSync`. Build the 600×60 sheet, the biff8 file, the HTML file (`bookType: "html"`) and the ods file with `XLSX.utils.aoa_to_sheet` and `XLSX.write(wb, { bookType, type: "array" })` (`type: "string"` for html, then `TextEncoder`). Run it (red).
  2. Implement `workbookToSheets`:
     1. Options: `{ dense: true, cellDates: true, cellNF: true, cellFormula: true, sheetStubs: true, sheetRows: SHEET_MAX_ROWS + 1 }` <!-- Shipped: the read also sets `cellHTML: false` -->, plus `type: "string"` for a string and `type: "array"` for bytes. A string is passed to SheetJS as is; bytes are never decoded to text first.
     2. Skip sheets whose `wb.Workbook?.Sheets?.[i]?.Hidden` is truthy.
     3. For each remaining sheet, decode `sheet["!fullref"] ?? sheet["!ref"]` with `utils.decode_range` (`sheetRows` shortens `!ref` and keeps the original range in `!fullref`). Set `totalRows = e.r - s.r + 1` and `totalCols = e.c - s.c + 1`.
     4. Build `rows` for the first `min(totalRows, 500)` rows and the first `min(totalCols, 50)` columns. A cell with `f` and either `t === "z"` or no `v` renders as `` `=${cell.f}` `` and adds `"r:c"` to `formulaCells`; any other cell renders `cell.w ?? (cell.v === undefined ? "" : String(cell.v))`.
     5. Trim trailing empty columns from every row, so that `rows[0]` is `["Region","Revenue"]`.
- **Success criteria:** All the sheet cases pass. If the `!fullref` assumption is wrong, the 600-row case fails; apply the Failure Protocol rather than dropping `sheetRows`.
- **Verify:** `bunx vitest run src/renderer/lib/preview/sheet-model.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after it.

### Task 3.6 — Red then green: PDF layout helpers; PdfPreview and SheetPreview, registry and locale keys
<!-- Red team: R5, R7, R14 --> <!-- Validation: refresh -->
- **Goal:** Renderers the shell can lazy-load, which bound memory and main-thread work and re-render in place when new bytes arrive.
- **Target files and symbols:** `pdf-layout.ts`: `PDF_MAX_PAGES = 50`, `PDF_MAX_CANVAS_PIXELS = 16_777_216`, `PDF_MAX_ASPECT = 20`, `pdfPageScale(size: { width: number; height: number }, cssWidth: number, dpr: number, maxPixels?: number): number | null`, `pagesNear(visible: ReadonlySet<number>, total: number): Set<number>`. `PdfPreview.tsx` (default export), `SheetPreview.tsx` (default export), and `renderers.ts` (`DEFAULT_PREVIEW_RENDERERS`). Add these locale keys to `en.ts` and `vi.ts`:

  | Key | en | vi |
  |---|---|---|
  | `preview.pagesNotShown` | "Pages not shown here: {count}. Open the file to see them." | "Số trang không hiển thị ở đây: {count}. Mở tệp để xem." |
  | `preview.pageSkipped` | "Page {page} is too large to show here." | "Trang {page} quá lớn để hiển thị tại đây." |
  | `preview.sheetTruncated` | "Showing the first {rows} rows and {cols} columns." | "Đang hiển thị {rows} hàng và {cols} cột đầu tiên." |
  | `preview.fileTruncated` | "Only the first 2 MB of this file is shown." | "Chỉ hiển thị 2 MB đầu tiên của tệp này." |
  | `preview.sheets` | "Sheets" | "Trang tính" |
  | `preview.formula` | "Formula without a saved value" | "Công thức chưa có giá trị đã lưu" |

- **Steps:**
  1. **Red.** Write `pdf-layout.test.ts` for the two matrix rows. Run it (red). **Green.** `pdfPageScale` returns null when `max(w/h, h/w) > PDF_MAX_ASPECT`; otherwise `scale = cssWidth * dpr / width`, lowered to `Math.sqrt(maxPixels / (width * height))` when `width * height * scale²` exceeds `maxPixels`. `pagesNear` adds `p - 1`, `p`, `p + 1` for each visible page, within `1..total`.
  2. **`PdfPreview({ content, onError })`** (bytes only).
     - An effect keyed on `content.bytes` calls `const handle = openPdfDocument(content.bytes)`, awaits `handle.promise`, sets `pages = Math.min(document.numPages, PDF_MAX_PAGES)`, and reads each page's scale-1 viewport (`getPage(i)`, `getViewport({ scale: 1 })`) into a list of sizes. A rejection, including the 20 s open timeout, calls `onError`.
     - Each page renders as a placeholder `<div>` with `style={{ aspectRatio: \`${w} / ${h}\` }}` holding a `<canvas>`, so the layout is stable before drawing and the scroll position survives a re-render.
     - One `IntersectionObserver` (root: `null`, `rootMargin: "100% 0px"`) tracks visible pages. For `pagesNear(visible, pages)`, render each page not yet drawn with `page.render({ canvas, viewport: page.getViewport({ scale }) })`, `scale = pdfPageScale(size, container.clientWidth - 24, devicePixelRatio)`; a null scale shows `t("preview.pageSkipped", { page: i })` instead. Pages that leave the set get their render task cancelled and `canvas.width = 0; canvas.height = 0` (as the sibling does, `pdf-thumbnail.ts:135-137`).
     - Cleanup cancels every render task, frees every canvas, disconnects the observer and calls `void handle.destroy()`. A `cancelled` flag drops late results.
     - When `numPages > PDF_MAX_PAGES`, show `t("preview.pagesNotShown", { count: numPages - PDF_MAX_PAGES })`.
     - No text layer and no annotation layer.
  3. **`SheetPreview({ content, onError })`.**
     - An effect keyed on `content` parses after yielding: `const timer = setTimeout(() => { try { const next = workbookToSheets("bytes" in content ? content.bytes : content.text); if (!cancelled) setSheets(next); } catch (error) { if (!cancelled) onError(error); } }, 0);`, cleared on cleanup. Nothing parses during render, and `onError` is never called during render.
     - The selected sheet is kept by name across a refresh, falling back to the first sheet.
     - It renders a `role="tablist"` row with `aria-label={t("preview.sheets")}` and one `<button role="tab" aria-selected>` per sheet.
     - The table is `<table className="border-collapse text-omp-sm">` with `<td>` text cells. Formula cells get `className="text-(--omp-muted)"` and `title={t("preview.formula")}`.
     - When a sheet has more rows or columns than shown, it adds the `preview.sheetTruncated` note. When `"text" in content && content.truncated`, it adds the `preview.fileTruncated` note.
  4. In `renderers.ts`, set `DEFAULT_PREVIEW_RENDERERS = { pdf: lazy(() => import("./PdfPreview")), sheet: lazy(() => import("./SheetPreview")) }`.
- **Success criteria:** The layout tests pass, the types compile, the build stays lean, and every test stays green.
- **Verify:**
  - `bunx vitest run src/renderer/lib/preview/pdf-layout.test.ts; echo "exit=$?"` ends with `exit=1` before the green part of step 1, and with `exit=0` after it.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.
  - `bunx vitest run; echo "exit=$?"` ends with `exit=0`.
  - `grep -c "useMemo" src/renderer/components/preview/SheetPreview.tsx` prints `0`.
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

- **One worker per open PDF.** Each thumbnail and the preview start their own module worker and terminate it on destroy. Many PDF cards mounting at once start that many short-lived workers; the thumbnail loader's in-flight sharing (`pdf-thumbnail.ts:75-93`) keeps it to one per path. Medium × Low.
- **The modern pdf.js build on SAI OS WebKitGTK.** By user decision the modern build is used. It calls `Map.prototype.getOrInsertComputed` (`pdf.mjs:2463`), `Math.sumPrecise` (`pdf.mjs:21673`) and `Uint8Array.fromBase64` (`pdf.mjs:25582`) without a polyfill [UNVERIFIED on WebKitGTK 2.48]. Phase 6 Task 6.4 probes them in the Ubuntu 24.04 container; a failing probe stops the plan through the Failure Protocol and goes back to the user. Switching builds is not an executor decision.
- **Main-thread parsing.** SheetJS parses at most 501 rows per sheet and runs after a yield; docx and sheets above 10 MiB show "too large" (Phase 2). A large sheet can still pause the UI briefly while it parses.
- **The `file://` fetch of cmaps in Electron.** pdf.js loads them with `XMLHttpRequest` for non-http URLs (`fetchData`, `pdf.mjs:1239-1264`). Phase 6 checks it in both shells with `cjk.pdf`.
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
