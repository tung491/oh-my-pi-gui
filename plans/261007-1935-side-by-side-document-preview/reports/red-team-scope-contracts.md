# Red team: scope and contracts (Contract Verifier)

Plan: `plans/261007-1935-side-by-side-document-preview/`. Checked against the working tree on 2026-10-07, with the sibling attachment-cards work present but uncommitted. The kongming verdict already lists 12 defects, and none of them is repeated here.

## Contract consumer inventory (grep)

| Interface the plan changes | Consumers found | Does the plan cover them? |
|---|---|---|
| `IPC_COMMANDS.FS_READ_DOCUMENT` / Rust `fs_read_document` | `ipc-types.ts:192` (anchor), `mod.rs:58,93`, `channels.rs:14`, `services.api.txt:15-18`, **`ports.api.txt:855-859`**, `services.parity.json:35` | No: `ports.api.txt` is missing (F1) |
| `OmpApi["fs"].readDocument` | the only implementer is `create-omp-api.ts:98`. Test doubles cast partial objects (`MessageBubble.test.tsx:307`, `InputArea.drop.test.tsx:88`, `AttachmentCard.test.tsx:37`, `RootErrorBoundary.test.tsx:32`) | Yes |
| `openFilePreview` / `filePreviewPath` | `ui.ts:191`, `FilesPanel.tsx:54-56,140,157,188-218`, `markdown.tsx:185`, `PanelContainer.test.tsx:66,154,182,191` | Yes |
| `AttachmentCardProps` / `<AttachmentCard` | `InputArea.tsx:1012,1024,1037`, `MessageBubble.tsx:448,456`, `attachments/index.ts:1`, **`AttachmentCard.tsx:51` (`Pick<AttachmentCardProps`)** | The gate breaks on the component itself (F2), and image cards cannot open (F7) |
| `OfficeFileRenderer` / `WriteRenderer` | `tools/index.tsx`, `OfficeFileRenderer.test.tsx:76-88` (finds buttons by `textContent`), `WriteRenderer.test.tsx:41`, `UpstreamParityRenderers.test.tsx:160,174` | Safe: the new buttons do not collide |
| `PanelContainer` | `App.tsx:603`, `PanelContainer.test.tsx` (5 tests) | The persisted-width side effect is not covered (F6) |
| `pdf-thumbnail.ts` internals (`rasterizeFirstPage`) | `PdfThumbnail.tsx`, `pdf-thumbnail.test.ts` (injects `rasterize`, so it never exercises the timeout) | The timeout is lost (F5) |
| e2e twin contract | `e2e-tauri/check-twins.ts:81-88`, where `e2e/` is the original and the twin must have `>=` assertions | The direction is reversed (F4) |
| `e2e-tauri/session.ts` helpers | `launch():178` returns `PreparedLaunch`; `until():430` takes an options object | The spec code misuses both (F3) |

---

## Finding 1: The plan misses `src-tauri/contracts/ports.api.txt`, so the snapshot gate fails at Task 1.6 and in CI
- **Severity:** Critical
- **Location:** Phase 1, Task 1.6 "Parity, snapshot, clippy". Also plan.md "Constraints" bullet 2 and the Phase 1 "Files to Create / Modify" list.
- **Flaw:** The plan adds the new `fs_read_document` line to `services.api.txt` only. `check-module.sh snapshots` checks every `contracts/*.api.txt`. The `ports` snapshot is built with `grep "sai_atlas_lib::ports::"` over the full public API. Every `services::ipc::*` handler takes a `sai_atlas_lib::ports::Caller` argument, so each handler line also lands in `ports.api.txt`. The sibling's own diff shows this: `git diff --stat` reports `src-tauri/contracts/ports.api.txt | 1 +` for `fs_read_pdf`.
- **Failure scenario:** At Task 1.6 step 3, `bash scripts/check-module.sh snapshots` reports `public API of ports changed` and exits non-zero, which triggers the Failure Protocol. If an executor regenerates only the services snapshot, the CI `tauri-linux` job fails on the API snapshots.
- **Evidence:**
  - `scripts/check-module.sh:72` builds `SNAPSHOTS` from every `contracts/*.api.txt`.
  - `:122` greps `"sai_atlas_lib::${snap}::"`.
  - `src-tauri/contracts/ports.api.txt:855-859` contains `pub fn sai_atlas_lib::services::ipc::fs_read(…)`, `fs_read_image(…)` and `fs_read_pdf(…)`.
  - The plan's Task 1.6 names only `services.api.txt`.
- **Suggested fix:** Add `ports.api.txt` to the Phase 1 file list, plan.md Constraints and Task 1.6. Insert the same `fs_read_document` line after the `services::ipc::fs_read(` line there too. Better, regenerate both snapshots with the `check-module.sh` grep instead of hand-inserting lines.

## Finding 2: The Task 5.3 call-site gate matches `AttachmentCard.tsx` itself, so it always fails
- **Severity:** High
- **Location:** Phase 5, Task 5.3 step 1, and its Verify line "Step 1 prints exactly the two expected lines".
- **Flaw:** The command is `grep -rln "<AttachmentCard" src/renderer --include=*.tsx | grep -v "\.test\.tsx$"`. It also matches the type expression `Pick<AttachmentCardProps, …>` inside the component file.
- **Failure scenario:** Running the command today, with the sibling's call sites already wired, prints three files: `src/renderer/components/attachments/AttachmentCard.tsx`, `src/renderer/components/chat/MessageBubble.tsx` and `src/renderer/components/layout/InputArea.tsx`. The plan says "Any other output triggers the Failure Protocol", so Phase 5 stops at its first attachment step on every run, however the sibling lands.
- **Evidence:**
  - `src/renderer/components/attachments/AttachmentCard.tsx:51`: `}: Pick<AttachmentCardProps, "kind" | "path" | "preview" | "loading">) {`.
  - Running the plan's exact grep prints the three paths above.
- **Suggested fix:** Use `grep -rlnE "<AttachmentCard(\s|$)"` and exclude `components/attachments/`. Better, assert the five JSX sites by line content rather than by file count. There are three in `InputArea.tsx` (1012, 1024, 1037) and two in `MessageBubble.tsx` (448, 456).

## Finding 3: The Tauri spec code does not typecheck and silently weakens criterion 6
- **Severity:** High
- **Location:** Phase 6, Task 6.1 steps 1 and 7. plan.md acceptance criterion 6 ("within 6000 ms"), and criterion 10 (`bun run check:types`).
- **Flaw:** Three contract errors against `e2e-tauri/session.ts`:
  1. Step 7 writes to `path.join(launch.project, "table.csv")`. Here `launch` is the imported function (`session.ts:178`, `export async function launch(options): Promise<PreparedLaunch>`), not the launch result, so `launch.project` does not exist.
  2. Step 7 calls `until(() => …, n => n >= 1, 6000)`. The real signature is `until(read, accept, { timeout = 10_000, interval = 100 } = {})` (`session.ts:430-434`), so a bare number is a type error. If it is cast, destructuring a number yields the default 10 000 ms. Criterion 6's 6000 ms bound would then never be enforced.
  3. Step 7 uses `exactTextCount`, but the step 1/Target import list (`launch, awaitBridge, collectPageErrors, pageErrors, until, lastExactText`) omits it.
- **Failure scenario:** `check:types` runs `tsc --noEmit -p tsconfig.wdio.json`, which includes `e2e-tauri/**/*.ts`. It fails in Task 6.4 step 1, which triggers the Failure Protocol. If an executor "fixes" it with `as never`, the refresh test passes even when the refresh takes 9 s.
- **Evidence:**
  - `package.json:32`: `"check:types": "tsc --noEmit && tsc --noEmit -p tsconfig.wdio.json"`.
  - `tsconfig.wdio.json:6` includes `e2e-tauri/**/*.ts`.
  - `session.ts:178` and `:430-434`.
- **Suggested fix:** Use `const l = await launch({...})` and `l.project`. Call `until(read, accept, { timeout: 6000 })`. Add `exactTextCount` to the import list.

## Finding 4: The twin-assertion rule is stated backwards, so a conscientious Electron spec fails `check-twins`
- **Severity:** Medium
- **Location:** Phase 6, Task 6.2 step 2: "at least as many `expect(` calls as each Tauri test".
- **Flaw:** `check-twins.ts` treats `e2e/` (Playwright) as the original and `e2e-tauri/` as the twin. It fails when the twin has fewer assertions than the original: `match.assertions < testCase.assertions`. The plan instructs the opposite inequality.
- **Failure scenario:** Playwright needs extra `expect(...)` calls for things WebdriverIO did through `until` or shadow-root `execute`, such as `toBeVisible` before each click. That gives the Electron test more `expect(` calls than its Tauri twin. `bun e2e-tauri/check-twins.ts` then reports `"…" has N assertion(s) in the twin, M in the original` and exits 1, so the Task 6.2 Verify fails.
- **Evidence:** `e2e-tauri/check-twins.ts:2-4` ("Every Playwright spec in `e2e/` must have a WebdriverIO twin … for each title at least as many assertions") and `:85-88`.
- **Suggested fix:** State the real rule: for each title, the Tauri test must have at least as many `expect(` calls as the Electron test, so keep them equal. Count the `expect(` calls inside each `it`/`test` region, not in helpers (`check-twins.ts:46-49`).

## Finding 5: `openPdfDocument` removes the sibling's 20-second hang guard from thumbnails and gives the preview none
- **Severity:** High
- **Location:** Phase 3, Task 3.3 step 2 (`openPdfDocument`) and step 3 (the `rasterizeFirstPage` rewrite). The contract is in plan.md "Shared contracts" (`openPdfDocument(bytes): Promise<{ document; destroy }>`).
- **Flaw:**
  - The contract awaits `task.promise` inside `openPdfDocument` before it returns `destroy`.
  - The sibling deliberately races `drawFirstPage(task)` against `RENDER_TIMEOUT_MS = 20_000` and destroys the task in `finally`, with the comment "A worker that never starts leaves pdf.js waiting forever; bound it so the card falls back to its icon".
  - Step 3 replaces that with `const { document, destroy } = await openPdfDocument(bytes); try {…} finally { await destroy(); }`.
  - When the worker never starts, `openPdfDocument` never resolves, `destroy` is never reachable, and the timeout race is gone.
- **Failure scenario:** On a WebKitGTK build where the module worker fails to start, which is unresolved question 5, every PDF attachment card shows its spinner forever instead of falling back to its icon. `PdfPreview` likewise sits in `loading`/Suspense forever with no **Open in its app**, which contradicts D8's "each failure leaves a working way out". `pdf-thumbnail.test.ts` injects its own `rasterize`, so the regression cannot fail any unit test, and the plan claims "thumbnail tests stay green".
- **Evidence:**
  - `src/renderer/lib/pdf-thumbnail.ts:18` (`RENDER_TIMEOUT_MS = 20_000`).
  - `:143-160` (the `Promise.race` with the timeout and `task.destroy()` in `finally`).
  - `pdf-thumbnail.test.ts:21,126` inject `readPdf`/`rasterize`.
- **Suggested fix:** Have `openPdfDocument` return `{ task, destroy }`, or accept a timeout and destroy the task when it expires. Keep the sibling's race in `rasterizeFirstPage`, and give `PdfPreview` the same bound that calls `onError`.

## Finding 6: The auto-widen effect silently and permanently rewrites the user's saved drawer width
- **Severity:** Medium
- **Location:** Phase 2, Task 2.7 step 2.4 (`setWidth(current => Math.max(current, target))`) and plan.md D1 ("Entering the preview widens the drawer to `max(current, 40 % of the window)`").
- **Flaw:** `width` is persisted. Any change to it is written to the `gui.panelWidth` pref 150 ms later. The plan's programmatic widen is therefore indistinguishable from a user drag. The request was to preview side by side, not to change the drawer's remembered width for every other use.
- **Failure scenario:** A user who keeps the Workspace drawer at 360 px for the Logs tab opens one PDF preview at 1440 px. The drawer widens to 576 px, the pref is saved, and after **Back** the Files tree and Logs stay at 576 px in every window and after a restart. Each later preview can only ratchet the value up, because of `Math.max`.
- **Evidence:**
  - `src/renderer/components/layout/PanelContainer.tsx:83-89`: `useEffect(() => { … window.omp.prefs.set(PANEL_WIDTH_PREF, Math.round(width)) … }, [width, widthHydrated])`.
  - `:16` sets `PANEL_WIDTH_PREF = "gui.panelWidth"`.
  - No Task 2.7 test asserts the pref is unchanged after the preview closes.
- **Suggested fix:** Apply the preview width as a derived style while `previewing`, for example `style={{ width: previewing ? Math.max(width, target) : width }}`, without calling `setWidth`, so only drags persist. Add a test that `prefs.set` is not called with the widened value. Alternatively, ask the user whether a widen that persists is wanted.

## Finding 7: The attachment-card entry cannot open images, so the "user bubble" entry covers documents only
- **Severity:** Medium
- **Location:** Phase 5, Task 5.3 step 4 (`onOpen={path ? … : undefined}`). Also plan.md Outcome ("Attachment cards in the composer and in the sent user bubble … clicking a card opens it") and acceptance criterion 8.
- **Flaw:**
  - The preview contract is path-only (`openFilePreview(path)` → `DocumentPreview({ path })`).
  - Sent image cards in `MessageBubble` are built from `ImageContent` (`data`, `mimeType`) and carry no `path` at all.
  - In the composer, pasted images have no `path` either.
  - Under the plan's guard, every sent image card and every pasted image card is inert, while document cards beside them are clickable.
- **Failure scenario:** The user attaches a screenshot and a PDF, then sends. In the transcript, clicking the PDF card opens the side preview, but clicking the screenshot card does nothing and gives no affordance or explanation. Criterion 8 tests one card with a path, so the gap ships green.
- **Evidence:**
  - `src/renderer/components/chat/MessageBubble.tsx:319-321` (`userImages` are `ImageContent` blocks) and `:448-453` (`<AttachmentCard … kind="image" preview={…}/>` with no `path`).
  - `src/renderer/stores/composer.ts:21` (`/** … absent for pasted images. */ path?: string;`).
- **Suggested fix:** Either accept a data-URL source in the preview (`openFilePreview` with `{ dataUrl, name }`), or state explicitly in Outcome and Non-goals that only on-disk attachments open. Add a test asserting that a path-less image card exposes no open button, so the behaviour is deliberate.

## Finding 8: The plan adds duplicate affordances and strings, and leaves an orphaned locale key
- **Severity:** Medium
- **Location:**
  - Phase 2, Task 2.3 (`preview.loading`, `preview.openInApp`).
  - Task 2.5 step 2.4, the error state (`<PathLink …>{t("preview.openInApp")}</PathLink>`).
  - Task 2.6 step 2 ("Keep the header block (… `PathLink` open externally …) unchanged").
- **Flaw:**
  - The preview header already renders a `PathLink` to the same file with the label `filesPanel.openExternal` ("Open externally").
  - The plan adds a second `PathLink` to the same file in the body, labelled "Open in its app". The same view would show two buttons with two different names for one `system.openPath` action.
  - `preview.loading` ("Opening preview…") duplicates `filesPanel.reading` ("Reading file…"). Task 2.6 deletes that key's only consumer, so it becomes a dead locale entry in both `en.ts` and `vi.ts`.
- **Failure scenario:** On a corrupt `.docx`, the user sees "Open externally" in the header and "Open in its app" in the body, which reads as two different actions. Vietnamese users see "Mở bằng ứng dụng" next to the header's translation of "Open externally". The locale files accrue a dead key with no test to catch it.
- **Evidence:**
  - `src/renderer/components/panels/FilesPanel.tsx:207-213` (the header `PathLink` with `t("filesPanel.openExternal")`) and `:230` (the only use of `filesPanel.reading`).
  - `src/renderer/locales/en.ts:1144` ("Open externally") and `:1146` ("Reading file…").
- **Suggested fix:** Reuse `filesPanel.reading` for the loading state. In the error state, either point at the existing header control or reuse the `filesPanel.openExternal` label, with one action under one name. If the "Open in its app" wording is preferred, rename the header's key rather than adding a second one.

## Finding 9: CSV goes through the lossy UTF-8 text channel and then is re-encoded, a second byte path that corrupts non-UTF-8 files
- **Severity:** Medium
- **Location:**
  - Phase 2, Task 2.5 step 2.2, the table row `csv`: `fs.read` with `2_000_000`, then `bytes = new TextEncoder().encode(content)`.
  - Phase 3, Task 3.5 step 2.1: `read(new TextDecoder().decode(bytes), { type: "string" })`.
- **Flaw:**
  - CSV is a sheet kind, but the plan routes it through `fs:read`. That channel decodes with `String::from_utf8_lossy` in Rust, lossy UTF-8 in TS, and truncates at 2 MB.
  - The text is then turned back into bytes for the sheet renderer, a round trip that exists only because CSV was kept off `fs:read-document`.
  - Non-UTF-8 bytes are irreversibly replaced with U+FFFD before SheetJS, which handles codepages, ever sees them.
  - The `binary: true` and `truncated: true` results of `fs:read` have no specified handling for the csv branch: the table only specifies them for `markdown`/`text`.
- **Failure scenario:**
  - A Vietnamese user opens a CSV exported by Excel on Windows (CP1258/ANSI). Every accented cell renders as `�`.
  - A UTF-16 "Unicode text" export comes back `binary: true` with empty content, so the sheet shows an empty table instead of an error.
  - A 3 MB CSV is cut mid-row with no truncation note, because the sheet note only counts parsed rows.
- **Evidence:**
  - `src-tauri/src/services/fs.rs:290-292` (`String::from_utf8_lossy(&buffer[..slice_len])`).
  - `src/main/ipc.ts:125` (`FS_READ_MAX_BYTES_CAP = 2_000_000`).
  - The Task 2.5 csv row has no `binary`/`truncated` handling.
- **Suggested fix:** Either send csv through `fs:read-document` (it would need a text allowlist entry, which conflicts with the signature rule), or specify the `binary`, `!ok` and `truncated` outcomes for the csv branch and pass the raw text straight to SheetJS (`type: "string"`) without the `TextEncoder`/`TextDecoder` round trip. Ask the user whether non-UTF-8 CSV must render.

## Finding 10: Auto-refresh polling adds an unrequested contract mode (`statOnly`) to the byte-read channel
- **Severity:** Medium (question, not a cut)
- **Location:** plan.md D2 (`statOnly`) and D9, Phase 1 (the `statOnly` test case, the bridge `options.statOnly` and Rust `stat_only`), Phase 2 Task 2.5 step 1 (`useFileVersion`), Phase 6 test `refreshes the preview when the file changes on disk`, and acceptance criterion 6.
- **Flaw:**
  - The request is to "open preview of output/input file … side by side". Live refresh is not in it.
  - To support refresh, the plan overloads `fs:read-document`. The same command becomes a byte reader that enforces a signature allowlist and also a stat oracle for any regular file. The doc says it returns `{size, mtimeMs}` "for any regular file", including absolute paths outside the workspace and text files the read mode would refuse.
  - The plan also adds a 2 s interval hook, a TS↔Rust twin test pair, and an e2e test in both shells.
  - Every version bump remounts the renderer through `PanelErrorBoundary key={`${path}:${version}`}`, so scroll position resets on each change.
- **Failure scenario:** The agent rewrites a 40-page docx three times during a turn while the user reads page 12. Each rewrite remounts docx-preview, drops the user back to page 1, and re-parses the 32 MiB file. That is behaviour the user never asked for and cannot turn off. Kongming fork 1 raises the strategy (poll vs event), not whether refresh is in scope or the contract coupling.
- **Evidence:**
  - plan.md D2: "`statOnly` returns `{size, mtimeMs}` for any regular file and drives refresh".
  - Phase 2 Task 2.5 step 2.4: the renderer key includes `version`.
  - The request text in `reports/ultra-evidence-packet.md` contains no refresh or live-update requirement.
- **Suggested fix:** Ask the user whether live refresh is wanted. If it is, keep the stat probe as its own field-free contract (a separate `fs:stat` command, or reuse `fs:list` metadata) so `fs:read-document` stays a pure allowlisted byte read. Preserve scroll position across refreshes, or refresh only when the user is not mid-document.

---

Status: DONE_WITH_CONCERNS
Summary: There are 10 new findings. The critical one is a missed snapshot contract (`ports.api.txt`) that fails Phase 1. Two more are guaranteed gate failures: the Task 5.3 grep matches the component itself, and the Phase 6 spec code does not typecheck. There is also a reversed twin rule, a hang regression in the sibling's PDF thumbnails, and a persisted-width side effect. The rest is scope and DRY drift: duplicate open affordances and strings, a lossy CSV path, inert image cards, and unrequested refresh coupled into the byte channel.
Concerns/Blockers: These findings were not run, only grep-verified, except F2, whose grep was executed (it prints three files). The plan's other runtime behaviour is unchanged by this review: Chromium ignores `@font-face` inside shadow roots, which may affect docx fonts, and the remaining unverified items belong to the kongming list.
