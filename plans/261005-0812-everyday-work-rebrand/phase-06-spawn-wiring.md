---
phase: 6
title: "Spawn wiring in both shells"
status: done
priority: P1
effort: "3.5d"
dependencies: [4, 5]
---

# Phase 6: Spawn wiring in both shells

## Goal

Every sidecar the GUI starts (Electron on macOS, Tauri on Linux) is an assistant session:
- it loads only the assistant pack, with fixed flags and a fixed environment;
- office jobs run as the pack's typed tools; no bash tool and no shell launcher exist;
- no launch profile can override any of it;
- no user or project config can override the keys the pack pins;
- an old chat-stamped session is refused with a "start a new task" message;
- the `--chat` branch is gone.

## Context

- Plan index `./plan.md`: Decisions "Office route", "Helpers", "Pinned settings and approval rules", "Chat kind", "Env bypass", "Spike gate result". Red Team Review findings 1–4, 6, 10, 11.
- Spike report `plans/reports/spike-261005-everyday-work-rebrand.md`: the tool list below is the one that loaded and scored 17/20 (v2b); containment row 6 shows a chat-stamped session cannot start with these flags at all (`Unknown tools in --tools: diagnose, system_status, open_item, os_setting`), so the refusal in Tasks 6.2 and 6.4 stays required.
- Spawn args today:
  - `src/main/sidecar.ts:298-307`: `["--mode","rpc-ui"]`, then `--session`/`--no-auto-resume`, then `--chat` at :301, then `stripDenylistedFlags(userFlags)`.
  - Env: `sidecar.ts:318-330` (`...process.env`, shell env, proxy env, `PI_*` keys).
  - Rust `src-tauri/src/omp/manager.rs:525-575`: `--chat` at :550, env at :569-572.
- `#spawn()` runs from a `.then()` with no `.catch` (`sidecar.ts:276-282`). The only clean error path is the missing-binary status check in `start()` (`:257-259`), and every pack check belongs next to it.
- Rust `ports::SidecarOptions` (`src-tauri/src/ports.rs:373-387`) is frozen API (`contracts/ports.api.txt`). Do not add fields to it.
- Pack location: in every layout the pack directory sits beside the sidecar binary:
  - deb: `/usr/lib/Sai ATLAS/{omp,assistant-pack}`;
  - AppImage: `$APPDIR/usr/lib/Sai ATLAS/…`;
  - Electron: `process.resourcesPath/{omp,assistant-pack}`;
  - dev: `resources/{omp.linux-x64,omp,assistant-pack}`.

  So both shells use `dirname(binaryPath)/assistant-pack`. In Electron `OMP_SIDECAR=source` mode (`binaryPath` empty, `src/main/index.ts:116-117`), use `<repo>/resources/assistant-pack`, found by the `searchFrom` walk of Task 6.2 step 1.
- e2e fixture sidecar: both shells honour `OMP_BUNDLED_OMP` (`src/main/index.ts:85-86` unconditionally; `src-tauri/src/paths.rs:238-241` under `e2e-hooks`), and every e2e spec points it at `e2e/sidecar-fixture.ts` (`e2e-tauri/session.ts:30,137`; the `e2e/*.e2e.ts` specs through `OMP_BUNDLED_OMP`). `dirname(binaryPath)/assistant-pack` is then `e2e/assistant-pack`, which does not exist, so without a fallback the pack refusal would stop every fixture launch. This phase cannot edit `e2e/**`, and moving the fixture would break its relative imports, so both shells fall back to `resources/assistant-pack` in dev and e2e builds (Tasks 6.2 and 6.4). There is no env var for the pack location (red team findings 1, 11). The fixture ignores argv, so the pack flags are harmless to it.
- Kind on spawn: `src/main/tab-spawn.ts:34-45`, `src-tauri/src/tabs/tab_spawn.rs:48-60`. The `kind-mismatch` refusal already reaches the user as the `sidebar.kindMismatch` toast (`src/renderer/hooks/use-session-switch.ts:190`, `stores/tabs.ts:390`). Phase 8 rewrites that toast's text.
- Old chat sessions: omp keeps a chat-stamped file `chat` even without `--chat` (`coding-agent/src/main.ts:1593`). It then sets `restrictToolNames`, which registers no extension tools (`sdk.ts:3273`). So the GUI refuses to resume them. This is your decision, recorded in the Red Team Review.
- omp silently treats a missing `--system-prompt` path as literal text (`system-prompt.ts:283-297`). A missing `--config` file is a hard error. Extension entries that are missing are skipped silently (`oh-my-pi/docs/extension-loading.md`). So the shells check the pack's full file list before spawning.
- No bash tool is loaded, so the session starts no shell of its own and `PI_BASH_NO_LOGIN` is no longer set or guarded. The OS tools (`xdg-open`, `gio launch`, `cinnamon-settings`) and `office_clean` (`soffice`) still start system programs, some of them shell scripts, with the sidecar's env, so `BASH_ENV` and `ENV` are still removed.
- `--no-extensions` turns off discovery but keeps explicit `--extension` roots (`coding-agent/src/main.ts:1643-1650`, `docs/task-agent-discovery.md` "explicit-only").
- TS ↔ Rust twins: every new `it()` in `src/main/assistant-pack.test.ts` needs a Rust test named `normalizeTestName(it name)` (`scripts/check-test-parity.ts:21-26`).
- Wave B: runs alone, because it touches files that Phases 7 and 8 also touch.

## Spawn contract (both shells must produce exactly this)

Args, after the session flags and before the user flags:

```text
--no-extensions
--extension <pack>
--tools <TOOLS>
--system-prompt <pack>/system-prompt.md
--config <pack>/config.yml
--approval-mode always-ask
```

`<TOOLS>` on Linux is `read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean`. On macOS it is `read,glob,write,ask,office_report,office_slides,office_clean`. The platform test is `platform === "linux"` for the Linux list; every other value, `win32` included (still reachable until Phase 7 drops Windows), gets the macOS list. `glob` is the file finder (`find` is a semantic search in omp 18.4.8 and fails startup when listed); `bash`, `task` and `wait` are not listed (plan.md Decisions "Office route" and "Helpers").

Env, set last so nothing earlier can replace it:

| Key | Value |
|---|---|
| `SAI_ATLAS_LANG` | `en` or `vi`, the app language at spawn (Electron `getMainLanguage()` in `src/main/i18n.ts`; Tauri `I18n::language()` in `src-tauri/src/i18n.rs:198`); the office tools pick the decimal mark and sheet names from it, the OS tools their approval sentences |
| `BASH_ENV`, `ENV` | removed |

`PATH`, `SAI_ATLAS_OMP`, `SAI_ATLAS_PACK` and `PI_BASH_NO_LOGIN` are not set: nothing in the pack reads them now that there is no launcher and no bash tool. The pack ships no executable, and nothing is written to `$HOME` at spawn.

Launch-profile flags removed from **all** of `DENYLISTED_FLAGS`, `DENYLISTED`, `DENYLISTED_WITH_VALUE` and `VALUED_FLAGS` as appropriate (`src/shared/launch-profile.ts:42-103`; Rust `manager.rs:133-139`):
- **Bare:** `--no-tools`, `--no-extensions`, `--no-skills`, `--auto-approve`, `--yolo`, `--plan-yolo`, `--no-rules`, `--chat`.
- **With a value** (moved out of `VALUED_FLAGS` into `DENYLISTED_WITH_VALUE`, so the value is dropped too): `--extension`, `--hook`, `--tools`, `--system-prompt`, `--system-prompt-template`, `--append-system-prompt`, `--config`, `--approval-mode`, `--skills`, `--plugin-dir`, `--trusted-extension`, `--profile`, `--plan-yolo-into`, `--add-dir`.
- **Short options:** both strip functions pass every token not starting with `--` through unexamined (`launch-profile.ts:114`, `manager.rs:148`). Change them to also drop `-e` and its value, and any token starting with `-` that is not a known allowed short flag. Today no allowed short flag exists, so every `-x` token is dropped. Any token not starting with `--` that is not consumed as the value of an allowed valued flag is dropped too, so the value of a dropped `-x` never reaches omp as a positional argument.

New env keys on both `OVERLAY_DENYLIST`s (`src/main/shell-env.ts:31`, `src-tauri/src/omp/shell_env.rs:28`): `PI_CONFIG_FILES`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` (they redirect omp's config), `BASH_ENV`, `ENV`. These keys stay in `process.env` if the session already had them. That is accepted: `--config` outranks `PI_CONFIG_FILES`, and the pack's `config.yml` pins every key that matters (Phase 4 Task 4.7).

Pack file list (`ASSISTANT_PACK_FILES`, checked before every spawn; it must equal what `scripts/build-assistant-pack.ts` writes):

`package.json`, `tools.js`, `system-prompt.md`, `config.yml`, `skills/word-report/SKILL.md`, `skills/spreadsheet-cleanup/SKILL.md`, `skills/slides-from-report/SKILL.md`, `skills/sai-os-helpdesk/SKILL.md`.

## Ownership

- May create:
  - `src/main/assistant-pack.ts` and `src/main/assistant-pack.test.ts`;
  - `src-tauri/src/omp/assistant_pack.rs`.
- May modify:
  - `scripts/check-assistant-pack.ts` (created by Phase 4 Task 4.9).
  - Electron main: `src/main/sidecar.ts`, `src/main/sidecar.test.ts`, `src/main/index.ts` (only its import lines and the `SidecarManager` construction at :357 and its option values), `src/main/tab-spawn.ts`, `src/main/tab-spawn.test.ts`, `src/main/shell-env.ts`, `src/main/shell-env.test.ts`.
  - Launch profile: `src/shared/launch-profile.ts`, `src/renderer/lib/launch-profile.test.ts`.
  - Rust: `src-tauri/src/omp/manager.rs`, `src-tauri/src/omp/mod.rs`, `src-tauri/src/omp/shell_env.rs`, `src-tauri/src/tabs/tab_spawn.rs`.
  - Contracts and packaging: `src-tauri/contracts/omp.parity.json`, `src-tauri/contracts/tabs.parity.json` (only when the tab-spawn twin row lives there), `src-tauri/linux/sidecar.conf.json`, `electron-builder.yml`, `electron-builder.x64.yml`, `src/main/packaging-config.test.ts`, `scripts/tauri-packaging-config.test.ts`.
  - Scripts: `scripts/sync-upstream.sh`.
  - CI: `.github/workflows/ci.yml` (the `tauri-linux` job only).
- Must not touch: anything else. That includes `src/shared/ipc-types.ts`, `src-tauri/src/ports.rs`, `src-tauri/contracts/*.api.txt` (new Rust items are `pub(crate)`, so snapshots stay unchanged), `src-tauri/macos/**` (macOS ships Electron; the Tauri macOS layout is the Tauri plan's Phase 12), and locales.

## Tasks

### Task 6.0 — Worktree
- Steps: `git -C /home/tung491/WORK/oh-my-pi-gui worktree add -b rebrand/p06-spawn-wiring /home/tung491/WORK/worktrees/rebrand-p06 rebrand/everyday-work && cd /home/tung491/WORK/worktrees/rebrand-p06 && bun install && ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp.linux-x64 && bun run build:pack`
- Verify: `ls resources/assistant-pack/config.yml resources/assistant-pack/tools.js && test -x resources/omp.linux-x64` exits 0.

### Task 6.1 — Tests before (red), TypeScript side
- First create `src/main/assistant-pack.ts` with the final exports and signatures of Task 6.2 step 1 returning wrong values (`ASSISTANT_PACK_FILES = []`, `assistantPackFlags` → `[]`, `assistantPackEnv` → `{}`, `resolveAssistantPackDir` → `""`, `missingAssistantPackFile` → `null`, `missingAssistantPackMessage` → `""`), so every suite loads and only the new or changed cases fail.
- Target files: `src/main/assistant-pack.test.ts` (new), `src/main/sidecar.test.ts`, `src/main/tab-spawn.test.ts`, `src/main/shell-env.test.ts`, `src/renderer/lib/launch-profile.test.ts`.
- Cases. Use these exact `it` names, because the Rust twins reuse them:
  - `assistant-pack.test.ts`:
    - `builds the linux pack flags in order`
    - `builds the macos pack flags without the os tools`
    - `resolves the pack beside the sidecar binary`
    - `resolves the pack under resources for a fixture sidecar outside the tree`
    - `builds the pack env with the session language`
    - `refuses to spawn when a pack file is missing` (table over `ASSISTANT_PACK_FILES`: `missingAssistantPackFile` returns the left-out path; `missingAssistantPackMessage(file, true)` names the file and contains `Reinstall Sai ATLAS`; `missingAssistantPackMessage(file, false)` names the file and contains `bun run build:pack`)
    - `ships the tool list the pack check expects` (reads `scripts/check-assistant-pack.ts` as text, without importing it, since `check:types` has no `Bun` types: it imports `assistantPackFlags` from `src/main/assistant-pack` and contains no inline tool list, i.e. no `office_report` literal)

    Use a temp directory for the pack. No test reads or writes `$HOME`.
  - `sidecar.test.ts`:
    - Replace `spawns a chat sidecar with --chat in the code-controlled argv` (line 53) with `spawns every sidecar with the assistant pack flags and never --chat`. Assert the argv equals `["--mode","rpc-ui","--no-auto-resume", ...]` for a tab created with `kind: "chat"`, where the pack part is written out as a literal array (the six flags of "Spawn contract" with the fixture's pack path and the `<TOOLS>` value for `process.platform`), not as a call to `assistantPackFlags(...)`, so the test does not restate the code it checks.
    - Add `surfaces a reinstall instruction when a pack file is missing`. Status `error` comes from `start()`, nothing is spawned, and there is no unhandled rejection. The fixture creates `assistant-pack/` beside the binary with one listed file left out (not an absent directory), so no fallback applies. Construct it with `packaged: true`.
    - Extend `appends the workspace launch profile flags at spawn, denylist-proof` (line 133). Use a profile containing `--tools edit --yolo --config /x -e /y --hook /z` and assert that no part of it survives, values included.
    - Update the exact-argv `toEqual` assertions at :35 and :49, and every other `new SidecarManager` case in the file (9 in total), to expect the pack flags. The two `binaryPath: ""` cases (`it` at :311 and :329) stay unchanged, because the pack check runs after the missing-binary check (Task 6.2 step 2). Build each with a temp `binaryPath` whose sibling `assistant-pack/` contains the full file list (one shared `makePackFixture()` helper).
  - `tab-spawn.test.ts`:
    - Replace the four chat-kind cases at :47, :56, :65 and :82 with:
      - `spawns an agent session for a chat request`;
      - `refuses a chat-stamped session file with kind-mismatch`;
      - `refuses a chat-stamped session file even when the payload omits kind`.
    - Keep the `owned` case as it is.
  - `shell-env.test.ts`: `drops PI_CONFIG_FILES, PI_CONFIG_DIR, PI_CODING_AGENT_DIR, BASH_ENV and ENV from the login shell overlay`.
  - `launch-profile.test.ts`:
    - Rewrite the cases at :17 (`maps every field to its CLI flag in a fixed order`: only `--no-lsp` and `--session-dir` are still emitted), :91-104, :115-123, :126-137 and :139-150, which today assert that `--tools`, `--config` and `--append-system-prompt` survive. They now assert those flags and their values are dropped.
    - Add one case per new flag (value-aware), one for `-e`, and one where an unknown `-x value` pair is dropped, value included.
- Verify (red): `bunx vitest run src/main/assistant-pack.test.ts src/main/sidecar.test.ts src/main/tab-spawn.test.ts src/main/shell-env.test.ts src/renderer/lib/launch-profile.test.ts` exits non-zero, and the failures are only in the new or changed cases.

### Task 6.2 — Implement the TypeScript side
- Steps:
  1. In `src/main/assistant-pack.ts`, export:
     - `ASSISTANT_PACK_FILES`;
     - `resolveAssistantPackDir(binaryPath, searchFrom: readonly string[] = [])`: `join(dirname(binaryPath), "assistant-pack")` when that directory exists (never `realpath` the binary first: a worktree's `resources/omp.linux-x64` is a symlink into the main checkout). Otherwise it returns the first `<dir>/resources/assistant-pack` that exists, where `<dir>` is each `searchFrom` entry or one of its ancestors up to 8 levels, the same walk `resolveBundledOmp` does (`src/main/index.ts:93`). When nothing is found it returns the beside-binary path, so the missing-file message names it. `src/main/index.ts` passes `searchFrom = [app.getAppPath(), process.cwd()]` only when `!app.isPackaged` or `process.env.OMP_BUNDLED_OMP === bundledOmp`, so a packaged build with its own binary never looks outside its resources. The manager receives it as a new optional `SidecarManagerOptions.packSearchFrom`;
     - `assistantPackFlags(packDir, platform)`: the Linux `<TOOLS>` when `platform === "linux"`, the macOS list for every other value;
     - `assistantPackEnv({ language })`: returns the keys the env table sets (`{ SAI_ATLAS_LANG }`);
     - `missingAssistantPackFile(packDir)`: returns the first missing relative path or `null`;
     - `missingAssistantPackMessage(file, packaged)`, mirroring `missingSidecarMessage(packaged)` (`src/main/sidecar.ts:183`): both name the missing file; packaged builds say `Reinstall Sai ATLAS`, dev builds say to run `bun run build:pack`.

     The module imports only `node:path` and `node:fs` (no `electron`), because `scripts/check-assistant-pack.ts` (Bun) and the vitest suite both load it.
  2. In `sidecar.ts`:
     - delete line 301 (`--chat`);
     - in `start()`, directly after the missing-binary check (so the `binaryPath: ""` cases keep their message), resolve the pack with `resolveAssistantPackDir(binaryPath, options.packSearchFrom)`, and when `missingAssistantPackFile` returns a path, set `#setStatus("error", missingAssistantPackMessage(file, !!this.#options.packaged))` and return;
     - in `#spawn()`, push `...assistantPackFlags(...)` after the session flags, and spread `assistantPackEnv(...)` last in `env`, after deleting `BASH_ENV` and `ENV` from the merged object;
     - add an optional `language?: () => "en" | "vi"` to the manager options, defaulting to `"en"` when absent (the existing cases need no change for it, mirroring Rust's `Weak::new()` default), and pass `getMainLanguage` from `src/main/index.ts:357`.
  3. In `tab-spawn.ts`:
     - the spawned kind is always `"agent"`;
     - when `sessionPath` is set and `fileKind === "chat"`, return `{ tabId: null, refusal: "kind-mismatch" }` whatever the payload says;
     - keep the `SessionKind` type.
  4. In `launch-profile.ts`:
     - apply the flag lists above to all four sets;
     - make `stripDenylistedFlags` drop short options and unconsumed non-`--` tokens as specified;
     - `profileToFlags` (`launch-profile.ts:148-176`) stops emitting every denylisted flag (the `LaunchProfile` fields stay so stored prefs parse; Phase 8 removes their UI); the invariant case at `launch-profile.test.ts:139` (`profileToFlags can never emit a denylisted flag…`) is the guard.
  5. In `shell-env.ts`, add the five keys to `OVERLAY_DENYLIST`.
- Verify: the Task 6.1 command exits 0; `bun run check:types` exits 0.

### Task 6.3 — Tests before (red), Rust side
- Target files:
  - `src-tauri/src/omp/assistant_pack.rs` (new, with `#[cfg(test)] mod tests`, every item `pub(crate)`, registered in `omp/mod.rs`);
  - the tests in `manager.rs`, `tab_spawn.rs` and `shell_env.rs`;
  - `src-tauri/contracts/omp.parity.json`: add `{"ts":"src/main/assistant-pack.test.ts","rust":"src-tauri/src/omp/assistant_pack.rs"}`.
- First write `pub(crate)` stubs with the final signatures that return wrong values (an empty `Vec`, `None`), so the crate compiles and only the new tests fail.
- Test function names: `normalizeTestName` of each TS `it` name from Task 6.1, for example `builds_the_linux_pack_flags_in_order`. Replace `spawns_a_chat_sidecar_with_chat_in_the_code_controlled_argv` (manager.rs:1110) with `spawns_every_sidecar_with_the_assistant_pack_flags_and_never_chat`. Update `appends_the_workspace_launch_profile_flags_at_spawn_denylist_proof` (manager.rs:1174; its assertion at :1202 expects `--append-system-prompt`, `--no-rules`, `--add-dir` and `--tools read,bash` to survive) to the expectations of its TS twin at `sidecar.test.ts:133`. `assistant_pack.rs` gains `resolves_the_pack_under_resources_for_a_fixture_sidecar_outside_the_tree` with the other twins; it passes a temp root as `search_from`, never the repo.
- Delete the Rust twins of the four replaced `tab-spawn.test.ts` cases (`tab_spawn.rs:149` `refuses_an_explicit_chat_payload_against_an_agent_file_i3_reject_never_degrade`, `:159` `refuses_an_explicit_agent_payload_against_a_chat_file`, `:169` `spawns_with_the_file_s_kind_when_the_payload_omits_it_file_is_authoritative`, `:178` `acquires_with_the_requested_kind_when_it_matches_the_file`) and of `spawns a chat sidecar…` (`manager.rs:1110`); they pass at red and would fail at green. Add their replacements under the `normalizeTestName` of the Task 6.1 names.
- In `manager.rs` add `surfaces_a_reinstall_instruction_when_a_pack_file_is_missing` (`sidecar.test.ts` maps to `manager.rs` in `omp.parity.json`), built like its TS twin: `assistant-pack/` beside the binary with one listed file left out, not an absent directory, and a packaged build.
- Extend `strips_denylisted_flags_pair_aware` (`manager.rs:1090`) with the new flag lists, the `-e` rule and the dropped `-x value` pair: `launch-profile.test.ts` has no parity row, so this is what forces the Rust strip function to match.
- Verify (red), all three:
  - The parity loop (`plan.md` "Shared commands") exits 0, which shows the names match.
  - `bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features'` exits non-zero.
  - Its output lists as failed only tests whose names appear in Task 6.1 or in this task (the extended `strips_denylisted_flags_pair_aware` included).

### Task 6.4 — Implement the Rust side
- Steps:
  - **`assistant_pack.rs`:** replace the stubs, mirroring Task 6.2 step 1. `resolve_pack_dir(binary: &Path, search_from: &[PathBuf]) -> PathBuf` uses the same rule. The manager passes `&[PathBuf::from(env!("CARGO_MANIFEST_DIR"))]` when `tauri::is_dev()` or `cfg!(feature = "e2e-hooks")`, and `&[]` otherwise. Tests pass temp roots.
  - **`manager.rs`:**
    - delete the `--chat` push at :550;
    - apply the flag lists at :133-139 and the short-option rule in the strip function at :148;
    - before spawning, after the missing-binary check, check the pack (`resolve_pack_dir(binary_path, search_from)`) and take the same error path as a missing binary, with the message rule of Task 6.2 step 1;
    - append the flags, and set the env table last.
  - **Language:** `spawn` is on `Inner`, so read `self.ctx.upgrade().map_or("en", |ctx| ctx.i18n.language().code())` (`manager.rs:559` reads `self.ctx`; `MainLanguage::code` at `src-tauri/src/i18n.rs:17`), at spawn time next to the `launch_profile_flags` call (helper defined at `manager.rs:227`). The `en` default covers a context gone at shutdown. Do not add a field to `ports::SidecarOptions`.
  - **`tab_spawn.rs`:** always `SessionKind::Agent`, and refuse a chat-stamped file with `kind-mismatch` as in Task 6.2 step 3.
  - **`shell_env.rs`:** add the five env keys.
  - **CI:** in `.github/workflows/ci.yml`, job `tauri-linux`, add `- run: bun run build:pack` directly after its `bun install --frozen-lockfile` step. Rust tests that spawn the e2e fixture (`manager.rs`, `omp/ipc.rs`, `omp/shell_env.rs`) find the pack through the dev fallback, and `resources/assistant-pack` is gitignored.
- Verify, each exiting 0:
  - `cargo test` (the command above);
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` (same env prefix);
  - the parity loop;
  - `bash scripts/check-module.sh snapshots`, with no API change;
  - `grep -n 'build:pack' .github/workflows/ci.yml` shows the line inside the `tauri-linux` job, before `cargo test`;
  - `bunx vitest run scripts/tauri-packaging-config.test.ts` (its CI-job case parses `ci.yml`).

### Task 6.5 — Packaging (test first)
- Steps:
  1. Tests before:
     - In `scripts/tauri-packaging-config.test.ts`, assert that `src-tauri/linux/sidecar.conf.json` `bundle.resources` contains exactly the entry `"../resources/assistant-pack/": "assistant-pack/"` (trailing slashes on both sides; a glob key flattens the skill folders) beside the existing `omp` entry.
     - In `src/main/packaging-config.test.ts`, assert that the `extraResources` of `electron-builder.yml` and `electron-builder.x64.yml` contain `{ from: "resources/assistant-pack", to: "assistant-pack" }`.
     - Run them: red.
  2. Edit those three config files.
- Verify: `bunx vitest run scripts/tauri-packaging-config.test.ts src/main/packaging-config.test.ts` exits 0.

### Task 6.6 — Pack-load check for upstream syncs
- Target files: `scripts/check-assistant-pack.ts`, `scripts/sync-upstream.sh`.
- Steps:
  - Phase 4 Task 4.9 created `scripts/check-assistant-pack.ts` with an inline flag builder and tool list. Replace them with `resolveAssistantPackDir`, `assistantPackFlags` and `assistantPackEnv` from `src/main/assistant-pack.ts`; the pack-dir argument becomes optional and defaults to `resolveAssistantPackDir(<omp binary>)`. Keep its checks (tools, skills, system prompt, agents, settings value plus provenance, startup frames) unchanged.
  - The Task 6.1 case `ships the tool list the pack check expects` and its Rust twin `ships_the_tool_list_the_pack_check_expects` (parity rule) guard against a second tool list reappearing in the script.
  - In `sync-upstream.sh`, right after the `build:omp` step (`sync-upstream.sh:69-70`), run `bun --cwd="$GUI" run build:pack` and then `bun --cwd="$GUI" scripts/check-assistant-pack.ts resources/omp` (the binary that step just wrote on the build host). `resources/assistant-pack` is gitignored, so the script must build it before checking it.
- Verify: `bun run build:pack && bun scripts/check-assistant-pack.ts resources/omp.linux-x64` exits 0 and prints the tool names, the skill names and one `overlay` row per `config.yml` key, `bash.direnv` reading `off`, `plan.enabled` and `plan.defaultOnStartup` reading `false`, and one row each for `skills.customDirectories`, `skills.includeSkills`, `skills.ignoredSkills`, `commands.enableClaudeUser`, `commands.enableClaudeProject`, `commands.enableOpencodeUser` and `commands.enableOpencodeProject`.

### Task 6.7 — Real-shell check on Linux
- Steps:
  1. Run on the virtual display with a throwaway profile and a throwaway home:

     ```sh
     H=$(mktemp -d)
     scripts/virtual-display.sh run -- env CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup" CARGO_HOME_BIN="$HOME/.cargo/bin" HOME="$H" bun run dev:tauri -- --user-data-dir=$(mktemp -d)
     ```

     The cargo variables keep the real toolchain: `scripts/rust-pins.env` derives `CARGO_HOME_BIN` from `$HOME`, and `scripts/tauri-dev.ts:67-75` fails with `CARGO_TAURI_MISSING` without it.
  2. Open one task.
  3. Check the sidecar with `pgrep -af -- '--mode rpc-ui' | grep -- '--extension' | grep -v -- '--omp-supervise'` (prints exactly one line: the omp stats server lacks `--extension`, and the supervisor, whose argv carries omp's full argv on Linux (`manager.rs:241-247, 271-274`), carries `--omp-supervise`) and `tr '\0' '\n' < /proc/<pid>/environ | grep -E '^(SAI_ATLAS_|BASH_ENV=|ENV=)'`.
  4. Close the app and run `scripts/virtual-display.sh stop`.
- Verify:
  - the argv contains `--no-extensions`, `--extension`, `--config` and `--approval-mode always-ask`, the value after `--tools` equals the Linux `<TOOLS>` exactly, and the argv does not contain `--chat`;
  - the env grep prints exactly one line, `SAI_ATLAS_LANG=en` or `SAI_ATLAS_LANG=vi` matching the app language (no `BASH_ENV`, no `ENV`);
  - `ls $H/.local/share/sai-atlas` fails, because nothing is written to home.

### Task 6.8 — Gate and merge
- Verify, each exiting 0:
  - `bun run check:types`, `bunx vitest run`;
  - `cargo clippy …`, `cargo test …`;
  - the parity loop, `bash scripts/check-module.sh snapshots`;
  - biome on the touched files;
  - `scripts/virtual-display.sh run -- bun run test:e2e:tauri -- --spec e2e-tauri/runtime.e2e.ts` (one fixture spec proves the launch path; Phase 9 Task 9.0 owns the rest), then `scripts/virtual-display.sh stop`.
- Commits: `feat(sidecar): load the assistant pack in every session` (TS), `feat(tauri): load the assistant pack in every session` (Rust), `build: ship the assistant pack with the Linux and macOS packages` (it also carries the `ci.yml` and `sync-upstream.sh` steps).
- Merge: `git -C /home/tung491/WORK/worktrees/rebrand-integration merge --no-ff rebrand/p06-spawn-wiring`.
- CI check in a clean clone, after the merge and before the tag. This reproduces the `tauri-linux` job (`.github/workflows/ci.yml`), which has no sidecar binary and no built pack:

  ```sh
  C=$(mktemp -d) && git clone --branch rebrand/everyday-work /home/tung491/WORK/oh-my-pi-gui "$C/gui" && ( cd "$C/gui" \
    && test ! -e resources/assistant-pack && test ! -e resources/omp.linux-x64 \
    && bun install --frozen-lockfile && bun run build:pack && bun run build:renderer:tauri \
    && bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings && PATH="$CARGO_HOME_BIN:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features' \
    && for p in src-tauri/contracts/*.parity.json; do bun scripts/check-test-parity.ts "$(basename "$p" .parity.json)" || exit 1; done \
    && bash -c 'source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH" bash scripts/check-module.sh snapshots' ); echo "exit=$?"
  ```

  Verify: the last line printed is `exit=0`, and its `run:` commands are, in order, the `run:` steps of the `tauri-linux` job after its toolchain-install step (`grep -n 'run:' .github/workflows/ci.yml` in the clone to compare). Then `rm -rf "$C"`.
- Tag, only when the check above exits 0: `git -C /home/tung491/WORK/worktrees/rebrand-integration tag rebrand-wave-b`.

## Security considerations

- There is no bash tool. Office jobs are typed tools that run inside the sidecar and write only new files under Documents > Sai ATLAS (spike containment: `name: "../../escape"` stayed inside it). The overlay still pins `shellPath` and a deny-all `bash.patterns` as an inert guard.
- There is no `task` tool, so no helper session can start and agent files planted in a project or user `.omp/agents` directory have nothing to load them (spike containment row 1); `task.disabledAgents` stays pinned anyway.
- The overlay is the only place the pack's rules live. The user's `~/.omp/agent/config.yml` is never written.
- Every `write` and every office job asks for approval (`tools.approval`, spike containment row 5); Phase 8 shows a `write`'s full path in the approval sentence.

## Risks and rollback

- A dev run without `bun run build:pack` refuses to spawn. That is intended, and the error says what to run.
- Rollback: `git reset --hard rebrand-p05` on the integration branch, before Wave C exists. After Wave C, Phases 7 and 8 must be reverted with it, because Phase 8's starter cards call the pack's skills.

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
