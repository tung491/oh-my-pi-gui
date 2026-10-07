# Wave B review fixes

- Branch `rebrand/wave-b-fixes`, cut from `rebrand-wave-b` (`582b0ff`), worktree `/home/tung491/WORK/worktrees/rebrand-fixes-b`. Not merged, tagged or pushed.
- Review: `plans/reports/code-reviewer-261006-wave-b.md`. All six in-scope findings are fixed, each with a red test first and TS/Rust twins under the parity contract. Every gate exits 0.
- Counsel: `kongming` hit the Fable limit (HTTP 429), so a `planner` on opus stood in for the finding 2 design. I checked its claims against the code before using it (details under finding 2).

## Per finding

### 1. High: workspace `APPEND_SYSTEM.md` reached pack sessions (commit `50f653d`)

- **Source check (omp `main.ts:1316`):** `parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile()`, so an explicit flag replaces the lookup. An empty file resolves to `""` (`system-prompt.ts:283-297`), and `applyResolvedSystemPromptInputs` (`main.ts:1273`) skips a falsy append. Nothing else discovers `APPEND_SYSTEM.md`.
- **Fix:**
  - The pack ships an empty `assistant-pack/append-system-prompt.md`.
  - The file is listed in `ASSISTANT_PACK_FILES` (TS and Rust), in the build script's `TEXT_FILES`, and in every test file list.
  - Both shells pass `--append-system-prompt <pack>/append-system-prompt.md`, right after `--system-prompt`.
- **Tests:**
  - `check-assistant-pack.ts` plants `.omp/APPEND_SYSTEM.md` and `.claude/APPEND_SYSTEM.md` with a marker in its working folder. It prints `append  workspace APPEND_SYSTEM.md ignored|reached…` and fails on a leak. Before the fix it printed `PACK LOAD CHECK: FAIL - a workspace APPEND_SYSTEM.md reached the system prompt`.
  - The script now checks the pack with `missingAssistantPackFile` instead of its own four-file list.
  - `compiled.test.ts` asserts the `append … ignored` row. It was red without the flag and green with it.
  - `pack-files.test.ts` asserts the file is empty.
  - The flag and file expectations are updated in `assistant-pack.test.ts`, `sidecar.test.ts`, `build-assistant-pack.test.ts`, `assistant_pack.rs` and `manager.rs`.
  - The denylist-proof spawn twins now require exactly one `--append-system-prompt` (the pack's) and still assert that the profile's text is gone. The exact-argv `toEqual` above them still pins the whole argv.
  - The Rust twin `ships_the_tool_list_the_pack_check_expects` now reads a multi-line import statement, as its TS twin's regex already did. Biome's 120-column limit wraps the new import.

### 2. Medium: chat-stamped sessions on restore and "Open in new window" (commit `d73a093`)

**Fix:**
- **Refusal at the start choke point, both shells.** Before resuming `--session <file>`, the sidecar manager reads the session header synchronously: `isChatStampedSession` / `is_chat_stamped_session`, which mirrors the session index's 32 KiB head and 4 KiB header read. If the file is chat-stamped, it refuses without spawning.
  - The status is `error` and carries the new optional `refusal: "kind-mismatch"` on `SidecarStatusPayload`.
  - The check runs after the missing-binary and missing-pack checks, so install errors still win.
  - Restarting on the same file stays refused. A plain restart (no session path) starts a new task in that tab.
- **Renderer copy.** `use-rpc-events.ts` shows a status with that refusal as `t("sidebar.kindMismatch")`, the key Phase 8 rewrites to "…Start a new task." No locale file changed.
- **Restore.** `restoreLayout` / `restore_layout` acquire every saved tab as `agent`. A tab saved as chat is still restored, shows the refusal when it is shown, and spawns nothing.
- **Electron pool fix.** `#wireFull` used to start the sidecar before attaching its status listener, so a status reported during start (the refusal included) never reached the window. It now starts after wiring. Rust was unaffected, because its events drain through a channel after `full_wired` is set.
- **Open in new window:**
  - The decision moved to `src/main/session-new-window.ts`. Rust stays in `services/ipc.rs`.
  - Order of checks: focus the live owner, then refuse a chat-stamped file, then the cap check, then open.
  - The handler returns `IpcSessionOpenNewWindowResult = boolean | { refusal: "kind-mismatch" }` and passes no session kind to `spawnWindow` / `spawn_window`. The `spawn_window` signature is unchanged.
  - The sidebar, the session switch dialog and `routeToSessionOwner` show the refusal toast.

**Tests:**
- TS↔Rust twins:
  - `reads the chat stamp from the session header`
  - `refuses to resume a chat-stamped session without spawning`
  - `restores tab order, sessions, and the persisted active tab, every tab as an agent` (renamed from `…sessions, kinds, and…`, because the old contract kept the chat kind)
  - `forwards the status a deferred tab reports as it is shown`
  - The four `session-new-window` cases, twinned in `services/ipc.rs`. A new row in `services.parity.json` maps them.
- Renderer: a Sidebar case for the refusal toast, and a `use-rpc-events` case showing the refusal copy.
- In `releases every tab of a closed window` (TS), the window's earlier sends are now cleared before the late event. The initial `starting` status now reaches the window, which is the listener fix. The assertion is still "exactly one forwarded".

**Frozen API.** `ports.rs` gains `SidecarRefusal` and the optional `SidecarStatusPayload::refusal`. `ports.api.txt` was regenerated the same way the gate builds it: 16 added lines, no removals.

**Counsel adopted, after checking the code:**
- `SidecarStatusPayload.message` is documented as "never user-facing copy". A code avoids putting a second copy of the text into main-process i18n.
- The `#wireFull` ordering bug and the `SIDECAR_STATUS_GET` handlers returning only `{status, cwd}` are both real.

**Counsel not adopted:** pool-tracked refusal for the boot status snapshot. That is the status-before-subscribe gap you scoped to Phase 7 Task 7.5b (see the questions at the end).

### 3. Medium: `autoResume` not pinned (commit `1998607`)

- **Setting id:** `autoResume` (`cfgAutoResume`, omp `modes/settings.ts:29`, read at `main.ts:1237`).
- **Fix:** `autoResume: false` in `assistant-pack/config.yml`.
- **Tests:**
  - `pack-files.test.ts` `EXPECTED_CONFIG` was red, then green.
  - `compiled.test.ts` requires `setting autoResume = false [overlay]`; it was red, then green.
  - The check script walks every `config.yml` key, so it reads the new key back with no script change.

### 4. Medium: Electron source-sidecar pack path (commit `46a6b9a`)

- **Fix:** `resolveAssistantPackDir` skips the beside-binary check when the binary path is empty and always returns an absolute path.
  - When nothing is found, it falls back to the beside-binary path, or, for an empty binary path, to the first search root's `resources/assistant-pack`.
  - Rust `resolve_pack_dir` follows the same rule with `std::path::absolute`, which does not follow symlinks, so the worktree-link invariant holds.
- **Test:** `resolves the pack from the search roots when the sidecar runs from source`.
  - The TS test `chdir`s into a folder holding a pack-shaped `assistant-pack/`, as the repo root holds the pack source. Red result: `"assistant-pack"` (relative).
  - The Rust twin cannot change the shared test-process cwd, so it asserts the same contract (resolved through the search roots, absolute, anchored at the cwd) without a decoy.

### 5. Low: `OMP_PROFILE` / `PI_PROFILE` (commit `b931032`)

- **Fix:** one shared list per shell, `ASSISTANT_PACK_REMOVED_ENV` / `assistant_pack::REMOVED_ENV` = `BASH_ENV, ENV, OMP_PROFILE, PI_PROFILE`. It is removed from every spawn env, including values in the app's own `process.env`. The check script's env scrub uses the same list.
- **Tests:** the spawn-env twin feeds `OMP_PROFILE` from the login-shell overlay and, in TS, `PI_PROFILE` from the app env through `vi.stubEnv`. In Rust, both come through the fixed spawn env. Red, then green.

### 6. Low: allowlist for launch-profile flags (commit `71fcb47`)

- **Fix:** `allowedLaunchFlags` / `allowed_launch_flags` keep exactly `--no-lsp` and `--session-dir <value>`.
  - The value of `--session-dir` is data and passes verbatim.
  - These are dropped: `--x=…` spellings, a dangling `--session-dir`, short options, `--`, `--=x`, and stray tokens.
  - The production denylist constants are deleted. Their flag lists now live in the test as negative cases (`PROTECTED_FLAGS`).
- **Tests:**
  - Table cases for `--=x`, `--continue`, `--from-claude`, `--from-codex`, `--advisor`, `--alias`, `--allow-home` and `--model`.
  - A case for the exact allowed spellings.
  - The Rust test is renamed `keeps_only_the_allowed_launch_flags_pair_aware`; it has no TS twin, because `launch-profile.test.ts` has no parity row.

## Gates (worktree, final tree `d73a093`)

| Gate | Result |
|---|---|
| `bun run build:pack` | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx vitest run` | exit 0: 201 files passed, 1 skipped (`visual.test.ts`, environment-gated as before); 1936 tests passed, 5 skipped. `compiled.test.ts` ran |
| `bun run build` | exit 0 |
| `cargo clippy … -D warnings` (pinned toolchain) | exit 0 |
| `cargo test --all-features` | exit 0 (781 + 3 + 3 + 2 passed) |
| Parity loop | exit 0 |
| `bash scripts/check-module.sh snapshots` | `PASS (desktop ollama omp ports services tabs updater)` |
| Biome on `git diff --name-only rebrand-wave-b -- '*.ts' '*.tsx'` | exit 0 (25 files) |
| Biome on `assistant-pack` | exit 0 |
| `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` | `append  workspace APPEND_SYSTEM.md ignored`, `setting autoResume = false  [overlay]`, `PACK LOAD CHECK: PASS` |

No process I started is still running, and no temp directories are left.

## Unresolved questions

1. **Refusal not shown at launch until Phase 7 Task 7.5b.** A restored chat tab that is the active tab at launch is refused (no sidecar runs), but its status is emitted before the page subscribes. The boot snapshot (`SIDECAR_STATUS_GET`) carries only `{status, cwd}`, so that tab shows the generic "process failed" text, not the refusal copy, until Task 7.5b lands. A tab shown after the page has loaded shows the refusal correctly. Task 7.5b's replay or status query should carry the whole last payload, including `refusal`.
2. **Which key Phase 8 rewrites.** I used `sidebar.kindMismatch` for the new refusals, because that is the key Phase 8 rewrites to "Start a new task". The tab-spawn toast still uses `tabs.kindMismatch`, which Phase 8's copy table does not list. Phase 8 should rewrite both or point both paths at one key.
3. **Frozen API change.** `ports.rs` changed additively, with the snapshot regenerated. Phase 7's risk note calls any port change outside its stats stop out of scope, so Phase 7 must rebase onto this snapshot rather than treat the new field as drift.
4. **Project context files.** Resolved by your 2026-10-06 decision; see the follow-up below.

## Follow-up: pack sessions ignore folder instruction files

Decision (2026-10-06): pack sessions skip folder instruction files. This is done through an omp patch, not config, and `--no-rules` stays as well.

| Change | Commit |
|---|---|
| `patches/omp/0002-no-context-files-flag.patch`: the omp flag `--no-context-files` | `457de5f` `build(omp): add a flag that skips instruction files` |
| Both shells pass `--no-rules --no-context-files`; the pack check plants instruction files | `fbf19f6` `fix(spawn): ignore folder instruction files in assistant sessions` |

**First stop (source check).** `--no-rules` only sets `options.rules = []` (`main.ts:1619`). `AGENTS.md`, `CLAUDE.md` and the like are a separate capability, `context-files`, loaded by `discoverContextFiles` at startup (`sdk.ts:1738`) and on every rebuild (`sdk.ts:3659`). No flag could turn that loading off, so the flag alone did not meet the requirement.

**The omp patch (`--no-context-files`):**
- `parseArgs` (`cli/args.ts`) reads it; it is listed in `VALUELESS_FLAGS`, in the prepaint-safe list in `cli.ts`, in launch help, and in `docs/cli-reference.md`.
- `main.ts` sets `options.noContextFiles`. The new `CreateAgentSessionOptions.noContextFiles`:
  - skips startup discovery (`sdk.ts` ~1738) and rebuild discovery (~3659);
  - skips the context files of additional workspace roots, which `buildSystemPromptInternal` loads on its own (`system-prompt.ts` ~755);
  - is forwarded to subagents (`ToolSession` -> `task/structured-subagent.ts` and `vibe/runtime.ts` -> `task/executor.ts`), because a subagent loads context files again for any additional roots.
- `--no-rules` disables nothing the pack needs: the pack ships no rules, and the system prompt, append prompt and skills are separate options. The pack check still finds all four skills and the system prompt.
- **Test:** `packages/coding-agent/test/sdk-no-context-files.test.ts` (in the patch). It plants `AGENTS.md` and `CLAUDE.md` in cwd and its parent, plus a lone `CLAUDE.md` in an additional root; at one depth `AGENTS.md` shadows `CLAUDE.md`, so the lone file is what proves `CLAUDE.md` loads.
  - A control session without the flag loads them; with the flag the system prompt holds none, after startup and after `refreshSkills()`.
  - A parse test checks the flag takes no value.
  - Red before the change: 2 of 3 failed, and the control passed. Green after.
- **Monorepo checks:** `tsgo` type check, oxlint and oxfmt on the touched files are clean.
  - The related suites passed.
  - 30 failures in 18 unrelated files (rpc, browser, worktree, ssh, update-cli) happen identically on the untouched tree, so they predate the change.
  - The natives addon was staged by hand for the test run and removed afterwards.
- **Producing the patch without a monorepo commit:** a temporary index and `git commit-tree` built a dangling commit, then `git format-patch -1`. No ref moved. The monorepo working tree was reverted; its pre-existing `bun.lock` change and `packages/gui/` checkout are untouched.

**Sidecar rebuild:**
- Backup: `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64.pre-context-files` (sha256 `16d066b2…7b76`, `omp/18.4.8`).
- The build must run from a GUI checkout one level below the monorepo's `packages/`: the GUI `tsconfig` refers to `../coding-agent`, so a checkout elsewhere fails `check:protocol`. It ran from a temporary detached worktree at `packages/gui-ctxbuild` (commit `457de5f`), which was removed afterwards.
- `bun run build:omp:linux`: `0001 … already present`, `applied agent patch 0002-no-context-files-flag.patch`, exit 0. The patches were reverted and the monorepo status matches the start.
- After: `omp/18.4.8`, the same version (sha256 `ba603ac0…3332`). `--help` lists `--no-context-files`. The new binary replaced `resources/omp.linux-x64` in the main checkout, which the worktree's links point to. Rollback: copy the `.pre-context-files` file back.

**GUI change:**
- `--no-rules` and `--no-context-files` sit right after `--no-extensions` in `assistantPackFlags` and `pack_flags`.
- **Exact-argv tests (TS and Rust twins), updated first:** `builds the linux/macos pack flags…`, `spawns every sidecar…`, `passes the active session path…`, `forces a freshly created tab…`, `adoptCwd re-roots…`, and the denylist-proof spawn test.
  - Red: 7 TS and 7 Rust failures. Green after the change.
- **Denylist-proof spawn twins:** the smuggled profile flags now include `--no-context-files`. A profile's `noRules: true` and a smuggled `--no-context-files` must leave exactly one copy, the pack's.
- **Allowlist:** both allowlist tests now list `--no-context-files` among the flags a profile cannot pass. The allowlist itself is unchanged.
- **Pack check (`scripts/check-assistant-pack.ts`):**
  - It plants `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md`, each with its own marker, in the working folder and in its parent.
  - It fails when any marker reaches `get_state.systemPrompt`, and prints `context  workspace instruction files ignored|reached the system prompt: <files>`.
  - Red, with the flags taken out of the TS pack flags: `reached the system prompt: work/.github/copilot-instructions.md, parent/AGENTS.md`, then `FAIL`.
  - `compiled.test.ts` asserts the `context … ignored` row.

**Gates (worktree at `fbf19f6`), all exit 0:**

| Gate | Result |
|---|---|
| `bun run build:pack`, `check:types`, `build` | exit 0 |
| `bunx vitest run` | 201 files passed, 1 skipped; 1937 tests passed, 5 skipped. `compiled.test.ts` ran (5 tests) |
| clippy `-D warnings`, `cargo test --all-features` | exit 0; 781 + 3 + 2 + 3 passed |
| Parity loop | exit 0 (omp 47, services 39, tabs 46, …) |
| `check-module.sh snapshots` | `PASS (desktop ollama omp ports services tabs updater)` |
| Biome on changed TS and on `assistant-pack` | clean (after `--write` on `sidecar.test.ts`) |
| Pack load check | `append … ignored`, `context  workspace instruction files ignored`, `setting autoResume = false  [overlay]`, `PACK LOAD CHECK: PASS` |
| `build:omp:linux` patch step | `0001` already present, `0002` applied, then reverted; `0002` still applies to the clean monorepo |

### Open points from the follow-up

1. **The patch lives only in the GUI repo.** Like `0001`, it is not committed to the `nornzach/oh-my-pi` fork. Every sidecar build needs it, and an upstream sync that touches `sdk.ts`, `system-prompt.ts` or the subagent wiring will need a rebase.
2. **Only the Linux sidecar was rebuilt.** The macOS and Windows sidecars (`resources/omp`, `omp.x64`, win) need `build:omp*` again before they ship. An older sidecar fails at start on the unknown `--no-context-files` flag.
3. **The user-level `~/.omp/agent/AGENTS.md` is skipped too.** The flag skips every context file, not only the folder's. Pack sessions run with the user's real HOME, so a user-level `AGENTS.md` no longer reaches them either. This matches "ignore instruction files", but it is broader than "folder" if that word was meant strictly.
