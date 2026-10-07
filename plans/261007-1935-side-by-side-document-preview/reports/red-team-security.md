# Red team (Security Adversary + Fact Checker): side-by-side document preview

Reviewed 2026-10-07: plan.md, phase-01 to phase-06, the evidence packet, the research report, and kongming's verdict. The verdict's defects 1–12 are not repeated here.
Third-party facts come from `npm pack` of `docx-preview@0.4.1`, `@aiden0z/pptx-renderer@1.3.0` and `mtx-decompressor@1.4.2`, unpacked into a scratchpad. Nothing was installed into the repo.

## Finding 1: The ZIP guard trusts sizes that the attacker writes, and its cap is a DoS by itself
- **Severity:** High
- **Location:** Phase 2, Task 2.2 "ZIP bounds guard" step 5.4; plan.md D5; plan.md Risks row "A large docx renders slowly"
- **Flaw:** `checkZipBounds` adds up the *declared* uncompressed size at central-directory offset +24, and the attacker writes that field. Inflation follows the deflate stream, not the declared size. JSZip compares the declared and real lengths only after it has inflated the whole entry. The pptx library's own `RECOMMENDED_ZIP_LIMITS` reads the same declared field: `pptx-renderer.es.js:115` uses `t._data.uncompressedSize`. Even with honest sizes, 256 MiB of XML is enough to freeze the main thread through `DOMParser` and docx-preview, which has no page cap. The mitigation says "the chat stays usable, because the drawer is a sibling of the chat", but layout siblinghood does nothing for a single JS thread.
- **Failure scenario:** A 32 MiB `.docx` declares 1 KB per entry and holds a deflate stream that expands roughly 1000×. It passes `checkZipBounds`, and docx-preview's JSZip inflates about 30 GB. The renderer runs out of memory and the whole window crashes, chat included. The poll in D9 re-triggers the crash on every mtime change. A model-authored markdown link is enough to deliver it.
- **Evidence:** Plan: "Sum the uncompressed size (u32 at +24)… If the sum exceeds the limit, return `too-large`." The research report, line 140, says "docx-preview, JSZip and SheetJS do not [have ZIP limits]". The bridge carries the bytes to the renderer whole: `src/main/ipc.ts:1079`, `src-tauri/src/services/ipc.rs:555`.
- **Suggested fix:** Enforce the real inflated size. Either inflate each entry in a Worker with a streaming byte budget (fflate `Unzip` with a counter) and pass only the re-zipped or extracted parts on, or run the whole parse and render step in a Worker or a separate process that can be killed. Lower the uncompressed cap to about 64 MiB, add a per-entry cap for `word/document.xml` and the sheet XML, and delete the "chat stays usable" mitigation sentence.

## Finding 2: docx-preview CSS injection escapes the shadow root through `:host` and covers the whole app
- **Severity:** High
- **Location:** plan.md D4 ("document CSS cannot reach the app"); Phase 4, Task 4.3 step 4 (`useShadowMount`) and Task 4.4 step 1.4 (host `div` classes); Phase 2, Task 2.7 step 3 (`z-index: auto` on the docked aside)
- **Flaw:** docx-preview builds its stylesheet by string concatenation, without escaping: `styleToString` emits `${key}: ${values[key]};` (`docx-preview.mjs:3866-3875`). Font names pass through `encloseFontFamily` (`:44-46`), which quotes only names that contain whitespace and never escapes them. A `w:rFonts w:ascii="x;}:host{position:fixed;inset:0;z-index:2147483647}"` in `styles.xml` injects rules into the shadow `<style>`. Rules from inside a shadow root can style the **host**, and with `!important` they beat the outer page. The host is a plain light-DOM `div` with no `position`, `contain` or `isolation`. The plan also removes the aside's stacking context (`z-index: auto`), so nothing contains a fixed-position host.
- **Failure scenario:** A received `.docx`, or one the model links to, paints a full-window fake Sai ATLAS UI, for example a fake approval dialog or a "session expired, sign in" panel with an `https` link. The link router then opens the attacker's page in the browser. The overlay also hides the real chat and approval prompts.
- **Evidence:** Phase 4 Task 4.4: `<div ref={hostRef} className="h-full w-full overflow-auto bg-(--omp-code-bg) p-3" data-preview-host="docx" />`. Phase 2: `.omp-inspector[data-docked-preview] { … z-index: auto; … }`. The CSP keeps `style-src 'unsafe-inline'` (`src/renderer/index.html:7`, `src-tauri/tauri.conf.json:16`).
- **Suggested fix:** Put the shadow host inside a wrapper the document cannot style: `position: relative; contain: strict; isolation: isolate; overflow: clip`, plus `transform: translateZ(0)` so the wrapper becomes the containing block for `position: fixed`. Keep a stacking context on the docked aside. Add a unit test that mounts a style containing `:host{position:fixed!important}` and asserts the wrapper's bounding box clips it, and a fixture docx with an injected font name.

## Finding 3: The Tauri handler runs synchronously in the per-window ordered dispatcher, and the 2 s poll can wedge the window
- **Severity:** High
- **Location:** Phase 1, Task 1.5 step 4.7 (`Reply::ok(read_document_file(...))`); plan.md D9 (2000 ms `statOnly` poll)
- **Flaw:** Bridge calls from one window run strictly one at a time, in order, inside `drain()`. A handler that returns `Reply::Ready` does its I/O inline on that loop. A `stat` or a 32 MiB `read` plus base64 encode therefore blocks every later call from that window, and it also ties up a tokio worker. D2 allows absolute paths, so a model link or a Files-panel path can point at a GVFS, sshfs or NFS location (`/run/user/1000/gvfs/…`), where `stat` can hang indefinitely. The poll repeats the call every 2 s.
- **Failure scenario:** The user previews a file on a hung network mount. Every later `omp` IPC from that window queues behind the stuck `stat`: prompt send, abort, settings. `GAP_TIMEOUT` covers only *missing* sequence numbers, so the window freezes with no recovery. Each further poll ties up another worker. Even without a hang, re-reading a 32 MiB file after every change stalls the window's IPC for the whole read and encode.
- **Evidence:** `src-tauri/src/bridge.rs:5-9`: "every handler does its synchronous work before returning (`Reply::Ready`)". `bridge.rs:628-629`: `while let Some(call) = self.next_call(..) { self.run_call(..) }`. `bridge.rs:697-708` dispatches the handler inline. The existing sync read pattern is at `ipc.rs:510` and `ipc.rs:555`.
- **Suggested fix:** Return `Reply::Later` and run the read in `tokio::task::spawn_blocking` with a timeout. Do the same for `statOnly`. In the renderer, stop polling after an error or timeout, and back off instead of firing on a fixed 2 s cadence.

## Finding 4: The size cap is checked at `stat`, then the read has no bound, a step back from the existing image reader
- **Severity:** Medium
- **Location:** Phase 1, Task 1.3 step 4.5–4.6 (`fsp.readFile`); Task 1.5 step 3 (mirrors TS, so `std::fs::read`); plan.md D2 ("the same as `fs:read-image`")
- **Flaw:** The plan checks `stat.size` and then calls `readFile` on the path a second time. A file that grows between the two calls, or a path swapped for a larger file, is read without limit. D9 makes this likely rather than a rare race: the poll re-reads whenever the mtime changes, which is exactly while an agent or app is still writing the file. The existing `fs:read-image` handler avoids this by opening once and reading exactly `stat.size` bytes into a fixed buffer. D2 calls the new channel "the same", and it is not.
- **Failure scenario:** The agent is streaming a large deck or PDF into the previewed path. The poll sees 30 MiB at `stat`, `readFile` returns 400 MiB, and about 530 MB of base64 crosses IPC into the renderer.
- **Evidence:** `src/main/ipc.ts:1057-1066` (open → `handle.read(body, 0, stat.size, 0)`) against the plan's `fsp.readFile`, copied from `src/main/fs-read-pdf.ts` (`stat` then `readFile`).
- **Suggested fix:** Open once, call `fstat` on the handle, and read at most `cap + 1` bytes. Treat more than the cap as `too-large`. In Rust, use `File::open` + `metadata()` + `take(cap + 1)`. Add a twin test that grows the file between `stat` and `read` through a test hook, or at least one that asserts the read is bounded.

## Finding 5: PDF canvas memory has no limit: 50 full-resolution canvases, and page sizes the attacker chooses
- **Severity:** High
- **Location:** Phase 3, Task 3.6 step 1 (`PdfPreview`); plan.md D8 ("Each cap bounds memory")
- **Flaw:** Every page up to 50 renders eagerly into its own canvas at `(clientWidth − 24) × devicePixelRatio`, and all of them stay alive. The page height follows the PDF's MediaBox, so a tall, narrow page produces a canvas of tens of millions of pixels. Calling `page.render` directly skips pdf.js's `maxCanvasPixels`, which only the viewer applies. A remount on every version bump repeats all of it.
- **Failure scenario:** On an ordinary 50-page A4 PDF, with the drawer at `MAX_WIDTH` 840 (`PanelContainer.tsx:15`) and dpr 2, each canvas is about 1632×2308×4 ≈ 15 MB, about 750 MB in total. A crafted PDF with `MediaBox [0 0 1 14400]` asks for a canvas over 23 million pixels tall, past the platform's canvas limits. WebKitGTK renders blank or kills the web process, and the chat goes down with it.
- **Evidence:** The plan's scale is `(container.clientWidth - 24) * devicePixelRatio / page.getViewport({ scale: 1 }).width`, applied "for `i` from 1 to `pages`, sequentially". There is no pixel cap and no virtualization.
- **Suggested fix:** Clamp each page to a pixel budget, for example `maxCanvasPixels = 16_777_216`, and lower the scale to fit. Render only pages near the viewport with `IntersectionObserver` and free off-screen canvases (`canvas.width = 0`). Treat a page with an aspect ratio over 20 as unsupported.

## Finding 6: "One allowlisted opener" is false: pptx shape hyperlinks call `window.open` and never reach the router
- **Severity:** Medium
- **Location:** plan.md D4 ("One capturing click router sends `http`, `https` and `mailto` links… and swallows every other link"); Phase 4, Task 4.1 step 3.3 (matches only `tagName === "A"`)
- **Flaw:** In `@aiden0z/pptx-renderer`, a click on a shape with `hlinkClick` runs an `onclick` on a non-anchor element that calls `onNavigate({ url })`, and `PptxViewer.handleNavigate` then calls `window.open(e.url, "_blank", …)`. That path is at `aiden0z-pptx-renderer.es.js:16003`, `:16659` and `:22843`. No `<a>` is involved, so the router finds no anchor and returns. SVG `<a>` elements also slip through: their `tagName` is lowercase `"a"`, and their `href` may be `xlink:href`. Only the hosts' new-window allowlists stop non-http schemes: `src/main/window.ts:87-90` and `src-tauri/src/webview.rs:231-234`.
- **Failure scenario:** One click anywhere on a large transparent hyperlinked shape in a malicious deck opens an attacker URL in the system browser. This bypasses the plan's chokepoint, and the unit tests cannot catch it because they exercise only HTML anchors.
- **Evidence:** Phase 4 Test Matrix covers only `document.createElement("a")` anchors. The library's `handleNavigate` is at `es.js:22843`.
- **Suggested fix:** Pass an `onNavigate` option, if the viewer accepts one, that routes through `safeExternalHref` (check `dist/types/core/Viewer.d.ts`). Otherwise intercept clicks on any element with a hyperlink marker. In the router, match anchors case-insensitively, read `href.baseVal` / `xlink:href`, and add an SVG-anchor test.

## Finding 7: `mailto:` links, which the plan allowlists and tests, are silently dropped by both shells
- **Severity:** Medium
- **Location:** plan.md D4; Phase 4, Test Matrix row 1 and Task 4.3 step 4.3 (`window.omp.system.openExternal(href)`)
- **Flaw:** `system:open-external` accepts only `http://` and `https://` in Electron (`src/main/ipc.ts:733-737`) and in Tauri (`src-tauri/src/services/system.rs:15-17`, called from `ipc.rs:207-213`). The router prevents the click and passes `mailto:` to an opener that discards it without telling anyone. The unit test proves only that `safeExternalHref` keeps `mailto:`, so the plan claims a behaviour that cannot happen. The plan also lists changes to `system:open-external` as off limits through scope.
- **Failure scenario:** A user clicks a `mailto:` link in a docx and nothing happens. There is no toast and no error, and the e2e never checks it.
- **Evidence:** `ipc.ts:734`: `if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://")))`. `system.rs:16`: `url.starts_with("https://") || url.starts_with("http://")`.
- **Suggested fix:** Drop `mailto:` from the allowlist and from D4, or widen `allowed_external_url` and the Electron check in both shells, with twin tests. That second option is a scope change for the user to approve.

## Finding 8: Task 4.2's API greps use a path that does not exist in the package, so the phase is certain to stop
- **Severity:** Medium
- **Location:** Phase 4, Task 4.2 steps 4–5 and their Verify lines
- **Flaw:** The steps grep `node_modules/@aiden0z/pptx-renderer/dist/*.d.ts`. Version 1.3.0 ships its types under `dist/types/` (`dist/types/index.d.ts`, `dist/types/core/Viewer.d.ts`). `dist/` itself holds only `.es.js`, `.cjs` and `.browser.es.js` files. The glob matches nothing and the greps print nothing, so the Verify step that expects all five names fails, and the Failure Protocol stops Phase 4 even though the API is present: `RECOMMENDED_ZIP_LIMITS`, `lazySlides`, `lazyMedia`, `zipLimits` and `pdfjs` are in `dist/types`, and `static open` is at `Viewer.d.ts:164`.
- **Failure scenario:** Phase 4 always stops at Task 4.2 and spends a kongming round on a path typo.
- **Evidence:** The unpacked package lists `dist/types/`, `aiden0z-pptx-renderer.browser.es.js`, `.cjs` and `.es.js`. Its `package.json` `exports["."].import.types` is `./dist/types/index.d.ts`.
- **Suggested fix:** Grep `-r node_modules/@aiden0z/pptx-renderer/dist/types`. Also note that the package depends on `mtx-decompressor`, a single-maintainer EOT decompressor that parses font bytes the attacker supplies, and on `echarts ^6`. Add both to the pptx chunk rule and to the transitive-dependency review the plan never does.

## Fact-check sample (Fact Checker role)

| Claim (phase) | Result |
|---|---|
| `ipc.rs:483` `fs_read_image` (D2) | VERIFIED `src-tauri/src/services/ipc.rs:483` |
| `fs.rs:7-12` trust contract (D2) | VERIFIED `src-tauri/src/services/fs.rs:7-12` |
| `ipc.ts:104` `cwdFor`, `:241` `resolveWithin` (P1) | VERIFIED `src/main/ipc.ts:104`, `:241` |
| `ipc.ts:1013` `sniffImageMime`, `:1079` `FS_READ_PDF` (P1) | VERIFIED `src/main/ipc.ts:1013`, `:1079` |
| "`fs:read-document` reads the same as `fs:read-image`" (D2) | FAILED: the image reader does a bounded handle read (`ipc.ts:1057-1066`); the plan uses `readFile` |
| `ipc-types.ts` `FS_READ_PDF` ~190, `IpcFsReadPdfResult` ~757, `OmpApi.fs` ~1316 (P1) | VERIFIED approximately: `:192`, `:752`, `readPdf` `:1330` |
| `create-omp-api.ts` `fs:` block ~359 (P1) | VERIFIED approximately: `readPdf` at `:379` |
| `read_pdf_file` ~565, `mod tests` ~589 (P1) | `read_pdf_file` is at `:535` (off by 30); `mod tests` VERIFIED `:589` |
| `mod.rs` `CHANNELS` ~58, `register` ~91 (P1) | VERIFIED `:58`, and `fs:read-pdf` registration at `:93` |
| `workspace_fs::sniff_image_mime` / `resolve_within` / `ctx.tabs.cwd_for` / `expand_home` (P1) | VERIFIED `fs.rs:296`, `fs.rs:146`, `ports.rs:597`, `ipc.rs:18` |
| `tempfile` available for Rust tests (P1) | VERIFIED `src-tauri/Cargo.toml:69` |
| `ui.ts:191` `openFilePreview` (plan, P5) | VERIFIED `src/renderer/stores/ui.ts:191` |
| `PanelContainer.tsx:125` overlay class (D1) | VERIFIED approximately at `:127`; `MAX_WIDTH = 840` at `:15` |
| `global.css:705` compact rule (D1) | VERIFIED `src/renderer/styles/global.css:705-713` |
| `vite.renderer.shared.ts:20` `VENDOR_CHUNK_RULES`; `plugins: [tailwindcss()]` (P3) | VERIFIED `:20`, `:74` |
| `check-renderer-chunks.ts:13` `LAZY_CHUNKS`, "entry is lean … none of" (P3) | VERIFIED approximately at `:14`; message at `:53` |
| `pdf-thumbnail.ts` private `loadPdfJs`, `decodeBase64`, `getDocument` (P3) | VERIFIED `:105`, `:32`, `:143` |
| `buildReport` / `buildSlides` / `notes-en.md` fixtures (P3) | VERIFIED `assistant-pack/src/office/report.ts:229`, `slides.ts:526`, file exists |
| `exceljs`, `jszip` devDeps; `pdfjs-dist` dep (P2, P3) | VERIFIED `package.json:104-105`, `:73` |
| `e2e/runtime.e2e.ts` uses `writeDesktopPrefs`; `e2e/sidecar-fixture.ts` exists (P6) | VERIFIED `:6`, `:15`; file exists |
| "Open workspace" / "Back to files" selectors (P6) | VERIFIED `src/renderer/locales/en.ts:35`, `:1143` |
| `PathLink` renders a `button` (P2, P6 "a button whose text is Open in its app") | VERIFIED `src/renderer/components/tools/PathLink.tsx` |
| docx-preview options `renderAltChunks`, `useBase64URL` (P4) | VERIFIED in `docx-preview.d.ts:32,35` (package) |
| pptx `PptxViewer.open`, `RECOMMENDED_ZIP_LIMITS`, `pdfjs` option (P4) | VERIFIED `dist/types/core/Viewer.d.ts:164,29-30`, `index.d.ts` (package) |
| pptx types at `dist/*.d.ts` (P4 Task 4.2) | FAILED: they are under `dist/types/` |
| `mailto` routes to `system.openExternal` (D4) | FAILED: `ipc.ts:734`, `system.rs:16` accept only http/https |
| "ZIP limits bound zip bombs" (D5; pptx `RECOMMENDED_ZIP_LIMITS`) | FAILED: both use declared sizes (plan Task 2.2; `pptx-renderer.es.js:115`) |

Status: DONE_WITH_CONCERNS
Summary: Found 8 new security and robustness defects. The two that break the plan's isolation and DoS claims are the declared-size zip guard (Finding 1) and the docx CSS injection through `:host` (Finding 2). Findings 3 and 5 can freeze or crash the window: the synchronous Tauri handler polled every 2 s, and unbounded PDF canvases. Finding 8 is a guaranteed stop at Task 4.2.
Concerns: The third-party findings (2, 6, 8) rest on the npm tarballs unpacked in the scratchpad, not on installed `node_modules`. The executor should re-confirm them after `bun add`. CSS `!important` precedence for `:host` and fixed positioning inside an unpositioned aside in WebKitGTK are from the cascade spec and were not reproduced in a browser.
