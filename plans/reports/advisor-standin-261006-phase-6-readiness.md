Opus stand-in for kongming (Fable rate-limited, 2026-10-06)

# Phase 6 readiness counsel (after Phase 5)

Inputs: `plans/261005-0812-everyday-work-rebrand/phase-06-spawn-wiring.md`, `phase-07-*.md`, `phase-08-*.md`, `plan.md`, `reports/kongming-261006-phase-5-checkpoint.md`. Every claim below was checked read-only on `/home/tung491/WORK/worktrees/rebrand-integration` at `1f38391`.

## TL;DR

Phase 5 is sound, so close it. Phase 6 is **not ready as written**. P6-1..P6-4 landed correctly, but six must-fix edits remain:

- Two would break CI after the merge while every local gate stays green (M1, M3).
- Two would trip the Failure Protocol on a mechanical step (M2, M4).
- Two are small gaps in ownership and the sync script (M5, M6).

Wave C has no file owned by both Phase 7 and Phase 8. Phase 8's pinned-key list is stale by one key, `skills.ignoredSkills`.

## Q1: Phase 5 verdict (no remaining real risk)

- **Vietnamese-only use is impossible.** `translateForLang` falls back `locale[key] ?? en[key] ?? key` (`src/renderer/lib/i18n.tsx:38`), and `locales.test.ts` keeps the two tables key-identical.
- **Main and Tauri never read the renderer tables.**
  - `src/main` has its own table (`src/main/i18n.ts`).
  - Rust reads only `src/main/i18n.ts` (`src-tauri/src/i18n.rs:219`).
  - No file in `src/main`, `src/shared`, `src-tauri/src`, `e2e` or `e2e-tauri` contains any of the 1,468 deleted keys as a literal. I extracted the keys from `git diff rebrand-wave-a-fixed rebrand-p05` and compared. The only hits are in `scripts/capture-showcase.ts:194-234`: `sidebar.nav.agentHub`, `titlebar.providers|stats|usage`, `contextUsage.open`, `cmd.modelRoles`, `modelRoles.title` and `panel.tabs.diff`. These are already routed to Phase 9 Task 9.4 (prior P5-4).
- **Keys built from omp payloads are safe.**
  - None of the deleted keys falls under `jobs.type.*`, `titlebar.status.*` or `settings.source.*`.
  - `settings.tabs.*` (8 deleted) and `tools.coordination.status.*` are looked up with a fallback to the raw label (`SettingsWindow.tsx:782-785`, `CoordinationRenderer.tsx:156-160`). The worst case is an English schema label for a Vietnamese user on a tab that omp does not emit today. That is cosmetic, so accept it.

## Q2: Phase 6 readiness

P6-1..P6-4 are present and match the code:
- the fixture fallback is in Context and Task 6.2;
- the trailing-slash map is in Task 6.5;
- the Language bullet is in Task 6.4;
- the `profileToFlags`, `:17` and `manager.rs:1202` items are in place.

The pack file list matches the build output (`find resources/assistant-pack -type f`: 8 files, identical). Line citations check out to within one line.

### Must-fix

**M1. CI's `tauri-linux` job never builds the pack, so the Rust suite breaks on CI only.**

Every Rust test that spawns a sidecar has no `assistant-pack/` beside its binary:
- `fixture_path()` (`e2e/sidecar-fixture.ts`), used by the `manager.rs` tests, `omp/ipc.rs:127` and `omp/shell_env.rs:347`;
- the temp-dir `write_script` cases in `manager.rs`.

With `--all-features` (`e2e-hooks`), all of them fall back to `<repo>/resources/assistant-pack`. That directory is gitignored (`.gitignore:18`), and `ci.yml:102-105` runs `bun install`, then `build:renderer:tauri`, clippy and `cargo test`, with no `build:pack` step. The local gate passes because Task 6.0 built the pack, and CI then fails.

- **Ownership**, add after the Scripts bullet: "- CI: `.github/workflows/ci.yml` (the `tauri-linux` job only)."
- **Task 6.4 Steps**, append: "- **CI:** in `.github/workflows/ci.yml`, job `tauri-linux`, add `- run: bun run build:pack` directly after its `bun install --frozen-lockfile` step. Rust tests that spawn the e2e fixture (`manager.rs`, `omp/ipc.rs`, `omp/shell_env.rs`) find the pack through the dev fallback, and `resources/assistant-pack` is gitignored."
- **Task 6.4 Verify**, append: "- `grep -n 'build:pack' .github/workflows/ci.yml` shows the line inside the `tauri-linux` job, before `cargo test`."

**M2. The TS red run loads modules that do not exist yet.**

`sidecar.test.ts` needs `ASSISTANT_PACK_FILES` for `makePackFixture()`. Without the module, the whole file fails at import. That takes down the cases it does not change, such as `names the missing packaged binary…` at `:344`, and that breaks Task 6.1's pass condition ("only in the new or changed cases"). Rust already handles this with stubs.

- **Task 6.1**, insert before "Target files": "- First create `src/main/assistant-pack.ts` with the final exports and signatures of Task 6.2 step 1 returning wrong values (`ASSISTANT_PACK_FILES = []`, `assistantPackFlags` → `[]`, `assistantPackEnv` → `{}`, `resolveAssistantPackDir` → `\"\"`, `missingAssistantPackFile` → `null`), so every suite loads and only the new or changed cases fail."

**M3. `resolveAssistantPackDir` cannot be twin-tested, and its fallback root is wrong for Electron e2e.**

Problem 1: the Electron e2e specs launch `out/main/index.js` (`e2e/runtime.e2e.ts:27` and the others), so `app.getAppPath()` is `out/main`, not the repo root. Task 6.2 never says what `sourceRoot` is. `resolveBundledOmp` handles this by walking up from `[app.getAppPath(), process.cwd()]` (`src/main/index.ts:93`).

Problem 2: Rust `resolve_pack_dir(binary)` hard-codes `CARGO_MANIFEST_DIR`. The twin test `resolves_the_pack_under_resources_for_a_fixture_sidecar_outside_the_tree` could then only pass against the repo's built pack, not a temp tree.

Problem 3: a missing-pack test that omits the directory entirely falls through to the repo pack under `e2e-hooks`, so it never sees a refusal.

- **Task 6.2 step 1**, replace the `resolveAssistantPackDir` bullet with: "`resolveAssistantPackDir(binaryPath, searchFrom: readonly string[] = [])`: `join(dirname(binaryPath), \"assistant-pack\")` when that directory exists (never `realpath` the binary first: a worktree's `resources/omp.linux-x64` is a symlink into the main checkout). Otherwise it returns the first `<dir>/resources/assistant-pack` that exists, where `<dir>` is each `searchFrom` entry or one of its ancestors up to 8 levels, the same walk `resolveBundledOmp` does. When nothing is found it returns the beside-binary path, so the missing-file message names it. `src/main/index.ts` passes `searchFrom = [app.getAppPath(), process.cwd()]` only when `!app.isPackaged` or `process.env.OMP_BUNDLED_OMP === bundledOmp`. The manager receives it as a new optional `SidecarManagerOptions.packSearchFrom`."
- **Task 6.4**, replace the `assistant_pack.rs` bullet with: "**`assistant_pack.rs`:** replace the stubs, mirroring Task 6.2 step 1. `resolve_pack_dir(binary: &Path, search_from: &[PathBuf]) -> PathBuf` uses the same rule. The manager passes `&[PathBuf::from(env!(\"CARGO_MANIFEST_DIR\"))]` when `tauri::is_dev()` or `cfg!(feature = \"e2e-hooks\")`, and `&[]` otherwise. Tests pass temp roots."
- **Task 6.1**, `sidecar.test.ts` bullet `surfaces a reinstall instruction…`, append: "The fixture creates `assistant-pack/` beside the binary with one listed file left out (not an absent directory), so no fallback applies. Construct it with `packaged: true`." Apply the same rule to its Rust twin in Task 6.3.

**M4. The Task 6.7 command cannot start, and its `pgrep` matches two processes.**

The `HOME` problem: `HOME=$H` turns `CARGO_HOME_BIN="$HOME/.cargo/bin"` (`scripts/rust-pins.env`) into an empty path. `tauri-dev.ts:67-75` then fails with `CARGO_TAURI_MISSING`, and rustup and cargo would look for toolchains and the registry under `$H`.

The `pgrep` problem: on Linux the supervisor's argv carries omp's full argv (`manager.rs:241-247, 271-274`: `<gui> --omp-supervise <omp> --mode rpc-ui …`).

- **Step 1 block**, replace with:
  ```sh
  H=$(mktemp -d)
  scripts/virtual-display.sh run -- env CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup" CARGO_HOME_BIN="$HOME/.cargo/bin" HOME="$H" bun run dev:tauri -- --user-data-dir=$(mktemp -d)
  ```
- **Step 3**, replace the `pgrep` text with: "`pgrep -af -- '--mode rpc-ui' | grep -- '--extension' | grep -v -- '--omp-supervise'` (prints exactly one line: the omp stats server lacks `--extension`, and the supervisor carries `--omp-supervise`)".

**M5. The sync script checks a pack it never built.**

`resources/assistant-pack` is gitignored and `sync-upstream.sh:69-70` runs only `build:omp`.

- **Task 6.6**, replace the `sync-upstream.sh` bullet with: "In `sync-upstream.sh`, right after the `build:omp` step, run `bun --cwd=\"$GUI\" run build:pack` and then `bun --cwd=\"$GUI\" scripts/check-assistant-pack.ts resources/omp` (the binary that step just wrote on the build host)."

**M6. The index.ts ownership is too narrow for the edits it requires.**

`index.ts` has no `./i18n` import today, and M3 needs `OMP_BUNDLED_OMP` at the construction site.

- **Ownership**, Electron main item, replace "`src/main/index.ts` (only the `SidecarManager` construction at :357 and its option values)" with "`src/main/index.ts` (only its import lines and the `SidecarManager` construction at :357 and its option values)".

### Should-fix

- **S1, Task 6.4 Language.** The text says `self.inner.ctx`, but `spawn` is on `Inner` and the code reads `self.ctx` (`manager.rs:559`; `:227` is the helper's definition). Use `self.ctx.upgrade().map_or("en", |ctx| ctx.i18n.language().code())`. `MainLanguage::code` exists (`i18n.rs:17`).
- **S2, `language` manager option.** Make it optional, defaulting to `"en"`, which mirrors Rust's `Weak::new()` default. The existing cases then do not each need it.
- **S3, platform.** State that `platform === "linux"` gets the Linux list and everything else gets the macOS list. Windows is dropped in Phase 7, but `win32` is still a reachable value today.
- **S4, missing-pack message.** Mirror `missingSidecarMessage(packaged)`:
  - packaged builds name the file and say "Reinstall Sai ATLAS";
  - dev builds name the file and say "run `bun run build:pack`". Risks already promises "the error says what to run".
- **S5, check order.** Run the pack check after the missing-binary check in `start()`. The `binaryPath: ""` cases at `sidecar.test.ts:311` and `:329` then stay unchanged, so drop them from the "11 in total" fixture rewrite.
- **S6, Rust twins of removed TS cases.** In Task 6.3, name the deletion: "delete the Rust twins of the four replaced `tab-spawn.test.ts` cases and of `spawns a chat sidecar…`". They pass at red and would fail at green. Also name the new twin `surfaces_a_reinstall_instruction_when_a_pack_file_is_missing` in `manager.rs`. `sidecar.test.ts` maps to `manager.rs` (`omp.parity.json`).
- **S7, strip test coverage.** `launch-profile.test.ts` has no parity row, so nothing forces the Rust strip function to match. Extend `strips_denylisted_flags_pair_aware` (`manager.rs:1090`) with the new lists and the `-e` rule.
- **S8, short options.** After an unknown `-x` is dropped, its value passes through as an omp positional argument. Specify that any non-`--` token not consumed as the value of an allowed valued flag is dropped. The risk is low: stored profiles emit only flag tokens and `extraFlags` is empty in production.
- **S9, expected argv.** Write the expected argv in `sidecar.test.ts` as a literal array, not as `assistantPackFlags(...)`, so the test does not restate the code it checks.

### Red-run scope and parity order

Confirmed. Task 6.3 Verify already runs the parity loop first, which is the right order: it catches a name drift before `cargo test` spends its build time.

The loop must find twins for these cases:
- the 7 `assistant-pack.test.ts` cases;
- 2 new `sidecar.test.ts` cases;
- 3 new `tab-spawn.test.ts` cases (`tabs.parity.json:7`);
- 1 new `shell-env.test.ts` case.

With M2's stubs, both red runs fail only in the listed cases.

## Q3: Wave B/C sequencing

Running Phase 6 alone, then Phases 7 and 8 in parallel, is right.

- **No file is owned by both Phase 7 and Phase 8.** Phase 7 owns `src/main/**`, `src/shared/{ipc-types.ts,bridge/**}`, `src-tauri/**`, `e2e*/**`, Windows packaging and `AGENTS.md`. Phase 8 owns `src/renderer/**` only.
- **Phase 7's bridge deletions do not break Phase 8.** It removes the `stats`/`bench` bridge entries, and the renderer has zero callers (`rg 'omp\.(stats|bench)' src/renderer` finds nothing). So Phase 7's `check:types` holds without Phase 8.
- **The `MenuAction` trim stays in Phase 9.**
- **Phase 6's shared files cause no collision.** Files it shares with Phase 7 (`electron-builder.yml`, `scripts/tauri-packaging-config.test.ts`, `index.ts`, `sidecar.ts`) and with Phase 8 (`src/renderer/lib/launch-profile.test.ts`) are touched in sequence.
- **Wave C must-fix (phase-08):** `PACK_PINNED_SETTING_KEYS` (Task at `phase-08-everyday-ux.md:106`) says "the nine `skills.*` keys". The pack now pins ten, because `skills.ignoredSkills` was added by the orchestrator follow-up (`assistant-pack/config.yml`). Replace "the nine `skills.*` keys of the block (the seven `skills.enable*` keys, `skills.customDirectories`, `skills.includeSkills`)" with "the ten `skills.*` keys of the block (the seven `skills.enable*` keys, `skills.customDirectories`, `skills.includeSkills`, `skills.ignoredSkills`)".

## Q4: Next highest risk and containment

1. **CI-only failure after the Wave B merge** (M1). Containment: apply M1. After merging, push the integration branch to a scratch remote branch, or run the `tauri-linux` steps in a fresh clone without `resources/assistant-pack`, before tagging `rebrand-wave-b`.
2. **Drift between pinned keys in Wave C.** The pack's `config.yml` changed twice after Phase 8 was written. Containment: Phase 8's test should parse `assistant-pack/config.yml` (fs plus `yaml`, as `assistant-pack/test/pack-files.test.ts` does), flatten it to dotted keys, and assert that `PACK_PINNED_SETTING_KEYS` covers every one. A hand-written list then cannot fall behind again.
3. **Real-core e2e without `bash`** (unchanged from prior counsel). It stays in Phase 9 Task 9.0. Do not fix it in Phase 6.

Status: DONE_WITH_CONCERNS
Summary: Phase 5 is clean. Phase 6 needs six must-fix edits before Wave B starts (M1-M6, with exact text above), the most important being that CI's `tauri-linux` job must run `build:pack`. Wave C ownership is disjoint, and Phase 8's pinned-key list must add `skills.ignoredSkills`.
Concerns/Blockers: Electron e2e is not in Phase 6's gate, so M3's `searchFrom` walk is only proven by unit tests until Phase 9 Task 9.0.
