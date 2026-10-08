---
phase: 3
title: "macOS packaged smoke harness"
status: completed
priority: P1
effort: "1d"
dependencies: [2]
---

# Phase 3: macOS packaged smoke harness

## Goal

One command, `bun scripts/tauri-mac-smoke.ts "<path>/Sai ATLAS.app"`, checks a packaged macOS build from outside, because tauri-driver cannot drive WKWebView and `wdio.conf.ts` is Linux-only. It prints `PASS <case>` or `FAIL <case>: <reason>` per case, then `tauri-mac-smoke: PASS` and exit 0, or `tauri-mac-smoke: FAIL (<n>)` and exit 1. The harness is the macOS counterpart of `e2e-tauri/packaged-smoke.e2e.ts`. Page-level checks stay with the human sitting in Phase 6.

## Files

- Create: `scripts/tauri-mac-smoke.ts`, `scripts/tauri-mac-smoke.test.ts`

## Cases the harness runs

| Case | Check |
|---|---|
| `bundle layout` | `Contents/MacOS/sai-atlas`, `Contents/MacOS/omp` (mode 755) and every file of `ASSISTANT_PACK_FILES` (copy the list from `src-tauri/src/omp/assistant_pack.rs:10-20`) under `Contents/Resources/assistant-pack` |
| `app signature` | `codesign --verify --strict --deep <app>` exits 0. `codesign -dv` shows `Identifier=vn.io.vif.saiatlas` and flags containing `runtime` |
| `app entitlements` | the key set equals the keys of `src-tauri/macos/app.entitlements` |
| `sidecar entitlements` | the key set equals the keys of `src-tauri/macos/omp.entitlements` |
| `info plist` | `CFBundleURLTypes` contains scheme `omp`, `LSMinimumSystemVersion` is `13.3`, `NSMicrophoneUsageDescription` is present |
| `pack check` | `bun scripts/check-assistant-pack.ts <app>/Contents/MacOS/omp <app>/Contents/Resources/assistant-pack` exits 0 |
| `boots a supervised sidecar` | launch with a throwaway profile and agent dir plus a project folder; within 30 s the GUI pid has a `--omp-supervise` child whose child is `omp --mode rpc-ui …--extension <app>/Contents/Resources/assistant-pack`; it is still alive 10 s later; `<profile>/logs/gui-runtime.jsonl` has no `sidecar-restart` entry |
| `single instance per profile` | a second launch on the same profile exits within 10 s with status 0, and the first keeps running. A launch on a second throwaway profile keeps running. Stop both afterwards |
| `hard kill leaves nothing` | SIGKILL the GUI, then within 10 s none of the recorded supervisor and omp pids is alive (`process.kill(pid, 0)` throws) |

## Tasks

### Task 3.1 — Red: pure helper tests
- Goal: failing tests for the parsing helpers the cases rely on.
- Target files: `scripts/tauri-mac-smoke.test.ts` (create).
- Steps: import `{ parsePs, descendantsOf, plistKeys, entitlementKeysFromXml }` from `./tauri-mac-smoke`, and write:
  1. `it("parses ps output into pid, ppid and command")`: input `"  PID  PPID COMMAND\n  10     1 /a/sai-atlas --user-data-dir=/p\n  11    10 /a/sai-atlas --omp-supervise /a/omp --mode rpc-ui\n"` yields `[{pid:10,ppid:1,command:"/a/sai-atlas --user-data-dir=/p"},{pid:11,ppid:10,command:"/a/sai-atlas --omp-supervise /a/omp --mode rpc-ui"}]`.
  2. `it("collects every descendant of a pid")`: rows 10←1, 11←10, 12←11, 13←1 make `descendantsOf(rows, 10)` → `[11, 12]`.
  3. `it("reads the keys of an entitlements plist")`: `plistKeys` on the text of `src-tauri/macos/app.entitlements` → `["com.apple.security.device.audio-input"]`.
  4. `it("reads the keys codesign prints")`: `entitlementKeysFromXml` on an XML string with two `<key>` entries inside `<dict>` returns both, in order.
- Verify (red): `bunx vitest run scripts/tauri-mac-smoke.test.ts` exits non-zero (module missing). Passing is a failure of this task.

### Task 3.2 — Green: the harness
- Goal: helpers pass, and the script runs every case in the table.
- Target files: `scripts/tauri-mac-smoke.ts` (create).
- Steps:
  1. Doc header: usage, the case list, and that every launch uses `mktemp -d` profile and agent dirs and never touches the real profile.
  2. Export the four helpers. `parsePs` reads `ps -axo pid=,ppid=,command=` output and also tolerates a header line. `plistKeys` and `entitlementKeysFromXml` both return the `<key>` texts in order.
  3. `main(app)` runs the cases in table order. Each case is wrapped in try/catch and prints exactly `PASS <case>` or `FAIL <case>: <reason>`.
     - Launch with `Bun.spawn([`${app}/Contents/MacOS/sai-atlas`, `--user-data-dir=${profile}`, project], { env: { ...process.env, PI_CODING_AGENT_DIR: agent } })`.
     - Poll `ps` every 250 ms.
     - In a `finally`, SIGTERM every app pid the harness started, then SIGKILL after 5 s.
  4. `codesign -d --entitlements - --xml <path>` writes the XML to stdout. Parse it with `entitlementKeysFromXml`.
  5. When `process.platform !== "darwin"`, print `tauri-mac-smoke: macOS only` and exit 2.
- Success criteria: unit tests green; biome clean.
- Verify: `bunx vitest run scripts/tauri-mac-smoke.test.ts` exits 0, and `bunx biome check scripts/tauri-mac-smoke.ts scripts/tauri-mac-smoke.test.ts` exits 0.

### Task 3.3 — Run the harness on the Phase 2 bundle
- Goal: the current bundle passes every case except the hard-kill case, which waits for Phase 4.
- Steps:
  1. `bun scripts/tauri-mac-smoke.ts "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sai ATLAS.app" 2>&1 | tee "$TMPDIR/smoke-1.txt"`
  2. Copy each `PASS`/`FAIL` line into `reports/macos-parity.md` as `macOS <case>: PASS|FAIL`.
- Success criteria: every case except `hard kill leaves nothing` prints `PASS`. That case may FAIL before Phase 4. If it fails now, record it as `macOS hard kill leaves nothing: FAIL (expected before the macOS supervisor port)`, so the strict `: FAIL$` grep does not match this line.
- Verify: `grep -E "^FAIL " "$TMPDIR/smoke-1.txt" | grep -v "hard kill leaves nothing" | wc -l` prints `0`. Afterwards `pgrep -f "Sai ATLAS.app/Contents/MacOS" || echo none` prints `none`.

### Task 3.4 — Commit
- Steps: `git add scripts/tauri-mac-smoke.ts scripts/tauri-mac-smoke.test.ts` and commit `test(macos): add a packaged smoke check for the macOS app`.
- Verify: `bunx vitest run` exits 0.

## Test matrix

| Level | What |
|---|---|
| Vitest | ps parsing, descendants, plist keys (3.1/3.2) |
| Packaged, automated | the nine cases above (3.3, then again in Phase 6) |

## Regression gate

Plan regression gate items 5–7 (no Rust change in this phase).

## Rollback

Revert the commit. The harness is standalone.

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

