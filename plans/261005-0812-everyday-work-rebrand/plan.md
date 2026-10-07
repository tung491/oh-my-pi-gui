---
title: "Sai ATLAS everyday-work rebrand"
description: "Turn Sai ATLAS into a private, local assistant for everyday work: remove code mode and developer surfaces, ship a GUI-owned assistant pack (office skills, SAI OS help, helpdesk) through omp's --extension flag, and rewrite the copy."
status: in-progress
priority: P1
effort: 25d
branch: rebrand/everyday-work
tags: [feature, refactor, frontend, backend, critical]
blockedBy: []
blocks: []
created: 2026-10-05
---

# Sai ATLAS everyday-work rebrand

## Overview

Source design: the "Sai ATLAS Everyday-Work Rebrand Plan" doc (claude.ai artifact `898HSJ3s9RbbUi2sw7Kh3S`, rev 53, read 2026-10-05), built on `plans/reports/research-261005-1305-non-tech-assistant-rebrand.md` and `plans/reports/research-261005-1338-how-claude-creates-office-files.md`. The pack loads through omp's existing `--extension`, `--tools`, `--system-prompt`, `--config` and `--approval-mode` flags. Three omp patches were added during delivery, when no flag or setting could express a decision: `patches/omp/0002-no-context-files-flag.patch` (Decisions "Folder instruction files"), `patches/omp/0003-model-policy-local-only.patch` (Decisions "Local models only") and `patches/omp/0004-mcp-enabled-setting.patch` (an `mcp.enabled` setting the pack pins off: omp keeps MCP on for `--tools` sessions and loads the user's `~/.omp/agent/mcp.json`, which the egress dry run caught on 2026-10-06).

This plan is **handover-ready** (`--advice`): every phase file carries ordered tasks with target files, steps, mechanical `Verify` conditions, and its own Failure Protocol. A failed check means STOP and escalate, not improvise.

## Outcome and acceptance criteria

- [x] The Phase 1 spike passes its gate: Gemma 4 E4B completes at least 16 of 20 spike runs, scored separately for typed and starter-card requests; E2B is measured and its numbers are recorded for a later decision.
- [x] One task lane and one "New task" button; every surface in the doc's R1–R3, R5–R12 and R14 lists is deleted (not hidden), with its tests, commands, hotkeys, menu items and locale keys.
- [x] Agent sessions spawn with `--no-extensions --extension <pack> --tools … --system-prompt <pack>/system-prompt.md --append-system-prompt <pack>/append-system-prompt.md --no-rules --no-context-files --config <pack>/config.yml --approval-mode always-ask` and the pack env (`SAI_ATLAS_LANG` set; `BASH_ENV`, `ENV`, `OMP_PROFILE` and `PI_PROFILE` removed) in both shells, with twin tests. A launch profile cannot override any of it, and no user or project config can override a key the pack pins. Old chat-stamped sessions are refused with a "start a new task" message.
- [x] The Linux `.deb` creates a Word report, a cleaned spreadsheet and a slide deck offline; there is no bash tool (office jobs are the typed tools `office_report`, `office_slides`, `office_clean`, writing only new files under Documents > Sai ATLAS); no helper session can start (the `task` tool is not loaded); the Phase 1 containment checks pass.
- [x] Starter cards, attach button, output card, plain-language approvals and the Linux-only helpdesk work in en and vi.
- [x] No user-facing copy says "coding agent"; README (en + vi), site, package descriptions and CHANGELOG describe what ships; the egress audit confirms the privacy sentence.
- [x] Full gates green on the integration branch: every command in "Shared commands" below.

## Decisions

| Topic | Decision | Source |
|---|---|---|
| Office route | **Typed extension tools, no bash.** The pack's `tools.js` registers `office_report { title?, markdown, name? }`, `office_slides { title?, markdown, name? }` and `office_clean { file, sheet?, totals?, decimal? }`, which build files in-process and write only new files under Documents > Sai ATLAS; `bash` leaves `--tools` and there is no launcher. Each job asks for approval once (`tools.approval.office_*: prompt`). Replaces the bash `office` launcher route, which scored 3/20 on E4B in the spike against 17/20 for the tools (`plans/reports/spike-261005-everyday-work-rebrand.md`) | User, 2026-10-05 (spike gate); was: skills call a static `<pack>/bin/office` through bash (validation; red team) |
| Pinned settings and approval rules | Ship as a static `<pack>/config.yml` passed with `--config`, pinning every approval-relevant key (`temperature: 0.2`, `fetch`, `extensions`, `skills.*`, `mcp.enableProjectConfig`, `task.disabledAgents`, `tools.approval` with `office_*: prompt`, and `shellPath` plus `bash.*` kept inert as a deny-all guard with `direnv: "off"`; since the Wave A repair also `plan.enabled: false`, `plan.defaultOnStartup: false`, `skills.customDirectories: []`, `skills.includeSkills: []`, `skills.ignoredSkills: []` (a user pattern there hid pack skills) and `commands.enableClaudeUser`, `commands.enableClaudeProject`, `commands.enableOpencodeUser`, `commands.enableOpencodeProject: false`; Phase 4 Task 4.7), never through `set_setting`: `set_setting` writes the user's global `~/.omp/agent/config.yml` (omp `modes/rpc/rpc-mode.ts:3272-3293`, `docs/config-usage.md:159,188`), which would lock bash in the user's own omp. Overlays are process-only, read-only and inherited by helpers (`docs/config-usage.md:171-194`). The renderer also disarms a journal-armed plan session at ready, because `set_plan_mode` and `syncArmed` ignore `plan.enabled` (Wave A review H2), and the Settings window shows no `plan.*` setting | Verified in source; kongming; Wave A review H2, M3 (2026-10-06) |
| `tools.approval` shape | Flat `toolName: allow|prompt|deny` strings (`tools/settings.ts:275`, `docs/approval-mode.md:30-39`), not `{policy, override}` objects | Verified in source |
| ApprovalControl | Removed, and the tray approval radio with it (it wrote the global `tools.approvalMode`). Every session runs `always-ask`. ApprovalDialog and the read-only tray approval label stay | User, 2026-10-05; red team |
| ExtensionDialog | **Kept**, against the doc's R7 row: it is the `extension_ui_request` dispatcher that routes tool approvals to ApprovalDialog (`ExtensionDialog.tsx:1-12`, `:24`). Only ExtensionsPanel, InventoryPanel, `mcp/*`, ForceToolDialog, ActiveToolsDialog and the settings pages go | Verified in source |
| CoordinationRenderer | **Kept**, against the doc's R10 row: all three of its exports serve kept tools — `WaitRenderer` (`wait`, `index.tsx:10`), `ProcReadRenderer` (`ReadRenderer.tsx:14`), `ProtocolWriteRenderer` (`WriteRenderer.tsx:8`). TaskRenderer also stays. Since the spike (row "Helpers") pack sessions load no `task` or `wait`, so `TaskRenderer` and `WaitRenderer` serve old transcripts only; their removal is an open question | Verified in source |
| Chat kind | Phase 2 removes chat entry points only. Phase 6 removes the `--chat` spawn branch in both shells and normalises every spawn to `agent`; the `SessionKind` type stays so persisted sessions still parse. A chat-stamped session file is refused (`kind-mismatch`, toast "Start a new task"): omp resumes it restricted, without the pack's tools (`main.ts:1593`, `sdk.ts:3273`) | Doc R14; user, 2026-10-05 (red team) |
| Sidebar | One lane listing every session, project sessions included, without project grouping | User, 2026-10-05 (red team) |
| Removed commands | omp's own slash commands with a removed name (`/share`, `/collab`, `/mcp` …) are hidden and blocked in the GUI (`REMOVED_COMMANDS` in `src/renderer/lib/command-availability.ts`, shared by the palette, the composer and slash completion). Since the Wave A repair, a typed name resolves as omp parses it (cut at the first whitespace or `:`, aliases included), the queue shorthand is checked too, and `plugin`, `wt` and `worktree` are added. Phase 9 Task 9.0 adds `modelpreset`: it writes the user's global omp config even when the local-only policy refuses the model | Red team; Wave A review H1; Wave C checkpoint |
| Locale keys | Deleted in one serial sweep (Phase 5), not in each surface's commit, so parallel phases never edit `en.ts`/`vi.ts`. Accepted deviation from the doc's per-surface commit rule | Planner; kongming |
| Env bypass | `PI_CONFIG_FILES`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `BASH_ENV`, `ENV` join both shells' `OVERLAY_DENYLIST` (`PI_BASH_NO_LOGIN` dropped with the bash tool, spike propagation 2026-10-06) (`src/main/shell-env.ts:31`, `src-tauri/src/omp/shell_env.rs:28`). Values already in the app's own `process.env` pass through (e2e relies on it); the pinned overlay keys outrank them | kongming; red team |
| Folder instruction files | Pack sessions ignore `AGENTS.md`, `CLAUDE.md` and a workspace `APPEND_SYSTEM.md`: both shells pass `--no-rules`, `--no-context-files` (added to omp by `patches/omp/0002-no-context-files-flag.patch`, because `--no-rules` leaves `AGENTS.md`/`CLAUDE.md`/`*.instructions.md` loading and a `disabledExtensions` name list cannot cover them) and a pack-owned, empty `--append-system-prompt <pack>/append-system-prompt.md`; launch-profile flags are an allowlist of `--no-lsp` and `--session-dir <dir>`; `autoResume: false` is pinned. The pack system prompt is the only instruction source. Repaired on `rebrand/wave-b-fixes` (`plans/reports/code-reviewer-261006-wave-b.md`, `plans/reports/fullstack-developer-261006-wave-b-fixes.md`) | User, 2026-10-06 |
| Target desktop | The computer-help tools (`os_setting`, `open_item`, `diagnose`, `system_status`, helpdesk skill) target Ubuntu GNOME only: `gsettings` `org.gnome.*` keys, `wpctl` for volume (PipeWire; no `pactl`), `gnome-control-center <panel>` pages, `net.nokyan.Resources`/`gnome-system-monitor` and `update-manager` app ids. Every Cinnamon/LMDE command is removed. Verified on Ubuntu 26.04 (GNOME Shell 50.1, Wayland); the .deb floor stays Ubuntu 24.04. Ported on `rebrand/ubuntu-gnome` (`plans/reports/fullstack-developer-261006-ubuntu-gnome-port.md`), merged before Phase 9 | User, 2026-10-06 |
| Local models only | Pack sessions use only local, non-cloud Ollama models: online providers (Anthropic, OpenAI, Google, …), Ollama cloud tags, `/login` and provider API keys in the environment are blocked where the agent resolves and switches models (pinned in the pack config, or an omp patch if no setting can express it), with the renderer refusal as a second layer in every model chooser (picker, cycle, welcome, typed `/model`/`/switch`, Settings model dropdowns). Keeps "Your files and conversations stay on this computer" true. Repaired on `rebrand/wave-c-fixes` (`plans/reports/code-reviewer-261006-wave-c.md`, `plans/reports/fullstack-developer-261006-wave-c-fixes.md`). "Local" means this computer: Ollama on another machine, even on the user's own network, is refused (user, 2026-10-06), and the policy accepts only literal loopback addresses (`localhost`, `127.0.0.0/8`, `::1`, and `0.0.0.0`, which Ollama users commonly set and which connects to this computer), never a DNS name; a malformed `modelPolicy` allows no model | User, 2026-10-06 |
| Vietnamese pass wording | Approval dialogs and output cards for the office tools show only the plain sentence and a plain title, never `office_report`/`office_clean`/`office_slides`. The assistant pack writes its output-card summaries and the cleaned-file suffix in the app language (`SAI_ATLAS_LANG`). A language switch reaches the assistant at the next launch, and switching says so in a short message (there is no language row in Settings; the sidebar EN/VI button and the menu toggle switch it). Approval dialogs drop the tool id wherever a plain sentence exists. "Agent" stays as the word in both languages | User, 2026-10-07 (Vietnamese pass) |
| Network after the egress audit | Settings › Updates checks only the app's GitHub releases; it no longer asks the bundled agent for omp's npm release (`get_omp_update` reached `registry.npmjs.org`). On Linux, installing or starting Ollama from the welcome screen also writes the systemd drop-in `/etc/systemd/system/ollama.service.d/sai-atlas.conf` with `OLLAMA_NO_CLOUD=1` in the same password prompt: it stops Ollama's own 4-hourly fetch from `ollama.com` (model recommendations) and keeps model downloads working (tested on Ollama 0.35.0). The `.deb` also ships the same drop-in as `/usr/lib/systemd/system/ollama.service.d/sai-atlas.conf`, so an Ollama set up outside the app gets it after the next reboot or a `systemctl daemon-reload` (no maintainer script, so nothing reloads systemd at install). This turns off Ollama cloud models for every app on the computer, which matches local-only | User, 2026-10-07; egress audit |
| Branching | Start now on `rebrand/everyday-work` from local `main` (`7677ba1`, Tauri cutover merged, unpushed); bring in whatever Tauri Phase 11 ships with `git merge main` in Phase 9 (merge, not rebase, so the phase merge commits and wave tags survive) | User, 2026-10-05; red team |
| Spike gate | E4B ≥ 16/20 runs; typed and starter-card scored separately; E2B measured, not gated | User, 2026-10-05 |
| Windows | Dropped (R13). Phase 7 also amends the Tauri plan's Phase 12 so nobody re-adds it | Doc; kongming |
| Helpers | **Removed from v1.** `task` leaves `--tools`; `agents/helpdesk.md` is deleted and the helpdesk flow is the main-session skill `sai-os-helpdesk`, with real approvals; a multi-part job runs its skills one after another. Reason: omp 18.4.8 runs helpers headless (`task/executor.ts:4071`), so `ask` is absent and every `prompt` tool throws there (`extensibility/extensions/wrapper.ts:374-389`); Gemma also misfills the task tool's eval `tools` field. Phase 1 spike deltas (`glob` replacing `find`, `bash.direnv: off`, `loadMode: "essential"`, settings provenance as the readback check) are listed in `plans/reports/spike-261005-everyday-work-rebrand.md`; the final tool list, without `bash`, is in Phase 6 "Spawn contract" | User, 2026-10-05 (spike); kongming `plans/reports/kongming-261005-1930-spike-load-check-counsel.md` |
| Spike gate result | GO on the typed office tools route: Gemma 4 E4B 17/20 (typed 7/9, report + slides 1/2, starter 9/9), E2B 15/20; all six human file checks pass in WPS on SAI OS and in Microsoft Office, Vietnamese accents included; containment checks pass on the shipped pack. The planned bash-launcher route scored 3/20 (NO-GO). Report: `plans/reports/spike-261005-everyday-work-rebrand.md` | User, 2026-10-06 |
| Sidecar build | This checkout is standalone, so `build:omp` cannot resolve `../../packages/coding-agent` (`scripts/build-bundled-omp.ts:33-35`). Use the existing `resources/omp.linux-x64`, symlinked into each worktree by its Task N.0 (`resources/omp*` is gitignored); rebuild only from `/home/tung491/WORK/oh-my-pi/packages/gui` | Verified |

## Phases and waves

```text
P1 spike ──G1──┬─ P2 renderer removals ─┐
               ├─ P3 tool renderers ────┼─ P5 locale sweep ── P6 spawn wiring ──┬─ P7 main+Rust removals ─┐
               └─ P4 assistant pack ────┘                                      └─ P8 everyday UX ────────┴─ P9 copy + release
```

| # | Phase | Wave | Depends on | Effort | Status |
|---|---|---|---|---|---|
| 1 | [Spike and go/no-go gate](./phase-01-spike.md) | 0 | — | 2d | Completed |
| 2 | [Renderer removals](./phase-02-renderer-removals.md) | A | 1 | 3d | Completed |
| 3 | [Tool renderer removals](./phase-03-tool-renderer-removals.md) | A | 1 | 0.5d | Completed |
| 4 | [Assistant pack](./phase-04-assistant-pack.md) | A | 1 | 5d | Completed |
| 5 | [Locale sweep](./phase-05-locale-sweep.md) | serial | 2, 3, 4 | 1d | Completed |
| 6 | [Spawn wiring in both shells](./phase-06-spawn-wiring.md) | B | 4, 5 | 3.5d | Completed |
| 7 | [Main-process and Rust removals, Windows](./phase-07-main-and-rust-removals.md) | C | 6 | 3d | Completed |
| 8 | [Everyday UX and SAI OS help](./phase-08-everyday-ux.md) | C | 6 | 3d | Completed |
| 9 | [Copy, egress audit and release prep](./phase-09-copy-and-release.md) | serial | 7, 8 | 2.5d | In progress: release step with the user |

Phases in the same wave run in parallel, each in its own worktree and branch, with disjoint file ownership stated in each phase file. A wave merges into `rebrand/everyday-work` before the next wave starts.

**Wave gate.** The phase that merges last in Wave A does not tag at once. In `/home/tung491/WORK/worktrees/rebrand-integration` it runs: `bun install`, `ln -sf /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64`, `bun run build:pack`, `bun run check:types`, `bunx vitest run`, `bun run build`, `git diff --name-only rebrand-base -- '*.ts' '*.tsx' | xargs bunx biome check`, `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack`, then the absence greps of Tasks 2.9, 3.3 and 4.8. Only when every command exits 0 does it tag `rebrand-wave-a`. A failure is handled by the Failure Protocol of the phase that merged last.

**Wave A review fixes.** The Wave A review (`plans/reports/code-reviewer-261006-wave-a.md`; placement and fixes in `plans/reports/kongming-261006-phase-5-checkpoint.md` "Wave A review fixes") is repaired on one branch, `rebrand/wave-a-fixes`, cut from `rebrand-wave-a` (worktree `/home/tung491/WORK/worktrees/rebrand-fixes-a`). Its scope is H1, H2, M1, M2, M3, L1–L4, L6, L8 and L9; for H2 it deletes the dead `src/renderer/hooks/use-plan-approval.ts` and keeps `src/renderer/stores/plan-approval.ts`, which Phase 2's Keep list and Task 2.9 Verify (repeated by the Wave gate) still require. L5 is deferred, L7 is Phase 9 Task 9.5's CHANGELOG line, and M4 is Phase 9 Task 9.0's e2e step. It merges `--no-ff` into the integration branch before Phase 5 Task 5.0. The merge re-runs every Wave gate command above plus: `bunx vitest run src/renderer/lib src/renderer/components/layout src/renderer/hooks assistant-pack` exits 0 with the new cases listed as passed; `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` prints `plan.enabled` and `plan.defaultOnStartup` reading `false` with layers `overlay`, one `overlay` row for each of the six discovery keys, and `PACK LOAD CHECK: PASS`; `rg -n 'gtk-launch' assistant-pack` prints nothing. Only when every command passes is the integration branch tagged `rebrand-wave-a-fixed`; `rebrand-wave-a` stays where it is. Done 2026-10-06: merge `0c47264` (8 commits plus `skills.ignoredSkills: []` and hiding every `plan.*` setting), all 17 gate commands exit 0 (vitest 1883 passed, 5 skipped), tagged `rebrand-wave-a-fixed`; report `plans/reports/fullstack-developer-261006-wave-a-fixes.md`.

## Worktrees

| Branch | Worktree path |
|---|---|
| `rebrand/everyday-work` (integration) | `/home/tung491/WORK/worktrees/rebrand-integration` |
| `rebrand/p01-spike` | `/home/tung491/WORK/worktrees/rebrand-p01` (never merged) |
| `rebrand/wave-a-fixes` | `/home/tung491/WORK/worktrees/rebrand-fixes-a` |
| `rebrand/p0N-<slug>` | `/home/tung491/WORK/worktrees/rebrand-p0N` |

Each phase file's Task N.0 creates its worktree from the integration branch; its last task merges back. Run `bun install` once in each new worktree; phases that run the sidecar or the packaged pack also run `ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64` and `bun run build:pack`. Runs of the app on the virtual display and e2e runs use a throwaway `HOME` as well as a throwaway profile.

## Shared commands (run from the worktree root)

- Types: `bun run check:types` → exit 0.
- Unit tests: `bunx vitest run [path]` → exit 0.
- Lint touched files: `bunx biome check <files>` → exit 0.
- Rust: `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings'` and the same with `cargo test --manifest-path src-tauri/Cargo.toml --all-features` → exit 0.
- Twins ("the parity loop", as in `.github/workflows/ci.yml:80`): `for p in src-tauri/contracts/*.parity.json; do bun scripts/check-test-parity.ts "$(basename "$p" .parity.json)" || exit 1; done` → exit 0. The script needs a module argument; run bare, it exits 2.
- Snapshots: `bash scripts/check-module.sh snapshots` → exit 0.

## Rollback

The integration branch is tagged at each boundary: `rebrand-base` (Task 1.0), `rebrand-wave-a` (Phases 2–4 merged), `rebrand-wave-a-fixed` (the Wave A repair merged), `rebrand-p05`, `rebrand-wave-b` (Phase 6), `rebrand-wave-c` (Phases 7–8), `rebrand-pre-release` (Task 9.0). Reverting one merge commit is safe only until the next phase merges; after that, roll back with `git reset --hard <tag before the wave>` on the integration branch, because later phases depend on earlier ones (Phase 5 deletes locale keys of Phase 2's components; Phase 6 refuses to spawn without Phase 4's pack; Phase 8's starter cards call Phase 4's skills through Phase 6's flags).

## Dependencies

- Ollama running locally with `hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf` and `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf` (the E2B tag is already installed; Phase 1 pulls E4B).
- Human checks in Phase 1 and Phase 9: WPS on a SAI OS (LMDE 7) machine, and Microsoft Office once.
- Tauri plan `plans/261002-1441-tauri-shell-migration/` (Phase 11 release pending): this plan rebases onto it, it does not block on it.

## Open questions carried from the doc

Who reviews the Vietnamese strings (delegated to agy); which ten SAI OS problems matter most; whether escalation needs a named contact; slides theme choices; a macOS helpdesk later. The Phase 1 question about gating draft writes is moot: the office tools take Markdown as an argument, so there is no drafts folder.

Resolved 2026-10-06 (user): the computer-help tools target Ubuntu GNOME only, not Cinnamon (see Decisions "Target desktop"). Confirmed 2026-10-06 on the Ubuntu 26.04 laptop: every command passed, including the visible setting flips and Settings pages (two first-run failures were the check script's timing, not the commands). Recorded in `plans/reports/spike-261005-everyday-work-rebrand.md`, "SAI OS commands"; Phase 9 Task 9.0 is no longer waiting on it.

Added by the spike propagation (2026-10-06): with helpers, `bash` and `find` out of pack sessions, `TaskRenderer`, `WaitRenderer` and `CoordinationRenderer` (and `BashRenderer`, `FindRenderer`, plus the agent hub, jobs and subagent views on Phase 2's keep list) are now inert in the pack session and only render old transcripts. Removing them is an open question for the user; no phase removes them.

## Follow-ups after this plan

- Welcome screen with an off-computer `OLLAMA_HOST`: it advises "Starting its service should be enough", which cannot help when Ollama runs on another machine (refused by Decisions "Local models only"). Show the "only Ollama on this computer" sentence there too. Deferred from Phase 9 on 2026-10-06; the model chooser already says it.
- `site/index.html`'s release script still looks up a Windows `-setup.exe` asset (two dead lines; no page element uses them). Task 9.3 kept that script unchanged on purpose.
- Offer patches 0002–0004 to the `nornzach/oh-my-pi` fork, so an upstream sync stops needing them rebased; they stay GUI-side patches until then.
- Shared command names ("Clear Context", "Export HTML", "Retry Last Turn" …) still read as developer terms in the Settings overview and the app menus (TS and Rust); make them plainer together.
- The Agent Hub (`/agents`, its hotkey) stays reachable although helpers are off in assistant sessions; decide whether to remove it.
- The AppImage cannot ship the `OLLAMA_NO_CLOUD=1` drop-in, so an AppImage user's own Ollama keeps fetching model recommendations from ollama.com unless they use **Start Ollama** or **Install Ollama**. The `.deb` covers it.
- `e2e/auto-follow.e2e.ts:125` samples the scroll position once after 60 scroll events and failed once in two full Electron runs on 2026-10-07 (3 of 3 alone); make it wait for the scroll to settle.
- The tab subtitle shows the work folder's name, `work` (`~/.omp/work`), in both languages; decide whether it should read as a place ("Documents" / "Tài liệu") or be hidden.
- `scripts/check-test-parity.ts` blanks text after `//` inside Rust string literals (worked around with `127.0.0.1:11434`).
- The stripped provider env list in both shells is not checked against omp's provider list, so a provider added upstream is not stripped until the list is updated; `scripts/sync-upstream.sh` is the place to check it.

## Red Team Review

### Session — 2026-10-05
**Findings:** 15 after deduplication of 37 (15 accepted, 0 rejected; parts of 2 suggestions rejected as beyond scope)
**Severity breakdown:** 6 Critical, 8 High, 1 Medium
**Report:** `plans/reports/red-team-261005-everyday-work-rebrand.md`
**User decisions:** apply all; launcher moves into the install as a bare `office` on `PATH`; old chat sessions are refused with "start a new task"; project sessions stay listed in the one lane.

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| 1 | Launcher in `$HOME` is model-writable and shared by every build and test | Critical | Accept (user: move into install) | Phases 1, 4, 6, 8; Decisions |
| 2 | Overlay pinned only `bash.patterns`; login shell; env leaks | Critical | Accept | Phases 1, 4, 6; Decisions |
| 3 | `--tools` does not limit helpers | Critical | Accept | Phases 1, 4 (`task.disabledAgents`, `tools.approval` denies) |
| 4 | Extension and skill discovery stayed on | Critical | Accept | Phases 1, 4, 6 (`--no-extensions`, `skills.*`) |
| 5 | Removed GUI commands bring back omp's `/share`, `/collab`, `/mcp` | Critical | Accept | Phase 2 (`REMOVED_COMMANDS`) |
| 6 | Chat-stamped sessions resume without the pack | Critical | Accept (user: refuse) | Phases 1, 6, 8; Decisions |
| 7 | Bare parity command exits 2 | High | Accept | Shared commands; Phases 3, 6, 7, 8 |
| 8 | Worktrees have no sidecar; compiled test skipped | High | Accept | Worktrees; Phases 4, 6, 7, 8 |
| 9 | Rebase flattens merges; rollbacks ignore dependencies | High | Accept | Rollback section; Phases 2–9 |
| 10 | Pack check outside the error path; tests write `$HOME`; unlisted tests; frozen `SidecarOptions` | High | Accept | Phase 6 |
| 11 | Denylist gaps and dead launch-profile fields | High | Accept (allowlist redesign rejected) | Phases 6, 8 |
| 12 | Tray approval radio, 13 menu actions, Windows sites, macOS Tauri wiring | High | Accept | Phases 6, 7, 8, 9 |
| 13 | `open_item`, output card, draft detection, drafts race | High | Accept | Phases 4, 8 |
| 14 | Egress audit could not prove the privacy sentence | High | Accept (sentence wording to Validation) | Phase 9 |
| 15 | Renderer leftovers and executor-blocking references | Medium | Accept | Phases 1, 2, 5, 6, 8 |

### Whole-Plan Consistency Sweep
- Decision deltas: launcher location and shape; pinned overlay keys; `--no-extensions`; pack env; chat refusal; one lane with project sessions; `REMOVED_COMMANDS`; merge-not-rebase with wave tags; parity loop; sidecar symlink per worktree; `MenuAction` trim moved to Phase 9 Task 9.0.
- Searched every plan file for `~/.local/share/sai-atlas/bin`, `writeOfficeLauncher`, `uniquePath`, `assertAssistantPackFiles`, `git rebase`, bare `check-test-parity.ts`, "no migration", `ipc-types.ts:442`, `lib/rpc-client`, `ps -o args`: the only remaining hits assert that nothing is written to `~/.local/share`.
- Ownership re-checked after the edits: Phase 7 no longer edits the `MenuAction` union (Phase 9 does, after Wave C); Phase 8 owns the renderer leftovers; Phase 9 owns e2e follow-ups to Phase 8's UI; Phase 6 no longer touches `src-tauri/macos/**`.
- Unresolved contradictions: none.

## Validation Log

### Session 1 — 2026-10-05
**Trigger:** plan validation after the red-team gate (`--parallel --tdd --advice`).
**Questions asked:** 3 (red team already settled launcher, chat sessions and project sessions).

#### Verification Results
- Claims checked: 8 new line references introduced by the red-team edits (sampled across Phases 7, 8, 9); earlier claims carry the red-team verification.
- Verified: 8 | Failed: 0 | Unverified: 0
- Tier: Full (9 phases); guard applied — the Red Team Review already holds per-role evidence.

#### Questions & Answers
1. **[Privacy]** Ollama cloud tags would send conversations online.
   - Options: refuse cloud tags (Recommended) | warn and soften the sentence | leave as is
   - **Answer:** Refuse cloud tags
   - **Rationale:** keeps the privacy sentence true and provable by the audit.
2. **[Scope]** Change the macOS category to Productivity too?
   - Options: change macOS too (Recommended) | Linux only
   - **Answer:** Change macOS too
   - **Rationale:** every platform describes the same product.
3. **[Scope]** Accept legacy `.xls`/`.ods` in v1?
   - Options: not in v1 (Recommended) | convert with LibreOffice
   - **Answer:** Convert with LibreOffice
   - **Rationale:** users on SAI OS often have `.ods`/`.xls` files; conversion needs no new dependency.

#### Resolved from evidence, no question needed
- Draft writes stay approval-gated: omp's `tools.approval` is per tool, not per path, so auto-allowing drafts would auto-allow every write (`coding-agent/src/tools/approval.ts:286-305`). Phase 1 still measures the friction.
- `computer` and `browser` commands stay deleted: they toggle tools the allowlist excludes.

#### Impact on Phases
- Phase 4: Task 4.3 rule 11 (LibreOffice conversion), CLI and skill accept `.xls`/`.ods`.
- Phase 8: Task 8.6 (refuse cloud tags), starter and attach filters accept `.xls`/`.ods`; later tasks renumbered.
- Phase 9: Task 9.6 checks that cloud tags are refused.

### Whole-Plan Consistency Sweep
- Searched for `xlsx","csv"]`, `legacy .xls`, `-cloud`, `Task 8.6`/`8.7` references: filters, CLI contract and skill text agree; the open-questions list no longer carries the legacy-format question; Phase 8 task references are renumbered.
- Unresolved contradictions: none.


### Spike propagation — 2026-10-06
**Trigger:** Phase 1 gate GO on the typed office tools route (Decisions "Office route", "Helpers", "Spike gate result"); every user decision was taken at the gate, none re-opened here. Sources: `plans/reports/spike-261005-everyday-work-rebrand.md`, `plans/reports/kongming-261005-1930-spike-load-check-counsel.md`, `plans/reports/kongming-261005-1945-spike-suite-counsel.md` (section D). Report: `plans/reports/planner-261006-spike-propagation.md`.

#### Changes per phase
- **plan.md:** outcome bullets 3 and 4 (pack env, no bash tool, no helpers); Decisions row "Bash and approval rules" renamed "Pinned settings and approval rules" with the new key set; "CoordinationRenderer", "Env bypass" and "Helpers" rows brought in line; open questions (drafts question moot; inert renderers).
- **Phase 1:** an Outcome section only; the tasks stay as the record of the v1 run.
- **Phase 3:** context names the new session tool list; the inventory test also requires a renderer for `glob`. No renderer is deleted beyond the original list.
- **Phase 4:** rewritten around the office tools. Pack layout loses `bin/office`, `office/office.js`, `src/office/cli.ts` and `agents/helpdesk.md`, and gains `src/office/markdown.ts` and `src/tools/office-tools.ts`. Tasks 4.1–4.5 are the output helpers (Documents fallback, first-segment containment, `safeBaseName`), the three string/path builders, and the office tools (replacing the CLI task), all test-first. Task 4.6 registers seven tools with `loadMode: "essential"`. Task 4.7: skills call the tools, the helpdesk skill carries the helpdesk flow, the system prompt opens skills through `skill://`, and the new `config.yml`. Task 4.8 builds eight files. Task 4.9 drives `tools.js` through the compiled sidecar.
- **Phase 6:** `<TOOLS>` uses `glob` and the three office tools, without `find`, `task`, `bash` or `wait`; the env sets only `SAI_ATLAS_LANG` and removes `BASH_ENV`/`ENV`; denylist adds five keys; `ASSISTANT_PACK_FILES` has eight paths (identical to Phase 4 Task 4.8); Task 6.6 reads tools, skills and settings with value plus provenance; Task 6.7 checks the exact `--tools` value and env; security notes rewritten. The chat-session refusal stays (spike containment row 6).
- **Phase 7:** the reason for deleting the `bash.patterns` e2e cases.
- **Phase 8:** helpdesk starter sends `/skill:sai-os-helpdesk …` (no forced tool); the output card reads the `office_*` result JSON and falls back to `GenericRenderer`; approvals lose the draft branch and gain office action phrases; `PACK_PINNED_SETTING_KEYS` follows the new `config.yml`; the risk note uses the measured typed and starter numbers.
- **Phase 9:** Task 9.7 step 2 proves "no shell" from the session file instead of a bash deny rule.
- **Phases 2 and 5:** unchanged.

#### Choices made where the decisions left one open
- `config.yml`: drop `task.maxConcurrency` and `tools.approval.task`; keep `task.disabledAgents`; keep `shellPath` and `bash.*` inert, with `bash.patterns` reduced to deny-all (the `office *` allow named a launcher that no longer ships) and `direnv: "off"` quoted.
- Spawn env: stop setting `PATH`, `SAI_ATLAS_OMP`, `SAI_ATLAS_PACK` and `PI_BASH_NO_LOGIN` (nothing reads them), and drop `PI_BASH_NO_LOGIN` from the denylist. Keep `SAI_ATLAS_LANG` and the removal of `BASH_ENV`/`ENV`, because the OS tools start system scripts.
- Office tools keep the spike's static `approval: "write"`; their approval sentence is the generic one with a per-tool action phrase (Phase 8), with no new reason function.

#### Whole-Plan Consistency Sweep
- Searched phases 2–9 and plan.md for `bin/office`, `office/office.js`, `launcher`, `bash`, `find,`, `,find`, `helpdesk.md`, `agents/`, `task,`, `,wait`, `drafts`, `PI_BASH_NO_LOGIN`, `direnv: false`. Every remaining hit is intentional: it states the absence ("no launcher", "no bash tool", "no `agents/` directory"), names the inert `bash.*` keys or the `task.disabledAgents` list, or sits in a historical record (the Office route row's "was", the Red Team table and its sweep, Validation Session 1). `bash scripts/…`/`bash -c` command lines are shell invocations, not the tool. Phase 1 keeps its v1 text as the spike record, under its new Outcome section.
- Unresolved contradictions: none.

### Phase 5 checkpoint — 2026-10-06
**Trigger:** kongming Phase 5 checkpoint after Wave A, with the Wave A code review (`plans/reports/kongming-261006-phase-5-checkpoint.md`, `plans/reports/code-reviewer-261006-wave-a.md`). No user decision re-opened. Changes per phase: `plans/reports/planner-261006-spike-propagation.md` "Phase 5 checkpoint edits".
- Phase 5 finder rules (P5-1, P5-2); Outcome sections in Phases 2–4; the Wave A repair branch, gate and tag; the pinned `plan.*`, `skills.customDirectories`/`includeSkills` and `commands.*` keys (Phase 4 Task 4.7, Phase 6 Task 6.6, Phase 8 Task 8.5); Phase 6 P6-1–P6-4; Phase 9 Task 9.0 (SAI OS confirmation, `QuickEntryTarget` `chat`, `libglib2.0-bin`) and Task 9.5 (worktree-tab CHANGELOG line).
- Unresolved contradictions: none.

### Phase 6 readiness — 2026-10-06
**Trigger:** Opus stand-in counsel for kongming before Wave B (`plans/reports/advisor-standin-261006-phase-6-readiness.md`). No user decision re-opened. Changes per phase: `plans/reports/planner-261006-spike-propagation.md` "Phase 6 readiness edits (Opus stand-in counsel)".
- Phase 6: M1–M6 (CI `build:pack` step and `ci.yml` ownership; stub-first `assistant-pack.ts`; `searchFrom` walk-up in both shells with temp-root tests and partial-pack fixtures; Task 6.7 cargo env and supervisor-free `pgrep`; `sync-upstream.sh` builds the pack before checking it; `index.ts` import lines owned), S1–S9, and a clean-clone run of the CI `tauri-linux` steps between the merge and the `rebrand-wave-b` tag.
- Phase 8: `PACK_PINNED_SETTING_KEYS` gains `skills.ignoredSkills`, and a test reads `assistant-pack/config.yml` and asserts the constant covers every key; Task 8.8's visual check keeps the cargo env.
- Phases 7 and 9: the throwaway-`HOME` `test:e2e:tauri` runs keep the cargo env (same defect as M4).
- Unresolved contradictions: none.
