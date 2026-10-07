# Kongming counsel — Phase 1 Task 1.5/1.7: E4B suite result 4/20

Plan: `plans/261005-0812-everyday-work-rebrand/` — Phase 1 (`phase-01-spike.md`) Tasks 1.5 and 1.7.
Worktree: `/home/tung491/WORK/worktrees/rebrand-p01` (branch `rebrand/p01-spike`).
Source verified against `/home/tung491/WORK/oh-my-pi/packages/coding-agent/src` and `packages/ai/src` (18.4.8, same as `resources/omp.linux-x64`), the run records in `spike/results/`, the pack in `spike/pack/`, and `ollama show` on the host (Ollama 0.35.0).
Earlier counsel: `plans/reports/kongming-261005-1930-spike-load-check-counsel.md`.

## TL;DR

The v1 design (skills that compose a bash `office` command) is a NO-GO at the 16/20 bar, and the honest v1 numbers are lower than reported: E4B 3/20 and E2B 4/20, because one starter pass per model came from a draft left behind by an earlier run (the launcher deletes its input, the drafts folder is shared). The failures are not a wording gap: the typed form never reaches the skill body because the pack never tells the model the only way omp exposes a skill (`read` of `skill://<name>`), and the starter form fails on command composition (literal example path copied, command printed as the reply). Next step: fix the two harness bugs, then run one transparently reported v2 round whose main variant replaces the bash launcher with three typed extension tools in `tools.js` (`office_report`, `office_slides`, `office_clean`, markdown passed as a parameter, no `bash` in `--tools`) and keeps the v1 pack with minimal text fixes as a control. Score v2 against the same 20 runs and the same 16/20 bar; record the v1 numbers as the gate result for the v1 design.

## Reframed problem

The question is not "how do we get E4B to 16/20" but "which office route a 4B local model can execute reliably, and whether the gate should be re-run against that route". The plan's `Office route` decision (bash launcher) was a user decision taken before any measurement; the spike exists to test it. The doc's own fallbacks name the two alternatives (scripts as tools; starter cards running scripts directly). Choosing between them is the gate decision the user must make; this counsel gives the evidence and a recommended default.

Requirements that stay fixed: offline, bundled sidecar, Gemma E4B/E2B through Ollama, files written only to Documents > Sai ATLAS, approvals for anything that writes, en and vi, no omp source patch unless unavoidable, Phase 1 does not touch `src/`.

## A. How skills reach the model in omp 18.4.8

Verified:

- There is no skill tool. With `--system-prompt`, omp renders `prompts/system/custom-system-prompt.md`: the pack prompt, then `Skills are specialized knowledge. Scan descriptions for your task domain. If a skill applies, you MUST read \`skill://<name>\` before proceeding.` and a `<skills>` list of `name` + `description` only. The body enters context only when the model calls `read` with path `skill://<name>` (`system-prompt.ts:919-938` lists skills only when an active tool declares `readsSkillUris`; `read` does). The `read` tool prompt (`prompts/tools/read.md`) never mentions `skill://`.
- The pack prompt says "open the matching skill (word-report, …)" without saying how. Both models tried to "open" it with a bare name: E4B `read {"path":"spreadsheet-cleanup"}` (twice, clean-en-messy-typed), E4B `write {"path":"word-report(file=…)"}` (word-vi-meeting-typed), E2B `write {"path":"spreadsheet-cleanup"}`, `write {"path":"slides-from-report"}`, `write {"path":"word-report"}` (clean-vi-messy-typed, slides-en-review-typed, report-and-slides-typed-1). So the typed form fails at skill discovery: a prompt mismatch, fixable by naming the literal path.
- Starter form: `/skill:<name> <args>` is handled by `modes/skill-command.ts` → `buildSkillPromptMessage` (`extensibility/skills.ts:671-703`) → template `prompts/skills/user-invocation.md`. The whole skill body is inlined as a user-attributed message (that is why first-request input rises from ~60 to ~420-1,400 tokens), framed as `[IMPORTANT: User invoked the "<name>" skill; follow its instructions. Full skill below.]`, followed by `[Skill directory: <baseDir>] Resolve relative paths … run scripts with the terminal tool when skill instructions call for it.` and, last, `User: <args>`. Two consequences: the person's path appears once, at the very end, labelled only `User:`, after the body's literal example (`'~/Documents/sales.xlsx'`, `'~/.cache/sai-atlas/drafts/q3.md'`), which a 4B model copies (clean-en-sales-starter and clean-vi-messy-starter on E4B, clean-en-sales-starter on E2B; every passing word/slides run used the example title `Q3 report`/`Q3 review`); and the footer names a "terminal tool" that does not exist in this session.
- Verdict on typed 0/9: the discovery step is a prompt problem, but once the skill is read the model is in the starter position, which E4B fails 6/9 for composition reasons. Typed cannot exceed starter in expectation under this design.

## B. Is a v2 round legitimate, and what moves E4B

Legitimate if: (1) the v1 numbers stay the recorded gate result for the v1 design; (2) every change corrects a mismatch between the pack text and omp's actual mechanics, a harness bug, or switches to one of the doc's named fallbacks; (3) scenarios, prompts and the PASS rule stay identical or get stricter. Overfitting would be: fixture-specific hints, per-scenario tuning, re-running until a pass, or changing the bar.

Minimal text set for the v1 design (run it as the control, "v2a"):

1. `system-prompt.md`: replace "open the matching skill … It names the one command to run" with: `To open a skill, call the read tool with the path skill://word-report, skill://spreadsheet-cleanup or skill://slides-from-report, then follow it.` Delete "Do not show code, commands or technical terms" (it conflicts with running a command) and add `Run the office command with the bash tool. Never write the command in your reply.`
2. Skills: make examples correct by construction instead of placeholders. Fixed draft names per skill (`~/.cache/sai-atlas/drafts/report.md`, `…/slides.md`): copying the example is then right, and the launcher consumes the draft so two jobs in one session do not collide. For `clean`, the path must be the person's: `office clean --in 'PATH'` plus `PATH is the file path on the User: line at the end of this message; copy it exactly, in single quotes.`
3. Launcher: make `--title` optional (first `#` heading when absent). Every passing docx/pptx today is named `Q3 report`/`Q3 review` whatever its content — a user-visible defect even in PASS runs.
4. Pin `temperature: 0.2` in `config.yml` (see C).

Honest forecast for v2a: starter 5-7/9, typed 2-5/9, total 8-12/20. It will not reach 16. It is worth 25 minutes of machine time because it documents that wording alone does not close the gap, which the gate record needs.

## C. Runtime levers outside the text

- Thinking: off in all 40 runs and not switchable for this import. `ollama show hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf` lists capabilities `tools, completion, vision, audio` — no `thinking`. omp's catalog sets `reasoning = capabilities.includes("thinking")` (`catalog/src/provider-models/ollama.ts:155`), the session clamps the level for non-reasoning models (`extensibility/legacy-pi-ai-shim.ts:87`), and `mapReasoning` (`ai/src/providers/ollama.ts:106-134`) sends `think` only for an explicit level, which Ollama rejects on a model without the capability. Ollama's library `gemma4:e4b` (non-QAT) advertises thinking, toggled by `<|think|>` at the start of the system prompt. Not a first lever: the failure modes are instruction following, not reasoning depth, and thinking on E4B costs TTFT, which the plan tracks. Try it only after v2b, on the two or three scenarios that still fail.
- Temperature: omp sends `options.temperature` only when the `temperature` setting is ≥ 0 (`session/settings.ts:433-440`, `:550-562`; `ollama.ts:338-340`). Default −1 means Ollama's default (0.8 here; the import has no Modelfile parameters beyond stop tokens; Google recommends 1.0/0.95/64 for chat). For argument fidelity pin `temperature: 0.2` in the pack overlay (one more pinned key, product-relevant). Expect a modest gain in path copying, none for "command as text".
- `PI_OLLAMA_API=ollama-chat`: native `/api/chat` with `tools`, `num_ctx: 16384` sent for the local provider (`ollama.ts:313-326`; `OLLAMA_NATIVE_DEFAULT_CONTEXT = 16_384`, `config/model-discovery.ts:163`), structured `tool_calls` parsed by Ollama's gemma4 parser. omp's text-channel healer for this model is `"thinking"` only (`ai/src/utils/stream-markup-healing.ts:229-233`): no tool-call recovery from text. None was needed: every "command as text" `assistantText` is a bare command line with no `<|tool_call>` markup, so these are genuine text replies, not parse failures. Partial calls (`read {}`, `write {path only}`) are the model's omissions — `parseStreamingJson` does not drop keys, and long `write.content` strings round-trip in every starter run.
- Context: pack prompt ≈2.7k of 16,384 (input + cacheRead; baseline 7.2k). Not a factor.

## D. Which fallback fits the evidence

(i) Office jobs as extension tools — recommended.

Evidence: all nine E4B starter failures are command composition (example path copied: 2; command printed as text: 3; draft written to one name, command run on another: 1; no write at all: 1; leaked-draft false pass: 1), while every structured call that carried a long string (`write.content`, 6/6 word+slides starters on E4B) succeeded. Typed-parameter tools remove exactly the failing step and also the step the typed form never reaches: the tool schema carries the markdown rules, so a typed request becomes `read` → `office_report` with no skill discovery.

Shape (all in `spike/pack/tools.js`, the existing `--extension`; `registerTool` is the mechanism `diagnose` already uses, `extensibility/extensions/types.ts:667-711` — no `patches/omp` patch, the doc's phrasing is obsolete):

- `office_report { title, markdown, name? }`, `office_slides { title, markdown, name? }`, `office_clean { file, sheet?, totals?, decimal? }`; `loadMode: "essential"`; descriptions carry the markdown rules and the output folder, with no example values (examples get copied).
- `execute` runs the office code in-process (the bundle already contains docx/exceljs/pptxgenjs; `spike/src/office.ts` has `buildReport`, `buildSlides`, `buildClean`, `writeUnique` — add a markdown-string entry beside `readMarkdown`) and returns the same JSON line as its text result. Spawning the launcher instead is also fine; in-process is simpler and has no PATH or env contract.
- `--tools` drops `bash`; `write` stays only for the helpdesk support note. `config.yml`: `bash.*` keys become inert (keep or drop, say which); add `tools.approval.office_report|office_slides|office_clean`.
- Containment gains: no shell at all, so red-team finding 2 (bash patterns, login shell, direnv, compound commands, env leaks) closes by construction; `PI_BASH_NO_LOGIN` and `PATH` in the spawn env stop being load-bearing.
- Approval tier is a user fork: `prompt` (one plain-language approval per job, consistent with the "draft writes stay approval-gated" decision) vs `allow` (the tools never overwrite and write only under Documents > Sai ATLAS). Recommend `prompt` for v2b and report approvals/run; flip to `allow` only if the approval count or the UX argues for it.
- Plan deltas if chosen: Decisions `Office route` (user decision — present at the gate, do not change silently); outcome bullet "the bash tool runs nothing but the office launcher" → "no bash tool"; Phase 4 pack layout (`bin/office` and `office/office.js` optional; `src/office/cli.ts` tests become tool tests), Task 4.7 overlay, skill bodies ("read the input, then call office_report …"); Phase 6 `<TOOLS>` list; Phase 8 Task 8.3 output card keys on `office_*` tool results instead of parsing bash output (simpler, no JSON-in-stdout heuristics); Phase 2/3 tool-renderer list.

(ii) Starter cards running the scripts directly from the GUI — partial fit only. It suits `spreadsheet-cleanup` (deterministic, no content to write: a card → file dialog → script → output card would pass 100% with zero approvals), but Word and slides need the model to write the content, so (ii) cannot deliver them. Keep it as a later product option for cleanup; it is not needed if v2b passes.

## E. Harness correctness

1. `resultText` is captured (`rpc.ts` `recordToolEnd`: `textOf(event.result).slice(0, 4000)`) and used by `launcherLinesFrom`; `suite.ts` then drops it when building `RunRecord.toolCalls`. Not a scoring bug; a diagnostics gap. Keep 500 chars per call so the record shows why `read "spreadsheet-cleanup"` or the first `bash` in word-en-review-starter failed.
2. Real bug, overstates the score: `~/.cache/sai-atlas/drafts/` is shared across runs and models, and the launcher deletes its input after converting (`spike/src/office.ts:418`). E4B `slides-vi-review-starter` made no `write` and ran `office slides --in '~/.cache/sai-atlas/drafts/q3-slides.md'`, the English draft left by `slides-en-review-starter`; the resulting `Q3 review.pptx` is English (slide 2: "Revenue grew 8% over Q2"). E2B `word-vi-review-starter` wrote `report-vi.md` but ran on `q3.md`, left by E4B's `word-vi-review-starter`. Honest v1: E4B 3/20 (starter 3/9), E2B 4/20 (starter 4/9). Fix: wipe the drafts folder before every run; add a PASS condition that each launcher `--in` (or tool `file`/`markdown`) is the fixture copy or a path written in this run; add a derivation check (output contains a fixture-specific string per language, e.g. "Da Nang" / "Đà Nẵng").
3. `firstInputTokens` records `usage.input`, which on Ollama excludes the cached prefix (33-98). Record `input + cacheRead` as the plan's "input tokens" (≈2.7k pack, ≈7.2k baseline).
4. Timeouts and approval loops are scored FAIL correctly. Optionally cap approvals at 20 per run to save wall time; not a scoring change.
5. For v2b, `launcherLinesFrom` must also scan `office_*` tool results, not only `bash`.

## What to do (ordered)

1. Harness: wipe drafts per run; provenance and derivation checks; keep `resultText` (500 chars); record `input + cacheRead`; scan `office_*` results. Re-score the existing v1 JSON with the new rule and write the honest v1 table (E4B 3/20, E2B 4/20) into the spike report as the v1 gate result.
2. Build v2b in the spike: three office tools in `tools.ts`, `--tools read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean`, overlay `temperature: 0.2`, `tools.approval.office_*: prompt`, skills rewritten to call the tools, system prompt naming the tools and the `skill://` read path. Keep the ten scenarios, both forms and the prompts unchanged.
3. Build v2a (text-only fixes 1-4 from B) as a separate pack directory, same harness.
4. Run E4B on v2b and v2a (about 25 minutes each), then E2B on v2b. Report all three beside v1.
5. Gate: v2b E4B ≥ 16/20 and six human checks → GO on the tools route (user confirms the `Office route` change). Below 16 → NO-GO; the remaining options are (ii) for cleanup plus a larger model for word/slides, or thinking on the library `gemma4:e4b` as a last probe.

## What to avoid

- Lowering the bar, dropping scenarios, or adding fixture-specific wording to prompts or skills.
- Treating v1 4/20 (or 5/20 for E2B) as the recorded number: the leak is documented above.
- `think` on the hf.co import (rejected) or switching to the non-QAT library model just for thinking before v2b is measured.
- A `patches/omp` patch for tools: unnecessary, `tools.js` already registers tools.
- Keeping `bash` in `--tools` "for flexibility" under the tools design: it keeps the whole shell containment surface alive for no gain.

## Alternatives and trade-offs

- v2a alone (keep the bash route, fix wording): cheapest, keeps the plan's shape, but the evidence says it tops out around half the bar; a 4B model composing shell commands is the wrong contract.
- v2b (office tools): one more tool-result renderer in Phase 8 and a Decisions row change, in exchange for removing bash, the drafts folder, the quoting rules and the output-card stdout parsing. Markdown now travels as a tool argument (fine: it already did as `write.content`).
- (ii) GUI-run cleanup + tools for word/slides: best cleanup reliability, but two execution paths to maintain and the assistant is bypassed for one job; defer unless v2b cleanup still fails.

## Success metrics

- v2b E4B ≥ 16/20 with typed ≥ 7/11 and starter ≥ 8/9, approvals ≤ 2 per single-skill run, TTFT comparable to v1 (3-8 s), every output file derived from its own run's input, Vietnamese outputs in Vietnamese.
- Honest v1 and v2a rows present in the spike report with the leak explained.

## Assumptions

- The office tools run in-process in the sidecar (extension modules load in the sidecar's Bun runtime; the spike's `diagnose` stub already executes there; `BUN_BE_BUN` proved the bundle's dependencies work under the compiled binary). Confidence: high. If an extension module were sandboxed from heavy imports, spawn the launcher from `execute` instead.
- Ollama rejects `think` on a model whose capabilities lack `thinking` (medium; one `curl /api/chat` with `think:true` settles it after the suites finish — do not run it while a suite holds the GPU).
- `temperature` is a top-level overlay key (its registered id is `temperature`, `session/settings.ts:433`). Confidence: high; the load check's provenance readback confirms it.
- E2B honest score 4/20 assumes no other starter pass reused a leftover draft; the four remaining E2B passes show a write-then-run or fixture-path `clean`, so none did. Confidence: high.
- The `Office route` change is a user decision; this counsel recommends it but does not make it. The gate (Task 1.7) is where the user records GO/NO-GO and the route.

## Unresolved questions for the user (decide at the gate)

1. Office route: bash launcher (v1, NO-GO at 3/20) vs typed office tools (v2b, to be measured).
2. Approval tier for `office_*`: `prompt` (recommended) or `allow`.
3. Whether to spend the v2a control run (recommended; 25 minutes).
