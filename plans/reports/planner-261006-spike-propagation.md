# Planner report: spike propagation into the everyday-work rebrand plan

Date: 2026-10-06. Plan: `plans/261005-0812-everyday-work-rebrand/`. `ak plan validate` exits 0.

## Result

Phases 2–9 and `plan.md` now describe the route that passed the gate: typed office tools (`office_report`, `office_slides`, `office_clean`), no bash tool, no launcher, no drafts folder, no helpers. Wave A (Phases 2, 3, 4) can start. No `src/`, `src-tauri/` or spike-worktree file was touched, and no status field was edited.

## What changed

| File | Change |
|---|---|
| `plan.md` | Outcome bullets 3 and 4; Decisions row renamed "Pinned settings and approval rules" with the new key set; "CoordinationRenderer", "Env bypass" and "Helpers" rows aligned; open questions updated; new Validation Log section "Spike propagation — 2026-10-06" with per-phase changes, choices and the sweep |
| `phase-01-spike.md` | Outcome section only (GO, the three variants' scores); tasks kept as the v1 record |
| `phase-03-…` | Context names the new session tools; the inventory test also requires a `glob` renderer |
| `phase-04-…` | Rewritten around the office tools. Tasks 4.1–4.5: output helpers (with the Documents fallback, first-segment `..` containment and `safeBaseName`), the three builders taking strings or paths, and the office tools with tests (replacing the CLI task), all test-first. Task 4.6 registers seven tools, each with `loadMode: "essential"`. Task 4.7 covers skills, the helpdesk skill, the `skill://` system prompt and the new `config.yml`. Task 4.8 builds eight files. Task 4.9 runs `tools.js` through the compiled sidecar |
| `phase-06-…` | New `<TOOLS>` for both platforms; the env sets only `SAI_ATLAS_LANG` and removes `BASH_ENV`/`ENV`; five denylist keys; an eight-path `ASSISTANT_PACK_FILES`; Task 6.6 reads tools, skills and settings with value plus provenance; Task 6.7 checks the exact argv and env; security notes rewritten; the chat refusal is kept |
| `phase-07-…` | Reason for deleting the `bash.patterns` e2e cases |
| `phase-08-…` | The helpdesk starter sends `/skill:sai-os-helpdesk …`. The output card reads the `office_*` result JSON. Approvals drop the draft branch and gain office action phrases (en/vi). `PACK_PINNED_SETTING_KEYS` updated; the risk note uses the measured numbers |
| `phase-09-…` | Task 9.7 step 2 proves that no shell runs, from the session file |

## Choices made where the decisions allowed one

- `config.yml`: `task.maxConcurrency` and `tools.approval.task` are dropped and `task.disabledAgents` is kept. `shellPath` and `bash.*` are kept but inert, with `bash.patterns` reduced to deny-all (the `office *` allow named a launcher that no longer ships) and `direnv: "off"` quoted. Phase 4 Task 4.7's deep-equal test and Phase 8's pinned-key list match this block.
- Spawn env: `PATH`, `SAI_ATLAS_OMP`, `SAI_ATLAS_PACK` and `PI_BASH_NO_LOGIN` are no longer set, and `PI_BASH_NO_LOGIN` leaves the denylist. `SAI_ATLAS_LANG` stays. `BASH_ENV` and `ENV` are still removed, because the OS tools start system scripts.
- Office tools keep the spike's static `approval: "write"`. Phase 8 phrases their approval with the generic sentence and a per-tool action, and adds them to `WRITE_TOOLS` for the tier badge.

## Acceptance checks

- No phase file instructs building a launcher, a drafts folder or an agent file, or passing `find`, `task` or `bash` in `--tools`. Phase 1 still describes them, as the record of the v1 run under its new Outcome section.
- The Phase 4 output layout and Task 4.8 file list match the eight paths in Phase 6 "Pack file list".
- Every `### Task` section in phases 1–9 has a Verify, and every phase has exactly one `## Failure Protocol`.
- `ak plan validate plans/261005-0812-everyday-work-rebrand` exits 0.

## Sweep

I grepped phases 2–9 and `plan.md` for `bin/office`, `office/office.js`, `launcher`, `bash`, `find,`, `,find`, `helpdesk.md`, `agents/`, `task,`, `,wait`, `drafts`, `PI_BASH_NO_LOGIN` and `direnv: false`. Every remaining hit falls into one of these intentional groups:

- **Absence statements:** "no shell launcher", "no bash tool", "no `agents/` directory", "`PI_BASH_NO_LOGIN` is not set".
- **Inert overlay keys:** the inert `bash.*` keys (the config block, its tests, `PACK_PINNED_SETTING_KEYS`) and the `task.disabledAgents` list.
- **Historical records:** the Office route row's "was" clause, the Helpers row's account of the deleted agent file, the Red Team table and its sweep, and Validation Session 1 (its draft-write resolution).
- **Shell invocations, not the tool:** `bash scripts/…` and `bash -c` command lines.

`,find`, `,wait`, `office/office.js` and `direnv: false` have zero hits outside Phase 1.

## Open questions

1. `TaskRenderer`, `WaitRenderer`, `CoordinationRenderer`, `BashRenderer` and `FindRenderer` are now inert in pack sessions, and so are the agent hub, jobs and subagent views that Phase 2 keeps. Should a later phase remove them, or should they stay for old transcripts? The plan records this in `plan.md` "Open questions"; no phase removes them.
2. Phase 8 still renames "subagents" to "Helpers" in user-visible copy for those surfaces. If they are removed, that copy work goes too.
3. The overlay that ships differs from the measured `pack-v2b/config.yml` in three dropped entries. The first full readback is Phase 6 Task 6.6, after Wave A. If you want that check earlier, Phase 4 would need a provenance readback of its own.

## Checkpoint edits (2026-10-06)

Applied from `plans/reports/kongming-261006-wave-a-checkpoint.md` (GO for Wave A after edits). No user decision changed. `ak plan validate` exits 0 afterwards.

- **M1 (Phase 4 Task 4.0):** `tsconfig.json` `include` gets only `assistant-pack/**/*.ts`. Scripts stay out of `check:types`, because the root config has `types: ["node"]` and the scripts use `Bun`.
- **M2 (Phase 4 Task 4.0):** `bun add -d` also installs `yaml@2.9.1` and `jszip@3.10.2`; the Verify checks six versions.
- **M3 (Phase 4 Task 4.9):** the existing CI `linux` vitest step gets `SKIP_COMPILED: "1"`, and the Verify requires at least 2 `SKIP_COMPILED` hits in `ci.yml`.
- **M4 (Phase 5 Task 5.0):** the worktree links the sidecar and runs `bun run build:pack`, and the Verify checks both.
- **M5 (`plan.md` "Wave gate"):** an integration gate runs on `rebrand-integration` before `rebrand-wave-a` is tagged. It covers install, sidecar link, pack build, types, vitest, build, biome on changed files, the pack load check, and the absence greps of Tasks 2.9, 3.3 and 4.8. Tasks 2.10, 3.4 and 4.11 point to it instead of tagging directly.
- **Q2 (load check in Phase 4):** Phase 4 now creates `scripts/check-assistant-pack.ts`, ported from the spike's `loadcheck.ts` and `rpc.ts`. It runs six checks: tools, skills, system prompt, agents, settings value plus provenance, and startup frames.
  - Task 4.9 runs it, including the negative `find` case. Task 4.9 also lists `visual.test.ts` among its target files.
  - In Phase 6 the script moves to "May modify". Task 6.6 now rewires the script to `assistantPackFlags` and `assistantPackEnv` and makes the pack dir optional.
  - A new twin test, `ships the tool list the pack check expects`, reads the script as text, because importing it would pull `Bun` into `check:types`.
- **Should-fix:**
  - **Phase 2 Keep list:** adds `keyboardPlatformOf` (`lib/keymap.ts`), `effectiveShortcut` (`lib/shortcut-hint.ts`) and `toolsExpandAll` (`stores/ui.ts`).
  - **Phase 2 menu branches:** Task 2.7 deletes the `App.tsx:701` `open-pr-center` branch and Task 2.8 the `:673` `open-workspace-dirs` branch; the `MenuAction` union stays until Phase 9.
  - **Phase 4 Task 4.0 step 5:** records that the coordinator sent the SAI OS command list to the user on 2026-10-06. Task 4.10 now records the answer, or a `NEEDS-INTEGRATION` row if none has arrived by Task 4.11, instead of blocking.
  - **Phase 6 wording:** `soffice` is attributed to `office_clean`, not to the OS tools.
- **Resolved concern:** open question 3 above (overlay drift found only in Phase 6) is closed by Q2: Phase 4 now loads the built pack and reads every key back.

## Phase 5 checkpoint edits (2026-10-06)

Applied from `plans/reports/kongming-261006-phase-5-checkpoint.md` (including its "Wave A review fixes" section) and `plans/reports/code-reviewer-261006-wave-a.md`. No user decision changed: the new pinned keys fulfil the existing "pin every approval-relevant key" decision, and `plugin`/`wt`/`worktree` fall under R3. No code was edited. `ak plan validate plans/261005-0812-everyday-work-rebrand` exits 0 afterwards.

- **Phase 5:**
  - P5-1: Task 5.2 behaviours 3 and 4 use the report's text. A key is used only when it equals a whole literal. Dynamic patterns are the template head when it contains a `.` (so `tabs.menu.split` counts), or the tail as a suffix pattern when the head is empty.
  - P5-2: Task 5.3's `cmd.` rule applies `keyOf` to the first argument of every `sub(...)`/`subAction(...)` call (`command-registry.ts:155-156`, `:267`, `:275`, re-checked).
  - Task 5.0 Verify uses `log --first-parent -4` and requires `rebrand-wave-a-fixed` to be an ancestor. The old `log -5` check would have listed repair commits instead of the phase merges. Context says Phase 5 runs after the repair merge.
- **Phases 2, 3 and 4:** each gets an `## Outcome (2026-10-06)` section after Goal, built from the report's deviation table, with commits and report paths.
  - Phase 2 keeps `src/renderer/stores/plan-approval.ts` (Keep list). The dead `hooks/use-plan-approval.ts` is deleted by the repair branch.
  - Phase 4 records the review repairs and leaves L5 deferred.
  - Phase 4 Task 4.6 notes the `gio launch` replacement.
  - Phase 4 Task 4.7's `config.yml` block gains `skills.customDirectories: []`, `skills.includeSkills: []`, a `commands` block (`enableClaudeUser`, `enableClaudeProject`, `enableOpencodeUser`, `enableOpencodeProject`, all `false`) and a `plan` block (`enabled: false`, `defaultOnStartup: false`). Their omp ids and line ranges were re-checked in `extensibility/settings.ts:65-81,104-149` and `plan-mode/settings.ts:12-35`.
- **plan.md:**
  - Decisions "Removed commands" now points to `src/renderer/lib/command-availability.ts` and records the omp-compatible name parsing, the queue check and the three added names.
  - Decisions "Pinned settings and approval rules" lists the new keys and the renderer disarm at ready.
  - A "Wave A review fixes" paragraph sits after the Wave gate. It covers the branch `rebrand/wave-a-fixes` from `rebrand-wave-a`, its worktree, its scope (H2 keeps the store), the merge before Phase 5, the full Wave gate re-run plus the repair gate, and the tag `rebrand-wave-a-fixed`.
  - The worktree row and the Rollback tag list include the repair branch and its tag.
  - A new open question covers the SAI OS confirmation, due before Phase 9 Task 9.0.
- **Phase 6:**
  - P6-1: Context explains the e2e fixture sidecar. `resolveAssistantPackDir` and `resolve_pack_dir` fall back to `resources/assistant-pack` only when the build is unpackaged, uses an `OMP_BUNDLED_OMP` binary, is dev, or has `e2e-hooks`. There is no env var. The twin cases `resolves the pack under resources for a fixture sidecar outside the tree` are added, and Task 6.8 Verify runs `e2e-tauri/runtime.e2e.ts`.
  - P6-2: Task 6.5 asserts the trailing-slash map entry `"../resources/assistant-pack/": "assistant-pack/"`.
  - P6-3: the Language bullet reads `ctx.upgrade().map(|ctx| ctx.i18n.language())` with an `en` default, and the STOP is removed.
  - P6-4: `profileToFlags` stops emitting denylisted flags. `launch-profile.test.ts:17` joins the rewrite list, and Task 6.3 names `appends_the_workspace_launch_profile_flags_at_spawn_denylist_proof` (`manager.rs:1174`, assertion `:1202`).
  - Task 6.6 Verify adds the two `plan.*` rows and the six discovery rows.
  - Two cosmetic corrections: `OMP_SIDECAR=source` is at `index.ts:116-117`, and the OS-tools line says `gio launch`.
  - Two should-fix items from the report were applied because they keep Verify mechanical. `assistant-pack.ts` may import only `node:path` and `node:fs`. Task 6.7's `pgrep` is narrowed with `grep -- '--extension'`, because the stats server also matches `--mode rpc-ui`.
- **Phase 8:**
  - Context and Task 8.5 count seven launch-profile fields, `noRules` included.
  - `PACK_PINNED_SETTING_KEYS` lists the nine `skills.*` keys, the four `commands.*` keys and both `plan.*` keys.
  - Task 8.5 drops `pinnedGroups`/`toggleGroupPin` and `workspaceLastUsed`/`touchWorkspace`, keeps `groupAliases`, and adds the test `ignores the retired pinnedGroups and workspaceLastUsed fields of a stored blob` and an absence `rg`.
  - The plan-approval leftover line was not added, because the store stays and the repair branch deletes the hook.
- **Phase 9:**
  - Task 9.0 has a precondition and a Verify for the SAI OS confirmation (`rg 'awaiting user confirmation'` on the spike report prints nothing).
  - Step 2a removes the `QuickEntryTarget` `chat` member and the Rust `Chat` variant in both shells. A sent or saved `"chat"` still parses as `work`. Twin test renames are named, and ownership now lists the quick-entry files.
  - Step 2b adds `libglib2.0-bin` to `deb.recommends`, `DEB_RECOMMENDS` (`finalize-deb.ts:74`, now owned for that constant only) and the packaging test list.
  - Task 9.5 adds the CHANGELOG line "Closing a worktree tab no longer asks about its checkout; the checkout stays on disk." with a count Verify.
- **Not applied (outside the requested list):**
  - P5-3 (pruning stale allowlist entries) and P5-4 (the `capture-showcase.ts` risk note).
  - The `gio launch` edit to the spike report's "SAI OS commands" list, which belongs with the repair branch.
- **Grep sweep:** `gtk-launch` now appears only in Phase 4's Outcome and Task 4.6, both as the replaced command. No "six removed fields" text remains. `parent()/assistant-pack` appears only as the first choice of `resolve_pack_dir`. `plan-approval` appears only in Phase 2's Keep list, Task 2.6, the Task 2.9 `ls` and its Outcome, and in plan.md's "Wave A review fixes" paragraph, all of them intentional.

## Phase 6 readiness edits (Opus stand-in counsel)

Applied from `plans/reports/advisor-standin-261006-phase-6-readiness.md`. Citations were re-checked read-only on `/home/tung491/WORK/worktrees/rebrand-integration` at `1f38391`. No user decision changed, and no code was edited. `ak plan validate plans/261005-0812-everyday-work-rebrand` exits 0 afterwards.

- **Phase 6 must-fixes:**
  - M1: Ownership adds `.github/workflows/ci.yml` (the `tauri-linux` job only). Task 6.4 adds the `bun run build:pack` step after `bun install --frozen-lockfile` (`ci.yml:102`). Verify adds the `grep` and `bunx vitest run scripts/tauri-packaging-config.test.ts`. That test checks the job's commands with `toContain` (`scripts/tauri-packaging-config.test.ts:548-558`), so the extra step does not break it.
  - M2: Task 6.1 opens with the `assistant-pack.ts` stubs, including the new `missingAssistantPackMessage` export from S4.
  - M3: Task 6.2 step 1 replaces `sourceRoot` with `searchFrom` (8-level walk-up, the same as `resolveBundledOmp` at `index.ts:93`, no `realpath`, new `SidecarManagerOptions.packSearchFrom`). Task 6.4 uses `resolve_pack_dir(binary, search_from)`, and the manager passes `CARGO_MANIFEST_DIR` only under `is_dev()` or `e2e-hooks`. The missing-pack cases in both shells leave one file out of an existing `assistant-pack/` and use a packaged build. The Rust fixture-outside-the-tree twin passes a temp root. Context's source-mode sentence points to the walk.
  - M4: Task 6.7 step 1 passes `CARGO_HOME`, `RUSTUP_HOME` and `CARGO_HOME_BIN` from the real home. `readRustPins` expands `$HOME` from the env (`scripts/tauri-dev.ts:48`). Step 3's `pgrep` excludes `--omp-supervise`.
  - M5: Task 6.6 builds the pack, then checks it, after `build:omp` (`sync-upstream.sh:69-70`).
  - M6: index.ts ownership covers its import lines.
- **Phase 6 should-fixes, all applied:**
  - S1: Language reads `self.ctx…code()` (`manager.rs:559`, `i18n.rs:17`).
  - S2: `language` is optional and defaults to `en`.
  - S3: `linux` gets the Linux list, and every other platform gets the macOS list. This is stated in Spawn contract and Task 6.2.
  - S4: `missingAssistantPackMessage(file, packaged)` mirrors `missingSidecarMessage` (`sidecar.ts:183`). Task 6.1's table case asserts both variants.
  - S5: the pack check runs after the missing-binary check. The fixture rewrite count goes from 11 to 9, because the `it` cases at `:311` and `:329` stay unchanged.
  - S6: the Rust twins `tab_spawn.rs:149,159,169,178` and `manager.rs:1110` are named for deletion, and `surfaces_a_reinstall_instruction_when_a_pack_file_is_missing` is added.
  - S7: `strips_denylisted_flags_pair_aware` (`manager.rs:1090`) is extended. Task 6.3's red condition now admits it.
  - S8: unconsumed non-`--` tokens are dropped. Task 6.1 adds a `-x value` case.
  - S9: the expected argv is written as a literal.
- **Phase 6 gate:** Task 6.8 splits merge and tag. Between them, a clean clone of `rebrand/everyday-work` runs the `tauri-linux` job's `run:` steps in order. The chain asserts that no pack and no sidecar exist, and it passes only if it prints `exit=0`. The clone is removed afterwards.
- **Phase 8:**
  - `PACK_PINNED_SETTING_KEYS` lists ten `skills.*` keys, `skills.ignoredSkills` included.
  - The constant is exported from `settings-schema-utils.ts`.
  - The new `pack-pinned-keys.test.ts` (`covers every key the pack config pins`) parses `assistant-pack/config.yml` with `yaml`, flattens it (arrays are leaves), and requires every path to equal an entry or have an entry as a dotted prefix. This test is written first, and its Verify is red, then green.
- **Applied beyond the list, same defect as M4:** throwaway-`HOME` runs that start cargo tools now pass the same cargo variables:
  - Phase 8 Task 8.8 (`dev:tauri`);
  - Phase 7's `test:e2e:tauri` step;
  - Phase 9 Task 9.0 step 3.

  Without them, `wdio.conf.ts:55-57` looks for `tauri-driver` under the throwaway home and fails.
- **Skipped:** nothing. No should-fix conflicts with a Decision in plan.md:
  - S3 keeps Windows-drop sequencing in Phase 7.
  - S4 fulfils the Risks line "the error says what to run".
- **Grep sweep:** no `sourceRoot`, `self.inner`, `11 in total` or bare `env HOME=$H … tauri` remains in phases 6–9.
