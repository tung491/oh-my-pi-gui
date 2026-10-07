---
phase: 2
title: "Preview shell, refresh and docking"
status: pending
priority: P1
effort: "9h"
dependencies: [1]
---
# Phase 2: Preview shell, refresh and docking

## Goal

The Files panel's preview body becomes `DocumentPreview`. The preview state
becomes a **target**: a file path pinned to the tab that opened it, or an
in-memory image (data URL and name). `DocumentPreview` works out the kind,
reads the file through the right channel, validates the signature, bounds ZIP
files by their **real** inflated size, shows the loading, error and unsupported
states, renders text, markdown and images itself, and hands other kinds to
injectable lazy renderers (filled in by Phases 3–4).

Refresh is event-driven: when a `write` or office tool call that wrote the
previewed file finishes, the preview re-reads with an `ifChanged` stamp and
re-renders in place only when size or mtime moved. A **Reload** button forces a
full re-read. Nothing polls.
<!-- Validation: refresh -->

The drawer docks beside the chat while a target is previewed, including in a
split workspace and at ≤1000 px. At ≤1000 px it docks at 50vw and hides the
left sidebar, which comes back on close. The preview widening is a derived
width and never writes the persisted drawer width. A focus change between the
two panes of a split keeps the preview open and pinned to its tab.
<!-- Validation: narrow window --> <!-- Red team: R8, R12, K3 -->

## Files to Create / Modify

- **Create:**
  - `src/renderer/lib/preview/document-kind.ts`, `src/renderer/lib/preview/document-kind.test.ts`
  - `src/renderer/lib/preview/document-bytes.ts`
  - `src/renderer/lib/preview/zip-guard.ts`, `src/renderer/lib/preview/zip-guard.test.ts`
  - `src/renderer/components/preview/file-writes.ts`, `src/renderer/components/preview/file-writes.test.ts` <!-- Validation: refresh -->
  - `src/renderer/components/preview/DocumentPreview.tsx`, `src/renderer/components/preview/DocumentPreview.test.tsx`
  - `src/renderer/components/preview/renderers.ts`
- **Modify:**
  - `src/renderer/stores/ui.ts` and `src/renderer/stores/ui.test.ts`: `filePreviewPath` (`ui.ts:44`, initial value `:172`, `closeSessionOverlays` `:277`) becomes `filePreview: PreviewTarget | null`; `openFilePreview` (`:191`) gains a `tabId`; new `openImagePreview`; `closeSessionOverlays` (`:264`) gains `keepFilePreview`. <!-- Red team: R8 --> <!-- Validation: path-less images -->
  - `src/renderer/stores/tabs.ts` and `src/renderer/stores/tabs.test.tsx`: `switchTab` (`tabs.ts:446-456`) keeps the preview when the target tab is already a pane of the current split. Today it calls `closeSessionOverlays()` there, which clears the preview on every pane click.
  - `src/renderer/lib/markdown.tsx`: `ExternalLink` (about `:177-192`) passes `useRuntimeTabId()` to `openFilePreview`.
  - `src/renderer/hooks/use-rpc-events.ts` and `src/renderer/hooks/use-rpc-events.test.tsx`: report finished writes to `file-writes.ts` from the `tool_execution_start` / `tool_execution_end` events (`use-rpc-events.ts:326`). <!-- Validation: refresh -->
  - `src/renderer/components/panels/FilesPanel.tsx`: remove `PreviewState`, `openPreview`, the preview effect and the preview body; render `<DocumentPreview>`; header gets **Reload**; tree clicks pass the tab id.
  - `src/renderer/components/layout/PanelContainer.tsx` and `PanelContainer.test.tsx` (its existing `filePreviewPath` lines `:66`, `:154`, `:182`, `:191` move to `filePreview`)
  - `src/renderer/App.tsx`: the compact auto-hide effect (`hideInspector`, about `:289-299`).
  - `src/renderer/styles/global.css`: the `@media (max-width: 1000px)` block (`global.css:705-713`).
  - `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| `previewKindOf` maps docx, pptx, xlsx/xls/ods, csv, pdf, png/jpg/jpeg/webp/gif/svg/bmp/avif, md/mdx, `.ts` → text, and doc/ppt/odt/odp/zip/mp3/mp4 → unsupported (case-insensitive) | `document-kind.test.ts` | vitest exit 1 (missing module) | pass |
| `expectedSignatures`: docx/pptx/xlsx/ods → `["zip"]`, xls → `["ole","zip","html"]`, pdf → `["pdf"]`, image and md → `[]` <!-- Red team: K11 --> | same | exit 1 | pass |
| `inspectZip` accepts a real zip, refuses more than 5000 entries, refuses more than 64 MiB declared, refuses ZIP64 markers, and refuses a truncated buffer as corrupt | `zip-guard.test.ts` | exit 1 | pass |
| `inspectZip` refuses a zip whose entry declares 1 KiB but inflates to 1 MiB (lying sizes) as too-large, after inflating no more than 1 KiB + 1 byte of it <!-- Red team: R3 --> | same | exit 1 | pass |
| `writtenPathOf` returns `details.resolvedPath` (else `args.path`) for `write`, the parsed `file` for `office_report`/`office_slides`/`office_clean`, and null for errors and other tools | `file-writes.test.ts` | exit 1 | pass |
| `writeMatchesPreview`: equal absolute paths match; a relative preview path matches an absolute write ending in `/<path>` from the same tab only; `./a.csv` matches `a.csv` | same | exit 1 | pass |
| A finished `write` tool call in the event stream notifies subscribers with its tab and path; an errored one does not | `use-rpc-events.test.tsx` | exit 1 | pass |
| Markdown path: calls `fs.read(path, 200_000, tabId)` and renders `h1` (the existing behaviour) | `DocumentPreview.test.tsx` | exit 1 | pass |
| docx path with a stub renderer: calls `readDocument(path, { tabId })`, and the stub receives `content.bytes.length` | same | exit 1 | pass |
| Image path: calls `fs.readImage(path, tabId)` (never `readDocument`) and renders `img[src=dataUrl]` <!-- Red team: K7 --> | same | exit 1 | pass |
| In-memory image target: renders `img[src=dataUrl]` and calls no read at all <!-- Validation: path-less images --> | same | exit 1 | pass |
| Signature mismatch (`.docx` with `signature: "pdf"`): `data-preview-state="error"` with the `preview.failed` text | same | exit 1 | pass |
| `error: "too-large"`, and a docx over the 10 MiB parse cap, show the too-large text <!-- Red team: R5 --> | same | exit 1 | pass |
| CSV `binary: true` and `ok: false` show `preview.failed`; `truncated: true` reaches the renderer as `content.truncated` <!-- Red team: R14 --> | same | exit 1 | pass |
| `.zip` path: unsupported text, and no read is called | same | exit 1 | pass |
| A matching write notification re-reads with `ifChanged`; an `unchanged` reply keeps the same renderer instance (no remount) and calls no second full read <!-- Validation: refresh --> | same | exit 1 | pass |
| A matching write with new bytes re-renders the same renderer instance with the new bytes (mount count stays 1) | same | exit 1 | pass |
| A write to another path, or nothing at all for 10 s of fake time, triggers no read (no polling) | same | exit 1 | pass |
| A `reloadToken` change re-reads without `ifChanged` | same | exit 1 | pass |
| `openFilePreview(path, tabId)` stores `{ kind: "path", path, tabId }`; `openImagePreview` stores `{ kind: "image", … }`; `closeSessionOverlays({ keepFilePreview: true })` keeps it | `ui.test.ts` | exit 1 | pass |
| Switching focus to the other pane of the split keeps the preview; switching to a tab outside the split clears it <!-- Red team: R8 --> | `tabs.test.tsx` | the first case fails (preview cleared) | pass |
| Split + previewing: a change of `activeTabId` to the other pane neither remounts the preview nor calls `readDocument` again, and the read's `tabId` stays the opener's <!-- Red team: R8 --> | `PanelContainer.test.tsx` | fails (second read with the new tab) | pass |
| Split workspace + previewing: the aside has no `absolute` class | same | fails (class present) | pass |
| Split workspace without a preview: the aside keeps `absolute` (regression) | same | passes before and after | pass |
| Previewing at innerWidth 1440: the aside width is `576px`, and after 1000 ms `prefs.set` was never called with `576` <!-- Red team: R12 --> | same | fails (`403px`) | pass |
| Compact (matchMedia true) + previewing: `sidebarVisible` becomes `false`, `data-docked-preview` is present; closing the preview makes `sidebarVisible` `true` again <!-- Red team: K3 --> | same | fails | pass |
| Compact + previewing with the sidebar already hidden: closing the preview leaves it hidden | same | passes before and after | pass |
| Existing tests "opens a local markdown link…" and "decodes an absolute file URL…" | same | stay green | pass |

## Tasks

### Task 2.1 — Red then green: kind detection and byte decoding
- **Goal:** Pure helpers that the shell and the entry points share.
- **Target files and symbols:**
  - `document-kind.ts`: `PreviewKind`, `previewKindOf(path)` and `expectedSignatures(path)` (contracts in plan.md).
  - `document-bytes.ts`: `decodeBase64(data: string): Uint8Array`, the same body as the private one in `src/renderer/lib/pdf-thumbnail.ts:32-37`, and `readDocumentBytes`.
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

     For `expectedSignatures`: `xls` → `["ole", "zip", "html"]` (real `.xls` files are OLE, but Excel and web apps also save OOXML or HTML tables under that name); other sheet extensions, `docx` and `pptx` → `["zip"]`; `pdf` → `["pdf"]`; everything else → `[]`.
  3. Write `document-bytes.ts`: `decodeBase64`, plus `readDocumentBytes(path: string, tabId: string | null, ifChanged?: { size: number; mtimeMs: number })`. It calls `window.omp.fs.readDocument(path, { ...(tabId ? { tabId } : {}), ...(ifChanged ? { ifChanged } : {}) })` and returns `{ ok: true; unchanged: true; size; mtimeMs; resolvedPath }`, `{ ok: true; unchanged: false; bytes; signature; size; mtimeMs; resolvedPath }` or `{ ok: false; error: string }`.
- **Success criteria:** All the table cases pass.
- **Verify:** `bunx vitest run src/renderer/lib/preview/document-kind.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after it.

### Task 2.2 — Red then green: ZIP guard on the real inflated size
<!-- Red team: R3 -->
- **Goal:** Refuse zip bombs before JSZip or SheetJS inflate anything, using the bytes each entry really inflates to, not the sizes the file declares.
- **Target files and symbols:** `zip-guard.ts`: `export const ZIP_MAX_ENTRIES = 5000`, `export const ZIP_MAX_UNCOMPRESSED = 64 * 1024 * 1024`, and `export async function inspectZip(bytes: Uint8Array): Promise<{ ok: true } | { ok: false; reason: "too-large" | "corrupt" }>`.
- **Steps:**
  1. In the test, build ZIP buffers in code with `jszip` (devDependency, test-only here, `compression: "DEFLATE"`): one small file → `ok`; 5001 empty files → `too-large`.
  2. Declared size: patch one central-directory entry's uncompressed-size field (offset 24 of the `PK\x01\x02` record) to `0x7fffffff` in each of 3 entries. Expect `too-large`.
  3. Lying size: one entry of `new Uint8Array(1024 * 1024)` (zeros), then patch both its central-directory size (+24) and its local-header size (+22 of `PK\x03\x04`) to `1024`. Spy on the counting hook (`inspectZip`'s optional second argument `{ onInflated?(bytes: number): void }`, test-only) and expect `too-large` with the total reported bytes `<= 1025`.
  4. ZIP64: patch the EOCD entry count (EOCD offset 10) to `0xffff`. Expect `too-large`. Corrupt: `bytes.subarray(0, 30)`. Expect `corrupt`. Run (red).
  5. Implement the guard:
     1. Scan backwards from the end, up to 65 557 bytes, for the EOCD signature `0x06054b50`. If it is missing, return `corrupt`.
     2. Read the total entries (u16 at +10), the central-directory size (u32 at +12) and offset (u32 at +16). If the entry count is `0xffff` or the offset is `0xffffffff`, return `too-large`. If the count is more than `ZIP_MAX_ENTRIES`, return `too-large`.
     3. Walk the central directory, checking for `0x02014b50` at each record. Read method (u16 +10), flags (u16 +8), compressed size (u32 +20), declared uncompressed size (u32 +24) and local-header offset (u32 +42). Advance by `46 + nameLen(+28) + extraLen(+30) + commentLen(+32)`. If the declared sum exceeds `ZIP_MAX_UNCOMPRESSED`, return `too-large`. An encrypted entry (flag bit 0) or a method other than 0 or 8 is `corrupt`.
     4. For each entry, find its data at `localOffset + 30 + nameLen(local +26) + extraLen(local +28)`. Method 0: the compressed size must equal the declared size. Method 8: pipe `new Blob([slice]).stream()` through `new DecompressionStream("deflate-raw")` and count output bytes; as soon as the entry's count exceeds its declared size, or the running total exceeds `ZIP_MAX_UNCOMPRESSED`, cancel the reader and return `too-large`. At the end, an entry shorter than declared is `corrupt`.
     5. Any out-of-bounds read, signature mismatch or stream error is `corrupt`. Use `DataView` little-endian reads.
- **Success criteria:** All 6 cases pass. Because every entry's real length equals its declared length and the declared total is under 64 MiB, JSZip's later inflate is bounded by the same budget.
- **Verify:** `bunx vitest run src/renderer/lib/preview/zip-guard.test.ts; echo "exit=$?"` ends with `exit=1` before step 5, and with `exit=0` after it.

### Task 2.3 — Locale keys
<!-- Red team: R14 -->
- **Goal:** Every new string exists in both languages, without duplicating an existing action or label.
- **Target files and symbols:** `src/renderer/locales/en.ts` and `vi.ts`. Add these keys next to the `filesPanel.*` block (`en.ts:1140-1146`). The loading state reuses `filesPanel.reading`, and the way out is the header's existing **Open externally** control (`filesPanel.openExternal`), so neither gets a new key:

  | Key | en | vi |
  |---|---|---|
  | `preview.failed` | "This file could not be shown here. Use Open externally to see it." | "Không thể hiển thị tệp này tại đây. Hãy dùng Mở bằng ứng dụng ngoài để xem." |
  | `preview.unsupported` | "Preview is not available for this type of file. Use Open externally to see it." | "Chưa hỗ trợ xem trước loại tệp này. Hãy dùng Mở bằng ứng dụng ngoài để xem." |
  | `preview.tooLarge` | "This file is too large to preview here. Use Open externally to see it." | "Tệp quá lớn để xem trước tại đây. Hãy dùng Mở bằng ứng dụng ngoài để xem." |
  | `preview.reload` | "Reload" | "Tải lại" |

- **Steps:** Add the 4 keys to both files in the same order.
- **Success criteria:** The locale parity test passes.
- **Verify:** `bunx vitest run src/renderer/locales; echo "exit=$?"` ends with `exit=0`.

### Task 2.4 — Red then green: preview target in the ui store, kept across a pane-focus change
<!-- Red team: R8 --> <!-- Validation: path-less images -->
- **Goal:** The preview knows which tab opened it, can hold an in-memory image, and survives a click into the other split pane.
- **Target files and symbols:** `ui.ts`: `export type PreviewTarget`, `filePreview`, `openFilePreview(path: string, tabId?: string | null)`, `openImagePreview(dataUrl: string, name: string)`, `closeFilePreview()`, `closeSessionOverlays(options?: { keepFilePreview?: boolean })`. `tabs.ts`: `switchTab`. `markdown.tsx`: `ExternalLink`.
- **Steps:**
  1. **Red.** In `ui.test.ts`, add the three ui cases from the matrix. In `tabs.test.tsx`, add the two split cases, building the split with `useTabsStore.setState({ split: { axis: "columns", firstTabId: "t0", secondTabId: "t1", ratio: 0.5 } })` (`SplitAxis` is `"columns" | "rows"`, `tabs.ts:83-91`), seeding the tabs the way the file's existing `switchTab` tests do, and opening a preview with `openFilePreview("a.pdf", "t0")`. Run both (red). <!-- Red team: K2 -->
  2. **Green, ui.ts.**
     - `export type PreviewTarget = { kind: "path"; path: string; tabId: string | null } | { kind: "image"; id: number; dataUrl: string; name: string };` A module counter gives each image target a new `id`.
     - Replace `filePreviewPath: string | null` with `filePreview: PreviewTarget | null` (field, initial value, `closeSessionOverlays`).
     - `openFilePreview: (path, tabId = null) => set({ filePreview: { kind: "path", path, tabId }, panelTab: "files", panelVisible: true })`; `openImagePreview` sets the image target the same way; `closeFilePreview` sets `filePreview: null`.
     - `closeSessionOverlays(options = {})` leaves `filePreview` untouched when `options.keepFilePreview` is true.
  3. **Green, tabs.ts.** In `switchTab`, compute `const paneFocus = state.split !== null && (state.split.firstTabId === id || state.split.secondTabId === id);` before `ui.closeSessionOverlays()` and pass `{ keepFilePreview: paneFocus }`. `splitTab` is unchanged.
  4. **Green, markdown.tsx.** In `ExternalLink`, read `const tabId = useRuntimeTabId();` (from `../stores/session-runtime-context`) and call `openFilePreview(filePath, tabId)`.
- **Success criteria:** The new cases pass and every existing ui, tabs and lib test still passes. FilesPanel and `PanelContainer.test.tsx` still name `filePreviewPath` until Task 2.7 moves them, so this task does not run the PanelContainer suite or `check:types`.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/stores/ui.test.ts src/renderer/stores/tabs.test.tsx; echo "exit=$?"` ends with `exit=1`.
  - After step 4: `bunx vitest run src/renderer/stores src/renderer/lib; echo "exit=$?"` ends with `exit=0`.

### Task 2.5 — Red then green: write notifications
<!-- Validation: refresh -->
- **Goal:** The renderer learns, without polling, that a tool call finished writing a path.
- **Target files and symbols:** `src/renderer/components/preview/file-writes.ts`: `writtenPathOf(toolName: string, args: unknown, result: unknown): string | null`, `writeMatchesPreview(write: { tabId: string; path: string }, target: { path: string; tabId: string | null }, resolvedPath: string | null): boolean`, `notifyFileWritten(tabId: string, path: string): void`, `subscribeFileWrites(listener: (write: { tabId: string; path: string }) => void): () => void`. `use-rpc-events.ts`: the `tool_execution_start` and `tool_execution_end` cases inside `reduceEvents`.
- **Steps:**
  1. **Red.** Write `file-writes.test.ts` for the `writtenPathOf` and `writeMatchesPreview` rows. In `use-rpc-events.test.tsx`, add a case with the existing `installTabRoutedMockOmp()` harness: emit `tool_execution_start` (`toolName: "write"`, `args: { path: "table.csv" }`) and then `tool_execution_end` (`isError: false`, `result: { content: [{ type: "text", text: "ok" }], details: { resolvedPath: "/w/table.csv" } }`) for tab `t1`; a `subscribeFileWrites` spy must receive `{ tabId: "t1", path: "/w/table.csv" }` once. A second call pair with `isError: true` must not notify. Run (red).
  2. **Green, `writtenPathOf`.** `write`: `resultDetails(result)?.resolvedPath` when it is a string, else `args.path` when it is a string (`resultDetails` is `src/renderer/lib/format.ts:269`). Office tools (`isOfficeTool`, `src/renderer/components/tools/office-tools.ts:16`): `parseOfficeResult(resultText(result), OFFICE_TOOL_KINDS[name])?.file` (`OfficeFileRenderer.tsx:30`, `format.ts:239`). Anything else: `null`.
  3. **Green, `writeMatchesPreview`.** Normalize both paths (drop a leading `./`, collapse `//`). Match when the write path equals `resolvedPath` or the target path, or when the target path is relative, `write.tabId === target.tabId`, and the absolute write path ends with `/${targetPath}`.
  4. **Green, the bus.** A module-level `Set` of listeners; `notifyFileWritten` calls each inside a try/catch.
  5. **Green, `use-rpc-events.ts`.** Keep a `Map<string, Record<string, unknown>>` of `args` keyed by `` `${tabId}:${toolCallId}` `` in the effect closure, filled on `tool_execution_start` when `toolName === "write" || isOfficeTool(toolName)`. On `tool_execution_end`, take and delete that entry; when `!event.isError`, compute `writtenPathOf(event.toolName, args, event.result)` and, if non-null, call `notifyFileWritten(tabId, path)`. The existing `todo` handling in that case is unchanged.
- **Success criteria:** All the new cases pass and the rest of `use-rpc-events.test.tsx` stays green.
- **Verify:**
  - After step 1: `bunx vitest run src/renderer/components/preview/file-writes.test.ts src/renderer/hooks/use-rpc-events.test.tsx; echo "exit=$?"` ends with `exit=1`.
  - After step 5: the same command ends with `exit=0`.

### Task 2.6 — Red: DocumentPreview behaviour tests
- **Goal:** Pin the shell's states, channels and refresh before the code exists.
- **Target files and symbols:** `src/renderer/components/preview/DocumentPreview.test.tsx`.
- **Steps:**
  1. Copy the linkedom harness from `src/renderer/components/layout/PanelContainer.test.tsx` lines 7–56, including `flush()`, the `ompWindow` save and restore, and mounting inside `I18nProvider`.
  2. Define stub renderers that count mounts: `let mounts = 0; const Stub = ({ content }: PreviewRendererProps) => { useEffect(() => { mounts += 1; }, []); return <div data-stub>{"bytes" in content ? content.bytes.length : `${content.text.length}:${content.truncated}`}</div>; }; const stubRenderers: PreviewRenderers = { docx: Stub, sheet: Stub };`.
  3. Write the `DocumentPreview.test.tsx` cases from the Test Matrix. Render `<DocumentPreview target={…} reloadToken={0} renderers={stubRenderers} />`.
     - The docx case encodes the real bytes of `new JSZip().file("a", "b").generateAsync({ type: "uint8array" })` with `Buffer.from(bytes).toString("base64")`, so `inspectZip` accepts them.
     - Refresh cases call `notifyFileWritten("t0", "/w/a.docx")` with `readDocument` returning `resolvedPath: "/w/a.docx"` on the first read, then `{ ok: true, unchanged: true, … }` or new bytes on the second. Assert the second call's options include `ifChanged: { size, mtimeMs }` from the first read, the `[data-stub]` text, and `mounts === 1`.
     - No polling: `vi.useFakeTimers()`, `await vi.advanceTimersByTimeAsync(10_000)` inside `act`, then expect exactly one read.
     - Assert on `[data-preview-state]`, `[data-stub]` text, the `preview.*` texts, and the `vi.fn` call args.
  4. Run the tests.
- **Success criteria:** The file fails only because `./DocumentPreview` is missing.
- **Verify:** `bunx vitest run src/renderer/components/preview/DocumentPreview.test.tsx; echo "exit=$?"` output contains `Failed to resolve import "./DocumentPreview"` and ends with `exit=1`.

### Task 2.7 — Green: DocumentPreview, the renderer registry and FilesPanel
<!-- Red team: R5, R14, K7 --> <!-- Validation: refresh --> <!-- Validation: path-less images -->
- **Goal:** Implement the shell and make the Files panel use it.
- **Target files and symbols:** `renderers.ts`: `PreviewContent`, `PreviewRendererProps`, `PreviewRenderers`, and `DEFAULT_PREVIEW_RENDERERS = {}` (Phases 3–4 fill it). `DocumentPreview.tsx`: `DocumentPreview`, `PREVIEW_PARSE_MAX_BYTES = 10 * 1024 * 1024`, `previewTargetKey(target)`. `FilesPanel.tsx`.
- **Steps:**
  1. **`DocumentPreview({ target, reloadToken, renderers = DEFAULT_PREVIEW_RENDERERS })`.**
     1. For an image target: state `image` with `target.dataUrl`; no read.
     2. For a path target: `kind = previewKindOf(target.path)`. A `load(mode: "full" | "ifChanged")` function with a request counter that drops stale results:

        | Kind | Read | Result |
        |---|---|---|
        | `unsupported` | none | error `unsupported` |
        | `markdown` or `text` | `fs.read(path, 200_000, tabId ?? undefined)` | State `text` with `{ content, truncated, markdown: kind === "markdown" }`. When `binary` is true, show the existing `filesPanel.binary` text; when not ok, show the existing `filesPanel.readFailed` text. |
        | `csv` | the same `fs.read` with `2_000_000` | `!ok` or `binary` → error `failed`. Otherwise state `rich` with `content = { text: content, truncated }`; the text goes to SheetJS as a string, never re-encoded. |
        | `image` | `fs.readImage(path, tabId ?? undefined)` | `ok` → state `image` with its `dataUrl`. `error === "Image too large"` (`ipc.ts:1059`) → `too-large`; any other failure → `failed`. |
        | `pdf`, `docx`, `pptx`, `sheet` | `readDocumentBytes(path, tabId, mode === "ifChanged" ? stamp : undefined)` | See below |

     3. For the `readDocumentBytes` kinds:
        - `unchanged` → do nothing (state, scroll, sheet and page stay as they are).
        - When not ok: `too-large` → error `too-large`; any other error → error `failed`.
        - When `!expectedSignatures(path).includes(signature)` → error `failed`.
        - When `kind` is `docx` or `sheet` and `bytes.length > PREVIEW_PARSE_MAX_BYTES` → error `too-large` (these parse on the main thread).
        - When the signature is `zip` and `await inspectZip(bytes)` is not ok → error `too-large` or `failed`, matching its `reason`.
        - Otherwise store the stamp `{ size, mtimeMs }` and `resolvedPath`, and set state `rich` with `content = { bytes }`.
     4. Effects: `load("full")` keyed on `[previewTargetKey(target), reloadToken]`, with state `loading` first. A second effect subscribes with `subscribeFileWrites`; when `writeMatchesPreview(write, target, resolvedPath)` holds it calls `load("ifChanged")` for byte kinds and `load("full")` without the loading state for text, markdown and csv. It never sets a timer.
     5. Render into a root `<div className="h-full min-h-0 overflow-auto" data-preview-kind={kind} data-preview-state={state.status}>`. The root is the scroll container and is never keyed, so scroll survives an in-place refresh:

        | State | Renders |
        |---|---|
        | `loading` | `Spinner` + `t("filesPanel.reading")` |
        | `text` | Exactly the markup of today's FilesPanel body (`FilesPanel.tsx:226-250`): `MarkdownRenderer` for markdown, `<pre>` otherwise, with the `filesPanel.truncated` note |
        | `image` | `<img src={dataUrl} alt="" className="mx-auto max-w-full object-contain p-3">` |
        | `rich` | `const Renderer = renderers[kind === "csv" ? "sheet" : kind]`. If it is missing, error `unsupported`. Otherwise `<PanelErrorBoundary key={previewTargetKey(target)}><Suspense fallback={<Spinner size="sm" />}><Renderer content={content} kind={kind} path={path} onError={() => setState({ status: "error", reason: "failed" })} /></Suspense></PanelErrorBoundary>`. The key is the target, never a version: new bytes re-render the same instance. |
        | `error` | A centred message from `preview.unsupported`, `preview.tooLarge` or `preview.failed`. No second open button: the header's **Open externally** is the one way out. |

     6. `previewTargetKey`: `path:${tabId ?? ""}:${path}` or `image:${id}`.
  2. **FilesPanel.**
     1. Delete `PREVIEW_MAX_BYTES`, `PreviewState`, the `preview` state, `previewVersion`, `openPreview`, the `filePreviewPath` effect, `activePreview` and `previewIsMarkdown`.
     2. Read `filePreview` from the store. Tree clicks call `openFilePreview(id.slice(5), tabId)` with the panel's existing `useRuntimeTabId()` value (`FilesPanel.tsx:53`).
     3. Header for a path target: back, path, **Open externally** `PathLink`, a new **Reload** `IconButton` (`RotateCw` from `lucide-react`, label `t("preview.reload")`) that increments a local `reloadToken` state, and insert mention, otherwise unchanged. For an image target: back and the name only.
     4. Body: `<div className="min-h-0 flex-1 overflow-hidden bg-(--omp-code-bg)"><DocumentPreview target={filePreview} reloadToken={reloadToken} /></div>`.
     5. Remove the imports that are now unused (`MarkdownRenderer`, and `Spinner` if unused).
  3. Update the `PanelContainer.test.tsx` lines that set `filePreviewPath` (`:66`, `:154`, `:182`, `:191`) to set `filePreview` (`null`, or `{ kind: "path", path: "docs/report.md", tabId: null }`).
  4. Run the tests.
- **Success criteria:** All `DocumentPreview.test.tsx` cases pass, and the existing PanelContainer preview tests still pass.
- **Verify:**
  - `bunx vitest run src/renderer/components/preview src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=0`.
  - `grep -rn "filePreviewPath" src --include=*.ts --include=*.tsx | wc -l` prints `0`.
  - `grep -cE "setInterval|PREVIEW_POLL" src/renderer/components/preview/DocumentPreview.tsx` prints `0`.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 2.8 — Red then green: docking beside the chat
<!-- Red team: R6, R8, R12, K2, K3 --> <!-- Validation: narrow window -->
- **Goal:** The preview is never an overlay, never rewrites the saved drawer width, and gives the sidebar back on close.
- **Target files and symbols:** `PanelContainer.tsx`: `previewing`, `viewportWidth`, `effectiveWidth`, the className condition (`PanelContainer.tsx:125-130`), the `PanelErrorBoundary` key (`:166`), a new compact-sidebar effect. `global.css`: a new `.omp-inspector[data-docked-preview]` rule. `App.tsx`: the `hideInspector` condition.
- **Steps:**
  1. **Red.** Add the PanelContainer cases from the Test Matrix.
     - **Split:** `useTabsStore.setState({ split: { axis: "columns", firstTabId: "t0", secondTabId: "t1", ratio: 0.5 } })` with no cast.
     - **Pane focus:** with the split and `openFilePreview("a.pdf", "t0")`, mock `fs.readDocument`, mount, then `useTabsStore.setState({ activeTabId: "t1" })`; expect one `readDocument` call whose options carry `tabId: "t0"`.
     - **Width:** innerWidth 1440, a mocked `prefs.get` resolving `403` and a `prefs.set` spy; open a preview; expect `aside.style.width === "576px"`; `await vi.advanceTimersByTimeAsync(1000)`; expect no `prefs.set` call with `576`.
     - **Compact:** set `window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })` and restore it in `afterEach`. Seed `sidebarVisible: true` and a preview; expect `sidebarVisible === false` and `aside.hasAttribute("data-docked-preview")`; then `closeFilePreview()` and expect `sidebarVisible === true`. A second case seeds `sidebarVisible: false` and expects it to stay `false` after close. In `afterEach`, also `useUiStore.setState({ sidebarVisible: true })`.
     - Run (red).
  2. **Green.** In `PanelContainer`:
     1. `const filePreview = useUiStore(s => s.filePreview);` and `const previewing = panelTab === "files" && filePreview !== null;`.
     2. `const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);`, updated inside the existing `clampToViewport` resize handler (`:96-103`).
     3. `const effectiveWidth = previewing && !compact ? Math.max(width, Math.min(MAX_WIDTH, Math.round(viewportWidth * 0.4), Math.max(MIN_WIDTH, viewportWidth - 56))) : width;` and `style={{ width: effectiveWidth }}`. `setWidth` is never called for the preview, so only drags and keys persist through `gui.panelWidth` (`:88-94`). The separator's `aria-valuenow` shows `effectiveWidth`.
     4. Change the overlay condition to `(compact || split) && !previewing ? "absolute inset-y-0 right-0 z-30 shadow-[var(--omp-shadow-lg)]" : "shrink-0"`, and add `data-docked-preview={previewing ? "" : undefined}` to the `<aside>`.
     5. Key the boundary on `previewing ? \`preview:${panelTab}\` : \`${activeTabId ?? "no-tab"}:${panelTab}\``, so a pane-focus change does not remount the preview.
     6. Sidebar: `const hidSidebar = useRef(false);` and `useEffect(() => { const ui = useUiStore.getState(); if (compact && previewing) { if (ui.sidebarVisible) { ui.toggleSidebar(); hidSidebar.current = true; } return; } if (hidSidebar.current) { hidSidebar.current = false; if (!useUiStore.getState().sidebarVisible) ui.toggleSidebar(); } }, [compact, previewing]);`. It restores only what it hid, and only if the user has not reopened the sidebar meanwhile.
  3. In `global.css`, inside the existing `@media (max-width: 1000px)` block and after the `.omp-inspector` rule, add:
     ```css
     .omp-inspector[data-docked-preview] {
     	position: relative;
     	inset-block: auto;
     	right: auto;
     	z-index: 0;
     	isolation: isolate;
     	width: 50vw !important;
     	box-shadow: none;
     }
     ```
     The `!important` beats the compact rule's `width: min(460px, …) !important` by source order. `z-index: 0` with `isolation: isolate` keeps a stacking context, so nothing a document paints can rise above the app.
  4. In `App.tsx`'s `hideInspector`, change the condition to `compact.matches && ui.panelVisible && !(ui.panelTab === "files" && ui.filePreview !== null)`.
- **Success criteria:** The new tests pass, and every existing PanelContainer test still passes.
- **Verify:** `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=1` after step 1, and with `exit=0` after step 4.

### Task 2.9 — Phase gate and commit
- **Goal:** A clean, revertable phase.
- **Target files and symbols:** all the files of this phase.
- **Steps:**
  1. Run `bunx vitest run`.
  2. Run `bun run check:types`.
  3. Run `bunx biome check src/renderer/lib/preview src/renderer/components/preview src/renderer/components/panels/FilesPanel.tsx src/renderer/components/layout/PanelContainer.tsx src/renderer/components/layout/PanelContainer.test.tsx src/renderer/App.tsx src/renderer/stores/ui.ts src/renderer/stores/ui.test.ts src/renderer/stores/tabs.ts src/renderer/stores/tabs.test.tsx src/renderer/lib/markdown.tsx src/renderer/hooks/use-rpc-events.ts src/renderer/hooks/use-rpc-events.test.tsx src/renderer/locales/en.ts src/renderer/locales/vi.ts`.
  4. Run `node scripts/lint-surfaces.mjs`.
  5. Commit with `git commit -m "feat(preview): dock a document preview beside the chat and refresh it after writes"`.
- **Success criteria:** All the gates pass.
- **Verify:** Each of the four commands in steps 1–4 exits 0, and `git log -1 --format=%s` prints `feat(preview): dock a document preview beside the chat and refresh it after writes`.

## Verification

- `bunx vitest run` exits 0.
- `bun run check:types` exits 0.
- `node scripts/lint-surfaces.mjs` exits 0.
- `bun run build` exits 0. Phase 2 adds no new library, so the chunk guard is unchanged.

## Risks & Rollback

- **The existing preview tests depend on the exact `fs.read(path, 200_000)` call.** Task 2.7 keeps that call (with the pinned `tabId` as the third argument when present).
- **`DecompressionStream("deflate-raw")` is missing in a shell.** Electron 44 (Chromium) and WebKitGTK 2.48+ ship it, and Node 26 runs the unit tests with it. The Phase 6 e2e renders every ZIP format in both shells, so a missing API fails there with a page error.
- **A file edited by hand in another app is not refreshed automatically.** By design (no polling); **Reload** covers it.
- **A renderer that threw during render stays on its boundary fallback after an in-place refresh.** **Reload** goes through `loading`, which remounts the boundary.
- **The narrow-window rule reflows the chat.** It applies only while a target is previewed. Closing the preview restores the overlay behaviour and the sidebar.
- **Rollback:** `git revert <phase commit>` restores the old in-panel text preview, `filePreviewPath` and the old `switchTab` behaviour together.

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
