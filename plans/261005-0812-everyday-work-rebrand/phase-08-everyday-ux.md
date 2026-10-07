---
phase: 8
title: "Everyday UX and SAI OS help"
status: done
priority: P1
effort: "3d"
dependencies: [6]
---

# Phase 8: Everyday UX and SAI OS help

## Goal

A non-technical user can start each everyday job from a card, attach any document, open the finished file from its card, read every approval as a plain sentence in en or vi, and (on Linux) get help with their computer.

## Context

- Plan index `./plan.md`. Doc section "Minimum UX".
- Empty state: `STARTERS` in `src/renderer/components/chat/ChatStream.tsx:232-246`; starter buttons dispatch `omp:fill-composer` (:578-586). The chat-only starters and `isChat` branch (:245) can go: after Phase 6 every tab is an agent tab.
- File picker: `window.omp.system.showOpenDialog(filters?, options?: { directory?: boolean })` → `Promise<string[] | null>`; without `directory` both shells already allow several files (`src/main/ipc.ts:851` `multiSelections`, `src-tauri/src/services/dialogs.rs:85` `multiple: !directory`). `window.omp.system.openPath(path)` (`src/shared/ipc-types.ts:1315-1320`). Platform: `window.omp.platform` (`ipc-types.ts:999`; :442 is the quick-entry bar's own API). Images by path: `window.omp.fs.readImage(path)` (`ipc-types.ts:1366`; absolute paths accepted, `src/main/ipc.ts:1105-1107`).
- RPC mode expands `/skill:<name> <args>` in a prompt (`coding-agent/src/modes/rpc/rpc-mode.ts:400-423`); the spike's starter form used exactly this and scored 9/9 on E4B.
- Attach button: `src/renderer/components/layout/InputArea.tsx:982-1003` (`accept="image/*"`).
- Tool renderers: `src/renderer/components/tools/index.tsx` `REGISTRY` (the office tools have no entry yet, so they render through `GenericRenderer`); props in `ToolCard.tsx:11-23` (no tool name; a renderer that needs one is registered through a wrapper, as `recall` is). A result's text comes from `resultText(result)` (`src/renderer/lib/format.ts:239`). An office tool's successful result text is one JSON object with exactly `file`, `kind`, `check` (Phase 4 Task 4.5); a failed one is `isError` with a plain sentence.
- Approvals: `src/renderer/components/dialogs/ApprovalDialog.tsx` (`isApprovalRequest` :20-29, `READ_TOOLS` :31, `WRITE_TOOLS` :44, `tierFor` :60). The request is a `select` whose `title` omp builds in `formatApprovalPrompt` (`oh-my-pi/packages/coding-agent/src/tools/approval.ts:366-386`): line 1 `Allow tool: <name>`, then an optional `Reason: <reason>` line, then the tool's `formatApprovalDetails` lines — for `write` these are `Path: <path>` and `Content:\n<content>` (`tools/write.ts:487-492`). The pack's tools define no `formatApprovalDetails`: an office tool's title is line 1 only, and `open_item`/`os_setting` add the `Reason:` line.
- Tests follow the linkedom harness in `src/renderer/components/chat/ThinkingBlock.test.tsx`; reset stores in `afterEach`.
- Every new string goes into **both** `src/renderer/locales/en.ts` and `vi.ts` (`locales.test.ts` enforces parity). A native-speaker review of the vi strings is delegated to agy (doc); mark each new vi string in the phase report.
- Renderer leftovers of removed shell features (this phase owns `src/renderer/**` in Wave C):
  - handlers for the menu actions Phase 7 deletes (`App.tsx` near :598, :608, :657, :701, :705, :731-748) and the tray `set-approval` handler (`App.tsx:724-726`);
  - `useSettingsStore.setApprovalMode` (`stores/settings.ts:211-222`) and the prefs migration that writes `tools.approvalMode` (`:101-107`); both write the user's global omp config;
  - Launch Profile fields whose flags Phase 6 now drops (tools, config file, system prompt, append system prompt, plan yolo, add dir, no rules: seven fields) in `components/settings/SettingsWindow.tsx` near :1325, including the "Launch command preview" lines for them;
  - schema setting rows for keys the pack's `config.yml` pins (`components/settings/SchemaSettingRow.tsx` and the schema pages): their writes go to the global layer, which the overlay outranks, so they would do nothing;
  - the sidebar-prefs fields Phase 2's one lane stopped reading (`./phase-02-renderer-removals.md` "Outcome"): `pinnedGroups` with its `toggleGroupPin` writer, and `workspaceLastUsed` with its `touchWorkspace` writer and the workspace half of `touchSession` (`stores/sidebar-prefs.ts:16-20`, `:24-35`, `:121-178`; `hooks/use-sidebar-recency.ts`). `groupAliases` stays: TabBar reads it.
- Old chat sessions are refused by both shells with `kind-mismatch` (Phase 6, and since `rebrand/wave-b-fixes` also on tab restore and "Open in new window", shown through `sidebar.kindMismatch`); the existing toast `sidebar.kindMismatch` (`hooks/use-session-switch.ts:190`) and the tab-spawn toast `tabs.kindMismatch` both get the new text here: give `tabs.kindMismatch` the same value as `sidebar.kindMismatch`, or point its one caller at `sidebar.kindMismatch` and delete it.
- e2e specs are not owned here; Phase 9 Task 9.0 brings them in line with this phase after the Wave C merge. Keep the raw approval details in the DOM (`<details><pre>`), which the e2e approval checks read (`e2e/desktop.e2e.ts:99-106`).
- Wave C: parallel with Phase 7.

## Ownership

- May modify or create: `src/renderer/**` only (including locales).
- Must not touch: `src/main/**`, `src/shared/**`, `src-tauri/**`, `e2e*/**`.

## Copy (en / vi)

| Key purpose | en | vi |
|---|---|---|
| Empty-state title | What can I help you with today? | Hôm nay tôi có thể giúp gì cho bạn? |
| Starter 1 | Turn my notes into a Word report | Biến ghi chú thành báo cáo Word |
| Starter 2 | Clean up a spreadsheet and add totals | Dọn dẹp bảng tính và thêm tổng |
| Starter 3 | Make slides from a report | Tạo slide từ báo cáo |
| Starter 4 (Linux only) | Help with my computer | Trợ giúp máy tính |
| Helpdesk prompt | I need help with my computer. | Tôi cần trợ giúp với máy tính. |
| Output card buttons | Open · Show in folder | Mở · Mở thư mục |
| Generic approval | Sai ATLAS wants to {action}. Allow it? | Sai ATLAS muốn {action}. Cho phép không? |
| Approval action, `office_report` | make a Word report | tạo báo cáo Word |
| Approval action, `office_slides` | make a slide deck | tạo bộ slide |
| Approval action, `office_clean` | make a cleaned copy of a spreadsheet | tạo bản sao đã dọn dẹp của bảng tính |
| File approval (`write`) | Save a file to {path}? | Lưu tệp vào {path}? |
| Old chat refused (`sidebar.kindMismatch` value, and `tabs.kindMismatch`) | This conversation is from an older version of Sai ATLAS. Start a new task. | Cuộc trò chuyện này từ phiên bản Sai ATLAS cũ. Hãy bắt đầu một việc mới. |

"Helpers" replaces "subagents" in user-visible English (`agentHub.`, `subagent.`, `subagentPanel.`, `jobs.`, `dag.` values); Vietnamese uses "trợ lý phụ". Change values only, never keys.

## Tasks

### Task 8.0 — Worktree
- Steps: `git -C /home/tung491/WORK/oh-my-pi-gui worktree add -b rebrand/p08-everyday-ux /home/tung491/WORK/worktrees/rebrand-p08 rebrand/everyday-work && cd /home/tung491/WORK/worktrees/rebrand-p08 && bun install && ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64 && ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp && bun run build:pack`
- Verify: `git -C /home/tung491/WORK/worktrees/rebrand-p08 branch --show-current` prints `rebrand/p08-everyday-ux`.

### Task 8.1 — Starter cards (test first)
- Target files: `src/renderer/components/chat/ChatStream.tsx`, create `src/renderer/components/chat/starters.ts` (pure data + `runStarter`), `src/renderer/components/chat/starters.test.ts`, `src/renderer/components/chat/ChatStream.starters.test.tsx`, locales.
- Starter data (in `starters.ts`):

  | id | skill | file filters (`showOpenDialog`) | linuxOnly |
  |---|---|---|---|
  | `word-report` | `word-report` | `{ name: "Documents", extensions: ["md","txt","docx","pdf"] }` | no |
  | `spreadsheet-cleanup` | `spreadsheet-cleanup` | `{ name: "Spreadsheets", extensions: ["xlsx","xls","ods","csv"] }` | no |
  | `slides-from-report` | `slides-from-report` | `{ name: "Documents", extensions: ["docx","md","txt","pdf"] }` | no |
  | `helpdesk` | `sai-os-helpdesk` | — | yes |

- `runStarter(starter, deps)`: a file starter calls `deps.showOpenDialog(filters)`; on `null` or `[]` it does nothing; otherwise it sends the prompt `/skill:<skill> '<path>'` through the same function the composer's Send button uses (find it in `InputArea.tsx`'s submit handler and `lib/composer-submit.ts`; inject it through `deps`). The helpdesk starter opens no dialog and sends `/skill:sai-os-helpdesk <localized helpdesk prompt>` through the same function; the skill runs in the main session (there are no helpers, plan.md Decisions "Helpers").
- Tests before (red): `starters.test.ts` — the four entries above; a cancelled dialog sends nothing; a chosen file sends exactly `/skill:word-report '/home/u/notes.md'`; the helpdesk starter sends exactly `/skill:sai-os-helpdesk I need help with my computer.` in en and calls `showOpenDialog` zero times. `ChatStream.starters.test.tsx` — renders four cards when `window.omp.platform === "linux"` and three on `"darwin"`; the empty-state title text is the new key's value.
- Verify: `bunx vitest run src/renderer/components/chat/starters.test.ts src/renderer/components/chat/ChatStream.starters.test.tsx` red first, then exits 0.

### Task 8.2 — Attach any document (test first)
- Target files: `src/renderer/components/layout/InputArea.tsx`, create `src/renderer/components/layout/attach-document.ts` and `attach-document.test.ts`.
- Behaviour: the paperclip opens `window.omp.system.showOpenDialog([{ name: "Documents", extensions: ["md","txt","docx","xlsx","xls","ods","csv","pptx","pdf","png","jpg","jpeg","webp"] }], )` (no options: several files are already allowed). Image paths (`png`, `jpg`, `jpeg`, `webp`) go through `window.omp.fs.readImage(path)` and the result is added with `setImages` in the same shape the current `fileToImage` produces (`input-area-utils.ts:73`; read both and convert, do not change `fileToImage`). Every other path is appended to the composer text on its own line, wrapped in single quotes. No drag-and-drop (deferred by the doc).
- Tests before (red): `splitAttachments(["/a/x.png", "/a/y.docx"])` returns `{ images: ["/a/x.png"], documents: ["/a/y.docx"] }`; `readImageAttachment` with a fake `readImage` returns the `setImages` shape; `appendDocumentPaths("hi", ["/a/y.docx"])` returns `"hi\n'/a/y.docx'"`.
- Verify: `bunx vitest run src/renderer/components/layout/attach-document.test.ts` red first, then exits 0; `bun run check:types` exits 0.

### Task 8.3 — Output card (test first)
- Target files: create `src/renderer/components/tools/OfficeFileRenderer.tsx`, `OfficeFileRenderer.test.tsx`; modify `src/renderer/components/tools/index.tsx`.
- Behaviour: register `office_report`, `office_slides` and `office_clean` in `REGISTRY`, each through a wrapper that passes the kind it must produce (`docx`, `pptx`, `xlsx`) to `OfficeFileRenderer`. The card renders only when all hold: `isPartial` is not true; `isError` is not true; `resultText(result)`, trimmed, parses as JSON with exactly the keys `file`, `kind`, `check` (strings); `kind` equals the tool's kind and `file` ends with `.<kind>`; `file` is absolute, has no `..` segment, and its parent directory's name is `Sai ATLAS`. Then render: an icon per kind, the file's base name, the `check` text, and two buttons — Open (`window.omp.system.openPath(file)`) and Show in folder (`openPath(dirname(file))`). Otherwise render `GenericRenderer` with the same props (a failed job shows its plain sentence there). `bash` keeps `BashRenderer`.
- Tests before (red): an `office_report` result renders the card with the base name; clicking Open calls `openPath` with the full path and Show in folder with its directory; malformed JSON, `isError: true`, `isPartial: true`, a `file` of `/home/u/.config/autostart/a.docx`, a `kind` that does not match the extension, a `docx` result on `office_slides`, and an extra JSON key each render GenericRenderer; `getToolRenderer` returns a non-Generic renderer for each of the three office tools.
- Verify: `bunx vitest run src/renderer/components/tools/OfficeFileRenderer.test.tsx src/renderer/components/tools/registry-inventory.test.ts` red first, then exits 0.

### Task 8.4 — Plain-language approvals (test first)
- Target files: `src/renderer/components/dialogs/ApprovalDialog.tsx`, create `src/renderer/components/dialogs/ApprovalDialog.test.tsx` (none exists today), locales.
- Steps:
  1. Add a pure `parseApprovalTitle(title)` in `ApprovalDialog.tsx` returning `{ toolName, reason?: string, path?: string, details: string }` from the format in Context (`reason` from the first line starting `Reason: `, `path` from the first line starting `Path: `, `details` = every line after the first).
  2. Add `diagnose`, `system_status` to `READ_TOOLS` and `office_report`, `office_slides`, `office_clean` to `WRITE_TOOLS` (their tier in the pack); leave `open_item`, `os_setting` on the default exec tier.
  3. Main sentence: `open_item`/`os_setting` → the request's `reason` (the pack writes it in the session language); `write` → the file-approval string with the full `path` after POSIX normalisation (`.` and `..` segments resolved); `office_report`, `office_slides`, `office_clean` → the generic string with that tool's action phrase from the Copy table; any other tool → the generic string with the tool name as the action. Keep the raw details in a collapsed `<details>` element whose body is the existing `<pre>`.
- Tests before (red): `parseApprovalTitle` on a `write` title, a title with `Reason:`, and a bare title; a `write` to `/home/u/Documents/Sai ATLAS/../../.config/autostart/x.desktop` shows `/home/u/.config/autostart/x.desktop`; then one rendered case per sentence branch (reason, `write`, each office tool, another tool), in en and in vi (switch the i18n store's language).
- Verify: `bunx vitest run src/renderer/components/dialogs/ApprovalDialog.test.tsx` exits non-zero first, then 0.

### Task 8.5 — Renderer leftovers (test first)
- Target files: `App.tsx`, `stores/settings.ts`, `components/settings/SettingsWindow.tsx`, `components/settings/settings-schema-utils.ts`, the schema settings pages, their tests, and the new `components/settings/pack-pinned-keys.test.ts`.
- Tests before (red): a settings-store test that `setApprovalMode` no longer exists (type-level: delete its callers, `bun run check:types` must pass) and that loading prefs never calls `rpc.setSetting("tools.approvalMode", …)`; a SettingsWindow test that the Launch Profile page renders none of the seven removed fields; a schema page test that no row renders for a key in `PACK_PINNED_SETTING_KEYS` (a constant listing the dotted keys of the pack's `config.yml`, Phase 4 Task 4.7: `temperature`, `shellPath`, `bash.patterns`, `bash.allowCompoundCommands`, `bash.direnv`, `fetch.enabled`, `extensions`, the ten `skills.*` keys of the block (the seven `skills.enable*` keys, `skills.customDirectories`, `skills.includeSkills`, `skills.ignoredSkills`), `commands.enableClaudeUser`, `commands.enableClaudeProject`, `commands.enableOpencodeUser`, `commands.enableOpencodeProject`, `plan.enabled`, `plan.defaultOnStartup`, `mcp.enableProjectConfig`, `task.disabledAgents`, `tools.approval`, plus `tools.approvalMode`; export it from `src/renderer/components/settings/settings-schema-utils.ts`); a new `src/renderer/components/settings/pack-pinned-keys.test.ts` with the case `covers every key the pack config pins`, which reads `assistant-pack/config.yml` with `node:fs` and `parse` from `yaml` (as `assistant-pack/test/pack-files.test.ts` does), flattens its mappings to dotted paths (arrays and scalars are leaves, so `bash.patterns` and `task.disabledAgents` are one path each), and asserts that every path equals an entry of `PACK_PINNED_SETTING_KEYS` or starts with an entry followed by `.` (so `tools.approval.write` is covered by `tools.approval`), so a hand-written list cannot fall behind `config.yml` again; in `stores/sidebar-prefs.test.ts`, rewrite the `pinnedGroups` and `workspaceLastUsed` cases (:26-31, :52-59) into `ignores the retired pinnedGroups and workspaceLastUsed fields of a stored blob` (hydrating a blob that carries them succeeds and the store exposes neither) and keep the `groupAliases` cases.
- Steps: delete the handlers listed in Context (leave the `MenuAction` union alone; Phase 9 trims it), the setter and migration, the seven profile fields (keep the `LaunchProfile` type fields so stored prefs parse), filter the schema rows, and drop the two sidebar-prefs fields with their writers (recency timestamps then come from `sessionLastUsed` alone).
- Verify: the new tests red first (`bunx vitest run src/renderer/components/settings/pack-pinned-keys.test.ts` exits non-zero before the constant exists), then `bunx vitest run src/renderer/components/settings/pack-pinned-keys.test.ts` exits 0 and lists `covers every key the pack config pins` as passed, and `bunx vitest run src/renderer` exits 0; `bun run check:types` exits 0; `rg -n 'setApprovalMode|"set-approval"' src/renderer` prints nothing; `rg -n 'pinnedGroups|workspaceLastUsed|toggleGroupPin|touchWorkspace' src/renderer --glob '!*.test.*'` prints nothing.

### Task 8.6 — Refuse cloud models (test first)
<!-- Updated: Validation Session 1 - refuse Ollama cloud tags so the privacy sentence holds -->
- Goal: no conversation is sent to Ollama's cloud; the privacy sentence stays true.
- Target files: `src/renderer/components/settings/ProvidersWindow.tsx` (`normalizePullTag` :28-33 and the "Use as default" action), its test file, locales.
- Behaviour: a tag is a cloud tag when its name or its `:tag` part ends with `-cloud` or equals `cloud` (for example `gpt-oss:120b-cloud`, `kimi-k2:cloud`). Pulling one is refused with the message below and nothing is sent to Ollama; "Use as default" is disabled for an installed cloud tag, with the same message as its tooltip.
- Copy: en `Cloud models send your conversations online. Sai ATLAS uses only models that run on this computer.`; vi `Mô hình đám mây gửi cuộc trò chuyện của bạn lên mạng. Sai ATLAS chỉ dùng mô hình chạy trên máy tính này.`
- Tests before (red): `normalizePullTag("gpt-oss:120b-cloud")`, `("kimi-k2:cloud")` and `("x-cloud")` return null; `("hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf")` and `("llama3:8b")` return the tag; the "Use as default" button is disabled for an installed `x:cloud` model.
- Verify: `bunx vitest run src/renderer/components/settings/ProvidersWindow` red first, then exits 0.

### Task 8.7 — Locales and helper wording
- Steps: add every key from the Copy table to `en.ts` and `vi.ts` (the `sidebar.kindMismatch` row changes an existing value); change the "subagent" values as described; remove the keys of the deleted `STARTERS`/`CHAT_STARTERS` entries if nothing references them anymore (`rg` each key).
- Verify: `bunx vitest run src/renderer/locales` exits 0; `rg -n -i ':\s*"[^"]*subagent' src/renderer/locales/en.ts` prints nothing (keys may still contain "subagent"; values may not).

### Task 8.8 — Gate and merge
- Verify: `bun run check:types` → 0; `bunx vitest run` → 0; `bunx biome check src/renderer` (touched files) → 0; `bun run build` → 0.
- Visual check: `scripts/virtual-display.sh run -- env CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup" CARGO_HOME_BIN="$HOME/.cargo/bin" HOME=$(mktemp -d) bun run dev:tauri -- --user-data-dir=$(mktemp -d)`, then `scripts/virtual-display.sh shot /tmp/p08-empty.png` and read it: four cards on Linux with the new title. Then `scripts/virtual-display.sh stop`.
- Commits: `feat(ui): starter cards for everyday jobs`, `feat(ui): attach any document`, `feat(ui): open finished files from their card`, `feat(ui): plain-language approvals`, `refactor(ui): drop settings that no longer take effect`, `feat(ui): refuse cloud models`.
- Merge: `git -C /home/tung491/WORK/worktrees/rebrand-integration merge --no-ff rebrand/p08-everyday-ux`.

## Risks and rollback

- A typed request (no card) may skip `read` and send placeholder content: with the office tools Phase 1 measured typed requests at 7/9 on E4B against 9/9 for the starter cards, so the cards are the reliable path.
- Rollback: `git reset --hard rebrand-wave-b` on the integration branch (undoes Wave C, Phases 7 and 8 together).

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
