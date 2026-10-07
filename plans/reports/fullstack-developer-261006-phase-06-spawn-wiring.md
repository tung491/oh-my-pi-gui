# Phase 6 report: spawn wiring in both shells

Every Phase 6 task (6.0 to 6.7) is done and every gate in Task 6.8 exits 0, including the clean-clone run of the CI `tauri-linux` steps on `rebrand/p06-spawn-wiring`. The branch has not been merged, tagged or pushed. That is left to the orchestrator.

- Worktree: `/home/tung491/WORK/worktrees/rebrand-p06`
- Branch: `rebrand/p06-spawn-wiring`
- Base: `rebrand-p05` (`1f38391`)

## Commits

| Hash | Message | Scope |
|---|---|---|
| `ef70720` | feat(sidecar): load the assistant pack in every session | Electron main process, launch profile, shell env, the pack check script |
| `eaf4923` | feat(tauri): load the assistant pack in every session | Rust manager, `assistant_pack.rs`, tab spawn, shell env, the `omp.parity.json` row |
| `0b86f60` | build: ship the assistant pack with the Linux and macOS packages | `sidecar.conf.json`, both `electron-builder*.yml`, packaging tests, the `ci.yml` `tauri-linux` step, `sync-upstream.sh` |

Every changed file is on the Phase 6 ownership list. No plan file was edited.

## Per task

### 6.0: Worktree

I created the worktree, ran `bun install`, linked `resources/omp.linux-x64` and ran `build:pack`.

Verify: `ls resources/assistant-pack/config.yml resources/assistant-pack/tools.js && test -x resources/omp.linux-x64` exited 0.

### 6.1: TypeScript tests first (red)

I created `src/main/assistant-pack.ts` as stubs with the final signatures, then wrote or updated the tests:

- **`assistant-pack.test.ts`:** the 7 cases, each with the exact `it` name from the spec.
- **`sidecar.test.ts`:**
  - Added `makePackFixture()` and a literal `packFlags()` helper.
  - Replaced the `--chat` case with `spawns every sidecar with the assistant pack flags and never --chat`. Besides the argv, it asserts that `SAI_ATLAS_LANG` is set from `language` and that `BASH_ENV` and `ENV` are removed.
  - Added `surfaces a reinstall instruction when a pack file is missing`. It checks that the status is `error`, that nothing is spawned and that there is no unhandled rejection.
  - The profile case now uses `--tools edit --yolo --config /x -e /y --hook /z`.
  - All 9 `SidecarManager` cases are built with a pack beside the binary. The two `binaryPath: ""` cases are unchanged.
- **`tab-spawn.test.ts`:** the 3 replacement cases.
- **`shell-env.test.ts`:** the overlay case. The existing spawn-env case also needed a pack fixture, otherwise it would fail once the refusal is in place.
- **`launch-profile.test.ts`:**
  - Rewrote the mapping and denylist cases.
  - Added one `it.each` case per new bare flag and per new valued flag, plus the `-e` case and the `-x value` case.

Red: 48 failed and 31 passed. Every failure is in a new or changed case.

### 6.2: TypeScript implementation

- **`assistant-pack.ts`:** the full module. It imports only `node:fs` and `node:path`.
- **`sidecar.ts`:**
  - `--chat` is removed.
  - `start()` checks the pack after the missing-binary check.
  - The pack flags are appended after the session flags.
  - In the env, `BASH_ENV` and `ENV` are deleted, then `SAI_ATLAS_LANG` is set last.
  - New options: `packSearchFrom` and `language` (defaults to `en`).
- **`index.ts`:** passes `packSearchFrom = [app.getAppPath(), process.cwd()]` only when `!app.isPackaged` or `OMP_BUNDLED_OMP === bundledOmp`, and `language: getMainLanguage`.
- **`tab-spawn.ts`:** always `agent`; a chat-stamped file is refused with `kind-mismatch`.
- **`launch-profile.ts`:**
  - All four flag lists are applied.
  - Every non-`--` token is dropped, since no short flag is allowed.
  - `profileToFlags` now emits only `--no-lsp` and `--session-dir`.
- **`shell-env.ts`:** the five keys are added.

The pack check script rewiring (Task 6.6, first bullet) was done here, because the Task 6.1 case `ships the tool list the pack check expects` depends on it.

Verify: the Task 6.1 command reports 79 passed and exits 0. `bun run check:types` exits 0.

### 6.3: Rust tests first (red)

- `assistant_pack.rs` started as `pub(crate)` stubs with the 7 twins, registered in `omp/mod.rs`.
- In `manager.rs`:
  - The chat twin is replaced by `spawns_every_sidecar_with_the_assistant_pack_flags_and_never_chat`, which also reads the omp `/proc` environ.
  - Added `surfaces_a_reinstall_instruction_when_a_pack_file_is_missing`.
  - The profile twin and the exact-argv cases are updated.
  - `strips_denylisted_flags_pair_aware` is extended with all the lists, the `-e` rule, the `-x value` pair, and an assertion that `launch_profile_to_flags` maps only the safe fields.
- `tab_spawn.rs`: the 4 old twins are deleted and the 3 new ones added.
- `shell_env.rs`: the overlay twin.
- `omp.parity.json`: the new row.

Verify:

| Check | Result |
|---|---|
| Parity loop | Exits 0 |
| `cargo test` (red) | Exits 101: 17 failed and 756 passed. Every failure is in a new or changed twin. `ships_the_tool_list_the_pack_check_expects` passes, because the script was already rewired in 6.2. |

The first red run did not compile: `frontendDist ../out/renderer-tauri` was missing. I ran `bun run build:renderer:tauri` (a CI step) and re-ran. This was a missing setup step, not a code change.

### 6.4: Rust implementation

- **`assistant_pack.rs`:** the real logic. `resolve_pack_dir` walks `ancestors().take(8)` from each search root.
- **`manager.rs`:**
  - The flag lists and the strip rule are applied, and `launch_profile_to_flags` mirrors `profileToFlags`. The now-unused `string_list` helper is removed.
  - `start()` checks the pack with `pack_search_from()`, which is `[CARGO_MANIFEST_DIR]` under `tauri::is_dev()` or `e2e-hooks` and empty otherwise. The pack directory is kept in `State`, which is private.
  - `spawn()` appends the flags, removes `BASH_ENV` and `ENV`, and sets `SAI_ATLAS_LANG` from `self.ctx.upgrade().map_or("en", …)`.
- **`tab_spawn.rs`:** always `Agent`; a chat file is refused.
- **`shell_env.rs`:** the five keys.
- **`ci.yml`:** `bun run build:pack` is added to the `tauri-linux` job.

`ports::SidecarOptions` and the API snapshots are unchanged.

Verify (every item exits 0):

| Check | Result |
|---|---|
| `cargo test` | 773 passed |
| clippy `-D warnings` | Clean |
| Parity loop | Exits 0 |
| Snapshots | PASS, no API change |
| `grep build:pack ci.yml` | Line 103 is inside `tauri-linux` (the job starts at line 60), before `cargo test` at line 106 |
| `vitest scripts/tauri-packaging-config.test.ts` | 36 passed |

### 6.5: Packaging, tests first

Red: 2 failed, the Linux resources case and the mac `extraResources` case.

The edits:

- `src-tauri/linux/sidecar.conf.json` gets `"../resources/assistant-pack/": "assistant-pack/"`.
- Both `electron-builder*.yml` get `{from: resources/assistant-pack, to: assistant-pack}`.

`package:mac*` already runs `build:pack` (`package.json`).

Verify: both packaging test files pass, 58 tests.

### 6.6: Pack-load check for upstream syncs

- `scripts/check-assistant-pack.ts`:
  - It imports `assistantPackFlags`, `assistantPackEnv` and `resolveAssistantPackDir`; the inline tool list is gone.
  - The pack directory argument is optional.
  - `--tools` and `--lang` are kept, because `assistant-pack/test/compiled.test.ts` uses them.
  - The checks themselves are unchanged.
- `sync-upstream.sh`: after `build:omp` it runs `build:pack`, then the check against `resources/omp`.

Verify: `bun run build:pack && bun scripts/check-assistant-pack.ts resources/omp.linux-x64` prints `PACK LOAD CHECK: PASS` and exits 0. The output has:

- the 11 tools and the 4 skills;
- an `[overlay]` row for every `config.yml` key, including `bash.direnv = "off"`, `plan.enabled = false` and `plan.defaultOnStartup = false`;
- the `skills.customDirectories`, `includeSkills` and `ignoredSkills` rows, and the four `commands.enable*` rows.

### 6.7: Real-shell check on Linux

**First attempt failed.** The tab stayed on "Connecting" and no sidecar was spawned. Under the Failure Protocol I spawned `kongming`, which failed on a Fable rate limit (HTTP 429), so I spawned an **Opus `planner` as stand-in**.

**The stand-in's diagnosis (not a Phase 6 regression):**

- In a dev build, `paths::resolve_bundled_omp` only looks for `resources/omp`. The worktree had only `resources/omp.linux-x64`.
- So `start()` stopped at the missing-binary check, which is older than this phase, before the pack code ran.
- The renderer never showed that error because it was emitted before the webview subscribed.

**The fix applied** was setup only: `ln -s /home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64 resources/omp`. The path is gitignored and nothing is committed.

**Re-run** with a fresh throwaway HOME and profile, using the spec's command (including the cargo env) on `:99`. The first-run task tab spawned its sidecar.

Verify, all met:

- **The spec's `pgrep` pipeline prints exactly one line:** pid `1883115`, whose parent is the `--omp-supervise` process. Its argv is:

  ```
  --mode rpc-ui --no-auto-resume --no-extensions --extension …/resources/assistant-pack
  --tools read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean
  --system-prompt …/system-prompt.md --config …/config.yml --approval-mode always-ask
  ```

  - The `--tools` value equals the Linux `<TOOLS>` exactly.
  - The `--chat` count is 0.
- **The env grep** prints exactly `SAI_ATLAS_LANG=en`. The app language is en, from the en_US locale with no language pref set. There is no `BASH_ENV` and no `ENV`.
- **`ls $H/.local/share/sai-atlas`** fails ("No such file or directory").

I then closed the app (SIGTERM on my process tree only) and ran `scripts/virtual-display.sh stop`. I also stopped the two private-bus `dbus-daemon`s left over from my two runs, then deleted the throwaway directories.

### 6.8: Gate (no merge)

Every check ran in the worktree at `0b86f60` and exited 0:

| Check | Result |
|---|---|
| `bun run check:types` | 0 |
| `bunx vitest run` | 200 files passed, 1 skipped; 1916 tests passed, 5 skipped |
| `cargo clippy … -D warnings` | 0 |
| `cargo test …` | 773 + 3 + 2 + 3 passed |
| Parity loop | 0 |
| `bash scripts/check-module.sh snapshots` | PASS |
| `bunx biome check` on the 14 touched `ts`/`tsx`/`json` files | 0 |
| `scripts/virtual-display.sh run -- … bun run test:e2e:tauri -- --spec e2e-tauri/runtime.e2e.ts` (throwaway HOME, cargo env) | 1 passing; then `virtual-display.sh stop` |
| Clean clone of `rebrand/p06-spawn-wiring` running the spec's CI block | Last line `exit=0` |

About the clean-clone run:

- `test ! -e` held for both `resources/assistant-pack` and `resources/omp.linux-x64`.
- `build:pack` ran, then the renderer build, clippy, `cargo test` (773 passed), parity and snapshots (PASS).
- Its commands match, in order, the `run:` steps of the `tauri-linux` job after the toolchain install: `bun install`, `build:pack`, `build:renderer:tauri`, clippy, `cargo test`, parity, snapshots.
- The clone was deleted afterwards.

## Deviations and notes

- **Launch-profile cases outside the listed lines.** `launch-profile.test.ts` cases at lines 74, 81, 86 and 112 also asserted that `--append-system-prompt`, `--tools` or `--add-dir` survive. Because `profileToFlags` must stop emitting them, I rewrote these too ("emits no prompt flag…", "emits no --tools flag…", "emits no --add-dir flag…", and line 112 now uses `--session-dir`).
- **Bare `--`.** Both strip functions also drop a bare `--`, since it would turn the flags after it into positional arguments. Both twin tests cover this.
- **Profile denylist test input.** In both shells, the "denylist-proof" profile test feeds `--yolo -e /y --hook /z` through the extra-flags seam, because a stored profile cannot express those flags. The stored profile also holds `noLsp` and `sessionDir`, so the "appends" half is still proven.
- **Pack check script order.** It was rewired in Task 6.2 rather than Task 6.6 (see 6.2).

## Process hygiene

- I started: two `dev:tauri` runs (both stopped), virtual display `:99` (stopped three times, after each use), and one `test:e2e:tauri` run (it exited, and no `tauri-driver` or WebKitWebDriver is left).
- Deleted: every throwaway HOME, profile and clone I created.
- Port 5183 is free, and the worktree is clean apart from the gitignored `resources/omp` link.

## Unresolved questions

1. **Concurrent activity in this worktree.** While I worked, another session ran tests from this worktree (a `sidecar.test` fake-sidecar and a `check-assistant-pack` process). There is also a clone of this branch at `/tmp/tmp.F6ZotxwTGq/gui`, created at 14:52, that I did not make. I left both alone. Please confirm they belong to the orchestrator.
2. **Worktree setup.** The dev-build Tauri lookup reads only `resources/omp`, so any worktree that will run `dev:tauri` needs that link as well as `omp.linux-x64`. The Worktrees section of `plan.md` lists only `omp.linux-x64`. The Phase 8 visual check and the throwaway-HOME `dev:tauri` runs in Phases 7 and 9 will hit the same stall.
3. **Older bugs this run exposed (not Phase 6), from the stand-in's counsel:**
   - A sidecar `error` status emitted before the renderer subscribes is lost, so the UI shows "Connecting" forever instead of the message.
   - The missing-binary and missing-pack refusals are never written to `gui-runtime.jsonl`.

   Together they would hide a real missing-pack failure the same way. Should they go to a later phase or a separate ticket?

Status: DONE_WITH_CONCERNS
Summary: Phase 6 Tasks 6.0 to 6.7 are complete in three commits (`ef70720`, `eaf4923`, `0b86f60`), and every Task 6.8 gate passes, including the clean-clone CI `tauri-linux` check on `rebrand/p06-spawn-wiring`. Nothing was merged, tagged or pushed.
Concerns/Blockers: Task 6.7 first failed because the worktree lacked `resources/omp`, a setup gap that predates this phase. kongming was rate-limited, so an Opus stand-in diagnosed it. Errors emitted before the renderer subscribes are still silently lost, which is an older bug. Another session was active in this worktree.
