---
phase: 5
title: "Entry points"
status: completed
priority: P2
effort: "3h"
dependencies: [4]
---
# Phase 5: Entry points

## Goal

The user can open a preview from:

- the office output card;
- the Write tool card;
- a model markdown link to a local document (wired in Phase 2; guarded here);
- attachment cards, both in the composer and in the sent user bubble, including images that have no path on disk (pasted or sent images open from their data URL).
<!-- Validation: path-less images -->

File entries call `useUiStore.getState().openFilePreview(path, tabId)` with the
tab of the session the card belongs to (`useRuntimeTabId()`), so the preview
stays pinned to that workspace. Path-less images call
`useUiStore.getState().openImagePreview(dataUrl, name)`. Both actions are
defined in Phase 2 (`src/renderer/stores/ui.ts`).
<!-- Red team: R8 -->

## Files to Create / Modify

<!-- Red team: K4 -->
- **Modify:**
  - `src/renderer/components/tools/OfficeFileRenderer.tsx` and `OfficeFileRenderer.test.tsx`
  - `src/renderer/components/tools/WriteRenderer.tsx` and `WriteRenderer.test.tsx`
  - `src/renderer/components/attachments/AttachmentCard.tsx` and `AttachmentCard.test.tsx`
  - The five `<AttachmentCard` JSX sites, verified on 2026-10-07 with the sibling's work in the tree: `src/renderer/components/layout/InputArea.tsx` at about `:1024` (image, `path` optional), `:1036` (image still being read, `loading`), `:1049` (document); `src/renderer/components/chat/MessageBubble.tsx` at about `:448` (sent image, no `path`) and `:456` (sent document). Task 5.3 re-checks them before editing.
  - `src/renderer/components/layout/InputArea.drop.test.tsx`, `src/renderer/components/chat/MessageBubble.test.tsx`
  - `src/renderer/components/layout/PanelContainer.test.tsx` (a markdown docx-link case)
  - `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`

## Test Matrix (TDD)

| Case | Test file | Red | Green |
|---|---|---|---|
| A successful report card shows a **Preview** button; clicking it sets `filePreview` to `{ kind: "path", path: REPORT, tabId: <runtime tab> }`, `panelVisible === true` and `panelTab === "files"`, and does not call `openPath` | `OfficeFileRenderer.test.tsx` | no button → exit 1 | pass |
| An error or partial office card shows no **Preview** button (it falls back to `GenericRenderer`) | same | passes before (regression) | pass |
| A finished Write card has a button with aria-label `Preview notes.md`; clicking it sets the preview path to `details.resolvedPath` when present, otherwise to `args.path` | `WriteRenderer.test.tsx` | exit 1 | pass |
| A partial or error Write card has no preview button | same | exit 1 (the button exists before the guard) | pass |
| `AttachmentCard` with `onOpen` exposes a button labelled `Preview report.pdf`, and a click calls `onOpen` once; without `onOpen` there is no such button; the remove button does not call `onOpen`; a `loading` card has no open button even with `onOpen` | `AttachmentCard.test.tsx` | exit 1 | pass |
| A dropped document card in the composer opens it in the preview; the image card still being read offers no preview button | `InputArea.drop.test.tsx` | exit 1 | pass |
| A sent document card opens its path in the preview; a sent image card (no path) opens an in-memory image preview with its data URL <!-- Validation: path-less images --> | `MessageBubble.test.tsx` | exit 1 | pass |
| A markdown link `[r](file:///home/u/Documents/Sai%20ATLAS/r.docx)` opens the drawer with the preview path `"/home/u/Documents/Sai ATLAS/r.docx"` and calls `fs.readDocument` | `PanelContainer.test.tsx` | fails (`readDocument` not called) only if Phase 2 regressed; otherwise green (a guard test) | pass |

## Tasks

### Task 5.1 — Locale keys
- **Goal:** The labels exist in both languages.
- **Target files and symbols:** `en.ts` and `vi.ts`, next to the `preview.*` keys from Phase 2.

  | Key | en | vi |
  |---|---|---|
  | `preview.openButton` | "Preview" | "Xem trước" |
  | `preview.open` | "Preview {name}" | "Xem trước {name}" |

- **Steps:** Add the 2 keys to both files.
- **Success criteria:** Locale parity holds.
- **Verify:** `bunx vitest run src/renderer/locales; echo "exit=$?"` ends with `exit=0`.

### Task 5.2 — Office card and Write card (red, then green)
- **Goal:** Output files open beside the chat, pinned to their session's tab.
- **Target files and symbols:** `OfficeFileRenderer`, inside its button row (`OfficeFileRenderer.tsx:94-98`). `WriteRenderer`, after the `<PathLink path={openPath} …>` (`WriteRenderer.tsx:88`).
- **Steps:**
  1. **Red.** Add the four tool-card cases from the matrix to the two existing test files. Reuse their harnesses and `REPORT`. Reset with `useUiStore.setState({ filePreview: null, panelVisible: false, panelTab: "files" })` in `afterEach`. Run them.
  2. **Green, office card.** Read `const tabId = useRuntimeTabId();` (`src/renderer/stores/session-runtime-context.tsx:138`) at the top of the component, before the early return. Before the **Open** button, add `<button type="button" className={buttonClass} onClick={() => useUiStore.getState().openFilePreview(office.file, tabId)}><Eye size={14} aria-hidden />{t("preview.openButton")}</button>`. Import `Eye` from `lucide-react` and `useUiStore` from `../../stores/ui`.
  3. **Green, Write card.** Read `useRuntimeTabId()` the same way. After the `PathLink`, when `!isPartial && !isError && openPath`, render `<button type="button" aria-label={t("preview.open", { name: basename(path) })} title={t("preview.open", { name: basename(path) })} onClick={event => { event.stopPropagation(); useUiStore.getState().openFilePreview(openPath, tabId); }} className="shrink-0 rounded-sm p-0.5 text-[var(--omp-dim)] hover:text-[var(--omp-accent)]"><Eye size={12} aria-hidden /></button>`.
- **Success criteria:** All the tool-card cases pass.
- **Verify:** `bunx vitest run src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/WriteRenderer.test.tsx; echo "exit=$?"` ends with `exit=1` after step 1, and with `exit=0` after step 3.

### Task 5.3 — Attachment cards (red, then green)
<!-- Red team: R11, K4 --> <!-- Validation: path-less images -->
- **Goal:** Files and images the user attached open beside the chat, except a card whose file is still being read.
- **Target files and symbols:** `AttachmentCardProps.onOpen?: () => void` in `AttachmentCard.tsx`, and the five call sites.
- **Steps:**
  1. Run `grep -rnE "<AttachmentCard([[:space:]]|$)" src/renderer --include=*.tsx | grep -v "\.test\.tsx:" | grep -v "components/attachments/" | cut -d: -f1 | sort | uniq -c`. The pattern needs whitespace or a line end after the name, so it skips `Pick<AttachmentCardProps` in `AttachmentCard.tsx:51`, and the component's own folder is excluded. The expected output is exactly two lines: `      2 src/renderer/components/chat/MessageBubble.tsx` and `      3 src/renderer/components/layout/InputArea.tsx`. Any other output triggers the Failure Protocol.
  2. **Red.** Add the `AttachmentCard`, `InputArea.drop` and `MessageBubble` cases from the matrix and run them. For `MessageBubble.test.tsx`, follow the existing "shows trailing quoted document paths as cards and only the typed text" case (`:319`) and add a user message with an `ImageContent` block for the image case. For `InputArea.drop.test.tsx`, follow "turns dropped files into cards…" (`:202`) and "shows an image card with a spinner while the image is read" (`:242`).
  3. **Green, the card.** When `onOpen` is set and `loading` is not, wrap the preview `div` and the `figcaption` in `<button type="button" onClick={onOpen} aria-label={t("preview.open", { name })} className="flex min-h-0 w-full flex-1 flex-col text-left">…</button>`. Otherwise keep today's markup. The remove button stays outside the wrapper. <!-- Shipped: not a wrapper, which would nest the figcaption's content inside a button (invalid HTML). The open control is an absolutely positioned sibling `<button className="absolute inset-0 …">` covering the figure, labelled `preview.open`; `preview.openButton` is the office card's label. The remove button is a second sibling above it. -->
  4. **Green, the call sites.** Read `const tabId = useRuntimeTabId();` in each component (once), then:
     - `InputArea.tsx` image card (about `:1024`): `onOpen={() => image.path ? useUiStore.getState().openFilePreview(image.path, tabId) : useUiStore.getState().openImagePreview(image.preview, image.name ?? t("input.attachmentAlt", { index: index + 1 }))}`. `image.preview` is a data URL (`InputArea.tsx:402`, `attach-document.ts:73`, `input-area-utils.ts:81`).
     - `InputArea.tsx` pending image card (about `:1036`, `loading`): no `onOpen`.
     - `InputArea.tsx` document card (about `:1049`): `onOpen={() => useUiStore.getState().openFilePreview(document.path, tabId)}`.
     - `MessageBubble.tsx` image card (about `:448`): `onOpen={() => useUiStore.getState().openImagePreview(\`data:${image.mimeType};base64,${image.data}\`, t("chat.attachedImage"))}`.
     - `MessageBubble.tsx` document card (about `:456`): `onOpen={() => useUiStore.getState().openFilePreview(path, tabId)}`.
- **Success criteria:** The card, composer and bubble tests pass, and the full suite stays green.
- **Verify:**
  - Step 1 prints exactly the two expected lines.
  - `bunx vitest run src/renderer/components/attachments src/renderer/components/layout/InputArea.drop.test.tsx src/renderer/components/chat/MessageBubble.test.tsx; echo "exit=$?"` ends with `exit=1` after step 2, and with `exit=0` after step 4.
  - `bunx vitest run; echo "exit=$?"` ends with `exit=0`.

### Task 5.4 — Markdown link guard test
- **Goal:** Lock in the markdown route for documents.
- **Target files and symbols:** `PanelContainer.test.tsx`, a new `it("opens a local Word document link in the side-by-side preview", …)`, reusing `FileLinkHarness`.
- **Steps:**
  1. Mock `fs.readDocument` as `vi.fn(async () => ({ ok: false, size: 0, mtimeMs: 0, error: "unsupported" }))`.
  2. Mount `<FileLinkHarness content="[r](file:///home/u/Documents/Sai%20ATLAS/r.docx)" />` and click the link.
  3. Expect `useUiStore.getState().filePreview` to have `kind === "path"` and `path === "/home/u/Documents/Sai ATLAS/r.docx"`, and that `readDocument` was called with `"/home/u/Documents/Sai ATLAS/r.docx"` as its first argument.
- **Success criteria:** The test passes.
- **Verify:** `bunx vitest run src/renderer/components/layout/PanelContainer.test.tsx; echo "exit=$?"` ends with `exit=0`.

### Task 5.5 — Gate and commit
- **Goal:** One revertable commit.
- **Target files and symbols:** this phase's files.
- **Steps:**
  1. Run `bun run check:types`.
  2. Run biome on the touched files.
  3. Run `node scripts/lint-surfaces.mjs`.
  4. Run `git commit -m "feat(preview): open files and images beside the chat from tool cards and attachments"`.
- **Success criteria:** The commit exists.
- **Verify:**
  - All three commands in steps 1–3 exit 0.
  - `git log -1 --format=%s` matches the message.

## Verification

- `bunx vitest run` exits 0.
- `bun run check:types` exits 0.

## Risks & Rollback

- **The sibling plan's card call sites move before this phase runs.** Task 5.3 step 1 stops the phase on any difference from the five sites above.
- **A button nested inside a `<figure role="listitem">`:** the remove button stays a sibling, never nested inside the open button.
- **A large pasted image opens as a data URL.** It is already in memory for the card's thumbnail; the preview shows the same string through `<img>`.
- **Rollback:** `git revert <phase commit>`. The previews stay reachable from the Files panel and from markdown links.

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
