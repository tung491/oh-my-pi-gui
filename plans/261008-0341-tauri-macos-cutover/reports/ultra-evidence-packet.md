# Evidence packet: Tauri for macOS (immutable; identical for all candidates)

Repo root: `/Users/tung491/orca/workspaces/oh-my-pi-gui/tauri_macos` (git worktree, branch `tung491/tauri_macos`, at `main` = `83d393c`). Plan directory: `plans/261008-0341-tauri-macos-cutover/`. Date: 2026-10-08, timezone Asia/Seoul, language English.

## Task

Write an implementation plan that moves Sai ATLAS on macOS from the Electron shell to the existing Tauri 2 Rust core (`src-tauri/`), then removes Electron from the repo. Linux already runs on Tauri (cutover release 0.9.17 is built and pending its tag). This plan replaces Phase 12 of the parent plan `plans/261002-1441-tauri-shell-migration/` (read `phase-12-macos-windows-cutover-electron-removal.md` and `plan.md` → Decisions, Execution rules, Validation Log). Windows is out of scope: skip every Windows step.

## User decisions (2026-10-08, binding)

1. Scope: macOS cutover first, then Electron removal as the final phase, gated on the macOS Tauri release being live with no blocking defect.
2. Architecture: **arm64 only**. No Intel x64 DMG/ZIP, no `build:omp:x64`, no `package:tauri:mac:x64`. `latest-mac.yml` lists arm64 assets only. AGENTS.md's release flow (which names both architectures) must be updated to match.
3. Sidecar source on this Mac: clone the monorepo `nornzach/oh-my-pi` to `~/WORK/oh-my-pi` and nest this GUI repo at `~/WORK/oh-my-pi/packages/gui` as AGENTS.md "Nested Checkout Layout" describes, then build `resources/omp` with `bun run build:omp` there and copy it into the worktree that needs it.
4. Population: **fresh installs only**. This repo has never published a macOS build (releases v0.9.15 and v0.9.16 carry only Linux assets; verified with `gh release view`). Mac users run the old `omp.app` from `nornzach/oh-my-pi-gui` and install the Sai ATLAS DMG by hand using the README migration steps. No Electron→Tauri self-update handover needs proving on macOS. The `omp-<version>-arm64.dmg` bridge copy stays (AGENTS.md: every release until 1.0.0).
5. Release timing: macOS Tauri ships in the **next release after 0.9.17** (so 0.9.18 or later), not bundled into 0.9.17. Linux 0.9.17 proceeds on its own plan.
6. Windows out of scope (2026-10-05).

## Host facts (this Mac, measured 2026-10-08)

- macOS 27.0 (26A428), arm64, Xcode Command Line Tools at `/Library/Developer/CommandLineTools` (no full Xcode), SDK 27.0.
- Rust stable 1.93 via rustup at `~/.cargo/bin`; installed target `aarch64-apple-darwin` only. `src-tauri/rust-toolchain.toml` = `stable`.
- **`cargo tauri` is NOT installed** (`cargo tauri --version` → "no such command"). The Linux plan pinned tauri-cli; check `scripts/rust-pins.env` and the Linux build Dockerfile `scripts/tauri-linux-build/Dockerfile` for the pinned version.
- `cargo-public-api` and its nightly (`scripts/rust-pins.env`: 0.52.0, nightly-2026-10-01) are not confirmed installed.
- No code-signing identity (`security find-identity -v -p codesigning` → 0). Signing stays ad-hoc (`signingIdentity: "-"`), as Electron does (`electron-builder.yml` `identity: "-"`, `notarize: false`).
- No monorepo clone; `resources/omp` and `resources/assistant-pack` are absent in this worktree.
- No Sai ATLAS installed in `/Applications`; no profile at `~/Library/Application Support/@oh-my-pi/omp-gui`.
- The user's real environment must be protected: every app run uses a throwaway profile (`--user-data-dir=$(mktemp -d)`).

## Repo facts

- AGENTS.md (repo root) governs everything: three-repo rule, sidecar & packaging rules, the five `patches/omp/*.patch`, the assistant pack spawn contract, release flow, i18n, tests. Read it first.
- `.claude/rules/*.md`: process-management (track/stop background processes, deterministic ports), development rules (no fake data, conventional commits without AI references, no plan IDs in code comments/tests/commit messages).
- Tauri macOS config exists but was never built: `src-tauri/tauri.macos.conf.json` (dmg+app, min 13.3, ad-hoc, `macos/app.entitlements`), `src-tauri/macos/{app.entitlements,omp.entitlements,sidecar.conf.json}`, `src-tauri/Info.plist`.
- `package.json` has `package:tauri:mac:arm64` = stage sidecar + `cargo tauri build --target aarch64-apple-darwin --config src-tauri/macos/sidecar.conf.json` (no `build:pack`, unlike `package:tauri:linux`). Electron scripts `package:mac*`, `build:omp:x64`, `check:mac-update-floor` still exist.
- `scripts/release-feeds.ts` writes `latest-mac.yml` (DMG+ZIP, `omp-` bridge copies, `minimumSystemVersion` 13.3→22.4.0); `scripts/mac-update-floor.ts` floor currently 22.0.0. The Tauri bundler produces no ZIP; Electron shipped `Sai-ATLAS-<v>-arm64.zip`.
- `src-tauri/src/omp/assistant_pack.rs:42-57` `resolve_pack_dir`: `assistant-pack/` beside the sidecar binary, else walk-up `resources/assistant-pack`. On macOS the sidecar is `Contents/MacOS/omp` (externalBin); non-code resources belong in `Contents/Resources` for the code-signature seal.
- `src-tauri/src/paths.rs:223-234` resolves the sidecar on darwin from `Contents/Resources` first, then `Contents/MacOS`.
- `pack_flags(pack_dir, os)` adds the Linux-only OS tools only on linux; macOS gets the office set.
- e2e: `wdio.conf.ts` is Linux-only (`/usr/bin/WebKitWebDriver`, `ss`); tauri-driver does not support WKWebView. `e2e-tauri/` has 9 spec files, `check-twins.ts`, `reach-ins.json`, and an `e2e-hooks` cargo feature that ships test hooks only in e2e builds. Electron Playwright specs live in `e2e/`.
- Rust gates (AGENTS.md "Build, Test, Release"): clippy `-D warnings` all targets/features, `cargo test --all-features`, `scripts/check-test-parity.ts`, `bash scripts/check-module.sh snapshots`. CI (`.github/workflows/ci.yml`) runs on ubuntu only.
- Sidecar supervisor: `src-tauri/src/omp/supervisor.rs` (re-exec of the GUI binary with `--omp-supervise`), Linux uses `setsid`, `PR_SET_CHILD_SUBREAPER`, `PR_SET_PDEATHSIG`, socketpair control fd 3, `/proc` orphan sweep. The parent plan's decision for macOS: supervisor plus kqueue `EVFILT_PROC`/`NOTE_EXIT` on the GUI pid and a recursive `proc_listchildpids` snapshot, because orphans reparent to launchd and `/proc` does not exist.
- Placeholders: `src-tauri/src/omp/proxy.rs:104` and `src-tauri/src/ollama/hardware.rs:109` log "… is not implemented on this OS". Parent plan: proxy via `scutil --proxy` (PAC-only → no proxy plus one log line), GPU via `system_profiler SPDisplaysDataType -json`.
- Single instance per profile: `lib.rs` swaps the Tauri identifier for `paths::single_instance_id()` on non-default profiles; confirm `tauri-plugin-single-instance` keys its macOS lock on it.
- Quick entry: `tauri-nspanel = "2"` (crates.io 2.1.0) under `cfg(target_os="macos")`, used at `desktop/windows.rs:1022-1035`; fallback if it does not build: plain always-on-top window.

## Scout inventory

Read `plans/261008-0341-tauri-macos-cutover/reports/scout-macos-parity-inventory.md` (full table with file:line). Ranked gaps: (1) no assistant pack in the mac bundle; (2) `omp.entitlements` unwired, hardened runtime unset; (3) no macOS e2e harness; (4) WKWebView microphone permission unhandled (`webview.rs:707-712` is webkit2gtk-only); (5) quick-entry panel parity (Mission Control collection behavior, `isBlockedMenuChord`, focus steal); (6) `omp://` CFBundleURLTypes unverified in a built .app; (7) Show-in-Finder for the update DMG, "Bring All to Front", floor 13.0→13.3; plus never-compiled macOS cfg code, proxy, GPU name, supervisor kqueue branch, single-instance check.

## Required plan format (output contract)

The candidate plan must satisfy, in its text:

- **Flags `--advice --tdd`.** Read `.claude/skills/ak-plan/references/advice-handover-plan.md`: the plan is executed by a weaker model (Sonnet-class). Every phase decomposes into ordered tasks, each with Goal, Target files and symbols (exact paths), Steps, Success criteria, and Verify (a mechanical pass condition: exact command + expected exit code/substring/file/value, or an explicit `no verification needed`). Every phase file contains the literal Failure Protocol block from that reference.
- **TDD:** each behavior change starts with a failing test (state the red-phase Verify explicitly: "exits non-zero with assertion failure"), then the implementation, then green. Each phase has a test matrix and a regression gate. Rust tests follow the repo's port-by-test style; TS tests use vitest and the linkedom harness.
- Phase file frontmatter: `phase`, `title`, `status: pending`, `priority`, `effort`, `dependencies`.
- `plan.md`: frontmatter (title, description, status, priority, effort, branch, tags, created), Outcome, Decisions table (with the user decisions above), Phases table + mermaid dependency graph, Execution rules (processes, throwaway profiles, protecting the user, sidecar build route, commit/push rules: commit to this GUI repo, push only with user approval), Acceptance criteria (checkboxes, mechanically checkable), Risks table, a link back to the parent plan.
- Manual on-screen checks the executor cannot do alone (TCC microphone prompt, quick-entry over a full-screen app, global chord, tray, notifications) are recorded as NEEDS-HUMAN with exact steps and batched into one sitting.
- Publishing (tags, pushes, GitHub Releases) requires the user's explicit go-ahead at that moment.

## Candidate output

Write ONE file: `plans/261008-0341-tauri-macos-cutover/reports/planner-ultra-candidate-{N}.md`, containing the full `plan.md` text followed by every phase file's full text, each under a `=== FILE: <name> ===` separator line. Do not write any other file. Do not edit source code, plan.md, or phase files. Do not read other candidates' files.
