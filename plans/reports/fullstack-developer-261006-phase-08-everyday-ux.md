# Phase 8 implementation report: everyday UX and SAI OS help

## Executed phase
- Phase: `phase-08-everyday-ux.md`
- Plan: `/home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/`
- Branch / worktree: `rebrand/p08-everyday-ux` at `/home/tung491/WORK/worktrees/rebrand-p08`, cut from `rebrand/everyday-work` at `rebrand-wave-b-fixed` (4492062)
- Status: Tasks 8.0–8.7 done, Task 8.8 gates and visual check pass. Not merged, tagged or pushed (orchestrator merges).
- Ownership: only `src/renderer/**` changed (32 files, +1486/−581). No file owned by Phase 7 touched. Failure Protocol was not triggered: no gate or Verify failed after it was believed complete, so kongming was not spawned.

## Commits (in order)
| Hash | Message |
|---|---|
| baff7a2 | feat(ui): starter cards for everyday jobs |
| d85a8f6 | feat(ui): attach any document |
| c86711b | feat(ui): open finished files from their card |
| 91b7c14 | feat(ui): plain-language approvals |
| 342b354 | refactor(ui): drop settings that no longer take effect |
| 70757c9 | feat(ui): refuse cloud models |
| 8c37f1d | feat(ui): plain wording for helpers and old conversations |

The six commit subjects from Task 8.8 are used as written; Task 8.7 got a seventh commit.

## Tasks

### 8.0 Worktree
Worktree created, `bun install`, both sidecar symlinks, and `bun run build:pack` all ran. Verify: `git -C …/rebrand-p08 branch --show-current` printed `rebrand/p08-everyday-ux`. PASS.

### 8.1 Starter cards (baff7a2)
- New `src/renderer/components/chat/starters.ts` holds the four entries (id, skill, `titleKey`, filters, `linuxOnly`), plus `startersFor(platform)` and `runStarter(starter, deps)`. `deps` is `{ showOpenDialog, send, t }`.
- `ChatStream.tsx`: the code and chat starter sets and the `isChat` branch are gone. The empty state shows the new title (`chat.empty.everyday.title`) and one card per `startersFor(window.omp?.platform)`.
- Send path: a card dispatches `omp:fill-composer` with `submit: true`. In that case `InputArea.tsx` calls the composer's own `send` through a ref; this is the same `useComposerSubmit` function the Send button uses.
- If the dialog returns several files, all of them are quoted and space-joined. A single file gives exactly `/skill:word-report '/home/u/notes.md'`.
- Red: `Cannot find module './starters'`, and 3 ChatStream assertions failed (4 cards on darwin, title undefined). Green: both files pass.
- Verify: `bunx vitest run …/starters.test.ts …/ChatStream.starters.test.tsx` failed first, then exited 0. PASS.

### 8.2 Attach any document (d85a8f6)
- New `src/renderer/components/layout/attach-document.ts` exports `ATTACH_FILTERS`, `splitAttachments`, `readImageAttachment` (`readImage` result → the `fileToImage` shape; rejects with the shell's error), `appendDocumentPaths` and `quotePromptPath`. `starters.ts` reuses `quotePromptPath`.
- `InputArea.tsx`: the hidden `<input type=file accept=image/*>` is replaced by `attachDocuments`. It opens `showOpenDialog(ATTACH_FILTERS)` with no options, appends the quoted document paths on their own lines, and adds the images. A tab or session that changed while the dialog was open is detected with the same check the paste path uses, and the result is then dropped. Each failed image read raises a toast. `fileToImage` is unchanged.
- Red: 5 failures (functions missing). Green: 5 passed.
- Verify: the test failed first, then exited 0; `bun run check:types` exited 0. PASS.

### 8.3 Output card (c86711b)
- New `OfficeFileRenderer.tsx` with `parseOfficeResult(text, kind)`. The card shows only if the result is not partial and not an error, and the trimmed JSON has exactly `check`, `file` and `kind`, all strings. `kind` must equal the tool's kind and `file` must end in `.<kind>`. `file` must be absolute, contain no `..` segment, and sit directly in a folder named `Sai ATLAS`.
- The card shows an icon for the kind, the base name, the `check` text (passed through `sanitizeToolText`), and Open / Show in folder buttons. Both buttons call `openPath`; a failure raises a toast reusing `tools.path.openFailed`. Any result that fails the checks renders `GenericRenderer` with the same props.
- `index.tsx`: `office_report`/`office_slides`/`office_clean` are registered through wrappers pinning `docx`/`pptx`/`xlsx`, and their header summaries are added. `registry-inventory.test.ts` now lists the three tools.
- Red: 9 failures. Green: 40 passed.
- The tests include every fallback case in the spec, plus three more: a `..` path that resolves back into the folder, a relative path, and a non-string `check`. Each fallback is compared byte for byte with the `GenericRenderer` markup.
- Verify: both files failed first, then exited 0. PASS.

### 8.4 Plain-language approvals (91b7c14)
- `ApprovalDialog.tsx` changes:
  - Adds `parseApprovalTitle` and `normalizePosixPath`.
  - `READ_TOOLS` gains `diagnose` and `system_status`; `WRITE_TOOLS` gains the three office tools.
  - The main sentence (`data-approval-sentence`) is chosen as follows:
    - `open_item`/`os_setting` show their reason.
    - `write` shows the file sentence with the normalised path.
    - The office tools show the generic sentence with their action phrase.
    - Any other tool shows the generic sentence with its name.
  - The tool name and tier badge stay below the sentence. The raw details sit in a collapsed `<details>` whose body is the existing `<pre>`, so the e2e `modal.locator("pre")` check and `Modal.test.tsx` still hold.
- `lib/i18n.tsx`: parameters are now substituted with a function replacer. Without this, a path containing `$&` or `$'` was mangled by `String.replace`, so the dialog would not show the real path. A test covers it.
- Red: 18 failures. Green: 18 passed (en and vi for every branch).
- Verify: the test file exited non-zero first, then 0. PASS.

### 8.5 Renderer leftovers (342b354)
- `App.tsx`: removed the `set-approval` handler and the `open-project` handler with its busy-guard entry. The `MenuAction` union is untouched.
- `stores/settings.ts`: removed `setApprovalMode` and the prefs migration. `syncApproval` now only reads `tools.approvalMode`, for the read-only labels.
- Launch Profile: the section is extracted to `components/settings/pages/LaunchProfileSection.tsx`, and only `--no-lsp` and the session directory remain.
  - The seven listed fields are removed, together with the add-dir picker and the verbatim-field handling.
  - The profile-name field is removed as well; see Deviations.
  - `LaunchProfile` type fields are kept.
  - `LAUNCH_TEXT_FIELDS` is now `["sessionDir"]`.
  - The locale keys of the 18 removed field strings are deleted from both files.
- `settings-schema-utils.ts`: exports `PACK_PINNED_SETTING_KEYS`, and `isSettingSupportedInGui` hides each listed key and any key below it. That one change covers schema tabs, Advanced, search and nav.
- `pack-pinned-keys.test.ts` reads `assistant-pack/config.yml` with `yaml`. It caught `autoResume`, which the spec list lacked; the key is in the constant.
- Sidebar prefs: `pinnedGroups`, `workspaceLastUsed`, `toggleGroupPin` and `touchWorkspace` are dropped. `touchSession(path)` no longer takes a cwd, and `use-sidebar-recency.ts` and `Sidebar.tsx` are updated. A stored blob that still carries the old fields hydrates, and the next write drops them.
- Tests:
  - `settings.test.ts`: no approval writer exists, and `syncApproval` sends only `get_settings` and never touches prefs.
  - `SettingsWindow.test.tsx`: no row renders for any pinned key or any key below one; prefix look-alikes (`temperatureScale`, `tools.approvalTimeout`) stay visible; the Launch Profile page shows none of the removed fields or flags.
  - `sidebar-prefs.test.ts`: rewritten as specified, including `ignores the retired pinnedGroups and workspaceLastUsed fields of a stored blob`.
- Red: pack-pinned-keys threw (`Cannot read properties of undefined (reading 'some')`); the settings store had 2 failures; SettingsWindow failed on the missing `LaunchProfileSection` module; sidebar-prefs had 1 failure.
- Verify:
  - `pack-pinned-keys.test.ts` exited 0 and listed `✓ … covers every key the pack config pins`.
  - `bunx vitest run src/renderer`: 136 files, 1241 tests passed.
  - `check:types` exited 0.
  - Both `rg` greps printed nothing.
  - PASS.

### 8.6 Refuse cloud models (70757c9)
- `ProvidersWindow.tsx`:
  - `isCloudTag` is checked on the name and on the `:tag` part after the last `/`. It is case-insensitive and matches `cloud` or `*-cloud`.
  - `normalizePullTag` returns null for cloud tags, so the Pull button stays disabled and submitting never calls `ollama.pull`.
  - When a cloud tag is typed, an inline `role="alert"` message appears.
  - "Use as default" is disabled for an installed cloud tag, with the same message as its tooltip.
- Red: 4 failures. Green: 28 passed. The tests cover the spec cases plus `cloudy:7b`, which stays local.
- Verify: `bunx vitest run src/renderer/components/settings/ProvidersWindow` failed first, then exited 0. PASS.

### 8.7 Locales and helper wording (8c37f1d)
- All Copy-table keys are in both files.
- `sidebar.kindMismatch` and `tabs.kindMismatch` both carry the new "start a new task" text.
- "subagent" values are changed to "helper(s)" in English and "trợ lý phụ" in Vietnamese. This covers `cmd.agents.desc`, `cmd.hub.desc`, `settings.capabilities.agents`, `jobs.emptyHint`, `subagent.empty`, `subagent.loadFailed`, `subagentPanel.viewAria`, `agentHub.hub.gapNote` and `agentHub.hub.kind.sub`. No keys were renamed.
- The old starter and empty-state keys (`chat.starter.{understand,fix,build,review,explain,draft,brainstorm,translate}.*`, `chat.empty.{title,subtitle}[.chat]`) were removed in baff7a2 after `rg` showed nothing referenced them.
- Three tests that asserted the old copy literally now assert the new copy. The checks themselves are unchanged: the CapabilitiesHome ordering check, and in AgentHubWindow the kind badge and the roster-failure text.
- Verify: `bunx vitest run src/renderer/locales` exited 0, and the `rg … subagent` grep on `en.ts` printed nothing. PASS.

### 8.8 Gates and visual check (no merge)
| Command | Result |
|---|---|
| `bun run check:types` | exit 0 |
| `bunx vitest run` | exit 0: 207 files passed, 1 skipped; 1998 tests passed, 5 skipped |
| `git diff --name-only rebrand-wave-b-fixed -- '*.ts' '*.tsx' \| xargs bunx biome check` (32 touched files) | exit 0, after formatting two long locale values (folded into 8c37f1d) |
| `bun run build` | exit 0 |

- Visual check: before starting, `virtual-display.sh status` showed the display not running and port 5183 was free.
- The app ran through `dev:tauri` with the cargo env, a throwaway `HOME` and a throwaway profile. I dismissed the first-run model screen with "Set up later", via `virtual-display.sh xdotool`.
- `/tmp/p08-empty.png` shows the title "What can I help you with today?" and four cards on Linux. PASS.
- Extra check, `/tmp/p08-helpdesk.png`: clicking "Help with my computer" sent `/skill:sai-os-helpdesk I need help with my computer.` through the composer. The skill card rendered, `system_status` ran, and E4B answered. This exercises the `submit` path end to end, which no unit test covers.
- Cleanup:
  - I stopped the app, its sidecar, vite and the private bus, all of which I started.
  - `status` then listed only my own display, so I ran `virtual-display.sh stop`.
  - I deleted the throwaway HOME and profile.
  - Port 5183 is free and the worktree is clean.

## New or changed vi strings (for agy's review)
- Copy table: `chat.empty.everyday.title`, `chat.starter.wordReport.title`, `chat.starter.spreadsheetCleanup.title`, `chat.starter.slidesFromReport.title`, `chat.starter.helpdesk.title`, `chat.starter.helpdesk.prompt`, `tools.office.open`, `tools.office.showInFolder`, `approval.sentence.generic`, `approval.sentence.write`, `approval.action.officeReport`, `approval.action.officeSlides`, `approval.action.officeClean`, `sidebar.kindMismatch`, `tabs.kindMismatch`, `ollama.settings.cloudRefused`.
- Mine (not in the Copy table): `input.attach` "Đính kèm tệp" (was "Đính kèm hình ảnh"), `input.attach.failed` "Không thể đính kèm tệp", `approval.details` "Chi tiết".
- Helper wording: `cmd.agents.desc`, `cmd.hub.desc`, `settings.capabilities.agents`, `jobs.emptyHint`, `subagent.empty`, `subagent.loadFailed`, `subagentPanel.viewAria`, `agentHub.hub.gapNote`, `agentHub.hub.kind.sub`.

## Deviations
- **Profile name removed with the seven fields.** The spec's list of seven fields omits the profile name, but Phase 6 denylists `--profile` and states "Phase 8 removes their UI". `profileToFlags` never emits it either, so the field did nothing. The type field stays.
- **`autoResume` added to `PACK_PINNED_SETTING_KEYS`.** The pack now pins it, and the required config test fails without it.
- **New keys for the starter cards.** The starter labels use new keys rather than reusing the old `chat.starter.*` names. The empty-state subtitle is dropped, because the Copy table has none and the old one promised code editing.
- **Translation fix in `lib/i18n.tsx`.** The `$&` substitution fix is a small change outside the listed target files, but it is still under `src/renderer`.

## Unresolved questions
1. Office output cards are collapsed by default. In compact transcript mode they also fold into the "N steps" row, so Open and Show in folder are one or two clicks away. Should office tool cards open expanded or be lifted out of the fold? That is beyond this phase's renderer-only spec.
2. Cloud models are refused only in the Ollama window. A cloud model the user pulled with the CLI still appears in the model picker (`ModelPicker.tsx`) and could be chosen there. Should the picker hide or refuse cloud tags too?
3. Phase 9 should update these e2e and copy follow-ups:
   - the composer placeholder still says "Ask Sai ATLAS to build, explain, or fix something…";
   - e2e specs may assert the old empty-state title, the "Attach image" label, or the paperclip's file input (now a native dialog);
   - the approval `<pre>` is now inside a collapsed `<details>`; Playwright's `toContainText` reads it, but a visibility assertion would not.

## Follow-ups (coordinator, after the first report)

Both follow-ups were done test-first and touch only renderer files. Nothing is merged, tagged or pushed. No process was started for them.

### 1. Cloud models refused wherever a model is chosen (fab1fe1)
- **Shared rule.** `src/renderer/lib/ollama-cloud.ts` now holds the only `isCloudTag`, with the same rule as before. It has its own test (`ollama-cloud.test.ts`). `ProvidersWindow.tsx` (pull and "Use as default") imports it instead of keeping a local copy.
- **`ModelPicker.tsx`.** A cloud row renders disabled, with `aria-disabled`, the refusal text as its tooltip, and the refusal shown inline. `select()` returns before `set_model` for a cloud tag, so neither a click nor Enter sends anything.
- **`lib/command-registry.ts`, `cycleAllowedModel`.** This is the Ctrl+P / palette "Cycle model" path. It now cycles over local models only.
- **`FirstRunOnboardingDialog.tsx`.** The welcome screen also sets the session and default model. It no longer offers a cloud choice, and `defaultPick` never picks one.
- **Red:**
  - The `ollama-cloud` module was missing.
  - The cycle test stepped onto the cloud model.
  - `defaultPick` returned `kimi-k2:cloud`.
  - The cloud row in the model picker was not disabled.
- **Green:** 77 tests across the five files pass. A local model next to a cloud one still switches through `set_model`.
- **Typed command:** a typed `/model <cloud tag>` is covered by follow-up 3 below.

### 2. Office output cards start expanded and are never folded (e43e064)
- **Shared list.** New `components/tools/office-tools.ts` holds the tool-to-kind map and `isOfficeTool`. The renderer registry and `OfficeFileRenderer` now use it.
- **`ToolCard.tsx`.** An office tool's card starts expanded, and collapse-all (Ctrl+O) leaves it open. Other tools keep their default and Ctrl+O behaviour.
- **Finalized history in compact mode (`buildHistoryRows`).**
  - The office tool calls of a message become their own message row.
  - The rest of that message (narration, other tool calls) joins the steps group, which is closed off before the office row.
  - Steps that follow start a new group.
  - Full detail is unchanged.
- **Live turn in compact mode (`StreamingRows`).** Office cards render below the live steps group and are not counted in it. Full detail is unchanged.
- **Tests** (`components/chat/office-cards.test.tsx`), in both modes:
  - Compact history order and contents are process (`read`, `glob`, the narration), then the office call alone, then the answer.
  - Full history is unchanged.
  - A run with no office call still folds into one group.
  - Each office tool starts expanded, and the finished card shows Open with no click.
  - `read` stays collapsed.
  - In the compact live turn, the office card sits outside the collapsed group, which reports "1 step".
  - In the full live turn, both cards stay in place.
- **Red:** 6 failures (all of the behaviour cases). One expectation in my own new test assumed a full-mode `read` card. A collapsible `read` renders as a read group, so I used `glob` instead; no existing test changed.
- **Green:** all 10 pass, and 199 pass across `components/chat` and `components/tools`.

### 3. A typed `/model <cloud tag>` is refused (d1089d5)
- **The check.** `lib/command-availability.ts` has one parser that mirrors the agent's `parseSlashCommand`: the name ends at the first whitespace or `:`, and the arguments are trimmed. It resolves both advertised aliases and the agent's builtin aliases, now including `models` → `model`, which I confirmed in the agent's `builtin-modes.ts`.
  - `removedCommandName` uses this parser, with its behaviour unchanged.
  - The new `cloudModelCommand` returns true when the command resolves to `model` and its argument passes the shared `isCloudTag`.
- **Where it applies.** `lib/composer-submit.ts` (plain send) and `components/layout/use-composer-submit.ts` (the `->`/`=>` queue) refuse such a message right after the removed-command check. The draft is kept, nothing is sent, and the warning toast shows `ollama.settings.cloudRefused`.
- **Slash completion** lists only command names, never model arguments, so it needed no change.
- **Red:** 15 failures. Twelve were in `cloudModelCommand` (the function did not exist yet), two were composer refusals (`/model kimi-k2:cloud`, `/models x-cloud`), and one was the queue refusal (`=> /model x-cloud`).
- **Green:** 82 tests pass across the three files. `/model llama3:8b` and a bare `/model` still reach `prompt` with no toast; those two cases passed before and after the change.

### Task 8.8 gates, re-run on d1089d5
| Command | Result |
|---|---|
| `bun run check:types` | exit 0 |
| `bunx vitest run` | exit 0: 209 files passed, 1 skipped; 2031 tests passed, 5 skipped |
| biome on the 50 changed .ts/.tsx files since `rebrand-wave-b-fixed` | exit 0 (one new test file was formatted with `biome format --write` before the commit) |
| `bun run build` | exit 0 |

### Task 8.8 gates, earlier re-run on e43e064
| Command | Result |
|---|---|
| `bun run check:types` | exit 0 |
| `bunx vitest run` | exit 0: 209 files passed, 1 skipped; 2014 tests passed, 5 skipped |
| `git diff --name-only rebrand-wave-b-fixed -- '*.ts' '*.tsx' \| xargs bunx biome check` (44 files) | exit 0 |
| `bun run build` | exit 0 |

The branch now has 10 commits: the 7 above plus fab1fe1, e43e064 and d1089d5. Unresolved questions 1 and 2 are answered by these commits, and so is the typed `/model` case. Question 3 (composer placeholder, e2e title and label, collapsed approval details) goes to Phase 9.

Status: DONE
Summary: Phase 8 and all three coordinator follow-ups are done on `rebrand/p08-everyday-ux` (10 commits, latest d1089d5). Every Task 8.8 gate passes; nothing is merged, tagged or pushed.
Concerns/Blockers: None. The composer placeholder, the e2e title and label checks, and the collapsed approval details stay with Phase 9.
