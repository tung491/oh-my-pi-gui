# Code review: Wave A of the everyday-work rebrand (Phases 2, 3, 4)

Date: 2026-10-06 (Asia/Seoul). Worktree `/home/tung491/WORK/worktrees/rebrand-integration`, diff `rebrand-base..rebrand-wave-a` (`7677ba1..da001bb`, 210 files, +5799 / -31277). Plan: `plans/261005-0812-everyday-work-rebrand/` (Decisions treated as binding). Review only, no code edited.

## Scope

- Phase 2, renderer removals: 169 files under `src/renderer/`.
- Phase 3, tool renderer removals: 12 files under `src/renderer/components/tools/`.
- Phase 4, assistant pack: `assistant-pack/**`, `scripts/build-assistant-pack*.ts`, `scripts/check-assistant-pack.ts`, `package.json`, `tsconfig.json`, `.gitignore`, `.github/workflows/ci.yml`.
- Context read: `plan.md`, phase-02/03/04, the three implementer reports, the kongming Wave A checkpoint, `AGENTS.md`. Every claim below about omp behaviour was checked in `/home/tung491/WORK/oh-my-pi/packages/coding-agent/src`.

## Gates I ran myself (integration worktree, sidecar linked, pack built)

| Gate | Result |
|---|---|
| `bun run check:types` | exit 0 |
| `bunx vitest run` | exit 0: 197 files passed, 1 skipped (`visual.test.ts`); 1846 tests passed, 5 skipped. The 4 compiled-sidecar cases ran and passed. |
| `git diff --name-only rebrand-base -- '*.ts' '*.tsx' \| xargs bunx biome check` | exit 0 (89 files) |
| `bunx biome check assistant-pack` | exit 0 (22 files) |
| `bun run build` | exit 0. The bundle-lean checks pass. |
| Absence greps of Tasks 2.9, 3.3 and 4.8 | All clean. The keep-list files exist. `resources/assistant-pack` holds exactly the eight files. |

There are no new type, lint or build errors.

## Overall assessment

Phases 3 and 4 match their acceptance criteria. Phase 4's core security properties hold in source:
- `wx` exclusive create, with retry on `EEXIST`.
- A first-segment `..` test on `realpathSync` results.
- argv-only execution from closed lists.
- Fixed plain-sentence errors.
- An isolated LibreOffice profile with a 60 s timeout.
- A `config.yml` that is key-for-key the plan block.

Phase 2 meets its listed checks. Two kept behaviours regressed in ways the tests do not cover:
- `REMOVED_COMMANDS` can be bypassed three ways.
- Deleting the plan dialog left plan mode enterable but impossible to answer or leave.

## Critical

None.

## High

### H1. `REMOVED_COMMANDS` is bypassable: omp's `/share`, `/collab`, `/plugins` and others still run (red-team finding 5 not fully closed)

The composer blocks a removed name only when the first whitespace-delimited token matches exactly (`src/renderer/lib/composer-submit.ts:107-111`). omp resolves slash commands differently, and a second dispatch path skips the check entirely.

1. **Colon form.** omp's `parseSlashCommand` ends the name at the first whitespace **or `:`** (`slash-commands/helpers/parse.ts:26-33`). The GUI's `/^\/(\S+)/` reads `/share:x` as `share:x`, which is not in the set, so it goes to `rpc.prompt`. omp then parses the name as `share` and runs `shareSession` (`slash-commands/builtin-collaboration.ts:263-280`), which uploads the session. The same works for `/collab:start`, `/mcp:…` and `/force:read`.
2. **Queue shorthand.** For `=> /share` or `-> /share`, `use-composer-submit.ts:129` takes the queue branch before `planComposerSubmit` is ever called (`:223`). Its only guard is `isGuiOnlyBuiltinCommand` (`:144`), and the first item is then sent with `rpc.prompt(item, …, "followUp")` (`:170`). omp's RPC `prompt` runs builtins whatever the `streamingBehavior` (`modes/rpc/rpc-mode.ts:1852-1882`).
3. **Aliases.** omp's builtin lookup includes aliases (`slash-commands/builtin-registry.ts:50-56`):
   - `/plugin` is an alias of the removed `plugins` and has an RPC `handle` that enables or disables marketplace plugins (`builtin-marketplace.ts:425-437`).
   - `/wt` and `/worktree` (`builtin-lifecycle.ts:740-760`) create a git worktree and move the session into it. That is an R3 git surface the GUI never claimed, so it was not in the delete list.

**Impact:** the privacy promise ("Files stay on this computer", system prompt line 13) can be broken with one typed line. Only the person can type it, not the model, so this is high and not critical.

**Fix:**
- Put one shared `removedCommandName(text)` in `command-availability.ts` that mirrors omp's parse rule: strip `/`, then cut at the first whitespace or `:`.
- Resolve aliases through the advertised `AvailableCommand.aliases` (map alias → canonical name).
- Call it from `planComposerSubmit` and from the queue branch, before line 144, for every `dispatchItems` entry.
- Add `plugin`, `wt` and `worktree` to the set. That is a scope addition for the planner to confirm.
- Add tests for `/share:x`, `=> /share`, `/plugin list` and `/wt`.

### H2. Plan mode can still start, but no UI answers or leaves it

- Phase 2 deleted `PlanApprovalDialog`. That was the only caller of `usePlanApproval()` (`git grep` at `rebrand-base`: `PlanApprovalDialog.tsx:82`), so `hooks/use-plan-approval.ts:16` is now never mounted and `plan_proposal` frames are dropped.
- Phase 2 also removed `/plan`, the `plan.toggle` hotkey and `ComposerModes`. Nothing can turn plan mode off.
- omp still turns plan mode on in two ways:
  - At RPC startup when `plan.defaultOnStartup` and `plan.enabled` are true (`modes/rpc/rpc-mode.ts:1710-1720`; `plan.enabled` defaults to `true`, `plan-mode/settings.ts:12-21`).
  - From a resumed session's journal (`planApprovalController.syncArmed()`, `:1707`).
- The generic settings schema pages still offer "Start in Plan Mode": nothing hides the `plan.*` keys (`settings-schema-utils.ts:25` keeps the `planModeEnabled` condition).
- The pack `config.yml` pins no `plan.*` key, so Phase 6 sessions inherit the user's setting.

**Result:** the agent submits a plan, omp quietly ends the turn and waits for `plan_approval`, and the GUI shows nothing. The task looks finished but stays in a read-only planning state with no way out. The title-bar "Plan" chip (`TitleBar.tsx:255-262`) is display-only.

**Fix (needs a planner or user decision, because the config key list is a binding Decision):**
- Pin `plan: { enabled: false, defaultOnStartup: false }` in `assistant-pack/config.yml` and its deep-equal test.
- For Wave A on its own (no pack yet), either keep a minimal reject path or document the dead end until Phase 6.
- Phase 6 Task 6.6 should also confirm that a journal-armed plan session is refused or disarmed.

## Medium

### M1. `open_item app` can launch the user's own `.desktop` file, not the system one

`buildOpenItemArgv` checks that `/usr/share/applications/<id>.desktop` exists, then runs `gtk-launch <id>` (`assistant-pack/src/tools/os-commands.ts:245-251`). `gtk-launch` resolves the desktop id through `XDG_DATA_HOME` first.

I verified this in a scratch directory: with `saiprobe.desktop` in both a fake `XDG_DATA_HOME` and a fake `XDG_DATA_DIRS`, `gtk-launch saiprobe` ran the `XDG_DATA_HOME` copy. A `~/.local/share/applications/mintupdate.desktop` written with the `write` tool would therefore run when "Open the app mintupdate" is approved, which defeats the plan's "never the user's own folder".

The incremental risk is moderate, because an approved `write` to `~/.config/autostart` already gives code execution. The guarantee as stated is still false.

**Fix:** launch with `["gio", "launch", "/usr/share/applications/<id>.desktop"]`. I verified that `gio launch <absolute path>` runs the system entry even when a user copy exists. Update the test at `os-commands.test.ts:184`, and add the `gio` argv to the Task 4.10 SAI OS check list.

### M2. The office tools run inside the sidecar with no size limits and no cancel

- `cleanWorkbook` loads the whole workbook into memory, then walks every row × column with synchronous `getCell` (`clean.ts:274-304`). CSV input goes through an uncapped `readFileSync` (`clean.ts:150`).
- `execute` ignores the `AbortSignal` (`office-tools.ts:269,302`; `types.ts:364`).
- These tools run inside the omp process. A large or sparse workbook (for example, one stray cell at `XFD1048576`) or a zip bomb can block the RPC loop or kill the sidecar with an out-of-memory error, taking the session down.

**Fix:** refuse inputs over a byte cap (for example 20 MB) and a cell cap (`rowCount * columnCount`) with a plain sentence; check `signal.aborted` between sheets.

### M3. The pack overlay does not pin every skill and command discovery key

`config.yml` pins the seven `skills.enable*` keys, as the plan says. omp also reads:
- `skills.customDirectories` and `skills.includeSkills` (`extensibility/settings.ts:65-81`);
- `commands.enableClaudeUser`, `commands.enableClaudeProject`, `commands.enableOpencodeUser` and `commands.enableOpencodeProject` (`:104-140`).

A user's or project's config can therefore add skills or prompt commands to pack sessions. `check-assistant-pack.ts` runs with a temporary `HOME`, so it cannot detect this. This is a plan-level gap (the Decision row lists the keys), so it needs a planner decision. Pinning `customDirectories: []` and the four `commands.*: false` keys would close it.

### M4. e2e specs still drive removed surfaces

The `Session stats` button is gone, but three specs still click it:
- `e2e/real-core.e2e.ts:139`
- `e2e-tauri/real-core.e2e.ts:166`
- `e2e-tauri/packaged-smoke.e2e.ts:366`

`packaged-smoke` is the Linux release gate (`scripts/tauri-deb-smoke.sh`). `plan.md` gives e2e follow-ups to Phase 9, and the Wave A gate does not run e2e, so nothing fails today. Phase 9 needs an explicit task for this.

## Low

- **L1. A failed write leaves a partial file.** `writeUnique` (`output.ts:79-90`) does not unlink the file when `writeSync` throws (for example, disk full), and it ignores the byte count `writeSync` returns. A truncated or empty file can stay behind and take the name.
- **L2. `truncateToBytes` is quadratic** (`output.ts:57-61`): it rebuilds the code-point array once per removed character. A very long `name` or `#` title can stall the sidecar. Compute the code points once and slice.
- **L3. The output folder is not symlink-checked.** `documentsDir` and `save` (`output.ts:44-55`, `office-tools.ts:234-245`) never resolve `Documents/Sai ATLAS`. If that folder is a symlink, files land at its target. The final file name itself is safe, because `wx` refuses a symlink with `EEXIST`. Check item (d) asked for realpath handling, which only `open_item` has.
- **L4. The `open_item` approval text can be arbitrary model text.** For `app`, and for a file that does not exist, the sentence repeats the unvalidated `value` (`os-commands.ts:305-315`). Execution is still constrained, but the dialog text is not. Validate with `buildOpenItemArgv` first and fall back to the generic sentence, as `osSettingSentence` does.
- **L5. LibreOffice might outlive its timeout (unverified).** The timeout kills only the `soffice` wrapper pid; the script `exec`s `oosplash`, which starts `soffice.bin`. On a timeout, `soffice.bin` may live on while `rmSync` deletes its profile (`clean.ts:119-141`, `:166-172`). My probe finished inside its 400 ms limit, so this is not confirmed. Consider `detached` plus a process-group kill.
- **L6. Dead code left by the deletions:**
  - `hooks/use-git-status.ts`: its only consumer, `PrCreateDialog`, is deleted.
  - `hooks/use-plan-approval.ts`: no caller (see H2).
  - `SUMMARIES` entries for the removed tools (`tools/index.tsx:173-179`): deliberate, kept for old transcripts.
  - Menu actions such as `src/main/menu.ts:268` are now no-ops, which is accepted until Phase 9.

  Unused locale keys are expected and not counted here.
- **L7. Worktree tabs close without cleanup.** A worktree-bound tab now closes with no cleanup prompt (`lib/tab-close.ts:33-37`), so old worktree checkouts are left on disk without notice. The implementer chose this; the plan does not mention it.
- **L8. The helpdesk support note can be overwritten.** The helpdesk skill writes a fixed `support-note.md` with `write`, which replaces an earlier note (`skills/sai-os-helpdesk/SKILL.md`, step 6). The system prompt says new files never replace anything. Use a dated name.
- **L9. The load check inherits config overrides.** `check-assistant-pack.ts:341-346` passes the caller's `PI_CONFIG_FILES`, `PI_CONFIG_DIR` and `PI_CODING_AGENT_DIR` to the sidecar, so a developer shell with any of them set skews the readback. Delete them as `BASH_ENV` and `ENV` are deleted.

## Mandatory checks

| Check | Verdict |
|---|---|
| (a) Phase acceptance | P2: all Task 2.9 checks pass. Deviations (hub-filter kept, fork-handoff store deleted, worktree prompt dropped) are justified in the report. P3: met; the `GENERIC_BY_DESIGN` addition is the right mechanism. P4: met; Task 4.10 is `NEEDS-INTEGRATION`, as allowed. |
| (b) Kept behaviour | `ExtensionDialog` is mounted (`App.tsx:617`), and `ExtensionDialog`, `ApprovalDialog`, `extension-ui` and `use-extension-ui` are untouched. `ProvidersWindow`, Agent Hub and `JobsDialog` are mounted. Kept tool renderers are covered by the inventory test. A persisted `"diff"` maps to `"files"` (`stores/ui.ts:12-20`, `App.tsx:233`). The plan-approval store is kept but is now dead (**H2**). `REMOVED_COMMANDS` covers the palette (`command-registry.ts:785`) and completion (`use-completion-menu.ts:59`); the composer is bypassable (**H1**). |
| (c) Public contracts | `src/shared/**`, `src/main/**` and `src-tauri/**` are untouched. The `SessionKind` `"chat"` value is kept. The `defaultPanelTab` key is still read. Keymap overrides that name deleted ids are sanitised. The persisted sidebar-prefs fields are kept. No breaking change. |
| (d) Pack security | `wx` only, no overwrite. `safeBaseName` strips separators and control characters. First-segment `..` check on real paths. argv-only closed lists. Errors never echo paths or content (the success `check` string lists column headers by design). Isolated LibreOffice profile with a 60 s timeout. `config.yml` deep-equals the plan block. Gaps: M1, M3, L3, L5. |
| (e) Lint, types, build | Clean (table above). |
| (f) Leftovers | L6. |

## Recommended actions (priority order)

1. **H1:** a shared, omp-compatible name parser plus alias resolution, applied to the queue path; add `plugin`, `wt` and `worktree` (planner to confirm).
2. **H2:** decide on pinning `plan.enabled: false`; until Phase 6, either keep a minimal plan reject path or accept the dead end explicitly.
3. **M1:** `gio launch <absolute system path>` instead of `gtk-launch <id>`.
4. **M2:** byte and cell caps plus an abort check in `office_clean`.
5. **M3:** planner decision on pinning `skills.customDirectories`, `skills.includeSkills` and `commands.enable*`.
6. **M4:** a Phase 9 task listing the three e2e specs.

## Metrics

- Types: `tsc` clean. The pack contains no `any` (grep). Unknown input is narrowed with `asRecord` and type guards.
- Tests: 1846 passing. The pack tests are behavioural: they reopen zips, check real files on disk and use fake `execFile` recorders, not phantom assertions. There is no test for H1's colon, queue or alias forms, nor for H2.
- Lint: 0 diagnostics on the changed files.

## Unresolved questions

- H2 and M3 change the binding `config.yml` key list: does the planner or user accept pinning `plan.*`, `skills.customDirectories`, `skills.includeSkills` and `commands.enable*`?
- Should `/wt` and `/worktree` (omp's git worktree move) join `REMOVED_COMMANDS`, given that R3 removed every git surface?
