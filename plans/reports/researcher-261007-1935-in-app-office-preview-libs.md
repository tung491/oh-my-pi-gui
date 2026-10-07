# In-app read-only preview of DOCX / PPTX / XLSX / CSV / PDF (client-side only)

Date: 2026-10-07 (Asia/Seoul). Scope: libraries that run inside the React 19 + Vite renderer on WebKitGTK (Tauri, Linux) and Chromium (Electron 44, macOS), under the app CSP, with no server, no LibreOffice and no headless renderer.

## Recommendation

| Format | Primary | Fallback when it fails or renders badly |
|---|---|---|
| PDF | `pdfjs-dist` 6.4.299, used directly (one canvas per page, optional text layer) | none needed; on load error show "Open with system app" |
| DOCX | `docx-preview` 0.4.1 with hardened options, rendered into a shadow root | `mammoth` 1.13.0 → DOMPurify → simple reading view; then "Open with system app" |
| PPTX | `@aiden0z/pptx-renderer` 1.3.0 | own JSZip extractor (slide titles, text runs, pictures per slide); then "Open with system app" |
| XLSX | SheetJS CE 0.20.3 (vendored tarball, not npm) → own React table | values-only table is already the degraded mode; "Open with system app" |
| CSV | SheetJS CE (same code path and table as XLSX) | none needed |

The rationale, in one line per format:

- **PDF.** pdf.js is the only serious option. Version 6 removed `isEvalSupported` and contains no `new Function` (both checked by grep), so it is CSP-clean.
- **DOCX.** docx-preview is the only maintained docx library that lays the document out as pages. Mammoth is semantic HTML only.
- **PPTX.** aiden0z is the only maintained, permissively licensed renderer with real fidelity (shapes, charts, SmartArt fallbacks, tables), and it documents a security posture. Every other pptx renderer is abandoned, closed-source or a toy.
- **XLSX.** SheetJS has the most robust parser for arbitrary user files (WPS, old Excel, odd encodings) at about 120 KB gz. The catch is its distribution: the npm package is frozen at a vulnerable version (see below).

## Measured facts

Sizes come from esbuild (browser, ESM, minified), measured as gzip -9 of the entry each preview would actually import. Every library can be loaded lazily with `import()` behind the preview route, so none of this cost lands in the main chunk.

| Library | Version, release date | License | min+gz | TS types | Repo health |
|---|---|---|---|---|---|
| pdfjs-dist | 6.4.299, 2026-10-03 | Apache-2.0 | 126 KB main + 365 KB worker | bundled | 54k stars, very active (pushed 2026-10-07) |
| docx-preview | 0.4.1, 2026-09-21 | Apache-2.0 | 20 KB (+29 KB jszip) | bundled | 2.1k stars, 81 open issues, active |
| mammoth | 1.13.0, 2026-09-26 | BSD-2 | 90 KB (browser build) | bundled | 6.3k stars, 61 open issues, active |
| @aiden0z/pptx-renderer | 1.3.0, 2026-09-14 | Apache-2.0 | 141 KB without echarts/jszip; 350 KB with echarts | bundled | 127 stars, 7 open issues, active, single maintainer |
| pptx-preview | 1.0.7, 2025-10-17 | ISC | 391 KB (echarts inside) | bundled | **no public source repo**; author contact is a WeChat ID |
| pptx-viewer (mdurbar) | 0.2.2, 2026-04-13 | MIT | 30 KB | bundled | 8 stars, 22 open issues |
| PPTXjs (meshesha) / pptx2html | last push 2022 | MIT | n/a | none | abandoned, jQuery + d3 v4 |
| PptxGenJS | 4.0.1 | MIT | n/a | | **write-only, cannot read pptx** |
| SheetJS CE (`xlsx`) | 0.20.3 on cdn.sheetjs.com; npm is stuck at 0.18.5 | Apache-2.0 | 120 KB | bundled | maintained off-GitHub (git.sheetjs.com) |
| exceljs | 4.4.0, **2023-10-19** | MIT | 263 KB (dist build) | bundled | 15k stars, **816 open issues**, last push 2025-01 |
| read-excel-file | 9.3.10, 2026-08-10 | MIT | 16 KB | none in manifest | 328 stars, 2 open issues |
| papaparse | 5.7.0, 2026-08-24 | MIT | 7 KB | via @types | stable |

CSP scan (grep of the built bundles for `eval(`, `new Function`, `Function("`):

- **pdfjs-dist (main and worker), SheetJS, read-excel-file, papaparse and pptx-viewer:** zero hits.
- **docx-preview, aiden0z, mammoth, exceljs and pptx-preview:** each hit is a dead fallback that never runs in a modern engine.
  - JSZip's `setImmediate` polyfill runs `new Function` only on a string argument.
  - lodash and underscore use `Function("return this")` only when `self` and `globalThis` are missing.
  - The regenerator in exceljs falls back to `Function` only when `globalThis` is missing.
  - The echarts JSON fallback in pptx-preview runs only when `JSON` is missing.
- **Conclusion:** none of these trips `script-src 'self'` in practice.

## Per-format detail

### PDF: pdfjs-dist 6.4.299

How to set it up:

- Load the worker as a same-origin asset with `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"` and `GlobalWorkerOptions.workerSrc = workerUrl`. `worker-src 'self' blob:` already allows it.
- Do not use the viewer app in `web/`. Render pages to `<canvas>` with the core API, plus a `TextLayer` if the user should be able to select text.
- **WASM is the CSP trap.** pdf.js 6 decodes JPEG2000, JBIG2 and ICC colour through `.wasm` files, which need `'wasm-unsafe-eval'` in the CSP. The app CSP does not allow it. Pass `useWasm: false`; the package ships pure-JS `*_nowasm_fallback.js` decoders, and those contain no eval. The alternative is adding `'wasm-unsafe-eval'` to `script-src`, a policy change that should not be made just for a preview.
- Set `wasmUrl`, `cMapUrl`, `standardFontDataUrl` and `iccUrl` to self-hosted copies of `pdfjs-dist/{wasm,cmaps,standard_fonts,iccs}`, about 4 MB on disk. Copy them with Vite `publicDir` or a static-copy step. Without `cMapUrl`, CJK PDFs render as blanks; without standard fonts, PDFs that do not embed their fonts render poorly. These are local files only, never CDN fetches.
- Keep `enableScripting` off (it is off by default without the viewer). Then `quickjs-eval.wasm` and `pdf.sandbox` are never loaded, so PDF JavaScript cannot run.

Risks:

- **Engine floor.** The modern build calls `Promise.try`, `Math.sumPrecise`, `Uint8Array.fromBase64`, `Float16Array` and iterator helpers. Some calls are feature-detected; I did not verify that all of them are.
  - The dev host's WebKitGTK is 2.52.6 (Ubuntu 26.04) and Electron 44 is current Chromium, so both are fine there.
  - SAI OS's actual WebKitGTK version is unknown. If it is older than about 2.48, use `pdfjs-dist/legacy/build/*` (same API, about 15% larger).
  - Decide this with one smoke test on SAI OS.
- **Links.** External links come through the annotation layer. Intercept clicks and route them through the app's existing external-link opener; never let them navigate the webview.
- **Alternative.** `react-pdf` 11 (MIT) wraps the same library but pins pdfjs 6.3.289, one release behind. It saves about 80 lines and costs version lag. Use pdfjs-dist directly.
- **Rejected.** PDFium-WASM viewers such as `@embedpdf/pdfium` need `'wasm-unsafe-eval'` and are larger.

### DOCX: docx-preview 0.4.1 (primary), mammoth 1.13.0 (fallback)

docx-preview builds the DOM with `createElement`; text is set safely. It does have three hazards. Each one was found in its source and has a fix.

1. **`renderAltChunks` defaults to true.** An altChunk (HTML embedded in the docx) is rendered into an `<iframe srcdoc>` with **no `sandbox` attribute**. The srcdoc document inherits the CSP, so inline script is still blocked, but this is untrusted HTML inside the app origin. Pass `renderAltChunks: false`.
2. **Hyperlink targets are copied verbatim** from the relationship file into `href`. A `javascript:` link is blocked by `script-src 'self'`, since there is no `'unsafe-inline'`, but `http(s)`/`file:` links would navigate the webview. Intercept clicks on the container: call `preventDefault()`, allowlist `http`, `https` and `mailto`, and open through the system.
3. **Embedded fonts are loaded as `@font-face url(blob:…)`, which `font-src 'self' data:` blocks.** Pass `useBase64URL: true`; images and fonts then become `data:` URLs, which both `img-src` and `font-src` allow.

Further notes:

- **Shadow root.** Render into a shadow root (`renderAsync(buf, shadowBody, shadowStyle, opts)`). The library injects `<style>` blocks derived from the document. They are prefixed with the `docx` class, but they should still not reach the app's global CSS. `style-src 'unsafe-inline'` permits them, and `dangerousDisableAssetCspModification: ["style-src"]` keeps Tauri from adding nonces that would disable `'unsafe-inline'`.
- **No beacons.** Remote images (`TargetMode="External"`) are blocked by `img-src`, so a document cannot call home.
- **Fidelity.** Good for text, styles, tables, lists, headers/footers, footnotes and images, and fine for output of the `docx` 9.8 library.
- **Weaknesses.**
  - Pagination is approximate: it breaks pages only at explicit and last-rendered page breaks.
  - Fields are not computed: TOC, page numbers and dates show their cached text.
  - Charts, SmartArt and complex floating/anchored shapes are weak or missing.
  - WMF/EMF images do not render.
  - Fonts fall back to SAI OS system fonts, so line breaks differ from Word.
- **Mammoth (fallback).** It produces semantic HTML only (headings, paragraphs, lists, tables, images, links) and ignores layout. Its README states that it does **not sanitise**, so its output must go through DOMPurify (3.4.16) with a URL allowlist before insertion. Use it only when docx-preview throws. It costs 90 KB gz, loaded lazily, and is otherwise dead weight. If that cost is unwelcome, skip mammoth and fall straight to "Open with system app". That is the KISS option, and I would accept it.

### PPTX: @aiden0z/pptx-renderer 1.3.0 (primary), own JSZip extractor (fallback)

- **API.** `PptxViewer.open(buffer, container, { zipLimits: RECOMMENDED_ZIP_LIMITS, lazySlides: true, lazyMedia: true, listOptions: { windowed: true }, pdfjs: false })`.
- **Security (verified in source and README).**
  - ZIP parse limits are available, so pass `RECOMMENDED_ZIP_LIMITS` for user files.
  - Hyperlinks are protocol-filtered and opened with `target=_blank rel=noopener`. Still intercept them so they open through the system.
  - Text uses `textContent`. The single `innerHTML` assignment first escapes `&`, `<` and `>`.
  - Embedded fonts load through the `FontFace` API from bytes, which is not a fetch, so `font-src` is not involved.
  - Media uses `blob:` URLs, which `img-src` and `media-src` allow.
  - The EMF-PDF fallback runs a blob module Worker; `worker-src blob:` allows it.
- **pdfjs option.** Set `pdfjs: false`. Otherwise it tries a "best-effort automatic resolution" of pdf.js. If PDF preview ships anyway, pass the self-hosted pdfjs URLs from the PDF section instead, and EMF fallback previews then work too.
- **Bundle.** Import the package entry, not `*.browser.es.js`. That way Vite shares the app's JSZip and tree-shakes the modular `echarts/*` imports. The result is about 140 KB gz of renderer plus echarts' chart parts, roughly 350 KB gz in total, all in a lazy chunk.
- **Fidelity.** Shapes, gradients, tables, charts (echarts), groups, OMML equations and SmartArt via its fallback image. It has a visual-regression suite against PowerPoint ground truth. pptxgenjs 4.0 output (text boxes, tables, native charts, images) falls squarely inside that coverage.
- **Gaps.** No EMF/WMF vector rendering, no animations or transitions, and font metric drift on SAI OS.
- **Adoption risk:** medium. The project is young (127 stars, one maintainer), but it releases actively and has CI and coverage. Pin the exact version. Keep the fallback because a bus-factor-of-one dependency may stall.
- **Fallback (sane, about 150 LOC).** Use the JSZip already in devDependencies.
  - Read `ppt/presentation.xml` for slide order, and resolve each slide's rels.
  - For each `ppt/slides/slideN.xml`, collect the `<a:t>` text per `<p:sp>` and mark title placeholders by `p:ph type="title|ctrTitle"`.
  - Collect `<p:pic>` → `r:embed` → media blobs, plus `ppt/notesSlides`.
  - Render as a vertical list of "slide cards" with text and images, in reading order. Do not attempt to position shapes.
  - Parse with `DOMParser` (`application/xml`), never `innerHTML`. Render through React, which escapes text.
  - This is honest, readable and nearly risk-free. It is not a layout renderer, so do not try to grow it into one.
- **Rejected.**
  - **pptx-preview.** Its source is unavailable (the code is not auditable), it has 19 `innerHTML` sites, the last release was 2025-10, and it is 391 KB gz.
  - **PPTXjs / pptx2html.** Abandoned since 2022; they need jQuery and d3 v4.
  - **pptx-viewer.** Too immature: 8 stars, 0.x.
  - **`@kandiforge/pptx-renderer`.** UNLICENSED, and it pulls in MUI.
  - **PptxGenJS.** Writer only.

### XLSX and CSV: SheetJS CE 0.20.3 (primary)

- **npm situation.** `npm i xlsx` installs 0.18.5 (2022), which is vulnerable to CVE-2023-30533 (prototype pollution, fixed in 0.19.3). SheetJS no longer publishes to npm; current builds are only on `cdn.sheetjs.com`. Vendor `xlsx-0.20.3.tgz` into the repo and depend on `file:vendor/xlsx-0.20.3.tgz`. Avoid a URL dependency, which makes CI depend on their CDN. This is a build-time download; at runtime nothing is fetched, so the CSP is unaffected.
- **Usage.** `read(buf, { type: "array", cellDates: true, cellNF: true, dense: true })`, then render through the app's own React table. That gives formatted values (`cell.w`, from SSF number formats), merges (`!merges`), column widths (`!cols`), sheet tabs and hidden sheets. Do not use `sheet_to_html` plus `innerHTML`; React escaping is free.
- **CE limits.** Cell styling (fills, fonts, borders) is a SheetJS **Pro** feature, so the preview shows plain cells. Charts, images and conditional formatting are absent.
- **Formulas.** No reader computes formulas. Files written by exceljs often have formulas without cached values, because Excel recomputes on open. Show `=SUM(A1:A3)` in muted text when `v` is missing, rather than an empty cell.
- **CSV.** Use the same `read(text, { type: "string" })` path, so there is one table model and one renderer for both formats. papaparse (7 KB) is unnecessary unless streaming CSVs of hundreds of MB becomes a requirement.
- **Size.** Cap the row count (for example, first 5,000 rows with virtualised rendering) and show an "N more rows" note.
- **Ranked alternatives.**
  1. **exceljs 4.4** (already a devDependency). It reads styles, merges and widths, so a styled preview is possible. On the other hand: 263 KB gz, no release since 2023-10, 816 open issues (many are read failures on third-party files), and a browserified bundle full of polyfills. Choose it only if styled cells are a hard requirement and most files come from the agent's own exceljs output.
  2. **read-excel-file 9.3** (16 KB, MIT, active). Values only: no merges, no number formats, no styles. A good minimal option, but SheetJS dominates it once the 120 KB is accepted.

## Cross-cutting security

- **CSP does most of the work.** `script-src 'self'` neutralises inline handlers and `javascript:` URLs from any injected markup. `img-src`/`connect-src 'self'` stop remote beacons and CSS `url()` exfiltration. Do not loosen the CSP for previews; in particular, do not add `'wasm-unsafe-eval'` or CDN hosts.
- **Clicks.** Intercept them on every preview container and route links through one allowlisted opener. This is the main residual risk in both shells.
- **Isolation.** Use a shadow root for docx-preview and the pptx renderer to isolate CSS. A sandboxed iframe adds no script protection beyond the CSP, because the libraries need scripts in the frame, and it complicates sizing. Not worth it.
- **Resource limits.** Cap the input size before parsing (for example 50 MB) to bound zip bombs. Only aiden0z has its own ZIP limits; docx-preview, JSZip and SheetJS do not.

## Limitations of this research

- No library was run on SAI OS or WebKitGTK. Fidelity statements come from each project's own docs and test suites plus source reading, not side-by-side renders of this repo's generated files.
- Bundle sizes are esbuild measurements. Vite/Rollup numbers will differ by a few percent.
- The CSP checks are static greps of built bundles, not a runtime CSP-violation report. A smoke test with the real CSP in both shells is required.
- Legacy binary formats (`.doc`, `.ppt`, `.xls`) were out of scope. Only SheetJS reads `.xls`; for the others the fallback is "Open with system app".

## Unresolved questions

1. What is the WebKitGTK version on SAI OS? It decides between the pdf.js modern and legacy builds.
2. Is styled spreadsheet rendering (fills, bold headers) required? If yes, exceljs replaces SheetJS and its maintenance risk is accepted.
3. Should the DOCX fallback include mammoth (+90 KB lazy), or go straight to "Open with system app"? I lean towards the latter.
4. Is vendoring a tarball (SheetJS) acceptable under repo policy?

## Sources

- npm registry metadata (`npm view`) and GitHub API (`gh api repos/...`), queried 2026-10-07.
- Package source read directly: `docx-preview/dist/docx-preview.mjs` (altChunk iframe, href, blob fonts), `@aiden0z/pptx-renderer/dist/*.es.js` and README Security section, `pdfjs-dist/build/*` and `wasm/`.
- [SheetJS advisory CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533)
- [osv.dev CVE-2023-30533](https://osv.dev/vulnerability/CVE-2023-30533)
- [SheetJS issue #2961: 0.19.3 not on npm](https://git.sheetjs.com/sheetjs/sheetjs/issues/2961)
- [pdf.js FAQ (modern vs legacy builds)](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions)
- [Open WebUI stored XSS via unsanitised DOCX/XLSX preview (CVE-2026-45318)](https://corgea.com/advisories/vulnerabilities/CVE-2026-45318): precedent for sanitising preview HTML.
- [CVE-2026-91127: hyperlink-scheme DOM XSS in a doc viewer](https://vulert.com/vuln-db/CVE-2026-91127): precedent for link allowlisting.
- [aiden0z/pptx-renderer](https://github.com/aiden0z/pptx-renderer)
- [VolodymyrBaydalka/docxjs](https://github.com/VolodymyrBaydalka/docxjs)
- [mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js)
