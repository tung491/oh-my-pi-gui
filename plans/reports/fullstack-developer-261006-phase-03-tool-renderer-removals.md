# Phase 3 implementation report: tool renderer removals

- Plan: `plans/261005-0812-everyday-work-rebrand/` (phase file `phase-03-tool-renderer-removals.md`)
- Worktree: `/home/tung491/WORK/worktrees/rebrand-p03`, branch `rebrand/p03-tool-renderers`, created from `rebrand/everyday-work` (`7677ba1`)
- Status: DONE. Tasks 3.0 to 3.3 are complete. As instructed, Task 3.4 (merge, Wave A gate, tag) is left to the orchestrator. Nothing was pushed or tagged.

## Commit

- `8f63c6c` refactor(renderer): remove renderers for tools outside the allowlist (12 files, +45 / -2358)

## Tasks

- [x] 3.0: The worktree was created and `bun install` ran. `git branch --show-current` printed `rebrand/p03-tool-renderers`.
- [x] 3.1: I created `src/renderer/components/tools/registry-inventory.test.ts`. The red run exited 1 with 13 failures, all of them the deleted-key cases. The 8 kept-key cases (`read`, `glob`, `write`, `ask`, `bash`, `find`, `task`, `wait`) passed.
- [x] 3.2: I deleted `AstEditRenderer`, `AstGrepRenderer`, `LspRenderer`, `GithubRenderer`, `DebugRenderer`, `HubRenderer`, `VibeRenderer` and `EvalRenderer` (none of them had a sibling test file). I also removed their imports and the 13 `REGISTRY` keys from `index.tsx`, and the Hub and Eval cases from `UpstreamParityRenderers.test.tsx`. The Wait, proc-read and protocol-write cases are kept. `bun run check:types` exited 0.
- [x] 3.3 gates:
  - `bunx vitest run src/renderer/components/tools` exited 0 (9 files, 59 tests).
  - The renderer-name `rg` over `src/renderer` printed nothing (exit 1, no matches).
  - `bunx biome check src/renderer/components/tools` exited 0 (36 files).
  - Extra check: the full `bunx vitest run` exited 0 (213 files, 2009 tests).
  - The phase lists neither the parity loop nor snapshots, and it touches no Rust, so neither was run.

## Deviations

- **`ToolRegistry.test.tsx` was edited.** The phase file did not list this file, but it is inside `tools/**` ownership. Its coverage test requires every canonical omp tool name either to have a renderer or to appear in `GENERIC_BY_DESIGN`. After the deletion, `ast_edit`, `ast_grep`, `debug`, `eval`, `github`, `hub` and `lsp` have no renderer. I added these seven names to `GENERIC_BY_DESIGN` with a comment saying everyday-work sessions never load them. This is the mechanism the test documents for this case ("Landing here is a decision"), and it records the plan's accepted fallback. I made the edit before running Verify, so no Verify step failed and kongming was not consulted.
- **`SUMMARIES` in `index.tsx` was left as it is.** It still has header entries for `ast_edit`, `ast_grep`, `lsp`, `eval`, `debug`, `github` and `hub`. The phase only removes `REGISTRY` keys, and these entries give old transcripts a readable collapsed header on the generic card.
- Kept as the coordination rules require: `CoordinationRenderer.tsx`, `TaskRenderer.tsx`, `task-render-utils.ts` and `GenericRenderer.tsx`. Locale files were not touched (Phase 5 owns them).

## Next steps

- The orchestrator merges `rebrand/p03-tool-renderers` into `rebrand/everyday-work` (Task 3.4). If this branch is the last of Wave A to merge, it then runs the Wave gate.
- I did not edit the phase file's status. Plan status changes go through `ak plan`, which the orchestrator owns.

## Unresolved questions

None.
