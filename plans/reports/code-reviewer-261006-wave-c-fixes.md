# Code review: Wave C fixes and the local-only model policy

- Range: `rebrand-wave-c..rebrand/wave-c-fixes` in `/home/tung491/WORK/worktrees/rebrand-fixes-c` (HEAD `919e93c`, 12 commits, 54 files, +2277/−111).
- I edited nothing except this report and my reviewer memory. I started no long-running process.
- Agent source was read in `/home/tung491/WORK/oh-my-pi` (monorepo HEAD `f674c994a9`). Line numbers there are from the unpatched tree. `git apply --check` of `0003` succeeds on it. `0001` is already in the checkout, and `0002` applies.
- Checks I ran:
  - `bunx vitest run` on the touched suites (ApprovalDialog, model store, `lib/`, ModelValueSelect, `layout/`, assistant-pack, sidecar, use-rpc-events): 65 files, 735 tests passed.
  - A Bun probe of WHATWG URL hostname parsing (used for M1 below).
  - I could not run the monorepo `model-policy.test.ts`: `pi_natives` is not provisioned in the monorepo, because the implementer restored it after the build. I used source reading instead.

## Summary

| # | Severity | Area | Finding |
|---|---|---|---|
| M1 | Medium | Agent policy | `isLoopbackBaseUrl` accepts any DNS name that starts with `127.`, so an endpoint like `http://127.x.attacker.example` counts as local |
| M2 | Medium | Agent policy | The policy fails open: an invalid or unreadable `modelPolicy`, or a sidecar without patch 0003, means no restriction, and nothing at runtime or release time notices |
| L1 | Low | Approvals | `..` is resolved lexically, but omp passes absolute paths to the kernel unchanged, so a symlink in the path can make the sentence name a different file |
| L2 | Low | Agent policy | A remote copy is caught only at discovery. A model renamed to a remote copy after it was cached (24 h TTL) still counts as local |
| L3 | Low | Env stripping | The 119-name credential list is a hand copy of omp's catalog. Nothing detects new provider env vars after an upstream sync |
| L4 | Low | Starter cards | A starter send while the sidecar is not ready, or while a send is in flight, drops the picked file. The toast says "connecting" even in the error state |
| L5 | Low | Docs | AGENTS.md still lists only patches 0001 and 0002, and does not mention 0003, which the local-only guarantee depends on |
| L6 | Low | Tests | The Rust parity test only proves the two lists match each other, not that they are complete. The pack check is the only end-to-end proof, and it is not in CI or the release steps |

**No Critical or High findings.**

On the agent side, every model route I traced either reads the filtered catalog or goes through the gated credential and resolver path. A blocked model therefore fails before a request is sent. Details are in "Routes checked" at the end.

---

## M1 (Medium): a DNS name that starts with `127.` passes the local-only check

**Where**
- Patch `0003`, new file `packages/coding-agent/src/config/model-policy.ts`, line 83 of the file the patch creates:
  ```ts
  return hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || hostname.startsWith("127.");
  ```

**Cause**
- WHATWG `URL` turns a hostname into an IPv4 address only when every label is numeric.
- I checked with Bun: `new URL("http://127.evil.example:11434").hostname` is `"127.evil.example"`. That name passes `startsWith("127.")`, but DNS can resolve it to any address.
- The Ollama endpoint comes from `OLLAMA_BASE_URL` or `OLLAMA_HOST` (`model-discovery.ts:154-155`).
- Neither shell strips those two variables. omp also loads `<cwd>/.env`, `~/.env`, `~/.omp/.env` and `~/.omp/agent/.env` into its env at startup, for any key the process env does not already set (`packages/utils/src/env.ts:288-301`).
- `~/.omp/agent/models.yml` can also set the `ollama` provider's `baseUrl`.

**Failure scenario**
1. The user opens a folder they downloaded, or one a shared drive synced, as the session folder. It contains a `.env` with `OLLAMA_BASE_URL=http://127.0.0.1.attacker.example:11434`.
2. The user's login env does not set `OLLAMA_BASE_URL` (the usual case), so the `.env` value is used.
3. Discovery and every chat request go to the attacker's host, which pretends to be Ollama. `isModelAllowed` returns true, so the whole conversation leaves the computer.
4. The same `.env` with a plain `http://attacker.example` is correctly refused. Only the `127.` prefix gets through.

**Fix**
- Accept only literal loopback addresses:
  ```ts
  const v4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  return hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || v4.test(hostname);
  ```
  WHATWG has already normalised `127.1`, `2130706433` and `0x7f.1` to `127.0.0.1` by this point, so the strict regex loses nothing.
- Add `http://127.evil.example` and `http://127.0.0.1.nip.io` to the "treats only this computer's addresses as local" test as not local.
- Optionally, add `OLLAMA_BASE_URL` to what the shells pin: set it to the GUI's own resolved loopback URL at spawn, so a `.env` cannot pick the endpoint at all. That changes behaviour for users with a LAN Ollama (see question 1).

## M2 (Medium): the policy fails open, and no runtime or release gate catches it

**Where**
- Patch `0003`, `model-policy.ts:40-52` (`readModelPolicy`): `catch { return UNRESTRICTED; }`.
- omp `config/registry.ts:651-664`: an invalid configured value is logged and replaced by the default. For `modelPolicy` the default means unrestricted.
- The renderer guard (`src/renderer/stores/model.ts:188-221`) only reverts the session model. It cannot stop title generation, compaction or a fallback chain.

**Ways it fails open**
1. A malformed value turns the policy off, with only a `logger.warn`:
   - `localOnly: "true"` (quoted);
   - `providers: ollama` (a scalar);
   - `providers: [1]`: an array is accepted, then `id.trim()` throws, and the catch returns `UNRESTRICTED`.
2. A sidecar built without `0003` ignores the `modelPolicy` key. This is the main checkout's `resources/omp`, as the implementer notes in question 2.
   - With such a sidecar, a session with `ANTHROPIC_API_KEY` in `~/.env` lists and can use about 90 online models. The implementer's own red run shows this.
   - The GUI starts it without any warning.
3. `scripts/check-assistant-pack.ts` does catch cases 1 and 2. It reads the values back and requires the `overlay` layer. But only `scripts/sync-upstream.sh` runs it. It is not in CI, `package:linux` or the AGENTS.md release flow.

**Failure scenario**
- A release is cut from a build whose sidecar came from a stale `resources/omp`, or a later edit to `config.yml` mistypes the policy.
- Every gate in AGENTS.md passes, and the app ships with the policy off. The UI shows only Ollama models (`filterAllowedModels`), so nobody notices.
- Meanwhile the smol and title role resolves to an online model through `~/.env` keys.

**Fix**
1. Fail closed in the agent:
   - when `modelPolicy` is configured (`settings.isConfigured`) but does not read back as valid, return `{ providers: new Set(), localOnly: true }`, which allows nothing;
   - skip non-string entries instead of throwing;
   - keep `UNRESTRICTED` only for "not configured".
2. Fail closed in the shells: after `ready`, read `get_settings` for `modelPolicy.providers` and `modelPolicy.localOnly`. If they are not `["ollama"]` and `true` from the overlay layer, refuse the session with a status refusal, the same way a missing pack file is refused. This also catches an unpatched sidecar.
3. Add `bun scripts/check-assistant-pack.ts <sidecar>` to the release steps in AGENTS.md for every platform's sidecar, and to `package:linux` if the build time allows.

## L1 (Low): the save sentence resolves `..` lexically, but the write follows symlinks

**Where**
- `src/renderer/components/dialogs/ApprovalDialog.tsx:135-154` (`resolveLikeAgent` → `normalizePosixPath`).
- omp `tools/path-utils.ts:315-317`: `resolveToCwd` returns an absolute path unchanged, so the kernel resolves each `..` after following symlinks.

**Failure scenario**
- Given `/home/u/Documents/Sai ATLAS/link/../notes.md`, where `link` is a symlink to `/home/u/.config/autostart`:
  - the dialog says "Save a file to /home/u/Documents/Sai ATLAS/notes.md?";
  - the file lands in `/home/u/.config/notes.md`.
- This needs a symlink that already exists inside a folder that looks harmless, so it is hard to exploit. `write` cannot create symlinks. Relative paths are not affected, because `path.resolve` there is also lexical.

**Fix**
- Treat any `..` segment in an absolute raw path as unclear: return null, which shows the warning and opens the details.
- Models rarely write `..` into a save path, so a warning costs little and removes the gap.

## L2 (Low): a remote copy is detected only at discovery time

**Where**
- Patch `0003`: `discoverOllamaModels` skips `remote_host` entries, and the cache key gets `:local-only` (`model-registry.ts`, the `#configuredDiscoveryCacheProviderId` hunk).
- At request time, `isModelAllowed` checks only the id and the base URL.

**Failure scenario**
- The user runs `ollama cp kimi-k2:cloud mine:latest`, replacing a local model the catalog cached under that name less than 24 hours ago.
- `ollama/mine:latest` stays allowed until the cache is refreshed, and the local daemon forwards the conversation to ollama.com.
- This needs deliberate CLI action, so it is low risk.

**Fix**
- Either force an Ollama re-discovery at session start under `localOnly` (`/api/tags` on loopback is cheap), or note this limit in `docs/settings.md`.

## L3 (Low): the env credential denylist will drift after upstream syncs

**Where**
- `src/main/assistant-pack.ts:106-226` (`ASSISTANT_PACK_PROVIDER_CREDENTIAL_ENV`).
- `src-tauri/src/omp/assistant_pack.rs:104` (`REMOVED_ENV`) and its parity parser at `:468`.

**Cause**
- The list was copied from `catalog/src/compat/rules.json` `envVars` plus a few other key lookups.
- The Rust test compares the Rust list with the TS list, and the TS test checks a fixed subset. Neither compares with omp's source.
- A provider added upstream will not be stripped.
- Today the pinned policy is the real control, and the env strip is defence in depth. For the record, I diffed the list against credential-looking names in omp `ai/`, `catalog/`, `coding-agent/` and `utils/` source. What remains unstripped is non-model: `GH_TOKEN`/`GITHUB_TOKEN` (github tool, denied), `SEARXNG_TOKEN` (web_search, denied) and `HINDSIGHT_API_TOKEN` (memory, pinned off).

**Fix**
- Add a check to `scripts/sync-upstream.sh` (next to the pack check) that reads `rules.json` `envVars` and fails when a name is missing from the TS list.

**Parser note**
- `ts_removed_env` slices on `[`, `= [` and `];`, which is fragile.
- A comment inside the array, or a second spread, breaks it. It breaks loudly, though: the test fails, so the lists cannot drift silently. Acceptable.

## L4 (Low): a starter card can silently drop the file the user picked

**Where**
- `src/renderer/components/layout/use-composer-submit.ts:75-80`.

**Failure scenario**
- With `keepDraft`, a send while `status !== "ready"` shows `input.agentConnecting` and returns.
- A send while another send is in flight (`sending`) returns with no message at all.
- Either way, the picked path is not kept anywhere, so the user must pick the file again.
- When the status is `error`, the toast says "connecting", which contradicts the new `input.placeholder.unavailable` text.
- The earlier review suggested keeping the path in the draft when the sidecar is not ready. That was not done, and the implementer's report does not say why.

**Fix**
- When `keepDraft` cannot send, append the starter text to the draft (`setText(current => current ? `${current}\n${text}` : text)`), so the user can send it later.
- Use an "unavailable" toast when `status === "error"`.

## L5 (Low): AGENTS.md does not list patch 0003

**Where**
- `AGENTS.md:67` lists `0001` and `0002` as the patches the GUI depends on.

**Impact**
- `0003` carries the local-only guarantee. A maintainer who resolves an upstream conflict by dropping it would see no doc saying what breaks.
- Per the docs-impact rule, this is a security-relevant maintainer decision.

**Fix**
- Add one clause naming `0003-model-policy-local-only.patch` and the `modelPolicy` keys in `assistant-pack/config.yml` that rely on it.

## L6 (Low): test quality

**Tests that prove behaviour**
- `stores/model.test.ts` guard cases: switch back, fallback, failure toast, single flight.
- `ModelValueSelect.test.tsx`: refuses typed values and lists only local models. The implementer reports 6 red without the fix.
- `ApprovalDialog.test.tsx`: newline, second `Content:`, elided and control-character payloads.
- `InputArea.starter.test.tsx`: draft and images kept on a starter send.
- Monorepo `model-policy.test.ts`: catalog, credential, resolver and `setModel` refusals against a real `ModelRegistry` and `AgentSession`.

**Tests that only mirror the implementation**
- `assistant-pack.test.ts` "strips every online provider credential": a `toContain` check over a fixed subset.
- The Rust `strips_every_online_provider_credential_from_the_pack_env`: equality with the TS list.
- They prove the two shells agree, not that the strip is complete (see L3).

**Gaps**
- No test covers a loopback lookalike hostname. That test would have caught M1.
- No test covers a malformed or absent policy value (M2).
- No test covers the guard when `availableModels` is still empty at first hydration. In that case `model.ts:197-198` toasts and does not switch, and it tries again only when the next model report arrives. This matters only with an unpatched sidecar.
- The pack check uses `--no-session` and never sends a real prompt, so it does not exercise title generation, compaction or session restore. Source reading shows they go through `registry.find`, `getApiKey` and `resolver`, which are all gated.

---

## Routes checked (agent side, patch 0003)

| Route | Result | Evidence |
|---|---|---|
| Catalog listing (`getAll`, `getAvailable`, `find`, provider lookup) | Filtered | Every projection goes through `#withCatalogMetrics` (`model-registry.ts:792, 1107, 1116, 1815, 3250, 3330`). `#modelsForProviderLookup` uses `#composeStaticModels`. |
| Discovery of other providers | Skipped | The disabled-provider predicate now includes the allowlist (`:1496-1539`, `:2155-2245`). |
| `/model`, `/switch`, fuzzy ids, `@role`, `:level` | Refused | `resolveCliModel` reads the filtered catalog. `ModelControls.setModel` / `setModelTemporary` throw `ModelPolicyError`. |
| Typed selectors for unknown ids | Not resolved | `resolveProviderModelReference` (`model-resolver.ts:422`) never builds a model that is not in the catalog. |
| Session restore | Falls back | `sdk.ts:1922` and `:2675` use `modelRegistry.find`. |
| Model roles, `PI_SMOL/SLOW/PLAN_MODEL` (also from `~/.env`), `/modelpreset` | Fall back | They resolve through the filtered catalog. |
| Retry fallback chains | Refused | `turn-recovery.ts:1901, 1991-1999` use `resolveModelOverride`/`find` plus `getApiKey`, which returns undefined for a blocked model. |
| Main request path | Refused | `sdk.ts:2078` uses `modelRegistry.resolver(model)`, which rejects. `ai/src/stream.ts:1406-1418` fails the request on a rejected resolver; it does not fall through to `allowsMissingApiKey`. |
| Title, judgment, auto-repair, skill descriptions, speech enhancer, memories, sharpshooter | Refused | Each calls `getApiKey(model)` and then `resolver(model)`, and both are gated. Memory is pinned `off`. |
| `getApiKeyForProvider` callers (mnemopi, xai-http, scoped cycle) | Refused for other providers | They go through `#isProviderDisabled`, which uses the allowlist predicate. |
| Subagents and the task tool | Not loaded | The pack's `--tools` has no `task`, and `task.disabledAgents` is pinned. A subagent would inherit the parent's `getApiKey` (`sdk.ts:1540`). |
| Runtime override of `modelPolicy` | Not reachable from the GUI | `cfg://` writes need `settingsApproval`, which only the interactive TUI has (`main.ts:2151`). RPC `set_setting` writes the global layer, which the overlay outranks. The renderer also hides `modelPolicy` and `memory.backend` (`settings-schema-utils.ts:85-86`, prefix match). |
| Ollama cloud tags and remote copies | Refused | `isOllamaCloudTag` checks every `:` part. `/api/tags` `remote_host`/`remote_model` entries are skipped. The cache key is split with `:local-only`. |

## Renderer and shell checks that passed

- **Env stripping**
  - Electron: `sidecar.ts:394` deletes the keys before `assistantPackEnv` sets the language.
  - Tauri: `manager.rs:608` calls `env_remove` on every key.
  - Both spawn tests plant role, credential and `OLLAMA_HOST` values and assert on the child env.
- **Composer**
  - `isCloudTag` now checks every `:` part after the last `/`.
  - `/switch` is covered on both the direct path and the queue path (`use-composer-submit.ts:161-172`).
  - `/login` and `/logout` are removed commands.
- **Session guard**
  - Each tab's model store has its own tab-bound `command` (`tab-runtime.ts:82`), so a switch back goes to the right tab.
  - A switch back in flight is shared, so repeated reports send one `set_model`.
- **ModelValueSelect**
  - It filters options and refuses typed values.
  - A saved online value is shown disabled.
  - Clear stays available.
- **Save approval** (`resolveWritePath`)
  - Requires exactly one `Content:` line, directly after the `Path:` line. This defeats both a newline in the path and a fake `Path:` line injected through a reason.
  - Rejects C0/C1 controls, U+2028 and U+2029, and the tail elision marker. The marker regex matches omp's `truncateForPrompt` format exactly (`tools/approval.ts:357-361`, tail only).
  - Returns null for Unicode spaces, URLs and backslashes, which shows the warning (fail-safe).
  - The sentence is rendered as a React text node, so no HTML is injected.
  - `homeDir` is `process.env.HOME` in the sandboxed preload and `dirs::home_dir()` in Tauri. Both match the HOME the sidecar inherits.
- **Quoting** (`attach-document.ts`)
  - A path containing `'` switches to double quotes with `\` and `"` escaped.
  - Paths with control characters are refused with a toast, on both the attach path and the starter path.
- **Startup refusal replay** (`use-rpc-events.ts:668-697`)
  - The re-read is dropped if a newer status push arrives, the tab changes or the runtime is replaced, and it unsubscribes on unmount.

## Unresolved questions

1. M1's optional fix and M2's shell check both decide what "local" means. Should a user who runs Ollama on another machine on their LAN (`OLLAMA_HOST=192.168.x.x`) be refused, as now, or allowed? The recorded decision says "local, non-cloud". Today such a user sees an empty model list with no explanation.
2. Should the shells pin `OLLAMA_BASE_URL` to the GUI's own resolved endpoint, so a workspace `.env` can never choose the endpoint? This closes M1 more strongly than the hostname fix alone.
3. A loopback proxy configured as provider `ollama` in `~/.omp/agent/models.yml` (for example LiteLLM forwarding to OpenAI) passes the policy by design. Is that within the user's intent, or should the pack also ignore a user `models.yml` override for `ollama`?

Status: DONE_WITH_CONCERNS
Summary: The agent-side policy in patch 0003 covers every route I traced (catalog, switches, restore, roles, fallbacks, side-model calls and the request resolver). The renderer and shell fixes for H1–L3 are correct and tested. Two Medium gaps remain: the local check accepts DNS names that start with `127.`, and the policy fails open on a malformed value or an unpatched sidecar, with no runtime or release gate to catch it.
Concerns/Blockers: M1 can be exploited through a `.env` in the session folder. M2 needs a decision on whether the shells refuse sessions when the policy does not read back. Questions 1 and 2 need a user decision on what "local" means.
