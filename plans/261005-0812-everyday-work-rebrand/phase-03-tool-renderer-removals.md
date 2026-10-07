---
phase: 3
title: "Tool renderer removals"
status: done
priority: P2
effort: "0.5d"
dependencies: [1]
---

# Phase 3: Tool renderer removals

## Goal

Delete the renderers for tools the model no longer gets (doc row R10), so those tool names fall back to `GenericRenderer` in old transcripts.

## Outcome (2026-10-06)

Done and merged (`978d0ec`, commit `8f63c6c`); tagged with Wave A as `rebrand-wave-a`. Report: `plans/reports/fullstack-developer-261006-phase-03-tool-renderer-removals.md`. Deviations, no follow-up needed:

- `ToolRegistry.test.tsx` (inside this phase's ownership, not listed in the tasks) gained seven names in `GENERIC_BY_DESIGN`: `ast_edit`, `ast_grep`, `debug`, `eval`, `github`, `hub`, `lsp`. Its coverage test requires every canonical omp tool to have a renderer or be listed there.
- `SUMMARIES` in `index.tsx` keeps its header entries for the removed tools, so old transcripts still get a readable collapsed header on the generic card.

## Context

- Plan index `./plan.md`, Decisions row "CoordinationRenderer": `CoordinationRenderer.tsx` and `TaskRenderer.tsx` stay. Since the spike, pack sessions load neither `task`, `wait`, `bash` nor `find` (Decisions "Office route" and "Helpers"; the session tools are `read`, `glob`, `write`, `ask`, the four OS tools and the three office tools). Their renderers stay for old transcripts; whether to remove them is an open question for the user (`plan.md` "Open questions"), not part of this phase. Phase 8 adds the office tools' renderer.
- Wave A: runs in parallel with Phase 2 and Phase 4.
- `getToolRenderer(name)` returns `REGISTRY[name] ?? GenericRenderer` (`src/renderer/components/tools/index.tsx:101-147`).

## Ownership

- May modify or delete: `src/renderer/components/tools/**` only.
- Must not touch anything else. Phase 8 later adds `OfficeFileRenderer` to `index.tsx`; do not add it here.

## Delete list

Files under `src/renderer/components/tools/` (with their `*.test.tsx` siblings): `AstEditRenderer.tsx`, `AstGrepRenderer.tsx`, `LspRenderer.tsx`, `GithubRenderer.tsx`, `DebugRenderer.tsx`, `HubRenderer.tsx`, `VibeRenderer.tsx`, `EvalRenderer.tsx`.

`REGISTRY` keys to delete: `ast_edit`, `ast_grep`, `lsp`, `github`, `gh`, `debug`, `hub`, `eval`, `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`.

Keep: `CoordinationRenderer.tsx`, `TaskRenderer.tsx`, `task-render-utils.ts`, `GenericRenderer.tsx` and every other key.

## Tasks

### Task 3.0 — Worktree
- Steps: `git -C /home/tung491/WORK/oh-my-pi-gui worktree add -b rebrand/p03-tool-renderers /home/tung491/WORK/worktrees/rebrand-p03 rebrand/everyday-work && cd /home/tung491/WORK/worktrees/rebrand-p03 && bun install`
- Verify: `git -C /home/tung491/WORK/worktrees/rebrand-p03 branch --show-current` prints `rebrand/p03-tool-renderers`.

### Task 3.1 — Tests before (red)
- Goal: a registry inventory test that fails today.
- Target files: create `src/renderer/components/tools/registry-inventory.test.ts`.
- Steps: import `getToolRenderer` from `./index` and `GenericRenderer` from `./GenericRenderer`; for every deleted key assert `getToolRenderer(key) === GenericRenderer`; for `read`, `glob`, `write`, `ask`, `bash`, `find`, `task`, `wait` assert `getToolRenderer(key) !== GenericRenderer`.
- Verify (red): `bunx vitest run src/renderer/components/tools/registry-inventory.test.ts` exits non-zero, failing only the deleted-key cases.

### Task 3.2 — Refactor: delete the renderers
- Steps:
  1. Delete the files in the delete list.
  2. In `index.tsx`, delete their imports and the `REGISTRY` keys listed above.
  3. In `UpstreamParityRenderers.test.tsx`, delete the cases that import `EvalRenderer` or `HubRenderer`; keep the `WaitRenderer` cases.
  4. `bun run check:types` and fix only errors inside `src/renderer/components/tools/`.
- Success criteria: types compile.
- Verify: `bun run check:types` exits 0.

### Task 3.3 — Tests after and gate
- Verify:
  - `bunx vitest run src/renderer/components/tools` exits 0 (the inventory test is green).
  - `rg -l "AstEditRenderer|AstGrepRenderer|LspRenderer|GithubRenderer|DebugRenderer|HubRenderer|VibeRenderer|EvalRenderer" src/renderer` prints nothing.
  - `bunx biome check src/renderer/components/tools` exits 0.
- Commit: `refactor(renderer): remove renderers for tools outside the allowlist`.

### Task 3.4 — Merge
- Steps: `git -C /home/tung491/WORK/worktrees/rebrand-integration merge --no-ff rebrand/p03-tool-renderers`; on a conflict, STOP. If this is the last of Phases 2, 3 and 4 to merge, run the Wave A gate (`plan.md` "Wave gate") on the integration worktree; only when it passes, `git -C /home/tung491/WORK/worktrees/rebrand-integration tag rebrand-wave-a`.
- Verify: `git -C /home/tung491/WORK/worktrees/rebrand-integration log --oneline -1` mentions `p03-tool-renderers`.

## Risks and rollback

- An old transcript with `eval` or `lsp` calls renders through GenericRenderer: accepted by the doc ("Old transcripts fall back to GenericRenderer").
- Rollback: revert the merge commit until Phase 8 merges (it edits `tools/index.tsx`); afterwards see `plan.md` "Rollback".

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
