---
phase: 6
title: "End-to-end in both shells, packaged pdf.js check and docs"
status: completed
priority: P1
effort: "5h"
dependencies: [5]
---
# Phase 6: End-to-end in both shells, packaged pdf.js check and docs

## Goal

Prove that the real renders, the docking, the sidebar restore, the
event-driven refresh and Reload, the style containment, the self-hosted pdf.js
data and the CSP behave correctly in the Tauri shell (WebKitGTK, embedded
assets, real CSP) and in the Electron shell (Chromium, `file://`), using twin
specs that `check-twins.ts` accepts. Add a check to the packaged Ubuntu 24.04
smoke test that its WebKitGTK has the JavaScript APIs the modern pdf.js build
calls. Record the feature in the changelog.
<!-- Validation: pdf.js build --> <!-- Red team: R6, R9, R11, K9, K10 -->

## Files to Create / Modify

- **Create:** `e2e-tauri/document-preview.e2e.ts`, `e2e/document-preview.e2e.ts`
- **Modify:**
  - `e2e/sidecar-fixture.ts`: a `fixture:write-table-csv` branch in its `bash` command handler (next to `fixture:large-tool`, `sidecar-fixture.ts:550-560`), plus `import * as path from "node:path"`. Both shells' e2e use this fixture (`e2e-tauri/session.ts:30`, `e2e/runtime.e2e.ts:23`). <!-- Validation: refresh -->
  - `e2e-tauri/packaged-smoke.e2e.ts`: one assertion in `it("boots sandboxed and renders with a ready sidecar")` (`:200`). The twin rule only requires the Tauri twin to have at least as many assertions as the Playwright original (`check-twins.ts:85-88`), so `e2e/packaged-smoke.e2e.ts` is unchanged. <!-- Validation: pdf.js build -->
  - `CHANGELOG.md` (the `## [Unreleased]` → `### Added` section, `CHANGELOG.md:3-5`)

## Test Matrix (TDD)

The same test titles appear in both specs. The product code already exists,
so the red state of this phase is the twin gate: while only the Tauri spec
exists, `bun e2e-tauri/check-twins.ts` must exit 1 and print
`document-preview.e2e.ts: no Playwright original and not listed as Tauri-only`.
Writing the Electron twin turns it green. The behavioural red states for every
render path were already asserted by the unit tests in Phases 1–5.

| Case (title) | Tauri spec | Electron spec | Red | Green |
|---|---|---|---|---|
| `previews office files, PDFs, sheets and images beside the chat` | yes | yes | `check-twins` exit 1 while only one twin exists | the spec passes |
| `keeps the preview docked in a narrow window and gives the sidebar back on close` <!-- Red team: K3, K10 --> | yes | yes | same | pass |
| `shows a way out for a file that is not what its name says` | yes | yes | same | pass |
| `refreshes the preview after a tool writes the file, after any rewrite on disk, and on Reload` <!-- Shipped: auto-refresh --> <!-- Validation: refresh --> | yes | yes | same | pass |
| `keeps a document's injected styles inside the preview` <!-- Red team: R6 --> | yes | yes | same | pass |
| `loads pdf.js character maps and fonts from the app` <!-- Red team: K9 --> | yes | yes | same | pass |
| The packaged app's WebKitGTK has `Map.prototype.getOrInsertComputed`, `Math.sumPrecise`, `Uint8Array.fromBase64`, `Promise.withResolvers` and `URL.parse` <!-- Validation: pdf.js build --> | `packaged-smoke.e2e.ts` | no change | (container run) | the smoke passes |

## Tasks

### Task 6.1 — Fixture write command and the Tauri spec
<!-- Red team: R9, R11, K10 --> <!-- Validation: refresh -->
- **Goal:** Real renders under the real CSP on WebKitGTK, with assertions that cannot pass before a renderer has drawn. <!-- Shipped: the specs (both shells) dismiss the toasts before clicking header controls, because the fixture sidecar's non-local-model warning covers them; the body-children count excludes the toast stack (`[aria-live="polite"]`), and it is asserted unchanged after closing the docx and the pptx preview; the narrow-window test also asserts the composer `textarea` is enabled. The e2e found that PdfPreview canvases must start at 0×0 until drawn (an unsized canvas holds a 300×150 bitmap, so `width > 0` counted undrawn pages); fixed in the PDF renderer. -->
- **Target files and symbols:** `e2e/sidecar-fixture.ts`; `e2e-tauri/document-preview.e2e.ts`. The spec imports `launch`, `awaitBridge`, `collectPageErrors`, `pageErrors`, `until`, `lastExactText` and `exactTextCount` from `./session` (`e2e-tauri/session.ts:178,225,465,480,430,374,359`).
- **Steps:**
  1. In `sidecar-fixture.ts`, inside the `bash` case before the `fixture:security:` branch, add: when `command.command === "fixture:write-table-csv"`, write `"Region,Revenue\nWest,77\n"` to `path.join(process.cwd(), "table.csv")` (the sidecar runs in the workspace), then `write({ type: "tool_execution_start", toolCallId: "write-table-csv", toolName: "write", args: { path: "table.csv" } })`, `write({ type: "tool_execution_end", toolCallId: "write-table-csv", toolName: "write", result: { content: [{ type: "text", text: "Wrote table.csv" }], details: { resolvedPath: <that absolute path> } }, isError: false })`, `ok()` and `break`.
  2. Inside `describe("document preview", …)`, every `it` starts with:
     ```ts
     const run = await launch({
       name: "document-preview",
       setup: async l => {
         for (const f of await fsp.readdir(FIXTURES)) {
           await fsp.copyFile(path.join(FIXTURES, f), path.join(l.project, f));
         }
       },
     });
     ```
     where `FIXTURES = path.resolve(import.meta.dirname, "../e2e/fixtures/document-preview")`. Then call `await awaitBridge(browser); await collectPageErrors(browser); await browser.setWindowSize(1440, 900);`. Every later reference to the workspace uses `run.project`.
  3. A helper `openFromTree(name)`:
     1. If `$('aside.omp-inspector')` is not displayed, click `$('button[title="Open workspace"]')`.
     2. If the preview is open, click `$('button[aria-label="Back to files"]')`.
     3. Click the `[role="treeitem"]` whose text is exactly `name`, using `lastExactText(name, "aside")`.
     4. Wait until `[data-preview-state]` is not `loading`.
  4. Helpers `shadowCount(host, selector)`: `browser.execute((h, sel) => document.querySelector(\`[data-preview-host="${h}"]\`)?.shadowRoot?.querySelectorAll(sel).length ?? 0, host, selector)`, and `rendered(host)`: `browser.execute(h => document.querySelector(\`[data-preview-host="${h}"]\`)?.getAttribute("data-rendered") === "true", host)`.
  5. **`previews office files, PDFs, sheets and images beside the chat`:**
     1. Register a CSP listener: `browser.execute(() => { (window as never as { __csp: string[] }).__csp = []; document.addEventListener("securitypolicyviolation", e => (window as never as { __csp: string[] }).__csp.push(e.effectiveDirective)); })`.
     2. `report.docx`: expect `await until(() => rendered("docx"), ok => ok, { timeout: 15_000 })` to be `true` and `await shadowCount("docx", "section.docx")` to be at least 1.
     3. `deck.pptx`: expect `await until(() => rendered("pptx"), ok => ok, { timeout: 15_000 })` to be `true`, `await shadowCount("pptx", "*")` to be greater than 1 (more than the empty mount `div`), and, after `await browser.pause(1000)`, `[data-preview-state]` still to equal `rich`.
     4. `table.xlsx`: expect a `td` with exact text `Region`, a `td` with exact text `=SUM(B2:B4)`, tab buttons `Sales` and `Notes`, and no tab `Hidden`.
     5. `table.csv`: expect a `td` `North`.
     6. `one-page.pdf`: expect a `canvas` with `width > 0`.
     7. `sixty-pages.pdf`: expect the text `Pages not shown here: 10. Open the file to see them.` and fewer than 10 canvases with `width > 0` (lazy pages).
     8. `pixel.png`: expect an `img` inside `[data-preview-kind="image"]` with `naturalWidth === 1`.
     9. Layout checks, in the page, with a preview open:
        - `getComputedStyle(aside).position !== "absolute"`;
        - `aside.getBoundingClientRect().width >= 0.4 * innerWidth - 1`;
        - `document.querySelector("main").getBoundingClientRect().width >= 400`;
        - `document.querySelector("textarea").disabled === false`.
     10. Finally, expect `__csp` to equal `[]` and `await pageErrors(browser)` to equal `[]`.
  6. **`keeps the preview docked in a narrow window and gives the sidebar back on close`:** expect `aside.omp-session-sidebar` (`Sidebar.tsx:493-494`) to exist. `openFromTree("table.csv")`, then `browser.setWindowSize(900, 700)`. Then expect:
     - `getComputedStyle(aside.omp-inspector).position !== "absolute"`;
     - `Math.abs(inspector.getBoundingClientRect().width - Math.round(innerWidth * 0.5)) <= 1`;
     - the `td` `North` is still displayed;
     - `!document.querySelector("aside.omp-session-sidebar")`.
     Then click `Back to files` and expect `aside.omp-session-sidebar` to exist again.
  7. **`shows a way out for a file that is not what its name says`:** `openFromTree("not-a-docx.docx")`, then expect `[data-preview-state="error"]`, the text `This file could not be shown here. Use Open externally to see it.`, and a header button whose text is `Open externally`.
  8. **`refreshes the preview after a tool writes the file, after any rewrite on disk, and on Reload` <!-- Shipped: auto-refresh -->:** `openFromTree("table.csv")`. Then:
     1. `await browser.execute(() => window.omp.rpc.bash("fixture:write-table-csv"))`, and expect `await until(() => exactTextCount("West", "[data-preview-kind]"), n => n >= 1, { timeout: 6_000 })` to be at least 1.
     2. `await fsp.writeFile(path.join(run.project, "table.csv"), "Region,Revenue\nEast,5\n")` (no tool event), and expect a `td` with `East` within 6000 ms with no tool event (file watch). <!-- Shipped: auto-refresh -->
     3. Click `$('button[aria-label="Reload"]')`, and expect `await until(() => exactTextCount("East", "[data-preview-kind]"), n => n >= 1, { timeout: 6_000 })` to be at least 1.
  9. **`keeps a document's injected styles inside the preview`:** `openFromTree("injected-font.docx")`, wait for `rendered("docx")`. Expect the shadow root's style text to contain `:host{position:fixed` (`browser.execute(() => [...(document.querySelector('[data-preview-host="docx"]')?.shadowRoot?.querySelectorAll("style") ?? [])].some(s => s.textContent?.includes(":host{position:fixed")))` is `true`, which proves the fixture really injects; if it is `false`, apply the Failure Protocol). Then expect the host's `getBoundingClientRect()` to lie inside `[data-preview-frame]`'s rect (±1 px), and `!document.elementFromPoint(5, 5)?.closest("[data-preview-host]")`.
  10. **`loads pdf.js character maps and fonts from the app`:** `openFromTree("cjk.pdf")` and expect a `canvas` with `width > 0`. Then probe the same loader pdf.js uses for non-http URLs (`XMLHttpRequest`, `pdf.mjs:1255-1264`): `browser.execute(() => { const get = (u: string) => new Promise<number>(r => { const x = new XMLHttpRequest(); x.open("GET", new URL(u, document.baseURI).href); x.responseType = "arraybuffer"; x.onloadend = () => r(x.status === 200 || x.status === 0 ? (x.response as ArrayBuffer | null)?.byteLength ?? 0 : 0); x.send(); }); return Promise.all([get("pdfjs/cmaps/UniJIS-UCS2-H.bcmap"), get("pdfjs/standard_fonts/FoxitSerif.pfb")]); })` (the W3C execute command settles a returned promise, as `e2e-tauri/test-hooks.ts:71` notes; both files exist in `node_modules/pdfjs-dist/`), and expect both sizes to be greater than 0. Expect `pageErrors` to equal `[]`.
- **Success criteria:** All six tests pass on the virtual display.
- **Verify:**
  - `bun run check:types; echo "exit=$?"` ends with `exit=0` (`tsconfig.wdio.json` includes `e2e-tauri/**`).
  - `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/document-preview.e2e.ts; echo "exit=$?"` ends with `exit=0` (`test:e2e:tauri` is `wdio run wdio.conf.ts`, so `--spec` passes through).

### Task 6.2 — Electron twin (red twin check, then green)
<!-- Red team: R11 -->
- **Goal:** The same behaviour on Chromium with `file://` loading.
- **Target files and symbols:** `e2e/document-preview.e2e.ts`. It uses the Playwright launch pattern of `e2e/runtime.e2e.ts:8-31` (a temp profile, `writeDesktopPrefs`, `OMP_BUNDLED_OMP` set to `e2e/sidecar-fixture.ts`, and `electron.launch({ args: [out/main/index.js, project, --user-data-dir=…] })`).
- **Steps:**
  1. **Red.** Run `bun e2e-tauri/check-twins.ts; echo "exit=$?"` while only the Tauri spec exists.
  2. **Green.** Write the six `test(...)` blocks with the exact same titles. `check-twins.ts` treats `e2e/` as the original and fails when the Tauri twin has **fewer** `expect(` calls than the Electron test (`check-twins.ts:85-88`), so give each Electron test exactly as many `expect(` calls as its Tauri twin, counted inside the test body (helpers above the first test do not count, `check-twins.ts:40-49`):
     1. Copy the fixtures into `project` before launch.
     2. Resize with `app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))`, and later `setSize(900, 700)`.
     3. Use `page.locator(...)` and `page.evaluate(...)` for the same DOM, shadow-root, `data-rendered`, XHR probe and geometry checks; trigger the write with `page.evaluate(() => window.omp.rpc.bash("fixture:write-table-csv"))`.
     4. Collect `pageerror` into `errors`.
     5. Close the app in `finally`.
  3. Run `bun run build` first, because the spec launches `out/main/index.js`.
- **Success criteria:** The twin check passes, and the Electron spec passes.
- **Verify:**
  - Step 1 ends with `exit=1`, and its output contains `document-preview.e2e.ts: no Playwright original and not listed as Tauri-only`.
  - `bun e2e-tauri/check-twins.ts; echo "exit=$?"` ends with `exit=0`.
  - `bun run build && scripts/virtual-display.sh run -- bunx playwright test e2e/document-preview.e2e.ts; echo "exit=$?"` ends with `exit=0`.

### Task 6.3 — Changelog
- **Goal:** User-visible behaviour is documented in the existing owning surface.
- **Target files and symbols:** `CHANGELOG.md`, under `## [Unreleased]` → `### Added` (`CHANGELOG.md:3-5`).
- **Steps:** Add one bullet:
  > - **Preview files beside the chat**: Word documents, slide decks, spreadsheets (xlsx, xls, ods, csv), PDFs and images open in the workspace drawer next to the conversation from the office card's **Preview** button, the Write card, links in answers, the Files panel and attachment cards, pasted images included. Previews are read-only, refresh when the assistant writes the file, have a **Reload** button for changes made elsewhere, and point to **Open externally** for anything they cannot show. Mail links in documents now open the mail app.
- **Success criteria:** The bullet exists exactly once.
- **Verify:** `grep -c "Preview files beside the chat" CHANGELOG.md` prints `1`.

### Task 6.4 — Packaged pdf.js check in the Ubuntu 24.04 container
<!-- Validation: pdf.js build -->
- **Goal:** The installed `.deb` runs on a WebKitGTK that has the APIs the modern pdf.js build calls without polyfills (`Map.prototype.getOrInsertComputed` at `pdf.mjs:2463`, `Math.sumPrecise` at `pdf.mjs:21673`, `Uint8Array.fromBase64` at `pdf.mjs:25582`, plus `Promise.withResolvers` and `URL.parse`).
- **Target files and symbols:** `e2e-tauri/packaged-smoke.e2e.ts`, `it("boots sandboxed and renders with a ready sidecar")`.
- **Steps:**
  1. After the `#root > *` display check, add: `const pdfjsApis = await browser.execute(() => [typeof (Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed, typeof (Math as unknown as Record<string, unknown>).sumPrecise, typeof (Uint8Array as unknown as Record<string, unknown>).fromBase64, typeof Promise.withResolvers, typeof URL.parse]); expect(pdfjsApis).toEqual(["function", "function", "function", "function", "function"]);`.
  2. Build the package with `SAI_ATLAS_UPDATE_BASE` unset: `bun run build:omp:linux && bun run package:linux`.
  3. Run `bash scripts/tauri-deb-smoke.sh "$(ls src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb | head -1)"`.
- **Success criteria:** Types compile, the twin check still passes, and the container smoke passes with the probe. A failed probe is a product finding for the user (keep the modern build, or switch builds), not something to fix in this plan: apply the Failure Protocol.
- **Verify:**
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.
  - `bun e2e-tauri/check-twins.ts; echo "exit=$?"` ends with `exit=0`.
  - Step 3 ends with exit code 0.

### Task 6.5 — Full gate, cleanup and commit
- **Goal:** Every acceptance gate passes, and no process is left running.
- **Target files and symbols:** none new.
- **Steps:**
  1. Run each command under plan.md "Validation commands".
  2. Run `git diff <plan-start-commit> -- src/renderer/index.html src/renderer/quick-entry.html src-tauri/tauri.conf.json src/main/packaging-config.test.ts`.
  3. Run `scripts/virtual-display.sh stop`.
  4. Run `git commit -m "test(preview): render every preview format in both shells"` for the spec files, the fixture command and the packaged-smoke probe, and `git commit -m "docs(changelog): note the side-by-side file preview"` for the changelog.
- **Success criteria:** All gates pass, the CSP files are unchanged, and the virtual display is stopped.
- **Verify:**
  - Every command in step 1 ends with exit code 0.
  - Step 2 prints nothing.
  - `scripts/virtual-display.sh status` reports that nothing is running.
  - `git log -2 --format=%s` lists both commit messages.

## Verification

- Both e2e specs exit 0.
- `bun e2e-tauri/check-twins.ts` exits 0.
- The packaged smoke in the Ubuntu 24.04 container exits 0 with the pdf.js API probe.
- The full validation list in plan.md exits 0.
- The CSP diff is empty.

## Risks & Rollback

- **The docx or pptx renderers throw on WebKitGTK only.** `data-rendered` never appears, the spec fails at that assertion, and the renderer's `onError` shows the error state. Apply the Failure Protocol; this is the evidence the research could not produce statically.
- **A `securitypolicyviolation` fires** (for example `font-src` from a document font). The CSP must not be loosened. Report it through the Failure Protocol.
- **The cmaps probe fails on Electron `file://`.** That answers plan.md Unresolved question 2 with evidence; stop and report it.
- **The packaged build takes long and needs Docker.** It is the only way to test the Ubuntu 24.04 WebKitGTK the user named; it runs once, in Task 6.4.
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
