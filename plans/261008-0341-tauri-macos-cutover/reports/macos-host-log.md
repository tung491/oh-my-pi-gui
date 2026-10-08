# macOS host log

## Baseline

```
$ ls /Applications | grep -iE "sai atlas|omp" ; echo "exit=$?"
exit=1
$ test -e "$HOME/Library/Application Support/@oh-my-pi/omp-gui"; echo "profile=$?"
profile=1
$ ls -d ~/Library/{WebKit,Caches,HTTPStorages}/vn.io.vif.saiatlas "~/Library/Saved Application State/vn.io.vif.saiatlas.savedState"
ls: /Users/tung491/Library/Caches/vn.io.vif.saiatlas: No such file or directory
ls: /Users/tung491/Library/HTTPStorages/vn.io.vif.saiatlas: No such file or directory
ls: /Users/tung491/Library/Saved Application State/vn.io.vif.saiatlas.savedState: No such file or directory
ls: /Users/tung491/Library/WebKit/vn.io.vif.saiatlas: No such file or directory
$ git rev-parse HEAD
83d393c3c48e06a381c59286f50f1f54933f403d
```

## Toolchain

```
$ bun --version
1.3.14
```
bun: upgraded 1.3.14 → 1.4.2 (user approved; `bun upgrade` takes no version, so the bun-v1.4.2 darwin-aarch64 release binary replaced ~/.bun/bin/bun)
$ bun --version
1.4.2
rust: `rustup update stable` 1.85.1 → 1.99.0 (tauri-cli 2.12.1 needs rustc ≥ 1.90; cargo-public-api 0.52.0 needs ≥ 1.88)
$ cargo tauri --version
tauri-cli 2.12.1
$ cargo public-api --version
cargo-public-api 0.52.0
$ rustup run nightly-2026-10-01 rustc --version
rustc 1.101.0-nightly (21b707e3f 2026-09-30)
```

## Monorepo

- `~/WORK/oh-my-pi` at 97990a6c89cf7dea50b62d8450c1705aa41ff9bb (nornzach/oh-my-pi main); nested GUI at 83d393c.
- First `bun run build:omp` at fork main (97990a6c, omp 18.8.0) failed in `check:protocol`: the fork merged upstream 18.6.2 on 10-06 (`RpcLiveState`/`RpcLiveUpdateFrame` replaced, `logout` needs `credentialId`) and 18.8.0 on 10-08 (`gen:native` removed). The `sessionStorage`/`zlib.zstdCompress` errors came from nesting this GUI: its webdriver deps hoisted `@types/node` 20 to the monorepo root. Fixed by pinning `@types/node` 22.20.5 in the GUI (commit c892dbd).
- At a859518ce1 (omp 18.4.12) patch 0002 no longer applies (the 10-03 upstream merge re-indented `task/executor.ts`).
- **Pinned monorepo: `a73a582803d6d6c7f9f360bcdb5312087c5ca333` (omp 18.4.8)**, the fork base the Linux host's local main sits on (0001's `From 411f2721` is the host's local commit on it). All five `patches/omp` apply there unchanged. Release notes must record this commit. Not carried: the host-only `set_setting` unset fix (`f674c994`/`8f713fb619`), which is in no patch.

```
$ bun run build:omp
[build:omp] applied agent patch 0001-ollama-native-api-num-ctx.patch
[build:omp] applied agent patch 0002-no-context-files-flag.patch
[build:omp] applied agent patch 0003-model-policy-local-only.patch
[build:omp] applied agent patch 0004-mcp-enabled-setting.patch
[build:omp] applied agent patch 0005-ollama-per-model-context-limits.patch
$ file resources/omp
resources/omp: Mach-O 64-bit executable arm64
$ resources/omp --version
omp/18.4.8
$ git -C ~/WORK/oh-my-pi status --short --untracked-files=no | wc -l   # after `git checkout -- bun.lock`
0
```
`?? packages/gui/` is the intentionally untracked nested checkout, so the clean-tree check reads tracked files only.

## Pack check (Task 1.5)

`bun scripts/check-assistant-pack.ts resources/omp resources/assistant-pack` passes every row (model policy, switch refusals, MCP off, no context files, overlay settings) except one:
```
PACK LOAD CHECK: FAIL
  - tools differ from --tools: missing [], extra [diagnose, open_item, os_setting, system_status]
```
The pack registers the four SAI OS tools on every platform (`assistant-pack/src/tools/index.ts:8`), and the 18.4.8 sidecar activates extension tools absent from `--tools`, which leaves them out off Linux. omp 18.4.8 always adds extension-registered tools to an agent session (`sdk.ts:3928-3945`; only chat sessions restrict the list), so the pack now registers the SAI OS tools on Linux only (`assistant-pack/src/tools/index.ts`). Before the fix a Mac session could call them, but each refused in its `guard` before running anything. `os-commands.test.ts` also failed on macOS before the fix (temp dir behind `/var` → `/private/var`); its temp dirs are now canonical.

```
$ bun run build:pack && bun scripts/check-assistant-pack.ts resources/omp resources/assistant-pack
PACK LOAD CHECK: PASS
```

## Signing spike (Task 1.7)

- Hardened ad-hoc sidecar with `omp.entitlements` only (allow-jit, allow-unsigned-executable-memory; `flags=0x10002(adhoc,runtime)`): the sidecar exits before ready with `Cannot find module '/$bunfs/native/pi_natives.darwin-arm64.node'` (the addon it extracts to `~/.omp/natives/18.4.8/` is refused). The log names no cause.
- Same plus `com.apple.security.cs.disable-library-validation` (scratch copy): the output matches the unsigned binary, with only the tools difference above left. Library validation is what blocks the addon.
- After the pack fix: `omp.entitlements` only → check exit 1 (addon refused); plus `disable-library-validation` → `PACK LOAD CHECK: PASS`.

entitlements: add disable-library-validation

## Dev-port guard (Task 1.8b)

The plan's `python3 -m http.server` fixture never reached LISTEN on this host (inside the tool sandbox the socket stayed CLOSED; outside it, 10 s of `lsof` polling saw nothing), so a Bun listener on 127.0.0.1:5183 replaced it:

```
$ bun run dev:tauri -- --user-data-dir=$(mktemp -d)
Dev port 5183 is already in use. Stop its owner instead of picking another port:
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
bun     34845 tung491    4u  IPv4 0x3299396ea1350dad      0t0  TCP 127.0.0.1:5183 (LISTEN)
error: script "dev:tauri" exited with code 1
```

## First macOS clippy (Task 1.6)

```
error: unused imports: `linux_package_kind` and `package_type_at`   (src/updater/mod.rs:51)
error[E0308]: mismatched types — set_style_mask expects NSWindowStyleMask, found i32   (src/desktop/windows.rs:1032, tauri-nspanel 2.1.0)
error[E0599]: no associated constant `SOCK_CLOEXEC` for `SockFlag`   (src/omp/manager.rs:316)
```

## cargo test on macOS (Task 1.8)

First run: 758 passed, 20 failed. One (`refuses_to_resume_a_chat_stamped_session_without_spawning`) needed the built pack (`bun run build:pack`). The manager and shell_env failures had one cause: the manager re-executes the test binary into `omp::supervisor::tests::supervisor_role_helper`, which lived in a Linux-only module, so on macOS the re-exec ran 0 tests, exited 0 and read as "Normal shutdown". After the fix: `test result: ok. 764 passed; 0 failed` (run outside the tool sandbox, which blocks `listen()`).

deviation: supervisor_role_helper moved to cfg(all(test, unix)) mod test_role so the manager's supervised spawns run in macOS test binaries; mod tests untouched
gated: omp::manager::tests::passes_the_active_session_path_on_a_manual_restart — reads /proc/<pid>/cmdline; un-gate in Phase 4 Task 4.2b
gated: omp::manager::tests::spawns_every_sidecar_with_the_assistant_pack_flags_and_never_chat — reads /proc/<pid>/cmdline and environ; un-gate in Phase 4 Task 4.2b
gated: omp::manager::tests::forces_a_freshly_created_tab_to_bypass_the_cli_auto_resume_setting — reads /proc/<pid>/cmdline; un-gate in Phase 4 Task 4.2b
gated: omp::manager::tests::appends_the_workspace_launch_profile_flags_at_spawn_denylist_proof — reads /proc/<pid>/cmdline; un-gate in Phase 4 Task 4.2b
gated: omp::manager::tests::passes_the_context_limits_overlay_after_the_pack_config_and_creates_a_missing_file — reads /proc/<pid>/cmdline; un-gate in Phase 4 Task 4.2b
gated: omp::manager::tests::adoptcwd_re_roots_the_reported_cwd_and_plain_restarts_spawn_there — reads /proc/<pid>/cwd and cmdline; un-gate in Phase 4 Task 4.2b
gated: omp::manager::tests::dispose_stops_the_supervisor_and_the_fixture — reads /proc/<pid>/stat; un-gate in Phase 4 Task 4.2b
gated: omp::shell_env::tests::injects_the_shellenv_overlay_into_the_spawned_process — reads /proc/<pid>/environ; un-gate in Phase 4 Task 4.2b
gated: updater::tests::check_reports_an_available_update_with_its_notes — deb feed with install_mode Automatic; macOS asset_target is compile-time MacArm64 (updater/mod.rs:325); Linux CI is the authority; macOS twin in Phase 7 Task 7.2b
gated: updater::tests::check_now_runs_a_manual_check_from_the_menu — deb feed with install_mode Automatic; Linux CI is the authority; macOS twin in Phase 7 Task 7.2b
gated: updater::tests::download_verifies_the_package_and_reports_progress — deb feed with install_mode Automatic; Linux CI is the authority
gated: updater::tests::download_resumes_a_partial_when_the_server_continues_it — deb feed with install_mode Automatic; Linux CI is the authority
gated: updater::tests::download_restarts_when_the_server_answers_a_different_range — deb feed with install_mode Automatic; Linux CI is the authority
gated: updater::tests::download_removes_the_partial_on_a_hash_mismatch — deb feed with install_mode Automatic; Linux CI is the authority
gated: updater::tests::download_drops_a_partial_the_release_can_never_complete — deb feed with install_mode Automatic; Linux CI is the authority

## Vitest on macOS (Task 1.9 gate item 5)

First run: 5 tests and 21 files failed. After the fixes: `Tests 2374 passed | 9 skipped (2383)`, `Test Files 225 passed | 1 skipped`.

fixed: vitest.config.ts excludes .claude/** and .agentkit/** — gitignored tool checkouts; absent on CI
fixed: assistant-pack.test.ts canonicalises the chdir cwd (macOS /var symlink)
gated: scripts/finalize-deb.test.ts > finalizeDeb control checks > ships the alternation, the four Recommends and no Pre-Depends — builds and reads a .deb with dpkg-deb (finalize-deb.ts:79)
gated: scripts/finalize-deb.test.ts > finalizeDeb control checks > refuses a package whose configured depends grew a soft dependency — builds and reads a .deb with dpkg-deb (finalize-deb.ts:79)
gated: scripts/finalize-deb.test.ts > finalizeDeb control checks > leaves the bundler's package untouched when the finished one would carry a maintainer script — builds and reads a .deb with dpkg-deb (finalize-deb.ts:79)
gated: scripts/tauri-packaging-config.test.ts > Linux package > deb ships the /opt compat symlink and one desktop entry named after the app id — builds and reads a .deb with dpkg-deb

## Phase 1 checkpoint

Counsel verdict: GO. Notes for later phases:
- The bundled sidecar extracts its native addon to `~/.omp/natives/<omp version>/` whatever `PI_CODING_AGENT_DIR` says. It is a cache, but it is user-home state every packaged run touches; Phase 6 Task 6.4 should list it.
- Until Phase 5 Task 5.3 registers `tauri_nspanel::init()`, opening the quick-entry bar on a macOS build panics (`to_panel` reads unmanaged state). Nothing before Phase 5 may open the bar.
- Phases 2/7 and 4/5 run as two lanes (plan.md, Phases).

## Phase 2

Lane A, main worktree. Sidecar: the existing `resources/omp` (omp 18.4.8, arm64), not rebuilt.

red: `resolves_the_pack_in_the_app_bundle_resources` failed on its first assertion (left `…/Sai ATLAS.app/Contents/MacOS/assistant-pack`, right `…/Contents/Resources/assistant-pack`); green: `omp::assistant_pack` 11 passed.
red: `scripts/tauri-packaging-config.test.ts` 6 failed (the renamed externalBin test, the two `["app"]` assertions, the package-script test, the arm64-only script test, the entitlement dict test), 35 passed; green: 41 passed, 1 skipped.
red: `scripts/finalize-app.test.ts` failed with `Cannot find module '../src-tauri/macos/finalize-app'`; green: 2 passed.
deviation: the Task 2.4 step 6 grep also lists `scripts/build-bundled-omp.ts:34,74` (a usage comment naming `build:omp:x64`) and `src-tauri/src/paths.rs:210,385` (`sidecar_out_name("darwin","x64")`); neither file is in this phase's ownership, so both are left for their owners (paths.rs: lane B / Phase 5; the build script comment: Phase 7 docs pass).
deviation: `finalize-app.ts` resolves the repo root with `node:url` `fileURLToPath(import.meta.url)` (as `scripts/stage-tauri-sidecar.ts` does), because vitest runs under Node, where Bun's `import.meta.dir` is undefined.
note: biome's `files.includes` and tsconfig's `include` both leave out `src-tauri/**`, so gate 7 and `check:types` do not cover `src-tauri/macos/finalize-app.ts`, as for the Linux finalize scripts. Extra checks run: biome over stdin as `scripts/finalize-app.ts` (no changes) and a strict ad-hoc `tsc --types bun` (exit 0).
note: `hdiutil create` prints `WARNING: 'hdiutil create -volname -format ...' is deprecated` on this host (Darwin 27.0.0); the DMG is still made.

### First bundle

`bun run package:tauri:mac:arm64` → exit 0; one `.app` in `bundle/macos/`, one `Sai ATLAS_0.9.16_aarch64.dmg` in `bundle/dmg/`.

```
## 2.7 verify
       1
       1
Sai ATLAS_0.9.16_aarch64.dmg
## 2.8 step 1
src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/MacOS/omp
src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack/config.yml
## 2.8 step 2 (omp)
{
  "com.apple.security.cs.allow-jit" => true
  "com.apple.security.cs.allow-unsigned-executable-memory" => true
  "com.apple.security.cs.disable-library-validation" => true
}
## 2.8 step 2 (app)
{
  "com.apple.security.device.audio-input" => true
}
## 2.8 step 3
Identifier=vn.io.vif.saiatlas
CodeDirectory v=20500 size=53043 flags=0x10002(adhoc,runtime) hashes=1647+7 location=embedded
TeamIdentifier=not set
## omp flags
Identifier=omp-555549444c4c447c55553144a138dbd9c49417a3
CodeDirectory v=20500 size=452205 flags=0x10002(adhoc,runtime) hashes=14120+7 location=embedded
TeamIdentifier=not set
## 2.8 step 4
[{"CFBundleTypeRole":"Editor","CFBundleURLName":"vn.io.vif.saiatlas omp","CFBundleURLSchemes":["omp"]}]
## verify counts
audio-input in omp: 0
identifier: 1
omp scheme: 1
## strict verify
verify=0
## 2.8 step 5 (tail)
dotenv  127.0.0.1.attacker.example never contacted
mcp     user and project MCP servers never started
PACK LOAD CHECK: PASS
pack-check=0
```

### First launch

```
P=/var/folders/sl/5by2qx2j7cq78wr6yyj1pvsc0000gq/T/tmp.oX5NoRY0Hm
GUI=38088
loop broke=yes after 2s
## process tree
38167 38088 /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/MacOS/sai-atlas --omp-supervise /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/MacOS/omp --mode rpc-ui --no-extensions --no-rules --no-context-files --extension /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack --tools read,glob,write,ask,office_report,office_slides,office_clean --system-prompt /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack/system-prompt.md --append-system-prompt /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack/append-system-prompt.md --config /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack/config.yml --approval-mode always-ask --config /var/folders/sl/5by2qx2j7cq78wr6yyj1pvsc0000gq/T/tmp.oX5NoRY0Hm/profile/ollama-context-limits.yml
38168 38167 /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/MacOS/omp --mode rpc-ui --no-extensions --no-rules --no-context-files --extension /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack --tools read,glob,write,ask,office_report,office_slides,office_clean --system-prompt /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack/system-prompt.md --append-system-prompt /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack/append-system-prompt.md --config /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app/Contents/Resources/assistant-pack/config.yml --approval-mode always-ask --config /var/folders/sl/5by2qx2j7cq78wr6yyj1pvsc0000gq/T/tmp.oX5NoRY0Hm/profile/ollama-context-limits.yml
## runtime log hits
0
## after TERM
none
```

GUI pid 38088 (launched by its relative path, so the path filter above does not list it); supervisor 38167 has ppid 38088, omp 38168 has ppid 38167. `gui-runtime.jsonl` holds 9 lines, none naming `assistant-pack` or `sidecar-restart`. It does show `quick entry registered` (`Control+Shift+Space`) at startup; the chord was not pressed. `pgrep -fl` for the worktree's bundle path printed nothing afterwards.
- `hdiutil create` prints a deprecation warning on Darwin 27; Apple's replacement is `diskutil image create from --format UDZO --volumeName "Sai ATLAS" <stage> <dmg>`, which exists only on macOS 26+, so `hdiutil` stays until it errors.

## Phase 3

Main worktree, the Phase 2 bundle unchanged (not rebuilt). Harness committed as 5cb1b21.

red: `bunx vitest run scripts/tauri-mac-smoke.test.ts` exit 1 (`Failed to load url ./tauri-mac-smoke`); green: 10 passed. `bunx biome check` on both files exit 0 (one formatter-only line wrap applied first). Extra: a strict ad-hoc `tsc --types bun,node` exit 0, since `scripts/` is in no tsconfig.
deviation: besides the four required helpers, `sameKeys`, `codesignDetails` and `infoPlistProblems` are exported and unit-tested, so every parse the cases rely on is pure. `ps` runs as `ps -axww -o pid=,ppid=,command=` so long command lines are not cut. The harness refuses an app path under `/Applications` (exit 2).

```
$ bun scripts/tauri-mac-smoke.ts "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app" 2>&1 | tee "$TMPDIR/smoke-1.txt"
PASS bundle layout
PASS app signature
PASS app entitlements
PASS sidecar entitlements
PASS info plist
PASS pack check
PASS boots a supervised sidecar
PASS single instance per profile
PASS hard kill leaves nothing
tauri-mac-smoke: PASS
$ grep -E "^FAIL " "$TMPDIR/smoke-1.txt" | grep -v "hard kill leaves nothing" | wc -l
       0
$ pgrep -f "Sai ATLAS.app/Contents/MacOS" || echo none
none
```

The run took 29 s (15:46:16 to 15:46:45 KST). No cargo or rustc ran during it: the `pgrep -fl "rustc|cargo"` hits were two `npm exec chrome-devtools-mcp` processes whose PATH names cargo. A second run (`smoke-2.txt`) printed the same nine PASS lines and `tauri-mac-smoke: PASS`.

hard kill: PASS-before-Phase-4. The supervisor sees its control channel close when the GUI dies (that path is not Linux-gated) and ends omp. This does not prove the escaped-tool case (a tool process that left omp's process group); that needs Phase 4's kqueue parent watch and descendant snapshot.

Phase end: `pgrep -fl "omp --mode rpc-ui"` and `pgrep -fl -- "--omp-supervise"`, filtered by this worktree's `src-tauri` path, print nothing. No `tauri-mac-smoke-*` temp root is left. `test -e "$HOME/Library/Application Support/@oh-my-pi/omp-gui"; echo $?` prints 1. Full `bunx vitest run`: 227 files passed, 1 skipped; 2388 tests passed, 9 skipped.

## Phase 7 Task 7.2b (main worktree)

`cargo test … check_reports_an_available_manual_update_for_this_mac` → `test updater::tests::check_reports_an_available_manual_update_for_this_mac ... ok` (commit 76dbb7d). It sits behind `cfg(all(target_os = "macos", target_arch = "aarch64"))`, because the asset target is the compile-time arm64 Mac target.
