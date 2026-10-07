---
title: "Plan: side-by-side document preview"
date: 2026-10-07
summary: "Planned a read-only in-webview preview for office, PDF, image and text files beside the chat; best-of-5 plus red team"
---

# Plan: side-by-side document preview

**Date**: 2026-10-07 20:55 (Asia/Seoul)
**Severity**: Medium
**Component**: Workspace drawer, preview renderers, Tauri and Electron IPC
**Status**: Planned, no code changed

## What Happened
Planned `plans/261007-1935-side-by-side-document-preview/`: 6 phases, 35h. It is blockedBy `261007-1931-drop-file-attachment-cards`, which is being implemented uncommitted in this same tree, so phase work must wait for that to land or be rebased onto it.

Process was `--ultra`. Five Opus planners each wrote a candidate. A kongming verifier picked candidate 4 at 284/320 against 270 for the runner-up. That margin is low, so treat the choice as "good enough", not "clearly right". A 4-lens red team then produced 38 findings; 15 were accepted, 2 of them critical.

## The Brutal Truth
The plan is only as good as its unproven bets. The riskiest one, modern pdf.js on WebKitGTK 2.48, has never run on the target. Thirty-five hours rest on a probe that has not been executed yet.

## Technical Details
- SAI OS has no LibreOffice, so all rendering is JS inside the webview.
- pdf.js 6 has no `isEvalSupported` option and needs `useWasm: false`.
- `loadingTask.destroy()` kills the shared `workerPort` worker, so one preview closing breaks every other.
- JSZip checks real size only after inflate. Zip-bomb guards must count real inflated bytes, not header sizes.
- docx-preview injects unescaped CSS that can style `:host`; it must be contained.
- Tauri `Reply::Ready` handlers block the per-window serial IPC queue, so slow reads must not use them.
- Every new Tauri handler changes both `services.api.txt` and `ports.api.txt` snapshots.
- SheetJS drops exceljs formula cells that have no cached value unless `sheetStubs` and `cellFormula` are set.

## Decisions (7, made by the user)
Event-driven refresh plus a Reload button; dock the drawer at 1000px or less and hide the sidebar; vendored SheetJS 0.20.3, sha-pinned; modern pdf.js build; `mailto` widened in both shells; in-memory preview for pasted images. Rejected: polling refresh and floating the drawer over the chat.

## Root Cause Analysis of the Risk
These are library behaviours we only learned by reading sources during the red team. Without it, the worker kill and the formula-cell loss would have shipped.

## Lessons Learned
- Verify library option names against the pinned version, not memory.
- A low scoring margin between candidates means the red team matters more than the pick.
- Size guards must measure after decompression.

## Next Steps
- Phase 6 smoke probe gates the modern pdf.js build on WebKitGTK 2.48. It runs in Phase 6; if it fails, the build choice returns to the user.
- Phase 4.2 gate: confirm pptx-renderer `onNavigate` exists; unverified.
- Check Electron `file://` cmap loading for pdf.js.
- Start only after the attachment-cards plan is committed.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
