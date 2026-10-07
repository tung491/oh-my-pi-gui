# Kongming counsel — Phase 1 Task 1.4 load-check failure

Plan: `plans/261005-0812-everyday-work-rebrand/` — Phase 1 (`phase-01-spike.md`) Task 1.4.
Worktree: `/home/tung491/WORK/worktrees/rebrand-p01` (branch `rebrand/p01-spike`).
Source verified against `/home/tung491/WORK/oh-my-pi/packages/coding-agent/src` at version 18.4.8, the same version as `resources/omp.linux-x64` (`omp/18.4.8`), so every citation below applies to the compiled sidecar.

## TL;DR

Replace `find` with `glob`, set `bash.direnv: off`, keep `loadMode: "essential"`, accept `yield` in the helper allowlist, then re-run the load check. The bigger finding, not in the questions: helpers run with `hasUI: false`, so every `prompt`-policy tool (`write`, `os_setting`, `open_item`) throws inside a helper and `ask` is not registered there at all. The drafted helpdesk agent cannot work as a helper, and office helpers cannot write drafts. Recommended shape: helpers become read-only diagnosers with `blocking: true`, office jobs run sequentially in the main session, and these go to the gate as plan deltas. The draft-write policy (`prompt` vs `allow`) is a user fork; recommend keeping `prompt`.

## Reframed problem

The load check is one failed CLI validation (`find`), but the real decision is which parts of the Phase 4 pack and the Phase 6 spawn contract were written against an omp that no longer exists (18.4.8 renamed the file finder, made `find` semantic, and runs helpers headless). The spike exists to find exactly this, so the fixes below are legitimate spike work; the contract changes they imply must be recorded as deltas for the gate, not applied silently.

## Answers

### A. `find` → `glob` (not `find.enabled: on`)

- `find` in 18.4.8 is "Semantic grep: find files and line ranges by describing what they do" (`tools/jfind/index.ts:53-58`). It is enabled only when `find.enabled` is `on`, or `auto` resolves to a native judge model (`tools/jfind/index.ts:46-50`; setting at `tools/settings.ts:501-521`). Turning it on would run a judge-model pass through local Gemma per search — wrong tool, expensive.
- `glob` is the by-pattern file finder: `name = "glob"`, `approval = "read"`, `loadMode = "essential"` (`tools/glob.ts:87-89`). It covers what the plan wants `find` for (locating the user's files by name).
- The startup error comes from `validateToolNames` (`cli/args.ts:370-391`): a `--tools` name in the built-in catalog but absent from the registry is a `CliUsageError`, so `find` cannot be listed "just in case". Extension tool names are validated against the final registry, which is why the four pack tools pass (same function; "custom_tool" case in `test/flag-tables.test.ts:100-108`).

### B. `direnv: off`; nothing else coerces

- `bash.direnv` is an enum `auto | off`, default `auto` (`exec/settings.ts:153-157`). A configured value that does not fit the type is replaced by the default with `logger.warn("Settings: ignoring invalid value, using the default", …)` (`config/registry.ts:651-662`) — a log-file warning, never stderr. The plan's "no stderr setting warnings" condition therefore cannot catch coercion; the harness's `get_settings` provenance readback is the real check and should become the pass condition (every key: value equal and `provenance === "overlay"`).
- Other keys, verified: `bash.allowCompoundCommands` boolean (`exec/settings.ts:95-97`); `fetch.enabled` boolean (`tools/settings.ts:670-672`); `skills.enablePiUser/PiProject/AgentsUser/AgentsProject/ClaudeUser/ClaudeProject/CodexUser` all booleans (`extensibility/settings.ts:29-70`); `task.disabledAgents` string array (`task/settings.ts:372-376`); bundled agent names are exactly `scout`, `reviewer`, `security-reviewer`, `task`, `sonic` (`task/agents.ts:44-66`), so the pack's list is complete; `tools.approval` is an untyped record (`tools/settings.ts:275-278`), so `ast_edit`, `browser`, `web_search`, `github` keys are accepted whether or not those tools load.
- Disabling the `task` agent also blocks a `task` call that omits `agent` (default agent is `task`, `task/spawn-policy.ts:2`; disabled agents are filtered at `task/index.ts:162`).

### C. `yield` is harmless; check 1 should accept it

- Hidden tool (`tools/builtin-names.ts:36`), read tier (`tools/yield.ts:290-292`), in `READ_ONLY_TOOL_NAMES` (`task/read-only-policy.ts:15`). It is the only way a child run terminates, so it is force-added to any explicit child tool list (`sdk.ts:3876-3882`; `tools/index.ts:803-805`).
- Rule for check 1: allowed = agent file `tools` ∪ `{yield}`; if the agent file lists `bash` or `task`, also ∪ `{wait}` (`task/executor.ts:3661-3668`, skipped only for restricted sessions). Helpdesk has neither, so `yield` is the only addition.

### D. Helpers are headless — redesign them before scoring the helper scenario

Verified chain:
- Children are created with `hasUI: false` (`task/executor.ts:4071`) and `tools.approvalMode: yolo`, with user `tools.approval` policies still applied (`task/executor.ts:1097-1100`).
- A `prompt` policy with no UI throws `Tool "<name>" requires approval but no interactive UI available` (`extensibility/extensions/wrapper.ts:374-389`).
- `ask` is not created when the session has no UI (`tools/ask.ts:581`).
- Helpers inherit the overlay live (`docs/config-usage.md:171-173`), so `bash` in a helper is still bound by `office *` allow / `*` deny, and read-tier tools auto-allow under the child's yolo mode.

Consequences under the pack's `write: prompt`, `os_setting: prompt`, `open_item: prompt`:
- The helpdesk helper fails at its own steps 4 and 6 (`os_setting`/`open_item`, support-note `write`) and never asks its step-1 question. Containment check 1 would still "pass" (tool list is right) while the agent is unusable.
- An `office-helper` with `read, write, bash` fails on the draft `write`. Finding 5 is therefore moot: office helpers are impossible without changing the write policy.

Minimal plan-consistent shape:
1. `agents/helpdesk.md`: `tools: diagnose, system_status, read`; add `blocking: true` (`docs/task-agent-discovery.md:45`; the parent waits inline, `task/index.ts:762-770`). The helper diagnoses and returns findings plus allowed fixes; the main session offers one fix at a time with `os_setting`/`open_item` under real approvals.
2. Office: no helpers. Scenario 10 becomes "report and slides in one session, two skills, two `office` commands, expect `[docx, pptx]`, both announced". Drop "two helpers" from the typed prompt and the system-prompt bullet "give each part to a helper … at most two at a time". `task.maxConcurrency: 2` may stay.
3. Record "`wait` not needed" (blocking helper) for Phase 6's `,wait` clause. Without `blocking`, `async.enabled` (rpc protocol default `true`, `tools/settings.ts:864-867`) runs helpers detached (`task/index.ts:768-770`) and the main session has no `wait` in its `--tools` list.
4. The only way to keep office helpers is `tools.approval.write: allow`, which reverses the evidence-based "draft writes stay approval-gated" decision (plan.md, Validation Session 1). That is the user's call; present it at the gate, recommend keeping `prompt`.

### E. `loadMode: "essential"` — keep it; `tools.xdev: false` is unnecessary

- Anything named in `--tools` (or in an agent file's explicit list) is exempt from xd:// mounting: `!explicitlyRequested` at `sdk.ts:3996`; `createTools` mounts built-ins only when no list was given (`tools/index.ts:905-911`). So an extension tool listed in `--tools` stays top-level regardless of `loadMode`; the delegate's observation applies only to an unlisted extension tool.
- `essential` is the documented extension-side knob (`extensibility/extensions/types.ts:681`; default resolution `tools/essential-tools.ts:45-48`). Zero cost, protects a future spawn path that computes the list differently. Add it to Phase 4 Task 4.6's `registerTool` contract. Do not add `tools.xdev: false` to the overlay: it fixes nothing and widens the pinned-key surface.

### F. Classification, concrete edits, re-run order

#### Spike-local edits (apply now, then re-run Verify)

| # | File | Change |
|---|---|---|
| 1 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/rpc.ts:33` | `PACK_TOOLS`: `"find"` → `"glob"` (edit the constant, not `SPIKE_PACK_TOOLS`, so results record the list without the override failure marker) |
| 2 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/pack/config.yml` | `direnv: false` → `direnv: off` |
| 3 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/loadcheck.ts` | Setting failure = value mismatch or `provenance !== "overlay"`; keep stderr capture as informational |
| 4 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/containment.ts:45` | `HELPDESK_ALLOWED` = the agent file's `tools` + `"yield"` (derive from `get_agent_definitions` rather than a literal) |
| 5 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/pack/agents/helpdesk.md` | frontmatter `tools: diagnose, system_status, read`, add `blocking: true`; body: report findings and the fixes allowed for the area; the assistant applies fixes with the user's approval; no `ask`, no `write` |
| 6 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/pack/system-prompt.md` | "Computer problems: have the helpdesk helper diagnose, then offer one fix at a time, which the person approves."; delete the "separate parts … two helpers" bullet |
| 7 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/suite.ts:128-132` | Scenario 10 typed prompt without "two helpers" (e.g. "From the report in {path}, make a Word report and a slide deck."); keep typed-twice form and `expect: [docx, pptx]` |

Optional probe (recommended, one run): before edit 5, run containment check 1 once with the old helpdesk file and an assignment that forces a `write`; record the thrown error text in the report as the evidence for the helper redesign.

#### Re-run order

1. Edits 1 and 2.
2. `bun spike/harness/loadcheck.ts` — expected PASS: ten tools (`ask, bash, diagnose, glob, open_item, os_setting, read, system_status, task, write`), skills `slides-from-report, spreadsheet-cleanup, word-report`, every overlay key equal with provenance `overlay`, `bash.direnv` = `off`.
3. Edits 3–7 (and the optional probe before 5).
4. `bun spike/harness/loadcheck.ts` again — confirms `get_agent_definitions` shows the new helpdesk tools (`diagnose, system_status, read, yield`).
5. Containment (Task 1.4b), then the suite (Task 1.5).

#### Plan deltas (record in the spike report and `plan.md` Decisions; user confirms at the gate)

- Phase 6 "Spawn contract" and Phase 1 Task 1.4: `<TOOLS>` uses `glob` instead of `find` on both platforms (Linux `read,glob,write,ask,task,bash,diagnose,system_status,open_item,os_setting`; macOS `read,glob,write,ask,task,bash`).
- Phase 1 Task 1.4 and Phase 6 Task 6.6: "no stderr setting warnings" becomes "every overlay key reads back with its value and provenance `overlay`".
- Phase 4 Task 4.7: `bash.direnv: off`; helpdesk agent `tools: diagnose, system_status, read` + `blocking: true`; system-prompt helper wording; `pack-files.test.ts` assertions updated to match. Task 4.6: `loadMode: "essential"` on all four tools.
- Phase 1 Task 1.4b check 1: allowlist includes `yield` (and `wait` for any agent with `bash`/`task`). Task 1.5/1.7: scenario 10 re-scored as a sequential two-file job; "`wait` needed" = no.
- Decision fork for the user: draft writes stay `prompt` (recommended; office helpers are then impossible, helpers are diagnose-only) vs `allow` (office helpers possible, every `write` unprompted in main session and helpers alike).

## What to avoid

- `find.enabled: on` to keep the name: wrong tool, judge-model cost per call on a 16k-context local model.
- `SPIKE_PACK_TOOLS` for the real run: the harness marks it as a failure by design.
- `tools.xdev: false` in the overlay: solves nothing (E), widens the pinned-key surface.
- Giving helpers `write` or `ask` under the current overlay: silently non-functional, not caught by the tool-list check.
- Trusting stderr for setting coercion: it goes to the log file.

## Success metrics

- Load check PASS with the ten names (`glob`), three skills, all keys `overlay`.
- Containment check 1: helpdesk child tool list ⊆ `{diagnose, system_status, read, yield}`; `task` and `scout` refused.
- Suite scenario 10 produces both files in one session with no helper error text.
- Report records `wait` not needed, and the helper-redesign evidence (error text or the cited lines).

## Assumptions

- `mcp.enableProjectConfig` and `shellPath` ids are as the plan cites; not re-read (high confidence; the delegate reported both reading back correctly).
- A child's thrown approval error surfaces as a failed task result, not a sidecar crash (medium; the optional probe settles it).
- Multiple `blocking: true` spawns in one `task` call still run concurrently under `task.maxConcurrency` (medium; irrelevant once office helpers are dropped).
- No RPC-mode path re-attaches the parent's UI to a child (medium-high: `hasUI: false` is hard-coded at spawn, and the wrapper checks `runner.hasUI()`).

## Follow-up: helpers cannot start

### 1. Cause — the model filled the task tool's `tools` field, which is for eval-kernel tools

omp does not propagate the parent's `--tools` list to children. The list in the error is the one the **model** wrote into the task call: `spike/results/containment.json` rows[0] shows both helpdesk calls carrying `"tools": ["bash","read","glob","write","ask","task","diagnose","system_status","open_item","os_setting"]` (Gemma E4B echoing its own tool names; the harness assignment "write the exact names of every tool you have" invited it).

On the task tool, `tools` means something else entirely:
- The schema field exists only when `eval.tools.enabled` is true: `const toolsField = options.evalToolsEnabled ? { "tools?": "string[]" } : {}` (`task/index.ts:131`, applied at `:142,:160,:178,:191`); the prompt line is `{{#if evalToolsEnabled}}\`tools\`: eval-defined, run in your kernel.` (`prompts/tools/task.md:15`).
- `eval.tools.enabled` is a boolean, default `true`: "Let eval cells define tools (@tool in Python, tool(fn) in JS) that task, agent(), and workpool() subagents can call" (`eval/settings.ts:46-56`).
- At spawn, a non-empty `params.tools` is resolved against the Python/JS eval kernels (`task/index.ts:1614-1620` → `describeEvalTools`, `task/eval-tools.ts:85-110`). No kernel is running, so every name is "missing" and the spawn fails with `Unknown eval tool(s): … Available: none` (`task/eval-tools.ts:102-104`) before any agent file, approval or UI logic runs.

So this is neither an `--extension`/`--tools` interaction nor an omp bug: it is an advertised field that a small model misreads as "the tools my helper gets", and with the pack's `eval: deny` the field can never be satisfied anyway.

Second friction in the same row: `Missing \`context\`` comes from the batch shape (`task.batch`, rpc protocol default `true`, `task/settings.ts:196-208`; check at `task/index.ts:264-265`). The model recovered on the second try, but it is one more schema the model must get right.

### 2. Is there a knob? Yes, two settings; no patch needed

- `eval.tools.enabled: false` in `config.yml` removes the `tools` field from the task schema and the prompt line, so the model cannot send it (a stray `tools` would then hit the schema, not the kernel lookup).
- `task.batch: false` restores the flat single-spawn shape (`task/settings.ts:208`: "Disable to restore the flat single-spawn schema"), removing the required `context`.

Both are plain boolean settings read through the overlay, so they would join Phase 4 Task 4.7's pinned keys if helpers stay. Agent frontmatter has no field that affects either (`task/types.ts:230-245` lists `tools, spawns, model, thinkingLevel, output, blocking, …`), and `--no-extensions` is unrelated (the helpdesk agent was discovered: "Available: helpdesk").

### 3. Recommendation — helpers out of v1

Three facts now stack against helpers in this product: children run headless (`task/executor.ts:4071`), so `ask` disappears and every `prompt` tool throws; the task schema is a trap for a 16k-context local model (eval `tools`, batch `context`); and the spawn surface is the one place Phase 6 could not fully close ("helper agents written into the project or user `.omp/agents` still load", Phase 6 Security considerations; discovery precedence in `docs/task-agent-discovery.md`). The only thing a compliant helper could still do — call read-tier `diagnose`/`system_status` and return text — the main session can do directly.

**Option A (recommended): drop `task` from `--tools`; helpdesk is a skill in the main session.**
- Main session keeps `diagnose, system_status, os_setting, open_item` with real approvals, which is what the drafted helpdesk flow needs (ask one question, diagnose, one fix at a time, the user approves). The `skills/sai-os-helpdesk/SKILL.md` that Phase 4 already ships becomes the helpdesk flow; `agents/helpdesk.md` is deleted.
- Containment: the task tool is not registered at all, so there is no spawn, no agent discovery that matters, no child session, no eval-tool bridge. The Phase 6 residual risk about planted `.omp/agents` files becomes moot. Check 1 becomes mechanical: `task` absent from `get_active_tools`, and a prompt asking for a helper produces no `task` call (or an unknown-tool error).
- Context budget: the task tool description (agent list, batch contract, async advisory) leaves every request — relevant with `contextWindow: 16384` and `systemToolsTokens: 3748` in the baseline.
- Contracts that change (record as plan deltas for the gate):
  - Phase 6 "Spawn contract": `<TOOLS>` Linux `read,glob,write,ask,bash,diagnose,system_status,open_item,os_setting`; macOS `read,glob,write,ask,bash`; delete the `,wait` clause. `ASSISTANT_PACK_FILES` drops `agents/helpdesk.md` (ten paths). Delete the Security-considerations paragraph about helper agents.
  - Phase 4: Pack layout and Task 4.7 drop `agents/helpdesk.md` and the "start helpers only with agent helpdesk" assertions; the helpdesk flow moves into `skills/sai-os-helpdesk/SKILL.md` (the doc's "Helpdesk helper" steps, rewritten as skill steps for the main session); `system-prompt.md` loses both helper bullets ("hand them to the helpdesk helper", "give each part to a helper"). `config.yml`: `task.maxConcurrency`, `task.disabledAgents` and `tools.approval.task` become dead keys — keep `task.disabledAgents` as belt-and-braces (a launch profile cannot re-add `task`, but it costs nothing), drop `task.maxConcurrency` and `tools.approval.task`, or keep all three verbatim and note they are inert; either is fine, say which. Task 4.8 build test file list: ten paths.
  - Phase 1: Task 1.4 tool list (nine Linux names); Task 1.4b check 1 → "task tool absent; a helper request yields no `task` call"; Task 1.5 scenario 10 → sequential two-file job in one session, `expect [docx, pptx]`; Task 1.7 "whether `wait` was needed" → not applicable.
  - `plan.md`: Decisions row "CoordinationRenderer … TaskRenderer also stays (multi-agent stays)" — TaskRenderer can now go with Phase 3 (or stay inert); outcome bullet "helpers get no tool outside their agent file" → "no helper sessions: the `task` tool is not loaded"; Red Team finding 3 disposition updated to "closed by removing the tool".
  - Phase 8 (Linux-only helpdesk UX): unchanged in intent; its starter card invokes `/skill:sai-os-helpdesk` instead of relying on a helper.

**Option B: diagnose-only blocking helper.** Keep `task`; add to `config.yml` `eval: { tools: { enabled: false } }` and `task: { batch: false }`; `agents/helpdesk.md` → `tools: diagnose, system_status, read`, `blocking: true`. Works in principle, but buys nothing the main session cannot do, keeps the spawn surface and the agent-discovery residual risk, keeps the task schema in every request, and adds two more pinned keys. Choose it only if the user wants a visible "helper" in the UI for product reasons.

**Option C: a `patches/omp` patch.** Nothing to patch: the behaviour is a documented feature misused by the model, and the two settings above already turn it off. Rejected.

### Spike-local edits for Option A, then re-run

| # | File | Change |
|---|---|---|
| 8 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/rpc.ts:31-41` | `PACK_TOOLS`: remove `"task"` |
| 9 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/pack/system-prompt.md` | delete the two helper bullets; add "Computer problems: open the sai-os-helpdesk skill and follow it." |
| 10 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/pack/skills/sai-os-helpdesk/SKILL.md` (new) | frontmatter `name: sai-os-helpdesk`, one-line description; body = the drafted helpdesk steps 1–6 addressed to the main session (ask one question, `diagnose`, one fix via `os_setting`/`open_item`, re-diagnose, stop and write a support note with `write`) |
| 11 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/pack/agents/helpdesk.md` | delete (and the `agents/` directory) |
| 12 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/loadcheck.ts` | expected tools = nine; expected skills = four (add `sai-os-helpdesk`); agents list expected to contain no `helpdesk` |
| 13 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/containment.ts` (check 1) | pass = `task` not in `get_active_tools` and the helper request produced no `task` tool call; keep the row text "helpers: task tool not loaded" |
| 14 | `/home/tung491/WORK/worktrees/rebrand-p01/spike/harness/suite.ts:128-132` | scenario 10 as in edit 7 (sequential, `expect [docx, pptx]`) |

Edits 4–7 from the first counsel are superseded by 8–14 (edit 4's `yield` rule only matters if Option B is chosen). Keep `task.disabledAgents` in the spike `config.yml` unchanged for this run so the overlay readback stays identical to the plan's block except `direnv`; note the inert keys in the report.

Re-run order: edits 8–14 → `bun spike/harness/loadcheck.ts` (nine tools, four skills, all keys `overlay`) → `bun spike/harness/containment.ts` (check 1 under the new rule, checks 2–6 unchanged) → the suite.

### Evidence to put in the report

- The two task calls with the model-authored `tools` array (containment.json rows[0]).
- `task/index.ts:131`, `prompts/tools/task.md:15`, `eval/settings.ts:46-56`, `task/eval-tools.ts:102-104` for the field's meaning; `task/executor.ts:4071`, `extensibility/extensions/wrapper.ts:374-389`, `tools/ask.ts:581` for headless helpers.
- The gate decision to record: "Helpers removed from v1: `task` not loaded; helpdesk is a main-session skill" (user confirms), with Option B as the documented alternative.
