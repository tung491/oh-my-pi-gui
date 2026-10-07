# Phase 5 locale sweep: implementation report

## Executed phase

- Phase: `phase-05-locale-sweep.md` (Tasks 5.0 to 5.5)
- Plan: `/home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/`
- Branch / worktree: `rebrand/p05-locale-sweep` at `/home/tung491/WORK/worktrees/rebrand-p05`, cut from `rebrand/everyday-work` at `0c47264`
- Status: completed. As instructed, the branch was not merged, tagged or pushed. The orchestrator owns the Task 5.5 merge step (`merge --no-ff` into `rebrand-integration`, tag `rebrand-p05`).

## Outcome

The sweep removed 1,468 of 2,916 keys from `en.ts` and `vi.ts`, leaving 1,448 keys in each file. The two files are still key-identical. The plan estimated about 800. The real number is higher because Phase 2 removed whole namespaces: stats, security, mcp, ssh, debug, prCenter, inventory, extensions, marketplace, plugin detail, plan panel and approval, collab, share, worktree and others. It also removed 162 `cmd.*` labels for commands that no longer exist.

## Commits

- `15aaa60` `refactor(i18n): remove keys of deleted developer surfaces`. It changes `src/renderer/locales/en.ts` (1,597 lines removed, 43 orphaned section comments included), `src/renderer/locales/vi.ts` (1,520 lines removed) and `src/renderer/locales/locales.test.ts` (12 lines removed).

These files were created but not committed, as the phase specifies:
- `plans/261005-0812-everyday-work-rebrand/tools/unused-locale-keys.ts`
- `plans/261005-0812-everyday-work-rebrand/tools/unused-locale-keys.json`. This file now holds the state after the sweep. The JSON from before the sweep was kept as a scratch copy only.

## Finder (Task 5.2 and 5.3)

`unused-locale-keys.ts` parses files with the TypeScript compiler API, resolved from the worktree's `node_modules`. It does not use regex scanning, so comments, regex literals and nested `${}` cannot cause false hits. It follows the phase's rules exactly:

- A key counts as used when it equals a string literal, or a template literal with no `${`, anywhere under `src/` outside `locales/`. Test files are included.
- Template literals with `${` contribute patterns:
  - their static head, when the head contains a `.`;
  - otherwise, when the head is empty, their static tail as a suffix pattern.

The script writes `unused`, `review`, `dynamicPrefixes`, `reviewDecisions` and, as an extra, `dynamicSites`, all sorted.

Decision rules, all built into the script:

- **`cmd.`**: this follows the phase's mechanical rule. The script reimplements `keyOf` and keeps a key only when `cmd.<keyOf(name)>` matches a `sub("…")` or `subAction("…")` in `command-registry.ts`. The `why` field is the matching registry line, or `no submenu item builds this key`.
- **Suffix patterns `*s`, `*m`, `*k`, `*ch`**: these templates format numbers with a unit or a CSS width (`subagent-graph.ts:81,83,84`, `chart.ts:152,164`, `format.ts:152`, `tray-labels.ts:79`, `diff.tsx:524-554`). No value they can take produces a locale key, so every key matched only by them is deleted.
- **Locale-key prefixes**: each one has a value set taken from a union, array or const in the source, and the source line is recorded as `why`.
- **Undecided keys**: a review key that no rule decides makes the script exit 1. A pattern added later cannot be skipped silently.

Before the sweep: 1,104 keys were unused and 483 were review. Of the review keys, 364 were decided delete and 119 keep, from 140 patterns.

## Keys removed per prefix (1,468)

Literal-unused keys (1,104): stats 96, tools 73, security 55, settings 53, mcp 52, modesPanel 48, sessionTree 41, ssh 37, debug 37, prCenter 35, invPanel 34, input 34, sidebar 30, extPanel 30, planPanel 28, diffPanel 27, modelCompare 26, planApproval 22, modelRoles 21, marketplace 21, pluginDetail 20, collab 20, shareDialog 19, benchmark 18, live 16, worktree 14, workspaceDirs 14, handoff 14, usage 13, contextReport 13, import 12, worktreeClose 10, forceTool 9, updates 8, marketplaceAction 8, activeTools 8, workspaces 7, contextUsage 7, titlebar 6, tabs 6, chat 6, branchPicker 6, updater 5, dock 5, common 5, providers 4, mcpAction 4, hotkeys 4, todoPanel 2, statsPop 2, quickEntry 2, pluginAction 2, computer 2, browser 2, and one each in unavailable, thinking, rpc, pluginActivation, panel, modelPicker, jobs, fork, filesPanel, approval and app.

Review keys decided delete (364):
- cmd: 162. No submenu item builds them.
- 190 keys that only unit or CSS suffix patterns matched: stats 30, invPanel 16, extPanel 16, tools 14, debug 9, and smaller counts in other namespaces.
- 12 keys whose prefix value set excludes them:
  - `settings.nav.configuration`, `.operations`, `.overview` and `.security`. `SettingsNavGroup.id` (`settings-window-model.ts:46`) has no such value.
  - `settings.tabs.commands`, `.hooks`, `.mcp`, `.resources`, `.runtime`, `.security`, `.skills` and `.ssh`. They are not GUI tab ids (`settings-window-model.ts:33-36`) and not agent tabs (the `owners` map at `:72`, which matches omp's `SETTING_TABS` in `packages/tui/src/overlays/settings-defs.ts:20`). `git grep` at `rebrand-base` shows that every one except `runtime` was a GUI tab id Phase 2 removed. An unknown tab still falls back to its schema label (`SettingsWindow.tsx:785`).

## Keys kept as dynamic (119), with reasons

| Prefix | Kept | Value source |
|---|---|---|
| `cmd.` | 10 | `sub`/`subAction` at `command-registry.ts:373,374,536,537,539,540,640,649,650,651` |
| `category.` | 10 | `CommandCategory`, `command-registry.ts:68`. All ten union members are kept, `modes` and `workspace` included, although no item uses them today. |
| `themePicker.theme.` | 20 | `THEMES`, `themes.ts:1659` (label and description for each theme) |
| `input.thinking.name.` / `.level.` | 14 | `ThinkingControl.tsx:36` (off, auto, plus `THINKING_LEVEL_VALUES`, `rpc-types.ts:1428`) |
| `settings.tabs.` | 13 | GUI tab ids and the agent tabs `owners` map (`settings-window-model.ts:33-36,72`) |
| `settings.display.` | 8 | `GUI_DISPLAY_BOOL_FIELDS`, `display-preferences.ts:6` |
| `settings.nav.` | 7 | `SettingsNavGroup.id`, `settings-window-model.ts:46` |
| `settings.source.` | 4 | `SettingProvenance.layers`, `rpc-types.ts:1634` |
| `jobs.status.` / `jobs.type.` | 4 + 3 | `RpcAsyncJobItem`, `rpc-types.ts:366-367` (`bash` and `task` are kept, because the wire type still allows them) |
| `tools.coordination.status.` | 4 | `JobStatus`, `CoordinationRenderer.tsx:19` |
| `tools.memory.operation.` | 4 | `MemoryRenderer.tsx:41,54` |
| `agentHub.source.` / `agentHub.defs.prewalk.` | 3 + 3 | `KNOWN_SOURCES` `:116` and `PrewalkState` `:94` in `AgentHubWindow.tsx` |
| `chat.compaction.reason.` | 3 | `session.ts:45` (`threshold` reads no key) |
| `welcome.tier.` / `.card.fit.` / `.card.speed.` | 3 + 3 + 3 | `ModelTier` / `ModelFit` / `ModelSpeed`, `ollama-types.ts:47,52,53` |

No key was kept because of uncertainty. Every dynamic key traced to a closed value set. I also scanned for keys built outside the finder's patterns, and found none:
- string concatenation around key fragments;
- templates whose head has no dot but prefixes a key;
- dots in the middle span of a template;
- `t(variable)` call sites, which all resolve to literal `labelKey` or map entries;
- tests that iterate `en` or `vi`.

## Verify results

| Task | Command | Result |
|---|---|---|
| 5.0 | `git log --first-parent --oneline -4` | `0c47264` wave-a-fixes merge, then the `da001bb` p04, `dfc3381` p02 and `978d0ec` p03 merges |
| 5.0 | `git merge-base --is-ancestor rebrand-wave-a-fixed HEAD` | exit 0 |
| 5.0 | `test -x resources/omp.linux-x64 && ls resources/assistant-pack/tools.js` | exit 0 |
| 5.1 | `bunx vitest run src/renderer/locales` (baseline) | exit 0, 7 passed |
| 5.2 | `bun …/tools/unused-locale-keys.ts` | exit 0, `unused` 1,104 (non-empty) |
| 5.3 | jq: `review` equals the sorted, unique keys of `reviewDecisions` | true (483 = 483, each once) |
| 5.4 | `bunx vitest run src/renderer/locales` | exit 0, 7 passed |
| 5.4 | `bun run check:types` | exit 0 |
| 5.5 | finder re-run | exit 0, `unused` 0 (review 119, all keep) |
| 5.5 | `bunx vitest run` | exit 0: 199 files passed and 1 skipped; 1,883 tests passed and 5 skipped (the same count as the Wave A fixes gate) |
| 5.5 | `bunx biome check src/renderer/locales` | exit 0 |
| 5.5 | `grep -cE '^\s+"[^"]+":' src/renderer/locales/en.ts` | 2,916 before, 1,448 after (`vi.ts` the same) |

No long-running processes were started. No vitest or sidecar processes were left behind.

## Test file change

These 12 entries were removed from `TRANSLATED_NAMESPACES` because no key in `en.ts` starts with them any more: `handoff.`, `planApproval.`, `invPanel.`, `extPanel.`, `branchPicker.`, `statsPop.`, `planPanel.`, `usage.`, `import.`, `mcp.`, `marketplace.`, `pluginDetail.`.

## Unresolved questions

1. Five allowlist entries in `locales.test.ts` now name deleted keys. They are `ALLOW_IDENTICAL`: `modelCompare.noRole`, `extPanel.tabs.mcp`, `stats.col.ttft`, `stats.overview.ttftSub`; and `AGENT_SCOPE_OMP`: `collab.joinDesc`. They are harmless lookups, but they are stale. Task 5.4 only names `TRANSLATED_NAMESPACES`, so I left them alone. Should they go in a follow-up commit on this branch?
2. The deletion count (1,468) is well above the plan's estimate of about 800. Phase 9's visual pass remains the backstop for any key used only through a computed string, which the finder cannot see. I found no such construct.
