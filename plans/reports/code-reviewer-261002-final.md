# Final code review: feat/ollama-only-onboarding (base 94df83e, uncommitted)

Reviewer: code-reviewer, 2026-10-02 (Asia/Seoul). Read-only; no source edits.

## Scope
- 54 modified/deleted files (+2255 / -4552) plus untracked `src/main/ollama/*`, `src/main/provider-cleanup*`, `src/renderer/components/onboarding/*`, `src/renderer/lib/provider-cleanup*`, `src/shared/{ollama-*,provider-policy*}`, `e2e/{onboarding.e2e.ts,desktop-prefs.ts}`.
- I checked behaviour against the agent source in `/home/tung491/WORK/oh-my-pi/packages/coding-agent` (read-only): `rpc-mode.ts` `set_model` / `get_available_models` / `cycle_model`, `model-registry.ts` `awaitBackgroundRefresh`, and `model-discovery.ts` (Ollama base URL).
- Gates (types, vitest 1802, biome, build, the listed e2e runs) were already verified by the controller. I did not re-run them.

## Overall
The structure is solid. Privileged commands are a closed set owned by main. Payloads are validated in main. The migration does parse, edit, render, then back up (EXCL, size checked), then an atomic rename. The allow-list goes through one store choke point, and the IPC/preload/type surfaces match. One real happy-path bug remains: Continue right after a download fails against the real agent. There are also two AC4 leaks outside the model store.

## High

### H1. Continue after an on-screen download fails with "Model not found" on the real agent
- `src/renderer/components/dialogs/FirstRunOnboardingDialog.tsx:234-241` (`markInstalled`) and `:348-357` (`handleContinue`).
- Agent `rpc-mode.ts:2291-2309`: `set_model` searches `session.getAvailableModels()`. If the model is missing, it waits only for an **in-flight** background refresh (`model-registry.ts:583`, which returns at once when none is running) and then errors.
- Scenario: fresh profile, Ollama running with 0 models (exactly what `e2e/onboarding.e2e.ts` covers), or Ollama started by the remedy after the agent booted. Implicit Ollama discovery already ran at sidecar start with no models. The user downloads `qwen3:8b` and clicks Continue. `set_model ollama/qwen3:8b` returns `Model not found`, the inline error shows, and the user is stuck until a catalog refresh happens by chance. The e2e misses this because `e2e/sidecar-fixture.ts:471` answers `set_model` unconditionally.
- `ProvidersWindow.tsx:199-203` already does the right thing after a pull (`refreshAvailableModels(true)`). The welcome screen does not.
- Fix: in `markInstalled`, or just before `setModel` in `handleContinue`, call `useModelStore.getState().refreshAvailableModels(true)` (forced `get_available_models`, which re-runs discovery) and await it before `setModel`. Add a fixture mode where `set_model` fails for models not in the fixture catalog, so the e2e proves the refresh.

### H2. `^` model-delegation autocomplete falls back to the unfiltered agent catalog (AC4)
- `src/renderer/components/layout/use-completion-menu.ts:281-292`. When the store's (filtered) `availableModels` is empty, the code calls `rpc.getAvailableModels(true)` directly and shows `data.models` unfiltered.
- Scenario: the user has no Ollama models yet, but `ANTHROPIC_API_KEY` is in the env or a stored API key remains (both are deliberately kept). Typing `^` lists `anthropic/*` models and lets the user delegate a task to them. The store being empty is exactly the condition that triggers the leak.
- Fix: `showModels(filterAllowedModels(data?.models ?? []))`, or better, route through `useModelStore.getState().refreshAvailableModels(true)` so the choke point stays single. Add a unit test for the fallback path.

## Medium

### M1. Cycle-model shortcut and palette action can switch to a non-Ollama model (AC4)
- `src/renderer/App.tsx:412-419` (Ctrl+P / Shift+Ctrl+P) and `src/renderer/lib/command-registry.ts:634` both send `cycle_model` to the agent. The agent cycles over its own scoped/available set (`rpc-mode.ts:2311-2330`), which still includes providers that have env or stored API keys.
- Scenario: a user with `OPENAI_API_KEY` exported presses Ctrl+P, and the session moves to `openai/*`. The GUI's filtering is bypassed.
- Fix: implement cycling in the GUI over the store's filtered `availableModels` with `set_model`, or hide/disable both entry points until the agent supports a scope. At minimum, record this as a known gap. Typed slash commands are the settled exception; a built-in shortcut is not one.

### M2. Welcome screen's Download buttons can stay disabled for the rest of the launch
- `FirstRunOnboardingDialog.tsx:245-256` stores **every** progress frame by tag. `:279` computes `pullRunning` as `some(frame => !frame.done)`.
- Main error frames carry `done: false` (`pull.ts:185, 211, 214`), and a cancelled pull emits no terminal frame (`pull.ts:257`).
- Scenario: in Settings › Ollama the user pulls `llama3.2` and either cancels it or it fails. The welcome listener holds `{tag:"llama3.2", done:false}`, possibly with `error`, and nothing ever clears it. "Run setup again" then shows every card's Download disabled, and `ProvidersWindow` has no way to clear it.
- Fix: treat `frame.error` as terminal (`!frame.done && !frame.error`). Also ignore frames for tags this screen did not start and that are not among `choices`, or have main emit one terminal `cancelled` frame per cancel.

### M3. "Start Ollama" is offered on Linux hosts that have no systemd unit
- `src/main/ollama/probe.ts:339-340, 350-355`. `stopped` is reported when **either** the unit exists **or** `ollama` is on PATH, and `stopped` always maps to `linux-start` (`pkexec systemctl start ollama.service`).
- Scenario: a manual binary or tarball install (on PATH, no unit) shows a Start button. It asks for the root password and then always fails ("Unit ollama.service not found"). The user can never fix this from the screen.
- Fix: return `linux-start` only when `systemdUnit()` is true (carry that bit out of `isOllamaInstalled`). Otherwise use `remedy: null` and the "start the Ollama app/`ollama serve`" message.

### M4. Main runs any closed-set remedy regardless of state (defence in depth)
- `src/main/ollama/register-ipc.ts:69-73`. The renderer can request `linux-install` (curl | sh as root) while Ollama is running, and there is no single-flight guard.
- Threat model: polkit still prompts, so this is not a silent escalation. Still, a compromised or buggy renderer can raise a root-install prompt that the UI never offered, and a double invocation stacks two pkexec dialogs.
- Fix: in the handler, re-probe and reject when `id !== status.remedy`. Keep one in-flight remedy promise and return it to concurrent callers.

### M5. Stray build artifact in the worktree
- `tsconfig.node.tsbuildinfo` is untracked and not ignored (`git check-ignore` returns nothing). A `git add -A` at commit time would ship it.
- Fix: delete it or add `*.tsbuildinfo` to `.gitignore` before committing.

## Low (non-blocking; listed because they touch AC wording)
- AC2 says "the exact command", but `OLLAMA_REMEDY_COMMANDS["linux-start"]` (`ollama-types.ts`) shows `systemctl start ollama.service`, while main runs `pkexec systemctl …`. Install also runs through `pkexec sh -c`. The display omits the elevation wrapper. Consider prefixing `pkexec` in the display strings.
- Cancel is global (`OllamaPuller.cancel()`, no tag). The welcome screen and Settings › Ollama can join the same tag's pull, and cancelling in one silently ends the other. The welcome then records `{...last, done:true}` with no error. `cancelPull(tag)` that main checks against `activeTag` would close this.
- `pick()` warms every card the user clicks (`FirstRunOnboardingDialog.tsx:258-265`). Clicking through three cards loads three models into memory. Consider warming only on Continue or after a debounce.

## Mandatory checks

### (a) Acceptance criteria
1. AC1 is met on the fake fixture. Gate: `FirstRunOnboardingDialog.tsx:140-178` (pref plus `hasUsableModelProvider` narrowed by `isAllowedProvider`, `:61-76`). Facts: `MachineFacts.tsx`. Running row: `OllamaRow.tsx:45-56` (`welcome.ollama.running`, en.ts:3160). Installed badge: `welcome.card.installed` (en.ts:3188). Continue: `:348-372`, where set_model, then set_model_role default, then the pref. No reopen: `e2e/onboarding.e2e.ts:110-160`. It is **not met on the real agent after an on-screen download** (H1).
2. AC2 is met. Linux: `OllamaRow.tsx:72-90` with `remedy.ts:101-104` and `probe.ts:350-355`. macOS/Windows: remedy null, so only open-download and check-again appear. Caveats are M3 and the Low on command text.
3. AC3 is met. Indeterminate then percent then ready: `pull.ts:62-73`. Cancel and later resume: `pull.test.ts:115` and the dialog's `cancel`/`download`. Resume itself relies on Ollama keeping its layers. Caveat: M2.
4. AC4 is partially met. The store choke point is `stores/model.ts:62-73`, with roles at `ModelRolesWindow.tsx:315-320` and benchmark seed at `BenchmarkDialog.tsx:36-39`. Picker, compare and settings selects all read the store. The palette and slash autocomplete hide login/logout. Leaks: H2 and M1.
5. AC5 is met within the settled oauth-only decision. Runs once: pref `providers.cleanupVersion` (`renderer/lib/provider-cleanup.ts:21-22, 88-115`). Backup before delete: `main/provider-cleanup.ts:96-109`. Notice: `:135-144`.
6. AC6 was reported green by the controller and not re-run here.

### (b) Regressions in touched callers
- The deleted `openProviderConfig`, `upsertProvider`, `deleteProvider` and `openConfig` have no remaining references (grep is clean apart from the removed lines).
- `ModelPicker` lost its provider grouping and auth badges, which is consistent with Ollama-only.
- `Sidebar` now uses `ollama.settings.title`.
- No other caller regressions found.

### (c) IPC contracts
- The 8 new commands and 1 event are consistent across `ipc-types.ts`, `preload/index.ts`, `register-ipc.ts` and `provider-cleanup.ts`.
- The removal of the 3 models.yml write channels is intentional and matches across all three layers. `listProviders` is kept.

### (d) Security
- Remedies are a closed set (`isRemedyId` uses `Object.hasOwn`).
- The renderer sends only `{id}` / `{tag}`. Tags are validated by `isValidModelTag` before any fetch.
- `openDownload` uses a constant URL.
- No `dangerouslySetInnerHTML` in the new code. All text renders as text nodes.
- Migration: content failures throw before the backup. The backup uses `COPYFILE_EXCL` plus a size check, and the write is a temp file plus rename. Credentials go only through the `logout` RPC.
- Hardening gap: M4.

### (e) AGENTS.md conventions
- `useT` is used throughout, and en/zh are key-identical (test enforced).
- Tests use linkedom. No `mock.module`. No `any`.
- The CSS uses only `--omp-*` tokens.
- The only `max-h-[70vh]` in `ProvidersWindow.tsx:221` was already there at HEAD.

## Recommended actions
1. H1: force a catalog refresh before `set_model` in the welcome Continue flow, and make the e2e fixture reject unknown models.
2. H2: filter the `^` autocomplete fallback through `filterAllowedModels` or the store.
3. M1: decide how cycle-model should behave (GUI-side cycle over the filtered list, or hide it).
4. M2, M3, M4: the small targeted fixes described above.
5. M5: remove `tsconfig.node.tsbuildinfo` before committing.

## Unresolved questions
- Does the agent refresh Ollama discovery on a timer that would hide H1 in practice? I found no evidence of one. `set_model` waits only for an in-flight refresh.

Status: DONE_WITH_CONCERNS
Summary: Contracts, security boundaries and the migration are sound. Two High defects block merge: welcome Continue fails after an on-screen download on the real agent, and the `^` autocomplete leaks non-Ollama models.
