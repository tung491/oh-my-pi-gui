---
phase: 2
title: "Renderer removals"
status: done
priority: P1
effort: "3d"
dependencies: [1]
---

# Phase 2: Renderer removals

## Goal

Delete code mode and every developer-only renderer surface (doc rows R1, R2, R3, R5 and R6 renderer halves, R7, R8, R9, R11, R14 entry points, plus ApprovalControl), leaving one task lane with one "New task" button.

## Outcome (2026-10-06)

Done and merged (`dfc3381`, commits `8f00eb9`..`5b79516`); the Wave A gate passed and the integration branch was tagged `rebrand-wave-a` (`da001bb`). Report: `plans/reports/fullstack-developer-261006-phase-02-renderer-removals.md`. Review: `plans/reports/code-reviewer-261006-wave-a.md`. Deviations from the tasks below, as shipped:

- `components/panels/hub-filter.ts` is kept although the R7 row lists it: `AgentHubWindow` (Keep list) imports it. No follow-up.
- `stores/fork-handoff.ts` and the whole of `components/dialogs/ForkHandoffDialogs.test.tsx` are deleted, though R3 did not list them: `HandoffDialog` was the store's only purpose, and every test case exercised the handoff dialog (there were no standalone fork cases). No follow-up.
- A worktree-bound tab now closes without the file prompt (`WorktreeCloseDialog` is gone) and its checkout stays on disk. This is user-visible; Phase 9 Task 9.5 adds the CHANGELOG line.
- `REMOVED_COMMANDS` lives in `src/renderer/lib/command-availability.ts` (commit `6b9a7fa`), shared by the palette, the composer and slash completion (completion now hides removed commands too). `plan.md` Decisions "Removed commands" points there.
- `PlanApprovalDialog` is deleted; `stores/plan-approval.ts` stays (Keep list, Task 2.9 Verify), so nothing renders a plan proposal. The hook `hooks/use-plan-approval.ts` lost its only caller and is deleted by the repair branch `rebrand/wave-a-fixes`, which also pins plan mode off in the pack and disarms a resumed plan-mode session at ready (`plan.md` "Wave A review fixes", review H2).
- The sidebar-prefs fields `pinnedGroups` and `workspaceLastUsed` are no longer read (`groupAliases` still is, by TabBar). Phase 8 Task 8.5 drops them.
- `QuickEntryTarget` keeps its `{ kind: "chat" }` member (`src/shared/ipc-types.ts:367`, outside this phase's ownership); the renderer maps a chat target to Work (`quick-entry/QuickEntryBar.tsx:51`, `lib/quick-entry-delivery.ts:31`). Phase 9 Task 9.0 drops the member.
- The `App.tsx` branches for `open-pr-center`, `open-branch-picker`, `open-session-tree`, `open-git`, `handoff`, `open-workspace-dirs` and `new-chat-tab` are removed; their `src/main/menu.ts` items do nothing until Phase 9 Task 9.0 trims the `MenuAction` union (already planned).
- Smaller changes, no follow-up: the `tab.newWorktree` hotkey and the TabBar worktree button went in Task 2.7 with their dialog; `panelTabFromPref` maps the retired `diff` tab through a `{ diff: "files" }` map; `CHAT_DEAD_COMMANDS` is trimmed to `task` and `tan`; loop-mode state is removed end to end (session store, RPC events, hydration).
- The review found that `REMOVED_COMMANDS` could be bypassed through omp's colon form (`/share:x`), the queue shorthand (`=> /share`) and aliases (`/plugin`), and that `hooks/use-git-status.ts` is dead. Both are repaired on `rebrand/wave-a-fixes` (review H1, L6).

## Context

- Plan index `./plan.md` — Decisions rows "ApprovalControl", "ExtensionDialog", "Chat kind", "Locale keys".
- Wave A: runs in parallel with Phase 3 and Phase 4. **Do not edit any file Phase 3 or Phase 4 owns.**
- Locale keys are NOT deleted here. Unused keys do not fail `locales.test.ts` (it checks en/vi parity, not usage). Phase 5 deletes them.
- The `SessionKind` type and the `"chat"` value stay (Phase 6 normalises spawns and refuses chat-stamped files). Only the ways to create a new chat tab go.
- omp advertises its own slash commands (`availableCommands`), and the palette adds every one the GUI has not claimed (`lib/command-registry.ts:1452-1475`); typed slash text the GUI does not handle goes to `rpc.prompt` (`lib/composer-submit.ts:124-134`). Deleting a GUI entry therefore brings back omp's version (`/share` uploads the session). Every name in the Commands delete list joins a `REMOVED_COMMANDS` set that is skipped in the merge loop and blocked in `planComposerSubmit`.
- Project sessions stay listed (user decision, `plan.md` Red Team Review): the merged lane shows every session from both old lanes, without project grouping.

## Ownership

- May modify or delete: everything under `src/renderer/` **except** `src/renderer/components/tools/**`, `src/renderer/locales/**` and `src/renderer/components/chat/ChatStream.tsx`.
- Must not touch: `src/main/**`, `src/shared/**`, `src-tauri/**`, `e2e/**`, `e2e-tauri/**`, `package.json`, `assistant-pack/**`, `scripts/**`.
- If a type error can only be fixed in a file outside this list, STOP (Failure Protocol).

## Keep list (never delete; verify each still exists at the end)

`components/dialogs/ExtensionDialog.tsx`, `components/dialogs/ExtensionEditorDialog.tsx`, `components/dialogs/ApprovalDialog.tsx`, `stores/extension-ui.ts`, `hooks/use-extension-ui.ts`, `stores/plan-approval.ts`, `components/settings/ProvidersWindow.tsx`, `components/onboarding/` (whole dir), `components/panels/FilesPanel.tsx`, `components/panels/LogPanel.tsx`, AgentHubWindow, JobsDialog, `components/chat/dock/AgentsDockCard*`, SubagentTranscript, SubagentDag, `lib/default-workspace*` if present, `components/settings/UpdatesSettingsPage.tsx`, `components/settings/pages/CapabilitiesHome.tsx`; the exports `keyboardPlatformOf` (`lib/keymap.ts`) and `effectiveShortcut` (`lib/shortcut-hint.ts`), imported by both deep-audit e2e specs (`e2e/deep-audit.e2e.ts:6-7`, `e2e-tauri/deep-audit.e2e.ts:11-12`), which Phase 2 does not own; and `toolsExpandAll` on `stores/ui.ts`, read by `components/tools/ToolCard.tsx:43` (Phase 3's).

## Delete lists

**Files (delete each file and its `*.test.ts(x)` siblings):**

| Row | Files under `src/renderer/` |
|---|---|
| R1 | `components/dialogs/WorkspaceDialog.tsx`, `components/dialogs/WorkspaceDirsDialog.tsx`, `lib/workspace-dirs.ts` |
| R2 | `lib/input-modes.ts`, `lib/loop-mode.ts`, `components/layout/ComposerModes.tsx`, `components/layout/mode-visibility.test.tsx`, `components/panels/ModesPanel.tsx`, `components/dialogs/PlanApprovalDialog.tsx`, `components/chat/dock/GoalDockBar.tsx`, `components/chat/dock/PlanDockCard.tsx` |
| R3 | `components/panels/DiffPanel.tsx`, `components/panels/DiffPanel.projection.test.ts`, `components/panels/RepositoryChanges.tsx`, `components/panels/PrCenterWindow.tsx`, `components/panels/pr/` (dir), `stores/pr-center.ts`, `components/dialogs/WorktreeDialog.tsx`, `components/dialogs/WorktreeCloseDialog.tsx`, `components/dialogs/BranchPickerDialog.tsx`, `components/dialogs/SessionTreeDialog.tsx`, `components/dialogs/session-tree-layout.ts`, `components/dialogs/SessionTreeNodeCard.tsx`, `components/dialogs/HandoffDialog.tsx` |
| R5 | `components/settings/ModelRolesWindow.tsx`, `components/settings/ModelCompare.tsx`, `components/settings/UsageWindow.tsx`, `components/dialogs/BenchmarkDialog.tsx` |
| R6 | `components/stats/` (dir), `stores/stats.ts`, `hooks/use-stats.ts` |
| R7 | `components/panels/ExtensionsPanel.tsx`, `components/panels/InventoryPanel.tsx`, `components/panels/inventory-utils.ts`, `components/panels/hub-filter.ts`, `components/panels/mcp/` (dir), `components/dialogs/ForceToolDialog.tsx`, `components/dialogs/ActiveToolsDialog.tsx`, `components/settings/SkillsSettingsPage.tsx`, `components/settings/SshSettingsPage.tsx`, `components/settings/SecuritySettingsPage.tsx` |
| R8 | `components/dialogs/DebugConsoleDialog.tsx`, `components/dialogs/ContextReportDialog.tsx`, `components/layout/ContextUsagePopover.tsx` |
| R9 | `components/dialogs/LiveVoiceDialog.tsx`, `components/dialogs/CollabDialog.tsx`, `components/dialogs/ShareSessionDialog.tsx`, `components/dialogs/ImportForeignDialog.tsx` |
| Approval | `components/layout/ApprovalControl.tsx`, `components/layout/ApprovalControl.test.tsx` |

`components/dialogs/ForkHandoffDialogs.test.tsx` covers both fork and handoff: delete only its handoff cases; keep the fork cases.

**Commands** (in `lib/command-registry.ts`, by `name:`): `new-chat-tab`, `import`, `handoff`, `share`, `branch`, `tree`, `model-roles`, `model-compare`, `benchmark`, `context`, `tools`, `computer`, `browser`, `force`, `usage`, `skills`, `hooks`, `commands`, `mcp`, `mcp panel`, `mcp list`, `marketplace`, `marketplace panel`, `marketplace list`, `marketplace installed`, `plugins`, `plugins panel`, `reload-plugins`, `memory`, `memory panel`, `security`, `templates`, `ssh`, `plan`, `vibe`, `goal`, `loop`, `modes`, `move`, `add-dir`, `remove-dir`, `dirs`, `git`, `stats`, `extensions`, `prs`, `collab`, `join`, `leave`, `debug`, `live`, `plan-review`, `guided-goal`. (`computer` and `browser` toggle tools that the Phase 6 allowlist excludes, so they would do nothing.)

**Hotkeys** (in `lib/keymap.ts`, by `id:`): `plan.toggle`, `pr.center`, `tab.newChat`, `tab.newWorktree`. Keep `agents.hub`.

**UI store open methods** (in `stores/ui.ts`): `openUsage`, `openModelRoles`, `openStatsDashboard`, `openModelCompare`, `openBenchmark`, `openExtensions`, `openInventory`, `openModes`, `openImportDialog`, `openContextReport`, `openActiveTools`, `openShareSession`, `openWorkspaceDirs`, `openForceTool`, `openCollab`, `openDebug`, `openLive`, `openWorktreeDialog`, `openWorktreeClosePrompt`, `openPrCenter`, `openBranchPicker`, `openSessionTree`, plus the state fields that only they set.

**Nav rail** (`components/layout/Sidebar.tsx`, nav items near lines 584–651): keep `commands`, `providers`, `settings`; delete `agents`, `pull-requests`, `stats`, `usage`, `capabilities`, `workspace`, `hotkeys`.

**Settings** (`components/settings/SettingsWindow.tsx` and `pages/CapabilitiesHome.tsx`): delete the tabs and capability targets `modelRoles`, `modelCompare`, `benchmark`, `usage`, `skills`, `mcp`, `resources`, `marketplaces`, `templates`, `memoryResources`, `hooks`, `commands`, `security`, `ssh`, `modes`, `vibe`, `collab`, `live`, `debug`, and the `SKILLS_TAB_ID`, `MCP_TAB_ID`, `RESOURCES_TAB_ID`, `HOOKS_TAB_ID`, `COMMANDS_TAB_ID`, `SECURITY_TAB_ID`, `SSH_TAB_ID` pages. Keep `model`, `providers`, `agents`, `updates`.

## Tests before (red first)

### Task 2.0 — Worktree
- Steps: `git -C /home/tung491/WORK/oh-my-pi-gui worktree add -b rebrand/p02-renderer-removals /home/tung491/WORK/worktrees/rebrand-p02 rebrand/everyday-work && cd /home/tung491/WORK/worktrees/rebrand-p02 && bun install`
- Verify: `git -C /home/tung491/WORK/worktrees/rebrand-p02 branch --show-current` prints `rebrand/p02-renderer-removals`.

### Task 2.1 — Write the inventory tests
- Goal: three tests that describe the end state and fail today.
- Target files:
  - Create `src/renderer/lib/command-registry-inventory.test.ts`: build the menu with `buildCommandMenu(ctx)` exactly as `lib/command-registry-actions.test.ts` builds its `ctx` (copy that setup), but pass `availableCommands` = one advertised entry (`{ name, description: "x", textModeExecutable: true }`) for every name in the Commands delete list; flatten item names, and assert that every name in the Commands delete list above is absent (GUI-owned and sidecar-advertised alike) and that `new`, `new-tab`, `settings`, `providers`, `agents`, `hub`, `jobs`, `model`, `theme`, `hotkeys`, `quit` are present.
  - Extend `src/renderer/lib/composer-submit.test.ts` (reuse its rpc fake): `planComposerSubmit("/share", …)` returns `{ kind: "blocked" }` and never calls `rpc.prompt`; the same for `/collab x` and `/mcp`.
  - Extend `src/renderer/lib/keymap.test.ts`: the four deleted hotkey ids are absent; `agents.hub`, `palette`, `settings`, `tab.new` are present.
  - Extend `src/renderer/components/layout/Sidebar.test.tsx`: the nav rail renders exactly the ids `commands`, `providers`, `settings`; no element has the text of the `sidebar.mode.code` key; exactly one button has the text of the `sidebar.newWork` key.
  - Create `src/renderer/stores/ui.test.ts`: restoring prefs with `defaultPanelTab: "diff"` yields `"files"`; `keymapOverrides` naming a deleted hotkey id is ignored without throwing.
- Verify (red): `bunx vitest run src/renderer/lib/command-registry-inventory.test.ts src/renderer/lib/composer-submit.test.ts src/renderer/lib/keymap.test.ts src/renderer/stores/ui.test.ts src/renderer/components/layout/Sidebar.test.tsx` exits **non-zero** with assertion failures in the new cases only. A pass here, or a failure in an old case, is a failure of this task.

## Refactor (delete, then fix imports)

Do one surface row per task, in this order, with one commit each (`refactor(renderer): remove <surface>`). For each task, the steps are:
1. Delete the files in that row.
2. `bun run check:types 2>&1 | grep -E '^src/' | head -50`, then fix each error by deleting the import and the JSX, store field, command entry, hotkey or method that used the deleted module. Never stub a deleted component.
3. Delete that row's commands, hotkeys, open methods, nav items and settings tabs from the lists above.

- Task 2.2 — R8 debug and inspection (smallest; it rehearses the loop). Edit points: `App.tsx`, `components/layout/InputArea.tsx` (ContextUsagePopover).
- Task 2.3 — R9 cloud features. Edit points: `App.tsx`; `lib/command-registry.ts` and `lib/composer-submit.ts` — add the exported `REMOVED_COMMANDS` set (every name in the Commands delete list; later tasks only add their command deletions to the menu, the set is complete from this task on), skip it in the `availableCommands` merge loop, and in `planComposerSubmit` return `{ kind: "blocked" }` with the existing blocked-command toast for a slash message whose first word is in the set.
- Task 2.4 — R5 and R6 renderer halves. Edit points: `App.tsx`, `lib/command-registry.ts`, `stores/ui.ts`, `components/settings/SettingsWindow.tsx`, `components/settings/pages/CapabilitiesHome.tsx`, `components/layout/Sidebar.tsx` (nav item `stats`, `usage`).
- Task 2.5 — R7 developer configuration (keep ExtensionDialog). Edit points: `App.tsx`, `SettingsWindow.tsx`, `CapabilitiesHome.tsx`, `lib/command-registry.ts`.
- Task 2.6 — R2 composer modes and ApprovalControl. Edit points: `components/layout/InputArea.tsx`, `components/layout/use-composer-submit.ts` (drop the `!`/`$` sigil parsing so text is sent as typed), `hooks/use-rpc-events.ts` (loop-mode import), `components/chat/dock/WorkspaceDock.tsx`, `App.tsx`. Keep `stores/plan-approval.ts` and `hooks/use-plan-approval.ts`.
- Task 2.7 — R3 git and review. Edit points: `components/layout/PanelContainer.tsx`, `components/panels/PanelsCrashRepro.test.tsx` (drop its DiffPanel case), `App.tsx` (the persisted-tab restore at :286-291 maps `"diff"` to `"files"`), `lib/command-registry.ts`, `lib/keymap.ts`, `stores/ui.ts` (remove `"diff"` from `PanelTab` at :10, default `panelTab` to `"files"` at :235). Keep the worktree fields of tab-layout types (they live in `src/shared`, not here). `App.tsx:701`: delete the `open-pr-center` branch; the `MenuAction` union and `src/main/menu.ts` stay until Phase 9 Task 9.0.
- Task 2.8 — R1, R11, R14 entry points: one lane.
  - `components/layout/Sidebar.tsx`: delete `SidebarMode` (line ~102), its state and the segmented control; delete the Code-lane project groups; render one list containing every session either lane showed — Work-lane sessions, `codeSessions` (cwd outside the default workspace, :272-274) and chat sessions — sorted by last activity, without project group headers or pinned groups (:210, :321-331); a pinned session stays pinned in the one list; keep one primary button labelled with key `sidebar.newWork` that runs the action the Work lane's new button ran; delete the `openTab({ kind: "chat" })` entry (~744).
  - `components/layout/TitleBar.tsx`: drop the WorkspaceDialog import and its trigger.
  - `components/layout/TabBar.tsx`, `quick-entry/QuickEntryBar.tsx`, `lib/quick-entry-delivery.ts`: remove every new-chat-tab entry point; a quick-entry submission opens an agent tab.
  - `lib/keymap.ts`: delete `tab.newChat`, `tab.newWorktree`.
  - `lib/command-registry.ts`: delete `new-chat-tab`, `move`, `add-dir`, `remove-dir`, `dirs` and the `workspace-dirs` import.
  - `App.tsx`: drop WorkspaceDirsDialog, and delete the `open-workspace-dirs` branch at :673 (the `MenuAction` union and `src/main/menu.ts` stay until Phase 9 Task 9.0).
  - Update `Sidebar.test.tsx`, `TabBar.test.tsx`, `QuickEntryBar.test.tsx` cases that created chat tabs; add `lists project sessions in the one lane` to `Sidebar.test.tsx`; never delete a test that covers kept behaviour.
- Command tests that only cover deleted commands go with them: the mcp, marketplace, plugins and memory cases in `lib/command-registry-submenus.test.ts` (:101-281) and the deleted-command cases in `lib/command-registry-availability.test.ts` (:22, :90-107, :126). Delete those cases in the task that deletes the command; keep every case about a kept command.
- Each task's Verify: `bun run check:types` exits 0 and `bunx vitest run src/renderer` exits 0, except the still-red inventory cases from Task 2.1 that later tasks fix.

## Tests after (green)

### Task 2.9 — Inventory green and absence checks
- Steps: run the three inventory tests, then the absence checks.
- Verify:
  - `bunx vitest run src/renderer/lib/command-registry-inventory.test.ts src/renderer/lib/composer-submit.test.ts src/renderer/lib/keymap.test.ts src/renderer/stores/ui.test.ts src/renderer/components/layout/Sidebar.test.tsx` exits 0.
  - `rg -n '"diff"' src/renderer/stores/ui.ts` prints nothing.
  - `rg -l "DiffPanel|PrCenterWindow|StatsDashboard|ModelRolesWindow|BenchmarkDialog|ExtensionsPanel|InventoryPanel|DebugConsoleDialog|LiveVoiceDialog|CollabDialog|ComposerModes|ApprovalControl|WorkspaceDialog|workspace-dirs|input-modes|loop-mode" src/renderer` prints nothing.
  - Every Keep-list file still exists: `ls src/renderer/components/dialogs/ExtensionDialog.tsx src/renderer/components/dialogs/ApprovalDialog.tsx src/renderer/stores/extension-ui.ts src/renderer/stores/plan-approval.ts src/renderer/components/settings/ProvidersWindow.tsx` exits 0.

## Regression gate

### Task 2.10 — Full gate and merge
- Steps:
  1. `bun run check:types` → 0; `bunx vitest run` → 0; `bunx biome check src/renderer` → 0 (fix only diagnostics in files you touched); `bun run build` → 0.
  2. `git -C /home/tung491/WORK/worktrees/rebrand-integration merge --no-ff rebrand/p02-renderer-removals` after Phase 3 and Phase 4 have merged or in any order; on a conflict, STOP. If this is the last of Phases 2, 3 and 4 to merge, run the Wave A gate (`plan.md` "Wave gate") on the integration worktree; only when it passes, `git -C /home/tung491/WORK/worktrees/rebrand-integration tag rebrand-wave-a`.
- Verify: every command in step 1 exits 0; the merge commit exists (`git -C /home/tung491/WORK/worktrees/rebrand-integration log --oneline -1` mentions `p02-renderer-removals`).

## Risks and rollback

- The Sidebar lane merge is the largest edit; the inventory test pins its shape. If a Work-lane action is unclear, STOP rather than guess.
- Rollback: before Phase 5 merges, `git -C /home/tung491/WORK/worktrees/rebrand-integration revert -m 1 <merge commit>`. After Phase 5 the deleted components' locale keys are gone, so roll back with `git reset --hard rebrand-base` (see `plan.md` "Rollback").

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
