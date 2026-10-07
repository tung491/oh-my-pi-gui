# Phase 10 Task 10.3 part 1: WebdriverIO harness and first spec ports

**Worktree:** `/home/tung491/WORK/worktrees/tauri-integration` · **Branch:** `tauri/integration` · **Base:** `a98b4d4` · **Tip:** see commits below · **Date:** 2026-10-03 (KST)

## Outcome

The harness, the twins check, the Tauri-only CSP spec, the Electron Send-button twin and the ports of `runtime`, `onboarding`, `auto-follow` and `performance` are written, typed, linted and committed. No ported spec could be run to green, for two reasons outside this part's file ownership:

1. **The embedded-assets build shows a blank main window.** Tauri drops `index.html` from `WebviewUrl::App("index.html")` (tauri 2.12.1 `src/manager/webview.rs:477-484`, "ignore index.html just to simplify the url"), so the window loads the bare `tauri://localhost`. For a non-special scheme the `url` crate keeps that path empty, and `webview::navigation_allowed` (`src-tauri/src/webview.rs:207`) accepts only `/index.html` or `/`, so the app's own navigation lock vetoes its initial load. Evidence: every launch of `src-tauri/target/debug/sai-atlas` (with or without WebDriver) logs exactly one `renderer-load` entry, `blocked navigation of main-1 to tauri://localhost`, and nothing else from the page; a WebDriver probe sees `getPageSource()` = `<html><head></head><body></body></html>`, an empty title, and the first `executeScript` hangs (W3C Execute Script waits on the never-finishing navigation). `node -e 'new URL("tauri://localhost").pathname'` prints `""`; the unit test at `webview.rs:715` only covers `tauri://localhost/`. `cargo tauri dev` is unaffected because `http://localhost:5183` normalises to `/`. Kongming confirmed the diagnosis and that **every packaged Linux bundle (.deb, AppImage) from `cargo tauri build` has the same blank window**, since they load the identical URL. Recommended fix (frozen file, not mine to edit here): in `navigation_allowed`, treat an empty path as `/` for the `index.html` page, and add `tauri://localhost` without a slash to `allows_the_initial_app_url`. The `blob:` early return and the dev-URL check are untouched by that change.
2. **The current binary does not honour `OMP_BUNDLED_OMP`.** It runs the real `resources/omp`, so no fixture-dependent spec can pass until lane 1's `e2e-hooks` override is merged and the binary rebuilt (as the coordinator planned). I did not add my own override. Note that this `--debug` build has `tauri::is_dev()` true (the supervisor spawned `src-tauri/../resources/omp`), so the updater's startup check is also off in it.

## Commits (on `tauri/integration`, not pushed)

| Commit | Subject |
|---|---|
| 1 | `test(e2e): cover the quick entry Send button` — `e2e/quick-entry.e2e.ts` |
| 2 | `build(e2e): add a WebdriverIO harness for the Tauri shell` — `package.json`, `bun.lock`, `biome.json`, `tsconfig.wdio.json`, `wdio.conf.ts`, `e2e-tauri/session.ts`, `e2e-tauri/launch-app.sh` |
| 3 | `test(e2e): check Playwright specs have Tauri twins, assert the Tauri CSP` — `e2e-tauri/check-twins.ts`, `e2e-tauri/csp.e2e.ts` |
| 4 | `test(e2e): port runtime, onboarding, auto-follow and performance to WebdriverIO` — four spec files |

The tree is clean. `test-results/` is gitignored.

## Session-launch design

- `wdio.conf.ts` starts one `tauri-driver --port 4444 --native-port 4445 --native-driver /usr/bin/WebKitWebDriver` in `onPrepare` (PID tracked, readiness polled on `/status`, both ports checked first and a busy port is an error naming its owner), one worker, spec glob `e2e-tauri/*.e2e.ts`, mocha, spec reporter.
- tauri-driver forwards only `tauri:options.application` and `.args`, and WebKitWebDriver starts the app in the driver's environment. So `application` is `e2e-tauri/launch-app.sh`: it sources the per-launch env file named by its first argument, refuses to start without `--user-data-dir`, and `exec`s the binary (same PID). `e2e-tauri/session.ts` → `prepareLaunch()` creates `<run dir>/<name>-XXXX/{desktop,agent,project,rpc.jsonl,launch.env}`, writes prefs through `e2e/desktop-prefs.ts`, and the env mirrors the Electron specs exactly: `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `OMP_PROFILE=""`, `PI_PROFILE=""`, `OMP_BUNDLED_OMP=e2e/sidecar-fixture.ts`, `OMP_GUI_TEST_RECORD`, optional `OMP_GUI_TEST_HISTORY`, plus spec extras.
- `beforeSession` prepares a plain launch for the session the runner opens per spec file. Specs needing their own history/prefs/env/sidecar call `launch(options)` (prepare + `browser.reloadSession(capabilities)`), and `relaunch(previous)` restarts the same profile (onboarding's second launch). WebKitWebDriver keeps one live session, which `reloadSession` respects. Documented in the `wdio.conf.ts` header.
- `onComplete` stops, by PID, every process whose command line carries `--user-data-dir=<run dir>`, then tauri-driver and its WebKitWebDriver child, then removes the run dir. `afterTest` saves a screenshot and the launch's `logs/gui-runtime.jsonl` to `test-results/` on failure (fired in the CSP run but could not produce output because the page was hung; unverified on a healthy page).
- Helpers: `awaitBridge`, `awaitMainWindow`, `until` (poll, return the last value, so the following `expect(` does the asserting — this is how `expect.poll` is translated and keeps assertion parity), `recorded`, `collectPageErrors`/`pageErrors` (WebDriver has no `pageerror`), `nodeOf`, `wheel` (W3C wheel actions), `nextFrame`.
- Types: `tsconfig.wdio.json` (extends root; `types: node, mocha, @wdio/globals/types, @wdio/mocha-framework, expect-webdriverio`; includes `e2e-tauri/**`, `wdio.conf.ts`, `src/renderer/global.d.ts`); `check:types` = `tsc --noEmit && tsc --noEmit -p tsconfig.wdio.json`. biome.json gained `e2e-tauri/**/*.ts`.

## Electron twin

`quick entry sends from the Send button` added to `e2e/quick-entry.e2e.ts` after `bun run build`. Run 1 of the modified spec: 7 passed, 2 failed (`sends a new chat and focuses the main window`, which runs before the new test, and `Escape hides quick entry`), both at `openQuickEntry`'s `barVisible` poll — Wayland window-visibility flakes right after the build. The unmodified spec passed 8/8 as a baseline, and the modified spec then passed 9/9 twice in a row.

## Ports

| File | Ported now | Waiting for part 2 (reach-ins) |
|---|---|---|
| `performance.e2e.ts` | the one test (gated by `OMP_GUI_PERFORMANCE=1` as the original; baseline root resolves to `<root>/src-tauri/target/debug/sai-atlas`; no CDP profile) | — |
| `runtime.e2e.ts` | both tests (the legacy-core one keeps its `OMP_GUI_LEGACY_CORE` gate; no CDP profile, WebKit has none) | — |
| `onboarding.e2e.ts` | the one test (fake Ollama via `src/main/ollama/test-fake-ollama`, `OLLAMA_HOST`/`OMP_GUI_TEST_OLLAMA_URL`/`OLLAMA_BASE_URL=""` as the original) | — |
| `auto-follow.e2e.ts` | the one test (wheel gestures through W3C actions) | — |
| `quick-entry.e2e.ts` | none: every test summons the bar through `app.emit("second-instance")` and reads `BrowserWindow.isVisible()` | all 9, incl. the new Send-button test (needs `secondInstance`, `quickEntryVisible`) |
| `csp.e2e.ts` | Tauri-only, written as specified; waits for the bridge only (the policy is a page property) | — |
| `desktop`, `real-core`, `deep-audit`, `packaged-smoke` | — | part 2 / Task 10.3 step 4 |

Translation notes: `aria-label` buttons are addressed as `button[aria-label="…"]` (Send (Enter), Abort, Jump to latest), the welcome dialog as `[role="dialog"][aria-label="Set up your local assistant"]`, new tab as `browser.keys(["Control", "t"])` (`tab.new`'s Ctrl twin), `toContainText` as `toHaveText(…, { containing: true })`, `toHaveCount(0)` as `toBeElementsArrayOfSize(0)`. The legacy-core test uses `aria/Refresh preview` and `aria/Upload and create link` because that button's markup was not checked.

## check-twins output (expected to fail until all specs are ported)

```
check-twins: 5 difference(s) across 9 spec file(s), 44 test(s)
  - deep-audit.e2e.ts: no twin in e2e-tauri/
  - desktop.e2e.ts: no twin in e2e-tauri/
  - packaged-smoke.e2e.ts: no twin in e2e-tauri/
  - quick-entry.e2e.ts: no twin in e2e-tauri/
  - real-core.e2e.ts: no twin in e2e-tauri/
```

The four ported files pass the title and per-test assertion checks.

## Checks

- `bun run check:types` (root + wdio): pass. `bunx biome check e2e-tauri wdio.conf.ts e2e/quick-entry.e2e.ts`: clean. `bunx vitest run --exclude '.claude/**' --exclude '.agentkit/**'`: 208 files, 1945 tests passed.
- `bun run test:e2e:tauri -- --spec e2e-tauri/csp.e2e.ts`: the chain works end to end (driver up, session created, app launched through the wrapper, cleanup leaves nothing) but the test times out on the blank page (item 1 above). No other ported spec was run (item 2).
- After every run `pgrep -af "tauri-driver|WebKitWebDriver|target/debug/sai-atlas|omp --mode rpc-ui|--omp-supervise|sidecar-fixture"` printed nothing; no `/tmp/omp-gui-wdio-*` left behind.
- Safety: `~/.omp/agent/sessions` has no new file; `~/.config/@oh-my-pi/omp-gui/prefs.json` mtime unchanged (`2026-10-02 18:18:23`); no `~/.local/share/applications/vn.io.vif.saiatlas.desktop`; nothing installed or removed; no release bundle built.

## Open questions for the coordinator

1. The navigation-lock defect (item 1) blocks every Tauri e2e run and, per kongming, every packaged Linux bundle; it should land before part 2.
2. Merge note: lane 1 adds `e2e-tauri/**` to the root `tsconfig.json` and `biome.json`. My branch adds `e2e-tauri/**/*.ts` to `biome.json` (trivial conflict) and keeps the wdio specs out of the root `tsconfig.json` on purpose: they rely on mocha/wdio globals (`describe`, `it`), so a root include would fail `tsc --noEmit` unless those types are added to the root `types` list (which then declares a global `expect` for the whole project). Suggest dropping the root-tsconfig include from lane 1 and relying on `tsconfig.wdio.json`.
3. Unverified until the fixture runs: W3C wheel actions and `Control+t` under WebKitWebDriver, `aria/` selectors, `toBeDisplayed` on the fading "Jump to latest" button, and the failure-artifact hook.
4. A non-dev Tauri build (`is_dev()` false, i.e. the bundles) enables the updater's startup check with no runtime switch; the current debug binary happens to be dev, so it did not matter here. Kongming's read: a check never downloads by itself, but an "update available" banner could shift layout during specs if the checkout version is behind the latest release. A `e2e-hooks`-only disable would remove the variable.
