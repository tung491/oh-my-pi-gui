# Renderer visual pass (Linux, Tauri)

Phase 10 Task 10.4. Run unattended on 2026-10-04, 22:36–23:05 KST.

## Environment

- **Build under test:** the Tauri `sai-atlas_0.9.18_amd64.deb` release (`/home/tung491/WORK/worktrees/stage-c/feed-0.9.18/`, sha256 `52176c7afefd9350…`), unpacked with `dpkg-deb -x` (no install, no sudo). The binary was `deb-tree/usr/bin/sai-atlas` with the bundled sidecar at `deb-tree/usr/lib/Sai ATLAS/omp`. It is a release build: no `e2e-hooks`, and it registers the `omp://` handler.
- **Display:** Xvfb `:99` 1920x1080x24 (xvfb 21.1.22) through `scripts/virtual-display.sh run`. The session was X11 (`GDK_BACKEND=x11`, `XDG_SESSION_TYPE=x11`) with a private D-Bus session bus that starts no services. There was no window manager, compositor, tray host, notification daemon or portal.
- **Rendering:** software GL (`libEGL warning: DRI3 error`, Mesa fallback). GDK monitor scale 1 at 96 dpi; `GDK_SCALE` was unset.
- **Stack:** Ubuntu 26.04.1, WebKitGTK `libwebkit2gtk-4.1-0` 2.52.6, GTK 3.24.52.
- **Model:** the real local Ollama with `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf` (from `config.yml` `modelRoles.default`).
- **Isolation:**
  - Profile: `--user-data-dir=<scratch>/profile`. `prefs.json` was seeded with only `language`, `providers` and `welcome` from the user's prefs, which were only read.
  - Agent dir: `PI_CODING_AGENT_DIR=<scratch>/agent`, seeded with `agent.db*`, `config.yml`, `models.db*`, `skill-descriptions.db` and `extensions/`; no sessions were copied.
  - XDG: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` pointed into scratch. Downloads went to `<scratch>/downloads`, through `user-dirs.dirs` in the scratch config home.
  - omp root: `PI_CONFIG_DIR` was a relative path that resolves to `<scratch>/omp-root` (from the third launch on; see Isolation notes).
  - `<scratch>` is `/tmp/claude-1000/-home-tung491-WORK-oh-my-pi-gui/dead79cc-3438-41c2-a6c5-17cc15a53c1c/scratchpad/visual`.
- **Input:** all input went through `scripts/virtual-display.sh xdotool` on `:99`. orca was not used.
- **Evidence:** screenshots are under `<scratch>/shots/`, copied to `/home/tung491/WORK/worktrees/.checkpoint-sai-atlas-261004/visual-pass/` (written `VP/` below). The exported log file is `VP/omp-logs-saved.log`.

## Results

| Row | Result | Evidence |
|---|---|---|
| Chat with markdown and code (highlight.js) | PASS | The model answered with a heading, a bullet list and a fenced python block. The block is syntax highlighted with a language badge and copy button. Light: `VP/03-chat-top.png`; dark: `VP/24-chat-dark-code.png`. |
| KaTeX | PASS | `E = mc^2 + \int_0^1 x^2\,dx` renders in KaTeX fonts with sub- and superscripts. Light: `VP/03-chat-top.png`; dark: `VP/24-chat-dark-code.png`. |
| Mermaid | PASS | `graph TD; A[Start] --> B[End]` renders as an SVG diagram. It re-themes on the dark switch. Light: `VP/02-chat.png`; dark: `VP/22-chat-dark.png`. |
| xterm (captured shell / tool output) | PASS | The renderer mounts no xterm.js instance: `@xterm/xterm` is only in `package.json`, and captured output renders through `AnsiText` (`src/renderer/lib/ansi.tsx`). A composer `!` command and the model's bash tool call both render with command line, output, exit badge and wall time. Shell: `VP/04-shell.png`; bash tool: `VP/05-bash-tool.png`. The sidecar strips ANSI before the GUI sees it (the session jsonl stores plain `green bold-red orange256`), so no colored spans can show; the GUI showed exactly the text it received. |
| CodeMirror | PASS | The composer's Edit Draft dialog (CodeMirror 6, markdown mode) accepts typing, Return inserts lines, and the markdown list continues ("- " added on Enter). Discarding with unsaved changes shows the confirm guard. Evidence: `VP/11-codemirror-zoom.png`, `VP/12-stats.png` (taken while the guard was showing). |
| Stats charts | PASS | Session stats after Sync shows the cards (31 requests, 279.2k tokens, 91% cache, 195 tok/s), the agent-type, model and tool tables, and the Activity line chart with time axis on range 1h. Range all: `VP/39-stats-all.png`; 1h: `VP/40-stats-1h.png`, `VP/40-stats-1h-chart.png`. On range "all" the chart shows one daily bucket, which a line cannot draw; this is data shape, not the engine. |
| Diff panel | PASS | Workspace > Diff > Repository lists `M hello.py` and `?? util.py`. The hunk view shows word-level red/green highlights, line numbers and `+1 -1`. Evidence: `VP/07-workspace.png`, `VP/08-diff.png`. The edit was made with a shell command in the scratch cwd, because the 2B model could not drive the hashline `edit` tool (16 failed calls, `VP/06-edit.png`; a model limit). |
| Files panel | PASS | Workspace > Files lists `hello.py` and `util.py`. Opening `hello.py` shows its current content with Open externally and Insert @mention. Evidence: `VP/09-files.png`, `VP/10-file-open.png`. |
| Settings reflow at 1400 px | PASS | Settings at window width 1400: the two-column capability cards and the full nav labels fit. Evidence: `VP/15-settings-1400.png`. Cosmetic, not WebKit-specific: the search placeholder runs under the `Ctrl+K` badge (`VP/15-settings-search-zoom.png`; the input's `pr-12` is narrower than the Linux label; see Observations). |
| Settings reflow at 800 px | PASS | Window resized to 800x900 with `xdotool windowsize`. The cards drop to one column, nav labels truncate with ellipses, and nothing overflows horizontally. Evidence: `VP/16-settings-800.png`. |
| Light and dark themes | PASS | Switching VIF Light to VIF Navy in Settings > Appearance > GUI re-themes the settings, chat, code, Mermaid, the scrollbars and the composer. Evidence: `VP/17-appearance.png`, `VP/21-settings-dark.png`, `VP/22-chat-dark.png`, `VP/24-chat-dark-code.png`. |
| Scrollbars | PASS | Thin overlay thumbs are visible and track position in the chat (right edge) and settings content, in both themes. Evidence: `VP/03-chat-top.png`, `VP/15-settings-1400.png`, `VP/24-chat-dark-code.png`, `VP/21-settings-dark.png`. |
| Quick-entry bar at 680x168, no empty band | PASS | Summoned with Shift+Ctrl+Space (X11 key grab, `quick entry shortcut activated` in `gui-runtime.jsonl`). `xwininfo` reports exactly 680x168. Pixel rows from the bar's top edge down to its last row (y=491) are all the page background `#F7F9FC`; the controls end at y≈474, with no separate strip below them. Evidence: `VP/18-quick-entry-light.png`, `VP/18-quick-entry-light-crop.png`. |
| Quick-entry Send button | PASS | Typed "Reply with the single word: pong" and clicked **Send**, not Enter. The bar closed and a new Chat tab in the main window got the prompt and the model's `pong`. Evidence: `VP/20-quick-entry-sent.png`. |
| Theme change reaches the bar on next summon | PASS | After switching to VIF Navy, the next Shift+Ctrl+Space summon opens the bar dark, still 680x168. Evidence: `VP/23-quick-entry-dark.png`, `VP/23-quick-entry-dark-crop.png`. |
| Voice dictation (WebAudio capture, sandbox on) | PENDING-USER | The virtual display has no real microphone and the private bus has no portal, so a transcript cannot arrive without the user present. |
| Tray icon visible with a working menu click | PENDING-USER | The private session bus has no StatusNotifier host, so no tray exists on `:99` (`libayatana-appindicator` loaded, nothing to show it). |
| Global shortcut on Wayland while another app has focus | PENDING-USER | `:99` is X11-only (`portal:false` in `gui-runtime.jsonl`); the Wayland portal path needs the user's real GNOME session. The X11 path works: Shift+Ctrl+Space summoned the bar twice (rows above). |
| Native notifications | PENDING-USER | The private bus has no notification daemon. |
| Bar stays above other windows on Wayland | ACCEPTED-DEGRADATION | Accepted in the phase file. Not observable on X11/Xvfb either way. |
| Tray has no left-click | ACCEPTED-DEGRADATION | Accepted in the phase file (AppIndicator menus open on any click). The tray itself is PENDING-USER above. |
| `omp://` link (second-instance handoff) | PASS | With the first instance running, a second `sai-atlas --user-data-dir=<same profile> omp://new` on the same session bus exited 0 after 0.11 s. The first instance logged `second instance: Url("omp://new")` then `deep link omp://new delivered to window 1`, and opened a new session. The bus name was `vn.io.vif.saiatlas.pbc4f976f2dcd3ae0` plus its `.SingleInstance` name. Evidence: `VP/34-before-link.png`, `VP/35-after-link.png`. Release-build registration landed only in scratch: `xdg/data/applications/sai-atlas-handler.desktop` and `xdg/config/mimeapps.list`. |
| Export logs (native save dialog, `.part` invariant) | PASS | Baseline `ls -a "$(xdg-user-dir DOWNLOAD)" \| grep -c '\.part$'` = 0. "Export filtered logs" opened a native GTK "Save File" dialog with suggested name `omp-logs-<ISO>.log`, rooted in the Downloads folder (`VP/27-save-dialog.png`). While it was open, the hidden staged file `.omp-logs-2026-10-04T13-55-03-348Z.log.1081910-0.part` (1624 B) existed. **Save** to `<scratch>/exports/omp-logs-saved.log` moved it; the count went back to 0. A second export answered with **Cancel** removed its `.…-1.part`; the count stayed at the baseline. The saved file holds exactly the 5 log lines the panel showed (`VP/26-logs-lines.png`, `VP/omp-logs-saved.log`). |
| Quit guard during a turn | PASS | With a bash tool turn running (`sleep 90`), the palette `quit` command opened the native "Sessions are still running" dialog ("1 of 2 sessions are still working in 1 window(s)…", Quit anyway / Keep working). **Keep working** left the app and turn running; the turn later completed. Evidence: `VP/30-turn-running.png`, `VP/32-quit-guard.png`, `VP/33-keep-working-crop.png`. |
| Closing the last window exits the process | PASS | Window > Close Window (and later Shift+Ctrl+W) on the only window, with nothing working: the GUI, supervisors, sidecars and stats server were all gone within 0.5 s, and the launcher exited 0. This was repeated on every shutdown in this run. Evidence: the File and Window menus in `VP/13-file-menu.png` and `VP/13-window-menu-crop.png`; process checks are in the run log. |
| Quitting with three windows restores all three | PASS | Opened two more windows (Shift+Ctrl+N; 3 `tabLayouts`) and quit from the palette: all processes exited in 0.5 s. Relaunching restored three windows, each with its tabs; window 1 kept Untitled, the Chats tab and the working session. Dark theme persisted, and one sidecar per restored agent tab came up. Evidence: `VP/36-three-windows.png` (before), `VP/37-three-restored.png` (after). The restored windows open cascaded from one saved geometry and at double size on this WM-less display; see Concerns. |

No row is FAIL, so the Failure Protocol and kongming escalation were not triggered and no code was changed.

## Observations and concerns (not Task 10.4 rows)

1. **New windows double in size on a display without a window manager.**
   - What happens: on `:99` every main window opened at twice its requested or saved size: 1400x900 became 2800x1800, a cascaded 2730x1730 became 5460x3460, and the restored windows came up at 2800x1800, 2772x1772 and 2744x1744.
   - Cause: tao 0.37.1 seeds `outer_size` with `root_origin()`, a position (`tao/src/platform_impl/linux/window.rs:329`). The value only becomes a real size on the first `configure-event`, and a WM-less X server sends no ConfigureNotify on map. `build_main_window` (`src-tauri/src/desktop/windows.rs:730`) then probes `outer_size` right after creation, reads about 0x0, and gets a negative "decoration". `corrected_inner_size` (`src-tauri/src/desktop/window_bounds.rs:44`) then adds the whole size back.
   - Scope: a desktop WM normally configures the window before the probe, but that path was not observable here. The quick-entry bar is unaffected (min = max = 680x168).
   - Suggested hardening (not applied, since no row failed): skip the correction when the probed outer size is smaller than the inner size.
   - Needs a check on the user's real X11 and Wayland sessions.
2. **The runtime log reports the wrong app version.** `gui-runtime.jsonl` stamps `appVersion: "0.9.15"` in the 0.9.18 build. `runtime_log.rs:235` uses `env!("CARGO_PKG_VERSION")`, and `src-tauri/Cargo.toml` still says `0.9.15`, while the app version comes from `package.json`. Logs and bug reports would carry a stale version.
3. **Settings search placeholder overlap (cosmetic).** The Linux `Ctrl+K` badge (about 58 px with its `right-2` offset) is wider than the input's `pr-12` (48 px) in `SettingsWindow.tsx:925`. This is layout, not WebKit; macOS shows the narrow `⌘K`.
4. **Sidecar resume note.** After a normal SIGTERM shutdown whose last session entry was a composer `!` shell run, the next launch appends "Previous OMP process exited before completing the turn." (`VP/14-relaunch.png`). That is sidecar resume logic and engine-neutral.
5. **Harness artifacts, not product defects:**
   - Each `virtual-display.sh run` starts its own private bus. A second instance launched through `run` cannot see the first and becomes its own primary. The handoff row was therefore run on the first instance's bus.
   - With no WM, a GTK dialog does not take X focus. Keys typed "into" the first save dialog re-pressed the still-focused Export button and opened a second export. The dialogs were then driven with explicit `xdotool windowfocus`.
   - `xdotool type` sends `\n` as Linefeed, which CodeMirror ignores. Return was sent as a key instead.

## Isolation notes and cleanup

- **What leaked:** `PI_CODING_AGENT_DIR` does not move omp's root data (`stats.db`, `logs/`, `cache/`, `run/`). With a non-default agent dir, omp also ignores the XDG overrides (`dirs.ts` `isDefault`). So the first two launches wrote per-PID logs to `~/.omp/logs` and opened the user's real `~/.omp/stats.db` read-only:
  - `stats.db` mtime is unchanged (2026-10-03 14:12) and its WAL was 0 bytes.
  - SQLite removed the empty `-wal`/`-shm` when my stats server closed.
- **Cleanup:** I removed the six files named with my process IDs (`omp.2026-10-04.{1054561,1071807,1079942}.log` and the matching `.omp.<pid>-audit.json` where present). Nothing else of the user's was modified.
  - Touched but left: `~/.omp/natives/18.4.8` (it predates this run, birth 05:10), `~/.omp/run/daemons` and `~/.omp/cache/legacy-pi-extension-cache.db` were only opened or touched.
- **Fix for later launches:** from the third launch on, `PI_CONFIG_DIR` pointed the omp root into scratch (`<scratch>/omp-root`). Because the GUI's log watcher tails `<agent dir>/../logs`, `<scratch>/logs` was symlinked to `<scratch>/omp-root/logs`; in the default layout both are `~/.omp/logs`.
- **Real desktop files, before and after:**
  - `md5sum ~/.config/mimeapps.list` = `ca1dc4649ef173558754f4d870c961d2` both times.
  - `~/.local/share/applications` never had `sai-atlas-handler.desktop`, so no restore was needed.
- **Processes:** every process I started (five app launches, one stray second instance, the two second-instance probes) was stopped through the app's own close or quit, or ended with its launcher. No signals were sent to anything else. At the end, `scripts/virtual-display.sh status` listed only Xvfb, then `scripts/virtual-display.sh stop` reported the display and viewer not running.

## Verify

The phase's FAIL-row count (`grep -c` for a FAIL result cell in this file) prints `0`. All 26 rows are PASS, PENDING-USER or ACCEPTED-DEGRADATION.
