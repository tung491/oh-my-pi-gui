# Red team: failure modes (Flow Tracer)

Scope: plan.md and phase-01..06. Already-known defects from `kongming-261007-ultra-verdict.md` (winner's list, items 1-12) are excluded.

## Finding 1: The pptx e2e check passes before the pptx renderer has run, so a broken pptx preview ships green
- **Severity:** High
- **Location:** Phase 6, Task 6.1 step 4.3; plan.md Acceptance criterion 4 (`deck.pptx`); Phase 4, Task 4.3 step 4
- **Flaw:** The assertion is `data-preview-state === "rich"` and `shadowCount("*") > 0`. Both hold before any pptx code has run. `DocumentPreview` sets state `rich` as soon as the bytes pass the signature and ZIP checks (Phase 2, Task 2.5 step 3, "Otherwise → state rich"), before the lazy chunk loads. `useShadowMount` appends its own `mount` div to the shadow root before it awaits `render` (Task 4.3 step 4.2), so `*` matches at least 1 element at once.
- **Failure scenario:** `PptxViewer.open` throws on WebKitGTK, or its `.d.ts` shape differs. `until` reads the state and count on its first poll, finds `rich` and 1 (the empty mount div), and passes. The test moves on to `table.xlsx` and clicks Back, which unmounts the preview. The later `onError` is caught inside the try/catch, so no page error is recorded. Criterion 4 reports pptx as rendering while every deck shows "could not be shown".
- **Evidence:** Plan: "deck.pptx: expect `[data-preview-state]` to equal `rich`, and `shadowCount("*")` to be greater than 0 within 15000 ms". Task 4.3: "Creates `mount = document.createElement("div")` and appends it … Awaits `render(mount, root)`". `e2e-tauri/session.ts:465-484`: `collectPageErrors` records only uncaught errors and unhandled rejections, and a caught renderer error is neither.
- **Suggested fix:** Assert on renderer output: a slide element class from the pptx-renderer `.d.ts`, or `mount.childElementCount > 0` plus a `data-rendered` attribute that `PptxPreview` sets only after `open` resolves. Also assert that `data-preview-state` is still `rich` after a settle delay.

## Finding 2: Clicking the other split pane remounts the preview and re-reads the file from the other pane's workspace
- **Severity:** High
- **Location:** Phase 2, Task 2.5 step 2.2 (effect keyed on `[path, tabId, version]`) and Task 2.7 (docking in split); plan.md D1
- **Flaw:** The plan newly docks the preview beside a split workspace, so the user keeps working in both panes while it is open. Pointer-down in the inactive pane calls `switchTab`. `PanelContainer` keys its error boundary on `activeTabId`, so `FilesPanel` and `DocumentPreview` remount with a new `tabId`. Tree paths are workspace-relative, so the same `filePreviewPath` now resolves against the other session's cwd.
- **Failure scenario:** With `report.docx` open from pane A's tree, the user clicks into pane B's composer. The 50-page PDF or docx is torn down and parsed again, which freezes the UI (see Finding 5). Then one of two things happens: B's workspace has its own `report.docx` and the preview silently shows that other file, or it doesn't and the preview turns into "could not be shown". Every focus change between panes repeats this, and the 2 s poll now stats the wrong workspace.
- **Evidence:** `src/renderer/components/layout/SplitWorkspace.tsx:85-87` (`onPointerDownCapture … switchTab(tabId)`); `src/renderer/components/layout/PanelContainer.tsx:166` (`<PanelErrorBoundary key={`${activeTabId ?? "no-tab"}:${panelTab}`}>`); `src/renderer/components/panels/FilesPanel.tsx:53` (`useRuntimeTabId()`), and `src/renderer/stores/session-runtime-context.tsx:138-139` falls back to `focusedTabId`; `FilesPanel.tsx` `onNodeClick` passes the relative `entry.path` (`openFilePreview(id.slice(5))`). No test or acceptance criterion covers a tab switch.
- **Suggested fix:** Store the owning tab with the preview, e.g. `openFilePreview(path, tabId)`. Resolve tree paths to absolute when opening, or pin `DocumentPreview`'s `tabId` to the opener. Remove `activeTabId` from the boundary key while previewing. Add a PanelContainer test: switch the active tab and assert that `readDocument` is not called again and that `tabId` is unchanged.

## Finding 3: The shared `openPdfDocument` removes the sibling's 20 s hang guard and returns no handle to cancel a load
- **Severity:** High
- **Location:** Phase 3, Task 3.3 steps 2-3; plan.md Shared contracts (`openPdfDocument`)
- **Flaw:** `openPdfDocument` does `return { document: await task.promise, destroy }`. The `PDFDocumentLoadingTask` is reachable only after loading succeeds. Task 3.3 step 3 replaces the thumbnail's `getDocument` + `Promise.race([drawing, timeout])` + `finally task.destroy()` with `await openPdfDocument(bytes); try {…} finally { destroy() }`, so the await on `task.promise` now sits outside any timeout. `PdfPreview`'s cleanup cannot destroy a document still loading, because it has no handle yet.
- **Failure scenario:** (a) The worker fails to start, which is exactly what the sibling's comment guards against. `task.promise` never settles. The thumbnail loader's `pending` map holds that promise forever, so every card for that path spins for the rest of the session. The preview shows the Suspense spinner forever and offers no **Open in its app**. (b) The user clicks a 30 MB PDF, then Back, before it finishes loading. The effect cleanup has nothing to destroy, the document finishes loading in the shared worker and is never freed. Each refresh or tab-switch remount (Finding 2) leaks one more document.
- **Evidence:** `src/renderer/lib/pdf-thumbnail.ts:141-157` (`RENDER_TIMEOUT_MS`, `Promise.race`, `finally { await task.destroy() }`, and the comment "A worker that never starts leaves pdf.js waiting forever"); `pdf-thumbnail.ts:75-93` (the in-flight promise is reused until it settles). `pdf-thumbnail.test.ts:25` injects a fake `rasterize`, so "thumbnail tests stay green" cannot detect the regression.
- **Suggested fix:** `openPdfDocument` should return the `loadingTask` synchronously (`{ task, promise }`) so callers can destroy it during loading. Keep the timeout race in a shared helper used by both callers. Add a unit test with a never-resolving fake task that asserts a timeout rejection and a `destroy` call.

## Finding 4: The ZIP guard trusts central-directory sizes, and JSZip inflates fully before it checks them
- **Severity:** High
- **Location:** Phase 2, Task 2.2; plan.md D5
- **Flaw:** `checkZipBounds` sums the declared u32 uncompressed sizes from the central directory. A crafted docx, pptx or xlsx can declare 1 KB and carry a deflate stream that expands about 1000:1. JSZip, which docx-preview and the pptx renderer both use, only compares the real output length with the declared size on the stream's `end` event, after the whole entry has been inflated in memory.
- **Failure scenario:** A downloaded or model-linked `.docx` of 30 MB passes the 32 MiB read cap and the guard (declared total under 256 MiB, under 5000 entries). docx-preview inflates `word/document.xml` to many GB on the renderer main thread, and the web process runs out of memory. In the Tauri shell the whole chat window dies, and the UI cannot show "could not be shown" because nothing is left to show it.
- **Evidence:** `node_modules/jszip/lib/compressedObject.js:30-40` (`worker.on("end", … if (this.streamInfo["data_length"] !== that.uncompressedSize) throw …)`); `node_modules/jszip/lib/zipEntry.js:96` builds the `CompressedObject` from the declared CD sizes. Plan Task 2.2 step 5.4: "Sum the uncompressed size (u32 at +24)". The guard's tests only patch declared sizes upward, never downward.
- **Suggested fix:** Also bound by the actual inflate: inflate each entry in a Worker with a streaming inflater such as `fflate` or `DecompressionStream`, abort beyond the cap, and refuse an entry whose real length differs from its declared one. At minimum, refuse entries whose compressed size exceeds their declared uncompressed size by more than the deflate floor, and refuse a declared compression ratio beyond about 200:1. Add a lying-header fixture to `zip-guard.test.ts`.

## Finding 5: Parsing runs on the UI thread and is repeated on every refresh; the plan's "chat stays usable" claim is false
- **Severity:** High
- **Location:** Phase 3, Task 3.5 step 2.1 and Task 3.6 step 2; Phase 4, Task 4.4; plan.md Risks ("the chat stays usable, because the drawer is a sibling of the chat"); Phase 1, Task 1.5 step 4.7
- **Flaw:** Being a DOM sibling of the chat gives no CPU isolation, because the drawer runs on the same JS thread. These all run synchronously on the main thread:
  - SheetJS `read(bytes, { type: "array", dense: true, cellDates: true, cellNF: true })` parses every cell of every sheet, hidden ones included, inside `useMemo` during render. The 500×50 cap is applied afterwards, and `sheetRows` is not passed.
  - docx-preview and JSZip run on the main thread.
  - The `atob` loop decodes up to 32 MiB.

  On Tauri, `fs_read_document` is a synchronous `Reply::ok(...)` handler. The bridge drains one call at a time per window, so a 32 MiB read plus base64 encode stalls every other IPC call from that window, RPC prompts included.
- **Failure scenario:** The agent writes a 20 MB xlsx export and the user previews it. The window freezes for several seconds: the composer does not type, and the stream does not scroll. While the agent keeps appending to the file, the 2 s poll triggers the full read, decode and parse again on every change, so the freeze repeats. A `useMemo` that throws calls `onError` (the parent's `setState`) during render, which React reports as "Cannot update a component while rendering a different component".
- **Evidence:** `src-tauri/src/bridge.rs` drain comment: "One drainer per window at a time, so a handler's synchronous work always finishes before the next call starts"; `src-tauri/src/services/ipc.rs:529-565` (`fs_read_pdf` is the synchronous precedent the plan copies); `src/renderer/lib/pdf-thumbnail.ts:32-37` (the `atob` loop that Phase 2 copies as `decodeBase64`).
- **Suggested fix:**
  - Pass `sheetRows: SHEET_MAX_ROWS + 1` and `bookSheets`/`sheets` limits to SheetJS, and parse in a Worker (SheetJS supports this).
  - Call the parse from an effect, not from `useMemo` during render.
  - Make the Rust handler `Reply::Later` with `spawn_blocking`.
  - Lower the rich-render cap, e.g. 10 MB for sheets and docx, and show "too large" above it.

## Finding 6: Entering a preview permanently widens the saved drawer width, and rollback does not undo it
- **Severity:** Medium
- **Location:** Phase 2, Task 2.7 step 2.4 (widen effect); plan.md D1; plan.md Rollback
- **Flaw:** The widen effect calls `setWidth(current => Math.max(current, target))`. Any `width` change is persisted to `gui.panelWidth` 150 ms later. The plan never restores the earlier width when the preview closes.
- **Failure scenario:** The user keeps the drawer at 403 px for logs. One preview on a 1440 px window saves 576 px. From then on the Logs tab, the tree and every later session open at 576 px, and repeated previews on a larger monitor ratchet the width up to 840 px. Reverting Phase 2 leaves the inflated pref in every profile.
- **Evidence:** `src/renderer/components/layout/PanelContainer.tsx:88-94` (persist effect on `[width, widthHydrated]` → `prefs.set(PANEL_WIDTH_PREF, …)`); `:62-86` (hydration restores the saved width on every mount).
- **Suggested fix:** Keep a separate preview width: either `effectiveWidth = previewing ? max(width, target) : width`, without calling `setWidth`, or a separate `gui.previewPanelWidth` pref. Add a test that `prefs.set` is not called with the widened value when no drag happened.

## Finding 7: `useShadowMount` throws away the disposer of a render that resolves after cleanup, leaking viewers and ResizeObservers on every refresh
- **Severity:** Medium
- **Location:** Phase 4, Task 4.3 step 4.6; Task 4.4 steps 1.3 and 2.1
- **Flaw:** "Ignores a resolved render after cleanup (a `cancelled` flag)": when `render` resolves after cleanup, its disposer is dropped, not called. The pptx render returns `() => viewer.destroy()`, and the docx render's disposer disconnects a `ResizeObserver` that observes the persistent host element.
- **Failure scenario:** The agent rewrites `deck.pptx` while the user watches. Each 2 s refresh cleans up the previous effect while `import()` or `PptxViewer.open` is still pending. Each orphaned viewer keeps its blob URLs, media elements and lazy-slide observers. Each orphaned docx `ResizeObserver` stays attached to the live host and writes `zoom` onto a detached mount on every drawer resize. Memory grows for the life of the session.
- **Evidence:** Plan Task 4.3 step 4.4-4.6; Task 4.4 step 1.3 ("disconnect it in the disposer"). `PanelContainer.tsx:166` remounts on every tab switch as well (Finding 2), which multiplies the number of cleanups that race a pending render.
- **Suggested fix:** When the render resolves after cleanup, call the returned disposer at once. Pass an `AbortSignal` into `render` so the library call can be skipped. Unit-test `useShadowMount` with a deferred render: unmount before it resolves, then assert the disposer ran once.

## Finding 8: Refresh remounts the renderer, which resets scroll and flashes, and the stat baseline can miss the change that matters
- **Severity:** Medium
- **Location:** Phase 2, Task 2.5 steps 1 and 2.4 (`PanelErrorBoundary key={`${path}:${version}`}`); plan.md D9
- **Flaw:**
  - Every version bump changes the boundary key, so the renderer unmounts and remounts. Scroll position, the selected sheet tab, and the page the user was reading are all lost, and the full render runs again.
  - `useFileVersion` takes its baseline from its own `statOnly` call, issued independently of the content read. `fs.read`, used for text, md and csv, returns no `mtimeMs` at all. When the file changes between the content read and the baseline stat, the baseline already holds the new mtime and the preview stays stale until the next write.
- **Failure scenario:**
  - The user reads page 30 of a PDF or sheet tab 3 while the agent touches the file. The view snaps back to page 1 or sheet 1 every 2 s.
  - The user opens a preview from the Write card while the agent's next `write` to the same path lands. The old content is shown with the new mtime as baseline, and no refresh ever fires.
- **Evidence:** `src/main/ipc.ts:961-995` (the `fs:read` result has `size` but no mtime); plan Task 2.5 step 1 ("On mount it calls `readDocument(path, { …, statOnly: true })` and stores `{ size, mtimeMs }`"). The unit test (Task 2.4) uses a single `vi.fn` with fixed results and cannot exercise this ordering.
- **Suggested fix:**
  - Take the baseline from the content read (`readDocument` already returns `mtimeMs`). For `fs.read` kinds, stat before the read and use that result.
  - Key the remount on `path` only, pass `bytes` as a prop, and keep the scroll container and selected sheet outside the renderer.
  - Debounce refresh until two consecutive polls agree.

## Finding 9: The PDF renderer allocates up to 50 full-width HiDPI canvases eagerly and never releases them
- **Severity:** Medium
- **Location:** Phase 3, Task 3.6 step 1
- **Flaw:** Every page up to 50 is rendered at `(clientWidth − 24) × devicePixelRatio` into its own `<canvas>`, sequentially and eagerly. Nothing virtualizes or lazy-renders off-screen pages, and canvas backing stores are not zeroed on cleanup. The sibling deliberately sets `canvas.width = 0` to free the bitmap.
- **Failure scenario:** On a 2× display with a 576 px drawer, a Letter page is about 1104×1429×4 B ≈ 6.3 MB, so 50 pages take about 315 MB. At the 840 px maximum it is about 470 MB. Each refresh or remount (Findings 2 and 8) allocates another set before GC frees the last. WebKitGTK hits its canvas memory limit, and later canvases render blank or the web process is killed.
- **Evidence:** `src/renderer/lib/pdf-thumbnail.ts:135-137` ("Release the bitmap now rather than when the GC gets to it"); `PanelContainer.tsx:15` (`MAX_WIDTH = 840`). Phase 6 tests only `one-page.pdf`, so neither the 50-page cap nor memory is exercised.
- **Suggested fix:** Render pages on demand with an IntersectionObserver, cap the backing width (e.g. 1600 px), zero the canvases in cleanup, and add a 60-page fixture to the e2e that asserts the "pages not shown" note.

## Finding 10: The Tauri e2e code does not type-check, and the 6000 ms refresh bound in criterion 6 is never enforced
- **Severity:** Medium
- **Location:** Phase 6, Task 6.1 steps 1 and 7; plan.md Acceptance criterion 6
- **Flaw:**
  - Step 7 calls `until(() => exactTextCount(...), n => n >= 1, 6000)`, but `until` takes an options object as its third argument.
  - It writes to `path.join(launch.project, …)`, but `launch` is the imported function and step 1 discards the `PreparedLaunch` it returns.
  - `check:types` includes `e2e-tauri/**` through `tsconfig.wdio.json`, so both lines fail type-checking.
- **Failure scenario:** Task 6.4's full gate fails on `bun run check:types`, and the Failure Protocol stops the phase. If the executor patches only the second issue, or casts `as never` as the plan does elsewhere, the timeout silently falls back to 10 000 ms: destructuring `6000` yields the default. Criterion 6 ("within 6000 ms") is then reported as met when it was not measured.
- **Evidence:** `e2e-tauri/session.ts:430-433` (`{ timeout = 10_000, interval = 100 }: { timeout?: number; interval?: number } = {}`); `session.ts:178-183` (`launch` returns `PreparedLaunch` with `project`); `package.json:32` (`"check:types": "tsc --noEmit && tsc --noEmit -p tsconfig.wdio.json"`); `tsconfig.wdio.json:6` (`"include": ["e2e-tauri/**/*.ts", …]`).
- **Suggested fix:** Use `const run = await launch({...})` and `path.join(run.project, "table.csv")`, and call `until(…, n => n >= 1, { timeout: 6_000 })`. Add `bun run check:types` to Task 6.1's Verify.

Status: DONE
Summary: 10 new failure-mode findings, each traced to code. The worst: the pptx e2e assertion passes before the renderer runs; the preview remounts against the wrong workspace when the user clicks the other split pane; the pdf.js extraction drops the 20 s hang guard and the cancel handle; the ZIP guard is defeated by lying central-directory sizes (JSZip checks only after a full inflate).
Concerns/Blockers: none. All findings exclude kongming's defects 1-12.
