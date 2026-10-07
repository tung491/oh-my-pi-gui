---
phase: 4
title: "Composer and transcript integration"
status: completed
priority: P2
effort: 2h
dependsOn: [1, 2, 3]
---

# Phase 4 — Composer and transcript integration

## Files

Modify: `src/renderer/components/layout/InputArea.tsx`,
`src/renderer/components/chat/MessageBubble.tsx`, their tests
(`MessageBubble.test.tsx`; add `InputArea.drop.test.tsx` if no InputArea test
exists).

## Steps

1. Shared add routine in `InputArea.tsx`: `attachPaths(paths)` takes the
   origin-tab guard already used by `attachDocuments`, splits with
   `splitAttachments`, adds documents through phase 2's `addDocuments` (warning
   toast for unsafe names), reads images with `readImageAttachment` and appends
   them. Show the image card immediately with a spinner (placeholder entry keyed
   by path) and replace it when the read settles; drop it and toast on failure.
2. Paperclip `attachDocuments` calls `attachPaths` instead of writing paths into
   the draft.
3. Drop zone on the composer's outer wrapper: `onDragEnter`/`onDragOver` only
   when `isFileDrag` (call `preventDefault`, set `dropEffect = "copy"`, show a
   dashed overlay with `t("input.drop.hint")`); `onDragLeave` with a depth counter
   so child elements do not flicker it; `onDrop` calls `preventDefault`, reads
   `droppedFilePaths`, then `attachPaths`. Non-file drags fall through untouched.
   Disabled when `collabReadOnly`.
4. Replace the 64 px image grid with `AttachmentStrip`: image cards first, then
   document cards, each with `onRemove`.
5. `MessageBubble.tsx` user turn: run `splitPromptAttachments` on the last text
   block, render the body as text and the paths as `AttachmentCard`s (no remove
   button) above it, together with the message's image blocks as image cards.
   Copy-message copies only the body text.
6. Tests: drop event with a `text/uri-list` payload adds documents and leaves the
   draft empty; a drop with only `text/plain` does nothing special; user bubble
   with trailing quoted paths renders cards and hides the path lines.
7. Live check on the virtual display (Tauri dev, throwaway profile): drop a PDF,
   an image, an mp3 and a zip; screenshot with
   `scripts/virtual-display.sh shot`; send; screenshot the bubble; check the tab
   bar still reorders by drag. Close the app and run
   `scripts/virtual-display.sh stop`.

## Validation

Full suite and every command in plan.md, plus the live check above.

## Risks and rollback

- Window-level drops outside the composer still hit WebKitGTK's default text
  insertion only on editable targets, so nothing changes there; if the user
  expects the whole pane to accept drops, widen the zone in a follow-up.
- Rollback: revert this phase; phases 1–3 are inert without it.

## Implementation notes (2026-10-07)

- `InputArea.tsx`: `attachPaths(paths, origin)` serves both the paperclip
  (origin captured before the dialog) and drops. Documents go through
  `addDocuments` (warning toast for unsafe names). Images get a spinner card
  that is keyed by tab and path, is removable, and is replaced when its read
  settles. A failed read raises an error toast. Send is enabled for documents
  alone. The drop hint sits on the bordered composer box.
- Claiming a drag: WebKit skips a text field's own drop insertion for any drag
  whose `dragover` the page cancelled, even when `drop` is left alone (a link
  dropped on the composer then inserted nothing). `dragenter`/`dragover`
  therefore cancel only drags known to carry files, through
  `dragCarriesFiles` (`Files` in types, or fresh native paths; the shell
  sends an empty list for a link). `drop` cancels only when the
  `hasDroppedFiles` sync check is true. `isFileDrag` no longer revives
  native paths that have gone stale.
- `AttachmentCard` gained `loading` (shared `PreviewSpinner` with
  `PdfThumbnail`). `MessageBubble` splits the last text block with
  `splitPromptAttachments`, shows image and document cards above the typed
  text, and copies only that text.
- Tab reorder by drag does not exist; a tab drag splits the workspace, and
  that still works.
- Live check (Tauri dev, Xvfb, throwaway profile; dev reads only
  `resources/omp`, so the stale Oct 4 binary was kept as
  `resources/omp.stale-20261004` and the Oct 6 `omp.linux-x64` was copied
  in, since this checkout has no monorepo for `build:omp`). A PDF, PNG, MP3
  and ZIP dropped as four cards with a PDF page thumbnail. Sending reached
  the model, and the bubble showed cards plus the typed text. Plain text and
  a browser-style link dropped as text. A tab drag split the panes.
