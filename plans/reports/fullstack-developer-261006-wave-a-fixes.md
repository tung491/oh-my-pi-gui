# Wave A review fixes: implementation report

Date: 2026-10-06 (Asia/Seoul). Branch `rebrand/wave-a-fixes` cut from `rebrand-wave-a` (`da001bb`), worktree `/home/tung491/WORK/worktrees/rebrand-fixes-a`. Not merged, tagged or pushed. Inputs: `plans/reports/code-reviewer-261006-wave-a.md`, the "Wave A review fixes" section of `plans/reports/kongming-261006-phase-5-checkpoint.md`, and `plan.md` plus phases 02 and 04.

**Status: done.** Every finding in scope is fixed test-first. I saw each new test fail before the fix, then pass. All Wave gate commands exit 0. No locale, e2e or plan files were touched.

## Commits (`git log --oneline rebrand-wave-a..rebrand/wave-a-fixes`)

| Hash | Message | Findings |
|---|---|---|
| `bf0a794` | fix(renderer): block removed commands in every form the agent runs | H1 |
| `f19d74c` | fix(renderer): turn plan mode off when a session hydrates | H2 (renderer), L6 |
| `b4d96aa` | fix(pack): pin plan mode off and every skill and command discovery key | H2 (config), M3 |
| `b38135e` | fix(pack): give each helpdesk support note a new dated name | L8 |
| `9b60783` | fix(pack): keep the caller's omp config out of the pack load check | L9, M3 readback |
| `e3db05e` | fix(pack): open apps by their system entry and name only checked items | M1, L4 |
| `37f6b3a` | fix(pack): never leave a half-written office file, and cap names in one pass | L1, L2 |
| `bbaed22` | fix(pack): cap office tool inputs, stop on cancel, keep saves in Documents | M2, L3 |

## Per finding

### H1: removed-command bypass (`bf0a794`)
- **Fix:** `removedCommandName(message, commands)` in `src/renderer/lib/command-availability.ts` mirrors omp's `parseSlashCommand` (`slash-commands/helpers/parse.ts:26-33`).
  - It cuts the name at the first whitespace or `:` and lower-cases it.
  - It resolves aliases two ways: from the advertised `AvailableCommand.aliases`, and from a static table of the omp aliases that point at a removed command with an RPC `handle`. These are `plugin → plugins` (`builtin-marketplace.ts:426`) and `worktree → wt` (`builtin-lifecycle.ts:741`).
  - The terminal-only aliases `status → extensions` and `rewind → branch` are deliberately left out. omp cannot run them over RPC, and they are not advertised (`available-commands.ts:54,69-73`), so those names stay free.
  - `plugin`, `wt` and `worktree` were added to `REMOVED_COMMANDS`.
  - `planComposerSubmit` uses the resolver.
  - The queue branch of `use-composer-submit.ts` checks every `dispatchItems` entry before the GUI-only check. On a hit it restores the text and images and shows one `unavailable.tuiOnly` toast.
  - `/skill:<name>` is still sent.
- **Tests:**
  - `lib/command-availability.test.ts` (new): colon form, upper case, `/force:read`, plugin/worktree aliases before any commands are advertised, advertised aliases, and skill/kept/plain passthrough.
  - `lib/composer-submit.test.ts`: `/share:x`, `/plugin list`, `/wt`, `/worktree feature` (blocked, one toast), plus the `/skill:word-report` passthrough.
  - `components/layout/InputArea.queue-shorthand.test.tsx`: `=> /share` and `->` with `1. hello` / `2. /collab:start`. Nothing is sent, the draft is restored, one toast appears and history stays empty.
  - Palette (`lib/command-registry-inventory.test.ts`): the deleted list now includes plugin/wt/worktree, and a new alias case checks name and alias spellings.
  - Slash completion (`components/layout/use-completion-menu.test.ts`): no suggestion by name or alias.

### H2: plan mode enterable but not answerable (`f19d74c`, `b4d96aa`)
- **Fix, renderer:**
  - `hooks/session-hydration.ts` gains `disarmPlanMode`. When a `get_state` snapshot reports `planModeEnabled`, both hydrate paths send `{ type: "set_plan_mode", enabled: false }` through the session's own command channel. That is `runtime.command` for tabs, or `activeTabCommand` for the window-level session, which now maps `set_plan_mode` to the existing `rpc.setPlanMode`.
  - The store follows the reply. A failure is left for the next hydration to retry.
  - "Start in Plan Mode" (`plan.defaultOnStartup`) is no longer offered in the Settings window (`settings-schema-utils.ts`, `UNOFFERED_AGENT_SETTINGS`).
  - Deleted: `hooks/use-plan-approval.ts` and `hooks/use-git-status.ts` (L6). `stores/plan-approval.ts` is kept, as instructed (Phase 2 keep-list and Wave gate).
- **Fix, config:** `assistant-pack/config.yml` pins `plan.enabled: false` and `plan.defaultOnStartup: false`. The ids were checked in `plan-mode/settings.ts:12-35`.
- **Tests:**
  - `hooks/session-hydration.test.ts` (new):
    - `disarms a resumed plan-mode session at ready`: exactly one `set_plan_mode {enabled:false}`, and the tab store reads false.
    - `sends no plan command when the session is not in plan mode`.
    - `disarms plan mode on the window-level session too`: `rpc.setPlanMode(false)` is called once.
  - `SettingsWindow.test.tsx`: the start-in-plan row is hidden whatever `plan.enabled` is.
  - `pack-files.test.ts`: deep-equal.
  - `compiled.test.ts`: the `plan.*` rows read `false [overlay]`.

### M1: `open_item app` resolved the user's .desktop first (`e3db05e`)
- **Fix:**
  - The tool now runs `[gioPath, "launch", <realpath of /usr/share/applications/<id>.desktop>]`, with `gioPath` defaulting to `/usr/bin/gio` and added to `OsEnv`.
  - The entry must exist, and its realpath must lie inside the applications folder (first-segment check through `isInsideDir`). A link out of the folder is refused with "I could not find that app."
  - A missing `gio` fails with the existing "This is not available on this computer." before anything is spawned.
  - `rg -n 'gtk-launch' assistant-pack` prints nothing.
- **Tests (`os-commands.test.ts`):** the updated launch test (absolute-path argv), `refuses a system entry that is a link out of the system folder`, and `refuses the app when gio is not installed`.

### M2: no size caps and no cancel in the office tools (`bbaed22`)
- **Fix, `clean.ts`:**
  - A file over 20 MB is refused before it is loaded. The check covers CSV and the converted output of `.xls`/`.ods`.
  - Rows × columns over all selected sheets above 2,000,000 is refused before any cell is walked.
  - The stop checkpoints are: before loading, before each sheet, every 500 rows (each checkpoint yields one event-loop turn so a cancel can arrive), and before writing.
- **Fix, `office-tools.ts`:**
  - Markdown over 1 MiB gets "The text is too long for one file. Split it into smaller parts."
  - Every tool checks the `signal` before work and before saving. The stop sentence is "I stopped before the file was made." (`throwIfStopped` in `output.ts`).
- **Tests:**
  - `clean.test.ts`: `refuses a workbook over the byte cap` (xlsx and csv, sparse 20 MB + 1 file), `refuses a sheet with too many cells` (one cell at `XFD1048576`), and `stops between sheets when the signal is aborted` (one signal aborted before the call, one aborted during it).
  - `office-tools.test.ts`: `refuses oversized markdown with a plain sentence` and `stops without saving when the signal is aborted`.

### M3: unpinned discovery keys (`b4d96aa`, `9b60783`)
- **Fix:** `config.yml` pins:
  - `skills.customDirectories: []` and `skills.includeSkills: []`;
  - `commands.enableClaudeUser`, `enableClaudeProject`, `enableOpencodeUser` and `enableOpencodeProject`, all `false`.

  The ids come from `extensibility/settings.ts:65-81,104-140`. `includeSkills: []` means no filter (`skills.ts:350`).
- **Tests:**
  - `pack-files.test.ts` `EXPECTED_CONFIG`.
  - `compiled.test.ts` "loads the pack into the sidecar" now also requires the six discovery rows and the two plan rows from `overlay`, plus `PACK LOAD CHECK: PASS`.
  - `scripts/check-assistant-pack.ts` needed no expectation change, because it walks `config.yml`.

### Lows
- **L1 (`37f6b3a`):** `writeUnique` writes every byte in a loop (a write that makes no progress counts as a failure), and on any write error closes and unlinks the new file. Test: `removes the partial file when the write fails`, which was red against the old code.
- **L2 (`37f6b3a`):** `truncateToBytes` computes the code points once and slices. Test: `caps a very long name in one pass` (100,000 × "ệ" within 2 s), plus the existing cap case.
- **L3 (`bbaed22`):** `ensureOutputDir` creates Documents > Sai ATLAS and refuses it when its realpath is not inside the real Documents folder. A Documents folder that is itself a link is still fine. Test: `refuses an output folder that is a symlink out of Documents`.
- **L4 (`e3db05e`):** `openItemSentence(args, lang, context)` builds the sentence only from what `buildOpenItemArgv` accepted, and falls back to the generic sentence otherwise. Test: `the approval sentence never repeats an invalid value`, in en and vi. A valid app reads "Open the app <id>".
- **L6 (`f19d74c`):** the two dead hooks are deleted. Nothing imported them.
- **L8 (`b38135e`):** the helpdesk skill names `support-note-YYYY-MM-DD-HHMM.md` with today's date and time. Test: `sai-os-helpdesk writes each support note under a new dated name`.
- **L9 (`9b60783`):** the load check deletes `PI_CONFIG_FILES`, `PI_CONFIG_DIR` and `PI_CODING_AGENT_DIR` next to `BASH_ENV`/`ENV`. Test: `ignores the caller's own omp config location`. It runs the check with `PI_CODING_AGENT_DIR` pointing at a config with `skills.ignoredSkills: [word-report]`; before the fix that made the check FAIL, because a pack skill disappeared.
- **Skipped as instructed:** L5 and L7. M4 stays with Phase 9.

## Gate outputs (worktree `/home/tung491/WORK/worktrees/rebrand-fixes-a`)

| Command | Result |
|---|---|
| `bun install` | exit 0 |
| `ln -sf …/resources/omp.linux-x64 resources/omp.linux-x64` | exit 0 |
| `bun run build:pack` | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx vitest run` | exit 0: 199 files passed, 1 skipped; 1883 tests passed, 5 skipped |
| `bun run build` | exit 0 |
| `git diff --name-only rebrand-base -- '*.ts' '*.tsx' \| xargs bunx biome check` | exit 0 (92 files) |
| `bunx biome check assistant-pack` | exit 0 (22 files) |
| `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` | exit 0, `PACK LOAD CHECK: PASS`. Rows include `plan.enabled = false [overlay]`, `plan.defaultOnStartup = false [overlay]`, `skills.customDirectories = [] [overlay]`, `skills.includeSkills = [] [overlay]` and the four `commands.* = false [overlay]` |
| Task 2.9 greps (`"diff"` in `stores/ui.ts`; the removed-surface `rg -l`) | no output |
| Task 2.9 keep-list `ls` (`stores/plan-approval.ts` included) | exit 0 |
| Task 3.3 renderer `rg -l` | no output |
| Task 4.8 (`ls tools.js config.yml`, no `bin`/`agents`) | exit 0; the pack holds exactly the eight files |
| Repair extras: `bunx vitest run src/renderer/lib src/renderer/components/layout src/renderer/hooks assistant-pack` | exit 0: 71 files, 761 tests, the five compiled cases run (not skipped) |
| Repair extras: `rg -n 'gtk-launch' assistant-pack` | no output |

The full `vitest run` and `bun run build` ran before a comment-only fixup to `os-commands.ts`, which was folded into `e3db05e`. Every other row above was re-run after it.

No processes were left running. The empty `~/Documents/Sai ATLAS` predates this session (2026-10-05 20:46), and no file was written there.

## Deviations from the kongming spec

- **`stores/plan-approval.ts`, `settleTabPlanApproval` and the `clearProposal()` call are kept.** The orchestrator's brief overrides kongming here (Phase 2 keep-list and Wave gate). Only the hook was deleted. Phase 8 Task 8.5's line about the store therefore stays valid; its hook part is now done.
- **The cell cap is counted over all cleaned sheets, not per sheet.** Many sheets just under a per-sheet cap would otherwise still walk billions of cells. The per-sheet case is covered too.
- **The queue tests went into the existing `InputArea.queue-shorthand.test.tsx`** rather than a new `use-composer-submit.test.ts`. Kongming asked for a new file only "if none exists".

## Follow-ups for the planner (plan files not edited here)

- `plan.md` Decisions: add the "Removed commands" parser and alias note and the "Pinned settings" additions (H2, M3, renderer disarm), per kongming's "Plan edits that go with the repair branch".
- `phase-08-everyday-ux.md:105` `PACK_PINNED_SETTING_KEYS`: add `plan.enabled`, `plan.defaultOnStartup`, `skills.customDirectories`, `skills.includeSkills` and the four `commands.*`. Task 8.5: the plan-approval hook is gone, but the store remains.
- `phase-06-spawn-wiring.md` Task 6.6 Verify: add the two `plan.*` rows.
- `phase-09-copy-and-release.md` Task 9.0: add `libglib2.0-bin` to `deb.recommends`, with `DEB_RECOMMENDS` and the packaging test. `gio` comes from that package; the tool refuses plainly when it is missing.
- `plans/reports/spike-261005-everyday-work-rebrand.md` "SAI OS commands": the argv to confirm is now `/usr/bin/gio launch /usr/share/applications/<id>.desktop`.
- `phase-02-renderer-removals.md` Task 2.6 says to keep `hooks/use-plan-approval.ts`. That file is now deleted, per this brief.

## Unresolved questions

1. **`skills.ignoredSkills` is still unpinned.** The L9 probe showed that a user's or project's `ignoredSkills` hides pack skills from a pack session. It narrows what the assistant can do; it does not widen it. Should `skills.ignoredSkills: []` join the overlay? It is a binding Decision-list change, so I left it.
2. **The Settings window still shows the "Plan Mode" (`plan.enabled`) toggle.** Only "Start in Plan Mode" was hidden, as briefed. Turning the toggle on has no effect in practice (pack sessions pin it off, and hydration disarms plan mode), but it advertises a feature the app does not have. Should it be hidden too, or left for Phase 8's settings clean-up?
