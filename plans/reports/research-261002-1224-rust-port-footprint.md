# Research: porting Sai ATLAS to Rust to shrink its footprint

Conducted 2026-10-02 12:24 (Asia/Seoul) on Linux x64, Electron 44.4.5, GUI 0.9.10, on the `feat/gemma-catalog-install-progress` branch.

## Verdict

Do not port to Rust now. Rust does not touch the largest cost. The bundled `omp` sidecar takes most of the memory and most of the disk space, it is upstream TypeScript (about 617k lines), and the parts of it that do heavy computing are already Rust (`crates/pi-*`). A Tauri rewrite of the Electron shell would save about 250 MB of RAM, a fixed amount that does not grow with tabs. It would cost months of work, a break in auto-update for users already installed, and a new class of WebKitGTK rendering bugs on Linux.

The same RAM can be won more cheaply in the GUI's own code. Today every open tab keeps its own live sidecar of about 340 MB, and nothing ever releases it. Releasing sidecars for tabs that are idle and hidden saves more memory than the Rust port as soon as a user has two or more tabs open, and it takes days, not months.

## Contents

1. [Where the footprint goes (measured)](#1-where-the-footprint-goes-measured)
2. [What a Rust port could change](#2-what-a-rust-port-could-change)
3. [Costs and risks of a Tauri port](#3-costs-and-risks-of-a-tauri-port)
4. [Cheaper levers, ranked](#4-cheaper-levers-ranked)
5. [Recommendation and next steps](#5-recommendation-and-next-steps)
6. [Unresolved questions](#6-unresolved-questions)

## 1. Where the footprint goes (measured)

These numbers come from the live `bun run dev` instance with one tab open. PSS is read from `/proc/<pid>/smaps_rollup` and counts shared pages only once, so the rows can be added up.

| Process | PSS | Notes |
|---|---:|---|
| `omp --mode rpc-ui` (one tab) | **343 MB** | 265 MB anonymous heap (Bun/JSC) plus 79 MB of mapped binary. Peak (VmHWM) is **593 MB**. 44 threads. |
| Electron renderer | 153 MB | The React app. Most of this would remain in any webview. |
| Electron GPU process | 141 MB | |
| Electron main | 124 MB | Dev mode, so inflated by HMR and electron-vite. |
| Electron network and utility | 30 MB | |
| Zygotes (×3) | 32 MB | |
| **Electron total** | **~480 MB** | Fixed per app, not per tab. |

How memory grows: `SidecarPool` (`src/main/sidecar-pool.ts:159`, `max = 10`) creates one sidecar per tab. A sidecar is disposed only when its tab closes (`#releaseEntry`, line 405) or the app quits (`disposeAll`). There is no idle eviction. Opening the stats dashboard adds one more `omp` process (`src/main/stats-server.ts`).

| Open tabs | Electron | Sidecars | Total | Share from Electron |
|---:|---:|---:|---:|---:|
| 1 | 480 MB | 343 MB | ~0.8 GB | 58% |
| 3 | 480 MB | 1.0 GB | ~1.5 GB | 32% |
| 10 (pool cap) | 480 MB | 3.4 GB (peaks to ~5.9 GB) | ~3.9 GB | 12% |

Disk: `resources/omp` alone is **301 MB**. The Electron runtime adds roughly 100 to 120 MB per installer. The sidecar is about 70% of every package.

## 2. What a Rust port could change

"Port to Rust" can mean three different scopes:

| Scope | What changes | Realistic saving | Feasibility |
|---|---|---|---|
| **A. Tauri v2 shell.** Rust core plus the existing React renderer in the OS webview. | Replaces Electron main, preload and Chromium. Rewrites ~10.6k lines of `src/main` and the 54 IPC handlers in Rust. | RAM: ~480 MB becomes ~150 to 250 MB (the webview still runs the 80k-line React app and its JS heap). Disk: ~100 MB less per installer. | Feasible. 2 to 4 engineer-months including QA on 3 OSes. |
| **B. Native Rust UI** (egui, Iced, Slint, Dioxus native) | Also rewrites the 80k-line renderer: markdown, KaTeX, Mermaid, xterm, CodeMirror, Chart.js. | Up to ~400 MB of RAM. | Not justified. These libraries have no Rust equivalents of the same quality. |
| **C. Rust agent / sidecar** | Rewrites `packages/coding-agent`, `agent` and `ai` (~617k lines). | Most of the sidecar's 265 MB heap. | **Not feasible.** It cuts the product off from `can1357/oh-my-pi` upstream sync, which `AGENTS.md` makes the first step of every release. |

Published 2026 benchmarks report Tauri idling at about 42 MB against 168 MB for Electron, and bundles 20 to 50 times smaller ([tech-insider](https://tech-insider.org/tauri-vs-electron-2026/), [rustify](https://rustify.rs/articles/rust-tauri-vs-electron-2026), [pkgpulse](https://www.pkgpulse.com/blog/best-desktop-app-frameworks-2026)). Those are hello-world apps. Our renderer is heavy, and the 301 MB sidecar ships with either shell, so "96% smaller" does not apply to us. Our package would shrink by about 25%, not 96%.

## 3. Costs and risks of a Tauri port

- **Auto-update break.** `electron-updater` cannot install a Tauri build. Existing users need a final Electron release that sends them to a manual download, and some stay behind for months ([kanbanflow PR #455](https://github.com/metawave/kanbanflow-app/pull/455), [Fluxzy migration notes](https://www.fluxzy.io/resources/blogs/electron-to-tauri-migration-fluxzy-desktop)). We are already running one manual migration (omp.app → Sai ATLAS until 1.0.0). A second one in a row is a real cost to users.
- **Contracts that must hold.** The pinned `appId`, the Windows `nsis.guid`, the profile path `<appData>/@oh-my-pi/omp-gui`, the `electron-store` files and the `latest-mac.yml` and `latest-linux.yml` flow, all guarded by `packaging-config.test.ts`. Tauri uses its own updater manifest and minisign signatures, and Windows needs two signing passes.
- **Linux webview risk.** WebKitGTK has known problems with Wayland and NVIDIA: blank windows, Error 71 crashes, and a DMABUF renderer that must be disabled at a cost to performance. A WebKitGTK 2.52.6 regression in 2026 pegged a CPU core on AMD as well ([Tauri Linux graphics docs](https://v2.tauri.app/develop/debug/linux-graphics/), [tauri #9394](https://github.com/tauri-apps/tauri/issues/9394), [example regression](https://github.com/Snehal1112/rocket/issues/17)). The product targets SAI OS on Linux, so this lands on the main platform.
- **Three rendering engines.** The app would run on WKWebView (macOS 13 is the floor in `electron-builder.yml`), WebView2 and WebKitGTK, instead of one pinned Chromium. Tailwind v4 needs Safari 16.4 or later. The xterm, CodeMirror and Mermaid output would need checking on each engine.
- **Lost Electron behaviour that we rely on**: the quick-entry window, `globalShortcut` together with the Wayland portal, tray, deep links, `session`/`net` proxy handling and renderer-crash recovery. Each has a Tauri plugin or a Rust equivalent, but each has to be rebuilt and retested.

A lighter alternative is **Electrobun** (Bun main process plus the system webview, ~12 to 14 MB bundles) ([what is Electrobun](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/what-is-electrobun.mdx)). It would keep the main process in TypeScript, but it has the same webview and update-migration risks, and it is newer than Tauri. If the shell is ever replaced, compare the two then.

## 4. Cheaper levers, ranked

Each lever is ranked by the RAM or disk it saves against the effort it takes. All of them work inside this GUI repo or the sidecar build script.

1. **Release sidecars for idle, hidden tabs** (GUI repo, `sidecar-pool.ts`). Keep visible tabs and running turns live. After an idle timeout, dispose other tabs' sidecars and respawn on focus with `--resume` of the session file. The pool already tracks session paths. Saving: 343 MB for each tab beyond the visible ones, so one released tab already beats the Tauri port's fixed saving of about 250 MB. Effort: days. Risk: respawn latency and losing in-memory state such as approvals or queued prompts, so a running turn must never be released.
2. **Lower the cap and warn.** `max = 10` allows about 3.4 GB of sidecars, rising to about 5.9 GB at peak. Show memory per tab, or cap concurrent live sidecars separately from open tabs (this goes with lever 1).
3. **Tune the sidecar build** (`scripts/build-bundled-omp.ts` → `compileCodingAgent`). Turn on `minifyIdentifiers` (currently defaults to `false`) and Bun's `--bytecode-order` profile-guided layout, which Bun reports cut startup memory by about 40 MB on a large CLI ([Bun executables docs](https://bun.com/docs/bundler/executables)). Pick up Bun's lazy loading of embedded files on Linux ([Bun announcement](https://x.com/bunjavascript/status/2034853393513226334)), which should reduce the 79 MB of mapped binary. Measure `--smol` and JSC heap limits, but expect little: one 2026 measurement found `--smol` raised RSS ([khimananda](https://khimananda.com/blog/performance-tuning-bun-in-production)).
4. **Shut down the stats server when the dashboard closes**, instead of keeping it alive until quit.
5. **Shrink Electron itself.** Package with `asar`, ship only the needed locales (`electronLanguages`), and measure a packaged build, because dev mode inflates main and renderer. Expect tens of MB of disk and little RAM.
6. **Agent-side multi-session** (one `omp` process serving several tabs). This would be the largest structural saving, but it changes the monorepo and moves us away from upstream. Propose it upstream to `can1357/oh-my-pi` instead of forking.

## 5. Recommendation and next steps

```
priority:  idle-tab eviction  >  sidecar build tuning  >  stats-server lifecycle  >  Electron trims
           (days, −343 MB/tab)   (hours, −40–80 MB/tab)   (hours)                     (hours, disk)
deferred:  Tauri shell port (months, −~250 MB fixed, update break)
rejected:  Rust agent rewrite (severs upstream)
```

1. Measure a **packaged** build first (AppImage and DMG, 1 / 3 / 5 tabs, idle and mid-turn), using the PSS method in section 1. Dev-mode Electron numbers overstate the shell.
2. Plan and build idle-tab sidecar eviction in `sidecar-pool.ts`, with tests in `sidecar-pool.test.ts` covering the rule that a running turn is never released.
3. Try `minifyIdentifiers` and `--bytecode-order` in `build-bundled-omp.ts`. Record the sidecar's PSS and binary size before and after.
4. Reopen the Tauri question only if, after steps 1 to 3, the Electron shell is still more than half of the measured footprint for a typical session. If that happens, build a spike first: the quick-entry window, tray, global shortcut on Wayland and the updater, on SAI OS hardware, before committing to the port.

## 6. Unresolved questions

- What session does a typical user run: how many tabs, and how long do they stay idle? The size of the eviction win depends on it.
- Can the sidecar resume a session without losing pending UI state (approvals, queued input)? This needs checking in the `rpc-ui` protocol before eviction is designed.
- What does a packaged Linux build weigh in RAM? All Electron figures above come from dev mode.
- Which WebKitGTK version ships on SAI OS, and on which GPUs? This decides whether a Tauri port would be viable on Linux at all.
