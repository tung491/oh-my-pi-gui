---
title: "Everyday-work rebrand plan: red team moved the office launcher into the install"
date: 2026-10-05
summary: "9-phase plan for the Sai ATLAS rebrand; red team found the doc's containment bypassable and the plan's own gates broken; both fixed before handoff."
---

# Everyday-work rebrand plan: red team moved the office launcher into the install

## What happened
Planned the Sai ATLAS everyday-work rebrand from the design doc into `plans/261005-0812-everyday-work-rebrand/` (9 phases, parallel waves, TDD, handover-ready for a Sonnet-class executor).

The 4-reviewer red team (37 raw findings, 15 after dedup, 6 critical) showed the doc's containment did not hold against omp's actual behaviour:
- The launcher at `~/.local/share/sai-atlas/bin/office` is model-writable; the bash allow rule (`tools/bash.ts:575`) then runs whatever is there without a prompt. Every build, worktree and test run also overwrote it.
- `--tools` limits only the parent; helpers take tools from their agent file (`task/executor.ts:3638`), and the bundled `task` agent has all of them.
- Extension, skill and MCP discovery stayed on; user/project `tools.approval` still applied because the overlay pinned only `bash.patterns`; bash ran a login shell.
- Chat-stamped sessions resume restricted, without extension tools (`main.ts:1593`, `sdk.ts:3273`).
- Deleting GUI commands re-exposes omp's own `/share`, `/collab`, `/mcp` through `availableCommands`.
- The plan's own gates were broken: bare `check-test-parity.ts` exits 2; worktrees have no gitignored sidecar; `git rebase` would erase the merge commits rollbacks depend on.

## Decision
- Launcher: static read-only `<pack>/bin/office`, found through `PATH`, configured by env (`SAI_ATLAS_OMP`, `SAI_ATLAS_PACK`, `SAI_ATLAS_LANG`), `PI_BASH_NO_LOGIN=1`; nothing written to `$HOME`.
- Spawn adds `--no-extensions`; the overlay pins `shellPath`, bash rules, `fetch.enabled`, `extensions`, `skills.*`, `mcp.enableProjectConfig`, `task.disabledAgents`, `tools.approval`.
- Chat-stamped sessions refused with "start a new task"; project sessions stay listed; `REMOVED_COMMANDS` blocks omp's built-ins.
- Merge (not rebase) plus wave tags for rollback; the parity loop from CI.
- Validation: refuse Ollama cloud tags, macOS category to Productivity, `.xls`/`.ods` through LibreOffice conversion.

## Next steps
Run `/ak:cook /home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/plan.md --advice`. Phase 1's containment checks (Task 1.4b) must all pass before Phases 4 and 6 start.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
