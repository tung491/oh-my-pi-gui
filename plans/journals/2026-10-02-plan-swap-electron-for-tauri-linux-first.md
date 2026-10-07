---
title: "Plan: swap Electron for Tauri, Linux first"
date: 2026-10-02
summary: "13-phase handover plan for a Tauri 2 Rust shell; red team caught a lost Linux sandbox, a broken updater handover and an unpinned release route"
---

# Plan: swap Electron for Tauri, Linux first

## What happened

Planned the swap from Electron to Tauri 2 for Sai ATLAS (`plans/261002-1441-tauri-shell-migration/`, `--parallel --advice`). The plan went through scouting (three Explore passes over `src/main`, the preload bridge and packaging), one round of kongming architecture counsel and a four-lens red team. The red team returned 40 raw findings, merged into 15.

Three were critical:
- On Linux, WebKitGTK's web-process sandbox is opt-in, and wry leaves it off. Electron's renderer sandbox is a tested invariant today (`e2e/packaged-smoke.e2e.ts:139-156`).
- The 0.9.x Electron updater would break when installing the Tauri build. The AppImage `execFileSync` blocks on a child that ignores `APPIMAGE_EXIT_AFTER_INSTALL`, and the deb relaunches `/opt/Sai ATLAS/sai-atlas`, which no longer exists (`src/main/updater.ts:225-232, 368`).
- The release route was never pinned. origin is `tung491/oh-my-pi-gui`, which has no releases, while the feeds point at `nornzach/oh-my-pi-gui`, whose latest is omp 0.9.14. Installed Sai ATLAS builds are therefore offered a different app as an update right now.

Other findings changed the core design:
- a runtime-free `AppCtx` with port traits, so modules can be tested with fakes;
- ordered per-window dispatch with handlers that admit work synchronously, replacing Electron's single-threaded IPC ordering;
- one `Channel` per page instead of per-subscription invokes;
- numeric window ids, to keep `IpcSessionOwner.winId`;
- SIGTERM sidecar shutdown;
- test hooks behind a compile-time feature;
- the e2e reach-in count corrected from 15 to 34.

## Decision

The user decided:
- publish from `tung491/oh-my-pi-gui`;
- the installed builds were hand-shared, so the Phase 1 Electron release repoints their feed and is handed out the same way;
- port the yml updater, not the Tauri updater plugin;
- switch Linux first, with macOS/Windows and Electron removal in Phase 12;
- add a one-time import of Chromium LevelDB localStorage;
- keep the footprint gate at ≤ 60% of the Electron shell's PSS;
- block the Linux cutover until dictation works.

The plan now has 13 phases and about 75 engineer-days, up from 43 in the first draft.

## Next steps

- Phase 1 should ship soon regardless of the Tauri go/no-go, because the wrong-feed hazard exists today.
- Phase 0 runs on this machine (NVIDIA RTX 5080, GNOME Wayland, WebKitGTK 2.52.6). The hard gates are S1, S2, S3, S7, S7b and S14.
- Open: the README and site links and the deb `homepage`/`maintainer` still name nornzach.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
