---
phase: 1
title: "Toolchain, sidecar, first macOS compile and signing spike"
status: completed
priority: P1
effort: "1.5d"
dependencies: []
---

# Phase 1: Toolchain, sidecar, first macOS compile and signing spike

## Goal

The Mac can build everything this plan needs: `cargo tauri` 2.12.1, `cargo public-api` 0.52.0 with its nightly, a sidecar `resources/omp` built from the monorepo, the assistant pack, and a clean `clippy` and `cargo test` of `src-tauri/` on `aarch64-apple-darwin`. The phase also measures, before any packaging, which entitlements an ad-hoc, hardened Bun sidecar needs.

## Context

- `scripts/rust-pins.env` pins `CARGO_PUBLIC_API_VERSION="0.52.0"` and `PUBLIC_API_TOOLCHAIN="nightly-2026-10-01"`. The Linux build image pins tauri-cli 2.12.1 (`scripts/tauri-linux-build/Dockerfile:60`).
- No `cfg(target_os = "macos")` code has ever been compiled. The gate-9 cross check in `scripts/check-module.sh:207-224` only ever printed WARN on Linux.
- `tauri-nspanel = "2"` (lock: 2.1.0, `src-tauri/Cargo.lock:4400-4403`) is used at `src-tauri/src/desktop/windows.rs:1027-1035`.
- `scripts/stage-tauri-sidecar.ts:24-28` maps `aarch64-apple-darwin` to `resources/omp`.

## Files

- Create: `plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md`, `plans/261008-0341-tauri-macos-cutover/reports/macos-parity.md`
- Modify (only to fix first-compile errors, Task 1.6/1.7 rules): any file under `src-tauri/src/` that clippy or `cargo test` names
- Create/modify (Task 1.8b): `scripts/tauri-dev.test.ts`, `scripts/tauri-dev.ts`
- Outside the repo: `~/WORK/oh-my-pi` (monorepo clone), `~/.cargo/bin` (tools)

## Tasks

### Task 1.1 — Record the protected baseline
- Goal: a written record that no Sai ATLAS install, profile or bundle-id state exists on this Mac before any run.
- Target files: `plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md` (create).
- Steps:
  1. Run, and paste each command with its output under a `## Baseline` heading:
     `ls /Applications | grep -iE "sai atlas|omp" ; echo "exit=$?"`
     `test -e "$HOME/Library/Application Support/@oh-my-pi/omp-gui"; echo "profile=$?"`
     `ls -d "$HOME/Library/WebKit/vn.io.vif.saiatlas" "$HOME/Library/Caches/vn.io.vif.saiatlas" "$HOME/Library/HTTPStorages/vn.io.vif.saiatlas" "$HOME/Library/Saved Application State/vn.io.vif.saiatlas.savedState" 2>&1`
     `git rev-parse HEAD`
  2. Create `plans/261008-0341-tauri-macos-cutover/reports/macos-parity.md` with the single heading `# macOS parity`.
- Success criteria: the log shows `exit=1`, `profile=1` and four "No such file or directory" lines.
- Verify: `grep -c "profile=1" plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md` prints `1`. If the baseline is not clean (an install or profile exists), STOP and follow the Failure Protocol: the protection rules assume a clean Mac.

### Task 1.1b — Check the Bun version (user decision point)
- Goal: this Mac runs the Bun the repo expects (README requires ≥ 1.4; `scripts/tauri-linux-build/Dockerfile:58` pins 1.4.2), so `bun install`, `bun.lock` and vitest behave as in CI.
- Target files: none in the repo.
- Steps:
  1. `bun --version` and append the output to the host log. On 2026-10-08 it printed `1.3.14`.
  2. If the major.minor is below `1.4`: STOP and ask the user, quoting the command `bun upgrade --version 1.4.2`. Run it only after their go-ahead, then re-run step 1. If they decline, record `bun: kept <version> (user)` in the host log and continue.
- Success criteria: the host log holds a `bun --version` line of 1.4 or later, or the user's recorded decline.
- Verify: `bun --version` prints a version whose major.minor is ≥ `1.4`, or `grep -c "^bun: kept" plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md` prints `1`.

### Task 1.2 — Install tauri-cli 2.12.1
- Goal: `cargo tauri` works with the version the Linux image uses.
- Target files: none in the repo.
- Steps:
  1. `export PATH="$HOME/.cargo/bin:$PATH"`
  2. `cargo install tauri-cli --version 2.12.1 --locked`
  3. Append `cargo tauri --version` and its output to the host log.
- Success criteria: the command exists.
- Verify: `PATH="$HOME/.cargo/bin:$PATH" cargo tauri --version` exits 0 and prints `tauri-cli 2.12.1`.

### Task 1.3 — Install the snapshot tools
- Goal: `bash scripts/check-module.sh snapshots` can run on the Mac.
- Steps:
  1. `"$HOME/.cargo/bin/cargo" install cargo-public-api --version 0.52.0 --locked`
  2. `"$HOME/.cargo/bin/rustup" toolchain install nightly-2026-10-01 --profile minimal`
- Success criteria: both tools exist at the pinned versions.
- Verify: `"$HOME/.cargo/bin/cargo" public-api --version` prints `cargo-public-api 0.52.0`, and `"$HOME/.cargo/bin/rustup" run nightly-2026-10-01 rustc --version` exits 0.

### Task 1.4 — Clone the monorepo, nest the GUI repo, build the sidecar
- Goal: `<worktree>/resources/omp` is an arm64 Mach-O sidecar built from `nornzach/oh-my-pi` with this branch's `patches/omp/*.patch` applied.
- Target files: `~/WORK/oh-my-pi`, `~/WORK/oh-my-pi/packages/gui`, `<worktree>/resources/omp` (gitignored).
- Steps:
  1. `test -e ~/WORK/oh-my-pi || git clone https://github.com/nornzach/oh-my-pi ~/WORK/oh-my-pi`
  2. `test -e ~/WORK/oh-my-pi/packages/gui/.git || git clone https://github.com/tung491/oh-my-pi-gui ~/WORK/oh-my-pi/packages/gui`
  3. Put the nested GUI checkout on this branch's commit (it may not be pushed): `git -C ~/WORK/oh-my-pi/packages/gui fetch /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos tung491/tauri_macos && git -C ~/WORK/oh-my-pi/packages/gui checkout --detach FETCH_HEAD`
  4. `cd ~/WORK/oh-my-pi && bun install`, then `cd ~/WORK/oh-my-pi/packages/gui && bun install && bun run build:omp`
  5. `cp ~/WORK/oh-my-pi/packages/gui/resources/omp /Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos/resources/omp`
  6. Append to the host log: `git -C ~/WORK/oh-my-pi rev-parse HEAD` (the monorepo commit; release notes need it) and `file resources/omp`.
- Success criteria: the sidecar exists, runs and is arm64. `git -C ~/WORK/oh-my-pi status --short` is empty after the build: `build:omp` reverts its patches.
- Verify: `file resources/omp` prints a line containing `Mach-O 64-bit executable arm64`, `resources/omp --version` exits 0, and `git -C ~/WORK/oh-my-pi status --short | wc -l` prints `0`.

### Task 1.5 — Build the assistant pack and prove the sidecar loads it
- Goal: `resources/assistant-pack/` exists, and the sidecar loads exactly the pack. This is the AGENTS.md patch check: `modelPolicy`, `mcp.enabled` and `--no-context-files` are honored.
- Steps:
  1. `bun run build:pack`
  2. `bun scripts/check-assistant-pack.ts resources/omp resources/assistant-pack`
- Success criteria: every row of the check passes.
- Verify: the check exits 0. `ls resources/assistant-pack/skills/word-report/SKILL.md` exits 0.

### Task 1.6 — First macOS compile: clippy clean
- Goal: `cargo clippy --all-targets --all-features -- -D warnings` exits 0 on `aarch64-apple-darwin`.
- Target files: whichever `src-tauri/src/**` files clippy names. The likeliest are `src-tauri/src/desktop/windows.rs:1027-1035` (nspanel), `src-tauri/src/lib.rs`, `src-tauri/src/desktop/mod.rs`, `src-tauri/src/updater/mod.rs:603-612` and `src-tauri/src/omp/supervisor.rs:293-331`.
- Steps:
  1. `bun run build:renderer:tauri` (`tauri::generate_context!` needs `out/renderer-tauri/index.html`).
  2. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings 2>&1 | tee "$TMPDIR/clippy-mac.txt"`. Copy the list of distinct `error:` headlines into the host log.
  3. Fix rule for each error:
     - A macOS-only item that is unused, or only used by tests: gate it to its real OS set (`#[cfg(any(target_os = "linux", test))]` and the like), mirroring the existing `#[cfg_attr(not(test), allow(dead_code))]` pattern at `src-tauri/src/desktop/quick_entry_core.rs:132`.
     - An API mismatch inside a `cfg(target_os = "macos")` block: fix the call to the crate's actual signature. Read the signature in `~/.cargo/registry/src/*/<crate>-<version>/src`.
     - `tauri-nspanel` itself fails to compile (the error is inside the crate, not in our code): STOP and record `tauri-nspanel 2.1.0: does not build` in the host log. Then apply the parent fallback: remove the `[target.'cfg(target_os = "macos")'.dependencies] tauri-nspanel` entry from `src-tauri/Cargo.toml`, replace the `#[cfg(target_os = "macos")]` block at `windows.rs:1027-1035` with `let _ = window.set_always_on_top(true); let _ = window.set_visible_on_all_workspaces(true);`, run `cargo check --manifest-path src-tauri/Cargo.toml` so Cargo drops it from `Cargo.lock` (do not use `cargo update -p tauri-nspanel`: Cargo rejects a package spec that is no longer in the graph), confirm `grep -c 'name = "tauri-nspanel"' src-tauri/Cargo.lock` prints `0`, and record `quick-entry: always-on-top fallback` in the host log.
     - Anything else, or a fix that would change Linux behavior: Failure Protocol.
  4. Re-run step 2 until it exits 0.
- Success criteria: clippy is clean on the Mac, and the Linux-only code paths are unchanged (`git diff --stat` touches only cfg attributes and macOS blocks).
- Verify: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` exits 0.

### Task 1.7 — Signing spike: what the hardened ad-hoc sidecar needs
- Goal: a recorded, evidence-based answer to "does `omp` signed with `src-tauri/macos/omp.entitlements` under hardened runtime load its native addon and run the pack?"
- Target files: none in the repo. Work on a copy in `$S=$(mktemp -d)`.
- Steps:
  1. `S=$(mktemp -d); cp resources/omp "$S/omp"`
  2. `codesign --force --sign - --options runtime --entitlements src-tauri/macos/omp.entitlements "$S/omp"`
  3. `codesign -d --entitlements - --xml "$S/omp" 2>/dev/null | plutil -p -` and paste the output to the host log.
  4. `bun scripts/check-assistant-pack.ts "$S/omp" resources/assistant-pack; echo "spike=$?"`
  5. If step 4 printed `spike=0`, record `entitlements: omp.entitlements unchanged` in the host log. If it failed, and its output or `log show --last 2m --predicate 'process == "omp"' | grep -i "library validation\|code signature"` mentions library validation, repeat steps 2–4 with a scratch copy of the entitlements that adds `com.apple.security.cs.disable-library-validation`. If that passes, record `entitlements: add disable-library-validation`. Task 2.3 then adds the key to `src-tauri/macos/omp.entitlements`. Any other failure: Failure Protocol.
- Success criteria: the host log holds exactly one `entitlements:` decision line, backed by a passing pack check.
- Verify: `grep -cE "^entitlements: (omp.entitlements unchanged|add disable-library-validation)$" plans/261008-0341-tauri-macos-cutover/reports/macos-host-log.md` prints `1`.

### Task 1.8 — cargo test on macOS
- Goal: `cargo test --all-features` exits 0 on the Mac.
- Target files: whichever test modules fail.
- Steps:
  1. `cargo test --manifest-path src-tauri/Cargo.toml --all-features 2>&1 | tee "$TMPDIR/test-mac.txt"`. Copy the `failures:` list into the host log.
  2. Fix rule for each failing test:
     - The test asserts a fact that is Linux-only by design (a `/proc` path, `/usr/bin/...`, D-Bus, `.deb` or AppImage, WebKitGTK): add `#[cfg(target_os = "linux")]` to that one test, and write the reason in the host log as `gated: <test path> — <reason>`. Never delete a test, never weaken an assertion.
     - The test shows a real macOS behavior bug in code this plan does not otherwise own: Failure Protocol.
     - Tests in `src-tauri/src/omp/supervisor.rs` are already `cfg(all(test, target_os = "linux"))` and run on macOS from Phase 4 onward. Do not touch them here.
  3. Re-run step 1 until it exits 0.
- Success criteria: green, with every gate listed in the host log.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --all-features` exits 0, and its output contains `test result: ok` with no `FAILED`.

### Task 1.8b — Red/green: the dev-port guard works on macOS
- Goal: `bun run dev:tauri` refuses to start when the worktree's dev port is taken, on macOS as on Linux. Today `scripts/tauri-dev.ts:86` runs `ss`, which macOS lacks, so `owner.status` is non-zero and the guard silently never fires (`.claude/rules/process-management.md`: stop the stale owner, never pick another port).
- Target files: `scripts/tauri-dev.ts` (new exported `portOwnerProbe`, call site at :86), `scripts/tauri-dev.test.ts` (create).
- Steps:
  1. Red. Create `scripts/tauri-dev.test.ts` importing `portOwnerProbe` from `./tauri-dev`. Tests:
     - `uses ss on linux`: `portOwnerProbe("linux", 5180)` equals `{ command: "ss", args: ["-ltnp", "sport = :5180"], headerLines: 1 }`.
     - `uses lsof on macOS`: `portOwnerProbe("darwin", 5180)` equals `{ command: "lsof", args: ["-nP", "-iTCP:5180", "-sTCP:LISTEN"], headerLines: 1 }`.
     - Verify (red): `bunx vitest run scripts/tauri-dev.test.ts` exits non-zero (missing export). Passing is a failure of this step.
  2. Green. Export `portOwnerProbe(platform: NodeJS.Platform, port: number): { command: string; args: string[]; headerLines: number }` returning the two shapes above. At :86 call `const probe = portOwnerProbe(process.platform, port); const owner = spawnSync(probe.command, probe.args, { encoding: "utf8" });` and `.slice(probe.headerLines)` instead of `.slice(1)`. Both tools print one header line; `lsof` exits 1 with no output when the port is free, which the existing `owner.status === 0` check already treats as free.
  3. Manual check: `python3 -m http.server <the worktree's port from devPortForWorktree> &` (record its PID), run `bun run dev:tauri -- --user-data-dir=$(mktemp -d)`, expect it to exit with "Dev port … is already in use", then `kill <PID>`.
- Verify: `bunx vitest run scripts/tauri-dev.test.ts` exits 0, and the step-3 run printed `is already in use` (paste it into the host log). `bunx biome check scripts/tauri-dev.ts scripts/tauri-dev.test.ts` exits 0.

### Task 1.9 — Regression gate and commit
- Steps: run the plan's regression gate items 1–7. Commit the compile fixes as `fix(tauri): compile and test the macOS build` (only if files changed).
- Verify: every gate command exits 0, and `bash scripts/check-module.sh snapshots` prints `check-module snapshots: PASS`. `test -e "$HOME/Library/Application Support/@oh-my-pi/omp-gui"; echo $?` prints `1`.

## Test matrix

| Level | What | Command |
|---|---|---|
| Compile | every target and feature on aarch64-apple-darwin | Task 1.6 clippy |
| Unit/integration | full Rust suite on macOS | Task 1.8 |
| Sidecar | pack, local-only models, MCP off, no context files | Task 1.5, 1.7 pack check |
| Unit (red→green) | `portOwnerProbe` uses `ss` on Linux and `lsof` on macOS | Task 1.8b |

## Regression gate

Plan regression gate items 1–7, all exit 0.

## Rollback

`git revert` the compile-fix commit. The tools and clone outside the repo are harmless to leave.

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

