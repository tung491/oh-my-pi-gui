# User MCP servers started in Sai ATLAS assistant sessions

Branch `rebrand/mcp-containment` in `/home/tung491/WORK/worktrees/rebrand-mcp`, commit `ce33ee6` on `c5b0031`. Nothing was merged, tagged or pushed.

## Outcome

Every pack session started the user's MCP servers. The cause is that omp has no MCP opt-out besides `restrictToolNames`, and only chat sessions set that. A `--tools` allowlist leaves MCP discovery on, so the sidecar loaded `~/.omp/agent/mcp.json` at startup. The GUI never asked for it.

The fix is a new omp patch, `patches/omp/0004-mcp-enabled-setting.patch`. It adds an `mcp.enabled` setting, and the pack pins it to `false`. With the rebuilt sidecar, a planted user server and a planted project server stay down at startup, on the GUI heartbeat and on a plugin reload.

## Root cause (omp at `f674c994a9`)

1. **`--tools` does not restrict MCP.** In `packages/coding-agent/src/main.ts:1591-1603`, only `sessionKind === "chat"` sets `options.restrictToolNames = true`. The `else if (parsed.tools)` branch sets `toolNames` and nothing else.
2. **MCP is on by default.** `src/sdk.ts:2378` computes `enableMCP = !restrictToolNames && (options.enableMCP ?? true)`. `rpc-ui` has `hasUI`, so `sdk.ts:2382` takes the deferred path. `sdk.ts:2421-2445` then runs `discoverAndConnect` in the background right after the session exists.
3. **The user's file is read by the native provider.** `src/discovery/builtin.ts:213-219` reads `<agentDir>/mcp.json` and `.mcp.json` at `level: "user"`. The only gate in the pack config, `mcp.enableProjectConfig: false`, removes `project` entries only (`src/mcp/config.ts:131-132`).
4. **The ~30 s cadence is omp's own.** `src/mcp/timeout.ts:3` sets `DEFAULT_MCP_TIMEOUT_MS = 30_000`. The tripwire never answers `initialize`, so omp times out, kills the server and reconnects. In `egress-261006-dry-run/first-attempt/egress-app.txt`, pid 353 (omp) SIGTERMs each server exactly 30 s after it spawns (lines 110→147→154, 158→190, 200→230, 241→272), and a new one starts within about 10 ms.
5. **Other paths that rediscover** all go through `MCPManager.instance()`: `reload_plugins` (`src/modes/rpc/rpc-session-actions.ts:110-123`), `mcp_action` (`rpc-actions.ts:209-218`), and `mcp_add`/`mcp_reauth` (`rpc-mcp-extra.ts:142-150`). `mcp_test` by name (`rpc-mcp-extra.ts:264-283`) and the `/mcp test|resources|prompts` helper (`slash-commands/helpers/mcp.ts:199`) connect without that manager.

### The GUI side (the order of preference was a, b, c)

- **(a) was ruled out.** The GUI sends no request that triggers this. Its only periodic sidecar call is the heartbeat `get_state` every 15 s (`src/renderer/hooks/use-rpc-events.ts:264,522`). Nothing calls `reloadPlugins` or any `mcp*` RPC; they appear only in `rpc-client.ts` and `ipc-types.ts`. A typed `/mcp` is already refused by `REMOVED_COMMANDS` in `src/renderer/lib/command-availability.ts`. In the container the server started about 0.1 s after the sidecar's first Ollama connect, before any user action (`egress-app.txt` rows at 14:28:11.52 and 11.64).
- **(b) was ruled out.** There is no flag, env var or setting that turns off user MCP. The only MCP settings are `enableProjectConfig`, `startupTimeoutMs`, `renderMarkdownResults`, `notifications` and `notificationDebounceMs` (`src/mcp/settings.ts`). `disabledProviders: [native]` would also drop the user's `config.yml` settings layer (`builtin.ts:905`), extension discovery and more, so it is not a safe substitute.
- **(c) was used**, as a new patch.

### Hypotheses eliminated

- **A GUI periodic poll or MCP RPC:** no call site exists, and the `--no-session` check reproduces the spawn with no GUI at all.
- **`--tools` sets `restrictToolNames`:** disproved by `main.ts:1591-1603`.
- **Project config leaks:** the planted project `.mcp.json` never started even before the fix.

## Fix

**omp patch `0004-mcp-enabled-setting.patch`.** It touches 5 source and doc files plus a test.

- `mcp/settings.ts` registers `mcp.enabled` (boolean, default `true`, `restartRequired`).
- `sdk.ts` adds `&& cfgMcpEnabled.get(settings)` to `enableMCP`. When it is off, no manager is created, so reload and `mcp_action` have nothing to rediscover. Subagents share the gate.
- `mcp_test` and `testRpcMcpConnection` (`mcp_add`/`mcp_reauth`) and the `/mcp` slash helper refuse with `MCP is turned off for this session (mcp.enabled: false).`
- The docs updated are `docs/mcp-config.md` and `docs/mcp-runtime-lifecycle.md`.
- The new test is `test/sdk-mcp-enabled-setting.test.ts`.

**GUI changes:**

- `assistant-pack/config.yml` pins `mcp.enabled: false`.
- `settings-schema-utils.ts` adds `mcp.enabled` to `PACK_PINNED_SETTING_KEYS`, so no settings row offers a toggle the overlay would override.
- `assistant-pack/test/pack-files.test.ts` expects the new key and has a new MCP case.
- `AGENTS.md` lists the patch.
- No shell code changed. Both shells pass the same `config.yml`, and Rust has no pinned-key list, so TS/Rust parity is unaffected; the parity loop passes.

**Regression check in `scripts/check-assistant-pack.ts`:**

- It plants a stdio server that only records its start, in the scratch HOME's `~/.omp/agent/mcp.json` and in both sessions' `.mcp.json`.
- After the main checks it sends `get_state`, `reload_plugins` and `get_state`, then waits 3 s.
- It fails if any server started, and also fails if `config.yml` does not pin `mcp.enabled: false`, naming the patch.

**Sidecar rebuild:**

- I worked in a temporary monorepo worktree detached at `f674c994a9`, with a detached GUI worktree at its `packages/gui` that carried the 0001–0004 patches.
- `build:omp:linux` applied the patches. The output, `omp/18.4.8` with sha256 `573cf751…`, contains the new setting and the refusal string.
- The old binary is kept as `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64.pre-mcp` (`6b7bdbbc…`).
- The monorepo's status, HEAD, branches, `git diff` sha256 and stash list are identical before and after.
- Both temporary worktrees were removed and pruned.

## Red/green evidence

| Run | Result |
|---|---|
| Pack check, old sidecar, before the fix | exit 1: `mcp     user and project MCP servers STARTED 3 times: user` (main-session startup, `reload_plugins`, and the second session's startup, which sends no reload) |
| Pack check, old sidecar `.pre-mcp` with the new pack | exit 1: `config.yml key mcp.enabled is not a known setting`, `does not pin mcp.enabled: false (… 0004-mcp-enabled-setting.patch)`, and the user server STARTED 3 times |
| Pack check, new sidecar | exit 0: `setting mcp.enabled = false  [overlay]`, exactly one `model   ollama/gemma4:e4b`, no ACCEPTED, `127.0.0.1.attacker.example never contacted`, `mcp     user and project MCP servers never started`, `PACK LOAD CHECK: PASS` |
| omp unit test, with the source change stashed | 1 fail: 4 server starts were seen where none were expected |
| omp unit test, with the change | 2 pass |
| GUI `pack-pinned-keys.test.ts` and `pack-files.test.ts` before the key was added | 2 fail (`mcp.enabled` uncovered; the config differed) |
| Same tests after | pass |

The omp MCP and settings suites ran 411 tests: 410 pass. The one failure, in `rpc-settings-values.test.ts`, is a message-wording mismatch that fails the same way with my source stashed, so it predates this change. `tsgo` reports 8 errors, all in the untouched `test/rpc-pr.test.ts`. oxlint and oxfmt are clean on the touched files.

## Gates (worktree, commit `ce33ee6`)

All of these exited 0:

- `bun install`
- `bun run build:pack`
- `bun run check:types`
- `bunx vitest run` (208 files passed, 2108 tests)
- `bun run build`
- `bunx biome check` on the touched files and `assistant-pack/`
- the pack check above
- `bun run build:renderer:tauri`
- `cargo clippy … -D warnings`
- `cargo test --all-features` (772 passed)
- the parity loop over `src-tauri/contracts/*.parity.json`
- `bash scripts/check-module.sh snapshots` (PASS)

## Recurrence prevention

The pack check now fails both on a sidecar without the patch and on any configured MCP server start. Once the next deb is built, the egress audit's seeded `mcp.json` tripwire covers the packaged path.

## Unresolved questions

1. The containerized egress dry run was not repeated against a new deb. That needs a `package:linux` build from this branch with the new sidecar.
2. The patch is GUI-only for now. Should `mcp.enabled` be offered to the `nornzach/oh-my-pi` fork or upstream, so 0004 stops needing a rebase on every sync?
3. The TUI's own `/mcp` controller (`modes/controllers/mcp-command-controller.ts`) still builds temporary managers for its test commands. That code is never reached from rpc-ui pack sessions, so I left it unchanged.
