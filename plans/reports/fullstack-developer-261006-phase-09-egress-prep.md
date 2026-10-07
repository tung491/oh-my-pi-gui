# Phase 9 Task 9.6 (egress audit): preparation report

Status: prepared up to the start of recording. The recorded session has NOT been run. The dry run already shows one condition the recorded audit will mark "not allowed" (a user MCP server runs inside pack sessions), plus an automatic update check to GitHub at launch. Both are listed under Findings for the user to decide before or after recording.

## 1. The deb

- Path: `/home/tung491/WORK/worktrees/rebrand-integration/src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/Sai ATLAS_0.9.16_amd64.deb`
- sha256: `c4d34d6c8d62457fab87fa453e42dad78ffc3d5238ba321a6234e6cce47d4d9c`
- Built with `bun run package:linux` (Docker, Ubuntu 24.04) with `SAI_ATLAS_UPDATE_BASE` unset, from `rebrand/everyday-work` at `c5b0031`. The binary's compiled-in feed base is `https://github.com/tung491/oh-my-pi-gui/releases`.
- Bundled sidecar `/usr/lib/Sai ATLAS/omp`: sha256 `6b7bdbbcd1209d4b98ffd7128e057341bc343a5bffda55a095d33bfa86f668a0`, identical to `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64` (`omp/18.4.8`; `--help | grep -c -- --no-context-files` prints `1`).
- Depends: `bubblewrap, xdg-dbus-proxy, libayatana-appindicator3-1 | libappindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`. Recommends: `desktop-file-utils, xdg-utils, gstreamer1.0-plugins-good, gstreamer1.0-pipewire, libglib2.0-bin`.
- Build note: the worktree's `resources/omp.linux-x64` is a symlink to an absolute path outside the build container's mount, so staging would have failed. For the build only, I replaced it with a hard link to the same inode. The symlink was restored afterwards and the worktree is clean (`git status` prints nothing).

## 2. Harness

Plan tools only. No product file was modified and nothing was committed.

| File | Role |
|---|---|
| `plans/261005-0812-everyday-work-rebrand/tools/egress-audit.sh` | Host entry: preflight, image builds, DNS snapshot, container run, post-processing |
| `tools/egress-audit/Dockerfile` | `sai-atlas-tauri-deb-smoke` plus `strace` (image `sai-atlas-egress-audit`) |
| `tools/egress-audit/egress-entrypoint.sh` | Root stage: `apt-get install` of the deb, seeding of the power-user home. Session stage: headless weston, WebDriver run, copy of container-side evidence |
| `tools/egress-audit/egress-app-launcher.sh` | What WebKitWebDriver starts: `strace -f -ttt -Y -e trace=connect -o /out/egress-app.txt /usr/bin/sai-atlas`, started in `$HOME` with the default profile |
| `tools/egress-audit/egress.conf.ts` | wdio config. Reuses `wdio.conf.ts` driver handling (ports 4444/4445, leftover sweep) and launches through the strace launcher |
| `tools/egress-audit/egress.e2e.ts` | Drives the step-3 actions in order and stamps each one in `timeline.tsv` |
| `tools/egress-audit/egress-report.ts` | Post-processing into `egress-rows.tsv` and `egress-rows.md` |

How it matches the task:
- **Container.** Clean Ubuntu 24.04 with the same sandbox opt-outs and core limit as `tauri-deb-smoke.sh`, plus `--network host`. The smoke script itself does not reach Ollama at all, because it runs on the default bridge network. Host networking is the only way the app can reach the host's Ollama at a literal loopback address, which is the only kind the local-only policy accepts. No `DISPLAY` is passed in. The app runs on the container's own headless weston, with a private session bus.
- **Seeded home** (`/home/ubuntu`):
  - `~/.omp/agent/config.yml` contains `tools: {approval: {write: allow}}`.
  - `~/.omp/agent/mcp.json` defines one stdio server, `mcp-notes-server.sh`.
  - `~/.omp/agent/extensions/egress-tripwire.ts` is one user extension.
  - `~/.env` holds made-up `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` values (`sk-…-egress-audit-made-up-…`).
  - The MCP server and the extension are tripwires: if anything starts them, they write a marker to `~/.egress-tripwires/` and try one connect to TEST-NET-1 (`192.0.2.11`/`.12`, never routed). A load therefore shows both as a marker and as a connect row.
  - Inputs live in `~/Documents/egress-inputs/`: meeting notes `.md`, a messy `.csv`, a project update `.md`, and a supplier note `.txt` with two `example.com`/`example.org` URLs.
- **Actions, in order, each stamped with epoch start and end in `timeline.tsv`:**
  1. first run
  2. Word report (starter card)
  3. spreadsheet clean-up (card)
  4. slide deck (card)
  5. helpdesk (card, then a typed Wi-Fi question)
  6. read the document with the URLs (typed)
  7. "Search the web for …" (typed)
  8. typed `/model anthropic/claude-sonnet-4-5`
  9. typed `/login`
  10. update check (Settings › Updates › Check for updates)
  11. cloud-tag pull: Ollama window, type `gpt-oss:120b-cloud`, record whether Download is disabled and the refusal text, then press Enter anyway
  12. cloud-tag select: typed `/model ollama/gpt-oss:120b-cloud`, then the `set_model` RPC the picker sends, and record both refusals and the model before and after.
- **Stand-ins and choices, stated in the spec header.** The file cards use the desktop file chooser, which WebDriver cannot drive. The page's `showOpenDialog` is therefore replaced by one that returns the seeded file, and the card then sends exactly what it sends after a real pick. Approvals are approved. Ask dialogs get the recommended answer, or the first one. Open-in-browser requests are recorded and dismissed with Done, never opened. Each job runs in a fresh conversation (`new_session`). Each action has a time limit (`EGRESS_ACTION_TIMEOUT_MS`, default 20 minutes) and is aborted when the limit passes. There is a 5-second gap between actions so a late connection is not blamed on the next action.
- **Outputs** go to `plans/reports/egress-261006/`: `egress-app.txt`, `timeline.tsv`, `selected-model.txt`, `model-after.txt`, `dns-snapshot.tsv` (taken before and after the session), `run-info.txt` (deb sha256, image, Ollama PID), `screens/*.png`, `ps/*.txt` (thread-to-process map after each action), and `container-state/` (saved files, tripwire markers, sessions, app log). The directory already exists and is empty, so the user's `strace -o` path is valid.
- **Post-processing** (`egress-report.ts`, run automatically after the session; `--report-only` re-runs it once the Ollama trace has stopped):
  - Produces one row per (process, destination host:port, action), with first time, count, connect results and a mechanical "suggested" verdict taken from the plan's allowed list.
  - IPs are named from the DNS snapshot, otherwise by reverse lookup.
  - Port-53 rows are flagged as name lookups, and glibc's port-0 address-sorting probes are labelled as such (no packet is sent).
  - AF_UNIX connects are summarized separately as local IPC.
  - The parser was checked on real `strace -Y` output, including `<unfinished ...>`/`resumed` pairs.
- **Checks:** `tsc` (against `tsconfig.wdio.json` types) passes and `biome check` is clean on the three `.ts` files. `bash -n`/`sh -n` pass on the shell scripts.

Usage:
```bash
T=/home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/tools
bash $T/egress-audit.sh --dry-run                 # install, launch, stop at the first-run screen
bash $T/egress-audit.sh                           # recorded session (refuses unless the host Ollama trace is running)
bash $T/egress-audit.sh --report-only             # re-run post-processing on plans/reports/egress-261006
# options: --deb PATH, --out DIR, --no-ollama-trace; env: EGRESS_ACTION_TIMEOUT_MS, EGRESS_MODEL
```

## 3. Dry-run evidence

The evidence is kept in `plans/reports/egress-261006-dry-run/`. It is not a recording; the traces cover the launch only.

- **Attempt 1** (`first-attempt/`): install, launch under strace, sandboxed WebKit and the sidecar all worked, but the first-run screen never opened. The cause is that the welcome screen opens on its own only when Ollama lists no model, and the host already has four. The app started on the first model Ollama lists, `ollama/hf.co/mradermacher/Quyet-1.0-Medium-GGUF:Q4_K_M`. The harness now records that and opens the same screen through Ollama › Run setup again.
- **Attempt 2** (final harness): exit 0. `first run ✓`, 11 actions skipped. `timeline.tsv` records "first-run screen shown (dry run, nothing clicked)", and `screens/dry-run-first-run-screen.png` shows "Set up your local assistant" with Ollama running (4 models).
  - The whole app tree ran under strace, including `bwrap` → `WebKitWebProcess`, `--omp-supervise` and `omp --mode rpc-ui`. The app quit cleanly on SIGTERM, and no leftover processes were reported.
  - The EGRESS_MODEL and MainPID edits were made after this run. They touch only the non-dry-run path and the preflight, and they typecheck.
- **Teardown:** `docker ps` shows no container of mine, and no harness processes remain on the host. Scratch directories have been removed. The image `sai-atlas-egress-audit` is kept for the recorded session. `sai-atlas-tauri-deb-smoke` was rebuilt from the worktree's `scripts/tauri-deb-smoke`, using the same command the smoke script runs. No image or cache was removed or pruned.

## Findings from the dry run (for the user, before the recording)

1. **A user MCP server runs inside pack sessions.** The seeded `~/.omp/agent/mcp.json` server was spawned by the sidecar (`omp --mode rpc-ui --no-extensions …`, pid 353 → 475 `mcp-notes-server.sh`). It restarted roughly every 30 seconds, and its tripwire tried `192.0.2.12:9`. `assistant-pack/config.yml` sets only `mcp.enableProjectConfig: false`, and the spawn flags have no MCP opt-out. The recorded audit will mark this "not allowed", because a user's MCP server is arbitrary code that can connect anywhere while the privacy sentence is shown. Per the phase's Failure Protocol I have not changed any code. The user extension tripwire did not fire, so `--no-extensions` holds.
2. **Automatic update check at launch.** About 3 seconds after launch, the app main process (Rust `tokio-rt-worker`) resolved names and connected to `github.com` (20.200.245.247:443) and to `objects.githubusercontent.com`/`release-assets.githubusercontent.com` (185.199.x.133:443) without any click. These are allowed hosts for an update check, but the plan says "update check only". The auditor needs to decide whether the automatic startup check counts as an update check. The post-processor will attribute these rows to "first-run".
3. **Model choice.** On this host (65.4 GB RAM, "no dedicated GPU"), the welcome screen offers Gemma 4 E2B (Minimal, installed) and 26B A4B (Recommended and Maximum, not downloaded). The installed E4B gets no card, so Get started picks `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:latest`. The jobs would therefore run on E2B, which scored 15/20 in the spike, unless `EGRESS_MODEL=hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest` is set. Either way, the tag is recorded.

## 4. The user's host command (Ollama daemon trace)

- Ollama is the systemd service `ollama.service` (User `ollama`, MainPID 4345, `/usr/local/bin/ollama serve`). `pgrep -x ollama` finds exactly one process right now. However, once a model loads, its `ollama runner` child has the same name and pgrep would return two PIDs, so the command below uses the service's MainPID.
- `strace` is installed on the host (strace 6.19, package `strace`).

Run this in your own terminal, and leave it running until the session ends; it stops on Ctrl-C or after 3 hours:
```bash
sudo timeout 10800 strace -f -ttt -Y -e trace=connect -p "$(systemctl show -p MainPID --value ollama)" -o /home/tung491/WORK/oh-my-pi-gui/plans/reports/egress-261006/egress-ollama.txt
```
`-ttt` gives the daemon trace the same epoch clock as the timeline. `-f` is needed because Go connects from any thread and model runners start as children. Tracing a running process under ptrace slows Ollama's syscalls, so the jobs will run somewhat slower while the trace is attached. `--seccomp-bpf` cannot be used with `-p`.

## 5. Start command for the recorded session (once the user's trace is running)

```bash
bash /home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand/tools/egress-audit.sh --deb "/home/tung491/WORK/worktrees/rebrand-integration/src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/Sai ATLAS_0.9.16_amd64.deb"
```
Add `EGRESS_MODEL=hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest` in front of the command to run the jobs on E4B. The script refuses to start unless a `strace … -p <ollama MainPID>` process is running. Once the user stops the trace, run `bash …/egress-audit.sh --report-only`. Then write `plans/reports/egress-audit-261005-everyday-work-rebrand.md` from `egress-rows.md` (step 4).

## Unresolved questions

1. Finding 1 (user MCP servers start in pack sessions) will produce a "not allowed" row. Should the recording go ahead as-is, to document it, or should the pack first disable user MCP config (a product change outside this phase's ownership)?
2. Does the automatic GitHub update check at launch count as "update check only" for the verdict?
3. Should the jobs run on E2B (what Get started picks on this machine) or on E4B (spike-gated, via `EGRESS_MODEL`)?
4. Method limit: `-e trace=connect` does not see UDP datagrams sent with an explicit address (`sendto`/`sendmsg` without `connect`), connects made through io_uring, or processes started by D-Bus activation rather than by the app (for example at-spi). Is that acceptable for the verdict, or should the harness add a host-side `ss`/packet capture as a cross-check?
