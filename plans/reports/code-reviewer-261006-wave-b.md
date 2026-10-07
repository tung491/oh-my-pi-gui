# Code review: Phase 6 spawn wiring (Wave B)

- Diff: `git diff rebrand-p05..582b0ff` in `/home/tung491/WORK/worktrees/rebrand-integration` (ef70720 TS, eaf4923 Rust, 0b86f60 packaging/CI/sync).
- Spec: `plans/261005-0812-everyday-work-rebrand/phase-06-spawn-wiring.md`, `plan.md`.
- Line numbers below are at `582b0ff`. omp line numbers are in `/home/tung491/WORK/oh-my-pi/packages/coding-agent/src`.
- Already routed, not repeated: a status emitted before the webview subscribes is lost and refusals are not logged (Phase 7 Task 7.5b); worktrees need a `resources/omp` link.

## Checks I ran

| Check | Result |
|---|---|
| `bunx vitest run` on the 7 touched suites (assistant-pack, sidecar, tab-spawn, shell-env, launch-profile, both packaging tests) | 137 passed |
| `cargo test --all-features`, filtered to the new and changed twins | 24 passed (I built `out/renderer-tauri` first, which is gitignored) |
| Parity loop over `src-tauri/contracts/*.parity.json` | exit 0 |
| `bunx biome check` on the 12 touched TS files | clean |
| Live probe: `resources/omp.linux-x64` started with `assistantPackFlags(pack, "linux")`, a throwaway HOME, and a cwd holding `.omp/APPEND_SYSTEM.md`, then `get_state` | the project marker **is** in `systemPrompt` (finding 1) |

## Findings

### 1. High: a workspace's `APPEND_SYSTEM.md` is appended to the pack's system prompt

- **Where:**
  - The spawn contract: `src/main/assistant-pack.ts:69-85` and `src-tauri/src/omp/assistant_pack.rs:55-74`.
  - The omp code that does it: `main.ts:1316` runs `const appendPromptSource = parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile();`. That discovery (`main.ts:1252`, `config.ts:128-156`) looks in the project's `.omp`, `.claude`, `.codex` and `.gemini` folders and in the user config dirs.
- **The gap:** `--system-prompt` only switches off `SYSTEM.md` discovery (`main.ts:1307-1310`). It does not stop `APPEND_SYSTEM.md` discovery. The pack passes no `--append-system-prompt`, and the launch-profile denylist drops any user one, so discovery always runs.
- **Failure scenario:** the user opens a folder as a workspace, for example an unpacked zip in Documents or a colleague's project. If it contains `.omp/APPEND_SYSTEM.md` or `.claude/APPEND_SYSTEM.md`, that text becomes part of every pack session's system prompt.
  - Verified live: the probe above returned the project marker inside `get_state.systemPrompt`.
  - This breaks the phase goal "loads only the assistant pack, with fixed flags" and the question "a different system prompt". It sits in neither shell's spawn contract nor in the pack check script, so `check-assistant-pack.ts` (which uses an empty scratch cwd) cannot catch it.
- **Fix:** have both shells pass a pack-owned append prompt so discovery never runs. For example, ship an empty `<pack>/append-system-prompt.md`, add it to `ASSISTANT_PACK_FILES` and the build script, and add `--append-system-prompt <pack>/append-system-prompt.md` to `assistantPackFlags` / `pack_flags`.
  - Note that omp reads a missing path as literal text (`system-prompt.ts:283-297`), so the file has to be on the pre-spawn file list.
  - Then add a case to `check-assistant-pack.ts` that seeds `<cwd>/.omp/APPEND_SYSTEM.md` and asserts the marker is absent.
  - Separately, decide whether project context files (`AGENTS.md`/`CLAUDE.md`, which `--no-rules` would skip) are meant to reach pack sessions. I did not test that path.

### 2. Medium: chat-stamped sessions reach a pack sidecar through paths that skip the `tab:spawn` refusal

- **Where the refusal lives:** only in `src/main/tab-spawn.ts:42` and `src-tauri/src/tabs/tab_spawn.rs:55`.
- **Paths that cold-start a sidecar on a session file without it:**
  - **Saved-layout restore.** `src/main/sidecar-pool.ts:699` `restoreLayout` and `src-tauri/src/tabs/pool.rs:961` `restore_layout` acquire `tab.sessionPath` with `tab.kind`, and `#ensureStarted` then spawns `--session <file>` plus the pack flags.
    - Scenario: the user upgrades with a chat tab open. On next launch that tab's sidecar resumes the chat file. omp sets `restrictToolNames` for chat-stamped files (`main.ts:1593-1597`), the pack's extension tools are not registered, and startup fails (`Unknown tools in --tools: …`, spike containment row 6).
    - The user sees crash, restart, then a generic error, not the "start a new task" refusal the phase requires.
  - **Open in new window.** `src/main/ipc.ts:645` and `src-tauri/src/services/ipc.rs:186-190` still look up the file's kind and pass it to `spawnWindow`.
    - The sidecar now spawns as a pack session whatever that kind is, but the pool entry records `chat`.
    - The boot `switch_session` is refused by omp's kind guard (`modes/rpc/rpc-mode.ts:2007-2017`), so this fails closed, but with the old toast and a pool entry whose kind no longer matches its process.
- **Fix:** apply the same `kindFor === "chat"` refusal wherever a session path becomes a sidecar:
  - In restore, drop the session path, or skip the tab and surface the refusal.
  - In both `SESSION_OPEN_NEW_WINDOW` handlers, return the refusal instead of spawning.
  - Stop passing a file kind into `spawnWindow`/`acquire` so no pool entry claims `chat`.
  - Twin-test each path.

### 3. Medium: `autoResume` is not pinned, so a sessionless non-fresh spawn resumes whatever omp picks

- **Where:**
  - `src/main/window-spawn-target.ts:26-31` returns `fresh: false` for every explicit workspace or session window: new window on a folder, open in new window, launch argv, deep link.
  - So `src/main/sidecar.ts:328-330` passes neither `--session` nor `--no-auto-resume`.
  - omp then runs `continueRecent(cwd)` when `autoResume` is on (`main.ts:1237-1243`).
  - `autoResume` is a user setting exposed in the schema-driven settings UI (`modes/settings.ts:29-39`; GUI `schema-vi.ts:485`), and the pack's `config.yml` does not set it.
- **Failure scenario:** a user who turned Auto Resume on opens a folder in a new window. omp silently resumes the newest session in that folder. If that session is chat-stamped, startup fails as in finding 2. If it is a pre-rebrand coding session, its history (bash calls and so on) is loaded into a pack session, which the GUI's session-kind checks never saw.
- **Fix:** pin `autoResume: false` in `assistant-pack/config.yml` (Phase 4's file, so it needs routing) and add its row to `check-assistant-pack.ts`. Or have both shells always pass `--no-auto-resume` when no `--session` is given. Pinning is simpler and covers every spawn path.

### 4. Medium: in Electron source-sidecar mode the pack resolves relative to the main process's cwd

- **Where:** `src/main/assistant-pack.ts:53` with `src/main/sidecar.ts:278-284`.
- **The gap:** with `OMP_SIDECAR=source` and no built sidecar, `binaryPath` is `""`, which `start()` allows when `sourceCli` is set. Then `join(dirname(""), "assistant-pack")` is the relative path `"assistant-pack"`.
- **Failure scenario:** `bun run dev` runs from the GUI repo root, where `assistant-pack/` is the pack **source** folder (no `package.json`, no `tools.js`). So the beside-binary branch wins and the start refuses with "missing package.json. Build it with `bun run build:pack`". Running that command does not help, because the built pack is in `resources/assistant-pack`.
  - If a relative directory did pass the check, the flags would carry relative paths that omp resolves against the session cwd (the workspace), not the main process's cwd. A missing `--system-prompt` path is then read as literal text, which is exactly what the pre-spawn check exists to prevent.
  - The spec (Context, "Pack location") says source mode must use `<repo>/resources/assistant-pack` through the search walk.
  - The Rust side never has an empty binary path, so this is also a TS-only behaviour gap.
- **Fix:** in `resolveAssistantPackDir`, skip the beside check when `binaryPath` is empty, and `resolve()` the result to an absolute path. Add a test with `binaryPath: ""` and a `searchFrom` root.

### 5. Low: `OMP_PROFILE` / `PI_PROFILE` from the login shell still redirect omp's agent dir

- **Where:** `src/main/shell-env.ts:53-59` and `src-tauri/src/omp/shell_env.rs:34-37`.
- **The gap:** `PI_CODING_AGENT_DIR` is now dropped from the overlay. But omp activates `OMP_PROFILE`/`PI_PROFILE` at startup (`cli.ts:492-500`), and `setProfile` then sets `process.env.PI_CODING_AGENT_DIR` to the profile's agent dir (`packages/utils/src/dirs.ts:565-570`).
- **Scenario:** `export OMP_PROFILE=work` in `~/.bashrc` reaches the sidecar through the overlay. The session then reads that profile's user config, user `APPEND_SYSTEM.md` and models, which is the same redirect the new denylist entries were added to block. The `--profile` flag is denylisted, but its env equivalent is not.
- **Fix:** add `OMP_PROFILE` and `PI_PROFILE` to both `OVERLAY_DENYLIST`s and to the env scrub in `check-assistant-pack.ts`, with a twin test.

### 6. Low: the strip function is still a denylist while only two flags can legitimately pass

- **Where:** `src/shared/launch-profile.ts:129-157` and `src-tauri/src/omp/manager.rs:205-239`.
- **Today's producers:** `profileToFlags` / `launch_profile_to_flags` emit only `--no-lsp` and `--session-dir`, and `extraFlags` has no production caller. So nothing below is reachable today.
- **What still passes the strip:** omp flags that change what a session loads or resumes, including `--continue`, `--from-claude`, `--from-codex`, `--alias`, `--advisor` and `--allow-home` (omp `cli/args.ts:244-280`).
- **The `--=x` case:** the token `--=x` parses as the name `--`, which is not denylisted, so it survives. omp splits it into `--` plus a value (`args.ts:194-201`) and treats the `--` as end-of-options (`args.ts:316`). That defeats the new bare-`--` rule, and its value and every flag after it become positional messages.
- **Fix:** replace the denylist with an allowlist (`--no-lsp`; `--session-dir` plus its value) in both shells, keeping the current tests as the negative cases. Also add `--=x` to both test tables.

### 7. Low (informational): a Windows Electron build now refuses every session

- **Where:** `electron-builder.win.yml:10-12` and `package.json` `package:win`.
- **The gap:** the Windows config ships no `assistant-pack`, and `package:win` does not run `build:pack`. Since `start()` refuses a missing pack, any Windows build made between Wave B and Phase 7 (which deletes Windows) shows "Reinstall Sai ATLAS" on every tab.
- **Fix:** none needed if no Windows build is cut before Phase 7. Otherwise mirror the mac `extraResources` entry. This file is outside Phase 6 ownership, so it is noted rather than counted against the phase.

## Questions asked of the review

1. **Containment.**
   - Launch-profile fields: only `noLsp` and `sessionDir` map, and the tests prove it in both shells.
   - Flag spellings: `--x=…`, `-e`, unknown short options, bare `--` and duplicate valued flags are dropped. The exception is `--=x` (finding 6), which no producer can emit today.
   - `BASH_ENV`/`ENV` are removed last in both shells, and `/proc` environ is checked in the Rust test.
   - Residual paths: `APPEND_SYSTEM.md` (finding 1), the unpinned `autoResume` (finding 3), cold resumes of chat files (finding 2) and the profile env (finding 5).
   - Packaged fallback:
     - Electron searches outside the bundle only when `OMP_BUNDLED_OMP` names the binary in use, and an attacker who can set that env var already chooses the binary.
     - Tauri searches only under `is_dev()` (that is, no `custom-protocol` feature) or `e2e-hooks`. `tauri-packaging-config.test.ts:278` guards that no bundle enables `e2e-hooks`.
2. **Parity.**
   - Same flag lists, same strip rules, same refusal order (missing binary, then pack), same messages (`PRODUCT_NAME` = "Sai ATLAS") and same env order. The ancestor walk has the same depth: 8 directories including the start.
   - The only divergence is the TS-only empty-binary path (finding 4).
3. **Pack resolution.**
   - deb: `/usr/bin/sai-atlas` resolves to `/usr/lib/Sai ATLAS/{omp,assistant-pack}`.
   - AppImage: `$APPDIR/usr/lib/Sai ATLAS/…`.
   - macOS Electron: `process.resourcesPath/{omp,assistant-pack}`.
   - `tauri-utils` 2.10.1 walks a directory key of the resources map and keeps the tree under the target (`resources.rs:295-300` and `208-217`), so `skills/*/SKILL.md` keeps its structure.
   - A partial pack is refused without falling back, and both shells test this.
4. **Tests.**
   - Exact-argv `toEqual` assertions use literal flag arrays, not calls to the code under test.
   - The denylist case asserts the whole argv.
   - The rewritten launch-profile cases turn "survives" into "dropped", which is the intended contract, not a weakened one.
   - Gaps: the `packSearchFrom` gating in `src/main/index.ts:357-362` is untested; nothing tests source mode with an empty binary path (finding 4); and no test seeds a project prompt file (finding 1).
5. **Packaging and CI.**
   - The `ci.yml` `build:pack` step sits in `tauri-linux` before `cargo test`.
   - `bun --cwd=<GUI> scripts/check-assistant-pack.ts resources/omp` resolves the script and the binary against `<GUI>` (I verified `bun --cwd` behaviour). The script runs under `set -euo pipefail`.
   - The resources map entry is correct.

## Recommended order

1. Finding 1: pack-owned `--append-system-prompt`, plus a check-script case.
2. Findings 2 and 3: chat refusal on the restore and new-window paths, and pin `autoResume: false`. Route the config key to the Phase 4 owner.
3. Finding 4: empty `binaryPath` handling and an absolute pack path.
4. Findings 5 and 6: profile env keys, and the allowlist strip.

## Unresolved questions

- Are project context files (`AGENTS.md`, `CLAUDE.md`) meant to reach pack sessions? The GUI passes no `--no-rules`, and Phase 6 denylists it for profiles only.
- Should restored chat tabs be dropped silently, or shown with the "start a new task" message? This is a product call for Phase 8's toast copy.
