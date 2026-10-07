# Wave C fixes, round 2: implementation report

- Scope: the findings in `plans/reports/code-reviewer-261006-wave-c-fixes.md` that were in scope (M1, M2, L1, L4, L5, L6), plus the sidecar rebuild.
- Branch: `rebrand/wave-c-fixes-2` in `/home/tung491/WORK/worktrees/rebrand-fixes-c2`, based on `b8e0423`. There are 4 commits. Nothing was merged, tagged or pushed.
- Status: completed. Every listed gate exits 0. One deliberate deviation from the brief: `0.0.0.0` is still accepted as local (see "Deviations").

## Commits

| Commit | Content |
|---|---|
| `a7b0833` | fix(agent): refuse look-alike loopback hosts and malformed model policies. Covers the regenerated patch 0003 and the pack check's fake-loopback case. |
| `3d184b8` | fix(approvals): warn about a save path with a parent segment |
| `2aa9516` | fix(ui): keep a starter card in the composer when it cannot be sent yet |
| `6941036` | docs: list the model policy patch among the agent patches |

## What changed, per item

### M1: loopback check (patch 0003)

- `isLoopbackBaseUrl` now accepts only these WHATWG-parsed hostnames: `localhost`, `[::1]`, `0.0.0.0`, and a dotted IPv4 literal in 127.0.0.0/8. The IPv4 test is a strict regex on the canonical form, so `127.1`, `2130706433` and `0x7f.1` still pass, because WHATWG has already normalised them. Every other DNS name is refused, including `127.0.0.1.attacker.example`, `127.evil.example`, `127.0.0.1.nip.io` and `localhost.attacker.example`.
- Under `localOnly`, configured discovery no longer contacts a non-loopback endpoint at all (`fetchDynamicModels` in `model-registry.ts`). Before this, the agent sent `/api/tags` and `/api/show` to the fake host even though it then filtered the models out.
- New agent tests in `packages/coding-agent/test/model-policy.test.ts`:
  - loopback literals however they are written;
  - look-alike names refused;
  - a registry whose `OLLAMA_BASE_URL` is the look-alike lists nothing, makes no request and refuses the resolver.
- `docs/settings.md`, inside the patch, states the host rule.
- The patch was regenerated with `git format-patch`, with the `Co-Authored-By` trailer dropped. It keeps the original author header, and it applies on the base plus 0002.

### M2: fail closed (patch 0003)

- `readModelPolicy` now validates the raw configured values instead of reading the typed handles, which fall back to their defaults on bad input.
  - If `modelPolicy` is absent, there is no restriction, as upstream.
  - If the group is a scalar or a list, or `localOnly` is not a boolean, or `providers` is not an array of non-empty strings, the result is `{ providers: ∅, localOnly: true }`, which allows no model.
  - The catch-all `catch { return UNRESTRICTED }` is gone. Missing global settings (early boot, SDK) still mean unrestricted.
- To see a scalar group, the patch adds a small `Settings.rawPathValue(segments)` accessor. A scalar group hides its members from `rawValue`, so this was needed.
- Tests: eight malformed shapes, each loaded from a real `config.yml` through `Settings.loadReadOnly`:
  - `localOnly: "true"`;
  - `providers: [1]`, with and without `localOnly`;
  - `providers: [""]`;
  - `providers: "ollama"`;
  - `providers` as a record;
  - `modelPolicy: true`;
  - `modelPolicy: [ollama]`.
  
  Each must list nothing, allow neither Ollama nor Anthropic, and reject the resolver. One more test checks that an absent policy, read from a file, leaves every model in place. No shell-side readback was added.

### Sidecar rebuild

- The old binary is backed up as `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64.pre-loopback` (sha256 `93b578d2…`).
- How it was built:
  1. A temporary monorepo worktree, `/home/tung491/WORK/worktrees/omp-policy-tmp`, detached at `f674c994a9`.
  2. A detached GUI worktree at `a7b0833` placed at its `packages/gui`.
  3. `bun run build:omp:linux`, which logged: 0001 already present, 0002 applied, 0003 applied.
- The new `omp.linux-x64` (sha256 `6b7bdbbc…`) prints `omp/18.4.8`, and `--help | grep -c -- --no-context-files` prints `1`.
- Monorepo before and after: the same `git status --porcelain` (` M bun.lock`, `?? packages/gui/`), the same HEAD `f674c994a9`, the same branches, and the same `git diff` sha256 (`17eef801…`).
- Both temporary worktrees were removed and pruned. Agent-side edits, tests and `bun install` ran only inside the temporary worktree.
- The patch was produced with `git am` and an amend there, in a detached HEAD. No ref points at those commits; they remain only as unreachable objects until git gc.

### L1: save-approval sentence

- In `src/renderer/components/dialogs/ApprovalDialog.tsx`, `resolveLikeAgent` returns null for an absolute path, after `:`/`@`/`~` handling, that has a `..` segment. The dialog then shows the existing unusual-name warning with the full request open.
- Relative paths still resolve lexically, as omp does. Names that only contain two dots (`notes..md`, `..notes/`) are unaffected.
- The two existing cases that expected an absolute `..` path to resolve were changed: the sentence case now uses a `./` and `//` path, and the absolute `..` case now expects a refusal.

### L4: starter card

- In `src/renderer/components/layout/use-composer-submit.ts`, a starter card (`keepDraft`) that cannot go out is appended to the composer after any typed draft, and pasted images are kept. This covers four states: the agent is not ready, the route is not ready, a send is in flight, or the submission is uncertain.
- A warning toast names the actual state:
  - `input.starterKept.connecting`
  - `input.starterKept.unavailable` (status `error`)
  - `input.starterKept.busy`
- A typed message sent in the `error` state now gets `input.agentUnavailable` instead of "connecting".
- Four new keys were added to both `en.ts` and `vi.ts`. They are key-identical, and `locales.test.ts` passes.
- Tests (`InputArea.starter.test.tsx`):
  - starting: the card is kept and the notice says the agent is starting;
  - error with a typed draft and an image: the draft becomes `draft\ncard`, the image is kept, the notice says the agent cannot start, and no "connecting" toast appears;
  - a second card while the first send hangs: it is kept and the notice says the agent is busy.

### L5: AGENTS.md

- The patch list now names `0003-model-policy-local-only.patch`: what it does, that the pack pins `modelPolicy.providers: [ollama]` and `modelPolicy.localOnly: true` in `assistant-pack/config.yml`, and that the pack check fails on a sidecar without it.

### L6: tests

- Covered by the tests above.
- The pack check (`scripts/check-assistant-pack.ts`) gained a second session in a scratch `work-dotenv` folder:
  - Its `.env` sets both `OLLAMA_BASE_URL` and `OLLAMA_HOST` to `http://127.0.0.1.attacker.example:11434`. omp reads both. Neither is set in the process env for this session, so the `.env` is what picks the endpoint.
  - Its traffic goes through `HTTP_PROXY` to a recording proxy that answers as that host would, so a sidecar that trusts the name really lists models there and sends the prompt there.
  - The session lists the catalog, sends one prompt, waits 3 s, and aborts. It fails if any listed model has a non-loopback base URL, or if the proxy saw any request to that host.
  - Its lines use the `dotenv` prefix, so the main case still prints exactly one `model   ` line.

## Red and green evidence

- Agent tests, before the fix: 9 of the 10 new cases fail, as recorded in the scratch run. `an empty provider id` already blocked by accident, because the empty set allowed nothing. After the fix, `bun test test/model-policy.test.ts`: 19 pass.
- Agent regression: 65 model, settings, registry and discovery files plus `test/config`. 1392 passed, 1 failed.
  - The failure is `rpc-settings-values.test.ts`, which expects the string "expected boolean" but gets "(expected a boolean)". It fails identically without my changes.
  - `tsgo` reports 8 errors, all in `test/rpc-pr.test.ts`, with and without my changes.
  - oxlint and oxfmt are clean on the touched files.
- Pack check against `omp.linux-x64.pre-loopback`: exit 1, with these failures:
  - `a .env endpoint listed ollama/gemma4:e4b at http://127.0.0.1.attacker.example:11434/v1`
  - `requests reached 127.0.0.1.attacker.example: GET /api/tags, POST /api/show, …, POST /v1/responses`

  The old binary sent the conversation to the fake host.
- Pack check against the new `resources/omp.linux-x64`: `PACK LOAD CHECK: PASS`, exit 0, exactly one `model   ollama/gemma4:e4b` line, no `ACCEPTED`, and `dotenv  127.0.0.1.attacker.example never contacted`.
- L1 before the fix: 1 failing test. After: ApprovalDialog 35 of 35 pass.
- L4 before the fix: 3 failing tests. After: the layout and locale suites pass, 140 of 140.

## Gate output (worktree HEAD `6941036`)

- `bun install`, `bun run build:pack`, `bun run check:types`, `bun run build`: exit 0.
- `bunx vitest run`: exit 0, 208 files passed and 1 skipped; 2103 tests passed and 5 skipped.
- `bunx biome check` on the 7 touched `.ts`/`.tsx` files: exit 0. `bunx biome check assistant-pack`: exit 0, 22 files.
- `bun run build:renderer:tauri`: exit 0.
- With `source scripts/rust-pins.env && PATH="$CARGO_HOME_BIN:$PATH"`:
  - clippy with `-D warnings`: exit 0.
  - `cargo test --all-features`: exit 0, 764 lib tests plus integration tests.
- Parity loop: exit 0. desktop 114, foundation 14, ollama 96, omp 37, services 39, tabs 46, updater 19.
- `bash scripts/check-module.sh snapshots`: PASS for desktop, ollama, omp, ports, services, tabs and updater.

## Deviations

- `0.0.0.0` is still accepted as local, as an exact literal, not a prefix. The brief listed only `localhost`, 127/8 and `::1`. I kept it for two reasons:
  - `OLLAMA_HOST=0.0.0.0` is a common Ollama server setting that omp turns into `http://0.0.0.0:11434`. Refusing it would empty the model list for those users.
  - Connecting to `0.0.0.0` reaches this computer on Linux and macOS. It is not a DNS name, so the M1 attack does not apply. The reviewer's suggested fix kept it too.

  Dropping it is a one-token change in `model-policy.ts` plus one test line, if you want it gone.
- `::ffff:127.0.0.1` (written `[::ffff:7f00:1]`) is refused, because the brief listed only `::1`.

## Cleanup

- Removed: the temporary monorepo worktree and the GUI worktree inside it, both pruned; the pack check's scratch dirs, which the script removes itself; and the scratchpad files, which are session-local.
- No sidecar, proxy or check process is left running.
- I did not start a virtual display or a GUI.
- The `/tmp/omp-natives-linux-x64-18.4.8` download cache was already there before this work and stays.
- `resources/omp.linux-x64.pre-loopback` stays, as requested.

## Unresolved questions

1. Should `0.0.0.0` stay accepted as local (see Deviations)?
2. The main checkout's `resources/omp` (dated Oct 4) is still unpatched. This was already raised in the previous round. Only `resources/omp.linux-x64` carries the new 0003.
3. A typed (non-starter) send in the `error` state now says the agent cannot start. No test covers that path, because it is reachable only through the Enter key. Is a keyboard-driven test wanted?
