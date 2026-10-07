---
phase: 3
title: "Attachment card components"
status: completed
priority: P2
effort: 3h
dependsOn: []
---

# Phase 3 — Attachment card components

## Context

Reference: a dark rounded card about 186×140 px; top two-thirds is a preview
(thumbnail, or dark tile with a centred spinner while loading); bottom strip has
a type icon (PDF red, audio purple, archive outlined) and the file name truncated
with an ellipsis. Cards sit in a horizontally scrolling row. Use the app's
`--omp-*` tokens, not the screenshot's literal colours, so light theme works.

## Files

Create: `src/renderer/components/attachments/AttachmentCard.tsx`,
`AttachmentStrip.tsx`, `file-kind.ts`, `PdfThumbnail.tsx`, `index.ts`, tests
`AttachmentCard.test.tsx` and `file-kind.test.ts`;
`src/renderer/lib/pdf-thumbnail.ts` (+ test for the cache and error paths).
Modify: `package.json` / `bun.lock` (`pdfjs-dist`), `src/renderer/locales/en.ts`,
`src/renderer/locales/vi.ts`.

## Steps

1. `file-kind.ts`: `fileKindOf(name)` by extension (pdf; doc/docx/odt/rtf;
   xls/xlsx/ods/csv; ppt/pptx/odp; mp3/wav/m4a/ogg/flac/opus; mp4/mov/mkv/webm;
   zip/tar/gz/tgz/7z/rar/xz; md/txt/log; common code extensions; png/jpg/jpeg/
   webp/gif → image; else `file`). Map each kind to a lucide icon and a token
   colour (`FileText`, `FileSpreadsheet`, `Presentation`, `AudioLines`,
   `FileVideo`, `FileArchive`, `FileCode`, `File`).
2. `pdf-thumbnail.ts`: lazy `import("pdfjs-dist")`, worker from
   `pdfjs-dist/build/pdf.worker.min.mjs?url` (served from `'self'`, allowed by
   `worker-src`), `isEvalSupported: false`. `renderPdfThumbnail(path)` calls
   `window.omp.fs.readPdf(path)`, renders page 1 to an `OffscreenCanvas` or
   canvas at the card's width × devicePixelRatio, returns a PNG data URL. Cache
   by path in a bounded `Map` (about 32 entries, LRU) and share one in-flight
   promise per path. Destroy the loading task after rendering.
3. `PdfThumbnail.tsx`: states `loading` (spinner), `ready` (`<img>` cover, top
   aligned), `failed` (falls back to the PDF icon tile). Ignores results after
   unmount.
4. `AttachmentCard.tsx`: `<figure>` with preview area and footer; `title` = path
   (or name); remove button top-right, visible on hover and on focus-within,
   `aria-label` from `t("input.attachment.remove", { name })`. Image kind uses
   `preview`; pdf kind with a `path` uses `PdfThumbnail`; others the icon tile.
   A `compact` variant (smaller) is not needed — one size.
5. `AttachmentStrip.tsx`: flex row, gap, `overflow-x-auto`, list semantics
   (`role="list"`, cards `role="listitem"`).
6. Locale keys in both files: `input.attachment.remove`,
   `input.attachment.loading`, `input.attachment.previewFailed`,
   `input.drop.hint` ("Drop files to attach"), `input.drop.unusualName` if the
   existing `input.attach.unusualName` does not fit the drop wording.
7. Tests (linkedom harness as in `ThinkingBlock.test.tsx`): renders name and
   tooltip, remove button calls `onRemove`, no remove button without `onRemove`,
   image kind shows the `<img>`, unknown extension gets the generic icon; mock
   `window.omp.fs.readPdf` by assigning a test double on `window`, never
   `mock.module()`.

## Validation

- `bunx vitest run src/renderer/components/attachments src/renderer/lib/pdf-thumbnail.test.ts src/renderer/locales`
- `bun run build` succeeds and the worker file lands in `out/renderer/assets`.

## Risks and rollback

- pdf.js in linkedom: keep it behind the dynamic import so component tests never
  load it.
- Rollback: delete the new folder and the dependency.
