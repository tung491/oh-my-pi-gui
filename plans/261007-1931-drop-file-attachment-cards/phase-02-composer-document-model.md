---
phase: 2
title: "Composer document model and prompt serialization"
status: completed
priority: P2
effort: 3h
dependsOn: []
---

# Phase 2 — Composer document model and prompt serialization

## Context

The composer store (`src/renderer/stores/composer.ts`) holds `draft` and
`images`. The paperclip (`InputArea.tsx` `attachDocuments`) appends non-image
paths to the draft text with `appendDocumentPaths`
(`components/layout/attach-document.ts`). Cards need the documents held apart
from the text and serialized only at send time, in exactly today's format.

## Files

Modify: `src/renderer/stores/composer.ts`, `src/renderer/stores/tabs.ts`
(`restoreTabComposer`), `src/renderer/components/layout/attach-document.ts`
(+ test), `src/renderer/components/layout/use-composer-submit.ts` (+ its test if
present).
Create: `src/renderer/lib/prompt-attachments.ts`, `src/renderer/lib/prompt-attachments.test.ts`.

## Steps

1. Store: add `documents: ComposerDocument[]` and `setDocuments` (value or
   updater, like `setImages`); `reset()` clears it. Add optional `name` and `path`
   to `ComposerImage` so image cards can show a name.
2. `attach-document.ts`: add `toComposerDocument(path)` (name = last path
   segment) and `addDocuments(current, paths)` that skips paths already attached.
   Keep `appendDocumentPaths` and `quotePromptPath` unchanged. `readImageAttachment`
   fills `name` and `path`.
3. `prompt-attachments.ts`: `splitPromptAttachments(text)` returns the body and
   the trailing run of lines that each parse as one quoted absolute path in the
   exact `quotePromptPath` form (single-quoted with no `'` inside, or
   double-quoted with `\\` and `\"` escapes). Lines are taken from the end and
   stop at the first non-matching line; the body loses the trailing newline.
   Round-trip test: `splitPromptAttachments(appendDocumentPaths(t, ps))` gives
   back `t` and `ps` for paths with spaces, `'`, `"`, `\` and Unicode.
4. Submit (`use-composer-submit.ts`): read `documents` from the store; the
   message sent is `appendDocumentPaths(text, documents.map(d => d.path))`.
   Empty-text + documents-only is a valid send. Clear documents with the draft.
   Every restore path (failed send, queue remainder, `/clear` failure) restores
   documents as documents, not as text. Queue shorthand (`->`, `=>`): documents
   ride on the first item, like images do.
5. `restoreTabComposer` takes a `documents` argument and prepends them like
   images.
6. Filter non-prompt-safe paths (`isPromptSafePath`) when documents are added,
   not at send time, so the user sees the warning while composing.

## Validation

- `bunx vitest run src/renderer/lib/prompt-attachments.test.ts src/renderer/components/layout src/renderer/stores`
- A submit test asserting the RPC message text equals today's paperclip output
  for the same files.

## Risks and rollback

- A restore path missed leaves documents stranded: grep every `previousImages`
  and `restoreDraft` call site and give each a documents twin.
- Rollback: revert; the paperclip still uses `appendDocumentPaths` until phase 4.
