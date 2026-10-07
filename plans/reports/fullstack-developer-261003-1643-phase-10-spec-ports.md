# Tauri e2e spec ports, part 2 (Linux)

- Plan: `plans/261002-1441-tauri-shell-migration/phase-10-integration-e2e-parity.md`, Task 10.3 (steps 2–5)
- Worktree: `/home/tung491/WORK/worktrees/tauri-integration`, branch `tauri/integration` (`c284c5f` → `e4f4193`), not pushed
- Status: DONE_WITH_CONCERNS

## Outcome

Every Playwright spec has a twin, and `bun e2e-tauri/check-twins.ts` exits 0. `bun run test:e2e:tauri` runs 8 spec files green, but exits 1 on `deep-audit`. That spec fails on 30 setting rows, and the same 30 rows fail on Electron. The cause is an agent-side defect in the monorepo, which I was not authorized to change (see Blocker). The two failing specs from part 1 now pass; their causes were one product defect and one fixture defect.

## Commits

| Commit | What |
|---|---|
| `b5650b0` fix(gui) | Transcript follower: one offset write instead of `virtualizer.scrollToEnd()` |
| `87fac25` test(e2e) | Sidecar fixture frames oversized replies like the agent (v2 chunks / overflow frame) |
| `883e07e` test(e2e) | Tauri specs get their timeout before the body runs; hook helpers typed against WDIO |
| `f06efb0` test(e2e) | Port quick-entry (9 tests, 680×168 asserted on every summon) |
| `7fe4581` test(e2e) | Port desktop (21 tests) |
| `196c3f1` fix(gui) | Behavior stats read `/api/stats/frustration` (Electron + Tauri allowlists, page, locales, CHANGELOG) |
| `85e8569` test(e2e) | real-core original: assert no welcome (stale since `860bd50`) |
| `1717b43` test(e2e) | Port real-core; second WebKitWebDriver + MiniBrowser for the exported HTML |
| `1b82a23` test(e2e) | packaged-smoke twin, `e2e-tauri/outside.ts`, `wdio.packaged.conf.ts` |
| `ff61ff0` fix(tauri) | `omp stats` runs under the sidecar supervisor |
| `e49cc43` test(e2e) | `onComplete` fails a run that leaves a launched process behind; hard-kill smoke opens stats |
| `e40acb6` test(e2e) | deep-audit original: no unconditional Escape, per-row "window visible" check, host-aware shortcut label |
| `c5e74ae` test(e2e) | Port deep-audit |
| `e4f4193` fix(tauri) | Stats exit task no longer SIGKILLs the supervisor when its record drops |

## Defects found and fixed (with cause)

1. **runtime (50k history never rendered).** The fixture wrote `get_messages` as one 9.6 MB v1 line. The Rust reader drops lines over 1 MiB (`rpc_bridge.rs`). The real agent never sends such a line: it negotiates v2 and chunks the reply, or sends an overflow frame. Fixed in the fixture (`87fac25`), not the Rust cap. Separately, an in-body `this.timeout()` never extends WDIO's race, so the twins now chain `.timeout()` instead.
2. **auto-follow (product, both shells).** The follower's `scrollToEnd()` armed TanStack's index reconcile. While the last row kept growing, that reconcile re-scrolled to the tail every frame, outliving the reader's wheel-up. WebKit frames (~43 ms) are slower than the stream's chunks (16 ms), so it always lost there; Chromium mostly won by cadence. Fixed with `scrollToLiveEdge` (`b5650b0`).
3. **Behavior stats 404 (product, both shells).** The agent renamed the route to `/api/stats/frustration` with a new payload; the GUI never followed. Fixed with a unit test (`196c3f1`). The Electron release on `main` needs this commit too.
4. **Orphaned `omp stats` (Tauri).** The stats server was a plain child, so a killed or crashed shell left it running. It is now supervised (`ff61ff0`), with a SIGKILL test proven to fail without the fix. My first version had a race: the exit task's `kill_rx` also fired on sender drop, SIGKILLing the supervisor during a graceful quit. Fixed in `e4f4193`. The strengthened ipc test fails 2 runs in 5 without that fix.
5. **Stale Playwright originals.** All three corrections must also pass on Electron, and they keep or add assertions:
   - real-core still required the pre-`860bd50` welcome wizard.
   - deep-audit pressed Escape with no picker open, which closed Settings and cascaded through every later row.
   - deep-audit asserted the macOS-only `⌘K / ⌃K` label.

   This deviates from the phase text "e2e/** keeps every existing test unchanged". Both originals were already red on Electron, unchanged.

Translation fixes in the harness:
- WebDriver's Element Clear blurs the field, so a `fill` helper selects and inserts instead.
- WebKitWebDriver's element text is empty inside the bar's webview, so text assertions compare `textContent`, which is what Playwright compares.
- WebDriver turns an `undefined` property into `null`, so results that can be unset come back as page-side JSON.
- Role and name lookups compute the accessible name from DOM text, ignoring CSS `text-transform`.
- WebKit has no devtools listener API, so the document-listener audit counts registrations in the page. It saw 200 and a net of 0.

## Per-spec results (`bun run test:e2e:tauri`, last full run)

| Spec | Result |
|---|---|
| auto-follow | 1/1 |
| csp | 1/1 |
| desktop | 21/21 |
| onboarding | 1/1 |
| performance | 0 run, 1 skipped (`OMP_GUI_PERFORMANCE` gate, as the original) |
| quick-entry | 9/9 |
| real-core | 1/1 (no env gate, as the original: real `resources/omp`, local operations only) |
| runtime | 1/1, 1 skipped (`OMP_GUI_LEGACY_CORE` gate) |
| deep-audit | 0/1: 30 failed rows, identical to Electron (below) |
| packaged-smoke | excluded from the default run (not run) |

`check-twins`: `9 spec file(s), 44 test(s), every twin matches`.

Gates on `e4f4193`, all exit 0:
- `cargo test --all-features`: 673 + 2 passed
- clippy with all features and all targets, and with no features
- vitest: 209 files, 1948 tests
- `check:types`
- `biome check e2e-tauri wdio.conf.ts`
- `bun run build`

Safety:
- `~/.omp/agent/sessions`: unchanged.
- `prefs.json` mtime: `2026-10-02 18:18:23` (unchanged).
- Nothing installed; no `.desktop` file.
- No leftover processes; no `/tmp/omp-gui-wdio-*` directories.

## Blocker: the agent rejects "Remove global override"

The 30 failing `deep-audit` rows are the same set on Electron and Tauri: 522 rows, 417 passed, 30 failed. Every one fails at `restoreInitial` with "Expected undefined, received <written value>".

Cause, in the monorepo at `411f2721`: `rpc-mode.ts:3272-3292` validates `set_setting`'s value before `Setting.set()`. `undefined` (unset) is therefore rejected, although `Setting.set` defines `undefined` as unset. A replay reproduces it in seconds:

```
{"type":"set_setting","path":"worktree.base"} → success:false "Invalid value for worktree.base: undefined (expected a string)"
```

The fix is a one-line guard (`if (command.value !== undefined) validateRpcSettingValue(...)`) plus a sidecar rebuild with `build:omp` in `/home/tung491/WORK/oh-my-pi/packages/gui`. That means a monorepo commit and fork push, and a rebuild that patches the shared monorepo while it runs. All of that is outside this brief (commit only in this worktree, no push), so it needs your go-ahead. After it lands, `deep-audit` should pass on both shells. The palette and nested-surface sections already pass on Tauri: 90 commands, 0 missing, 12 nested surfaces, 0 failed.

## How to run packaged-smoke

```
OMP_GUI_TEST_APP=/usr/bin/sai-atlas bun run test:e2e:tauri:packaged
```

Run it only after the Tauri `.deb` is installed. The default `wdio.conf.ts` excludes the spec.

How it works:
- Page steps go through WebDriver; release builds honour `TAURI_WEBVIEW_AUTOMATION`.
- The shell is observed from outside: `/proc`, the session bus (`<single_instance_id>.SingleInstance`), AT-SPI for windows (GNOME denies `GetWindows`), and a `WAYLAND_DEBUG` trace for the app id.
- I ran the `outside.ts` helpers against the e2e debug build in a throwaway probe. Each gave the expected result: the web process had `Seccomp 2`, a nested `NSpid` and a `bwrap` parent; the app owned its bus name; AT-SPI listed both windows, including the bar at 680×168; the app id was `vn.io.vif.saiatlas`.
- The spec itself has never run.

## Unverified / concerns

- **packaged-smoke** is unrun against a real package. These steps are unverified:
  - the `omp://` cold launch
  - `updater.check()` JSON on the Tauri updater
  - the hard-kill flow
  - window handles of release-build webviews
- **Hard-kill smoke strengthened.** The hard-kill test checks four pgreps (the plan's three plus `omp stats`), scoped to the profile's agent dir so the user's own omp never counts. The plan lists three. Please acknowledge the addition.
- **deep-audit timing.** It takes ~9 min on Tauri against a 600 s budget; the margin is thin.
- **Electron-only observations, out of scope:**
  - `app.exit(0)` leaves `omp stats` running, which times out Playwright's worker teardown for `real-core`.
  - In one `deep-audit` run, Escape after the "MCP Servers" submenu closed the whole palette (12 → 0 submenus). On Tauri the same step passed. Not rechecked.
- **Follow-up (product).** `RecordKvEditor` seeds `""` for records the agent validates, so "Add row" only produces an error toast (`task.agentServiceTierOverrides`).
- **Not mine, left running.** An 8-hour-old `bun /tmp/.tmpE7FgTE/stats.ts` predates this session.

## Unresolved questions

1. May I make the agent fix, which requires a monorepo commit and fork push plus a `build:omp` rebuild? Or will you schedule it?
2. Do you accept the three corrections to Playwright originals (real-core welcome, deep-audit Escape, shortcut label) despite "e2e/** unchanged"?
