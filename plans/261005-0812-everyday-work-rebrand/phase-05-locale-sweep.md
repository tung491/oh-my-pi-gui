---
phase: 5
title: "Locale sweep"
status: done
priority: P2
effort: "1d"
dependencies: [2, 3, 4]
---

# Phase 5: Locale sweep

## Goal

Delete every renderer locale key that no longer has a user after Phases 2 and 3, from `en.ts` and `vi.ts` together, so the two files stay key-identical. The doc estimates about 800 of the roughly 2,900 keys.

## Context

- Plan index `./plan.md`, Decisions row "Locale keys" (one serial sweep instead of per-surface key deletions).
- `src/renderer/locales/locales.test.ts` checks en/vi key parity, no empty values, placeholder subsets, real translations in `TRANSLATED_NAMESPACES` (lines 22–76), and product naming. It does not check usage.
- Runs alone, on the integration branch after Wave A and its repair branch merged (tag `rebrand-wave-a-fixed`, `plan.md` "Wave A review fixes").

## Ownership

- May modify: `src/renderer/locales/en.ts`, `src/renderer/locales/vi.ts`, `src/renderer/locales/locales.test.ts`.
- May create (not committed): `/home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/tools/unused-locale-keys.ts` and its output `tools/unused-locale-keys.json`.
- Must not touch any other file.

## Tasks

### Task 5.0 — Worktree
- Steps: `git -C /home/tung491/WORK/oh-my-pi-gui worktree add -b rebrand/p05-locale-sweep /home/tung491/WORK/worktrees/rebrand-p05 rebrand/everyday-work && cd /home/tung491/WORK/worktrees/rebrand-p05 && bun install && ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64 && bun run build:pack` (the full `bunx vitest run` in Task 5.5 includes Phase 4's compiled test, which needs both).
- Verify: `git -C /home/tung491/WORK/worktrees/rebrand-p05 log --first-parent --oneline -4` shows the `rebrand/wave-a-fixes` merge and the Phase 2, 3 and 4 merge commits; `git -C /home/tung491/WORK/worktrees/rebrand-p05 merge-base --is-ancestor rebrand-wave-a-fixed HEAD` exits 0 (the Wave A repair is merged and gated, `plan.md` "Wave A review fixes"); `test -x resources/omp.linux-x64 && ls resources/assistant-pack/tools.js` exits 0.

### Task 5.1 — Tests before: baseline green
- Verify: `bunx vitest run src/renderer/locales` exits 0 (the baseline must be green before any deletion).

### Task 5.2 — Write the unused-key finder
- Goal: a deterministic list of deletable keys.
- Target file: `plans/261005-0812-everyday-work-rebrand/tools/unused-locale-keys.ts` (absolute path above; run it with the worktree as cwd).
- Behaviour:
  1. Import `en` from `<cwd>/src/renderer/locales/en.ts`; take its keys.
  2. Read every `.ts`/`.tsx` file under `<cwd>/src/` except `src/renderer/locales/`.
  3. A key is **used** when it equals the whole content of a string literal (`"…"`, `'…'`, or a template literal without `${`) anywhere in those files, test files included.
  4. Collect **dynamic patterns** from every template literal that contains `${`: its static head (the text before the first `${`) when that head contains a `.`, and, when the head is empty, its static tail (the text after the last `}`) as a suffix pattern. The head need not end in `.`: `` `tabs.menu.split${…}` `` (`components/layout/SplitWorkspace.tsx:53`) yields the prefix `tabs.menu.split`. A key that is not used and starts with a prefix pattern or ends with a suffix pattern is **review**, not unused.
  5. Write `{ "unused": [...], "review": [...], "dynamicPrefixes": [...] }` to `tools/unused-locale-keys.json`, sorted (`dynamicPrefixes` holds both the prefix and the suffix patterns).
- Verify: `bun /home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/tools/unused-locale-keys.ts` exits 0 and the JSON's `unused` array is non-empty.

### Task 5.3 — Review the dynamic keys
- Steps: for each `dynamicPrefixes` entry, open its source line and list the values the `${…}` part can take today (an enum, a union type or an array in the same file). Move a `review` key to `unused` only when no current value produces it. Write the decisions into the JSON as `"reviewDecisions": [{ "key": "...", "decision": "delete|keep", "why": "<file:line>" }]`.
  - The `cmd.` prefix comes from `lib/command-registry.ts:267` and `:275`, which build `` `cmd.${keyOf(name)}` `` for the `sub(...)`/`subAction(...)` items only (`keyOf`, `:155-156`: `-x` becomes `X`, a space becomes `.`); every top-level command reads its label and `.desc` through literal keys, so they are already `used`. Decide the review keys mechanically: collect every first argument of `sub("…")` and `subAction("…")` in that file, apply `keyOf` to each, and keep a review key only when it equals `cmd.<keyOf(name)>` for one of them; delete the rest. Add this rule to `unused-locale-keys.ts` (reimplement `keyOf` there; do not import the registry) and record `why` as the matching `sub` line or `no submenu item builds this key`.
- Verify: every `review` key appears exactly once in `reviewDecisions`.

### Task 5.4 — Refactor: delete the keys
- Steps:
  1. Delete every `unused` key and every `reviewDecisions` key marked `delete` from **both** `en.ts` and `vi.ts`, in the same edit.
  2. In `locales.test.ts`, delete each `TRANSLATED_NAMESPACES` entry that no longer prefixes any key in `en.ts`.
  3. Commit: `refactor(i18n): remove keys of deleted developer surfaces`.
- Verify: `bunx vitest run src/renderer/locales` exits 0; `bun run check:types` exits 0.

### Task 5.5 — Tests after and gate
- Verify:
  - Re-running the finder prints a JSON whose `unused` array is empty.
  - `bunx vitest run` exits 0; `bunx biome check src/renderer/locales` exits 0.
  - Record the before/after key counts (`grep -cE '^\s+"[^"]+":' src/renderer/locales/en.ts`) in the phase report.
- Merge: `git -C /home/tung491/WORK/worktrees/rebrand-integration merge --no-ff rebrand/p05-locale-sweep && git -C /home/tung491/WORK/worktrees/rebrand-integration tag rebrand-p05`.

## Risks and rollback

- A key used only through a computed string (not a literal, not a template prefix) would be deleted wrongly; `locales.test.ts` would not catch it, but the UI would show the raw key. The review step covers template prefixes; Phase 9's visual pass is the backstop.
- Rollback: before Phase 6 merges, revert the merge commit; afterwards see `plan.md` "Rollback".

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
