# Ultra evidence packet — side-by-side document preview

Immutable input shared by all five candidate planners. Do not edit after dispatch.

## Request (verbatim)

> create a preview so i can open preview of output/input file like docx, pptx, etc. side by side without leaving the window --ultra --advice --tdd

Flags: `--tdd` (test-first in every phase: failing test, then code, then green;
a test matrix and exact verification commands per phase), `--advice` (the plan is
executed by a weaker Sonnet-class model: every phase is an ordered task list,
each task with Goal / Target files and symbols / Steps / Success criteria /
Verify; Verify is a mechanical comparison — exact command plus exact expected
exit code or output — and every phase file contains the literal Failure Protocol
block shown at the end of this packet). No `--yagni`: deliver the full requested
scope, add nothing beyond it.

## Outcome (controller's reading of the request)

Inside the Sai ATLAS window, the user can open a read-only preview of a file next
to the conversation (chat stays visible and usable) for:

- **Output files**: files the assistant made — the office tool cards
  (`office_report` → .docx, `office_slides` → .pptx, `office_clean` → .xlsx) and
  files named in tool cards (Write tool `PathLink`) or linked in model markdown.
- **Input files**: files the user attached (paperclip, drop) and files in the
  workspace Files panel.

Formats: .docx, .pptx, .xlsx (and .xls/.ods/.csv where feasible), .pdf, images,
plus the text/markdown the Files panel already previews. "etc." = the formats the
attach dialog already accepts (`ATTACH_FILTERS` in
`src/renderer/components/layout/attach-document.ts`: md, txt, docx, xlsx, xls,
ods, csv, pptx, pdf, png, jpg, jpeg, webp).

Non-goals (controller): editing documents; converting or writing files; previews
for audio/video/archives (show type + Open externally); multi-file tabs inside the
preview are not requested (one previewed file at a time is enough unless a
candidate justifies otherwise).

## Hard constraints (from repo evidence)

1. **No LibreOffice / headless renderer on SAI OS** (WPS is the default office
   suite). Source: `plans/reports/research-261005-1338-how-claude-creates-office-files.md`
   lines 192 and 205. Rendering must happen in the renderer with JS libraries.
2. **Two shells, one renderer.** Linux = Tauri 2 on system WebKitGTK (Rust core
   in `src-tauri/`); macOS = Electron 44. Every new IPC command needs: the type in
   `src/shared/ipc-types.ts` (`IPC_COMMANDS`, payload/result types, `OmpApi`), the
   bridge in `src/shared/bridge/create-omp-api.ts`, the Electron handler in
   `src/main/ipc.ts`, the Rust handler in `src-tauri/src/services/ipc.rs`
   registered in `src-tauri/src/services/mod.rs` (scope table ~line 57 AND
   `reg.register` ~line 89), Rust unit tests with TS twins
   (`scripts/check-test-parity.ts`, mapping in `src-tauri/contracts/<module>.parity.json`),
   regenerated API snapshots (`bash scripts/check-module.sh snapshots`).
3. **CSP** (identical in `src/renderer/index.html`, `quick-entry.html` and
   `src-tauri/tauri.conf.json`; guarded by `src/main/packaging-config.test.ts`
   ~lines 269 and 335):
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:`.
   No eval, no CDN, no frame-src beyond self. A CSP change is a public-contract
   change and must update the guard test.
4. **Lazy heavy deps.** `scripts/check-renderer-chunks.ts` fails the build when a
   lazy vendor chunk (`LAZY_CHUNKS`) is statically reachable from the entry. Chunk
   rules live in `vite.renderer.shared.ts` (`VENDOR_CHUNK_RULES`). New renderer
   libraries must be dynamic-imported and given their own chunk rule + entry in
   `LAZY_CHUNKS`.
5. **Model/document content is untrusted.** Never `dangerouslySetInnerHTML` with
   raw model text (AGENTS.md). Office/PDF documents can carry hostile content; a
   renderer that emits HTML must be isolated or sanitized; no script execution,
   no remote fetches (CSP `connect-src 'self'` helps).
6. **i18n**: every user-visible string via `useT()` with keys in both
   `src/renderer/locales/en.ts` and `vi.ts` (`locales.test.ts` enforces parity).
7. **Tests**: vitest + linkedom harness (`src/renderer/components/chat/ThinkingBlock.test.tsx`
   pattern); zustand stores reset in `afterEach` via `reset()`/setters, never
   `mock.module()`. Tauri e2e in `e2e-tauri/` (`bun run test:e2e:tauri`), Electron
   e2e in `e2e/`. GUI runs on the virtual display (`scripts/virtual-display.sh run -- …`).
8. **Quality gates**: `bunx vitest run`, `bun run check:types`, `bunx biome check <touched files>`,
   `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`,
   `cargo test --manifest-path src-tauri/Cargo.toml --all-features`,
   `bun scripts/check-test-parity.ts <module>`, `bash scripts/check-module.sh snapshots`,
   `bun run build` (runs check-renderer-chunks).
9. Commits go to this GUI repo only; conventional commits, no plan IDs in code/test names.

## What already exists (reuse, do not rebuild)

- **Right-side inspector drawer** `src/renderer/components/layout/PanelContainer.tsx`:
  tabs `files` | `logs` (`PanelTab` in `src/renderer/stores/ui.ts` line 9;
  `panelTabFromPref` line 18 maps persisted prefs), resizable 360–840 px
  (`MIN_WIDTH`/`MAX_WIDTH`, drag limit `innerWidth*0.55`), width persisted in pref
  `gui.panelWidth`; docks as a flex sibling of `<main>` in `src/renderer/App.tsx`
  ~line 605, but becomes an absolute overlay when `≤1000px` (`COMPACT_QUERY`) or
  when the workspace is split (`useTabsStore(s => s.split)`).
- **Files panel preview** `src/renderer/components/panels/FilesPanel.tsx`: clicking
  a tree file sets `useUiStore.filePreviewPath` (`openFilePreview(path)` sets
  `panelTab: "files", panelVisible: true`); the panel reads via `window.omp.fs.read`
  (text, 200 KB cap) and shows markdown via `MarkdownRenderer` or `<pre>`; binary
  files show the `filesPanel.binary` message. Header has back, `PathLink`
  "open externally", "insert @mention".
- `openFilePreview` is also called from model-markdown links to local files
  (`src/renderer/lib/markdown.tsx` ~line 185, `ExternalLink`).
- **Office output card** `src/renderer/components/tools/OfficeFileRenderer.tsx`:
  `parseOfficeResult` accepts only absolute paths directly inside a
  `…/Sai ATLAS/` folder (Documents › Sai ATLAS), with buttons Open (system app via
  `window.omp.system.openPath`) and Show in folder. Kinds from
  `src/renderer/components/tools/office-tools.ts` (`OFFICE_TOOL_KINDS`). Test:
  `OfficeFileRenderer.test.tsx`.
- **Write tool card** `src/renderer/components/tools/WriteRenderer.tsx` line ~88
  uses `PathLink` (opens externally).
- **fs IPC**: `fs:list`, `fs:read` (workspace-confined text, cap 2 MB,
  `IpcFsReadResult{ok,content,truncated,binary,size}`), `fs:read-plan`,
  `fs:read-image` (absolute/`~` allowed because bytes only reach a local `<img>`;
  magic-byte sniff; size cap `FS_IMAGE_MAX_BYTES`; returns data URL). Electron
  handler `src/main/ipc.ts` ~line 1040; Rust `fs_read_image` in
  `src-tauri/src/services/ipc.rs` ~line 479 with `expand_home`,
  `workspace_fs::resolve_within`, `workspace_fs::sniff_image_mime`.
- **Attach**: `attach-document.ts` — images become composer image attachments,
  other files become quoted path lines (`quotePromptPath`) appended to the prompt.
- **Sibling plan (pending, not implemented)**
  `plans/261007-1931-drop-file-attachment-cards/plan.md`: adds drop support,
  `ComposerDocument {path,name}`, `AttachmentCard` components
  (`src/renderer/components/attachments/*`, `FileKind`, `fileKindOf(name)`), cards
  in the sent user bubble (`splitPromptAttachments`), and `fs:read-pdf` (absolute
  only, `%PDF-` sniff, 32 MB cap, base64) + `pdfjs-dist` with bundled worker and
  `isEvalSupported: false` for page-1 thumbnails (`src/renderer/lib/pdf-thumbnail.ts`).
  This preview plan must coordinate with it: either depend on it, or define the
  shared byte-read IPC / pdf.js loader so both plans use one, and state clearly
  what happens when the attachment-card plan has or has not landed.
- Dev deps already present: `jszip 3.10.2`, `exceljs 4.4.0`, `docx`, `pptxgenjs`
  (devDependencies today; moving one to `dependencies` for renderer use is a
  bundle decision).
- Office tools write OOXML via `assistant-pack/src/office/{report,slides,clean}.ts`;
  fixtures in `assistant-pack/test/fixtures/` usable as preview test inputs.

## Library research

See `plans/reports/researcher-261007-1935-in-app-office-preview-libs.md`
(controller-commissioned; recommendations per format, licenses, sizes, CSP and
WebKitGTK compatibility, sandboxing needs). Treat its findings as evidence;
deviate only with a stated reason.

## Open design questions candidates must resolve (with rationale)

1. Surface: a new `preview` tab in the existing inspector drawer vs. a dedicated
   preview pane (e.g. a split column) — must be genuinely side by side with the
   chat at common widths (1280–1920 px), including when the inspector currently
   overlays (split workspace, ≤1000 px).
2. Byte transport: one generic `fs:read-document` (bytes + sniffed kind) vs.
   per-format commands; path policy (absolute allowed like `fs:read-image`? size
   cap? magic-byte/OOXML sniff?) and how it relates to the sibling `fs:read-pdf`.
3. Rendering isolation for docx/pptx HTML output (shadow root, sandboxed iframe,
   sanitizer) under the CSP above.
4. Entry points: which buttons/links open the preview (office card, Write card,
   markdown file links, Files panel, attachment cards / user bubble).
5. Large/unsupported/corrupt files: caps, partial rendering (e.g. first N sheets
   rows/slides/pages), error states, "Open in system app" fallback.
6. Staleness: refreshing when the agent overwrites the same file.

## Required Failure Protocol block (copy verbatim into every phase file)

```markdown
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
```

## Phase file template (frontmatter + sections)

```markdown
---
phase: <N>
title: "<Phase Name>"
status: pending
priority: P1|P2|P3
effort: "<e.g. 4h>"
dependencies: []
---
# Phase <N>: <Name>
## Goal
## Files to Create / Modify   (exact repo-relative paths)
## Test Matrix (TDD)         (cases → test file → expected red then green)
## Tasks                     (### Task N.M — Goal / Target files and symbols / Steps / Success criteria / Verify)
## Verification              (phase-level gate commands with exact pass conditions)
## Risks & Rollback
## Failure Protocol          (verbatim block above)
```
