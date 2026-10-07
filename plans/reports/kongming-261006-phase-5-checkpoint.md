# Kongming counsel: Phase 5 checkpoint (after Wave A)

Date: 2026-10-06 (Asia/Seoul). Plan: `plans/261005-0812-everyday-work-rebrand/`. Inputs: `plan.md`, `phase-05-locale-sweep.md`, `phase-06-spawn-wiring.md`, `phase-08-everyday-ux.md`, `phase-09-copy-and-release.md`, the three Wave A reports, and the integration tree at `da001bb` (`/home/tung491/WORK/worktrees/rebrand-integration`, tag `rebrand-wave-a`). Every claim marked verified was checked against a file on that tree today. The parallel code review was not waited for.

## TL;DR

**GO for Phase 5, after two edits to its finder spec (Task 5.2 rule 4 and Task 5.3's `cmd.` rule).** As written, the finder would delete `tabs.menu.split{Left,Right,Top,Bottom}` (built as `` `tabs.menu.split${…}` ``, a template head that does not end in `.`) and could mis-handle `cmd.*` keys built through `keyOf` (hyphen to camelCase, space to dot). Everything else in Phase 5 matches the post-Wave-A tree. **Phase 6 is not ready as written:** four edits are needed before it starts, the biggest being that every e2e spec runs the fixture sidecar from `e2e/sidecar-fixture.ts`, so "pack beside the binary" resolves to a missing `e2e/assistant-pack` and Phase 6's new refusal would stop every e2e launch. Wave A's deviations need an Outcome section in each phase file, three follow-up lines in Phases 8 and 9, and one plan.md gate for the unconfirmed SAI OS commands.

## Reframed problem

The decision is whether the serial locale sweep can run mechanically on the tree Wave A actually produced (not the tree the plan imagined), and whether Phase 6 can start right after it without a STOP in its first task. Requirements: Phase 5 deletes only keys with no user, keeps every key a later phase edits or a template builds, and leaves `locales.test.ts` green; Phase 6's spawn contract and file lists must match the shipped pack and the current line numbers; deviations become records, not folklore.

## Question 1: Phase 5 go/no-go

### Verified against the tree

- Key counts: `en.ts` and `vi.ts` both hold 2,916 keys (plan said about 2,900). Phase 2 and 3 touched no locale file (reports; `git log` agrees).
- Phase 8 and Phase 9 edit three existing keys: `sidebar.kindMismatch` (`hooks/use-session-switch.ts:190`), `sidebar.newWork` (`components/layout/Sidebar.tsx:515`), `welcome.continue` (`components/onboarding/FirstRunOnboardingDialog.tsx:526`). All three are referenced as string literals today, so the finder keeps them. Phase 8's `STARTERS`/`CHAT_STARTERS` keys are referenced by `ChatStream.tsx` today and stay until Phase 8 removes them itself (it owns locales in Wave C).
- Nothing outside `src/` imports the locale maps except `scripts/capture-showcase.ts:5-6` (see Risks). `src/main/i18n.ts` and `src-tauri/src/i18n.rs` carry their own strings (`MainTextKey`), so Phase 7's main/Rust removals orphan no renderer key. No HTML file references keys.
- `locales.test.ts` looks allowlist keys up by `en` keys, so stale `ALLOW_IDENTICAL`/`AGENT_SCOPE_OMP` entries do not fail; pruning them is hygiene (`modelCompare.noRole`, `extPanel.tabs.mcp`, `modesPanel.tabs.vibe`, `stats.col.*`, `benchmark.description`, `collab.join*` will all be deleted).
- The `kind-mismatch` toast, the one-lane sidebar and the `REMOVED_COMMANDS` move leave no key referenced only through a computed string other than the patterns below.

### Dynamic key construction (the part the finder must get right)

35 `t()` calls take a template literal; every one but one has a static head ending in `.` (verified list: `cmd.`, `titlebar.status.`, `settings.source.`, `settings.display.`, `settings.nav.`, `input.thinking.name.`, `input.thinking.level.`, `tools.memory.operation.`, `chat.compaction.reason.`, `welcome.tier.`, `welcome.card.fit.`, `welcome.card.speed.`, `themePicker.theme.`, `queuePanel.lane.`, `category.`, `agentHub.source.`, `agentHub.defs.prewalk.`, `jobs.type.`). Two template literals outside that rule carry keys into `t()` indirectly: `lib/tab-signal.ts:32` (`labelKey: \`titlebar.status.${tab.status}\``) and `settings/settings-window-model.ts:95` (`settings.display.${id}`); both have a `.`-terminated head, so rule 4 "every template literal" (not only inside `t(`) already covers them. The exceptions:

1. **`components/layout/SplitWorkspace.tsx:53`:** `` t(`tabs.menu.split${zone.placement[0]?.toUpperCase()}${zone.placement.slice(1)}`) `` builds `tabs.menu.splitTop|splitLeft|splitRight|splitBottom` (`en.ts:104-107`). The head `tabs.menu.split` does not end in `.`, so Task 5.2 rule 4 ignores it and the four keys land in `unused`. (`tabs.menu.splitCurrent` at `:109` is a literal elsewhere.)
2. **`hooks/use-rpc-events.ts:155`:** `` const key = `${kind}.notify` `` has an empty head. It is an omp settings path, not a locale key, and no locale key ends in `.notify`, so it causes no false delete today; the rule should still record empty-head templates as suffix patterns so the next one is caught.
3. **`lib/command-registry.ts:155-156`:** `keyOf(name)` turns `"session delete"` into `session.delete` and `"new-chat-tab"` into `newChatTab`. Only the ten `sub(...)`/`subAction(...)` items use the template (`:267`, `:275`; names `session delete|pin`, `advisor on|off|status|dump`, `todo edit|copy|export|import`); every top-level command uses literal `t("cmd.x")`/`t("cmd.x.desc")`. Task 5.3's rule "take the segment after `cmd.` and `rg 'name: "<segment>"'`" happens to work for the three parents in use (`session`, `advisor`, `todo` all exist as `name:` values at `:359`, `:529`, `:633`), but it is wrong in both directions in general: a camelCased segment never matches a hyphenated `name:`, and a parent that exists would keep sub keys of sub-items Phase 2 deleted. Replace it with the exact rule below.

### Must-fix plan edits (Phase 5)

**P5-1 — `phase-05-locale-sweep.md`, Task 5.2, replace behaviours 3 and 4 with:**

> 3. A key is **used** when it equals the whole content of a string literal (`"…"`, `'…'`, or a template literal without `${`) anywhere in those files, test files included.
> 4. Collect **dynamic patterns** from every template literal that contains `${`: its static head (the text before the first `${`) when that head contains a `.`, and, when the head is empty, its static tail (the text after the last `}`) as a suffix pattern. The head need not end in `.`: `` `tabs.menu.split${…}` `` (`components/layout/SplitWorkspace.tsx:53`) yields the prefix `tabs.menu.split`. A key that is not used and starts with a prefix pattern or ends with a suffix pattern is **review**, not unused.

**P5-2 — Task 5.3, replace the `cmd.` bullet with:**

> - The `cmd.` prefix comes from `lib/command-registry.ts:267` and `:275`, which build `` `cmd.${keyOf(name)}` `` for the `sub(...)`/`subAction(...)` items only (`keyOf`, `:155-156`: `-x` becomes `X`, a space becomes `.`); every top-level command reads its label and `.desc` through literal keys, so they are already `used`. Decide the review keys mechanically: collect every first argument of `sub("…")` and `subAction("…")` in that file, apply `keyOf` to each, and keep a review key only when it equals `cmd.<keyOf(name)>` for one of them; delete the rest. Add this rule to `unused-locale-keys.ts` (reimplement `keyOf` there; do not import the registry) and record `why` as the matching `sub` line or `no submenu item builds this key`.

**P5-3 (should) — Task 5.4 step 2, append:** "Also delete each `ALLOW_IDENTICAL` and `AGENT_SCOPE_OMP` entry whose key no longer exists in `en.ts` (the test tolerates stale entries, but they would misdocument the allowlist)."

**P5-4 (should) — Risks, append:** "`scripts/capture-showcase.ts` indexes `en`/`vi` by literal keys of deleted surfaces (`panel.tabs.diff`, `cmd.modelRoles`, `modelRoles.title`, `agentHub.tabs.hub`, `contextUsage.*`; lines 176-219). It is outside `src/` by design and Phase 9 Task 9.4 rewrites it; it will not run between Phase 5 and Phase 9."

Phase 5's Task 5.0, 5.1, 5.4 and 5.5 need no change: the sidecar link and `build:pack` are in place on the integration worktree, and the Wave gate already proved the full suite green.

## Question 2: which deviations need a record, and where

| Deviation | Record | Follow-up |
|---|---|---|
| `components/panels/hub-filter.ts` kept (R7 lists it); `AgentHubWindow` imports it | phase-02 Outcome | none |
| `stores/fork-handoff.ts` and `ForkHandoffDialogs.test.tsx` deleted (R3 did not list them) | phase-02 Outcome | none |
| Worktree tabs close without the file prompt (`WorktreeCloseDialog` gone) — user-visible | phase-02 Outcome | Phase 9 Task 9.5: one CHANGELOG line ("Closing a worktree tab no longer asks about its checkout; the checkout stays on disk") |
| `REMOVED_COMMANDS` lives in `lib/command-availability.ts` (shared by palette, composer, completion) | plan.md Decisions "Removed commands": append "(`src/renderer/lib/command-availability.ts`)" | none |
| `stores/plan-approval.ts` and its hook kept, `PlanApprovalDialog` deleted: nothing renders a proposal; `tabs.ts` `settleTabPlanApproval` still snapshots it | phase-02 Outcome | Phase 8 Task 8.5 leftovers: delete the store, hook, `settleTabPlanApproval` and the `clearProposal` call at `hooks/use-rpc-events.ts:571`; `rpc-client.ts` `planApproval` and the `plan_approval` RPC type are `src/shared`, so they wait for Phase 9 Task 9.0 or stay (an unused client method is harmless) |
| Sidebar prefs `pinnedGroups`, `workspaceLastUsed` no longer read (`groupAliases` still read by TabBar) | phase-02 Outcome | Phase 8 Task 8.5 leftovers (drop the two fields and their migration if any) |
| `QuickEntryTarget` keeps `{ kind: "chat" }` (`src/shared/ipc-types.ts:367`); renderer maps it to Work | phase-02 Outcome | Phase 9 Task 9.0 (`src/shared/ipc-types.ts` is already in its scope): drop the member and the renderer mapping |
| Menu-action branches removed in `App.tsx`; items in `src/main/menu.ts` do nothing until 9.0 | already in plan.md ("MenuAction trim moved to Phase 9 Task 9.0") | none |
| Phase 3: seven names added to `GENERIC_BY_DESIGN`; `SUMMARIES` headers kept for old transcripts | phase-03 Outcome | none |
| Phase 4: `yaml` stays a runtime dependency (Task 4.0 Verify prints `null` by design) | phase-04 Outcome | none |
| Phase 4: `assistant-pack/biome.json` (`root: false`, `extends: "//"`) instead of a root `files.includes` edit | phase-04 Outcome | none required; folding into the root config is optional cleanup for Phase 9 Task 9.0 if the user prefers one config |
| Phase 4 Task 4.10 SAI OS commands unconfirmed (NEEDS-INTEGRATION) | plan.md open questions | Phase 9 Task 9.0 precondition (text below) |
| Phase 9 Task 9.0 e2e scope widened to drop steps for removed controls | already applied by the controller | none |

Suggested record shape, matching Phase 1's `## Outcome (2026-10-06)` section: one bullet per row above, each naming the commit (`bf0bebb`, `6b9a7fa`, `8f63c6c`, `adebfe4`…) and the report path. Plans are stateful records (documentation rule), so this is the right home; no evergreen doc changes.

**Must-add gate (plan.md and Phase 9).** Nothing in Phases 5–9 references Task 4.10's pending confirmation (grep for `4.10` across `phase-0[5-9]*.md` and `plan.md`: no hit). Add to `plan.md` "Open questions carried from the doc": "The `os_setting` argv table, `cinnamon-settings` panels, `diagnose` checks and helpdesk menu paths shipped by Phase 4 await the user's check on a SAI OS (LMDE 7) machine (`plans/reports/spike-261005-everyday-work-rebrand.md`, "SAI OS commands"; Phase 4 Task 4.10 NEEDS-INTEGRATION). Due before Phase 9 Task 9.0." And add to Phase 9 Task 9.0 Verify: "`rg -n 'awaiting user confirmation' plans/reports/spike-261005-everyday-work-rebrand.md` prints nothing (the SAI OS command list is confirmed, and any correction has landed in `assistant-pack/src/tools/os-commands.ts` with its tests)."

## Question 3: Phase 6 readiness against the real Wave A code

### Verified consistent

- `ASSISTANT_PACK_FILES` (eight paths) equals what `scripts/build-assistant-pack.ts` writes and what `resources/assistant-pack/` holds on the integration tree: `package.json`, `tools.js`, `system-prompt.md`, `config.yml`, four `skills/*/SKILL.md`. No `bin/`, no `agents/`.
- `scripts/check-assistant-pack.ts` exists with the inline `DEFAULT_TOOLS` (eleven names, identical to the Linux `<TOOLS>`), `PACK_SKILLS`, `--tools`/`--lang` options, env built inline (`HOME` scratch, `SAI_ATLAS_LANG`, `BASH_ENV`/`ENV` deleted) and the checks Task 6.6 lists (tools, skills, prompt, agents, settings value plus `overlay` layer, notice/extension_error frames). Task 6.6's rewiring and Task 6.1's "no `office_report` literal" test are consistent with it. Keep `--lang` and the scratch `HOME`; make the pack argument optional while still accepting two positionals (`assistant-pack/test/compiled.test.ts` passes both).
- Line references are current: `sidecar.ts:298`/`:301`/`:307`/`:321`, `:257` and `:277-281`; `src/main/index.ts:357`; `manager.rs:133-139`, `:142-159`, `:543-550`, `:567-572`, test at `:1110`; `launch-profile.ts:42-103`, `:114`; `shell-env.ts:31`, `shell_env.rs:28`; `tab-spawn.ts:34-45`, `tab_spawn.rs:48-60`; `sidecar.test.ts:53` and `:133`, eleven `new SidecarManager` cases; `tab-spawn.test.ts:47/56/65/82`; `i18n.rs:198`; `getMainLanguage` at `src/main/i18n.ts:164` returning `"en" | "vi"`. `OMP_SIDECAR=source` is at `index.ts:116-117`, not `:355-360` (cosmetic).
- `sync-upstream.sh:69-70` runs `build:omp`, which writes `resources/omp` (host arch), as Task 6.6 assumes.
- The e2e harness sets `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` in the app's own env (`e2e-tauri/session.ts:133-134`); the plan's "values already in `process.env` pass through" keeps that working after the five keys join `OVERLAY_DENYLIST`.

### Must-fix plan edits (Phase 6)

**P6-1 — e2e fixture sidecar has no pack beside it.** Both shells honour `OMP_BUNDLED_OMP` (`src/main/index.ts:85-86` unconditionally; `src-tauri/src/paths.rs:238-241` under `e2e-hooks`), and every e2e spec points it at `e2e/sidecar-fixture.ts` (`e2e-tauri/session.ts:30,137`; ten `e2e/*.e2e.ts` files). `dirname(binaryPath)/assistant-pack` is then `e2e/assistant-pack`, which does not exist, so Phase 6's refusal stops every fixture launch and Task 6.7's dev run is the only thing that works. The fixture ignores argv (`e2e/sidecar-fixture.ts:16` reads only `stats`), so the flags themselves are harmless. Phase 6 cannot edit `e2e/**`, and relocating the fixture would break its relative imports (`:5-13`). Resolve it in the app, inside Phase 6's ownership, and add to Task 6.2 step 1:

> - `resolveAssistantPackDir(binaryPath, sourceRoot?)`: `join(dirname(binaryPath), "assistant-pack")` when that directory exists; otherwise `join(sourceRoot, "resources/assistant-pack")` when `sourceRoot` is given (also when `binaryPath` is empty). `src/main/index.ts` passes `sourceRoot` only when `!app.isPackaged` or the binary came from `OMP_BUNDLED_OMP`, so a packaged build with its own binary never looks outside its resources.

and to Task 6.4 (`assistant_pack.rs`): "`resolve_pack_dir(binary)` prefers `binary.parent()/assistant-pack`; when it is missing and the build is `tauri::is_dev()` or has the `e2e-hooks` feature, it falls back to `CARGO_MANIFEST_DIR/../resources/assistant-pack` (the same dev root `paths::resolve_bundled_omp` uses, `paths.rs:244`)." Add the twin cases `resolves the pack under resources for a fixture sidecar outside the tree` to Task 6.1's `assistant-pack.test.ts` list and `resolves_the_pack_under_resources_for_a_fixture_sidecar_outside_the_tree` to Task 6.3. Add to Task 6.8 Verify: `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/runtime.e2e.ts` exits 0 (one fixture spec proves the launch path; Phase 9 Task 9.0 owns the rest).

**P6-2 — Task 6.5 must use the trailing-slash map form, not a glob.** Tauri's map form copies a directory with its structure only as `"dir/": "target/"`; a glob key (`"dir/**/*": "target/"`) flattens matches into the target ("all the matching files will be placed to the target directory without preserving the original file structures", v2.tauri.app/develop/resources). Flattening would collide the four `SKILL.md` files. `src-tauri/linux/sidecar.conf.json` already uses the map form (`"binaries/omp-x86_64-unknown-linux-gnu": "omp"`). Replace Task 6.5 step 1's first bullet with: "In `scripts/tauri-packaging-config.test.ts`, assert that `src-tauri/linux/sidecar.conf.json` `bundle.resources` contains exactly the entry `"../resources/assistant-pack/": "assistant-pack/"` (trailing slashes on both sides; a glob key flattens the skill folders) beside the existing `omp` entry." Keep the Electron assertion as written.

**P6-3 — Task 6.4 "Language" bullet: the handle exists, so remove the STOP.** `manager.rs` holds `ctx: CtxRef` (`:413`), `CtxRef = Weak<AppCtx>` (`ports.rs:23`), and `AppCtx.i18n: MainI18n` (`ctx.rs:22`) exposes `language()` (`i18n.rs:198`); `launch_profile_flags(ctx, cwd)` at `:227` already upgrades the same handle. Replace the bullet with: "**Language:** `self.inner.ctx.upgrade().map(|ctx| ctx.i18n.language())`, defaulting to `en` when the context is gone (shutdown), read at spawn time next to `launch_profile_flags` (`manager.rs:227`). Do not add a field to `ports::SidecarOptions`."

**P6-4 — `profileToFlags` emits flags the new denylist drops.** `launch-profile.ts:150-176` emits `--system-prompt`, `--append-system-prompt`, `--no-rules`, `--add-dir`, `--tools`, `--config` (and `--no-lsp`, `--plan-yolo`, `--profile`, `--session-dir` from the fields at `:14-33`). After Task 6.2 step 4 all of them except `--no-lsp` and `--session-dir` are denylisted, so `launch-profile.test.ts:17` ("maps every field to its CLI flag in a fixed order") and `:139` ("profileToFlags can never emit a denylisted flag") contradict each other, and `manager.rs:1202` (the Rust twin of `sidecar.test.ts:133`) asserts `--append-system-prompt`, `--no-rules`, `--add-dir` and `--tools read,bash` survive. Add to Task 6.2 step 4: "`profileToFlags` stops emitting every denylisted flag (the `LaunchProfile` fields stay so stored prefs parse; Phase 8 removes their UI); `:139`'s invariant is the guard." Add `:17` to Task 6.1's rewrite list, and name `manager.rs:1202` (`appends_the_workspace_launch_profile_flags…`) in Task 6.3 next to the `:1110` replacement. Phase 8's Context names "six removed fields"; `noRules` makes seven, so add it there too (`phase-08-everyday-ux.md:30`).

### Should-fix

- Task 6.6: state that `src/main/assistant-pack.ts` imports only `node:path`/`node:fs` (no `electron`), because the Bun script and the Rust-twinned vitest both load it.
- Task 6.7 step 3: `pgrep -af -- '--mode rpc-ui'` also matches the omp stats server (`src-tauri/src/omp/stats.rs` spawns omp too); add `grep -- '--extension'` to pick the session sidecar.

## Question 4: next risk to watch

1. **Phase 6 Task 6.1 red-run scope creep.** Eleven `SidecarManager` cases plus the launch-profile rewrite plus the Rust twins is the largest test surface in the plan, and the parity loop fails on any name mismatch. Keep P6-4's list exact and run the parity loop before `cargo test`, as Task 6.3 orders.
2. **e2e after Phase 6.** Even with P6-1, the real-core specs (`e2e-tauri/real-core.e2e.ts`, `e2e/real-core.e2e.ts`) now run a sidecar without `bash`; any step that expects shell output or a removed tool fails until Phase 9 Task 9.0. That is already in 9.0's widened scope; do not fix it in Phase 6.
3. **Phase 5 false deletes outside the two known patterns.** The finder's `review` list is the safety net; if it is empty after P5-1, that is a bug (it must contain at least the `tabs.menu.split*` and `category.*` keys).
4. **Wave C parallelism.** Phase 7 (main/Rust) and Phase 8 (renderer) both depend on Phase 6's `assistant-pack.ts` shape; P6-1 changes that signature, so Phase 8's `PACK_PINNED_SETTING_KEYS` and Phase 7's packaging edits should read the merged Phase 6 code, not the phase file.

## What to avoid

- Do not let Phase 5 exclude test files from the "used" scan; a key referenced only by a surviving test is a harmless keep, and excluding tests risks deleting keys of components whose tests are the only literal reference.
- Do not add an env var for the pack location to solve P6-1; the plan's "no env override" rule (red team findings 1, 11) stands, and the dev/e2e fallback above stays inside `!app.isPackaged`/`e2e-hooks`.
- Do not use the glob form in `sidecar.conf.json` to "be safe"; it is the unsafe one.
- Do not fold the Phase 2 leftovers (plan-approval store, sidebar prefs) into Phase 5 or 6; they belong to Phase 8 Task 8.5, which owns `src/renderer/**` in Wave C.

## Work checklist (controller, before spawning Phase 5)

1. Apply P5-1 and P5-2 to `phase-05-locale-sweep.md`; P5-3 and P5-4 optional but cheap.
2. Add `## Outcome (2026-10-06)` sections to `phase-02`, `phase-03`, `phase-04` from the table in Question 2.
3. Edit `plan.md`: Decisions "Removed commands" file pointer; open-questions entry for the SAI OS confirmation.
4. Edit `phase-08-everyday-ux.md` Task 8.5 (plan-approval store and hook, `settleTabPlanApproval`, sidebar prefs fields; "seven" launch-profile fields including `noRules`).
5. Edit `phase-09-copy-and-release.md`: Task 9.0 precondition (SAI OS confirmation) and `QuickEntryTarget` member; Task 9.5 CHANGELOG line for worktree-tab close.
6. Apply P6-1 through P6-4 to `phase-06-spawn-wiring.md` before Wave B, not necessarily before Phase 5 starts.
7. Spawn Phase 5 with its ownership verbatim; its Task 5.0 worktree starts from `rebrand-wave-a`.

## Success metrics

- Phase 5's finder output has a non-empty `review` list containing `tabs.menu.splitTop` and the `cmd.session.delete`-style sub keys, and after Task 5.4 the UI shows no raw key on the split menu, the thinking control, the settings nav and the command palette (Phase 9's visual pass).
- Phase 6 Task 6.1's red run fails only in the listed cases; the parity loop exits 0 on the first try.
- One fixture e2e spec passes on the Phase 6 branch before merge.
- `rebrand-p05` and `rebrand-wave-b` tag without a Failure Protocol stop.

## Assumptions

- The finder treats keys referenced in `*.test.ts(x)` as used (high; conservative by design).
- Tauri's trailing-slash map semantics apply to `--config` overlay files the same as to `tauri.conf.json` (high; the existing `omp` entry already relies on the map form through the same overlay).
- Bun resolves the fixture's relative imports from the fixture's real path, so relocating it is not an option worth testing (medium; moot if P6-1 is applied app-side).
- The user still wants the SAI OS command confirmation to gate Phase 9, not Phase 6 (high; stated in the Phase 4 brief).
- The parallel code review of Wave A may add items to the Outcome sections; nothing here depends on it (high).

## Wave A review fixes

Input: `plans/reports/code-reviewer-261006-wave-a.md` (0 critical, 2 high, 4 medium, 9 low). Every omp claim below was re-read in `/home/tung491/WORK/oh-my-pi/packages/coding-agent/src` today; GUI claims on the integration tree.

### Verdict on placement

**One repair branch, `rebrand/wave-a-fixes`, cut from `rebrand-wave-a`, merged `--no-ff` before Phase 5 starts; not Phase 6.** Reasons: every file involved is Phase 2 or Phase 4 territory (`src/renderer/lib`, `components/layout`, `hooks`, `stores`, `assistant-pack/**`, `scripts/check-assistant-pack.ts`), none of which Phase 6 owns, and Phase 6 is already the heaviest phase. Phase 5 touches only locales, so the branches would not collide, but running the repair first lets Phase 5's finder see the final renderer (the plan-approval store and hook go in this branch, see H2). After the merge re-run the plan.md Wave gate (all fourteen steps) and tag `rebrand-wave-a-fixed`; leave `rebrand-wave-a` where it is. Phase 5 Task 5.0 then branches from the integration head as written. Effort: about one day.

Nothing here needs the user. H2 and M3 extend the binding "Pinned settings and approval rules" decision ("pin every approval-relevant key") rather than reverse it; `wt`/`worktree` fall under R3 (every git surface deleted). Record both as Decisions-row edits (below).

### H1 — removed-command bypass: in-scope repair of Phase 2 (red-team finding 5 was "Accept")

Verified: omp cuts the name at the first whitespace **or `:`** (`slash-commands/helpers/parse.ts:26-33`); the builtin lookup registers aliases (`builtin-registry.ts:50-56`); the GUI's regex `/^\/(\S+)/` (`lib/composer-submit.ts:107`) reads `/share:x` as `share:x`; the queue branch in `components/layout/use-composer-submit.ts:129-170` checks only `isGuiOnlyBuiltinCommand` (`:144`) before `rpc.prompt(item, …, "followUp")` (`:170`). `AvailableCommand` carries `aliases?: string[]` (`src/shared/rpc-types.ts:1560`).

Fix (all in `src/renderer`):
1. `lib/command-availability.ts`: export `removedCommandName(text: string, commands: readonly AvailableCommand[]): string | null` — strip `/`, cut at the first whitespace or `:`, lower-case, resolve through an alias map built from `commands[].aliases` plus a static table for the builtins omp advertises under an alias (`plugin → plugins`); return the canonical name when it is in `REMOVED_COMMANDS`. Add `plugin`, `wt`, `worktree` to `REMOVED_COMMANDS`.
2. `lib/composer-submit.ts:107-111`: replace the regex check with `removedCommandName(message, commands)`.
3. `use-composer-submit.ts`: before the `isGuiOnlyBuiltinCommand` check at `:144`, run `removedCommandName` over every `dispatchItems` entry; on a hit restore the text and images and toast `unavailable.tuiOnly`, exactly as the GUI-only branch does.
4. Palette and completion already use the exact set; no change.

Tests: `lib/composer-submit.test.ts` — `blocks a removed command in omp's colon form (/share:x)`, `blocks a removed command through its alias (/plugin list)`, `blocks the worktree commands (/wt, /worktree)`; `components/layout/use-composer-submit.test.ts` (create beside the hook if none exists) — `blocks a removed command in the queue shorthand (=> /share)` and `blocks a removed command anywhere in a queued list (-> hello, /collab:start)`: the text is restored, nothing is sent, one toast; `lib/command-availability.test.ts` — `removedCommandName resolves advertised aliases`.

### H2 — plan mode enterable, unanswerable: repair now, in the way that fits the decisions

Verified: the RPC start path arms plan mode only when `plan.defaultOnStartup` **and** `plan.enabled` are true (`modes/rpc/rpc-mode.ts:1710-1720`); `plan.enabled` defaults to true (`plan-mode/settings.ts:12-21`). But `set_plan_mode` never consults `plan.enabled` (`rpc-mode.ts:3305-3328`) and `syncArmed()` arms purely from the session's journaled plan state (`modes/rpc/rpc-plan.ts:75-79`), so a resumed session that was in plan mode arms whatever the config says. Disarming is always allowed (`rpc-mode.ts:3306-3309` refuses only enabling in a restricted session). The renderer already tracks `planModeEnabled` from hydration (`stores/session.ts:55,119`) and has `rpc.setPlanMode(false)` (`src/shared/rpc-client.ts:180`).

**Choose: pin the keys and force plan mode off at hydration. Do not restore a plan dialog.** A dialog contradicts "one task lane, every surface in R1–R14 deleted", and a pack session with no `task`, `bash` or `edit` has nothing to plan for. Two parts, both mechanical:
1. `assistant-pack/config.yml`: add `plan: { enabled: false, defaultOnStartup: false }`. Update `EXPECTED_CONFIG` in `assistant-pack/test/pack-files.test.ts:114`. `scripts/check-assistant-pack.ts` reads the new rows back from the overlay with no change (it walks `config.yml`).
2. Renderer: when a hydrated or resumed session reports plan mode on (`session-hydration.ts`, where `planModeEnabled` is set), send `setPlanMode(false)` once and set the store to `false`. This closes the journal path that the config cannot. Then delete the dead `hooks/use-plan-approval.ts`, `stores/plan-approval.ts`, `settleTabPlanApproval` in `stores/tabs.ts` and the `clearProposal()` call at `hooks/use-rpc-events.ts:571`, with their cases in `stores/tabs.test.tsx:199-229,545` (L6 and the Phase 8 Task 8.5 line become moot; the `planApproval` client method and `plan_approval` RPC type in `src/shared` stay, unused, until Phase 9 Task 9.0).

Tests: `hooks/session-hydration.test.ts` — `disarms a resumed plan-mode session at ready` (state with `planMode.enabled: true` → one `set_plan_mode {enabled:false}` command recorded, store `planModeEnabled` false) and `sends no plan command when the session is not in plan mode`; `pack-files.test.ts` deep-equal; Phase 6 Task 6.6 Verify gains "`plan.enabled` and `plan.defaultOnStartup` read `false` from `overlay`". Until Phase 6 the config pins are inert on their own, which is why part 2 is required now.

### M1 — `gtk-launch` resolves the user's `.desktop` first: repair of Phase 4

Verified: `assistant-pack/src/tools/os-commands.ts:245-251` checks `<applicationsDir>/<id>.desktop` then runs `gtk-launch <id>`. Fix: return `["gio", "launch", desktop]` with the absolute system path already computed on `:246`. Packaging fact the review missed: `gio` lives in `libglib2.0-bin` and `gtk-launch` in `libgtk-3-bin` (`dpkg -S` on this host), and **neither** is in `DEB_DEPENDS` or `DEB_RECOMMENDS` (`src-tauri/linux/finalize-deb.ts:71,74`), so the swap changes nothing for packaging today; both are present on every GTK desktop. Add `libglib2.0-bin` to `deb.recommends` in Phase 9 Task 9.0 (it owns `tauri.linux.conf.json` and the packaging tests; `DEB_RECOMMENDS` moves with it). In the tool, when `/usr/bin/gio` is missing, fail with the existing plain sentence rather than spawning. Tests: `os-commands.test.ts:184` expects the `gio launch <absolute path>` argv; add `refuses the app when gio is not installed` through the existing injected context. Add the `gio` argv to the Task 4.10 SAI OS check list in the spike report.

### M2 — no size caps, no abort in the office tools: repair of Phase 4

Verified: `ToolModule.execute(toolCallId, params, signal?)` (`assistant-pack/src/tools/types.ts:24`) and `office-tools.ts` never reads `signal`. Fix: in `office-tools.ts`, `statSync` the input before loading and refuse above 20 MB with a plain sentence; in `clean.ts`, refuse a sheet whose `rowCount * columnCount` exceeds 2,000,000 before walking cells, and check `signal?.aborted` between sheets (throw the plain "I stopped" sentence); cap `markdown` for `office_report`/`office_slides` at 1 MB. Tests in `clean.test.ts`: `refuses a workbook over the byte cap`, `refuses a sheet with too many cells` (one cell at `XFD1048576` written with ExcelJS makes `rowCount × columnCount` huge at no cost), `stops between sheets when the signal is aborted`; in `office-tools.test.ts`: `refuses oversized markdown with a plain sentence`.

### M3 — unpinned discovery keys: fulfils the existing decision, repair of Phase 4

Verified in omp: `skills.customDirectories` and `skills.includeSkills` (`extensibility/settings.ts:65-81`), `commands.enableClaudeUser|ClaudeProject|OpencodeUser|OpencodeProject` (`:104-140`). Fix: add to `config.yml` `skills.customDirectories: []`, `skills.includeSkills: []`, and the four `commands.*: false`; update `EXPECTED_CONFIG`. The overlay outranks user and project layers for every key it sets, so pinning a default still blocks a user value. `check-assistant-pack.ts` will fail the branch gate if any key is unknown to the compiled sidecar's schema, which is the test. Phase 8's `PACK_PINNED_SETTING_KEYS` text (`phase-08-everyday-ux.md:105`) must list the new keys (`plan.enabled`, `plan.defaultOnStartup`, `skills.customDirectories`, `skills.includeSkills`, the four `commands.*`).

### M4 — stale e2e: already Phase 9 Task 9.0 (controller widened it). No action.

### Lows to take in the same pass

- **L1** (`output.ts:79-90`): on a `writeSync` throw, `closeSync` and `unlinkSync` the partial file; assert the returned byte count equals the buffer length. Test: `removes the partial file when the write fails`.
- **L2** (`output.ts:57-61`): compute the code-point array once and slice. Test: existing truncation cases.
- **L3** (`output.ts:44-55`, `office-tools.ts:234-245`): `realpathSync` the `Sai ATLAS` folder after `mkdir` and apply the existing first-segment check to it against the real `Documents`. Test: `refuses an output folder that is a symlink out of Documents`.
- **L4** (`os-commands.ts:305-315`): build the sentence from `buildOpenItemArgv`'s validated result and fall back to the generic sentence on a `PlainError`. Test: `the approval sentence never repeats an invalid value`.
- **L6**: delete `hooks/use-git-status.ts` with the plan-approval files above.
- **L8** (`skills/sai-os-helpdesk/SKILL.md` step 6): a dated note name (`support-note-<date>-<time>.md`), consistent with "new files never replace anything". Test: `pack-files.test.ts` asserts the skill text names a dated file.
- **L9** (`check-assistant-pack.ts:341-346`): delete `PI_CONFIG_FILES`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` from the sidecar env, next to `BASH_ENV`/`ENV` (the same five keys Phase 6 adds to the overlay denylist).
- **Defer:** L5 (unverified; verify `soffice.bin` survival in Phase 9's container smoke, then `detached` plus a group kill if it does), L7 (CHANGELOG line already routed to Phase 9 Task 9.5).

### Plan edits that go with the repair branch

- `plan.md` Decisions "Pinned settings and approval rules": append "`plan.enabled`/`plan.defaultOnStartup: false`, `skills.customDirectories`/`includeSkills: []`, `commands.enable*: false` (Wave A review H2, M3, 2026-10-06); the renderer also disarms a journal-armed plan session at ready, because `set_plan_mode` and `syncArmed` ignore `plan.enabled`".
- `plan.md` Decisions "Removed commands": append "name resolution mirrors omp's parser (whitespace or `:`), aliases included; `plugin`, `wt`, `worktree` added (review H1)".
- `phase-08-everyday-ux.md:105`: extend `PACK_PINNED_SETTING_KEYS`; Task 8.5: drop the plan-approval leftover line if the repair branch deletes those files.
- `phase-06-spawn-wiring.md` Task 6.6 Verify: add the two `plan.*` rows.
- `phase-09-copy-and-release.md` Task 9.0: `libglib2.0-bin` in `deb.recommends` (with `DEB_RECOMMENDS` and the packaging test).
- `plans/reports/spike-261005-everyday-work-rebrand.md` "SAI OS commands": `gio launch` replaces `gtk-launch` in the list to confirm.

### Repair branch gate

Same as the Wave gate plus: `bunx vitest run src/renderer/lib src/renderer/components/layout src/renderer/hooks assistant-pack` green with the new cases listed as passed; `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` prints `plan.enabled = false [overlay]`, the six discovery rows, and `PACK LOAD CHECK: PASS`; `rg -n 'gtk-launch' assistant-pack` prints nothing.
