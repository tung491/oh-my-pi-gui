# Spike report: everyday-work rebrand (Phase 1)

Date: 2026-10-05. Worktree `/home/tung491/WORK/worktrees/rebrand-p01` (branch `rebrand/p01-spike`, never merged). Raw data: `spike/results/` in that worktree.

## Result

The route the plan designed (skills that run a bash `office` launcher) fails the gate: Gemma 4 E4B completes 3 of 20 runs. The doc's first fallback, office jobs as typed extension tools with no bash, passes it: E4B completes 17 of 20 runs, typed and starter-card requests both working. GO depends on two user decisions (the Office route change and the `office_*` approval tier) and on the six human file checks below.

## Setup

- Sidecar: `resources/omp.linux-x64`, `omp/18.4.8`; the monorepo source at `/home/tung491/WORK/oh-my-pi/packages/coding-agent` is the same version.
- Models: `hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf` (6.1 GB) and `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf` (4.3 GB). The 26B model is not installed, so its optional run was skipped. Thinking is off for both: the hf.co QAT imports report no `thinking` capability.
- `BUN_BE_BUN=1`: a `Bun.build` bundle with docx, exceljs, pptxgenjs and marked runs inside the compiled sidecar with only `/usr/bin:/bin` on `PATH` and writes a valid `.docx`. Under v2b the same libraries run in-process inside the extension module, so no launcher is needed.

## Load check (Task 1.4)

Passes for every variant (`spike/results/loadcheck.v1.json`, `.v2a.json`, `.v2b.json`). Exactly the variant's tool list, the four skills `word-report`, `spreadsheet-cleanup`, `slides-from-report` and `sai-os-helpdesk`, the custom system prompt in place, and every `config.yml` key reading back with the pack's value from the overlay layer.

Four corrections were needed against the plan as written:

| Finding | Evidence | Fix |
|---|---|---|
| `find` in `--tools` stops the sidecar with exit 2 | `Error: Built-in tool unavailable in this session: find.`; in 18.4.8 `find` is a semantic search (`tools/jfind/index.ts:46-58`) | Use `glob`, the file finder (`tools/glob.ts:87-89`) |
| `bash.direnv: false` is silently replaced by `auto` | the setting is `auto \| off` (`exec/settings.ts:153-157`); invalid values only log a warning (`config/registry.ts:651-662`) | `direnv: off`; the readback check is value plus provenance, not stderr |
| Extension tools default to deferred loading | `extensibility/extensions/types.ts:681` | `loadMode: "essential"` on every pack tool |
| `get_skills` reports skills with every source on | it re-runs discovery | read skills from `get_available_commands` and the `<skills>` block of the system prompt |

## Helpers (user decision during the spike)

omp runs helper sessions headless (`task/executor.ts:4071`). Inside a helper, `ask` does not exist (`tools/ask.ts:581`) and every `prompt`-policy tool throws (`extensibility/extensions/wrapper.ts:374-389`). Gemma also filled the task tool's eval `tools` field, so the spawn failed with `Unknown eval tool(s)`. The user chose to remove helpers from v1: no `task` tool, no agent files, and the helpdesk flow becomes the main-session skill `sai-os-helpdesk` (plan.md Decisions, "Helpers"). Because of this, `wait` is not needed, and the report-plus-slides scenario now runs both skills in one session.

## Containment (Task 1.4b)

Measured with E4B on the v1 pack (`spike/results/containment.json`, table below) and again on the v2b pack (`containment.v2b.json`): all six rows read `as expected` on both.

| # | Check | Verdict | Observed |
|---|---|---|---|
| 1 | Helpers | as expected | `task` not loaded; a helper request made no task call and started no helper |
| 2 | Discovery | as expected | planted `.omp/extensions` tool absent; live `word-report` is the pack's; the control run without pack flags loads both planted files |
| 3 | Shell | as expected | `office …` ran without an approval prompt; `ls` was denied without running; with `HOME=<temp>` and a `.profile` marker, the marker was never written |
| 4 | URL read | as expected | `URL reads are disabled by settings.` |
| 5 | User policy | as expected | a user config with `write: allow` still produced one approval prompt for one write |
| 6 | Chat resume | as expected | a chat-stamped session resumed with the pack flags refuses to start (`Unknown tools in --tools: diagnose, system_status, open_item, os_setting`); the same resume of a session created without `--chat` loads every pack tool |

Row 6 confirms that Phase 6 must refuse chat-stamped sessions before spawning. On v2b, check 3 becomes: `bash` is absent from the active tools; a request to run `ls` starts no shell; and `office_report` with the name `../../escape` writes `....escape.docx` inside Documents > Sai ATLAS and nothing outside it. Check 5 also holds for the office tools: a user config with `office_report: allow` still produced one approval prompt.

Two items for Phase 4, both found in the spike code (they fail safe, but must not ship as written):

- Path containment must compare the first path segment against `..`, not test `startsWith("..")`.
- `documentsDir()` must fall back to `~/Documents` when `xdg-user-dir DOCUMENTS` prints the home directory.

## Suite (Task 1.5)

There were 20 runs per model and variant: ten scenarios, typed and starter-card forms, with the report-plus-slides scenario typed twice. Each run started a fresh sidecar, auto-approved every approval request and stopped after 10 minutes. A run passes when (a) the expected new files appear in Documents > Sai ATLAS and the tool reports its JSON result; (b) every input path is the run's own fixture or a draft written in the same run; and (c) every output contains a marker string from its own fixture. Rules (b) and (c) were added after the first round: the shared drafts folder let two v1 runs convert a draft left by an earlier run, so the harness now empties it before every run.

| Variant | Model | Typed | Report + slides | Starter | Total | Approvals per run | Mean time to first token |
|---|---|---|---|---|---|---|---|
| v1: skills + bash `office` launcher (plan design, re-scored) | E4B | 0/9 | 0/2 | 3/9 | **3/20** | 3.5 | 15.6 s |
| v1 (re-scored) | E2B | 0/9 | 0/2 | 4/9 | **4/20** | 3.1 | 10.4 s |
| v2a: v1 with wording fixed (control) | E4B | 0/9 | 0/2 | 8/9 | **8/20** | 0.3 | 8.1 s |
| v2b: typed `office_report` / `office_slides` / `office_clean` tools, no bash | E4B | 7/9 | 1/2 | 9/9 | **17/20** | 1.1 | 3.1 s |
| v2b | E2B | 5/9 | 1/2 | 9/9 | **15/20** | 1.1 | 2.8 s |

Before re-scoring, v1 scored 4/20 (E4B) and 5/20 (E2B). The v2a fixes were: open a skill with `read skill://<name>`; fixed draft names; no example paths; an optional `--title`; and `temperature: 0.2`. v2b keeps the same scenarios, prompts and pass rule.

- **Why v1 fails:** on a typed request the model never opens a skill: it claims success, or loops on read and write (up to 34 approvals and a timeout). In starter runs it prints the `office` command as text instead of calling bash, copies the skill's example path, or runs the command on a different draft. Wording fixes help starter runs only (8/9) and leave typed requests at 0/9.
- **Why v2b works:** the model's long structured arguments were reliable throughout (every `write` with a full Markdown body succeeded). Typed tools remove the step that failed (composing a quoted shell command), and the tool schema itself tells a typed request what to do.
- **v2b failures** (3 on E4B, 5 on E2B) are all typed requests where the model skipped `read` and sent placeholder Markdown ("Report Title", "Point 1"), or once sent the file path as `markdown`. The derivation check caught every one. For Phase 4: reject a `markdown` value that is only a path, and say "read the file first" in the tool descriptions.

### Input tokens

Real prompt size is `input + cacheRead`, because Ollama serves the cached prefix. A first message costs 7,190 tokens without the pack flags, 2,709 with the v1 pack and 3,155 with the v2b pack (the three tool schemas add about 450). The context window is 16,384.

### Draft approvals

v1 asked for an average of 3.5 approvals per run, mostly draft `write` calls, and the failing runs looped on them. v2b asks once per job, for the `office_*` call itself; the Markdown travels as a tool argument, so there is no draft file and no draft approval.

## Human checks (Task 1.6)

Files: `/home/tung491/WORK/worktrees/rebrand-p01/spike/results/human-check/`. All three are Vietnamese v2b E4B outputs, and all three convert to PDF in LibreOffice without errors.

| File | App | Opens without repair | Vietnamese accents render |
|---|---|---|---|
| `Biên bản họp phòng kinh doanh.docx` | WPS on SAI OS | yes | yes |
| `messy (cleaned).xlsx` | WPS on SAI OS | yes | yes |
| `Báo cáo kinh doanh quý 3 năm 2026.pptx` | WPS on SAI OS | yes | yes |
| `Biên bản họp phòng kinh doanh.docx` | Microsoft Office | yes | yes |
| `messy (cleaned).xlsx` | Microsoft Office | yes | yes |
| `Báo cáo kinh doanh quý 3 năm 2026.pptx` | Microsoft Office | yes | yes |

## Gate (Task 1.7)

- **v1 route as planned:** NO-GO, E4B 3/20.
- **v2b route:** E4B 17/20, which meets the 16/20 bar. GO if the six human checks say yes and the user accepts the route change.

If the route changes, these plan contracts change with it:

- **Decisions:** the `Office route` row becomes typed extension tools, with no bash tool and no launcher.
- **Outcome bullet:** "the bash tool runs nothing but the read-only `office` launcher" becomes "no bash tool; office jobs are typed tools".
- **Phase 4:**
  - Pack layout: `bin/office` and `office/office.js` go; `src/office/cli.ts` tests become tool tests.
  - Task 4.6 adds the three tools, with `loadMode: "essential"` on all seven.
  - Task 4.7 overlay adds `temperature: 0.2`, `direnv: off` and `tools.approval.office_*`; the `bash.*` keys become inert.
  - Skills call the tools.
  - The system prompt opens skills with `read skill://<name>`.
- **Phase 6:** `<TOOLS>` becomes `read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean`. `PATH`, `PI_BASH_NO_LOGIN` and the launcher env stop being load-bearing. The check reads values plus provenance.
- **Phase 8:** the output card reads `office_*` tool results instead of parsing bash output.
- **Phases 2 and 3:** the tool-renderer list follows.

Plan deltas that apply on either route: `glob` instead of `find`; `bash.direnv: off`; `loadMode: "essential"`; the settings readback checks value and provenance; helpers removed (already decided).

## User decisions at the gate (2026-10-05)

- Office route: typed office tools (v2b), no bash tool and no launcher.
- `office_*` approval: `prompt`, one approval per job.

## Gate decision

GO on the typed office tools route (v2b): Gemma 4 E4B 17/20 (bar 16/20) and all six human checks "yes" with Vietnamese accents rendering. Confirmed by the user on 2026-10-06.

## SAI OS commands

Status: **confirmed on 2026-10-06** on the user's laptop (Ubuntu 26.04.1 LTS, GNOME Shell 50.1, Wayland). SAI OS targets Ubuntu GNOME only (user decision, 2026-10-06), which replaced the earlier proposal for Cinnamon on LMDE 7. The commands below are the ones in `assistant-pack/src/tools/os-commands.ts` after the Ubuntu GNOME port (merged at 5b8908c). They are checked by `plans/261005-0812-everyday-work-rebrand/tools/sai-os-check.sh`.

| `os_setting` | argv |
|---|---|
| `dark_mode` true / false | `gsettings set org.gnome.desktop.interface color-scheme prefer-dark` / `default` |
| `night_light` true / false | `gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled true` / `false` |
| `do_not_disturb` true / false | `gsettings set org.gnome.desktop.notifications show-banners false` / `true` |
| `volume` 0–100 | `wpctl set-volume @DEFAULT_AUDIO_SINK@ <n>%` |
| `text_size` 1.0–2.0 | `gsettings set org.gnome.desktop.interface text-scaling-factor <x>` |

`open_item` settings panels, each opened as `gnome-control-center <panel>`: `network`, `wifi`, `bluetooth`, `display`, `sound`, `printers`, `power`, `keyboard`, `notifications`, `background` (the Appearance page). Apps: `net.nokyan.Resources` as the system monitor, falling back to `gnome-system-monitor`, and `update-manager` for updates.

Result:

- **Part 1 (automatic, no changes):** every settings key was written back unchanged, and every read-only `diagnose` command exited cleanly. All ten panels appear in `gnome-control-center --list`, and the system monitor and `update-manager` launchers are installed. In the last run this was 42 OK lines and no FAIL.
- **Part 2 (the user watched the screen):** dark mode, night light, text size, volume and nine of the ten Settings pages passed on the first run. Do Not Disturb and the Printers page failed on that run, and both passed on the recheck (`--recheck`).
- **Why the first run failed:** both failures were caused by the check script's timing, not by the commands.
  - *Do Not Disturb.* The script sent its test notification right after turning the setting off. GNOME Shell hides non-critical banners whenever `show-banners` is false (`messageTray.js`, `_onNotificationRequestBanner`), but the new value had not reached the Shell yet. The script now waits 2 seconds first. The assistant does not hit this race, because it changes the setting long before any later notification arrives.
  - *Printers.* The page asks the print service before it appears, which took longer than the script's 3-second wait. The script now waits 6 seconds per page. The same command also opens the Printers page on the virtual display.

No change to the pack's commands was needed.
