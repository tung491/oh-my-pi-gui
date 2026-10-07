# Red-team review: Sai ATLAS everyday-work rebrand plan

Plan: `plans/261005-0812-everyday-work-rebrand/`. There were four reviewers: Security Adversary, Assumption Destroyer, Failure Mode Analyst, and Scope & Complexity Critic. They raised 37 findings, which reduce to 15 after deduplication. Every finding cites `file:line`, so none was rejected by the evidence filter. Rows marked *(verified)* were re-checked in source by the controller.

| # | Finding | Sev | Reviewers | Disposition |
|---|---|---|---|---|
| 1 | The launcher in `~/.local/share/sai-atlas/bin/office` is a file the model can write and that every build, test and dev run shares. Once one `write` is approved, the bash allow rule runs it with no prompt. | Critical | all four | Accept (needs user choice, see Q2) |
| 2 | The overlay pins only `bash.patterns`. Global and project `tools.approval`, `shellPath` and `extensions` still apply. bash runs a login shell. `PI_CONFIG_FILES` from `process.env` is never stripped. | Critical | Sec, AD, Scope | Accept |
| 3 | `--tools` does not limit helpers. The bundled `task` agent gets every tool, including `eval`, `edit` and `web_search`, and `web_search` is read tier, so it is never prompted. | Critical | Sec, AD | Accept *(verified `task/executor.ts:3638`)* |
| 4 | Extension and skill discovery stays on. `~/.omp/work/.omp/extensions`, plugins and native skills that outrank the pack's skills all load. | Critical | Sec, FMA | Accept *(verified `main.ts:1643-1650`)* |
| 5 | Deleting the app's own command entries brings back omp's `/share`, `/collab`, `/mcp` and others from `availableCommands`, and typed slash text goes to `rpc.prompt`. | Critical | Scope | Accept *(verified `command-registry.ts:1455`, `composer-submit.ts:134`)* |
| 6 | A resumed chat-stamped session stays `chat` and has `restrictToolNames` set, so the pack's tools never load. "No migration" is false. | Critical | AD, FMA | Accept (needs user choice, see Q3) *(verified `main.ts:1593`, `sdk.ts:3273`)* |
| 7 | `bun scripts/check-test-parity.ts` with no module exits 2, so every gate that uses it fails. | High | FMA, Scope | Accept *(verified, exit 2)* |
| 8 | Worktrees have no `resources/omp*` (gitignored). The sidecar-dependent Verify steps fail, and `compiled.test.ts` always skips. | High | AD, FMA | Accept |
| 9 | The `git rebase main` in Task 9.0 flattens the `--no-ff` merges, so "revert the merge commit" breaks. Rollbacks also ignore that later phases depend on earlier ones. | High | FMA, Scope | Accept |
| 10 | The pack check throws inside `#spawn()`, which runs in a `.then()` with no `.catch`, so the tab hangs at "starting". The pack check covers only 2 files. Tests write the real `$HOME`. 11 sidecar tests and 4 tab-spawn tests are not listed. The Rust side must not grow `ports::SidecarOptions`. | High | FMA, AD, Scope | Accept *(verified `sidecar.ts:276-282`)* |
| 11 | Denylist gaps: four parallel lists per shell, valued flags leave their value behind, `-e` is never inspected, `--hook` and `--plan-yolo` are missing, existing launch-profile tests are not listed, and the Launch Profile page keeps fields that no longer do anything. | High | Sec, Scope, FMA | Accept (rejected: replacing the denylist with an allowlist, a redesign beyond scope) |
| 12 | Shell inventories are incomplete. The tray approval radio still writes the global `tools.approvalMode`. 13 more developer menu actions, `tray.rs` and the `MenuAction` type are missed. Windows removal misses many test, `check-module.sh` and `release-feeds.ts` sites plus the `win` block in `electron-builder.yml`. The macOS Tauri pack wiring is wrong and unrequested. | High | AD, Scope, FMA | Accept |
| 13 | File-handling hardening: `open_item` bypasses the existing `openPathTarget` guard. The output card trusts any last-line JSON. Draft detection is a substring match, so `../` passes. The `write` path is hidden. Drafts race and are never deleted. | High | Sec, AD | Accept |
| 14 | The egress audit cannot prove the privacy sentence. It does not trace the Ollama daemon (cloud tags). It runs with no realistic `~/.omp/agent`. It records only host verdicts. It skips URL `read` (`fetch.enabled` defaults to true). | High | Sec, AD | Accept (wording of the sentence: Validation question) |
| 15 | Renderer and executor fixes: the panel default is still `"diff"`. Phase 8 breaks e2e checks that no phase owns. The `bash.patterns` editor no longer does anything. Two command test files are not listed. Image attach needs `fs.readImage`. Two references are wrong (`src/shared/rpc-client.ts:84`, `ipc-types.ts:999`). `ps -C omp` does not match. The spike-gate grep already passes. There are 261 `cmd.*` dynamic keys. | Medium | FMA, Scope, Sec | Accept |

Raised as questions, not findings:
- Project sessions (cwd outside the default workspace) disappear from the merged sidebar. This settles an open question without the user (Q4).
- The macOS category change goes beyond the doc. It goes to Validation.

## Controller verification notes

- `utils/src/procmgr.ts:55-59`: `PI_BASH_NO_LOGIN` switches bash from `-l -c` to `-c`.
- `task/settings.ts:372`: `task.disabledAgents` exists. Discovery is first-wins by agent name, with bundled agents last (`docs/task-agent-discovery.md`), so a pack agent named like a bundled one replaces it.
- `tools/approval.ts:286-305`: a tool `allow` or `prompt` decision returns before the user policy is checked. Otherwise the user `tools.approval` policy wins before the mode.
