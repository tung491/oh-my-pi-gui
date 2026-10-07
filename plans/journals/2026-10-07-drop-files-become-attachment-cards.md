---
title: Drop files become attachment cards
date: 2026-10-07
summary: Dropped and picked files render as cards in the composer and the sent bubble; prompt contract unchanged
---

# Drop files become attachment cards

## What happened
Implemented plans/261007-1931-drop-file-attachment-cards in four phases (three in parallel, then wiring). Dropped or picked files now show as cards (image thumbnail, PDF page 1 via pdf.js, type icon otherwise) in the composer and the sent user bubble. The agent still receives `appendDocumentPaths(text, paths)`, byte-identical to the old paperclip output.

## Surprises and root causes
- **WebKitGTK hides file paths from HTML5 drops.** With Tauri's drop handler disabled, a file drop reports `text/uri-list` + `text/html`, no `Files`, empty `getData`. Tauri's handler would steal HTML5 DnD (pane split). wry's own code showed `drag-data-received` only observes; `drag-drop` returning true is what takes the drop. Fix: a Linux-only `drag-data-received` observer in `src-tauri/src/webview.rs` emits `system:native-drop-paths`; the renderer pairs it with the DOM drop (`resolveDroppedPaths`, 10 s freshness, cleared on window drop/dragend).
- **Link drops stopped inserting text** when `dragover` was cancelled for any uri-list drag: WebKit skips default insertion for a drag whose dragover the page claimed. The composer now claims only drags known to carry files.
- **pdf.js 6.4 shares one worker per port**; one render's `destroy()` killed concurrent renders and an awaited destroy could hang forever. Fix: private worker per render, bounded teardown, 20 s timeout, at most 2 renders at once.
- `fs:read-pdf` reads through one handle (fstat size, `%PDF-` sniff before the full read, cap+1 read) and runs on `spawn_blocking` in Tauri so a large PDF doesn't block send/abort.

## Decisions
- Kept `disable_drag_drop_handler`; no need for the plan's fallback (native handler), which would have broken HTML5 DnD.
- Accepted: sent-bubble image cards say "attached image" (no name in the message); session titles still include path lines.

## Next steps
- Live-test Wayland and Electron on macOS.
- Dev `resources/omp` was swapped for the Oct 6 Linux sidecar (old kept as `resources/omp.stale-20261004`).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
