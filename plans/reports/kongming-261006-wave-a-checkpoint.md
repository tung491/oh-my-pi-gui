# Kongming counsel: Wave A checkpoint (Phases 2, 3, 4)

Date: 2026-10-06. Plan: `plans/261005-0812-everyday-work-rebrand/`. Inputs: the planner's propagation report, the spike report, the edited phase files, the current tree at `7677ba1`, the spike worktree `/home/tung491/WORK/worktrees/rebrand-p01`, and the omp 18.4.8 source. Every claim marked "verified" was checked against a file or a command run today; the rest is labelled.

## TL;DR

**GO for Wave A, after five mechanical edits to the plan files** (none changes a user decision): Phase 4 Task 4.0 must not add `scripts/build-assistant-pack*.ts` to the root `tsconfig.json` (it breaks `check:types`: `Bun` is unresolved under `types: ["node"]`), must add `yaml` and `jszip` to its `bun add`, Task 4.9 must set `SKIP_COMPILED=1` on the existing CI `linux` job, Phase 5 Task 5.0 must link the sidecar and build the pack (its full-suite gate now needs both), and the plan needs a Wave A integration gate on `rebrand-integration` before `rebrand-wave-a` is tagged. Yes to the Phase 4 load check: do it as `scripts/check-assistant-pack.ts` created in Phase 4 (ported from the spike's `loadcheck.ts`) and rewired in Phase 6, because the real gap is not the three dropped keys but that nobody loads the rebuilt pack into omp until Phase 6.

## Reframed problem

The decision is whether three parallel worktrees can start today without a merge that fails `check:types`, `vitest` or `build` on the integration branch, and whether the pack Phase 4 ships is proven loadable before Phases 5 and 6 build on it. Requirements: disjoint ownership, every Verify mechanical, no residual bash/launcher/helper/`find` assumption, and drift between the measured `pack-v2b/config.yml` and the shipped `config.yml` caught before Wave B. Non-goals: reopening the office route, approval tier, inert `bash.*` keys or renderer keep list, all decided.

## Question 1: review of the edited phase files

### Verified clean

- **Decisions vs phase text.** Phase 4 Tasks 4.5–4.7 and Phase 6 "Spawn contract" match the gate decisions: typed tools with static `approval: "write"` plus `tools.approval.office_*: prompt`, `<TOOLS>` identical to the spike's `pack-v2b/TOOLS.txt` (verified: `read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean`), `loadMode: "essential"` on all seven, `skill://` opening, no `task`/`wait`/`bash`/`find`. The config keys cited exist at the cited lines (`bash.direnv` enum `auto|off` at `exec/settings.ts:152-156`, `task.disabledAgents` at `task/settings.ts:371`, `temperature` at `session/settings.ts:432`, `loadMode` default at `extensibility/extensions/types.ts:681`).
- **YAML `off`.** omp parses config with `Bun.YAML` (`config/settings.ts:32`). Run through the sidecar's own runtime, `Bun.YAML.parse("a: off")` returns the string `"off"`, so the spike's unquoted value already read back correctly, and the planner's quoting is harmless belt-and-braces. The `yaml` npm package (1.2 core schema) agrees. No drift from quoting.
- **Ownership is disjoint and the cross-imports are safe.** No file under `src/renderer/components/tools/**` imports a module Phase 2 deletes (grep over the whole delete list: zero hits). Nothing outside `tools/**` imports a renderer Phase 3 deletes (zero hits in `src`, `e2e`, `e2e-tauri`). `ChatStream.tsx` (excluded from Phase 2) imports none of them. `tools/ToolCard.tsx:43` reads only `toolsExpandAll` from the ui store, which Phase 2 keeps.
- **Phase 2 line references are current** on `7677ba1`: `stores/ui.ts:10` (`PanelTab`), `:235` (`panelTab: "diff"`), `App.tsx:286-291`, `Sidebar.tsx:102` (`SidebarMode`), `:148`, `:744` (`openTab({ kind: "chat" })`), `command-registry.ts:1452-1456`, `composer-submit.ts:124-128`, `hooks/use-rpc-events.ts:35` (`loop-mode`). Every file in the Phase 2 and Phase 3 delete, keep and edit lists exists. `UpstreamParityRenderers.test.tsx:19-23` imports `EvalRenderer`, `HubRenderer` and `WaitRenderer` exactly as Task 3.2 step 3 assumes. `GlobRenderer` is registered (`tools/index.tsx:116`), so Task 3.1's `glob` assertion passes today.
- **Residual bash/launcher/helper/`find` text.** Only intentional hits remain (Phase 3's keep assertion for the `bash`/`find`/`task`/`wait` renderers, Phase 8's "helper wording" rename, Phase 4's reference to the doc's "Helpdesk helper" steps). Nothing instructs building a launcher, an agent file or passing `find`.
- **Menu actions.** `src/main/menu.ts:268,272` still send `open-pr-center` and `open-workspace-dirs`, and `src/shared/ipc-types.ts:336,343` keep them in `MenuAction`. The renderer handles them in an `if` chain (`App.tsx:673`, `:701`), not an exhaustive map, so Phase 2 can delete those two branches without touching `src/main` or `src/shared`; the union trim stays in Phase 9 Task 9.0 as decided.

### Must-fix before Wave A starts

**M1 — `phase-04-assistant-pack.md:78` (Task 4.0 step 3) breaks `check:types`.** The root `tsconfig.json` has `types: ["node"]` and `include: ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts"]`; no script is type-checked today (`tsconfig.node.json` is never run by `check:types`). Adding `scripts/build-assistant-pack*.ts` makes `tsc` see `Bun.build` and fail: verified with `bunx tsc --noEmit --types node` on a one-line file → `error TS2868: Cannot find name 'Bun'`. Replace step 3 with:

> 3. Add `"assistant-pack/**/*.ts"` to `tsconfig.json` `include` (the pack code and its tests use `node:` modules only). Do not add `scripts/**`: the root config has `types: ["node"]`, and the build script uses `Bun.build`; scripts are not type-checked by `check:types` today, and this one follows the same rule. Add `resources/assistant-pack/` to `.gitignore` under the sidecar block.

**M2 — `phase-04-assistant-pack.md:77` (Task 4.0 step 2) misses two test dependencies.** Task 4.7 parses `config.yml` with the `yaml` npm package (not installed: `jq '.devDependencies.yaml' package.json` → `null`) and Tasks 4.2/4.4 reopen zips with JSZip, which is only a transitive dependency of `docx`. Replace step 2 with:

> 2. `bun add -d docx@9.8.1 exceljs@4.4.0 pptxgenjs@4.0.1 marked@18.0.14 yaml@2.9.1 jszip@3.10.2` (the first four are the versions the spike ran; `yaml` and `jszip` serve the tests only; if one is not on npm, STOP).

and extend the Verify to `jq -r '.devDependencies.docx, .devDependencies.exceljs, .devDependencies.pptxgenjs, .devDependencies.marked, .devDependencies.yaml, .devDependencies.jszip' package.json` prints six versions.

**M3 — `phase-04-assistant-pack.md:260` (Task 4.9) turns the existing CI `linux` job red.** `.github/workflows/ci.yml:26` runs `bunx vitest run` with no vitest config file in the repo (none exists; `package.json` has no `vitest` key), so vitest's default include picks up `assistant-pack/test/compiled.test.ts`, which fails with `sidecar binary missing` unless `SKIP_COMPILED=1`. Add to the CI bullet:

> The existing `linux` job's `bunx vitest run` step gets `env: { SKIP_COMPILED: "1" }` (a clean clone has no sidecar, `AGENTS.md` "CI"); the new `assistant-pack` job sets the same variable on its vitest step.

and add to the Verify: `grep -c 'SKIP_COMPILED' .github/workflows/ci.yml` prints at least `2`.

**M4 — `phase-05-locale-sweep.md:30-35` (Task 5.0) cannot run its own gate.** Phase 5 runs after Wave A and its Task 5.4 gate (line 63) is the full `bunx vitest run`, which now includes `compiled.test.ts` (needs `resources/omp.linux-x64` and the built `resources/assistant-pack`). Task 5.0 creates the worktree with `bun install` only. Append to its Steps, exactly as Phases 6–8 do (`phase-07:41`, `phase-08:64`):

> `&& ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64 && bun run build:pack`

and to its Verify: `test -x resources/omp.linux-x64 && ls resources/assistant-pack/tools.js` exits 0.

**M5 — no integration gate between the third merge and the `rebrand-wave-a` tag.** Tasks 2.10, 3.4 and 4.11 each gate their own branch and then say "whichever merges last tags it". Three green branches do not prove a green merge (Phase 2 deletes renderer files; Phase 4 adds tests and changes `package.json`/`tsconfig.json`). Add to `plan.md` "Phases and waves" after line 74, and reference it from the three merge tasks:

> **Wave gate.** The phase that merges last does not tag at once. In `/home/tung491/WORK/worktrees/rebrand-integration` it runs: `bun install`, `ln -sf /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64`, `bun run build:pack`, `bun run check:types`, `bunx vitest run`, `bun run build`, `git diff --name-only rebrand-base -- '*.ts' '*.tsx' | xargs bunx biome check`, then the absence greps of Tasks 2.9, 3.3 and 4.8. Only when every command exits 0 does it tag `rebrand-wave-a`. A failure is handled by the Failure Protocol of the phase that merged last.

### Should-fix (small, do them in the same edit pass)

- **S1 — Phase 2 constraints missing from its Keep list (`phase-02:33`).** Two e2e specs inside `check:types` but outside Phase 2's ownership import renderer code: `e2e/deep-audit.e2e.ts:6-7` and `e2e-tauri/deep-audit.e2e.ts:11-12` import `keyboardPlatformOf` from `lib/keymap` and `effectiveShortcut` from `lib/shortcut-hint`. Add to the Keep list: "the exports `keyboardPlatformOf` (`lib/keymap.ts`) and `effectiveShortcut` (`lib/shortcut-hint.ts`), imported by both deep-audit e2e specs; and `toolsExpandAll` on `stores/ui.ts`, read by `components/tools/ToolCard.tsx:43`". Add to Task 2.7/2.8 edit points: "`App.tsx:673` and `:701` — delete the `open-workspace-dirs` and `open-pr-center` branches; the `MenuAction` union and `src/main/menu.ts` stay until Phase 9 Task 9.0".
- **S2 — Phase 4 Task 4.10 is a human gate in the middle of a parallel wave.** The `os_setting` and `cinnamon-settings` argv lists are already written in Task 4.6, so the request can go out at the start. Add a step 5 to Task 4.0: "Send the user the `os_setting` argv table and the `cinnamon-settings` panel list from Task 4.6 now, asking for a check on a SAI OS (LMDE 7) machine; Task 4.10 collects the answer." If the answer has not arrived by Task 4.11, merge with the proposed commands and record a `NEEDS-INTEGRATION` row for 4.10 in the Phase 4 report; nothing ships before Phase 9.
- **S3 — `phase-04:257` Task 4.9 target files** omit `assistant-pack/test/visual.test.ts`, which the task creates; add it.
- **S4 — `phase-06:42` wording.** `soffice` is started by `office_clean` (Task 4.3 rule 11), not by an OS tool. Replace "The OS tools still start system programs (`xdg-open`, `gtk-launch`, `soffice`, some of them shell scripts)" with "The OS tools (`xdg-open`, `gtk-launch`, `cinnamon-settings`) and `office_clean` (`soffice`) still start system programs, some of them shell scripts".
- **S5 — Phase 6 ownership and Task 6.6** change with the Question 2 answer below (`phase-06:87` moves `scripts/check-assistant-pack.ts` from "May create" to "May modify"; Task 6.6 steps become a rewiring).

No contradiction with a user decision was found in Phases 3, 4 or 6, and no Verify step is non-mechanical except Task 4.10 (human by design).

## Question 2: load check in Phase 4 — yes, and widen it

The planner frames the risk as "three dropped entries". Dropping keys cannot make the remaining keys stop reading back, and quoting `off` is a no-op under `Bun.YAML`, so on that framing the check would catch nothing. The real gap is bigger: Phase 4 rebuilds `tools.js`, the skills, the system prompt and the manifest from scratch through a new build script, and Task 4.9 only drives `tools.js` through a fake `pi`. Nobody runs omp against the shipped pack until Phase 6 Task 6.6, two phases later. The spike already wrote the check (`spike/harness/loadcheck.ts`, 297 lines, plus the parts of `rpc.ts` it needs: spawn, newline JSON with `rpc_chunk` reassembly at `rpc.ts:795-830`, `negotiate_protocol` v2, `get_active_tools`, `get_available_commands`, `get_settings_schema`, `get_settings`, `get_state`, `get_agent_definitions`). Port it now, and Phase 6 inherits it instead of writing it.

Placement: Phase 4 creates `scripts/check-assistant-pack.ts` (the file Phase 6 Task 6.6 planned), with the flags built inline from arguments. Phase 6 later replaces the inline builder with `assistantPackFlags`/`assistantPackEnv` imports from `src/main/assistant-pack.ts` (Phase 4 must not touch `src/**`, so it cannot import them). The duplicated tool list is deliberate: Phase 6's test then asserts the script's default equals `assistantPackFlags`'s `--tools` value, which is the drift check between the two statements of the contract.

Edits:

- `phase-04:31` Ownership "May create": add `scripts/check-assistant-pack.ts`.
- `phase-06:87`: move `scripts/check-assistant-pack.ts` to "May modify".
- `phase-06:191-197` Task 6.6 steps: "Replace the script's inline flag builder and tool-list argument with `resolveAssistantPackDir`, `assistantPackFlags` and `assistantPackEnv` from `src/main/assistant-pack.ts`; keep its checks unchanged; add a test in `src/main/assistant-pack.test.ts` named `ships the tool list the pack check expects` whose Rust twin is `ships_the_tool_list_the_pack_check_expects` (parity rule)." Keep the `sync-upstream.sh` step and the Verify as written.

New Task 4.9 text (replace the task; the CI bullet keeps M3):

> ### Task 4.9 — Compiled-path integration test, pack load check and CI job
> - Target files: `assistant-pack/test/compiled.test.ts`, `assistant-pack/test/fixtures/call-tool.mjs`, `assistant-pack/test/visual.test.ts`, `scripts/check-assistant-pack.ts`, `.github/workflows/ci.yml`.
> - `call-tool.mjs <packDir> <toolName> <params JSON>`: imports `<packDir>/tools.js`, calls its default export with a fake `pi` that records `registerTool`, runs the named tool's `execute("t1", params)` and prints the result as one JSON line.
> - `scripts/check-assistant-pack.ts <omp binary> <pack dir> [--tools <comma list>] [--lang en|vi]` (Bun script, ported from `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/loadcheck.ts` and the `Sidecar` client in `spike/harness/rpc.ts`: spawn, newline-delimited JSON, `rpc_chunk` reassembly, `negotiate_protocol` version 2, request/response by id; no suite, scoring or drafts code). It spawns `<omp binary> --mode rpc-ui --no-session --no-extensions --extension <pack> --tools <list> --system-prompt <pack>/system-prompt.md --config <pack>/config.yml --approval-mode always-ask` with `HOME` set to a fresh temp directory, `SAI_ATLAS_LANG` from `--lang` (default `en`), `BASH_ENV` and `ENV` removed, and a 60 s ready timeout. The default `--tools` is the Linux list from Phase 6 "Spawn contract". It exits 1, naming every failed row, unless all of these hold:
>   1. `get_active_tools` names equal the `--tools` list exactly (sorted compare);
>   2. the `skill:<name>` entries of `get_available_commands` are exactly `sai-os-helpdesk`, `slides-from-report`, `spreadsheet-cleanup`, `word-report` (never `get_skills`, which re-runs discovery);
>   3. `get_state().systemPrompt` contains the trimmed text of `<pack>/system-prompt.md`, and the `<skill name="…">` entries in it are the same four names;
>   4. `get_agent_definitions` lists no agent whose `source` is the pack;
>   5. for every `config.yml` path known to `get_settings_schema` (walk nested maps to schema paths as the spike's `flattenToSchema` does), `get_settings` returns the pack's value and a `provenance.layers` array containing `"overlay"`; for the `record` path `tools.approval` every pack entry reads back; the list of `config.yml` paths the schema does not know is empty;
>   6. no `extension_error` frame and no `notice` frame mentioning the pack arrived before the checks ran.
>   It prints one row per tool, skill and setting (`path`, value, layers).
> - `compiled.test.ts`: `OMP_BIN` is `resources/omp.linux-x64` on Linux or `resources/omp` on macOS. When the binary is missing the suite fails with `sidecar binary missing: <path>` unless `SKIP_COMPILED=1` is set (CI sets it; worktrees link the binary in Task N.0). Cases:
>   1. `office_report` through `call-tool.mjs` as before (env `{ BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", HOME: <temp>, SAI_ATLAS_LANG: "en" }`; exit 0; not `isError`; a `.docx` under `<temp>/Documents/Sai ATLAS/`);
>   2. `office_clean` on an ExcelJS-built `.xlsx` → `(cleaned).xlsx` in the same folder;
>   3. `loads the pack into the sidecar`: `execFileSync("bun", ["scripts/check-assistant-pack.ts", OMP_BIN, <abs resources/assistant-pack>], { env: { ...process.env, HOME: <temp> } })` exits 0, and its stdout lists the eleven tools, the four skills and a `bash.direnv` row reading `off` with layers `overlay`;
>   4. `refuses a wrong tool list`: the same with `--tools read,glob,write,ask,find` exits 1 and the output names `find` (proves the check is not vacuous).
> - CI job `assistant-pack` (ubuntu-latest): checkout, setup Bun as the other jobs do, `bun install --frozen-lockfile`, `sudo apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress`, `bun run build:pack`, `SKIP_COMPILED=1 bunx vitest run assistant-pack scripts/build-assistant-pack.test.ts`, then `CI_VISUAL=1 bunx vitest run assistant-pack/test/visual.test.ts`. The existing `linux` job's `bunx vitest run` step gets `env: { SKIP_COMPILED: "1" }`. `visual.test.ts` (skipped unless `CI_VISUAL=1`) converts each fixture output with `soffice --headless --convert-to pdf` (exit 0, PDF non-empty) and the cleaned workbook with `--convert-to csv`, then checks the totals row equals the cached results.
> - Verify: `bunx vitest run assistant-pack` exits 0 locally with the four compiled cases listed as passed (not skipped); `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` exits 0; `grep -c 'SKIP_COMPILED' .github/workflows/ci.yml` prints at least `2`.

Measured baseline the port must reproduce: in `spike/results/loadcheck.v2b.json` every row reads `{"provenance":{"layers":["overlay"]},"match":true}` and `unknownKeys` is `[]`.

## Question 3: next risk, and the gate to add

**Risk to watch: Phase 2's type-error cascade reaching a file it may not edit.** The verified map says the cascade stays inside `src/renderer` minus `tools/**` (no cross-imports), but the plan's own rule for that case is STOP, and Phase 2 is the largest phase (eight surface rows, one `check:types` loop each). Two things keep it mechanical: the Keep-list additions in S1 (so the e2e-imported exports are never "cleaned up" while fixing an unused-import diagnostic), and Task 2.1's red-first inventory, which pins the end state before deletion starts. Second-order risk: `bun run build` runs `scripts/check-renderer-chunks.ts`, which only asserts that lazy vendor chunks stay unreachable from the entry (`:13-47`); deleting a chunk's only consumer makes it unreached, not failing, so no gate breaks there, but the orphaned vendor dependencies cannot be dropped by Phase 2 (`package.json` is Phase 4's) and should go on Phase 9's list.

**Gate to add: the wave gate in M5**, run on the integration worktree with the sidecar linked and the pack built, before `rebrand-wave-a` is tagged. Add one more row to it: `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` exits 0, so the tag certifies a loadable pack, not only green unit tests.

## What to avoid

- Do not make `compiled.test.ts` skip silently when the sidecar is missing; the red team chose a loud failure plus an explicit `SKIP_COMPILED=1` for CI. M3 and M4 keep that.
- Do not add `/// <reference types="bun" />` to get the build script into `check:types`; `bun-types` next to `lib: ["DOM"]` is a known source of duplicate-global diagnostics, and no script is type-checked today.
- Do not let Phase 4 import from `src/main/**` to avoid the inline tool list; the duplication is the contract check Phase 6 turns into a test.
- Do not reopen the inert `bash.*` block or the renderer keep list during Wave A; both are recorded decisions and the open question belongs to the user.

## Alternatives considered

- **Readback only, no load check** (the planner's framing): cheaper, but it would catch nothing the spike did not already prove, and leaves the "pack is loadable by omp" proof in Phase 6. Rejected.
- **Load check as a Phase 4 vitest-only client** under `assistant-pack/test/`: avoids touching `scripts/`, but then Phase 6 writes the same client again for `sync-upstream.sh`. The script-first shape serves both.
- **Making `compiled.test.ts` build its own pack into a temp dir** (through `scripts/build-assistant-pack.ts --out`): removes the `bun run build:pack` prerequisite from Phases 5–8's Task N.0. Reasonable, optional; M4 is the smaller edit.

## Work checklist (for the controller, before spawning Wave A)

1. Apply M1, M2, M3, S2, S3 and the Task 4.9 rewrite to `phase-04-assistant-pack.md`; update its Ownership line 31.
2. Apply M4 to `phase-05-locale-sweep.md` Task 5.0.
3. Apply M5 to `plan.md` and reference it from Tasks 2.10, 3.4 and 4.11.
4. Apply S1 to `phase-02-renderer-removals.md`.
5. Apply S4 and S5 to `phase-06-spawn-wiring.md`.
6. `ak plan validate plans/261005-0812-everyday-work-rebrand` exits 0.
7. Spawn Phases 2, 3 and 4 with their ownership lists verbatim; Phase 4's prompt carries the spike worktree path and the licensing rule.

## Success metrics

- The wave gate passes on the first run after the third merge (no STOP from a cross-ownership type error).
- `scripts/check-assistant-pack.ts` exits 0 on the integration branch and its negative case exits 1.
- CI stays green on `rebrand/everyday-work` after Phase 4 merges.
- Phase 5 Task 5.0's Verify passes without an ad-hoc fix.

## Assumptions

- Phase 2's prompt is executed on `7677ba1` or a descendant with no renderer changes; the line references were checked there (high confidence; a renderer commit on `main` before the worktree is created would need a re-check).
- `bunx vitest` runs under Node (`node_modules/vitest/vitest.mjs` shebang), so the `yaml` npm package, not `Bun.YAML`, is right for Task 4.7's test (high).
- The `bun` binary is available in every worktree for the compiled test's `execFileSync("bun", …)` (high; `bun run` is already the gate runner).
- The CI `assistant-pack` job's LibreOffice install (several hundred MB) is acceptable; if CI time matters, move `visual.test.ts` to a nightly or manual trigger (medium).
- The user still prefers the human SAI OS check to proceed asynchronously rather than block Phase 4 (medium; if the user wants the commands confirmed before any merge, keep 4.10 as a hard STOP and accept the wave waiting on it).
