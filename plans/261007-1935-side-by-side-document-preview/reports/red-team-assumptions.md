# Red team: assumptions and state scope (side-by-side document preview)

Reviewer role: Assumption Destroyer / Scope Auditor. Date 2026-10-07.
These findings exclude the 12 defects already listed in `kongming-261007-ultra-verdict.md`.
Library claims were checked against the real packages: pdfjs-dist 6.4.299 (installed),
docx-preview 0.4.1, @aiden0z/pptx-renderer 1.3.0, and SheetJS 0.20.3 (downloaded to the
scratchpad; the tarball SHA-256 matches `8dc73fc3…99fe8`).

## Finding 1: The shared pdf.js worker port means one document's destroy breaks every other open document, and PDF refresh always fails
- **Severity:** Critical
- **Location:** plan.md D3; Phase 3, Task 3.3 ("one pdf.js setup for the card thumbnails and the preview") and Task 3.6 step 1 (PdfPreview "calls `destroy()` in cleanup"); Phase 2, Task 2.5 (`PanelErrorBoundary key={\`${path}:${version}\`}`).
- **Flaw:** The loader that the plan moves "verbatim" sets one process-wide `GlobalWorkerOptions.workerPort` (`src/renderer/lib/pdf-thumbnail.ts:105-111`). In pdf.js 6.4.299, `getDocument` returns the cached `PDFWorker` for that port and stores it on the task (`node_modules/pdfjs-dist/build/pdf.mjs:15458-15463`, `PDFWorker.create` at `:16349-16357`). Each `loadingTask.destroy()` then:
  - marks that shared worker `_pendingDestroy`, which makes any concurrent `getDocument` throw "PDFWorker.create - the worker is being destroyed" (`:15561-15562`, `:16351-16353`);
  - calls `this._worker.destroy()`, which tears down the shared message handler and drops the port from the cache (`:15573`, `:16339-16346`).

  The plan makes the thumbnails (one task per card) and the preview share that one worker, and destroys per document.
- **Failure scenario:**
  1. **Refresh:** `table.pdf` changes on disk, so `useFileVersion` bumps `version`. The new `PanelErrorBoundary` key unmounts the old PdfPreview, and its cleanup calls `destroy()`, which sets `_pendingDestroy` synchronously. The new PdfPreview's effect runs in the same commit and calls `openPdfDocument`, which throws "worker is being destroyed". `onError` fires, and the preview shows "could not be shown" after every PDF change. This breaks "A preview refreshes by itself when the file changes on disk" for PDFs. Acceptance criterion 6 only refreshes a CSV, so no gate catches it.
  2. **Concurrency:** The user previews a 40-page PDF and drops a PDF into the composer. When the thumbnail's `finally { await task.destroy() }` runs, it destroys the shared `PDFWorker` while the preview is still rendering pages. The remaining `getPage`/`render` calls hang or reject.
  3. **Detached bytes:** pdf.js transfers `data.buffer` to the worker (`pdf.mjs:8595-8596`, `:15508`). The `bytes` that DocumentPreview keeps in state are therefore detached (length 0) after the first open. Any re-run of the PdfPreview effect with the same props (for example re-rendering at a new drawer width) feeds pdf.js an empty buffer.
- **Evidence:** pdf.mjs lines above; `pdf-thumbnail.ts:108` `module.GlobalWorkerOptions.workerPort ??= new Worker(…)`; plan Phase 3 Task 3.3 step 2 "Move `loadPdfJs` verbatim".
- **Suggested fix:** Do not destroy loading tasks on a shared port. Either:
  - create one `PDFWorker` per document (`new pdfjs.PDFWorker()` with `workerSrc`, passed as `worker:` and destroyed with the task); or
  - keep one long-lived worker passed explicitly as `params.worker`, and call `document.destroy()` (never `loadingTask.destroy()`), awaiting the previous destroy before opening.

  Pass `bytes.slice()` to pdf.js. Add a PDF refresh case to the e2e (rewrite `one-page.pdf`) and a unit case that opens two documents and destroys one.

## Finding 2: Extracting the loader silently removes the thumbnail's 20 s timeout, and the preview has none
- **Severity:** High
- **Location:** Phase 3, Task 3.3 step 3 ("Replace the `getDocument` and `try/finally` usage in `rasterizeFirstPage` with `const { document, destroy } = await openPdfDocument(bytes); try { … } finally { await destroy(); }`"); Task 3.6 step 1 (PdfPreview).
- **Flaw:**
  - The sibling deliberately races the draw against `RENDER_TIMEOUT_MS = 20_000`, because "a worker that never starts leaves pdf.js waiting forever" (`src/renderer/lib/pdf-thumbnail.ts:18`, `:141-158`). The plan's replacement awaits `task.promise` inside `openPdfDocument` before any timeout exists, which deletes that bound.
  - PdfPreview is specified without any timeout.
  - The worker is created once with `??=` and never reset (`:108`), so a worker that died (an OOM on a big PDF, or a CSP or worker-load failure in one shell) stays installed for the life of the window.
- **Failure scenario:**
  - The worker fails to start under WebKitGTK, or crashes on a malformed PDF. Every later thumbnail and every PDF preview then spins forever.
  - The thumbnail loader's `pending` map keeps the never-settling promise (`pdf-thumbnail.ts:75-92`), so that path is never retried until the window reloads.
  - The plan's gate cannot see the regression. The thumbnail tests inject a fake `rasterize` through `createPdfThumbnailLoader` (`src/renderer/lib/pdf-thumbnail.test.ts:48-145`), so "the sibling's thumbnail cache tests stay green" holds while the real path has lost its timeout.
- **Evidence:** `pdf-thumbnail.ts:144` comment "A worker that never starts leaves pdf.js waiting forever; bound it"; plan Task 3.3 step 3 text; test file only constructs `createPdfThumbnailLoader` with stub sources.
- **Suggested fix:** Put the timeout inside the shared `openPdfDocument` (reject and destroy after N seconds). On a timeout or worker error, reset the cached loader and port. Give PdfPreview the same bound.

## Finding 3: SheetJS drops formula cells that have no cached value, so the planned test fails and real agent spreadsheets show blanks
- **Severity:** High
- **Location:** Phase 3, Task 3.1 (`table.xlsx` B5 `{ formula: "SUM(B2:B4)" }` with no result); Task 3.5 (read options `{ type: "array", dense: true, cellDates: true, cellNF: true }` and the cell-text rule `cell.w ?? (cell.v !== undefined ? String(cell.v) : cell.f ? \`=${cell.f}\` : "")`); Test Matrix row "cell `[4][1]` = `"=SUM(B2:B4)"`".
- **Flaw:** The plan marks this [UNVERIFIED]. It is verifiable, and it is wrong in both read modes.
  - The exceljs writer that the plan uses emits `<row r="5"><c r="B5"><f>SUM(B2:B4)</f></c></row>`, with no `<v>`.
  - With the plan's options, SheetJS 0.20.3 returns `!ref = "A1:B5"`, but `!data` has only 4 rows. The B5 cell does not exist at all.
  - With `sheetStubs: true`, the cell is `{"t":"z","f":"SUM(B2:B4)","v":0}`. The plan's rule then yields `"0"` (because `v` is defined), and `formulaCells` never records it.
- **Failure scenario:**
  - Task 3.5's green step cannot pass, and the Failure Protocol stops Phase 3.
  - If an executor "fixes" this by dropping the assertion, every formula in a spreadsheet written by openpyxl or exceljs shows as an empty cell or as `0`. That covers what LLM agents typically generate. A total of `0` is misleading data in a read-only preview.
- **Evidence:** A scratchpad run of exceljs 4.4.0 (repo devDependency, `package.json:104`) plus SheetJS 0.20.3. Default options give `!data[4]` = undefined. With `sheetStubs: true`, `!data[4]` = `[null,{"t":"z","f":"SUM(B2:B4)","v":0}]`.
- **Suggested fix:** Read with `sheetStubs: true, cellFormula: true`. Treat `t === "z"`, or a cell that has `f` but no `<v>`, as a formula without a value, rendered as `=${f}` and added to `formulaCells`. Test both the default and the stub reads against the committed fixture.

## Finding 4: Opening a preview permanently widens the drawer for every window and every later session
- **Severity:** High
- **Location:** Phase 2, Task 2.7 step 2.4 (the widen effect `setWidth(current => Math.max(current, target))`); plan.md D1 ("Entering the preview widens the drawer to `max(current, 40 % of the window)`").
- **Flaw:**
  - `width` is not preview-scoped state. `PanelContainer` debounces every `width` change into the app-global pref `gui.panelWidth` (`src/renderer/components/layout/PanelContainer.tsx:16`, `:88-94`) and restores it at mount (`:62-86`).
  - The widen effect writes that same state and has no restore on close.
  - The plan adds a preview-only geometry but stores it in the user's persisted, cross-window drawer width. The widen is also not undone when the preview closes (`closeFilePreview` only nulls the path, `src/renderer/stores/ui.ts:192`).
- **Failure scenario:**
  1. At 1440 px the user previews one file. The drawer goes from 403 px to 576 px, and `gui.panelWidth = 576` is saved.
  2. After Back, the Files tree and the Logs tab stay 576 px wide in this window.
  3. Every other window and every restart reads 576 px too.
  4. In a split workspace without a preview, the drawer is still an overlay (`PanelContainer.tsx:127`, kept by Task 2.7). It now covers 576 px of the chat instead of 403 px.
- **Evidence:** `PanelContainer.tsx:88-94` `void window.omp.prefs.set(PANEL_WIDTH_PREF, Math.round(width))`; plan Task 2.7 step 2.4.
- **Suggested fix:** Keep the user's width as the persisted value. Derive the docked width while previewing (`previewing ? Math.max(width, target) : width`) without calling `setWidth`, or hold a separate non-persisted preview width that resets on `closeFilePreview`. Add a test that `prefs.set` is not called with the widened value.

## Finding 5: A synchronous 32 MiB read in the Tauri handler blocks every other IPC call for that window, and the 2 s stat poll extends the stall
- **Severity:** High
- **Location:** Phase 1, Task 1.5 step 4.7 (`Reply::ok(read_document_file(&abs, stat_only, FS_DOCUMENT_MAX_BYTES))`); plan.md D9 (2000 ms stat poll); Risks row "The 2 s poll … Low × Low".
- **Flaw:**
  - The Tauri bridge admits one call per window at a time, in `seq` order: "One drainer per window at a time, so a handler's synchronous work always finishes before the next call starts" (`src-tauri/src/bridge.rs:606-609`).
  - `run_call` executes a `Reply::Ready` handler inline (`bridge.rs:699-713`). Only `Reply::Later` futures run off the drain (`:715-723`; see `editor_open_external`, `src-tauri/src/services/ipc.rs:568-585`).
  - The plan's handler reads up to 32 MiB, base64-encodes it to about 43 MB and builds a JSON value, all synchronously in the drain.
- **Failure scenario:**
  - The user opens a 30 MB deck while a turn is streaming. Every queued call from that window waits behind the read and encode: `rpc` prompt, abort, `prefs`, and the poll itself.
  - On SAI OS, files under GVFS/FUSE or NFS mounts (`/run/user/<uid>/gvfs/…`, a mounted share) can take seconds per `stat`. The poll then puts a multi-second blocking call into the window's queue every 2 s for as long as the drawer stays open. Clicking Stop or sending a message lags by that much.
  - Acceptance criterion 1 only checks that the textarea is enabled, which never detects this.
- **Evidence:** bridge.rs lines above; plan Task 1.5 step 4.7; `fs_read_pdf` (`ipc.rs:527-531`) has the same shape, but the thumbnail calls it once per card, not on a timer.
- **Suggested fix:** Return `Reply::Later(Box::pin(async move { tokio::task::spawn_blocking(…) }))` for both full and `statOnly` reads, and add a Rust test that the next call is admitted while a read is pending. This mirrors `later_futures_do_not_block_the_next_admission` (`bridge.rs:1264`).

## Finding 6: The pptx API check greps a path that does not exist in 1.3.0, so Phase 4 stops on a correct install
- **Severity:** High
- **Location:** Phase 4, Task 4.2 steps 4–6 (`grep … node_modules/@aiden0z/pptx-renderer/dist/*.d.ts`, `ls …/dist | grep -i "\.css$"`) and Verify ("Step 4 prints all five names", "Step 5 prints at least one `open(`").
- **Flaw:** The 1.3.0 tarball has no `.d.ts` directly in `dist/`. Its `package.json` declares `"types": "./dist/types/index.d.ts"`, and the declarations live under `dist/types/**` (`core/Viewer.d.ts`, `parser/ZipParser.d.ts`).
  - `dist/*.d.ts` does not match. Grep reports "No such file" and prints nothing, so both Verify lines fail and the Failure Protocol stops the phase, even though every symbol exists.
  - Run recursively on `dist/types`, the names are all present: `RECOMMENDED_ZIP_LIMITS`, `lazySlides`, `lazyMedia`, `zipLimits`, `pdfjs`, and `static open(input, container, options)` in `core/Viewer.d.ts:164`.
  - There is no CSS file, so step 6 is a no-op.
- **Evidence:** Unpacked `pptx-renderer-1.3.0.tgz`: `ls dist` shows `types/` plus three `.js`/`.cjs` bundles; `ls dist/*.d.ts` gives "No such file or directory"; `package.json` `"types": "./dist/types/index.d.ts"`.
- **Suggested fix:** Grep `-r node_modules/@aiden0z/pptx-renderer/dist/types`. Better, add a `check:types` probe file that imports `PptxViewer` and `RECOMMENDED_ZIP_LIMITS` and calls `PptxViewer.open(new Uint8Array(), div, pptxViewerOptions(RECOMMENDED_ZIP_LIMITS))`. The compiler then proves the API instead of grep.

## Finding 7: The attachment-card gate grep matches the component file itself, so Task 5.3 fails even when the sibling lands exactly as planned
- **Severity:** High
- **Location:** Phase 5, Task 5.3 step 1 (`grep -rln "<AttachmentCard" src/renderer --include=*.tsx | grep -v "\.test\.tsx$"`, "The expected output is exactly the two lines …").
- **Flaw:**
  - `src/renderer/components/attachments/AttachmentCard.tsx:51` contains `}: Pick<AttachmentCardProps, …>`, which matches `<AttachmentCard`. The command prints three files, not two, and the step treats "any other output" as a Failure Protocol stop.
  - The sibling's call sites now exist in the tree: `InputArea.tsx:1012,1024,1037` and `MessageBubble.tsx:448,456`. Two of them are cases the plan does not handle:
    - a pending image card (`loading`, with a path still being read, `InputArea.tsx:1024-1034`);
    - the transcript image card, which has no `path`, only a data-URL `preview` (`MessageBubble.tsx:448-453`).
- **Failure scenario:** The executor runs step 1 on a correct tree and gets `AttachmentCard.tsx`, `MessageBubble.tsx` and `InputArea.tsx`. Phase 5 stops and kongming is consulted for a non-problem. If the executor instead wires `onOpen={path ? … : undefined}` blindly, a still-loading pending image becomes clickable and opens a preview of a file the composer has not finished reading. Sent pasted images get no preview, silently. That contradicts D7's "attachment cards in the composer and in the sent user bubble".
- **Evidence:** `AttachmentCard.tsx:51`; the grep output listed above.
- **Suggested fix:** Use `grep -rln "<AttachmentCard[[:space:]]" … | grep -v "attachments/AttachmentCard.tsx"`, or count JSX openings per file. Specify per card whether `onOpen` applies: none while `loading`, and for path-less image cards either none or an image-from-data-URL preview, by decision.

## Finding 8: The refresh e2e writes to `launch.project`, and `launch` is the helper function
- **Severity:** Medium
- **Location:** Phase 6, Task 6.1 step 7 (`fsp.writeFile(path.join(launch.project, "table.csv"), …)`).
- **Flaw:**
  - `launch` is the exported async function (`e2e-tauri/session.ts:178`). The project directory lives on its returned `PreparedLaunch` (`session.ts:150-163`, field `project`), which step 1 discards (`await launch({...})`).
  - `launch.project` is `undefined`, so `path.join` throws `TypeError [ERR_INVALID_ARG_TYPE]`.
  - The only on-disk-change test (acceptance criterion 6) therefore fails for a spec bug, not a product bug, in the shell where refresh matters most.
- **Evidence:** `session.ts:178` `export async function launch(options: LaunchOptions): Promise<PreparedLaunch>`; plan step 1 and step 7 text.
- **Suggested fix:** Use `const run = await launch({...})` and `run.project`, or `currentLaunch().project` (`session.ts:206`).

## Finding 9: The CSV path ignores `binary`, `ok: false` and `truncated`, so UTF-16 or oversized CSVs render as a silent, wrong table
- **Severity:** Medium
- **Location:** Phase 2, Task 2.5 step 2.2 table, row `csv` ("the same `fs.read` with `2_000_000` → State `rich` with `bytes = new TextEncoder().encode(content)`"); plan.md D8 ("CSV 2 MB, the existing `fs:read` behaviour").
- **Flaw:** `fs:read` returns `{ ok: true, content: "", binary: true }` for any file whose bytes contain a NUL (`src/main/ipc.ts:988-989`; Rust `read_file_capped`, `src-tauri/src/services/fs.rs:265`). It truncates at `FS_READ_MAX_BYTES_CAP = 2_000_000` (`ipc.ts:125`, `fs.rs:24`) and reports `truncated`. The csv row checks none of these, unlike the markdown/text row.
- **Failure scenario:**
  - Excel's "Unicode Text"/UTF-16 CSV exports, which are common on Vietnamese-locale Windows machines, contain NULs. The preview shows an empty table in state `rich`, with no error and no **Open in its app**.
  - For a 5 MB CSV, the last parsed row may be cut mid-field. The only note is the 500-row `sheetTruncated` text, which describes a different limit.
  - `ok: false` (for example "Path escapes the workspace") becomes a TextEncoder of `""`, which is an empty table again.
- **Evidence:** `ipc.ts:962` `fail(...)` shape with `content: ""`; `ipc.ts:988-989` binary branch; plan csv row.
- **Suggested fix:**
  - Map `!ok` to error `failed`.
  - Map `binary` to error `failed`, or decode UTF-16 by BOM through `fs:read-document` bytes.
  - Pass `truncated` through to SheetPreview so it shows "file truncated at 2 MB" in addition to the row cap.
  - Add DocumentPreview cases for `binary: true` and `ok: false` on a `.csv`.

## Finding 10: The snapshot gate also checks `ports.api.txt`, which the plan never updates, so Phase 1 fails its own Verify
- **Severity:** High
- **Location:** Phase 1, "Files to Create / Modify" and Task 1.6 step 2 (only `services.api.txt` gets the new line); plan.md Constraints ("the API snapshot (`src-tauri/contracts/services.api.txt`)").
- **Flaw:**
  - `cargo public-api` lists every handler under the `ports` snapshot too. `check_snapshots` greps `sai_atlas_lib::ports::` (`scripts/check-module.sh:121-122`), and every handler signature contains `sai_atlas_lib::ports::Caller`.
  - The sibling's `fs_read_pdf` therefore appears in `src-tauri/contracts/ports.api.txt:859`, next to `fs_read_image` at `:858`. The sibling also modified that file (git status lists `M src-tauri/contracts/ports.api.txt`).
  - In `snapshots` mode, `SNAPSHOTS` covers every `contracts/*.api.txt` (`check-module.sh:72`).
- **Failure scenario:** After Task 1.5, `fs_read_document` appears in the regenerated `ports` listing, but `contracts/ports.api.txt` lacks it. `bash scripts/check-module.sh snapshots` fails with "public API of ports changed". The Failure Protocol stops Phase 1, and acceptance criterion 10 cannot pass.
- **Evidence:** `grep -c "ports.api" plans/261007-1935-side-by-side-document-preview/*.md` gives 0 in every file; `ports.api.txt:858-859`.
- **Suggested fix:** Add `src-tauri/contracts/ports.api.txt` to Phase 1's file list. In Task 1.6, insert the same `fs_read_document` line between `fs_read(` and `fs_read_image(` in both snapshot files, or regenerate both with the `check-module.sh` command and review the diff.

## Scope audit summary (state lifetimes)

| New or touched state | Intended lifetime | Actual lifetime in the plan | Verdict |
|---|---|---|---|
| `filePreviewPath` (existing, `ui.ts:44`) | per window, cleared on tab switch | unchanged; `closeSessionOverlays` clears it (`ui.ts:277`; `tabs.ts:455,512`) | OK, reused correctly |
| widened drawer width | per preview | written into `gui.panelWidth`, app-global and persisted | Wrong (Finding 4) |
| pdf.js loader and `GlobalWorkerOptions.workerPort` | per window, shared | shared, but destroyed per document; never reset after a dead worker | Wrong (Findings 1–2) |
| `useFileVersion` poll | per mounted preview | per mounted preview, but each tick goes into the window's serialized Tauri IPC queue | Cost understated (Finding 5) |
| `sidebarVisible` collapse | per preview | per window, never restored | Already known (verdict defect 3) |

Status: DONE
Summary: 10 new findings. One is critical: the shared pdf.js worker is destroyed per document, which breaks PDF refresh and concurrent renders. Seven are high: the thumbnail timeout is lost, SheetJS drops formula cells, a preview permanently widens the persisted drawer width, the synchronous Tauri read blocks the window's IPC queue, the gate greps in Tasks 4.2 and 5.3 always fail, and `ports.api.txt` is never updated. Library claims were verified against the real pdfjs-dist, pptx-renderer and SheetJS packages.
Concerns/Blockers: I did not verify the Electron `file://` worker and cmaps behaviour, or whether WebKitGTK applies `@font-face` declared inside a shadow root (docx embedded fonts). Both need a live run.
