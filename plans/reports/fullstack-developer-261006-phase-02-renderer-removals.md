# Phase 2 — Renderer removals: implementation report

- Phase: `phase-02-renderer-removals.md` (plan `plans/261005-0812-everyday-work-rebrand/`)
- Worktree: `/home/tung491/WORK/worktrees/rebrand-p02`, branch `rebrand/p02-renderer-removals` (from `rebrand/everyday-work`)
- Status: completed, apart from the merge and tag in Task 2.10 step 2, which the coordination rules hold back. Nothing was merged, tagged or pushed.

## Tasks

- [x] 2.0 Worktree created.
- [x] 2.1 Red inventory tests. Created `lib/command-registry-inventory.test.ts` and `stores/ui.test.ts`, and extended `composer-submit.test.ts`, `keymap.test.ts` and `Sidebar.test.tsx`. They were red on the new cases only.
- [x] 2.2 R8: debug and inspection.
- [x] 2.3 R9: cloud features. This task also added `REMOVED_COMMANDS`, the palette merge skip, and the composer's blocked-command handling.
- [x] 2.4 R5 and R6: the renderer halves.
- [x] 2.5 R7: developer configuration. `ExtensionDialog` is kept.
- [x] 2.6 R2: composer modes, `ApprovalControl`, and loop-mode state.
- [x] 2.7 R3: git, review, session tree and handoff.
- [x] 2.8 R1, R11 and R14 entry points: the sidebar now has one lane.
- [x] 2.9 The inventory tests are green and the absence checks pass.
- [x] 2.10 step 1: all gates pass. Step 2 (merge and tag) was not run, as instructed.

## Commits (oldest first)

| Hash | Message |
|---|---|
| 8f00eb9 | test(renderer): describe the single-lane everyday-work command set |
| 7da5844 | refactor(renderer): remove debug and inspection surfaces |
| 5d26768 | refactor(renderer): remove cloud sharing, collaboration and live voice |
| 17d2c38 | refactor(renderer): remove model roles, comparison, benchmarks, usage and stats |
| 93c717d | refactor(renderer): remove developer configuration surfaces |
| dcff2af | refactor(renderer): remove composer modes and the approval control |
| 1eacda5 | refactor(renderer): remove git, review and session tree surfaces |
| 6b9a7fa | fix(renderer): keep removed commands out of slash completion |
| bf0bebb | refactor(renderer): merge the sidebar into one task lane |
| 5b79516 | refactor(renderer): drop comments naming removed surfaces |

Total: 169 files changed, 3047 insertions and 28937 deletions. Every changed file is under `src/renderer/`. Nothing in `locales/**`, `components/tools/**` or `ChatStream.tsx` was touched.

## Gate outputs

- `bun run check:types`: exit 0.
- `bunx vitest run` (full suite): exit 0. 185 test files, 1671 tests passed.
- `bunx biome check src/renderer`: exit 0, 370 files, no diagnostics. The 60 touched renderer files are also clean.
- `bun run build`: exit 0. The bundle-lean checks passed for the main bundle, `index.html` and `quick-entry.html`.
- Task 2.9:
  - The five inventory test files pass: 85 tests, exit 0.
  - `rg -n '"diff"' src/renderer/stores/ui.ts` prints nothing.
  - The absence `rg -l` prints nothing.
  - The keep-list `ls` exits 0.

## Failure Protocol use

On its first run, the Task 2.9 absence grep matched one stale comment in `lib/command-registry.ts:299` that named `WorkspaceDialog`. I stopped and consulted kongming.

Kongming advised fixing that comment and also a second stale comment in `AgentHubWindow.tsx`. That comment named the deleted `PluginDetailDrawer`, which is not in the grep pattern. Both fixes went into a separate commit (5b79516), and I re-ran all four Task 2.9 Verify steps. All passed.

## Deviations and decisions

- **`components/panels/hub-filter.ts` is kept**, although the R7 row lists it. It is the Agent Hub status filter that `AgentHubWindow` imports, and `AgentHubWindow` is on the keep list.
- **`stores/fork-handoff.ts` was deleted**, although the R3 row does not list it. `HandoffDialog` was its only purpose.
- **`ForkHandoffDialogs.test.tsx` was deleted in full.** Every case in it exercised `HandoffDialog` or the handoff store, including the fork retry inside the handoff dialog. There were no standalone fork cases to keep.
- **The worktree close prompt was removed** together with `WorktreeCloseDialog`. A worktree-bound tab now closes like any other tab and leaves its checkout on disk. The tests that covered the prompt were rewritten to assert the new behaviour.
- **Two hotkeys went earlier than planned.** The `tab.newWorktree` hotkey and the TabBar worktree button were removed in Task 2.7 rather than 2.8, because the dialog they opened was deleted there.
- **`panelTabFromPref` uses a retired-tab map** (`{ diff: "files" }`), so `ui.ts` contains no `"diff"` literal. The diff option in the `defaultPanelTab` settings radio is gone.
- **`CHAT_DEAD_COMMANDS` was trimmed to `task` and `tan`.** Every other name in it was a deleted command.
- **The slash completion now hides removed commands.** I added this in a separate fix commit, 6b9a7fa. Without it, the composer completion still offered agent-advertised `/share` and `/mcp`, which the composer then refuses. To support this, `REMOVED_COMMANDS` moved into `lib/command-availability.ts`, which is shared by the palette, the composer and the completion.
- **Menu-action branches were removed** from `App.tsx` for `open-pr-center`, `open-branch-picker`, `open-session-tree`, `open-git`, `handoff`, `open-workspace-dirs` and `new-chat-tab`. The `MenuAction` union and `src/main/menu.ts` are unchanged, so those menu items do nothing until Phase 9 Task 9.0.
- **Quick entry:**
  - The Chat/Agent switch was removed.
  - A stored or restored chat target becomes the Work target.
  - `quickEntryTabArgs` maps a chat target to `{ kind: "agent", work: true }`.
  - `QuickEntryTarget` in `src/shared` still has `chat`; that file is not Phase 2's to change.
- **TitleBar:** the project button that opened `WorkspaceDialog` was removed, together with its chevron separator.
- **Sidebar:**
  - Removed: project groups, the group menu, group rename, pin and delete, the chats section, and the default-workspace lane detection.
  - Every session, chat sessions included, is in one list with pinned sessions first and the rest by last activity.
  - The nav items are `commands`, `providers` and `settings`.
- **Loop-mode state was removed end to end**, from the session store, RPC events and hydration, because nothing reads it any more.

## Concerns and hand-offs

- The `Session stats` steps in `e2e-tauri/packaged-smoke.e2e.ts:366` and `e2e-tauri/real-core.e2e.ts:166` refer to a removed surface. Phase 2 does not own `e2e-tauri/**`, and `plan.md` assigns e2e follow-ups to Phase 9. If the Wave A gate runs `test:e2e:tauri`, these specs will fail. The e2e specs may also use other removed selectors, such as the lane switch, quick chat and PR Center; I did not run them.
- The `plan-approval` store and its hook are kept, as the spec requires, but `PlanApprovalDialog` is deleted, so nothing renders a plan proposal now.
- Locale keys for every deleted surface remain in `en.ts` and `vi.ts`; Phase 5 removes them.
- The sidebar-prefs fields `pinnedGroups`, `groupAliases` and `workspaceLastUsed` remain in the store. The TabBar still reads `groupAliases`, and the sidebar no longer reads the others.

## Unresolved questions

- None blocking. The orchestrator should decide whether the Wave A gate includes the Tauri e2e specs, given the hand-off above.
