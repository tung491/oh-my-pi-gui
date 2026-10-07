---
title: "Plan: dropped files become attachment cards"
date: 2026-10-07
summary: "Planned composer and transcript file cards for drag-and-drop, with PDF thumbnails"
---

# Plan: dropped files become attachment cards

## What happened
Planned `plans/261007-1931-drop-file-attachment-cards/` (4 phases; phases 1–3 run in parallel, phase 4 integrates). Dropping a file on the composer today inserts its path as text.

## Findings
- The Tauri shell disables the native drag-drop handler so HTML5 drag-and-drop keeps working for tabs and panes. A dropped file's path therefore has to come from `text/uri-list` on WebKitGTK, or from `webUtils.getPathForFile` on Electron. Phase 1 starts with a spike to confirm that WebKitGTK provides the list.
- `fs:read-image` already reads absolute paths. A new `fs:read-pdf` follows the same reasoning, with a `%PDF-` check and a 32 MB cap.
- The prompt format stays the same (quoted path lines after the text). The transcript parses those lines back into cards.

## Decision
The user chose cards in the transcript too, real page-1 PDF thumbnails (pdf.js), and any file type on drop.

## Next steps
Run `/ak:cook --parallel plans/261007-1931-drop-file-attachment-cards`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
