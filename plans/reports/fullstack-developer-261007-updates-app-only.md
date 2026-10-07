# Updates page checks only the app's own release feed

Branch `rebrand/updates-app-only` in `/home/tung491/WORK/worktrees/rebrand-updates`, commit `fdea644` (parent `9d95b1e`). Not merged, tagged or pushed.

## Changes

- `src/renderer/components/settings/UpdatesSettingsPage.tsx`: "Check for updates" now calls only `window.omp.updater.check()`. A rejected check is shown as an updater error, as it was before. The "OMP Core" row (current/latest version and "Included with the next GUI update") is removed. No local source of the agent's version exists anywhere in the GUI, so the row was dropped rather than kept. `updateOverviewState` is now `(status, checking)`.
- `src/shared/rpc-client.ts` and `src/shared/ipc-types.ts`: removed `getOmpUpdate`.
- `src/shared/rpc-types.ts`: removed the `get_omp_update` command variant and `RpcOmpUpdateResult`.
- `scripts/protocol/contract.ts`: removed the `RpcOmpUpdateResult` wire assertion. The GUI command union stays a subset of core's, so `Commands` still holds.
- `src/renderer/locales/en.ts` and `vi.ts`: removed `updates.core.name`, `updates.core.description`, `updates.core.checkFailed` and `updates.coreBundledPending` from both files, which stay key-identical.
- `UpdatesSettingsPage.test.ts` became `.test.tsx`. It now has a mounted-page test using the linkedom harness, and the overview-state tests are rewritten.

Nothing in `src/main`, the preload/bridge, `src-tauri/src` or `src-tauri/contracts` referenced the command, so no Rust code, snapshot or parity change was needed.

Typed path: no slash command reaches omp's npm check. `/changelog` reads the local CHANGELOG, the `update` subcommands of `/marketplace` and `/skills` concern catalogs, and `omp update` is a CLI subcommand. The startup `checkForNewVersion` in the agent's `main.ts` runs only in interactive mode, never in `rpc`/`rpc-ui`. So `REMOVED_COMMANDS` is unchanged. No e2e spec drove the removed row (the update e2e tests call `window.omp.updater.check()` directly).

## Red/green

- Red, before the page change: `checks only the app's own release feed, never the agent's package registry` failed with `expected [ 'getOmpUpdate' ] to deeply equal []`. The sidecar status was `ready`, and every `window.omp.rpc` method was recorded through a Proxy.
- Green, after the change: 7/7 in the file.

## Gates (all exit 0 in the worktree)

| Gate | Result |
|---|---|
| bun install / build:pack | pass |
| check:types | pass |
| bunx vitest run | 2109 passed, 5 skipped |
| bun run build | pass |
| biome check (8 touched files) | clean |
| check-assistant-pack | PACK LOAD CHECK: PASS |
| build:renderer:tauri | pass |
| cargo clippy -D warnings | pass |
| cargo test | 772 passed, 0 failed |
| parity loop | omp, services, tabs, updater mirrored |
| check-module.sh snapshots | PASS |
| check-twins | every twin matches |
| `rg 'get_omp_update\|getOmpUpdate' src src-tauri/src` | no output |

Side effects: the `resources/omp` and `resources/omp.linux-x64` symlinks were added (gitignored), as instructed. No processes are left running, and the scratch files are removed.

## Unresolved questions

1. Some copy still names the agent: `updates.subtitle` ("Keep the desktop application and its bundled OMP Core aligned."), `updates.systemHealthy` ("OMP system is up to date"), `updates.systemChecking` ("Checking OMP system versions") and `updates.deliveryNote`. They are still used and still accurate, so they were left alone. Should the rebrand copy pass reword them around Sai ATLAS?
2. `bun run check:protocol` (`scripts/protocol/contract.ts`) cannot run from a worktree outside the monorepo, so it was not run. The edit only removes an assertion line for a deleted type.
