# Kongming counsel: `rebrand-wave-c-fixed` checkpoint

- Date: 2026-10-06 (Asia/Seoul). Advisory only; nothing edited outside this report.
- Inputs read: `plans/reports/fullstack-developer-261006-wave-c-fixes.md`, `plans/reports/code-reviewer-261006-wave-c.md`, `plans/261005-0812-everyday-work-rebrand/plan.md` (Decisions, Shared commands), `phase-09-copy-and-release.md`; code in `/home/tung491/WORK/worktrees/rebrand-integration` (HEAD `b8e0423`) and omp source in `/home/tung491/WORK/oh-my-pi/packages/coding-agent`.
- Runtime: Claude Fable 5.1.

## TL;DR

Nothing in the repair report blocks the tag. Tag `rebrand-wave-c-fixed` on `b8e0423` once the running gate exits 0, after one extra check the Shared-commands gate does not contain: `bun run build:pack && bun scripts/check-assistant-pack.ts resources/omp.linux-x64` in the integration worktree (it is the only agent-side proof of the local-only decision). All five questions are engineering calls; none needs the user. Phase 9 must be amended before it starts (exact edits below): widen Task 9.0 step 3 for the two intended deep-audit changes, add step 2c removing `/modelpreset`, seed planted keys in Task 9.6, and add a per-sidecar pack check to Task 9.7 step 4.

## Reframed problem

The decision is not "is Wave C fixed" (every listed gate is green, and the fixes match the review) but "what must be true of the plan text before Phase 9 runs under its Failure Protocol". Phase 9's executor STOPs on any Verify it cannot meet, and three of the implementer's questions describe conditions the current Phase 9 text does not anticipate. The job here is to route each one to a concrete step with pass conditions, so 9.0 does not stall on expected failures and 9.6/9.7 prove the user's local-only decision in the shipped deb rather than only in the pack check.

## Answers

### Q1. Deep-audit e2e: fold the two intended changes into Task 9.0 step 3? — Yes, with the step's wording widened first

Engineering call. The two failures are intended results of the user's local-only decision, and `e2e*/**` is 9.0's to edit. But 9.0 step 3 today permits only "Phase 8 UI" rewrites and "removed control" deletions, and says "Any other failure: STOP" (`phase-09-copy-and-release.md:40`). Left as is, the executor must STOP on exactly these two cases. Amend the step to name them:

- `conditionGate` (`e2e/deep-audit.e2e.ts:200-213`, twin `e2e-tauri/deep-audit.e2e.ts:248-261`): `hindsightActive` and `mnemopiActive` write `memory.backend`, which `assistant-pack/config.yml` pins `off` and `PACK_PINNED_SETTING_KEYS` hides (`src/renderer/components/settings/settings-schema-utils.ts:86`). The overlay wins, `pollSetting` times out, and the gate write also lands in the (throwaway) global `~/.omp/agent/config.yml`. Rule for 9.0: an entry whose condition gate is a pack-pinned key is recorded as `write: "skipped-no-control"` with the note "condition gate `memory.backend` is pack-pinned", and `writeSetting` is never called for that gate.
- The string branch for `/(model|provider)$/` paths (`e2e/deep-audit.e2e.ts:345-360`, twin `:455-470`): the custom marker `__gui_audit__/...` is refused by `ModelValueSelect` by design (`modelValue.localOnly`, `src/renderer/locales/en.ts:1348`), and the isolated audit profile has no local catalog row. Rule for 9.0: for these entries assert the refusal text is shown, then record `write: "skipped-no-control"` with the note "accepts only local Ollama models; none in the audit profile". Asserting the refusal keeps it a check, not a weakening.

Both edits must land in the Tauri twin too (`bun e2e-tauri/check-twins.ts` exits 0). The `/Apply|应用/` locators in the same file are stale (zh was retired for vi) but harmless while the audit runs in English; 9.0 may leave them.

### Q2. Main checkout's `resources/omp` lacks 0002/0003 — leave it to Task 9.7 step 4

Engineering call. `/home/tung491/WORK/oh-my-pi-gui` is on `main` (`7677ba1`), which passes neither `--no-context-files` nor a model policy, so its Oct 4 sidecar is the correct dev sidecar for that branch today. Every rebrand worktree reaches the patched binary through the `omp.linux-x64` symlink (plan Decisions "Sidecar build"); Electron's `resolveBundledOmp` (`src/main/index.ts:83-107`) tries `bundledOmpFilename()` first, so it finds the symlink, and Task 9.0 step 0 creates `resources/omp` for the Tauri dev build. Rebuilding now would reproduce the 20:00 `omp.linux-x64` and cannot run from the standalone checkout anyway (`build:omp` needs `/home/tung491/WORK/oh-my-pi/packages/gui`). The main checkout's `omp` becomes wrong only when the rebrand reaches `main`, which is exactly when 9.7 step 4 rebuilds every sidecar. Two additions to 9.7 step 4:

- The `--help | grep -c -- --no-context-files` line proves patch 0002 only. Prove 0003 per sidecar with `bun scripts/check-assistant-pack.ts <sidecar>` → `PACK LOAD CHECK: PASS` (Linux binary on Linux; arm64 and x64 binaries on the Mac). The check's local-only case fails against a binary without the patch (red evidence in the repair report).
- After the rebuilt binaries pass, delete `resources/omp.linux-x64.pre-local-only` and `resources/omp.linux-x64.pre-context-files` (600 MB of gitignored backups); keep them until then.

### Q3. `~/.env` and `<cwd>/.env` provider keys: extra startup warning? — No

Engineering call. Verified: omp reads `<project>/.env` and `~/.env` as key fallbacks, below the process environment (`/home/tung491/WORK/oh-my-pi/docs/environment-variables.md:21`, `docs/providers.md:218,440`). Every such key reaches a model only through `getApiKey`/`hasConfiguredAuth` and the request resolver, and patch 0003 gates all three after removing the provider from the catalog at `#withCatalogMetrics`. A key for a blocked provider therefore cannot make a model appear, authorize a switch (`model-controls.ts` throws `ModelPolicyError` before the auth check), or be sent. The threat model is "omp regresses and a bypass returns", and the guard for that is the pack check's planted-key case (`scripts/check-assistant-pack.ts:490-491`), not a shell-side file scan. A warning would (a) parse dotenv files in two shells for a condition with no effect, (b) tell users their own files are a problem when they are not, and (c) suggest the shell is the enforcer. Instead, prove it in the shipped deb: Task 9.6 step 2 seeds `~/.env` in the container home with fake `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` values before first run, and step 3 adds a typed `/model anthropic/claude-sonnet-4-5` and `/login`; under strace any `api.anthropic.com`/`api.openai.com` connect becomes a "not allowed" row. Note for the audit report: an `OLLAMA_HOST` pointing off-box (env or `~/.env`) makes `isLoopbackBaseUrl` refuse every Ollama model, so the app shows no model rather than going online; that is the intended failure.

### Q4. `/modelpreset`: make it a removed command? — Yes, in Task 9.0 (new step 2c)

Engineering call, and the strongest of the five. The policy only stops the session from landing on a blocked model; it does not stop `/modelpreset` from writing the user's global config. `runPresetsCommand` reports `changedConfig` on both `switched` and `failed` (`/home/tung491/WORK/oh-my-pi/packages/coding-agent/src/slash-commands/builtin-modes.ts:904-909`), because `applyModelPreset` calls `writePresetRoles(settings, preset)` before resolving the live default (`src/config/model-presets.ts:345`): a preset with a local `default` and an `anthropic/...` `smol` role writes that role into `~/.omp/agent/config.yml`, which the user's own omp CLI then uses. `save` writes `modelPresets` the same way (`model-presets.ts:81`). This is the "set_setting writes the user's global config" hazard from the plan's Pinned-settings decision, and `/model-roles` is already removed for it; `/modelpreset` is its sibling. Cost: one entry in `REMOVED_COMMANDS` (`src/renderer/lib/command-availability.ts:25`) with a one-line comment (role models are not an assistant surface and the command writes the user's global config), plus a case in `command-availability.test.ts`. No e2e change needed; the unit test suffices. Add the file pair to Task 9.0's ownership and a commit `fix(ui): refuse the model preset command`; append `modelpreset` to the plan's Decisions row "Removed commands".

### Q5. Composer cannot tell an online short name from a local one — Enough as is

Engineering call. Verified path for `/model claude-sonnet-4-5`: the catalog no longer contains the model, so `resolveSessionModelSelector` finds nothing and the agent replies through `usage("Unknown model: ...")` (`builtin-modes.ts:462-467`; `/switch` at `:513`), which `runtime.output` emits as a `command_output` frame (`src/modes/rpc/rpc-mode.ts:1878`) that the renderer shows (`src/renderer/hooks/use-rpc-events.ts:758`). The user sees text, the session stays on its model, and the session guard (`stores/model.ts:196`) backs it. The text is omp's and mentions ACP, which is technical, but this is a typed power-user path. Do not add a selector grammar in the renderer: H2 showed pattern-matching cannot cover `resolveCliModel`'s fuzzy ids and aliases, and any exact or substring check would falsely refuse `/model gemma`-style fuzzy local names. Changing the wording would mean growing patch 0003 for cosmetics; leave it.

## Tag gate and Phase 9 additions

Nothing in the repair report blocks `rebrand-wave-c-fixed`. Before tagging:

1. The running full gate (Shared commands) exits 0 on `b8e0423`.
2. Add one command the Shared gate lacks: `cd /home/tung491/WORK/worktrees/rebrand-integration && bun run build:pack && bun scripts/check-assistant-pack.ts resources/omp.linux-x64` → `PACK LOAD CHECK: PASS`. The pack check takes the sidecar path as its argument, so no `resources/omp` symlink is needed.
3. `git tag rebrand-wave-c-fixed`.

Phase 9 file edits before 9.0 starts (`/home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/phase-09-copy-and-release.md`):

- Ownership (line 27): add `src/renderer/lib/command-availability.ts` and its test "in Task 9.0 only"; widen the `e2e/**` clause with "or to record the local-only refusals the Wave C repair introduced (deep-audit: pack-pinned condition gates, model-valued custom strings)".
- Task 9.0 step 2c (after line 39): the `/modelpreset` removal from Q4.
- Task 9.0 step 3 (line 40): the two deep-audit rules from Q1, plus "a condition gate on a pack-pinned key is never written".
- Task 9.0 step 4 (line 41): third commit `fix(ui): refuse the model preset command`.
- Task 9.6 step 2 (line 77): seed `~/.env` with fake provider keys. Step 3: add typed `/model anthropic/claude-sonnet-4-5` and `/login`. Step 4 (line 79): replace "a cloud tag is refused by the app since Phase 8 Task 8.6" with "refused by the sidecar's pinned `modelPolicy` (`patches/omp/0003-model-policy-local-only.patch`) and by the app"; the planted keys must produce no connect row.
- Task 9.7 step 4 (line 88): per-sidecar `check-assistant-pack` PASS and the backup cleanup from Q2; state that the main checkout's `resources/omp` is replaced in this step and not before.
- `plan.md` Decisions "Removed commands" (line 44): append `modelpreset` with the global-config reason.

Non-blocking notes for later, outside Phase 9's ownership:

- `scripts/check-test-parity.ts` blanks text after `//` inside Rust string literals (the implementer worked around it with `127.0.0.1:11434`). A latent tooling defect; file a follow-up, do not fix in Phase 9.
- `patches/omp/0003-model-policy-local-only.patch` carries a `Co-Authored-By: Claude Opus 5.5` trailer in its header. `build:omp` applies with `git apply` (`scripts/build-bundled-omp.ts:271`), so it never enters any history; drop it the next time the patch is regenerated.
- The Tauri removed-command case failing only inside the full run (overlay left by an earlier failing test) is already covered by 9.0 step 3's "earlier failed test left a dialog open" clause.

## What to avoid

- Editing the deep-audit assertions on the integration branch now "to make the tag cleaner": e2e is red by design until 9.0 step 3, and a tag on a commit the gate did not run is worse than two known soft errors.
- A renderer-side model-selector grammar (Q5) or a dotenv scanner in the shells (Q3): both add code that is not the enforcer and can only produce false refusals or false alarms.
- Rebuilding sidecars from the standalone checkout (fails) or replacing the main checkout's `omp` before the rebrand reaches `main` (breaks Electron dev on `main`).
- Letting 9.0 start with the current step-3 wording: it STOPs on the two intended failures and burns a kongming round.

## Work checklist

1. Wait for the gate on `b8e0423`; run the pack check (tag gate step 2); tag `rebrand-wave-c-fixed`.
2. Apply the Phase 9 file edits listed above and the `plan.md` Decisions row.
3. Start Task 9.0; expect two commits already named plus `fix(ui): refuse the model preset command`.
4. In 9.6, seed `~/.env` and type the two online requests; in 9.7 step 4, pack-check each rebuilt sidecar, then delete the two `.pre-*` backups.

## Success metrics

- `rebrand-wave-c-fixed` points at a commit on which both the Shared gate and the pack check passed.
- Task 9.0 completes without a STOP on deep-audit; both e2e suites exit 0 at `rebrand-pre-release`.
- The egress audit shows no "not allowed" row with planted keys present and a typed online `/model`.
- Every shipped sidecar passes `check-assistant-pack` before the version bump.

## Assumptions

- The user's local-only decision (2026-10-06) covers removing `/modelpreset` as a developer surface; confidence high (it is the `/model-roles` family and it writes the user's global config). If the user wants presets of local models kept, keep the command and instead have 9.0 add a composer check that refuses `switch`/`save` and allows `list`.
- The deep-audit soft errors are only the two the report names; confidence medium (the implementer ran both shells once). If 9.0 finds more, each is classified against the `rebrand-wave-c` baseline as the plan already prescribes.
- `bun run build:pack` is required before `check-assistant-pack` in a fresh worktree; confidence medium (the integration worktree's `resources/assistant-pack` is dated 21:04 and may already be current). Running it is harmless either way.
- The egress container can create `~/.env` before first run inside `scripts/tauri-deb-smoke.sh`'s session; confidence medium. If the script's home is not writable before launch, seed through the same mechanism 9.6 step 2 uses for `~/.omp/agent`.
