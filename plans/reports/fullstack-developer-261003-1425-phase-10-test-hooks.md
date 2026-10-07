# Phase 10 Task 10.2 (Test hooks) — implementation report

- Plan: `plans/261002-1441-tauri-shell-migration/phase-10-integration-e2e-parity.md`, Task 10.2, Stage B lane 1
- Worktree: `/home/tung491/WORK/worktrees/tauri-e2e-hooks`, branch `tauri/e2e-hooks` (from `tauri/integration` @ a98b4d4), not pushed
- Status: DONE_WITH_CONCERNS (all Verify steps pass; two handoff concerns for lane 2 below)

## Commits

| Commit | Scope |
|---|---|
| `37ddb4a` feat(tauri): let scripted faults hold then reply and count calls | `src-tauri/src/bridge.rs` (e2e-hooks-gated only) |
| `24b94b4` feat(tauri): add runtime, call-count and barrier hooks for the e2e suite | `src-tauri/src/test_hooks.rs`, `src-tauri/src/desktop/mod.rs` (one gated accessor) |
| `8f1f0c8` test(e2e): map every Electron main-process reach-in to a Tauri hook | `e2e-tauri/reach-ins.json`, `e2e-tauri/test-hooks.ts`, `tsconfig.json`, `biome.json` |

## Inventory (step 1–2)

`grep -nE "\bapp\.evaluate\(" e2e/*.e2e.ts` finds **34** reach-ins, matching the plan's count (desktop 16, real-core 6, packaged-smoke 3, quick-entry 3, runtime 2, deep-audit 2, onboarding 1, auto-follow 1). `jq length e2e-tauri/reach-ins.json` prints `34`. Each entry carries `file`, `line`, `test`, `does`, `hook`, `payload` and a `twin` line showing the helper call; helper-level reach-ins also list `helper` and `usedBy`.

Hook per category:

| Reach-in category | Count | Hook |
|---|---|---|
| `app.exit(0)` teardown | 8 | `test:quit` (approves the quit, then `Host::exit(0)`; no dialog) |
| runtime evidence (`isPackaged`, `execPath`, sidecar env) | 2 | `test:runtime` (new) |
| `webContents.send("config:update", …)` | 2 | `test:emit` |
| `will-navigate` probe + its poll | 2 | `test:navigation-probe` |
| `ipcMain.removeHandler/handle` overrides | 2 | `test:fault` with `{ barrier, error }`, `{ barrier, value }`, `{ value }`, `{ error }` and the `when` first-argument filter |
| `audit*Requested` polls | 3 | `test:barrier-waiters` (new) |
| `Promise.withResolvers().resolve()` releases | 3 | `test:release` |
| `auditRestarts` assertions | 3 | `test:calls` (new) + `test:fault { error }` on `sidecar:restart` |
| `second-instance` emit | 1 | `test:second-instance` (`argv: ["sai-atlas", "--quick-entry"]`) |
| `barVisible()` (dev build) | 1 | `test:windows` (now with `visible`) |
| `setSize` + `setZoomFactor` | 2 | WebDriver `setWindowRect` + renderer zoom (CSS `zoom` on `<html>`) |
| `capturePage` | 1 | WebDriver `takeScreenshot` |
| export window `loadURL` | 1 | second WebDriver session (never an app window) |
| packaged-smoke (`argv`, renderer pid, `barVisible`) | 3 | external observation (`/proc`, compositor window list) — the installed `.deb` has no `e2e-hooks`, per Task 10.3 step 4 |

## New hooks (step 3) and why

- `test:runtime` → `{ pid, executable, debugBuild, userDataDir, sidecar, sidecarError }`. Replaces the Electron runtime evidence. Reads paths only (`user_data_dir_switch(argv)`, `resolve_bundled_omp()`); it never resolves the default profile, so the unit test cannot touch `~/.config/@oh-my-pi/omp-gui`.
- `test:barrier-waiters { id }` → number of calls currently held. Replaces the `auditProxyRequested` / `auditLaunchRequested` / `auditPrefsRequested` polls.
- `test:calls { channel }` → calls that reached the channel (faulted ones included). Replaces the `auditRestarts` recorder.
- `test:fault` extensions: `{ barrier, error }` (hold, then reject: Electron's `await pending.promise; throw`), `{ barrier, value }` and `{ value }` (canned reply: Electron's `prefs:get` snapshot override), and `when` (apply only when the first argument deep-equals it: the unkeyed `prefs:get` `{}` while keyed gets from `themes.ts`, `settings.ts`, `input-history.ts` keep running — a blanket barrier on `prefs:get` would hang the page boot).
- `test:windows` gained `visible` (`null` on a fake desktop).

None loads a URL into an app window or replaces a handler with code; canned replies are JSON data.

## `bridge.rs` changes (all `#[cfg(feature = "e2e-hooks")]`)

- `Fault` gained `Value`, `BarrierThenError`, `BarrierThenValue`; `Faults` holds `FaultRule { fault, first_arg }` and a per-channel call counter.
- New methods: `set_fault_when`, `barrier_waiters`, `calls_to`; `hold_at_barrier` factors the watch subscription.
- `pub const E2E_HOOK_GEN = "e2e-hooks"`: `Bridge::invoke` runs `test:*` calls on that page generation at once (`run_hook_call`), out of band of the page's ordered queue, and rejects any other channel on it. Needed because the page's `gen`/`seq` are private to `createTauriPort` and a `test:release` must never queue behind the call it frees. The feature-off path keeps the old behaviour; `cargo clippy` without features is clean.
- Tests added: `a_barrier_fault_can_reject_or_answer_once_released`, `a_fault_scoped_to_one_payload_leaves_other_calls_alone`, `the_hook_generation_runs_test_channels_ahead_of_an_unattached_page`. The Stage A `a_barrier_released_before_the_call_waits_still_releases_it` is untouched and passes.

`desktop/mod.rs`: one gated `pub(crate) fn is_window_visible(&self, id)` (the `Backend` field is private and `DesktopPort` is frozen).

## `e2e-tauri/test-hooks.ts` (step 4)

Exports (one line of doc each in the file): `currentWindowId`, `setFault`, `setFaultWhen`, `releaseBarrier`, `barrierWaiters`, `callsTo`, `emitToWindow`, `listWindows`, `quickEntryVisible`, `secondInstance`, `navigationProbe`, `runtimeFacts`, `quitApp`, `setPageZoom`; types `HookBrowser`, `FaultSpec`, `HookWindow`, `HookRuntime`, `NavigationProbe`.

Transport: every helper runs a self-contained script through `browser.execute` that calls `window.__TAURI_INTERNALS__.invoke("omp_invoke", { channel, args: [payload], seq: 0, gen: "e2e-hooks" })` — the same command `src/renderer/boot/tauri-port.ts` uses, on the hook generation. Helpers take a `HookBrowser` (the `execute` slice of `WebdriverIO.Browser`) so the file typechecks without the wdio packages, which lane 2 installs; pass the `browser` global. `quitApp` is fire-and-forget because the process exits before replying. No `any`.

## Verify

| Check | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml test_hooks` | exit 0, 1 test (`no_test_hook_is_registered_without_e2e_hooks`) |
| `cargo test … --features e2e-hooks -- test_hooks bridge::tests` | exit 0, 42 passed, includes `a_barrier_released_before_the_call_waits_still_releases_it` |
| `jq length e2e-tauri/reach-ins.json` | 34 |
| `cargo test … --all-features` | exit 0, 670 passed (+2 in `channels`) |
| `cargo clippy --all-features --all-targets -- -D warnings -D clippy::unwrap_used -D clippy::expect_used` | exit 0 |
| same clippy without features | exit 0 |
| `bun run check:types` | exit 0 |
| `bunx biome check e2e-tauri` | exit 0 |
| `git diff a98b4d4 -- src-tauri/contracts` | empty; no frozen file touched |
| leftover `omp` / fixture / supervise processes | none; the app was never launched |

## Concerns for lane 2 / the controller

1. **Shared config touchpoints.** `tsconfig.json` `include` and `biome.json` `files.includes` each gained `"e2e-tauri/**/*.ts"` so the helpers are gated by `check:types` and biome. Lane 2's specs land in the same directory and will be typechecked too; if lane 2 also edits these two files the merge conflict is one line each.
2. **No sidecar override in the Tauri build.** The Electron specs point the app at `e2e/sidecar-fixture.ts` through `OMP_BUNDLED_OMP`; the Rust side (`omp/mod.rs::omp_binary` → `paths::resolve_bundled_omp()`) honours no such variable, and `test:runtime` therefore has no `sidecarOverride` field (it reports the resolved `sidecar` path instead). Lane 2 needs another route to run the fixture-backed specs (for example staging the fixture as the bundled binary of the wdio build); this is outside Task 10.2 and I did not add an override.
3. **Visibility and the second-session twin.** `quickEntryVisible` relies on `test:windows.visible` (Tauri `is_visible`); the real-core export page twin is a WebDriver second session per the plan, which lane 2 owns.
