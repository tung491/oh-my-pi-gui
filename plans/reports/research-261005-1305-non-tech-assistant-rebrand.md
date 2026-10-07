# Research report: rebranding Sai ATLAS as a private, local assistant for non-technical users

Date: 2026-10-05 (Asia/Seoul). Scope: GUI repo `/home/tung491/WORK/oh-my-pi-gui` (branch `main`, HEAD `7677ba1`) and agent `/home/tung491/WORK/oh-my-pi/packages/coding-agent` (omp 18.4.8, HEAD `f674c994a9`). Flags: `--yagni`, `--ultra`. Per the hard rules, nothing was written to disk; this message is the whole report.

## Outcome and recommendation

1. **Rebrand by changing copy only.** Rewrite README, `site/`, the package descriptions, the locales (en and vi), tray and menu labels, empty states and starter cards to follow the script's message: "Private, local AI for everyday work." The product name, `appId`, profile path, the `omp` agent name and the two-locale rule do not change.
2. **Remove code mode by merging the lanes.** The sidebar's Code/Work split becomes a single "Assistant" lane that runs in the existing GUI-owned workspace. Delete every surface that only serves developers. Also delete every surface that sends data to a cloud service, because it would contradict "No cloud. No data leaks": Live Voice (OpenAI realtime), Collaboration (relay), Share (GitHub gist), and Claude/Codex import.
3. **Leave the agent's source alone.** Narrow what the model sees with omp's existing `--tools` allowlist instead of patching tools out of the sidecar. This adds no new `patches/omp` file and no upstream-sync cost.
4. **Add office and OS help as a GUI-owned "assistant pack".** The pack is a set of custom tools that ship as a bundled resource and load with omp's existing `--extension <dir>` flag:
   - `create_document` writes a .docx with `docx` 9.8.1.
   - `clean_spreadsheet` cleans a sheet and adds totals with `exceljs` 4.4.0.
   - `create_slides` builds a .pptx with `pptxgenjs` 4.0.1.
   - Three Linux OS tools cover system status, opening things, and a fixed list of settings.

   The model only writes Markdown or picks options. Plain code produces the file in one call. This is the same pattern AnythingLLM ships with local models. It does not require Python or LibreOffice, and it works offline from the first run.
5. **Small models are the main risk.** Google's Gemma 4 model card scores the bundled E2B at 24.5% and E4B at 42.2% on the Tau2 agentic benchmark, against 68.2% for 26B A4B. The design therefore keeps each file to one tool call with a short tool list, and Phase 0 measures real success rates before the rest of the work starts.

**Ranked implementation routes for docx/xlsx/pptx** (section 3.1 has the full comparison):

1. GUI-owned custom-tool pack with bundled JS libraries.
2. Patches to omp that add built-in tools.
3. Skills that drive the JS eval tool.
4. Skills that drive the Python eval tool.
5. LibreOffice headless.

## Table of contents

1. Positioning and rebrand copy
2. Removal list (delete vs keep), with the file-level table
3. Additions: route evaluation, tool contracts, wiring, minimum UX, OS assist
4. External evidence
5. Phased plan with acceptance criteria
6. Risks
7. Unresolved questions
8. Sources

---

## 1. Positioning and rebrand copy

### 1.1 What must not change

These come from `AGENTS.md`.

| Invariant | Where it is enforced |
|---|---|
| Product name "Sai ATLAS", always both words | `PRODUCT_NAME` in `src/shared/product.ts`; locale key `brand.name` (`src/renderer/locales/en.ts:3099`) |
| `appId` `vn.io.vif.saiatlas` and the Windows `nsis.guid` pin | `packaging-config.test.ts` |
| Profile path `<appData>/@oh-my-pi/omp-gui`; never add `productName` | `src/main/pin-user-data.ts` |
| The agent keeps the omp name (`omp` CLI, `~/.omp`, `omp://`) | `locales.test.ts:96-100` (`AGENT_SCOPE_OMP`) |
| en and vi keys stay identical | `locales.test.ts` ("exposes the same keys in en and vi") |
| Model output goes only through `MarkdownRenderer` | `src/renderer/lib/markdown.tsx` |

The rebrand changes positioning, not identity. The tagline goes from "AI assistant for SAI OS" to "the private AI assistant for everyday work on SAI OS".

### 1.2 Copy surfaces to change

| Surface | Current text (evidence) | Change |
|---|---|---|
| `README.md` (774 lines) | "A desktop home for parallel coding agents" (`:5`); a dev feature table (`:36-60`); a full Chinese duplicate (`:396-774`); 12 dev screenshots in `docs/screenshots/en/` | Rewrite around the script's eight lines: Private, Local, Word report, spreadsheet cleanup, slides, OS help, sovereignty. Keep Install, Ollama, Troubleshooting and Release process. Move build-from-source and release notes for maintainers under a "Development" heading. The app no longer ships a zh locale (only `en.ts` and `vi.ts` exist), so drop the Chinese half rather than translate it (open question 6). |
| `site/index.html` | `<title>` "One window. Every session in parallel." (`:6`), meta "GUI for the omp coding agent… SSH…" (`:7`), hero `:383`, sections on Skills/MCP/SSH/debug console (`:500-543`) | New hero "Private, local AI for your everyday work", three feature blocks (Word, Excel, PowerPoint), one OS-help block and one privacy block. Delete the dev sections and their `site/assets/*.webp`. The release links are read from the API, so release handling needs no change. |
| `package.json:6`, `src-tauri/tauri.linux.conf.json:10-11` (deb/AppImage short and long description, which also feeds `Comment=` in `src-tauri/linux/vn.io.vif.saiatlas.desktop:4`) | "a desktop GUI for the omp coding agent" | "Sai ATLAS, the private AI assistant for everyday work on SAI OS: reports, spreadsheets, slides and help with your computer, running locally." |
| Sidebar locale keys (`en.ts:320-331`) | `sidebar.mode.code` "Code" / "Build, debug, and ship in a project"; `sidebar.newCode` | Delete the mode keys. Keep one `sidebar.newWork` key → "New task" / "Việc mới". |
| Empty state and starters (`ChatStream.tsx:232-246`, `en.ts:2054-2075`) | "What should we build?"; starters "Understand the project", "Fix something", "Build a feature", "Review changes" | Title "What can I help you with today?" / "Hôm nay tôi có thể giúp gì cho bạn?". Four starters follow the script: Word report, clean spreadsheet, slides from a report, help with my computer (section 3.4). |
| Onboarding (`en.ts:3156-3211`) | Already plain-language and local: "nothing leaving the computer" (`:3157`) | Keep. Only change `welcome.continue` to "Start using Sai ATLAS". |
| Tray (`src/main/tray-labels.ts:16-41` and Rust twin `src-tauri/src/desktop/tray_labels.rs:70-71,99-100`) | "Open Project…", "Handoff", "Switch Workspace", "Add Workspace…", "Usage Stats…", "Fast Mode" | Delete the project, workspace, handoff, usage and fast-mode entries in both files together; `tray-labels.test.ts` is parity-mapped. |
| App menu (`src/main/menu.ts:57-300`, Rust `src-tauri/src/i18n.rs:80-115` and `desktop/menu.rs`) | Open Project, Agent Hub, PR Center, Extensions, Inventory, Model Roles, Debug Console, Branch Picker, Session Tree | Delete those items in both shells (section 2). |
| `CHANGELOG.md` | none | One "Sai ATLAS becomes a private assistant for everyday work" entry. |

**Honesty constraint on the copy.** The script says "No cloud." The current product still makes these network calls:
- The updater reads GitHub Releases.
- Onboarding downloads models from `hf.co` and can install Ollama from `ollama.com`.
- The agent exports OTLP telemetry only when an `OTEL_*` endpoint is set (`telemetry-settings.ts:9-17`, `telemetry-export-otlp.ts:4`).

The accurate claim is "Your files and conversations stay on this computer. Sai ATLAS only goes online to download models and updates." Use that wording in README, site and onboarding rather than an unqualified "no cloud", and verify it with an egress audit in Phase 5.

---

## 2. Removal list

### 2.1 Principles

- **Delete, don't hide.** For each surface, remove the component, its locale keys in **both** `en.ts` and `vi.ts`, its tests, its command-palette entries (`src/renderer/lib/command-registry.ts`, 1,810 lines), its hotkeys (`lib/keymap.ts`, `HotkeysDialog`) and its menu items in **one** commit.
- **Main-process modules come out in pairs.** A module with a Rust twin is deleted together with that twin and its `src-tauri/contracts/*.parity.json` entry, so `scripts/check-test-parity.ts` and the API snapshots (`scripts/check-module.sh snapshots`) stay green.
- **Never delete agent tools.** The sidecar is upstream code. Restrict what the model sees with `--tools` (section 3.3). A tool that is not on the allowlist is never offered, and any old transcript that used it still renders through `GenericRenderer`.

### 2.2 File-level removal table

| # | Surface | Files to delete or edit | Why | Blast radius |
|---|---|---|---|---|
| R1 | **Code mode** (Code/Work lane split, project grouping, quick-chat button) | `layout/Sidebar.tsx`: `SidebarMode` (`:102`), default `"code"` (`:148`), lane effects (`:250-265`), `codeSessions` and `groups` by cwd (`:270-328`), segmented control (`:698-723`), code/chat branches (`:730-746`, `:807-822`). Also `Sidebar.test.tsx`, `dialogs/WorkspaceDialog.tsx`, `dialogs/WorkspaceDirsDialog.tsx` (+test), `lib/workspace-dirs.ts`, keys `sidebar.mode.*`, `sidebar.newCode`, `sidebar.emptyCode`, `workspaces.*`, `workspaceDirs.*` | The request names code mode explicitly. One lane with one "New task" button. | Renderer only. **Keep** `src/main/default-workspace.ts:5-9` and `src-tauri/src/paths.rs:264-265`; the single lane still uses the GUI-owned workspace. Existing project sessions still show in the one list (open question 10). |
| R2 | Composer developer modes | `lib/input-modes.ts` (`!` bash, `$` python) and its use in `InputArea.tsx`; `layout/ComposerModes.tsx` (plan, goal, loop, vibe, roles, prewalk, steering; `:160-251`); `mode-visibility.test.tsx`; `panels/ModesPanel.tsx` (+test); `chat/dock/GoalDockBar.tsx` (+test); `chat/dock/PlanDockCard.tsx`; `dialogs/PlanApprovalDialog.tsx` (+test); `stores/plan-approval.ts`; `lib/loop-mode.ts`; keys `modesPanel.*`, `planApproval.*`, `planPanel.*`, `input.plan/goal/loop/roles/more.*` | Shell and Python sigils and agent-orchestration modes are developer features. | Renderer only. Sidecar slash commands stay in omp but are no longer exposed. |
| R3 | Git and code review | `panels/DiffPanel.tsx` (+projection test), `panels/RepositoryChanges.tsx` (+test), `panels/PrCenterWindow.tsx`, `panels/pr/*`, `stores/pr-center.ts` (+test), `dialogs/WorktreeDialog.tsx`, `dialogs/WorktreeCloseDialog.tsx`, `dialogs/BranchPickerDialog.tsx`, `dialogs/SessionTreeDialog.tsx` (+test, `session-tree-layout.ts`, `SessionTreeNodeCard.tsx`), `dialogs/HandoffDialog.tsx`, `ForkHandoffDialogs.test.tsx`, `stores/fork-handoff.ts`; keys `diffPanel.*`, `prCenter.*`, `worktree*.*`, `sessionTree.*`, `handoff.*` | Developer-only. | Renderer, plus tab-layout worktree fields (`src/main/tab-layout.ts`, Rust `desktop/tab_layout.rs`). Leave those fields in place; deleting them buys nothing and touches parity tests. |
| R4 | Multi-agent orchestration | `panels/AgentHubWindow.tsx` (+test), `agent-hub-settings.ts`, `hub-filter.ts` (+test), `SubagentDag.tsx`, `SubagentTranscript.tsx`, `subagent-graph.ts` (+test), `stores/subagents.ts`, `stores/subagent-graph.ts`, `chat/dock/AgentsDockCard.tsx` (+test), `dialogs/JobsDialog.tsx`; keys `agentHub.*` (67), `subagent.*`, `jobs.*` | The `task` and `wait` tools are excluded by the allowlist. | Renderer only. |
| R5 | Power-user model and provider tooling | `settings/ModelRolesWindow.tsx`, `settings/ModelCompare.tsx`, `settings/UsageWindow.tsx` (provider quotas, which mean nothing for Ollama), `dialogs/BenchmarkDialog.tsx`; keys `modelRoles.*`, `modelCompare.*`, `usage.*`, `benchmark.*` | Local Ollama only. One model picker is enough. | **Main and Rust pair:** `src/main/benchmark-runner.ts` (+test) with `src-tauri/src/omp/bench.rs`, the IPC `bench:run`/`bench:abort` (`omp/mod.rs:34-35,44-45`), `ipc-types.ts` `bench`, and parity entry `contracts/omp.parity.json:23`. Also update `e2e-tauri/desktop.e2e.ts:566-567`. |
| R6 | Statistics dashboard | `components/stats/*` (15 files), `stores/stats.ts`; keys `stats.*` (128), plus the `stats.*` entries in the `locales.test.ts` allow-lists | Costs, tokens and providers are developer metrics. Local cost is zero. | **Main and Rust pair:** `src/main/stats-server.ts`, `stats-client.ts`, `stats-restart-policy.ts` (+tests) with `omp/stats.rs`, `omp/stats_restart_policy.rs`, IPC `stats:fetch`/`stats:data` (`omp/mod.rs:33,39,43,58-60,135-153`), parity entries `omp.parity.json:15,19`. **The release gate `e2e-tauri/packaged-smoke.e2e.ts:365-385` uses the stats server as the shell's second omp child** to prove orphan cleanup; that step must be rewritten (for example to use an Ollama probe or a second tab) before deleting. Leave `sync-upstream.sh` step 5 (`gen:stats`) alone; it is agent-side. |
| R7 | Extension, plugin, MCP, hooks and security management | `panels/ExtensionsPanel.tsx` (+test), `panels/InventoryPanel.tsx` (+test, `inventory/*`), `panels/mcp/*`, `dialogs/ExtensionDialog.tsx` (+test), `ExtensionEditorDialog.tsx`, `ForceToolDialog.tsx` (+test), `ActiveToolsDialog.tsx`, `settings/SshSettingsPage.tsx` (+test), `settings/SecuritySettingsPage.tsx` (+test; this is a repository security scan); `SettingsWindow` tabs `skills`, `mcp`, `resources`, `marketplaces`, `templates`, `hooks`, `commands`, `security`, `ssh`, `advanced` (`settings-window-model.ts:33-43`); keys `extPanel.*`, `invPanel.*`, `mcp.*`, `pluginDetail.*`, `marketplace*.*`, `ssh.*`, `security.*`, `forceTool.*`, `activeTools.*` | Developer configuration. The assistant pack is code-controlled, so it needs no UI. | `SkillsSettingsPage.tsx` goes too. Skills are not part of the v1 design (section 3.1). |
| R8 | Debug and inspection | `dialogs/DebugConsoleDialog.tsx`, `dialogs/ContextReportDialog.tsx` (+test, delete **after** Phase 0 uses it to measure prompt size), `layout/ContextUsagePopover.tsx` (+test); keys `debug.*`, `contextReport.*`, `contextUsage.*` | Developer diagnostics. | Renderer only. |
| R9 | **Cloud-dependent** features | `dialogs/LiveVoiceDialog.tsx` (agent `live/transport.ts:74` calls `https://api.openai.com/v1/live/…`), `dialogs/CollabDialog.tsx` (relay, `en.ts:1789-1805`), `dialogs/ShareSessionDialog.tsx` (uploads a GitHub gist, `en.ts:34-39`), `dialogs/ImportForeignDialog.tsx` (Claude/Codex import); keys `live.*`, `collab.*`, `shareDialog.*`, `import.*`; `AGENT_SCOPE_OMP` collab and benchmark entries (`locales.test.ts:97-100`) | Each one contradicts "No cloud. No data leaks" or is developer-only. | Update `e2e-tauri/desktop.e2e.ts:567` and `e2e/desktop.e2e.ts`. |
| R10 | Renderers for excluded tools | `tools/AstEditRenderer`, `AstGrepRenderer`, `LspRenderer`, `GithubRenderer`, `DebugRenderer`, `HubRenderer`, `VibeRenderer`, `EvalRenderer`, `CoordinationRenderer`, `TaskRenderer` (+`task-render-utils.ts`), their registry rows in `tools/index.tsx:102-139`, and the matching cases in `UpstreamParityRenderers.test.tsx` | The model never calls these tools after the allowlist is in place. | Old sessions fall back to `GenericRenderer`. Lowest priority, Phase 2. |
| R11 | Nav rail | `Sidebar.tsx:584-651`: keep Search (session search), Ollama (`ollama.settings.title`), Settings. Remove Agent Hub, PR Center, Stats, Usage, Capabilities, Workspace panel, Hotkeys | Fewer destinations for non-technical users. | Renderer only. |
| R12 | Docs and marketing assets | `docs/screenshots/en/01-12`, `scripts/capture-showcase.ts`, `showcase-data.ts` and `showcase-fixture.ts` (synthetic `aurora-web` coding project), `site/assets/*.webp` | They show the old product. | Replace them with an office-scenario fixture, or drop the gallery to 3 shots (YAGNI). |

### 2.3 What must stay because the non-technical flow depends on it

| Keep | Reason |
|---|---|
| Ollama onboarding: `dialogs/FirstRunOnboardingDialog.tsx`, `components/onboarding/*`, `src/main/ollama/*`, `src-tauri/src/ollama/*`, `src/shared/ollama-catalog.ts` | This is the "local AI" story. It is already plain-language. |
| `settings/ProvidersWindow.tsx` (the Ollama window) and `dialogs/ModelPicker.tsx` | Changing models. |
| `dialogs/ApprovalDialog.tsx`, `layout/ApprovalControl.tsx`, tray approval labels | Safety for OS and file actions (section 3.4). |
| `panels/FilesPanel.tsx`, `tools/PathLink.tsx`, `system.openPath`/`showOpenDialog` (`ipc-types.ts:1312-1322`) | Attaching inputs and opening outputs. |
| Updater: `layout/UpdateBanner.tsx`, `settings/UpdatesSettingsPage.tsx`, `src/main/updater*.ts`, `src-tauri/src/updater/*` | The release path. |
| `panels/LogPanel.tsx`, `layout/SidecarBanner.tsx` | Support and troubleshooting. |
| Quick entry, dictation (local by default per `oh-my-pi/docs/local-models.md`), tray, deep links, theme and language pickers, session search and rename | Low cost and useful to non-technical users. |
| `chat/CodeBlock.tsx`, `MermaidBlock.tsx`, markdown math | Part of the single `MarkdownRenderer` path; models emit code fences and tables in ordinary answers. |
| Sidecar `--chat` plumbing (`sidecar.ts:301`, `manager.rs:550`, Rust `tabs/tab_spawn.rs`) | Remove only the UI entry point. The plumbing is parity-tested Rust, and removing it saves nothing (open question 2). |

---

## 3. Additions for non-technical users

### 3.1 Route evaluation for docx, xlsx and pptx

Scale: ++ strong, + adequate, − weak, −− blocking.

| Route | Offline on first run | Needs Python | Reliability with a small model | Output quality | Upstream-sync cost | Shell work | Rank |
|---|---|---|---|---|---|---|---|
| **A. GUI-owned pack of custom tools** (`docx`, `exceljs`, `pptxgenjs` bundled by `Bun.build`, loaded with `--extension`) | ++ (bundled) | no | ++ (one call; Markdown or option input) | + to ++ (headings, tables, Excel Table with totals and cached results) | ++ (no patch; public `CustomToolFactory` contract) | One spawn-flag change in each shell plus packaging | **1** |
| E. Built-in tools added through `patches/omp` | ++ | no | ++ | same as A | −− (a patch rebased on every sync; `build:omp` fails when it stops applying) | none | 2 |
| B. Skills plus JS `eval`, where the model writes `docx`/`pptxgenjs` code (Anthropic's approach) | − (`bun add` into the managed env needs network: `eval/js/package-installer.ts:153`) unless pre-seeded | no | −− (the model writes and debugs library code over many turns; E4B Tau2 42.2%) | ++ with a strong model | ++ | none | 3 |
| C. Skills plus Python `eval` with `python-docx` 1.2.0, `openpyxl` 3.1.5, `python-pptx` 1.0.2 | −− (pip packages missing; offline install impossible) | **yes** | −− (same as B) | + (`openpyxl` writes formulas with no cached values, so previews show blanks without a LibreOffice recalc, per Anthropic's xlsx SKILL.md) | ++ | none | 4 |
| D. LibreOffice headless (`soffice --convert-to`) | − (not installed with Ubuntu 24.04's "Default selection") | no | + | ++ | ++ | Recommends change in `finalize-deb.ts:74` | 5 (optional converter only) |

**Why A wins.** The sidecar already loads custom tools from extension package roots, so the GUI can add tools without touching agent source:
- omp's `--extension` flag registers a package root whose `skills/`, `tools/`, `prompts/` and other subtrees are discovered (`main.ts:1749-1756`, `discovery/omp-extension-roots.ts:1-15`, `cli/flag-tables.ts:218`).
- Custom tools are plain JS factories loaded with native Bun import (`extensibility/custom-tools/loader.ts:1-6`; `oh-my-pi/docs/custom-tools.md`).
- A custom tool can declare its own approval tier and plain-language approval lines (`custom-tools/types.ts:220-223`).
- `--tools` validation runs after custom tools are discovered, so custom tool names can be on the allowlist (`flag-tables.ts:190-199`).

**Production precedent.** AnythingLLM's Document Generation agent, built for local models, uses exactly `docx` 9.6.1, `exceljs` 4.4.0, `pptxgenjs` 4.0.1 and `pdf-lib` (`server/package.json`). It exposes one tool per format: `create-docx-file` takes Markdown content, and `create-excel-file` takes CSV per sheet.

**Required detail that is easy to miss.** `tools.xdev` defaults to `true` (`tools/settings.ts:883-887`), and custom tools default to `loadMode: "discoverable"` (`custom-tools/types.ts:206-207`). An unmarked pack tool would be hidden behind an `xd://` device that a small model would have to discover through `read`. Every pack tool must set `loadMode: "essential"`.

**Why not skills in v1 (YAGNI).** Reading a skill costs the model an extra tool call, and that extra multi-step hop is where small models fail. The tool descriptions plus a short `--append-system-prompt` carry the guidance instead.

**Library currency** (npm registry, checked 2026-10-05):

| Library | Version and date | Maintenance | Verdict |
|---|---|---|---|
| `docx` | 9.8.1, 2026-09-28, MIT | Repo pushed 2026-10-05 | Active |
| `pptxgenjs` | 4.0.1, 2025-06-26, MIT | Repo pushed 2025-11 | Fine |
| `exceljs` | 4.4.0, 2023-10-19, MIT | Repo last pushed 2025-01; 816 open issues | Stale; risk noted in section 6 |
| `xlsx` (SheetJS) | npm 0.18.5 (2022) | Carries CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS); fixed only in CDN builds ≥0.20.2; cell styling is Pro-only | Fallback only |
| `marked` | 18.0.14, 2026-09-22, MIT | — | Markdown lexer for the docx and pptx tools |

ExcelJS cannot calculate formulas, but it stores a result you supply alongside the formula (`{ formula: 'SUM(B2:B9)', result: … }`), and its Excel Tables support `totalsRowFunction` (README, "Formula Value" and "Totals Functions"). Totals therefore display correctly in any viewer without a recalculation step.

### 3.2 Tool contracts

All tools set `loadMode: "essential"` and have an `approval` tier and plain-language `formatApprovalDetails`. None of them overwrites a file: a name collision gets " (2)" appended. Outputs go to `~/Documents/Sai ATLAS/`, resolved with `xdg-user-dir DOCUMENTS` so localized names such as "Tài liệu" work.

| Tool | Parameters | Behaviour | Tier |
|---|---|---|---|
| `create_document` | `title`, `markdown`, `file_name?` | `marked` lexer → `docx` headings, paragraphs, bold and italic, lists and tables, with a simple brand style. This is "rough notes → polished Word report" (script line 4). The input notes reach the model through the existing `read` tool, which already converts docx, xlsx, pptx and pdf to Markdown (`src/markit/converters/*`). | write |
| `clean_spreadsheet` | `path`, `sheet?`, `add_totals = true` | Steps, in order: read .xlsx or .csv with `exceljs` → trim whitespace → drop empty rows and columns → remove exact duplicate rows → convert numbers and dates stored as text → detect the header → write `<name> (cleaned).xlsx` as an Excel Table with a SUM totals row (results supplied), header frozen, columns auto-sized. Returns a plain summary such as "removed 4 blank rows, converted 2 columns to numbers". The original file is never modified. This is script line 5. | write |
| `create_slides` | `title`, `markdown`, `file_name?` | One slide per `##` heading, bullets from list items, a title slide and a brand theme, built with `pptxgenjs`. The model reads the report (`read`) and writes a Markdown outline. This is script line 6. Markdown input instead of nested JSON is deliberate, because small models produce malformed JSON more often (Open WebUI docs, section 4). | write |

Creating spreadsheets from scratch, .xls/.ods input and PDF export are not in the script, so they are cut (YAGNI; open question 9).

### 3.3 Wiring (both shells)

- **Source and build.** The pack's source lives in the GUI repo, because it is GUI-owned and not agent code. A new `scripts/build-assistant-pack.ts` runs `Bun.build` (target `bun`, all dependencies bundled, no `@oh-my-pi/*` imports; it uses the injected `pi` API) and writes `resources/assistant-pack/tools/*.js`, which is gitignored like `resources/omp`. The pack directory must have no top-level `.js` file other than an intentional `index.js`, because a configured extension directory loads top-level `.ts`/`.js` files as extension modules (`extensions/loader.ts:526-531,652-654`).
- **Spawn flags.** Add code-controlled `--extension <pack>`, `--tools read,find,write,ask,create_document,clean_spreadsheet,create_slides,system_status,open_item,os_setting` and a short `--append-system-prompt` in:
  - `src/main/sidecar.ts:298-301` (Electron, still shipping on macOS and Windows), and
  - `src-tauri/src/omp/manager.rs:543-551` (Tauri Linux), with matching tests in both so parity holds.
  - Add `--extension` and `--tools` to `DENYLISTED_FLAGS` (`src/shared/launch-profile.ts`) and the Rust denylist (`manager.rs:134-139`) so a launch profile cannot override them. The launch-profile UI disappears with the Advanced tab anyway.
- **Packaging.**
  - Electron: `extraResources` in `electron-builder.yml`, `.x64.yml` and `.win.yml`.
  - Tauri: `src-tauri/linux/sidecar.conf.json`.
  - Resolve the pack path in the shells next to `resolveBundledOmp` / `paths::resolve_bundled_omp`.
- **Excluded tools.** `bash`, `eval`, `edit`, `task`, `browser`, `computer` (already off by default, `tools/settings.ts:576-579`), `web_search`, `fetch` and the memory, `gh` and LSP tools are all left off. That removes code mode at the agent level and makes the "files never leave" claim enforceable.

### 3.4 Minimum UX

1. **Four starter cards** replace `STARTERS` (`ChatStream.tsx:232-246`):

   | English | Vietnamese | Opens the file picker first |
   |---|---|---|
   | "Turn my notes into a Word report" | "Biến ghi chú thành báo cáo Word" | yes |
   | "Clean up a spreadsheet and add totals" | "Dọn dẹp bảng tính và thêm tổng" | yes |
   | "Make slides from a report" | "Tạo slide từ báo cáo" | yes |
   | "Help with my computer" | "Trợ giúp máy tính" | no |

   The picker uses the existing `system.showOpenDialog` (`ipc-types.ts:1317`), which both shells already implement. Have a native speaker review the vi strings.
2. **Attach button** in `InputArea.tsx`. It reuses `showOpenDialog` and inserts the chosen path as an attachment block (the paste-attachment helper already exists). **Drag and drop is deferred**: the frozen Tauri foundation turns off the native drag-drop handler (`src-tauri/src/webview.rs:117,162,282`), and turning it back on is a change to a security file.
3. **Output card.** A `OfficeFileRenderer` registered in `tools/index.tsx` for the three tools. It shows the file name with an **Open** button (`system.openPath` → OS default app; `open-path-target.ts:24-35`, `ipc.ts:818-822`) and a **Show in folder** button (`openPath` on the folder). No new IPC is needed.
4. **Plain-language approvals.**
   - Add the pack tools to `WRITE_TOOLS` (`ApprovalDialog.tsx:44`) and `system_status` to `READ_TOOLS` (`:31`).
   - The tools' `formatApprovalDetails` produce sentences such as "Save a new Word file 'Q3 report.docx' in Documents › Sai ATLAS".
   - Default approval mode `write`: file creation runs without a prompt, while `os_setting` and `open_item` declare tier `exec` so they always ask.
5. **Opening outputs needs an office app.** LibreOffice is not part of Ubuntu 24.04's default selection. Adding `libreoffice-writer, libreoffice-calc, libreoffice-impress` as deb **Recommends** would mean editing `DEB_RECOMMENDS` (`src-tauri/linux/finalize-deb.ts:74`) and `tauri.linux.conf.json`, which AGENTS.md permits. Whether to do it depends on what the SAI OS image ships (open question 4).

### 3.5 OS assist on SAI OS (Linux only; registered only when `process.platform === "linux"`)

| Tool | Behaviour | Tier |
|---|---|---|
| `system_status` | Disk free, memory, battery, network state, printers. Read-only, using Node `os` plus `df`, `nmcli -t`, `lpstat` through the injected `api.exec`. | read |
| `open_item` | Open a file or folder, an installed app (`.desktop` id), or a GNOME Settings panel from a **closed list** (wifi, bluetooth, display, sound, printers, power). | exec (asks) |
| `os_setting` | A **closed** enum of settings: dark mode, night light, do-not-disturb, volume, text size, set through `gsettings` / `pactl`. | exec (asks) |

This follows the closed-command pattern the repo already uses for privileged Ollama remedies (`plans/261002-0906-ollama-only-onboarding/plan.md`, "Privileged commands come from a closed set"). The `computer` tool, which works from screenshots and pointer coordinates, is rejected: it needs vision and precise coordinates that Gemma-class models do not handle reliably. Raw `bash` stays excluded in v1 (open question 7).

---

## 4. External evidence

| Product | How it serves non-technical users | How it produces documents | Local? | What it means for this project | Source credibility |
|---|---|---|---|---|---|
| Claude file creation (announced 2025-09-09; GA with network controls 2025-10-21) | Chat produces .docx, .xlsx, .pptx and .pdf | Skills: `docx` npm for new Word files, `pptxgenjs` for decks, `openpyxl` plus LibreOffice `recalc.py` for sheets ("Use formulas, never hardcoded results"; openpyxl leaves formulas without cached values) | No | Confirms the JS library choice. The approach assumes a frontier model writing code in a sandbox, which does not transfer to E4B. | Primary (claude.com blog, anthropics/skills SKILL.md) |
| Claude Cowork (preview 2026-01-12; GA 2026-04-09) | Agent scoped to a local folder, aimed at non-coders | Same skills | No | Validates the "work inside my folder" model | **Secondary only** (third-party articles); not verified against an Anthropic page |
| Microsoft 365 Copilot Agent Mode and Office Agent (blog 2025-09-29; default experience reported 2026-04-22) | Describe the outcome; the agent asks follow-up questions and builds the file | Native in the Office apps | No | Ask-then-build fits the `ask` tool | Primary for the launch; secondary for the GA date |
| ChatGPT agent (2025-07-17) | Delivers editable slides and spreadsheets | Code in a cloud VM | No | Cloud, not comparable on privacy | Primary |
| **AnythingLLM** Document Generation agent (v1.12.0+) | Turn on a skill, then ask | One tool per format; `docx`, `exceljs`, `pptxgenjs`, `pdf-lib`; Markdown and CSV inputs; docs recommend "8B+ models for PowerPoint generation" | **Yes** (Ollama) | Closest precedent for route A, including its model-size warning | Primary (docs, source, package.json) |
| ONLYOFFICE AI plugin with Ollama (blogs 2025-02 and 2025-05) | AI inside the editor (summarize, translate) | Editing inside the editor, not generating files | Yes | A different pattern; not needed | Primary (vendor) |
| LM Studio (MCP from 0.3.17), Jan (MCP; inline tool approval in v0.8.0, 2026-05-22) | Generic tool hosting | No built-in office generation; the user configures MCP servers | Yes | Shows the gap Sai ATLAS can fill. Jan's inline approval supports plain-language approvals. | Primary (vendor changelogs) |

**Reliability of tool calling in small models.** The sources disagree, so the design assumes the weaker numbers:
- The Gemma 4 model card (last updated 2026-07-30) gives Tau2 averages of **E2B 24.5%, E4B 42.2%, 26B A4B 68.2%, 12B 69.0%, 31B 76.9%**. Google's launch blog headlines "86.4% on agentic tool-use". That figure is not split by size and should be read as a large-model result, so the model card's per-size numbers are the ones that apply to this catalog (`src/shared/ollama-catalog.ts:44-66`).
- Docker's evaluation (2025-06-30) measured tool-selection F1 of 0.733 for `gemma3:4B` against 0.919–0.933 for Qwen3 8B. It lists the failure modes: eager invocation, wrong tool, invalid arguments, ignored tool output.
- Open WebUI's documentation: "Small local models (under ~30B parameters) often produce malformed JSON or fail multi-step tool chains even in Native Mode."
- A known bug: Gemma 4 E4B tool calls are missed over Ollama's OpenAI-compatible streaming API (opencode issue #20995). Sai ATLAS already forces Ollama's native API (`PI_OLLAMA_API=ollama-chat`, `sidecar.ts:331`, `manager.rs`), which avoids that path.

**Design consequences.** Each artifact takes one tool call. Inputs are Markdown or options rather than nested JSON. The tool list is short. The assistant should require E4B or larger, and recommend 26B A4B where it fits (open question 3).

---

## 5. Phased plan

Removal comes before addition so there are fewer surfaces to rewire. Copy comes last so it describes what actually ships.

| Phase | Work | Acceptance criteria |
|---|---|---|
| **0. Spike (go/no-go), about 2 days** | Build a pack with `create_document`, load it with `--extension` in the **compiled** Linux sidecar under Tauri, and apply the `--tools` allowlist. Check that `exceljs` and `pptxgenjs` run under the Bun runtime. Use `ContextReportDialog` to measure the system prompt size and time-to-first-token on E2B, E4B and 26B A4B. Run 20 scripted tasks per model (report, clean-up, slides). | The tool appears top-level (not `xd://`). All three libraries produce files that LibreOffice opens. Success rate ≥80% on E4B for single-call tasks (the threshold is a proposal for the user to confirm). Time-to-first-token is recorded. **If the success rate is too low:** fall back to UI-driven actions, where the starter card calls the tool directly with model-written Markdown. That needs a new RPC path, so it is a re-plan. |
| **1. Remove code mode and renderer-only surfaces** (R1–R4, R7, R8 after measurement, R9 renderer parts, R10, R11) | Deletions as in section 2.2. Locale keys removed from en and vi together. | `bunx vitest run`, `bun run check:types` and `bunx biome check <touched>` are green. `locales.test.ts` passes with no stale allow-list keys. The sidebar shows one lane and one "New task" button. `rg -i "worktree\|prCenter\|agentHub" src/renderer` finds nothing. |
| **2. Remove main-process and Rust pairs** (R5 bench, R6 stats, tray and menu items) | Delete the TS and Rust twins together. Update `contracts/omp.parity.json`, `*.api.txt` snapshots and `desktop.parity.json`. Rewrite the stats step in `packaged-smoke.e2e.ts:365-385`. | `cargo clippy … -D warnings`, `cargo test`, `scripts/check-test-parity.ts` and `check-module.sh snapshots` all pass. `bash scripts/tauri-deb-smoke.sh <deb>` passes. Electron e2e passes. |
| **3. Assistant pack and wiring** | Pack source plus build script, the three office tools, spawn flags in both shells with tests, packaging in both shells. Add a pack-load check after `build:omp` in `sync-upstream.sh`. | Vitest unit tests: Markdown → docx structure, the clean-up rules, the totals table, Markdown → slide count. Packaged deb smoke creates one of each file offline (network disabled in the container). An upstream sync breaks loudly if the custom-tool contract changes. |
| **4. UX and OS assist** | Starters, attach button, `OfficeFileRenderer`, approval tiers and wording, default `write` mode, the three Linux OS tools. | Linkedom tests for the starter cards, the attach button and the output card. Approval dialog text is plain-language in en and vi. `os_setting` rejects values outside its enum. Tested on the virtual display (`scripts/virtual-display.sh`). |
| **5. Rebrand copy and release** | README, site, descriptions, CHANGELOG, new screenshots, egress audit of the privacy claim. | No "coding agent" string remains in user-facing copy (`rg -i "coding agent"` returns only agent-scope uses). `packaging-config.test.ts` and `tauri-packaging-config.test.ts` stay green (appId, GUID, version). The release passes the AGENTS.md release checklist. |

---

## 6. Risks

| Risk | Likelihood and impact | Mitigation |
|---|---|---|
| Small models fail at tool calls (E2B Tau2 24.5%) | High / high | One call per artifact, Markdown inputs, a 10-tool allowlist, the Phase 0 gate, and E4B as the minimum for the assistant. |
| The default omp system prompt is large for CPU inference (system prompts total about 95 KB under `src/prompts/system`; the effective size is unmeasured) | Medium / medium | Measure in Phase 0. If it is too slow, consider `--system-prompt` (already mapped in `manager.rs:192`). That risks losing tool guidance, so treat it as a later decision. |
| `exceljs` is stale (last release 2023-10) and may break under Bun | Medium / medium | Pin the version and cover it with unit tests. Fall back to SheetJS CE ≥0.20.3 from the CDN, never npm 0.18.5. |
| The Tauri migration is still in progress (macOS and Windows on Electron until Phase 12) | Certain / medium | Every main-process change is made twice. `paths.rs`, `i18n.rs` and `webview.rs` were frozen during the wave; confirm with the plan owner that the freeze has lifted before Phase 2. |
| The custom-tool API changes upstream | Low / medium | No patches are carried. A post-`build:omp` pack-load check in `sync-upstream.sh` catches it. |
| The privacy claim is overstated | Medium / high (trust) | Use precise wording (section 1.2) and run an egress audit in Phase 5. |
| Outputs cannot be opened because no office suite is installed | Medium / medium | Toast with guidance, plus an optional Recommends (open question 4). |
| Existing users lose developer features | Certain / low to medium | CHANGELOG note. Power users still have the `omp` TUI. |

---

## 7. Unresolved questions

1. Do the macOS and Windows builds continue, or is the product now SAI OS (Linux) only? Linux-only would halve the shell work and allow deleting Electron early.
2. Should the tool-free "Chat" stay as a fast mode for weak machines, or merge entirely into the Assistant?
3. Should E2B ("minimal") be offered at all for the assistant, given its 24.5% Tau2 score? What success threshold should Phase 0 require?
4. Does the SAI OS image ship LibreOffice or ONLYOFFICE? Should the deb declare them as Recommends?
5. Which OS tasks matter most to SAI OS users? The closed lists in section 3.5 are a proposal.
6. README languages: drop the Chinese half; is a Vietnamese README wanted?
7. Should v1 allow `bash` with approval as a fallback for OS tasks outside the closed list?
8. Output folder name and location (`~/Documents/Sai ATLAS`)?
9. Is .xls, .ods, or creating new spreadsheets from scratch needed in v1?
10. Should existing project ("Code") sessions stay listed, be archived, or be hidden after the merge?

---

## 8. Sources

External sources (accessed 2026-10-05):
- [Claude can now create and edit files](https://claude.com/blog/create-files), Anthropic, 2025-09-09; GA date per [Anthropic support](https://support.anthropic.com/en/articles/12111783-create-and-edit-files-with-claude)
- [anthropics/skills docx SKILL.md](https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md), [xlsx SKILL.md](https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md), [pptx SKILL.md](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md)
- Claude Cowork, secondary: [creati.ai, 2026-07-02](https://creati.ai/ai-news/2026-07-02/anthropic-debuts-cowork-a-claude-desktop-agent-that-can-work-inside-local-folders-for-non-techni/), [emergent.sh](https://emergent.sh/news/claude-cowork-officially-launched)
- [Microsoft: Agent Mode and Office Agent](https://www.microsoft.com/en-us/copilot/blog/2025/09/29/vibe-working-introducing-agent-mode-and-office-agent-in-microsoft-365-copilot/), 2025-09-29; [Petri, Ignite 2025](https://petri.com/microsoft-agent-mode-powerpoint-excel-word/)
- [OpenAI: Introducing ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/), 2025-07-17
- [AnythingLLM Document Generation Agent](https://docs.anythingllm.com/agent/usage/document-generation-agent); [create-files plugin source](https://github.com/Mintplex-Labs/anything-llm/tree/master/server/utils/agents/aibitat/plugins/create-files); [server/package.json](https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/master/server/package.json)
- [ONLYOFFICE: Ollama offline](https://www.onlyoffice.com/blog/2025/05/use-ollama-ai-models-offline-in-onlyoffice), 2025-05
- [LM Studio 0.3.17 MCP](https://lmstudio.ai/blog/lmstudio-v0.3.17); [Jan v0.8.0](https://www.jan.ai/changelog/2026-05-22-jan-v0.8.0), 2026-05-22
- [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4), updated 2026-07-30; [Google Developers Blog: Gemma 4](https://developers.googleblog.com/bring-state-of-the-art-agentic-skills-to-the-edge-with-gemma-4/), 2026-04-02
- [Docker: Local LLM tool calling, a practical evaluation](https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/), 2025-06-30
- [Open WebUI Tools docs](https://docs.openwebui.com/features/extensibility/plugin/tools/)
- [opencode issue #20995: Gemma 4 e4b tool calls via Ollama OpenAI API](https://github.com/anomalyco/opencode/issues/20995)
- [BFCL v4 overview (Epoch AI)](https://epoch.ai/benchmarks/berkeley-function-calling-leaderboard/review)
- [ExcelJS README](https://github.com/exceljs/exceljs) (Formula Value, Totals Functions)
- [SheetJS issue #2961 (CVE-2023-30533)](https://git.sheetjs.com/sheetjs/sheetjs/issues/2961); [CVE-2024-22363](https://vulert.com/vuln-db/CVE-2024-22363)
- [UbuntuHandbook: LibreOffice on Ubuntu 24.04](https://ubuntuhandbook.org/index.php/2024/05/install-libreoffice-ubuntu-2404/), 2024-05
- npm registry (`docx`, `exceljs`, `pptxgenjs`, `xlsx`, `marked`) and PyPI (`python-docx`, `openpyxl`, `python-pptx`), queried 2026-10-05

Repository sources opened (all cited inline above): `AGENTS.md`, `README.md`, `site/index.html`, `package.json`, `src/renderer/components/layout/Sidebar.tsx`, `src/renderer/components/chat/ChatStream.tsx`, `src/renderer/components/dialogs/ApprovalDialog.tsx`, `src/renderer/components/tools/{index.tsx,PathLink.tsx}`, `src/renderer/lib/input-modes.ts`, `src/renderer/locales/{en.ts,locales.test.ts}`, `src/main/{sidecar.ts,default-workspace.ts,tray-labels.ts,menu.ts,open-path-target.ts}`, `src/shared/{ipc-types.ts,launch-profile.ts,ollama-catalog.ts}`, `src-tauri/src/{omp/manager.rs,omp/mod.rs,paths.rs,webview.rs,i18n.rs,desktop/tray_labels.rs}`, `src-tauri/contracts/omp.parity.json`, `src-tauri/linux/{finalize-deb.ts,sidecar.conf.json}`, `src-tauri/tauri.linux.conf.json`, `e2e-tauri/{packaged-smoke,desktop}.e2e.ts`, `plans/261002-1441-tauri-shell-migration/plan.md`, `plans/261002-0906-ollama-only-onboarding/plan.md`; agent: `src/cli/flag-tables.ts`, `src/main.ts`, `src/discovery/{builtin.ts,omp-extension-roots.ts,helpers.ts}`, `src/extensibility/{custom-tools/loader.ts,custom-tools/types.ts,extensions/loader.ts}`, `src/tools/{settings.ts,essential-tools.ts,eval-backends.ts,approval.ts}`, `src/eval/js/package-installer.ts`, `src/live/transport.ts`, `src/telemetry-settings.ts`, `src/markit/converters/*`, `oh-my-pi/docs/{custom-tools.md,extension-loading.md,local-models.md}`.

Limitations: no code was run, so whether `exceljs` and `pptxgenjs` work inside the compiled sidecar, how big the effective prompt is, and how often Gemma 4 succeeds on these tools are all unverified until Phase 0. The Cowork dates come only from secondary sources. The SAI OS image contents and its GNOME version were not inspected.

---

## Appendix: ultra verifier ranking

Research conducted 2026-10-05 (Asia/Seoul) as a best-of-5 verifier run: five independent Opus-tier candidates, one Fable-tier verifier (kongming). The winning report above is reproduced unchanged.

| Candidate | R1 sources | R2 cross-verification | R3 coverage | R4 actionability | R5 honesty | Total |
|---|---|---|---|---|---|---|
| **B (winner)** | 18 | 18 | 18 | 18 | 19 | **91** |
| A | 17 | 19 | 18 | 17 | 16 | 87 |
| D | 16 | 17 | 17 | 17 | 17 | 84 |
| C | 15 | 18 | 17 | 16 | 17 | 83 |
| E | 16 | 15 | 17 | 16 | 17 | 81 |

All five passed the hard constraints (AGENTS.md invariants, `--yagni`, no fabricated sources or paths). B won on honesty about the "No cloud" claim and on the safer design forks: no `bash`, `--append-system-prompt`, and writing outputs to Documents instead of moving the workspace cwd.

### Verified corrections the winner misses (carry these into the plan)

1. SAI OS is LMDE 7 (Debian 13) with Cinnamon and WPS Office by default. `open_item` should target `cinnamon-settings <panel>`, not GNOME Settings, and the LibreOffice Recommends question is moot.
2. Pass `--extension`, `--tools`, `--append-system-prompt` and the approval flag only to agent sessions, never to `--chat` tabs. On a chat tab an explicit `--tools` becomes the chat allowlist, and any system-prompt flag suppresses the chat prompt (`coding-agent/src/main.ts:1592-1604`).
3. Make the approval default concrete. Either pass `--approval-mode write` and add it to the denylist, or use `always-ask` plus `policy: allow, override: true` on the office tools.
4. Use `set_force_tool` for the starter cards (`src/shared/rpc-types.ts:113`). The Ollama provider then sends only the named tool, with `required`.
5. The packaging description must change in `package.json:6` and `src-tauri/tauri.linux.conf.json:10-11` together (`scripts/tauri-packaging-config.test.ts:304-317`). Also switch the category from `DeveloperTool`/`developer-tools` to `Productivity`.
6. Chats render only inside the Code lane (`Sidebar.tsx:822`), so merging the lanes must move the Chat list.
7. Vietnamese number formats ("1.500" = 1500) can silently corrupt totals. Add a `decimal_separator` parameter and report every column that was reinterpreted.
8. Measure the context budget as about 80 KB of tool prompts plus a 12.7 KB system prompt against the 16,384 `num_ctx` cap, not the whole 95 KB directory.
9. API-drift evidence: the extension `execute` argument order differs between `examples/extensions/hello.ts` and `types.ts:705`. That justifies the pack-load check after `build:omp`.
10. The stats removal also affects `e2e-tauri/real-core.e2e.ts:58,166` and its Playwright twin (`check-twins.ts`).

ultra: picked=B/5 margin=low unanimous=no rejected_all=no

### User decision after the run (2026-10-05)

Multi-agent stays (this overrides removal row R4). Office work needs it, for example one helper drafts a report while another builds the slides. Changes that follow from it:

- The `task` tool joins the `--tools` allowlist.
- `task.maxConcurrency` is capped at 2. Its default is 32, and the local `ollama` provider has no concurrency cap.
- A two-helper task joins the Phase 0 spike.

### User decisions after the run, continued (2026-10-05)

- **Agent Hub:** both halves stay, the watch-and-stop view and agent-definition editing.
- **Helpdesk:** add a helpdesk helper to the assistant pack. It has four parts:
  - the `agents/helpdesk.md` agent;
  - the `skills/sai-os-helpdesk/SKILL.md` skill;
  - a new read-tier `diagnose(area)` tool that runs fixed, read-only checks;
  - fixes limited to the closed-list `os_setting` and `open_item` tools, each approved by the user.

  When it cannot fix a problem, it writes a support note to `Documents/Sai ATLAS`. omp discovers `agents/` and `skills/` inside `--extension` package roots (`oh-my-pi/docs/task-agent-discovery.md:153`, `docs/skills.md:93`).
- **System prompt (2026-10-05):** agent sessions now get `--system-prompt <pack>/system-prompt.md` instead of `--append-system-prompt`. This replaces omp's 12.7 KB coding persona with a prompt of about 1.6 KB for everyday work. omp renders it through `custom-system-prompt.md`, which keeps the skills, the rules and the working-folder context.
  - A missing file is used silently as a literal prompt (`system-prompt.ts:283-297`), so both shells must check that it exists.
  - Phase 0 compares first-request size and time to first token against today's default of about 6.8k tokens.
