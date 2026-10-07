---
title: "Dropped files become attachment cards"
description: "Dragging files onto the composer shows ChatGPT-style file cards (thumbnail or PDF page, type icon, name) instead of quoted paths, in the composer and in the sent bubble."
status: completed
priority: P2
effort: 12h
branch: main
tags: [frontend, renderer, tauri, electron, ipc]
blockedBy: []
blocks: []
created: 2026-10-07
---

# Dropped files become attachment cards

## Outcome

Dropping one or more files onto the composer adds a card per file above the
textarea, like the reference screenshot: a preview area (image thumbnail, page 1
of a PDF, or a large coloured type icon) with a spinner while it loads, and a
footer with a type icon and the truncated file name. The paperclip uses the same
cards. After sending, the user bubble shows the same cards instead of the quoted
path lines. The agent still receives exactly what it receives today: images as
`ImageContent`, every other file as a quoted path line appended to the prompt.

## Decisions (user-confirmed 2026-10-07)

- Transcript: the sent user bubble renders cards too.
- Preview: real page-1 thumbnails for PDFs (pdf.js); type icon tile for others.
- Accepted types on drop: any file. The paperclip's filter is unchanged.

## Constraints

- The prompt contract does not change: `quotePromptPath` lines appended after the
  text, one per line (the pack skills were measured with that form).
- Tauri keeps `disable_drag_drop_handler` (HTML5 DnD powers tab reorder and pane
  split). Dropped paths come from the drop's `text/uri-list` on WebKitGTK and from
  `webUtils.getPathForFile` on Electron.
- Only drags carrying `Files` are handled; tab and pane drags pass through.
- CSP stays as is (`script-src 'self'`, `worker-src 'self' blob:`): pdf.js runs
  with its bundled worker and `isEvalSupported: false`.
- Every new string in both `en.ts` and `vi.ts`; linkedom tests; no `any`.

## Non-goals

- Uploading or copying files anywhere; cards reference the file on disk.
- Thumbnails for Office, audio or video files.
- Changing the paperclip's file filter or the starters' `/skill:` path form.

## Phases

| # | Phase | Owns | Depends on | Status |
|---|---|---|---|---|
| 1 | [Bridge: dropped paths and PDF bytes](phase-01-bridge-dropped-paths-and-pdf-bytes.md) | IPC types, bridge, preload, Electron + Tauri handlers, `lib/dropped-files.ts` | none | completed |
| 2 | [Composer document model and prompt serialization](phase-02-composer-document-model.md) | `stores/composer.ts`, `stores/tabs.ts` restore, `attach-document.ts`, `use-composer-submit.ts`, new `lib/prompt-attachments.ts` | none | completed |
| 3 | [Attachment card components](phase-03-attachment-card-components.md) | new `components/attachments/*`, `lib/pdf-thumbnail.ts`, `package.json`, locales | none (codes against the phase 1 contract) | completed |
| 4 | [Composer and transcript integration](phase-04-composer-and-transcript-integration.md) | `InputArea.tsx`, `MessageBubble.tsx`, e2e check | 1, 2, 3 | completed |

Phases 1–3 run in parallel with disjoint files; phase 4 wires them together.

## Shared contracts (fixed now so phases 1–3 can run in parallel)

```ts
// src/shared/ipc-types.ts (phase 1)
export interface IpcFsReadPdfResult { ok: boolean; data?: string /* base64 */; size: number; error?: string }
// window.omp.fs
readPdf(path: string): Promise<IpcFsReadPdfResult>;
// window.omp.system (Electron only; undefined under Tauri)
pathForFile?: (file: File) => string;

// src/renderer/lib/dropped-files.ts (phase 1)
export function droppedFilePaths(data: DataTransfer): string[];
export function isFileDrag(data: DataTransfer | null): boolean;

// src/renderer/stores/composer.ts (phase 2)
export interface ComposerDocument { path: string; name: string }
// ComposerImage gains optional `name?: string` and `path?: string`

// src/renderer/lib/prompt-attachments.ts (phase 2)
export function splitPromptAttachments(text: string): { body: string; paths: string[] };

// src/renderer/components/attachments (phase 3)
export type FileKind = "image" | "pdf" | "word" | "sheet" | "slides" | "audio" | "video" | "archive" | "text" | "code" | "file";
export function fileKindOf(name: string): FileKind;
export interface AttachmentCardProps {
  name: string; kind: FileKind; path?: string;
  preview?: string;          // data URL for images
  onRemove?: () => void;     // composer only; absent in the transcript
}
export function AttachmentCard(props: AttachmentCardProps): ReactElement;
export function AttachmentStrip(props: { children: ReactNode }): ReactElement;
```

## Acceptance criteria

1. Dropping a PDF, an image, an mp3 and a zip on the composer (Tauri on Linux,
   Electron on macOS) shows four cards; no path text enters the textarea.
2. The PDF card shows its first page after a spinner; the image card its
   thumbnail; others a type icon. Long names truncate with an ellipsis and the
   full path is the card's tooltip.
3. Each composer card has a keyboard-reachable remove button.
4. Sending yields the same RPC payload as the paperclip today: images in
   `images`, other paths as quoted lines after the text.
5. The sent user bubble shows the cards and only the typed text; copy-message
   copies only the typed text.
6. A failed send restores text, images and document cards to the issuing tab.
7. Dragging a tab or pane still works; dropping text still inserts text.
8. `bunx vitest run`, `bun run check:types`, biome on touched files, clippy,
   `cargo test`, test parity and API snapshots all pass.

## Risks

- WebKitGTK may not expose `text/uri-list` for file drops in every compositor
  (Wayland vs X11). Phase 1 verifies this first; the fallback is listed there.
- pdf.js adds about 1 MB to the renderer bundle and a worker; it is loaded with a
  dynamic import, only when a PDF card mounts.
- Reading a PDF's bytes outside the workspace widens `fs:` reads. Bounded by a
  `%PDF-` sniff and a 32 MB cap, mirroring `fs:read-image`'s rationale that the
  bytes stay in a local render.
- The transcript parser could turn a user's hand-typed trailing quoted path into
  a card. Accepted: it only matches absolute paths in the exact quoted form.

## Validation commands

```bash
bunx vitest run
bun run check:types
bunx biome check <touched files>
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
bun scripts/check-test-parity.ts
bash scripts/check-module.sh snapshots
```
