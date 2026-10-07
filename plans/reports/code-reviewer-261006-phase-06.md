# Code review: Phase 6, spawn wiring in both shells

- Range: `rebrand-p05..582b0ff` in `/home/tung491/WORK/worktrees/rebrand-integration` (commits `ef70720`, `eaf4923`, `0b86f60`; 25 files, +1335/-324).
- Inputs: `phase-06-spawn-wiring.md`, `plan.md` Decisions, the fullstack-developer and advisor-standin reports, `AGENTS.md`.
- Checked against the omp source: `/home/tung491/WORK/oh-my-pi/packages/coding-agent/src` (`cli/args.ts`, `cli/flag-tables.ts`, `main.ts`, `modes/rpc/rpc-mode.ts`).
- Ran: the focused vitest suites (assistant-pack, sidecar, tab-spawn, shell-env, launch-profile, both packaging tests), 137/137 passed. I also ran a `bun -e` probe of `resolveAssistantPackDir` and `stripDenylistedFlags`. I did not run cargo (read-only review); the developer report says it is green.

## Verdict

**No critical or high findings.** The spawn contract is implemented the same way in both shells:
- **Args:** the flags come in the order the spec gives, after the session flags and before the user flags.
- **Env:** `BASH_ENV`/`ENV` are removed and `SAI_ATLAS_LANG` is set last.
- **Pack check:** it runs after the missing-binary check.
- **Chat refusal:** both tab-spawn paths refuse a chat-stamped file.
- **Packaging:** the entries are present.

The launch-profile denylist holds for every form the brief listed:
- `=value` forms;
- short options;
- a bare `--`;
- positional arguments;
- repeated flags;
- case: omp's parser is exact-match and case-sensitive, so `--Tools` is an unknown flag and a hard startup error.

The gaps below are about defence in depth and paths outside `tab:spawn`. None is reachable through a stored launch profile today.

## Critical

None.

## High

None.

## Medium

### M1. Auto-resume can still open a chat-stamped session without the refusal

- **Where:** `src/main/sidecar.ts:328-330`, `src-tauri/src/omp/manager.rs:601-605`, `assistant-pack/config.yml` (no `autoResume` key).
- **What happens:** `--no-auto-resume` is sent only on a fresh tab's first spawn. Every later spawn without `--session` (plain `restart()`, project switch `restart(cwd)`, crash-loop respawns) leaves the user's `autoResume` setting in force.
- **What changed:** omp skipped auto-resume only for `--chat` (`main.ts:1237`: `!parsed.chat && !parsed.noAutoResume && cfgAutoResume.get(...)`). With the chat branch gone, `continueRecent(cwd)` runs on every such respawn.
- **Failure scenario:**
  1. A user turned on Auto Resume, which the settings UI exposes (default off).
  2. Their default workspace's most recent session is a legacy chat-stamped one.
  3. They switch project or restart, or the sidecar crashes once.
  4. omp resumes the chat file. That makes it a restricted session, and omp fails at startup with `Unknown tools in --tools: diagnose, …`. The sidecar crash-loops into an error state with omp's stderr instead of the "start a new task" refusal.
- **Same path, other effects:** it also resumes a session the GUI never checked for F-OWN ownership. That part is older than this phase for agent tabs.
- **Fix (either option):**
  - pin `autoResume: false` in `assistant-pack/config.yml` (Phase 4 file; `check-assistant-pack.ts` will then print its overlay row);
  - or make both shells always push `--no-auto-resume` when no `--session` is passed, which is simpler and needs no config ownership. Add a respawn case to `sidecar.test.ts` and its Rust twin.

### M2. The user-flag filter is a denylist, so every other omp flag gets through

- **Where:** `src/shared/launch-profile.ts:128-157`, `src-tauri/src/omp/manager.rs:205-240`.
- **What passes:** the probe confirmed that `stripDenylistedFlags(["--continue","--alias","--no-ui","--advisor","--allow-home","--no-session"])` returns all six unchanged. In omp:
  - `--continue` resumes the latest session, including a chat-stamped one. It is the same bypass as M1, without the setting.
  - `--alias` writes a shell alias into the user's rc file and exits (`cli.ts:502`). That breaks "nothing is written to `$HOME`".
  - `--no-ui` runs extensions headless (`rpc-mode.ts:1680`), so the pack's tools lose their UI context.
  - `--advisor`, `--model`, `--provider`, `--plan`, `--smol`, `--slow`, `--max-time` and `--allow-home` change session behaviour that the pack does not pin.
- **Positional leak:** omp's string flags consume any successor, even a flag-looking one (`flag-tables.ts:358-360`). The strip function does not model that for flags it keeps. `["--model","--session-dir","/s"]` survives as is; omp reads `--session-dir` as the model, and `/s` reaches it as a positional prompt. That contradicts the spec rule "no value reaches omp as a positional argument".
- **Why Medium, not High:** nothing feeds these flags in production.
  - `extraFlags` is never set (Electron `index.ts`; Rust `tabs/pool.rs:617`).
  - `profileToFlags` / `launch_profile_to_flags` emit only `--no-lsp` and `--session-dir <value>`.
  - The strip function exists as the backstop, and as written it cannot keep up as omp grows its CLI. Any new omp flag is allowed by default.
- **Fix:** in both shells, replace the denylist with an allowlist: keep exactly `--no-lsp` (bare) and `--session-dir <value>` / `--session-dir=<value>`, and drop everything else. That makes `DENYLISTED*` and `VALUED_FLAGS` unnecessary. The existing denylist cases stay as regression tests. Add cases for `--continue`, `--alias x`, `--no-ui`, and `--model --session-dir /s` (expected: `[]` or `["--session-dir","/s"]` with nothing before it).

### M3. A packaged Electron build reads the pack from an env-selected location, and Rust does not

- **Where:** `src/main/index.ts:359-362`, with `resolveBundledOmp` at `src/main/index.ts:85-86`.
- **What happens:**
  1. `OMP_BUNDLED_OMP` is honoured in packaged Electron builds unconditionally.
  2. Phase 6 then also turns on `packSearchFrom = [app.getAppPath(), process.cwd()]` when `OMP_BUNDLED_OMP === bundledOmp`.
  3. So in a shipped Mac app, an env var picks the binary and thereby the pack (`dirname(binary)/assistant-pack`). If that has no pack, the lookup walks up from `process.cwd()`.
- **Parity gap:** Rust gates the same override behind `e2e-hooks` (`paths.rs:237-242`) and only searches outside the bundle under `is_dev() || e2e-hooks` (`manager.rs:498-503`). The spec says "no env var for the pack location" and "no fallback in packaged builds". Electron breaks both.
- **Threat model:** whoever sets the env already picks the binary, so this is not a new privilege. It is a contract and parity gap.
- **Fix (Phase 7 owns `src/main/**`):** honour `OMP_BUNDLED_OMP` only when `!app.isPackaged`, and drop the `|| OMP_BUNDLED_OMP === bundledOmp` arm. Electron e2e runs unpackaged (`out/main/index.js`), so the fixture keeps working.

## Low

### L1. Source mode resolves the pack relative to the main process's cwd

- **Where:** `src/main/assistant-pack.ts:52-53`. `binaryPath` is `""` when `OMP_SIDECAR=source` and no bundled binary exists (`index.ts:366`).
- **What happens:** `join(dirname(""), "assistant-pack")` is the relative path `assistant-pack`. From the repo root that is the pack *source* directory, which exists. So it wins before the `searchFrom` walk. The probe returned `"assistant-pack"` with `package.json` missing.
- **Failure scenario:** in a dev run, the error says to run `bun run build:pack`, but running it changes nothing, because the build writes `resources/assistant-pack`. If the relative directory were complete, the spawn would pass a relative `--extension` that omp resolves against the workspace cwd.
- **Fix:** when `binaryPath` is empty, skip the beside-binary candidate and start at the `searchFrom` walk. The spec's Context section already asks for this.

### L2. Other session-open paths still carry the chat kind and skip the refusal

- **Where:** `src/main/ipc.ts:645-646` and `src-tauri/src/services/ipc.rs:186-190` (`session:open-new-window` still computes `kindFor` and passes `chat` to `spawnWindow`). `src/main/ipc.ts:920-930` (`SIDECAR_RESTART` with a `sessionPath`).
- **Safety still holds:** omp refuses a cross-kind `switch_session` (`rpc-mode.ts:2008-2017`) and fails startup on a chat file passed with these `--tools`.
- **What is wrong:**
  - The pool and manager report `kind: "chat"` for a sidecar that is an agent session.
  - The user gets omp's raw error, "Open the target session in a new tab instead", or a crash loop, instead of `kind-mismatch`.
- **Fix (Phase 7/8):** force `agent` in both `open-new-window` handlers. Refuse a chat file in `SIDECAR_RESTART` the same way `tab:spawn` does.

### L3. Crash-loop respawns reuse the checked pack directory without re-checking it

- **Where:** `src/main/sidecar.ts:591` and the Rust twin.
- **Failure scenario:** the Rust updater runs `apt-get install` while the app runs. A sidecar crash during the file swap respawns against a half-replaced pack. A missing `system-prompt.md` is then read as literal prompt text, the silent case the check exists for.
- **Fix:** call `missingAssistantPackFile(#packDir)` in `#spawn()` too. It is cheap: 8 `stat` calls.

### L4. The Windows Electron package neither builds nor ships the pack

- **Where:** `package.json:25` `package:win` (no `build:pack`), and `electron-builder.win.yml` (no `extraResources` entry).
- **Effect:** every sidecar on a Windows build refuses with "Reinstall Sai ATLAS". This is accepted until Phase 7 drops Windows, but no Windows build should be cut before then.

### L5. Tests that pass for weaker reasons than their names suggest

- `ships the tool list the pack check expects` (`src/main/assistant-pack.test.ts`) checks for only one literal, `office_report`. A reintroduced inline list without that name passes. A stronger version would assert that the script contains none of the tool names except through the import.
- **`spawns_every_sidecar_with_the_assistant_pack_flags_and_never_chat`** (`manager.rs`) reads `/proc/<pid>/environ` with `unwrap_or_default()`. The `BASH_ENV`/`ENV` absence asserts would pass on an unreadable environ. The `SAI_ATLAS_LANG == "en"` assert keeps it honest on Linux, but the test fails outright on macOS. Gate it `#[cfg(target_os = "linux")]`.
- **Packaging tests check the config map, not the built bundle.**
  - Nothing proves the deb/AppImage layout is `usr/lib/Sai ATLAS/assistant-pack/skills/<name>/SKILL.md`, i.e. that the trailing-slash map keeps the directory tree.
  - `e2e-tauri/packaged-smoke.e2e.ts` does not assert the pack flags.
  - A missing pack would show up only indirectly, as a sidecar that is never ready.
  - Suggest that Phase 9's smoke run asserts the packaged sidecar's argv contains `--extension /usr/lib/Sai ATLAS/assistant-pack`, and that `skills/sai-os-helpdesk/SKILL.md` exists there.
- **The Electron e2e path (`searchFrom` from `out/main`) is proven only by unit tests.** This was already noted by the stand-in; it is deferred to Phase 9 Task 9.0.

## Verified correct (no action)

- **Strip semantics against omp's parser:**
  - `--flag=value` is split by omp (`args.ts:615-621`) and dropped whole by the strip.
  - Denylisted valued flags drop their value; a flag-looking successor is examined on its own and is itself dropped or kept by the same rules.
  - There is no prefix abbreviation in omp, and the parser is case-sensitive.
  - `--` and every non-`--` token are dropped.
  - The TS and Rust implementations are line-for-line equivalent, and `strips_denylisted_flags_pair_aware` covers the lists, `=`, `-e`, `-x value` and a bare `--`.
- **Env:**
  - Electron deletes `BASH_ENV`/`ENV` from the merged object, then assigns `SAI_ATLAS_LANG`. Rust calls `env_remove` after the overlay loop, then sets `SAI_ATLAS_LANG`. Both are covered by tests that read the child's env.
  - Both `OVERLAY_DENYLIST`s carry the five keys.
- **Chat refusal at `tab:spawn`:** both shells always use `agent`, and refuse `kind-mismatch` whatever the payload says. The `owned` check runs first.
- **Pack check order:** it runs after the missing-binary check and returns synchronously with no spawn. The TS test asserts no unhandled rejection and no child.
- **Rust dev fallback:**
  - `CARGO_MANIFEST_DIR` is used only under `is_dev()` or `e2e-hooks`.
  - `e2e-hooks` is test-guarded so that no bundle or package script enables it (`tauri-packaging-config.test.ts:278`).
  - `packaged: !tauri::is_dev()` picks the right message.
- **Packaging and CI:**
  - Both mac `extraResources` blocks have the pack entry.
  - `sidecar.conf.json` has the trailing-slash map.
  - `package:tauri:linux` and every `package:mac*` script run `build:pack` first.
  - `ci.yml` `tauri-linux` runs `build:pack` after `bun install` and before clippy and `cargo test`.
  - `sync-upstream.sh` runs `build:pack` and then the check, under `set -euo pipefail`.
- **Parity:** the `omp.parity.json` row was added, and the API snapshots are untouched because the new items are `pub(crate)`.

## Unresolved questions

1. **M1 fix location:** should `autoResume: false` go into the pack's `config.yml` (Phase 4 ownership; also covers the `check-assistant-pack` overlay rows)? Or should both shells always send `--no-auto-resume` when there is no `--session`?
2. **M2 allowlist:** is the allowlist (`--no-lsp`, `--session-dir`) acceptable now? Or should it wait for Phase 8, which removes the launch-profile UI? Phase 8 may make `profileToFlags` emit nothing, in which case the strip function could go entirely.
3. **macOS helpdesk skill:** on macOS, `check-assistant-pack.ts` still expects the four skills, `sai-os-helpdesk` included, while the macOS tool list omits the OS tools that skill drives. Is shipping that skill on macOS intended (Phase 7/9)?
4. **Tauri resource layout:** was a packaged deb/AppImage built and inspected after `0b86f60`? The developer report shows no packaging run, so the trailing-slash layout is unverified until Phase 9.

Status: DONE_WITH_CONCERNS
Summary: Phase 6 matches its spawn contract in both shells, with no critical or high defects. Three medium gaps remain: auto-resume can open legacy chat sessions without the refusal; the flag filter is a denylist that lets other omp flags such as `--continue`, `--alias` and `--no-ui` through (none is reachable in production today); and a packaged Electron build can take its pack location from `OMP_BUNDLED_OMP`, unlike Rust.
Concerns/Blockers: Cargo was not re-run in this review. The packaged bundle layout is unverified until the Phase 9 smoke run.
