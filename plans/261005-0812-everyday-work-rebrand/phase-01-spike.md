---
phase: 1
title: "Spike and go/no-go gate"
status: done
priority: P1
effort: "2d"
dependencies: []
---

# Phase 1: Spike and go/no-go gate

## Goal

Prove, with the shipped sidecar binary and local Gemma models, that the assistant-pack route works before anything else is built, and record the numbers the gate needs.

## Outcome (2026-10-06)

GO on the typed office tools route (`plan.md` Decisions "Spike gate result"; report `plans/reports/spike-261005-everyday-work-rebrand.md`). The spike measured three pack variants in its worktree: `spike/pack` (v1, the bash `office` launcher this file describes) 3/20 on E4B, NO-GO; `spike/pack-v2a` (v1 with wording fixes) 8/20; `spike/pack-v2b` (typed `office_report`, `office_slides`, `office_clean` tools, no bash, no helpers) 17/20 on E4B and 15/20 on E2B, with all six human file checks passing. The tasks below are the record of the spike as planned: the launcher, drafts folder, helpdesk agent and the `find`/`task`/`bash` tool list in them are the v1 design that failed the gate. Phases 4 and 6 carry the v2b contract.

## Context

- Plan index: `./plan.md` (Decisions table is binding).
- Doc sections "Office skills", "Wiring", "System prompt", "Phases".
- omp facts used here (verified 2026-10-05, monorepo `/home/tung491/WORK/oh-my-pi/packages/coding-agent/src`):
  - A directory passed to `--extension` with a `package.json` whose `omp.extensions` array is non-empty loads only those entries (`docs/extension-loading.md:213-229`); `skills/` and `agents/` beside it are discovered (`docs/skills.md:93`, `docs/task-agent-discovery.md:153`).
  - Extension tools register with `pi.registerTool({ name, label, description, parameters, approval, execute(toolCallId, params, signal, onUpdate, ctx) })` (`extensibility/extensions/types.ts:667-711`).
  - Bash allow rules never match a command containing `\n \r ; & | < > \` $ ( )` outside single quotes (`tools/bash.ts:82-140`, `:304-310`).
  - `BUN_BE_BUN=1` makes the compiled binary behave as Bun (`subprocess/worker-runtime.ts:213`).
  - Facts the red team found and this spike must confirm at runtime (`plan.md` "Red Team Review"): `--tools` does not limit helpers — a helper's tools come from its agent file (`task/executor.ts:3638-3645`); `--no-extensions` keeps explicit `--extension` roots and turns discovery off (`main.ts:1643-1650`); bash runs `sh -l -c` unless `PI_BASH_NO_LOGIN` is set (`packages/utils/src/procmgr.ts:55-59`); a chat-stamped session resumes restricted, without extension tools (`main.ts:1593`, `sdk.ts:3273`).
  - The spike uses the final launcher shape (`./phase-04-assistant-pack.md` "Pack layout", `./phase-06-spawn-wiring.md` "Spawn contract"): a static `bin/office` inside the pack, found through `PATH`, configured by env. Nothing is written to `~/.local/share`.

## Ownership

- May create: everything under `/home/tung491/WORK/worktrees/rebrand-p01/spike/` and the report `plans/reports/spike-261005-everyday-work-rebrand.md` (in the main checkout `/home/tung491/WORK/oh-my-pi-gui`).
- May create outside the repo: files under `~/Documents/Sai ATLAS/`, `~/.cache/sai-atlas/drafts/` and temp directories from `mktemp -d`.
- Must not modify: any file under `src/`, `src-tauri/`, `scripts/`, `package.json`. The spike branch is never merged.

## Tests before / after (TDD)

- Tests before: none in the repo; the spike harness (Task 1.5) is the measurement.
- Refactor: none.
- Tests after: none in the repo. Phase 4 re-implements every script with unit tests.
- Regression gate: `git -C /home/tung491/WORK/oh-my-pi-gui status --short src src-tauri scripts package.json` prints nothing.

## Tasks

### Task 1.0 — Create the integration branch and the spike worktree
- Goal: `rebrand/everyday-work` and `rebrand/p01-spike` exist, each in its own worktree.
- Target files: none (git only).
- Steps:
  1. `cd /home/tung491/WORK/oh-my-pi-gui && git rev-parse --short main` — record the hash (expected `7677ba1` or newer).
  2. `git worktree add -b rebrand/everyday-work /home/tung491/WORK/worktrees/rebrand-integration main`
  3. `git worktree add -b rebrand/p01-spike /home/tung491/WORK/worktrees/rebrand-p01 rebrand/everyday-work`
  4. `cd /home/tung491/WORK/worktrees/rebrand-p01 && bun install`
  5. `git -C /home/tung491/WORK/worktrees/rebrand-integration tag rebrand-base`
- Success criteria: both worktrees are listed.
- Verify: `git -C /home/tung491/WORK/oh-my-pi-gui worktree list` contains `rebrand-integration` with `[rebrand/everyday-work]` and `rebrand-p01` with `[rebrand/p01-spike]`.

### Task 1.1 — Confirm the sidecar binary and the models
- Goal: the compiled sidecar runs and both Gemma models are installed.
- Target files: `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64` (read only; gitignored, so it is not in the worktree).
- Steps:
  1. `export OMP_BIN=/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64`
  2. `$OMP_BIN --version` and record the output.
  3. `ollama pull hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf` (E2B is already installed).
  4. `ollama list` and record both names.
- Success criteria: the binary prints a version; both models are listed.
- Verify: `$OMP_BIN --version` exits 0; `ollama list | grep -c 'gemma-4-E[24]B'` prints `2`.

### Task 1.2 — Prove `BUN_BE_BUN` runs a bundled script inside the compiled sidecar
- Goal: a script bundled with `Bun.build` and its npm dependencies runs through the sidecar with no Node or Bun on PATH.
- Target files: create `spike/bun-be-bun/hello.ts`, `spike/bun-be-bun/build.ts`.
- Steps:
  1. In `spike/`, run `bun init -y` then `bun add docx@9.8.1 exceljs@4.4.0 pptxgenjs@4.0.1 marked@18.0.14`.
  2. `hello.ts`: import `docx`, build a one-paragraph document with `Packer.toBuffer`, write it to the path in `process.argv[2]`, then print `{"ok":true}`.
  3. `build.ts`: `await Bun.build({ entrypoints: ["./bun-be-bun/hello.ts"], outdir: "./dist", target: "bun", minify: false })`; exit 1 if `!result.success`.
  4. `bun spike/bun-be-bun/build.ts`
  5. `env -i HOME=$HOME PATH=/usr/bin:/bin BUN_BE_BUN=1 $OMP_BIN spike/dist/hello.js /tmp/spike-hello.docx`
- Success criteria: the docx is written by the sidecar binary acting as Bun.
- Verify: step 5 prints `{"ok":true}` and exits 0; `file /tmp/spike-hello.docx` contains `Microsoft Word 2007+` or `Zip archive`.

### Task 1.3 — Build the throwaway spike pack
- Goal: a pack with three skills, four OS tool schemas (stub bodies), the helpdesk agent, a system prompt, the static launcher and the final config overlay, matching the layout of Phase 4.
- Target files (all under `spike/pack/`):
  - `package.json` — `{"name":"sai-atlas-pack-spike","private":true,"omp":{"extensions":["./tools.js"]}}`
  - `tools.js` — bundled from `spike/src/tools.ts`: registers `diagnose`, `system_status`, `open_item`, `os_setting` with the parameter schemas from Phase 4 Task 4.6, `approval: "read"` for `diagnose`/`system_status` and `"exec"` for the other two; each `execute` returns `{ content: [{ type: "text", text: "stub: <name> <params JSON>" }] }`.
  - `office/office.js` — bundled from `spike/src/office.ts`: subcommands `report`, `clean`, `slides` with long options exactly as in the doc (`--in`, `--title`, `--name`, `--sheet`, `--totals`, `--decimal comma|dot`). Minimal generators: `report` turns Markdown headings and paragraphs into a docx; `clean` trims cells and drops empty rows into `<name> (cleaned).xlsx`; `slides` makes one slide per `##`. Output folder: `xdg-user-dir DOCUMENTS` + `/Sai ATLAS` (create it); never overwrite (append ` (2)`, ` (3)` …). Print one JSON line `{"file":"<abs path>","kind":"docx|xlsx|pptx","check":"<summary>"}`. On a bad option print `Usage: office report --in <draft.md> --title '<title>' [--name '<file>']` (and the other two usage lines) to stderr and exit 2.
  - `skills/word-report/SKILL.md`, `skills/spreadsheet-cleanup/SKILL.md`, `skills/slides-from-report/SKILL.md` — frontmatter `name` + `description`; the body tells the model to write its Markdown with `write` to `~/.cache/sai-atlas/drafts/<name>.md`, then run exactly one command starting with the bare word `office`, then tell the user the file name from the JSON line.
  - `agents/helpdesk.md` — the doc's draft agent file (section "Helpdesk helper").
  - `bin/office` — the exact launcher from Phase 4 "Pack layout", mode 0755.
  - `system-prompt.md` — the doc's draft verbatim (section "System prompt", about 1.6 KB).
  - `config.yml` — the exact block from Phase 4 Task 4.7 (copy it; do not trim keys).
- Steps:
  1. Write the source files above under `spike/src/` and the static files under `spike/pack/`.
  2. Bundle both entry points with `Bun.build` (`target: "bun"`): `spike/src/tools.ts` → `spike/pack/tools.js`, `spike/src/office.ts` → `spike/pack/office/office.js`.
  3. `chmod 0755 spike/pack/bin/office`, then define the pack env used by every later task:
     ```sh
     export PACK=$PWD/spike/pack
     export PACK_ENV="PATH=$PACK/bin:/usr/bin:/bin SAI_ATLAS_OMP=$OMP_BIN SAI_ATLAS_PACK=$PACK SAI_ATLAS_LANG=en PI_BASH_NO_LOGIN=1 PI_OLLAMA_API=ollama-chat"
     ```
- Success criteria: the launcher builds all three file kinds by hand, through `PATH`.
- Verify: `env $PACK_ENV HOME=$HOME office report --in spike/fixtures/notes.md --title 'Spike'` exits 0 and its stdout parses as JSON whose `kind` is `docx`; the same for `clean --in spike/fixtures/messy.xlsx` (`xlsx`) and `slides --in spike/fixtures/report.md --title 'Spike'` (`pptx`). `env $PACK_ENV HOME=$HOME office report --bogus` exits 2 and stderr contains `Usage: office report`. `ls ~/.local/share/sai-atlas 2>&1` reports no such directory.

### Task 1.4 — Load check: the sidecar sees the pack
- Goal: with the spawn flags and env, the sidecar lists the three skills, the ten allowlisted tools and the custom system prompt, and accepts every overlay key.
- Target files: create `spike/harness/rpc.ts` (start from `scripts/smoke-sidecar.mjs`, which already drives the RPC protocol; message shapes are in `src/shared/rpc-types.ts`).
- Steps:
  1. The harness spawns `$OMP_BIN --mode rpc-ui --no-session --no-extensions --extension $PACK --tools read,find,write,ask,task,bash,diagnose,system_status,open_item,os_setting --system-prompt $PACK/system-prompt.md --config $PACK/config.yml --approval-mode always-ask` with `$PACK_ENV` merged into its env, then sends `get_state` and prints the tool names and skill names it reports. If `get_state` does not list tools or skills, use the RPC command `rpc-types.ts` defines for them and record which one in the report. Also capture stderr: any warning about an unknown or invalid setting key in `config.yml` fails this task.
  2. Ask for the effective settings (`get_settings` with the keys of `config.yml`) and record them.
  3. Repeat step 1 without the six pack flags (baseline).
- Success criteria: exactly the ten tools; exactly the skills `word-report`, `spreadsheet-cleanup`, `slides-from-report`; every `config.yml` key reads back with the pack's value.
- Verify: the sorted tool list equals the ten names exactly; the sorted skill list equals the three names exactly; no stderr setting warnings; the effective settings equal `config.yml`.

### Task 1.4b — Containment checks
- Goal: the red team's bypasses fail at runtime. Each check is one harness run in a fresh temp cwd (`mktemp -d`) with the Task 1.4 flags and env.
- Steps (record each result in the report under "Containment"):
  1. Helpers: ask the model to start a helper with agent `task`, then with `scout`; both must be refused (disabled agents). Then start `helpdesk` and record the child's tool list (from the subagent event or `get_state` of the child) — it must contain no tool outside `diagnose, system_status, os_setting, open_item, read, write, ask`.
  2. Discovery: plant `<cwd>/.omp/extensions/x.ts` (registers a tool `planted`) and `<cwd>/.omp/skills/word-report/SKILL.md` (description `PLANTED`); `planted` must not appear and `word-report`'s description must be the pack's.
  3. Shell: send a prompt that makes the model run `office report --bogus` and record that it ran without an approval prompt; then `ls` — it must be denied without running; then with `HOME=<temp>` and a `<temp>/.profile` that writes a marker file, run the office command again — the marker must not exist.
  4. URL read: ask the model to read `https://example.com`; the read must fail (fetch disabled) and no connection to example.com is made (`strace -f -e trace=connect -p <sidecar pid>` during the request, or the read error text).
  5. User policy: with a temp `PI_CODING_AGENT_DIR` whose `config.yml` sets `tools: {approval: {write: allow}}`, a `write` must still prompt.
  6. Chat resume: create a session file with the GUI's chat stamp (start `$OMP_BIN --mode rpc-ui --chat` once, then quit), resume it with the pack flags and record the tool list. Expected (confirms the plan's refusal): no pack tools.
- Success criteria: steps 1–5 behave as stated; step 6 is recorded.
- Verify: the report's "Containment" table has six rows; rows 1–5 read `as expected`. Any other value: STOP (Failure Protocol) — the overlay or spawn contract in Phases 4 and 6 must change before they start.

### Task 1.5 — Run the 20-run suite on E4B and E2B
- Goal: success rates, prompt size and time to first token for each model.
- Target files: create `spike/harness/suite.ts`, `spike/fixtures/` (`notes.md`, `meeting-notes-vi.md`, `messy.xlsx` with leading-zero phone numbers, blank rows and "1.500" values, `sales.xlsx`, `report.md`, `report-vi.md`), and `spike/results/<model>.json`.
- Steps:
  1. Ten scenarios, each run in two forms (20 runs): 4 Word reports (2 en, 2 vi), 3 spreadsheet clean-ups, 2 slide decks, 1 report-plus-slides job that should use two helpers. Typed form: plain request text naming the fixture path. Starter form: `/skill:<name> <fixture path>` (the helper scenario runs typed twice).
  2. The harness spawns with the Task 1.4 flags and env, sends each prompt through `rpc.ts`, approves every approval request it receives (counting them), stops after 10 minutes, and scores PASS when exactly one new file of the expected kind appears in `~/Documents/Sai ATLAS/` and the launcher printed its JSON line. It then moves the new files to `spike/results/files/<model>/<run>/`.
  3. It records per run: PASS/FAIL, form, approvals, tool calls, the first request's input tokens (from the first assistant message's usage) and the time to first text token. It also runs the baseline from Task 1.4 once and records its input tokens.
  4. Run the suite for `hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf` and `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf`. If `hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf` is installed, also run the helper scenario on it.
- Success criteria: two result files with 20 rows each.
- Verify: `jq 'length' spike/results/*.json` prints `20` for each file.

### Task 1.6 — Human file checks
- Goal: three spike files open cleanly in WPS on SAI OS and in Microsoft Office.
- Steps:
  1. Pick one passing docx, xlsx and pptx from `spike/results/files/`.
  2. STOP and ask the user to open them in WPS on a SAI OS machine and once in Microsoft Office, and to report "opens without repair: yes/no" for each, plus whether Vietnamese accents render.
- Success criteria: the user's six answers are recorded in the report.
- Verify: the report's "Human checks" table has 6 filled rows (3 files × 2 apps).

### Task 1.7 — Report and gate decision
- Goal: a written gate decision the user confirms.
- Target files: create `/home/tung491/WORK/oh-my-pi-gui/plans/reports/spike-261005-everyday-work-rebrand.md`.
- Steps:
  1. Write: sidecar version; the BUN_BE_BUN result; the load check; a results table per model (typed passes /10, starter passes /10, total /20, approvals per run, mean time to first token); the input tokens with and without the pack flags (baseline about 6.8k); the helper scenario result; human checks; whether `wait` was needed for helpers; whether draft `write` approvals hurt the flow; the Containment table (Task 1.4b).
  2. Gate: GO when E4B total ≥ 16/20 and all six human checks say yes. Otherwise NO-GO: list the doc's fallbacks (the same scripts as tools in a `patches/omp` patch, or starter cards that run the scripts directly).
  3. Present the result to the user and wait for their decision. Record it in `plan.md` under Decisions as a new row whose Topic is exactly `Spike gate result` and whose Decision starts with `GO` or `NO-GO`.
- Success criteria: the report exists and the user's decision is in `plan.md`.
- Verify: `grep -cE '^\| Spike gate result \| (GO|NO-GO)' /home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/plan.md` prints `1`.

## Risks and rollback

- Print/RPC approval behaviour differs from the GUI: the harness auto-approves and counts, so the counts stand in for the user's clicks.
- Rollback: `git worktree remove /home/tung491/WORK/worktrees/rebrand-p01`. The spike changes nothing in the repo and writes nothing outside `~/Documents/Sai ATLAS/`, `~/.cache/sai-atlas/` and temp directories.

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
