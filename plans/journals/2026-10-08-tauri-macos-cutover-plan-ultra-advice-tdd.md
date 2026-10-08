---
title: "Tauri macOS cutover plan (ultra, advice, tdd)"
date: 2026-10-08
summary: "Ten-phase plan to ship Sai ATLAS on Tauri for macOS arm64, then remove Electron; picked best of five by a blind verifier."
---

# Tauri macOS cutover plan (ultra, advice, tdd)

## What happened
Planned the macOS move from Electron to the existing Tauri 2 core with `ak:plan --ultra --advice --tdd`. Five Opus planners wrote candidate plans from one evidence packet; the `kongming` verifier scored them blind (winner 127/140, runner-up 119). The winner was materialized unchanged into `plans/261008-0341-tauri-macos-cutover/` (10 phases, about 12.5 days), then amended with 12 red-team fixes. Both the candidates and the verifier were interrupted (session end, then a network error) and resumed from their transcripts.

## Findings that shaped the plan
- The macOS bundle shipped no assistant pack, and `resolve_pack_dir` looks in `Contents/MacOS`; the pack moves to `Contents/Resources`.
- The Tauri bundler signs the sidecar with the app's entitlements (no JIT). A finalize step re-signs the sidecar, then the app, and rebuilds the DMG with `hdiutil`.
- The RAM probe returns 0 off Linux (`ollama/hardware.rs`), so the context fit has no machine facts on any Mac.
- `tauri_nspanel::init()` is never registered, so the quick-entry panel would panic on first open.
- A release with only Mac assets becomes "latest" and breaks Linux `latest-linux.yml` updates.
- Electron removal is blocked by `include_str!` reads of `src/main/**` (i18n, tray mark, assistant pack), the fixture's `rpc-bridge` import and 41 parity entries; Phase 9 moves them first.
- `scripts/tauri-dev.ts` probes the dev port with `ss`, so the port guard never fires on macOS.

## Decisions (user, 2026-10-08)
arm64 only; fresh installs only (this repo never published a Mac build); ships in the first release after 0.9.17; Electron removed only after that release is live with no blocking defect; the user builds the Linux assets on the Linux host; delete `capture-showcase.ts`; accept the untested 13.3 floor.

## Next steps
Run Phase 1 (toolchain, monorepo sidecar build, first macOS compile, signing spike) with `/ak:cook --advice`. Phase 8 waits for v0.9.17 and the Linux assets.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
