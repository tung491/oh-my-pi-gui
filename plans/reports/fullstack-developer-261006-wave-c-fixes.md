# Wave C fixes: implementation report

## Executed phase

- Scope: the repair of the Wave C review findings (`plans/reports/code-reviewer-261006-wave-c.md`), the new local-only model decision of 2026-10-06, and the items routed earlier.
- Branch: `rebrand/wave-c-fixes` in `/home/tung491/WORK/worktrees/rebrand-fixes-c`, based on `rebrand-wave-c`. There are 12 commits. Nothing has been merged, tagged or pushed.
- Status: completed. Every listed gate exits 0. The concerns at the end are about e2e state that existed before this branch and about residual risks.

## Findings: fix, test and commit

| Finding | Fix | Test | Commit |
|---|---|---|---|
| H1 | `resolveWritePath` builds the approval sentence from the fully resolved path. The dialog shows a warning with the full `Path:` text, instead of a sentence, in these cases: the line after `Path:` is not exactly `Content:`, there is more than one `Content:` line, the path contains a control or line-separator character, the path is elided, or the path cannot be resolved the way omp resolves it. | `ApprovalDialog.test.tsx` covers the newline payload, a second `Content:` line, an elided path, control characters, and the Vietnamese warning. | `67a0021` |
| L2 | The path is resolved like the agent does: a leading `:`, an `@` prefix, `~`, `~/x` and `~x`, and a relative path against the session cwd. `homeDir` reaches the renderer through both shells: the preload's `process.env.HOME`, and the Tauri bootstrap's `dirs::home_dir()`. | The same file covers relative and `~` paths. `create-omp-api.test.ts` covers `homeDir`, and the `bridge.rs` bootstrap test covers the Tauri side. | `67a0021` |
| H2 | The composer refuses a cloud tag sent through `/switch`, through any `:` part (so `kimi-k2:cloud:low` is caught), and through an advertised alias. The agent's pinned model policy refuses the rest: fuzzy names, role aliases and online providers. Wherever the agent reports the session model, a model that is not local shows a refusal notice and the tab switches back to the last local model it ran. If it never ran one, it switches to the first local catalog model. | `command-availability.test.ts`, `ollama-cloud.test.ts`, `stores/model.test.ts` (7 guard cases), and `use-rpc-events.test.tsx` ("switches a tab back to its local model when the agent reports an online one"). The pack check covers the agent side. | `ddc7c57`, `06a24f0`, `03ad633` |
| H3 | Every model-valued `ModelValueSelect` (setting rows, `modelRoles` record values) lists only local Ollama models. It refuses an online model, a role alias, a cloud tag or a provider-less name typed as a custom value, and explains why. A saved online value still shows as current but cannot be picked again; Clear stays available. The agent's policy filters any value that reaches it anyway. | `ModelValueSelect.test.tsx`, model settings block (7 cases). They fail without the fix (6 red). | `ab147d6` |
| M1 | `/login` and `/logout` are removed commands. The agent policy refuses online providers. Both shells strip every provider credential from the sidecar env (see below). | `command-availability.test.ts`, `assistant-pack.test.ts` with its Rust twin, and the spawn-env tests in `sidecar.test.ts` and `manager.rs`. The pack check plants keys in the scratch `~/.env` and still sees only `ollama/gemma4:e4b`. | `7a8ce4f`, `03ad633`, `ddc7c57` |
| M2 | A starter card sends through `send(text, undefined, { keepDraft: true })`. This sends no images, skips queue shorthand, and neither clears nor restores the composer. | `InputArea.starter.test.tsx`: draft and images kept, failed send keeps the draft, empty composer. | `180eea2` |
| L1 | `quotePromptPath` single-quotes a path, or double-quotes it with `\` and `"` escaped when the path contains `'`. Paths containing control characters are refused with a toast. | `attach-document.test.ts` and `starters.test.ts` (`Bob's notes.docx`). | `180eea2` |
| L3 (unit) | The starter `submit` branch now has unit tests. | `InputArea.starter.test.tsx` | `180eea2` |
| L3 (e2e) | Restored in both shells, where the deleted case lived: `/collab`, `/tools`, `/debug`, `/import` and `/login` each show the "TUI-only" notice and open no dialog, and none records a `prompt` or a `collab_join`. | `e2e/desktop.e2e.ts` and `e2e-tauri/desktop.e2e.ts`, "removed commands stay inert: a notice, no dialog and no agent call". `check-twins` passes with 44 twins. | `74e0e90` |

Items routed earlier:

| Item | Fix | Test | Commit |
|---|---|---|---|
| Startup refusal reaches the window | When `snapshotRuntime` is null, `use-rpc-events` waits for a focused runtime and re-reads `sidecar.getStatus()`. The composer placeholder now says "Sai ATLAS can't start right now. See the message above." instead of "Connecting". | Two tests in `use-rpc-events.test.tsx`, and a placeholder test in `InputArea.starter.test.tsx`. | `c02aa22`, `919e93c` |
| `sidecar-restart` crash reports | `sidecar-restart` is now a listed runtime-log source in `RuntimeErrorSource`, `runtime-log-core.ts` and Rust `RUNTIME_ERROR_SOURCES`. Both shells already wrote that source. | Twin tests "keeps sidecar crash reports under their own listed source". | `8f4f022` |
| Windows leftovers | `build-bundled-omp.ts` accepts only `darwin\|linux` with no `.exe`. `stage-tauri-sidecar.ts` has no Windows triple. The stats-server comment in both `electron-builder*.yml` now names the loopback Ollama server and GitHub releases. | `scripts/tauri-packaging-config.test.ts` | `ba0abf9` |

Phase 7 screenshot criterion: I ran `dev:tauri` on display :99 with `resources/omp` removed and a throwaway profile, on dev port 5183, after checking that the port was free.
- The screenshot shows the "Agent unavailable — Built-in omp not found…" banner, the `Error` chip and the new placeholder. "Connecting" appears nowhere.
- `logs/gui-runtime.jsonl` had 3 lines.
- The link was restored afterwards.

## Local-only mechanism

### Agent-side enforcement

The policy lives in `patches/omp/0003-model-policy-local-only.patch`, produced with `git format-patch` against the monorepo, which was reverted afterwards with nothing committed there. `build:omp` applies it after `0002`. The pack pins it in `assistant-pack/config.yml`:

```yaml
modelPolicy:
  providers: [ollama]
  localOnly: true
memory:
  backend: "off"
```

Both keys are in `PACK_PINNED_SETTING_KEYS`. Evidence from omp source (unpatched monorepo, `packages/`), and what the patch does at each point:

- **Disabled providers.** `coding-agent/src/config/model-registry.ts:198` (`getDisabledProviderIdsFromSettings`) only reads `disabledProviders`. The patch makes it return a predicate that also excludes every provider outside `modelPolicy.providers`.
- **Catalog projection.** Every catalog projection goes through `#withCatalogMetrics` (`model-registry.ts:328`, called at `:792` and `:1107`). The patch filters there, so `get_available_models`, `/model`, fuzzy names and role resolution never see a blocked model.
- **Ollama needs no key.** Ollama is a keyless provider (`catalog/src/provider-models/descriptors.ts:192` `allowUnauthenticated`, and `model-registry.ts:1496-1498` adds it to `#keylessProviders`). A missing key therefore blocks nothing. The patch makes `resolver()` return a resolver that rejects with `ModelPolicyError`, and gates `hasConfiguredAuth`/`getApiKey` (as kongming advised).
- **Session model switches.** `/model` and `/switch` call `session.setModel` and `setModelTemporary` (`coding-agent/src/slash-commands/builtin-modes.ts:451`, `:495`). Under the patch, both throw `ModelPolicyError` for a blocked model, and `scopedModels` is filtered.
- **Cloud tags.** These have any `:` part equal to `cloud` or ending in `-cloud`, or are reported by Ollama `/api/tags` with `remote_host`/`remote_model`. Under `localOnly`, `discoverOllamaModels` skips them (`DiscoveryContext.excludeRemoteModels`), and `isModelAllowed` refuses a cloud tag or a non-loopback Ollama base URL (`model-discovery.ts:154-155` reads `OLLAMA_BASE_URL`/`OLLAMA_HOST`).
- **Monorepo test results.** `test/model-policy.test.ts`: 7 of 7 pass. The regression run passed 914 of 915; the one failure (`sdk-async-job-manager-singleton`) is flaky and fails both with and without the patch. `tsgo` and oxlint are clean.
- **Sidecar build.** The sidecar was rebuilt with `build:omp:linux` from a temporary `packages/gui-wcf` worktree. The version is unchanged (`omp/18.4.8`). The old binary is backed up at `resources/omp.linux-x64.pre-local-only`, and the monorepo is back to its earlier state (`bun.lock` modified, `packages/gui/` untracked).

### Environment stripping

`ASSISTANT_PACK_REMOVED_ENV` (`src/main/assistant-pack.ts`) and `REMOVED_ENV` (`src-tauri/src/omp/assistant_pack.rs`) now strip the following from every pack session:

- the role model overrides `PI_SMOL_MODEL`, `PI_SLOW_MODEL` and `PI_PLAN_MODEL`;
- 119 credential variables.

The credential list was taken from omp source:
- every `envVars` entry in `catalog/src/compat/rules.json` (84 names);
- the Anthropic, Google, Vertex and Bedrock key lookups (including the AWS credential chain variables);
- the web-search keys;
- `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN`.

`OLLAMA_HOST` and `SAI_ATLAS_LANG` survive. A Rust test parses the TS list from source, so the two shells cannot drift.

### Renderer defence in depth

Covered under H2, H3 and M1 above: removed commands, the cloud-tag composer check, the session-model guard, and the local-only dropdowns.

### Proof

The pack check's new local-only case does the following:
- It serves a fake Ollama with `gemma4:e4b`, `kimi-k2:cloud` and `gpt-oss:120b-cloud`.
- It plants `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the scratch `~/.env`.
- It asserts that the session lists only `ollama/gemma4:e4b`, and that the policy keys are pinned.
- It asserts that each refused `set_model` and each `/model` or `/switch` leaves the session on the local model, and that no model request reached Ollama.

Against `omp.linux-x64.pre-local-only`, the same check fails (red evidence). That binary lists about 90 `anthropic/*` and `openai/*` models plus both cloud tags, starts on `anthropic/claude-opus-5-5`, and accepts every switch.

## Gate outputs (worktree, final HEAD `919e93c`)

- **TypeScript and build**
  - `bun run build:pack`: exit 0.
  - `bun run check:types`: exit 0.
  - `bunx vitest run`: exit 0, 208 files passed and 1 skipped; 2074 tests passed and 5 skipped.
  - `bun run build`: exit 0.
- **Rust**, with the pinned toolchain and `PATH="$HOME/.cargo/bin:$PATH"`, after `build:renderer:tauri`:
  - clippy `--all-targets --all-features -D warnings`: exit 0.
  - `cargo test --all-features`: exit 0, with 764 lib tests plus integration tests passing.
- **Parity loop**: every module mirrored. desktop 114, foundation 14, ollama 96, omp 37, services 39, tabs 46, updater 19.
- **API snapshots**: `bash scripts/check-module.sh snapshots` reports PASS for desktop, ollama, omp, ports, services, tabs and updater.
- **Biome**: `bunx biome check $(git diff --name-only rebrand-wave-c -- '*.ts' '*.tsx')` checked 46 files with exit 0. `bunx biome check assistant-pack` checked 22 files with exit 0.
- **Pack check**: `bun scripts/check-assistant-pack.ts resources/omp` printed `PACK LOAD CHECK: PASS` with exit 0, including the local-only case.
- **e2e removed-command check**: passes in both shells.
  - Electron, `bunx playwright test e2e/desktop.e2e.ts -g "removed commands stay inert"`: 1 passed.
  - Tauri, `wdio --spec e2e-tauri/desktop.e2e.ts --mochaOpts.grep …`: 1 passing.
  - `check-twins`: 44 twins match.

## Full e2e suites, compared with the baseline

These suites are not listed gates. I ran them because the session-model guard touches every e2e session.

- **Electron**: 13 failed, 22 passed on this branch, against 13 failed and 21 passed on `rebrand-wave-c`. The same 13 tests fail in both, and the extra pass is the new case.
- **Tauri**: 17 pass in both. The baseline's failures are identical, except that the new removed-command case also fails in the full run. It fails with "element click intercepted" because the test before it, which already fails on the baseline, leaves an overlay behind. It passes on its own.

Inside the deep-audit test, which already fails on the baseline, two new soft-error kinds appear. Both are intended by the local-only decision, and Phase 9's e2e rewrite needs to update the test for them:
- The test commits the custom value `__gui_audit__/sharpshooter_model` through the dropdown. That value is now refused because it is not `ollama/<tag>`.
- The test switches `memory.backend` to `mnemopi` or `hindsight`. That setting is now pinned `off`.

I left the deep-audit test unchanged. Rewriting it is Phase 9 Task 9.0's job, and editing its assertions here would look like weakening a test.

## Issues encountered

- The parity parser in `scripts/check-test-parity.ts` blanks everything after a `//` inside a Rust string literal. Because of that, an `"http://…"` value in a Rust test made 14 unrelated twins look missing. I used `127.0.0.1:11434` for `OLLAMA_HOST` in both shells' spawn tests instead.
- The pack check needs the sidecar as its first argument: `bun scripts/check-assistant-pack.ts resources/omp`.
- I built `out/renderer-tauri` before `cargo test`, as the Rust build requires it.

## Cleanup

- Stopped processes:
  - the Tauri dev run (cargo-tauri, `sai-atlas`, vite on 5183, `dbus-run-session` and its `dbus-daemon`);
  - the display `:99` that my runs started.
- Removed:
  - the throwaway dev profile;
  - my e2e scratch dirs (`/tmp/omp-gui-audit-*` from 20:14 to 20:39);
  - the baseline worktree `/home/tung491/WORK/worktrees/wcf-baseline`;
  - the temporary monorepo worktree and branch.
- Port 5183 and ports 4444/4445 are free.
- `resources/omp` in the fix worktree points back to `omp.linux-x64`.
- The `.pre-local-only` backup stays, as requested.

## Unresolved questions

1. Phase 9 needs to update the deep-audit e2e for the two intended changes above (local custom model values; `memory.backend` pinned `off`). Does Phase 9 Task 9.0 take this?
2. The main checkout's `resources/omp` (the Electron dev sidecar, dated Oct 4) was not rebuilt. Only `resources/omp.linux-x64` carries patch 0003. Should `resources/omp` be re-linked or rebuilt on the main checkout before the next Electron dev run?
3. omp still reads keys from `~/.env` and `<cwd>/.env`. The shells cannot strip those. The pinned policy blocks them, and the pack check proves it with planted keys. Do you want a further guard, such as a startup warning when those files hold provider keys?
4. `/modelpreset` applies saved role-model presets. It is not a removed command, because the policy filters any blocked model it names. Should it be removed from the composer too?
5. The renderer composer cannot tell an online short name (`/model claude-sonnet-4-5`) from a local one, so only the agent refuses it, with the session guard as a backup. Is the agent-side refusal message enough for users, or should the composer also map short names against the local catalog?

Status: DONE_WITH_CONCERNS
Summary: All Wave C findings and routed items are fixed with tests, and every listed gate exits 0 across 12 commits on `rebrand/wave-c-fixes`. Local-only is enforced in the agent through a pinned `modelPolicy` (patch 0003, rebuilt sidecar still `omp/18.4.8`), credential env stripping in both shells, and renderer guards.
Concerns/Blockers: The deep-audit and many other e2e tests fail on the baseline as well. This branch adds two intended soft-error kinds to deep-audit, and the new Tauri removed-command case fails inside the full run only because of an overlay that an earlier failing test leaves behind. The main checkout's `resources/omp` is not patched.
