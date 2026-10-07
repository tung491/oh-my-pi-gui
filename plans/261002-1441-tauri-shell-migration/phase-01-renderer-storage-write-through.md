---
phase: 1
title: "Mirror renderer localStorage into prefs.json and repoint the Electron update feed"
status: pending
priority: P1
effort: "2d"
dependencies: []
---

# Phase 1: Mirror renderer localStorage and repoint the Electron update feed

## Goal

One Electron release, handed to the installed users the way they got their current build (hand-shared `.deb`/`.AppImage`/DMG/installer files, per the Validation Log), does two things. First, it writes the renderer's five localStorage keys into `prefs.json`, so the Tauri build (new webview origin, empty localStorage) gets language, theme and UI state back. Second, it makes the in-app updater read the publishing repo `tung491/oh-my-pi-gui`, so every later release, the Tauri one included, arrives through the app. This phase does not depend on Phase 0's verdict, and it fixes a live hazard: today's installed builds poll `nornzach/oh-my-pi-gui`, whose latest release is omp 0.9.14, a different app id that they would offer as an update.

## Context

- Electron loads `file://` pages (`src/main/window.ts:103`); Tauri serves `tauri://localhost` (macOS/Linux) or `http://tauri.localhost` (Windows). localStorage does not carry over between origins.
- The five keys and their write sites (verified 2026-10-02):

| Key | Written at | Read at |
|---|---|---|
| `omp.lang` | `src/renderer/lib/i18n.tsx:22` | `src/renderer/lib/i18n.tsx:13` |
| `omp.themeScheme` | `src/renderer/lib/themes.ts:1730` | `src/renderer/lib/theme.ts:19`, `src/renderer/quick-entry/appearance.ts:18` |
| `omp.update.dismissed` | `src/renderer/stores/updater.ts:44` | `src/renderer/stores/updater.ts:28` |
| `omp.dock.focusHeight` | `src/renderer/components/chat/dock/WorkspaceDock.tsx:63` | same file, line 54 |
| `omp.palette.recent` | `src/renderer/components/dialogs/CommandPalette.tsx:60` | same file, line 51 |

- `window.omp.prefs.set(key, value)` goes through `PREFS_SET` (`src/main/ipc.ts:888`). electron-store nests dotted keys, so `rendererStorage.omp.lang` is stored as `{ "rendererStorage": { "omp": { "lang": … } } }`. Phase 2's Rust bootstrap reads exactly these paths.
- The quick-entry page has no `window.omp` (`src/preload/index.ts:396`), so the helper must tolerate a missing `window.omp`.

## Files

- Create: `src/shared/renderer-storage.ts` (the key list and the prefs path rule)
- Create: `src/renderer/lib/persisted-storage.ts`
- Create: `src/renderer/lib/persisted-storage.test.ts`
- Modify: `src/renderer/lib/i18n.tsx`, `src/renderer/lib/themes.ts`, `src/renderer/stores/updater.ts`, `src/renderer/components/chat/dock/WorkspaceDock.tsx`, `src/renderer/components/dialogs/CommandPalette.tsx`, `src/renderer/main.tsx`
- Modify: `CHANGELOG.md` (one line under the Unreleased section)
- Modify (feed): `src/main/updater.ts` (`RELEASE_DOWNLOAD_BASE`, line 55), `electron-builder.yml:99`, `electron-builder.x64.yml:70`, `electron-builder.linux.yml:59`, `electron-builder.win.yml:49` (`publish.owner`), `src/main/packaging-config.test.ts:240`, `AGENTS.md` (Repository Identity: the publishing repo)

## Tasks

### Task 1.1: Define the shared key list
- Goal: one source of truth that the renderer helper and Phase 2's Rust bootstrap both use.
- Target: `src/shared/renderer-storage.ts`.
- Steps:
  1. Export `RENDERER_STORAGE_KEYS = ["omp.lang", "omp.themeScheme", "omp.update.dismissed", "omp.dock.focusHeight", "omp.palette.recent"] as const`.
  2. Export `type RendererStorageKey = (typeof RENDERER_STORAGE_KEYS)[number]`.
  3. Export `function rendererStoragePrefKey(key: RendererStorageKey): string { return \`rendererStorage.${key}\`; }`.
  4. Add a file comment saying the Tauri bootstrap seeds localStorage from these prefs paths, so the list must stay in sync with `src-tauri/src/prefs.rs`.
- Success criteria: the file type-checks and exports the three symbols.
- Verify: no verification needed (covered by Task 1.4).

### Task 1.2: Write the write-through helper
- Goal: `writePersisted(key, value)` writes localStorage and mirrors the value into prefs. `mirrorAllToPrefs()` copies all five current values once.
- Target: `src/renderer/lib/persisted-storage.ts`.
- Steps:
  1. `export function writePersisted(key: RendererStorageKey, value: string): void`. In a `try`, call `localStorage.setItem(key, value)` (ignore errors as the current call sites do). Then, if `globalThis.window?.omp?.prefs` exists, call `void window.omp.prefs.set(rendererStoragePrefKey(key), value).catch(() => {})`.
  2. `export function mirrorAllToPrefs(): void`. For each key in `RENDERER_STORAGE_KEYS`, read `localStorage.getItem(key)`. When it is not `null`, call the prefs mirror only (not `setItem`).
  3. Store values as strings, exactly as localStorage holds them (the JSON-encoded values in updater.ts and CommandPalette.tsx stay JSON strings).
- Success criteria: neither function throws when `window.omp` is undefined or localStorage throws.
- Verify: no verification needed (covered by Task 1.4).

### Task 1.3: Route the five write sites through the helper
- Goal: every write of the five keys mirrors into prefs.
- Target: the five write sites in the table above, plus `src/renderer/main.tsx`.
- Steps:
  1. At each write site, replace `localStorage.setItem(<key>, <value>)` with `writePersisted(<key>, <value>)`. Keep the surrounding `try`/`catch` and comments. Leave the read sites unchanged.
  2. In `src/renderer/main.tsx`, call `mirrorAllToPrefs()` once before the React root renders, so values set before this release are mirrored too.
- Success criteria: `grep -rn "localStorage.setItem" src/renderer --include=*.ts --include=*.tsx | grep -v test` shows only `src/renderer/lib/persisted-storage.ts`.
- Verify: `grep -rln "localStorage.setItem" src/renderer --include=*.ts --include=*.tsx | grep -v '\.test\.'` prints exactly `src/renderer/lib/persisted-storage.ts`.

### Task 1.4: Test the helper
- Goal: lock the prefs path contract with a test.
- Target: `src/renderer/lib/persisted-storage.test.ts`.
- Steps: follow the global-mock pattern in `src/renderer/stores/input-history.test.ts` (`installPrefs()` with `vi.fn()`). Write these cases:
  1. `writes localStorage and mirrors to the nested prefs path`: `writePersisted("omp.lang", "vi")` calls `prefs.set("rendererStorage.omp.lang", "vi")`, and `localStorage.getItem("omp.lang")` is `"vi"`.
  2. `skips the mirror when window.omp is missing`: no throw, localStorage still written.
  3. `mirrorAllToPrefs copies only present keys`: with two keys set, `prefs.set` is called exactly twice.
  4. `swallows a rejected prefs write`: `prefs.set` rejects; no unhandled rejection.
- Success criteria: the four tests pass.
- Verify: `bunx vitest run src/renderer/lib/persisted-storage.test.ts` exits 0 and the output contains `4 passed`.

### Task 1.5: Repoint the update feed at the publishing repo
- Goal: installed builds stop offering omp 0.9.14 and update from `tung491/oh-my-pi-gui`.
- Steps:
  1. Set `RELEASE_DOWNLOAD_BASE` in `src/main/updater.ts:55` to `https://github.com/tung491/oh-my-pi-gui/releases/download/`.
  2. Set `publish.owner: tung491` in the four electron-builder configs. Leave `maintainer` and `homepage` unchanged; they are separate decisions (see `plan.md` → Unresolved questions).
  3. Update the publish assertion in `src/main/packaging-config.test.ts:240` to `owner: "tung491"`.
  4. In `AGENTS.md` → Repository Identity, record that releases publish from `tung491/oh-my-pi-gui`, and that `nornzach/oh-my-pi-gui` is the upstream GUI repo this fork tracks. Read the section first, and change only those lines.
- Verify: `grep -rn "nornzach/oh-my-pi-gui/releases" src/main/updater.ts` prints nothing, `grep -c "owner: tung491" electron-builder*.yml` prints `1` for each of the four files, and `bunx vitest run src/main/packaging-config.test.ts` exits 0.

### Task 1.6: Full regression and changelog
- Goal: nothing else broke.
- Steps:
  1. Add under the CHANGELOG Unreleased section: `- Settings that lived only in the window (language, theme, dock height, palette history, dismissed update) are now also saved to the profile.`
  2. Run the gates below.
- Success criteria: all four commands pass.
- Verify: `bunx vitest run` exits 0, `bun run check:types` exits 0, `bunx biome check src/shared/renderer-storage.ts src/renderer/lib/persisted-storage.ts src/renderer/lib/persisted-storage.test.ts src/renderer/lib/i18n.tsx src/renderer/lib/themes.ts src/renderer/stores/updater.ts src/renderer/components/chat/dock/WorkspaceDock.tsx src/renderer/components/dialogs/CommandPalette.tsx src/renderer/main.tsx` exits 0, and `bun run build` exits 0.

### Task 1.7: Build and hand out the mirror release
- Goal: every installed user runs a build that mirrors storage and polls the right feed, before the Linux cutover.
- Steps (each publishing step waits for the user's go-ahead):
  1. Pick a version above every hand-shared build in use (ask the user for the highest one).
  2. Follow AGENTS.md → Release flow for the Electron packages. Publish the GitHub Release on `tung491/oh-my-pi-gui` with its `latest-*.yml` feeds after approval (`gh release create -R tung491/oh-my-pi-gui`).
  3. Hand the packages to the installed users through the same channel as before. Builds older than this one poll the wrong feed and will never see it on their own.
  4. Record the release date in `plan.md` → Validation Log. Phase 11 waits at least 7 days after it.
- Verify: `curl -sL https://github.com/tung491/oh-my-pi-gui/releases/latest/download/latest-linux.yml | grep -c "version: <the version>"` prints `1`.

## Commit

Two conventional commits in the GUI repo: `feat(gui): mirror window-only settings into the profile` and `build(gui): publish updates from the fork's releases`. Do not mention Tauri, plans or phases in the messages.

## Risk

Low. Prefs writes are fire-and-forget, so a failure loses only the mirror, never the setting.

## Rollback

Revert the commit. The extra `rendererStorage` subtree in `prefs.json` is harmless if left behind.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
