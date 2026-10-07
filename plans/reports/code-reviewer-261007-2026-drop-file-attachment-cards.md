# Code review: dropped files become attachment cards

Date: 2026-10-07 · Scope: uncommitted working tree (26 modified + 18 new files under `src/`, `src-tauri/`), plan `plans/261007-1931-drop-file-attachment-cards/`.

## Gates run

| Gate | Result |
|---|---|
| `bun run check:types` | pass |
| `bunx vitest run` (touched areas, 27 files / 334 tests) | pass |
| `bunx vitest run` (full) | 18 files fail, all under untracked `.claude/` / `.agentkit/` (`process.exit` in `worktree.test.cjs`); none in `src/` |
| `bunx biome check` (35 touched files) | clean |
| `cargo clippy … -D warnings` | clean |
| `cargo test --all-features` | pass |
| `check-test-parity.ts services` | 46 tests mirrored |
| `check-module.sh snapshots` | PASS |
| `any` / `mock.module` / lint suppressions | none |
| i18n | 4 new keys in both `en.ts` and `vi.ts`; removed `input.removeAttachment` from both |

## Overall

The prompt contract and failure-path restores in `use-composer-submit.ts` are correct and tested. The Rust drag observer is non-intrusive and scoped to the window. There are two real defects. The PDF thumbnail renderer breaks when several PDFs render at once and can leave a card spinning forever. On Tauri, stale native drop paths can take over a later text or tab drop. The rest are robustness and low-severity issues.

## High

### H1. Concurrent PDF renders share one pdf.js worker; one render's `destroy()` breaks the others, and the timeout cannot fire through a hung `destroy()`
`src/renderer/lib/pdf-thumbnail.ts:108`, `:143`, `:156`

Verified against `node_modules/pdfjs-dist/build/pdf.mjs` 6.4.299:
- With `GlobalWorkerOptions.workerPort` set, every `getDocument` gets the same cached `PDFWorker` (`PDFWorker.create`, ~16349), so `task._worker` is shared.
- `PDFDocumentLoadingTask.destroy()` (~15557) sets `_pendingDestroy` on that shared worker. It then calls `PDFWorker.destroy()`, which aborts the shared `MessageHandler` listener (`#messageAC.abort()`, ~9066) and drops the port mapping.
- `destroy()` first does `await this._setupCapability.promise`. That promise only resolves after the `GetDocRequest` reply (~15541).

Failure scenario: drop two PDFs at once (the headline acceptance case). Tauri serialises both `fs:read-pdf` calls, so B's bytes arrive while A is rendering. A finishes, and its `finally` calls `task.destroy()`. Then one of two things happens:
- (a) B calls `getDocument` while A's destroy is pending. `PDFWorker.create` throws "the worker is being destroyed", and B shows the icon fallback instead of page 1.
- (b) B's `GetDocRequest` is in flight when A's `PDFWorker.destroy()` aborts the listener. B's reply is never read, and B's 20 s timeout fires. B's `finally` then does `await task.destroy()`, which awaits B's `_setupCapability`, which never resolves. `rasterizeFirstPage` never settles, the `pending` map keeps the promise forever (`pdf-thumbnail.ts:80-91` only deletes on settle), and every later mount of that path gets the same never-ending promise. The spinner stays until reload.

The same unbounded `await task.destroy()` also defeats the stated purpose of the timeout ("A worker that never starts leaves pdf.js waiting forever; bound it"). If the worker module fails to load, `GetDocRequest` is never answered, and the timeout rejection is swallowed by a `finally` that never completes.

The tests use only fake `rasterize` sources, so none of this is exercised.

Fix:
- Serialise rasterisation through one promise chain, so one document at a time uses the shared port and each `destroy()` finishes before the next `getDocument`.
- Do not `await` an unbounded `destroy()`: race it against a short timer, or fire it with `void task.destroy().catch(() => {})`.
- On a timeout, `terminate()` the Worker and reset `GlobalWorkerOptions.workerPort` (and the cached module promise's worker), so the next render gets a fresh one.
- Add a test with a fake `pdfjs` that rejects a second `getDocument` while a destroy is pending, and one whose `destroy()` never settles.

## Medium

### M1. Stale native drop paths take over a later text or tab drop on Tauri/Linux
`src/renderer/lib/dropped-files.ts:161-164`, used by `src/renderer/components/layout/InputArea.tsx:579-581`

`hasDroppedFiles` returns true whenever `freshNativePaths() !== null`, whatever the current drag's types. Native paths are set when any file drag crosses the window (`webview.rs` `drag-data-received`). They are cleared only by a later URI-list drag or by being consumed in a composer drop, and they stay fresh for `NATIVE_PATHS_FRESH_MS = 10_000`.

Scenario:
1. The user drags a file onto the transcript, where nothing claims it. No `drop` fires, so the paths are not consumed.
2. Within 10 s they drag selected transcript text, or a tab (`application/x-omp-tab`), onto the composer. Neither drag lists `text/uri-list`, so the shell sends nothing and the old paths remain.
3. `handleDrop` sees `hasDroppedFiles` true, calls `preventDefault()` (the text is not inserted), and attaches the earlier, abandoned file. For a tab drop, `SplitWorkspace`'s ancestor `onDrop` still splits, and the stale files are attached too.

This breaks acceptance 7 ("dropping text still inserts text") on Linux, the shipping shell. Existing tests cover a link drag clearing paths, and staleness, but not a non-URI drag while paths are fresh.

Fix:
- In `hasDroppedFiles` (and `resolveDroppedPaths`), consult native paths only when `isFileDrag(data)` (the types include `Files` or `text/uri-list`).
- Clear `nativePaths` on a window-level `drop`/`dragend` capture listener, so an abandoned drag cannot leak into the next one.
- Add a test: fresh native paths, then a `text/plain`-only drop, must insert text and attach nothing.

### M2. Tauri `fs:read-pdf` does up to 32 MB of blocking I/O plus base64 encoding inside the window's ordered drain
`src-tauri/src/services/ipc.rs:529-565`

`fs_read_pdf` returns `Reply::ok(...)`, which is `Reply::Ready`. The bridge runs `Ready` handlers inline under the window's single drainer role (`bridge.rs` `drain`/`run_call`), so every later call from that window waits behind it. This includes `rpc:command` (send and abort) and the next card's read. Dropping several large PDFs means several sequential 32 MB reads and roughly 43 MB base64 encodes each before the composer's next RPC is admitted.

Fix: return `Reply::Later(Box::pin(async move { tokio::task::spawn_blocking(move || read_pdf_file(...)).await… }))`, the pattern already used at `ipc.rs:63/94/111`. Keep `read_pdf_file` pure so the tests stay as they are.

## Low

### L1. The size cap is checked on `stat`, then the whole file is read; the `%PDF-` sniff runs only after the full read (both shells)
`src/main/fs-read-pdf.ts:31-37`, `src-tauri/src/services/ipc.rs:545-561`

Between `stat` and `readFile`/`std::fs::read`, the path can be replaced by a larger file, or by a symlink to one, so the 32 MB cap is advisory. Any file under the cap is fully read before the 5-byte sniff rejects it. Exploiting this needs a local writer racing the renderer. The renderer CSP (`connect-src 'self'`) limits exfiltration, consistent with the plan's threat model.

Fix: open once, `fstat` the handle (`isFile`, size), read the first 5 bytes and reject a non-PDF, then read at most `max+1` bytes from the same handle and fail when it exceeds `max`.

### L2. Image attachments land in read-completion order, and dedupe uses render-time state
`src/renderer/components/layout/InputArea.tsx:508-523`

Each image is appended as its read resolves, so `images` (and the RPC `images` payload order) can differ from drop or pick order. The paperclip used `Promise.allSettled` and appended in pick order before. `isPending`/`images.some` read the closure's `pendingImages`/`images`, so two drops before a re-render can read the same image twice.

Fix: collect the results and append them in `reads` order. Dedupe inside the functional updater: `setImages(prev => prev.some(i => i.path === image.path) ? prev : [...prev, image])`.

### L3. The transcript parser hides user-typed or pasted trailing quoted paths (accepted risk; note only)
`src/renderer/lib/prompt-attachments.ts:47-59`

A message whose typed text or expanded paste ends in lines like `'/etc/hosts'` shows those lines as cards and drops them from the body and from copy-message. The plan accepts this, and the exact-requote check keeps it narrow. Also, `prompt-attachments.ts:7` (lib) imports from `components/layout/attach-document`. That inverts the lib→component layering; moving `quotePromptPath`/`isPromptSafePath`/`appendDocumentPaths` into `lib/` would fix it.

### L4. Transcript image cards lose the file name
`src/renderer/components/chat/MessageBubble.tsx:450`

The composer shows `image.name`, but the sent bubble always labels images "attached image", because `ImageContent` carries no name. This is cosmetic; it is mentioned because acceptance 5 says "the same cards".

### L5. Stale doc comment
`src/renderer/lib/dropped-files.ts:169` says "no file drag for two seconds"; the constant is 10 s.

## Verified, no defect

- **Prompt contract**: `outgoingMessage = appendDocumentPaths(expandedMessage, paths)` (`use-composer-submit.ts:301`) is byte-identical to the paperclip's output for the type-then-attach flow. Two behaviours differ from the old flow, both improvements: paths now always follow the text (before, text typed after picking came after the path lines), and emoticon and paste-marker expansion no longer runs over path lines. The only byte difference is that trailing whitespace on the typed text is now trimmed before the path lines rather than kept. Documents-only sends work in plain, queue and send-button paths.
- **Restores**: documents are restored on every failure path. These are: refused queue (`restoreRefused`), zero-sent queue, `/clear` refused, origin changed before dispatch, `!response.success`, and a thrown request. A partial queue correctly returns no documents. `restoreTabComposer` dedupes by path, and its new positional argument has no stale callers.
- **History** records `appendDocumentPaths(message, paths)`, which replays the same bytes.
- **Rust observer**: it is connected with `connect` on a `RUN_LAST` signal, its closure returns `()` so it cannot stop emission or take the drop, it filters to the `text/uri-list` target, it is installed only for `WindowKind::Main`, and it emits via `emit_to_window(win_id, …)`.
- **Electron**: `webUtils.getPathForFile` goes through the preload, `onNativeDropPaths` is undefined, and `will-navigate` is blocked (`window.ts:93`), so an unclaimed Files drop cannot navigate the window.
- **MessageBubble**: copy uses the split `content`, so only the body is copied, and empty text blocks are skipped.
- **PdfThumbnail**: the `live` flag guards unmount, and a failure is not cached.

## Recommended actions (priority order)
1. H1: serialise pdf.js renders, bound or fire-and-forget `destroy()`, and reset the worker on timeout.
2. M1: gate native paths on `isFileDrag`, and clear them on any window drop or dragend.
3. M2: `Reply::Later` + `spawn_blocking` for `fs_read_pdf`.
4. L1 and L2 when convenient.

## Unresolved questions
- Whether WebKitGTK on Wayland delivers `drag-data-received` before the page's first `dragover`. This only decides whether the hint shows on first entry; the drop path waits 300 ms anyway. It needs a real-display check.

Status: DONE_WITH_CONCERNS
