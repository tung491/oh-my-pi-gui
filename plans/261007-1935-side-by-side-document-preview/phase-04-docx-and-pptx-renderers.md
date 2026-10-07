---
phase: 4
title: "DOCX and PPTX renderers"
status: pending
priority: P1
effort: "5h"
dependencies: [3]
---
# Phase 4: DOCX and PPTX renderers

## Goal

Render .docx with docx-preview and .pptx with `@aiden0z/pptx-renderer`, each
inside an open shadow root whose host sits in a **containment frame** the
document cannot style its way out of. The hardened options are pinned by
tests. Every link inside a document, including SVG anchors and pptx shape
hyperlinks, goes through one allowlisted opener. A render that resolves after
its preview was torn down is disposed at once. Each renderer marks its host
`data-rendered` only after the library has drawn, so the e2e cannot pass before
the renderer runs. Both libraries load lazily and re-render in place when new
bytes arrive.
<!-- Red team: R6, R9, R13, R15 -->

## Files to Create / Modify

- **Create:**
  - `src/renderer/lib/preview/safe-links.ts`, `src/renderer/lib/preview/safe-links.test.ts`
  - `src/renderer/components/preview/shadow-mount.ts`, `src/renderer/components/preview/shadow-mount.test.tsx` <!-- Red team: R13 -->
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
| `safeExternalHref` keeps `https://example.com/a`, `http://x.y`, `mailto:a@b.c` (both shells open `mailto:` since Phase 1) <!-- Validation: mailto --> | `safe-links.test.ts` | exit 1 | pass |
| `safeExternalHref` returns null for `javascript:alert(1)`, `file:///etc/passwd`, `data:text/html,x`, `vbscript:x`, `#frag`, `relative/path` and `` | same | exit 1 | pass |
| `routeDocumentLinkClicks`: a click on an `https` anchor is `defaultPrevented` and `open` is called once with its href | same | exit 1 | pass |
| A click on a `javascript:` anchor, or a nested `<span>` inside a `file:` anchor, is `defaultPrevented` and `open` is not called | same | exit 1 | pass |
| A click inside an SVG `<a>` whose link is in `xlink:href` is prevented and routed; an SVG `<a>` with a `javascript:` `href` is prevented and not opened <!-- Red team: R15 --> | same | exit 1 | pass |
| `auxclick` on an `https` anchor is also routed and prevented | same | exit 1 | pass |
| The returned disposer removes the listeners (a later click is not prevented) | same | exit 1 | pass |
| `DOCX_RENDER_OPTIONS` has `renderAltChunks: false`, `useBase64URL: true`, `inWrapper: true` and `className: "docx"` | `office-render-options.test.ts` | exit 1 | pass |
| `pptxViewerOptions(limits, open)` has `pdfjs: false`, `lazySlides: true`, `lazyMedia: true` and `zipLimits === limits` | same | exit 1 | pass |
| `pptxViewerOptions(limits, open).onNavigate({ url: "https://a.b" })` calls `open("https://a.b")` once; `{ url: "javascript:x" }` and `{ url: "file:///x" }` call nothing (a pptx shape hyperlink is routed) <!-- Red team: R15 --> | same | exit 1 | pass |
| `PREVIEW_FRAME_CLASS` contains `relative`, `overflow-clip`, `isolate`, `[contain:strict]` and `[transform:translateZ(0)]` (the `:host` injection stays clipped; geometry is checked in Phase 6) <!-- Red team: R6 --> | same | exit 1 | pass |
| `useShadowMount`: unmounting before a deferred render resolves aborts its signal, and the disposer the render later returns runs exactly once <!-- Red team: R13 --> | `shadow-mount.test.tsx` | exit 1 | pass |
| `useShadowMount`: a normal unmount runs the disposer once and removes `data-rendered` from the host; `data-rendered="true"` is set only after the render resolves <!-- Red team: R9 --> | same | exit 1 | pass |
| The build keeps the `docx`, `pptx` and `jszip` chunks lazy | `bun run build` | rule missing | pass |

## Tasks

### Task 4.1 — Red then green: link routing
<!-- Red team: R15 -->
- **Goal:** No document link can navigate the webview, and only web and mail links open, through the system.
- **Target files and symbols:** `safe-links.ts`: `safeExternalHref` and `routeDocumentLinkClicks`.
- **Steps:**
  1. Write the tests with the linkedom harness (`parseHTML`), building HTML anchors with `document.createElement("a")` and SVG anchors with `document.createElementNS("http://www.w3.org/2000/svg", "a")` plus `setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", …)`. Dispatch `new Event("click", { bubbles: true, cancelable: true })` and the same for `"auxclick"`. Run them (red).
  2. Implement `safeExternalHref(href)`: return null when `href.trim()` is empty. Otherwise parse with `new URL(href)` inside a try (relative URLs throw, and that gives null) and return `href` only when `url.protocol` is `http:`, `https:` or `mailto:`.
  3. Implement `routeDocumentLinkClicks(root, open)`:
     1. Define a handler `(event: Event) => { … }`.
     2. In it, set `path = typeof event.composedPath === "function" ? event.composedPath() : []`. When `path` is empty, walk from `event.target` through `parentNode`.
     3. Find the first `Element` whose `localName === "a"` (HTML `A` and SVG `a` alike) and that has a link: `el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href")`. If there is none, return.
     4. Call `event.preventDefault()` and `event.stopPropagation()`. Then `const safe = safeExternalHref(link)`, and if it is truthy, call `open(safe)`.
     5. Register it with `root.addEventListener("click", handler, true)` and the same for `"auxclick"`, and return a disposer that removes both.
- **Success criteria:** All the safe-links cases pass.
- **Verify:** `bunx vitest run src/renderer/lib/preview/safe-links.test.ts; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after step 3.

### Task 4.2 — Install the libraries and confirm their APIs
<!-- Red team: R11, R15 -->
- **Goal:** Pinned versions, and the option names this plan relies on actually exist in the installed type declarations and bundle.
- **Target files and symbols:** `package.json` `dependencies`; `bun.lock`.
- **Steps:**
  1. Run `bun add docx-preview@0.4.1 @aiden0z/pptx-renderer@1.3.0 --exact`.
  2. Run `grep -rl "renderAltChunks" node_modules/docx-preview/dist | head -1`.
  3. Run `grep -rl "useBase64URL" node_modules/docx-preview/dist | head -1`.
  4. Run `grep -rho "RECOMMENDED_ZIP_LIMITS\|lazySlides\|lazyMedia\|zipLimits\|pdfjs\|onNavigate" node_modules/@aiden0z/pptx-renderer/dist/types | sort -u`. The 1.3.0 package keeps its declarations under `dist/types/` (`package.json` `"types": "./dist/types/index.d.ts"`), not in `dist/`.
  5. Run `grep -rhoE "(static )?(async )?open\(|destroy\(" node_modules/@aiden0z/pptx-renderer/dist/types | sort -u`.
  6. Run `grep -rn "interface [A-Za-z]*Options" node_modules/@aiden0z/pptx-renderer/dist/types/core/Viewer.d.ts` and record the viewer options type name for Task 4.3 step 3.
  7. Run `grep -n "handleNavigate" -A12 node_modules/@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.es.js | head -40` and record whether `handleNavigate` calls a user `onNavigate` **instead of** `window.open`. [UNVERIFIED: the red team found `window.open(e.url, "_blank", …)` in `handleNavigate`; whether a user `onNavigate` replaces it is not known.]
  8. Run `ls node_modules/@aiden0z/pptx-renderer/dist | grep -i "\.css$"`. The red team found none; record the result for Task 4.4.
  9. Run `bun pm ls --all 2>/dev/null | grep -E "mtx-decompressor|echarts|zrender|jszip|pako"` and record which transitive packages exist for the chunk rule in Task 4.5.
- **Success criteria:** Both versions are installed exactly, every name is found, and the pptx library routes shape hyperlinks to a user `onNavigate` without also calling `window.open`.
- **Verify:**
  - `grep -c '"docx-preview": "0.4.1"' package.json` prints `1`.
  - `grep -c '"@aiden0z/pptx-renderer": "1.3.0"' package.json` prints `1`.
  - Steps 2 and 3 each print one path.
  - Step 4 prints all six names: `RECOMMENDED_ZIP_LIMITS`, `lazyMedia`, `lazySlides`, `onNavigate`, `pdfjs`, `zipLimits`.
  - Step 5 prints at least one `open(` and one `destroy(`.
  - Step 6 prints at least one line.
  - Step 7 shows that a provided `onNavigate` is called and `window.open` is skipped. If `onNavigate` is missing, or `window.open` still runs with it set, apply the Failure Protocol. Do not override `window.open`; the hosts' new-window allowlists (`src/main/window.ts:87-90`, `src-tauri/src/webview.rs:231-234`, http/https only) remain the backstop meanwhile.

### Task 4.3 — Red then green: pinned render options, the containment frame and the shadow mount
<!-- Red team: R6, R9, R13, R15 -->
- **Goal:** The hardening cannot be removed silently, document CSS cannot escape its frame, and no late render leaks.
- **Target files and symbols:** `office-render-options.ts`: `DOCX_RENDER_OPTIONS`, `pptxViewerOptions(zipLimits, open)` and `PREVIEW_FRAME_CLASS`. `shadow-mount.ts`: `useShadowMount(render: (mount: HTMLDivElement, root: ShadowRoot, signal: AbortSignal) => Promise<() => void>, deps: unknown[]): RefObject<HTMLDivElement | null>`.
- **Steps:**
  1. Write `office-render-options.test.ts` for its matrix rows, and `shadow-mount.test.tsx` with the linkedom harness: a render that returns a promise the test resolves later with a `vi.fn` disposer. Import only `office-render-options.ts` and `shadow-mount.ts`, neither of which imports a library at runtime. Run them (red).
  2. Implement `DOCX_RENDER_OPTIONS = { className: "docx", inWrapper: true, breakPages: true, renderAltChunks: false, useBase64URL: true, experimental: false } as const`.
  3. Implement `pptxViewerOptions(zipLimits, open: (href: string) => void)` returning `{ zipLimits, lazySlides: true, lazyMedia: true, listOptions: { windowed: true }, pdfjs: false, onNavigate: ({ url }: { url: string }) => { const safe = safeExternalHref(url); if (safe) open(safe); } }`. Annotate the return type with the options type recorded in Task 4.2 step 6, imported with `import type` only, so `check:types` proves every name.
  4. `export const PREVIEW_FRAME_CLASS = "relative h-full w-full overflow-clip isolate [contain:strict] [transform:translateZ(0)]";`. The transform makes the frame the containing block for a `position: fixed` host, and the clip and containment keep anything a document's `:host` rules do inside the frame.
  5. Implement `useShadowMount`. It keeps a host `ref`. Its effect:
     1. Gets `root = host.shadowRoot ?? host.attachShadow({ mode: "open" })` and calls `root.replaceChildren()`.
     2. Creates `mount = document.createElement("div")` and appends it.
     3. Calls `const unroute = routeDocumentLinkClicks(root, href => void window.omp.system.openExternal(href))`.
     4. Creates an `AbortController`, then calls `render(mount, root, controller.signal)`. When it resolves: if the effect was cleaned up, call the returned disposer at once; otherwise keep it and set `host.setAttribute("data-rendered", "true")`. A rejection is the renderer's to report (each renderer catches and calls `onError`).
     5. Cleanup: `controller.abort()`, call the kept disposer (once), `unroute()`, `host.removeAttribute("data-rendered")`, then `root.replaceChildren()`.
- **Success criteria:** The options and shadow-mount tests pass.
- **Verify:** `bunx vitest run src/renderer/components/preview/office-render-options.test.ts src/renderer/components/preview/shadow-mount.test.tsx; echo "exit=$?"` ends with `exit=1` before step 2, and with `exit=0` after step 5.

### Task 4.4 — DocxPreview and PptxPreview
<!-- Red team: R5, R6, R9, K8 --> <!-- Validation: refresh -->
- **Goal:** Real renders inside the shadow roots, re-rendered in place on new bytes.
- **Target files and symbols:** `DocxPreview.tsx` (default export) and `PptxPreview.tsx` (default export), both `(props: PreviewRendererProps) => ReactElement`. Both receive `content.bytes` (Phase 2 refuses docx over 10 MiB before they mount).
- **Steps:**
  1. **DocxPreview.**
     1. `useShadowMount(async (mount, root, signal) => { … }, [content.bytes])`. Inside: `const { renderAsync } = await import("docx-preview"); if (signal.aborted) return () => {}; await renderAsync(content.bytes, mount, mount, DOCX_RENDER_OPTIONS);`. Wrap the body in a try/catch that calls `onError` and returns a no-op disposer.
     2. Fit the page to the drawer through the shadow host (the callback has no host parameter): `const host = root.host as HTMLElement; const fit = () => { const page = mount.querySelector<HTMLElement>("section.docx"); if (page) mount.style.zoom = String(Math.min(1, (host.clientWidth - 24) / page.offsetWidth)); }; fit();`.
     3. Observe `host` with a `ResizeObserver` that calls `fit`, and return `() => observer.disconnect()` as the disposer.
     4. Render `<div className={PREVIEW_FRAME_CLASS} data-preview-frame><div ref={hostRef} className="h-full w-full overflow-auto bg-(--omp-code-bg) p-3" data-preview-host="docx" /></div>`.
  2. **PptxPreview.**
     1. `useShadowMount(async (mount, _root, signal) => { const lib = await import("@aiden0z/pptx-renderer"); if (signal.aborted) return () => {}; const viewer = await lib.PptxViewer.open(content.bytes.buffer.slice(content.bytes.byteOffset, content.bytes.byteOffset + content.bytes.byteLength), mount, pptxViewerOptions(lib.RECOMMENDED_ZIP_LIMITS, href => void window.omp.system.openExternal(href))); return () => viewer.destroy(); }, [content.bytes])`, with a try/catch that calls `onError`.
     2. If Task 4.2 step 5 showed a different call shape (for example a constructor plus `open`), use the shape from the `.d.ts`. The options object stays exactly `pptxViewerOptions(...)`.
     3. If Task 4.2 step 8 found a CSS file, import it with `?inline`, and inside the render callback before opening run `const style = document.createElement("style"); style.textContent = css; root.prepend(style);`.
     4. Render the same frame with `data-preview-host="pptx"`.
  3. Update `renderers.ts` to add `docx: lazy(() => import("./DocxPreview"))` and `pptx: lazy(() => import("./PptxPreview"))`.
- **Success criteria:** The types compile, and no unit test regresses. The real render, the `data-rendered` marker and the frame geometry are verified in Phase 6.
- **Verify:**
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.
  - `bunx vitest run; echo "exit=$?"` ends with `exit=0`.
  - `grep -c "PREVIEW_FRAME_CLASS" src/renderer/components/preview/DocxPreview.tsx src/renderer/components/preview/PptxPreview.tsx` prints a count of at least `1` for each file.

### Task 4.5 — Lazy chunks for docx, pptx and jszip
<!-- Red team: R11 -->
- **Goal:** These libraries and their transitive parsers stay out of the entry chunk.
- **Target files and symbols:** `VENDOR_CHUNK_RULES` and `LAZY_CHUNKS`.
- **Steps:**
  1. Append these rules to `VENDOR_CHUNK_RULES`, before the `xterm` rule's comment or at the end of the array. Include in the pptx alternation only the packages Task 4.2 step 9 found:
     - `[/[\\/]node_modules[\\/]docx-preview[\\/]/, "docx"]`
     - `[/[\\/]node_modules[\\/](@aiden0z[\\/]pptx-renderer|echarts|zrender|mtx-decompressor)[\\/]/, "pptx"]`
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

- **docx-preview builds its stylesheet without escaping font names** (`styleToString`, `encloseFontFamily` in docx-preview 0.4.1), so a document can inject `:host` rules. The containment frame keeps the result inside the drawer, the docked aside keeps its own stacking context (Phase 2 CSS), and Phase 6 checks it with `injected-font.docx`.
- **docx-preview and JSZip parse on the main thread.** The 10 MiB parse cap (Phase 2) and the real-inflate ZIP budget of 64 MiB (Phase 2) bound the work; a large document can still pause the UI briefly.
- **A transitive dependency such as `tslib` or `lodash` lands in the `pptx` chunk and is also used eagerly**, so the entry imports `pptx`. The chunk guard names the file. Remove that package from the rule; do not add it to the rule.
- **docx-preview renders too wide for a narrow drawer.** The CSS `zoom` fit handles it, and it is checked in the Phase 6 e2e.
- **Rollback:** `git revert <phase commit>`. Docx and pptx then show "not available"; the header's **Open externally** stays the way out.

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
