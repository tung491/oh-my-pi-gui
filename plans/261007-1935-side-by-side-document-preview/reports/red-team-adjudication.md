# Red-team adjudication and decision delta — 2026-10-07

Sources: `red-team-security.md`, `red-team-failure-modes.md`, `red-team-assumptions.md`,
`red-team-scope-contracts.md`, plus the verifier's winner defects in
`kongming-261007-ultra-verdict.md` (K1–K12). 38 reviewer findings deduplicated to 15.
All passed the evidence filter (file:line citations) and all were accepted by the user.

## Accepted findings

| # | Finding | Sev | Sources | Applied to |
|---|---|---|---|---|
| R1 | Shared pdf.js worker is destroyed per document (`loadingTask.destroy()` kills the cached `workerPort` worker); buffers are transferred, so retained `bytes` go empty; the shared loader also drops the thumbnail's 20 s timeout and gives callers no cancel handle | Critical | assumptions 1–2, failure 3, scope 5 | Phase 3 (loader contract, PdfPreview, thumbnail refactor), plan.md contracts |
| R2 | API snapshot gate also checks `src-tauri/contracts/ports.api.txt` (handlers take `ports::Caller`) | Critical | scope 1, assumptions 10 | Phase 1 files + Task 1.6 |
| R3 | Zip guard sums attacker-declared sizes; JSZip checks real size only after full inflate | High | security 1, failure 4 | Phase 2 Task 2.2, D5, Risks |
| R4 | Tauri handler is synchronous (`Reply::Ready`) inside the per-window serial queue; read is unbounded after stat (TOCTOU) | High | security 3–4, assumptions 5, failure 5 | Phase 1 Tasks 1.3/1.5 |
| R5 | Main-thread parse of large files (SheetJS parses all cells before the cap; no `sheetRows`; parse in `useMemo` sets parent state during render) | High | failure 5 | Phase 3 Task 3.5, Phase 4, Risks |
| R6 | docx-preview injects unescaped CSS (font names) that can style `:host` and cover the window; docked aside drops its stacking context | High | security 2 | Phase 4 Tasks 4.3/4.4, Phase 2 Task 2.7 |
| R7 | PDF renders all pages eagerly at full width × dpr, no pixel cap, canvases never freed | High | security 5, failure 9 | Phase 3 Task 3.6 |
| R8 | Split-pane switch remounts the preview with the other tab's id; relative paths resolve against the wrong workspace | High | failure 2 | Phase 2 Tasks 2.5/2.7, ui store |
| R9 | pptx e2e assertion passes before the renderer runs | High | failure 1 | Phase 4 Task 4.3, Phase 6 Task 6.1 |
| R10 | SheetJS drops exceljs formula cells without cached `<v>`; use `sheetStubs` + `cellFormula`, render `=${f}` | High | assumptions 3 | Phase 3 Tasks 3.1/3.5 |
| R11 | Broken gate commands: Task 4.2 greps `dist/*.d.ts` (types are under `dist/types/`); Task 5.3 grep matches `AttachmentCard.tsx` itself; Task 6.1 spec misuses `launch.project`, `until(…, 6000)`, missing `exactTextCount` import; Task 6.2 states the twin assertion rule backwards | High | security 8, assumptions 6–8, scope 2–4, failure 10 | Phases 4, 5, 6 |
| R12 | Widening writes the persisted `gui.panelWidth` pref (ratchets up, never restored) | High | failure 6, scope 6, assumptions 4 | Phase 2 Task 2.7 |
| R13 | Renders resolving after cleanup are never disposed (pptx viewer, docx ResizeObserver) | Medium | failure 7 | Phase 4 Task 4.3 |
| R14 | CSV through lossy `fs:read` ignores `binary`/`!ok`/`truncated`; duplicate "open externally" action and `preview.loading` duplicating `filesPanel.reading` | Medium | scope 8–9, assumptions 9 | Phases 2, 3 |
| R15 | Link guard misses pptx shape hyperlinks (`window.open` in library) and SVG `<a>`/`xlink:href`; `mailto:` allowlisted but both shells drop it | Medium | security 6–7 | Phase 4 Task 4.1/4.3, Phase 1 (shell allowlist) |

Verifier defects K1–K12 are also applied (K1 channel-count numbers, K2 `SplitAxis`
values, K3 sidebar restore, K4 speculative files list, K5 SHA-256 pin
`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`, K6 image
sniffer move covered by image tests, K7 images keep `fs:read-image`, K8
`root.host`, K9 cMaps on Electron `file://` gets an e2e check, K10 real sidebar
selector, K11 `.xls` accepts OLE or OOXML/HTML signature, K12 Reload button).

## User decisions (2026-10-07)

| Topic | Decision |
|---|---|
| Red-team findings | Apply all 15 |
| Refresh | Event-driven: re-check (size+mtime, `ifChanged`) only when a tool call that wrote this path finishes (`tool_execution_end` for Write/office tools naming the path) plus a Reload button. No polling. Keep scroll/sheet/page when unchanged; on change, re-render in place keyed on path, not version. |
| ≤1000 px | Dock at 50vw, hide the left sidebar while the preview is open, restore the sidebar's previous visibility on close |
| Spreadsheets | Vendor SheetJS CE 0.20.3 tarball under `vendor/`, SHA-256 pinned and verified in a task |
| pdf.js build | Modern build (SAI OS WebKitGTK ≥ 2.48); add a check in the Ubuntu 24.04 container smoke test |
| mailto | Widen `system:open-external` to accept `mailto:` in both shells (`src/main/ipc.ts:734`, `src-tauri/src/services/system.rs:16`) with twin tests |
| Path-less images | Preview in-memory images too: the preview state accepts either a file path or an image data URL (e.g. `{ kind: "path", path, tabId } | { kind: "image", dataUrl, name }`) |

Consequences: `statOnly` polling mode is removed from `fs:read-document`; an
`ifChanged`-style stat compare stays only if needed by the event-driven refresh
(prefer returning `mtimeMs` with each read and a cheap stat call).
