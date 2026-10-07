# Release readiness: Sai ATLAS everyday-work rebrand (steps 1, 2, 2b, 3)

Date: 2026-10-07. Worktree `/home/tung491/WORK/worktrees/rebrand-integration`, branch `rebrand/everyday-work`. Started at HEAD `98e1c8b` and ended at `88ea3cd` (one fix commit). Step 4 (sidecar rebuild, version bump, tag, publish) was not done; it is the user's.

**Outcome:** steps 1, 2 and 3 pass. Step 2b found a real bug and I fixed it in `clean.ts` (commit `88ea3cd`): a LibreOffice conversion past its timeout used to hang the tool call forever. Now the tool reports the timeout after 60 s and no LibreOffice process is left running. The Verify line for 2b is still **not met as written**. `pgrep -af soffice.bin` lists one zombie (`<defunct>`), which the Tauri supervisor holds until the app quits. The fix for that belongs in `src-tauri/src/omp/supervisor.rs`, which is outside this task's files, so it is handed to the user (see the open questions at the end).

## Artifacts

| Item | Value |
|---|---|
| Final deb (built from `88ea3cd`) | `src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/Sai ATLAS_0.9.16_amd64.deb` |
| Final deb sha256 | `0055c3c52de4833c2cd5f50cfd2a1bcb72dbc0ea969e8759e80a51b3c8abcade` |
| First deb (built from `98e1c8b`) sha256 | `d58b1c7617cf9e89bf27e149a475769bff6f76c76840b874ace06136fec9d08f` |
| Packaged `/usr/lib/Sai ATLAS/omp` sha256 (both debs) | `573cf7518b3b601e5f066762beeb52c0603b42676522f4ae87a933e9bfa1edf7`, equal to `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64` |
| Model picked by "Get started" | `ollama/hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:latest` |
| `SAI_ATLAS_UPDATE_BASE` during builds | unset |
| `resources/omp.linux-x64` after both builds | symlink restored to `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64` |

Before the e2e runs I rebuilt `out/` (`bun run build`) and the Tauri debug binary (`cargo tauri build --debug --features e2e-hooks --no-bundle`), because both were older than HEAD.

## Checks

| Step | Command | Exit | Result |
|---|---|---|---|
| 1 | `scripts/virtual-display.sh run -- env HOME=<tmp> bunx playwright test` (run 1) | 1 | 32 passed, 1 failed, 9 skipped. `e2e/auto-follow.e2e.ts:125` expected `jumpOffered()` to be false and got true. |
| 1 | same, `e2e/auto-follow.e2e.ts` only, 3 times | 0 ×3 | 1 passed each time |
| 1 | same, full suite (run 2) | 0 | 33 passed, 9 skipped |
| 1 | `scripts/virtual-display.sh run -- env CARGO_HOME=… RUSTUP_HOME=… CARGO_HOME_BIN=… HOME=<tmp> bun run test:e2e:tauri` | 0 | 9/9 spec files passed |
| 1 | `bash scripts/tauri-deb-smoke.sh <deb>` (first deb / final deb) | 0 / 0 | 8 passing / 8 passing |
| 1 | `OMP_E2E_FAKE_MIC=1 bash scripts/tauri-deb-smoke.sh <deb>` (first / final) | 0 / 0 | 3 passing / 3 passing |
| 1 | `bash scripts/tauri-wm-geometry-check.sh <deb>` (first / final) | 0 / 0 | geometry check passed |
| 2 | `bash plans/261005-0812-everyday-work-rebrand/tools/offline-check.sh` (first deb / final deb) | 0 / 0 | one `.docx`, one `.xlsx` and one `.pptx` saved; the `bash` grep prints nothing |
| 2b | same run, LibreOffice timeout check, first deb | n/a | **Survivor and hang.** The tool never reported within 5 minutes of `soffice.bin` being stopped. `oosplash` was still alive and `soffice.bin` was a zombie under it. |
| 2b | same run, final deb (after `88ea3cd`) | n/a | The tool reported the timeout after 60.2 s. 5 s later `pgrep -af soffice.bin` printed `636 [soffice.bin] <defunct>` (PPID 401 = `sai-atlas --omp-supervise`). **Verify not met as written.** |
| 3 | `rg -n -i "coding agent" README.md README.vi.md site package.json src-tauri/tauri.linux.conf.json src/renderer/locales` | 1 | printed nothing (pass) |
| after the fix | `bunx vitest run` | 0 | 209 files passed (1 skipped); 2122 tests passed (5 skipped) |
| after the fix | `bun run check:types`; `bunx biome check` on the two touched files | 0 / 0 | clean |

**About `auto-follow.e2e.ts:125`.** The step sends 60 wheel events back to back and then samples `jumpOffered()` once, without waiting for the scroll to land. It is a timing race under load, not a rebrand regression: the spec passed alone three times and the next full run was green. I did not change it, because it is outside this task's e2e allowance. The fix would be to poll the value (`expect.poll(jumpOffered).toBe(false)`), the same way line 64 was fixed earlier.

## Step 2: offline file creation

Harness: `plans/261005-0812-everyday-work-rebrand/tools/offline-check.sh` and `tools/offline-check/`. It is a copy of the egress harness's install step, launcher, WebDriver helpers and starter-card driving, with the strace and seeding removed. The egress harness itself is unchanged.

**How "network off except Ollama" is enforced:**
- The app container runs with `--network none`, so its only interface is `lo`.
- A relay container on host networking runs `socat UNIX-LISTEN:/relay/ollama.sock → TCP:127.0.0.1:11434`. Inside the app container, a second `socat` maps `127.0.0.1:11434` to that socket.
- No firewall rule or long-lived process was added on the host, and both containers are removed when the run ends.
- An iptables rule inside a host-network container would have edited the host's own netfilter tables, so I did not use that route.

Recorded in `network.txt`: only `lo`, no route; 1.1.1.1:443, 8.8.8.8:53 and 140.82.112.3:443 refused or unreachable; no DNS answer for github.com; Ollama listed its 4 models through the relay.

`ls -la "<container home>/Documents/Sai ATLAS"`, final deb (`plans/reports/offline-check-261007-after-fix/step2-listing.txt`):

```
-rw-r--r-- 1 ubuntu ubuntu 74511 Oct  7 04:22 Office move project update.pptx
-rw-r--r-- 1 ubuntu ubuntu 10025 Oct  7 04:22 Team meeting, 3 October.docx
-rw-r--r-- 1 ubuntu ubuntu  7834 Oct  7 04:22 store-sales (cleaned).xlsx
```

`grep -rlE '"name": ?"bash"' ~/.omp/agent/sessions` printed nothing (exit 1) in both runs.

- **"run ls":** the model answered with `glob` ("There are no files in the current directory"), and no shell ran. The sidecar's command line shows the session's tool list: `--tools read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean`, with no `bash`.
- **Get started:** the welcome screen did not open on its own, because Ollama already lists models. The harness opened it through Ollama › Run setup again, as the egress audit did.

## Step 2b: LibreOffice timeout survival

**Method:**
- The harness generates a 60,000-row `.xls` (4.3 MB) and runs it through the "Clean up a spreadsheet" card.
- A watcher sends SIGSTOP to `soffice.bin` within 50 ms of it appearing. It then waits for the `office_clean` tool result in the session file, sleeps 5 s and runs `pgrep -af soffice.bin`.

**Before the fix.** The tool never returned. `oosplash` (the direct child) stayed alive and `soffice.bin` was a zombie under it. I reproduced the cause in isolation in the same image: Bun 1.4.2's `execFile(…, { timeout })` never calls back once LibreOffice's launcher has been signalled, while Node's does. The bundled sidecar runs on Bun, so the tool call hung for good.

**Was the group-kill change needed?** Yes. Commit `88ea3cd` (`fix(pack): kill LibreOffice's whole process group on timeout and stop`) touches `assistant-pack/src/office/clean.ts` and `assistant-pack/test/clean.test.ts`:
- The new `runInGroup` spawns LibreOffice `detached` with stdio ignored. On timeout or abort it sends `SIGKILL` to `-pid` and settles on `exit`.
- The stop signal is passed through, so a stop is reported as a stop rather than as "save as .xlsx".
- Tests use a real `sh` + `sleep` grandchild. They prove the group kill is sent (`[-pid, "SIGKILL"]`) on both timeout and abort and that the grandchild dies. Plain success and failure exits and ENOENT (which the `libreoffice` fallback relies on) are still handled.
- Mutating the code to `kill(pid)` makes both group-kill tests fail.

**After the fix.** The tool reports the timeout after 60.2 s and no live LibreOffice process remains. One zombie remains:
- When the group is killed, `oosplash` dies before it can reap `soffice.bin`, so the kernel hands the zombie to the nearest subreaper, the supervisor (`supervisor.rs:95`).
- The supervisor reaps only in `sweep_orphans()`, which runs when omp exits or on shutdown.
- So every orphan that dies during a session stays a zombie until the app quits. That costs one pid slot each and is Linux only.
- Nothing in `clean.ts` can reap a process that is not its own child.

Following the phase's Failure Protocol, I consulted kongming. Its advice: keep `88ea3cd`, do not add a second mechanism in `clean.ts`, do not weaken the Verify line, and hand the supervisor fix to the user.

Evidence directories: `plans/reports/offline-check-261007/` (first deb) and `plans/reports/offline-check-261007-after-fix/` (final deb). Each contains `timeline.tsv`, `2b-stopped.txt`, `2b-pgrep.txt`, `network.txt`, `screens/`, and `container-state/` with the sessions and app logs.

## Fixed

- `88ea3cd` fix(pack): kill LibreOffice's whole process group on timeout and stop.
- No wording fix was needed for step 3.

## Cleanup

- The virtual display was stopped.
- No containers remain. The `sai-atlas-offline-check` image, the relay socket directories and the throwaway homes were removed. The `sai-atlas-tauri-deb-smoke` image existed before this work and was kept.
- No process I started is still running.
- Disk: 62 GB free on `/`.

## Unresolved questions

1. **Supervisor reaping.** Do you want the supervisor to reap non-omp zombie children during a session? The proposal is a `SIGCHLD` arm in `supervise()` that runs `waitpid(Some(pid), WNOHANG)` only on children that are zombies and are not omp, plus one Rust test, with a check that test parity is kept. It is outside this phase's allowed files. Until it lands, the 2b Verify line cannot print nothing on Linux. The alternative is to accept "no live process; one zombie until quit" for this release.
2. **Electron e2e flake.** Should `e2e/auto-follow.e2e.ts:125` poll `jumpOffered()` instead of sampling it once? It failed once in two full Electron runs.
3. **Re-running e2e on the final commit.** The two e2e suites ran at `98e1c8b`. The only later change is the converter runner in the assistant pack. The `real-core` specs do load the real sidecar and the built pack, but no e2e spec runs a spreadsheet clean-up, so the changed code is not exercised there; it is covered by vitest and by the step 2b run on the final deb. The deb checks and the full vitest suite were re-run on the final build. Say if you want the e2e suites repeated on `88ea3cd` anyway.

## Follow-up by the orchestrator (2026-10-07 13:38)

The supervisor fix landed as `89a610d` "fix(shell): reap orphaned tool processes while the sidecar runs": it reaps each orphan on `SIGCHLD` while omp runs, peeking with `waitid(WNOWAIT)` so omp's own status still reaches `child.wait()`. The new Rust test `an_orphan_that_exits_is_reaped_while_omp_runs` fails with the reaper disabled (the orphan stays in state `Z`) and passes with it; clippy, 770 Rust tests (three runs), parity and API snapshots pass.

Re-run of steps 2 and 2b on a deb built from `89a610d` (sha256 `222fd01d51c5293191a160e2dc13dca58337ad65651ca91051cac2dfcd7be550`), evidence in `plans/reports/offline-check-261007-reaper/`: the three files were created offline, the `bash` grep prints nothing, the tool reported the timeout after 60.1 s, and 5 s later `pgrep -af soffice.bin` printed nothing (exit 1), with no zombie under the supervisor. **The step 2b Verify line is met.** Open question 1 is resolved by that commit; question 2 (`auto-follow.e2e.ts:125`) is a follow-up in `plan.md`.

## Gate at the final head (2026-10-07)

On `89a610d`, gate steps 1–4 and 6–14 exit 0: bun install, sidecar link, build:pack, check:types, build, biome changed, biome pack, pack load check, Tauri renderer, clippy and cargo test (770), parity, snapshots, keep list. The clean-clone CI check also exits 0.

Step 5 (vitest) failed once at `assistant-pack/test/clean.test.ts` "kills the whole process group when the clean-up is stopped", with `ENOENT /proc/<pid>/stat`. That was a race in the test's `gone()` helper, fixed in `9f3503a`. On `9f3503a`: the test passed 10 of 10 runs, and the full vitest suite gave 2122 passed, 5 skipped, 0 failed. `4614f24` changes only documentation and a test comment.

## Vietnamese pass

Date: 2026-10-07. Deb `222fd01d51c5293191a160e2dc13dca58337ad65651ca91051cac2dfcd7be550` (built from `89a610d`), used as is with no rebuild. Model picked by "Bắt đầu": `ollama/hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:latest`. Evidence is in `plans/reports/offline-check-261007-vi/`: `timeline.tsv`, and for every step `screens/<step>.png` with its visible text (body text plus every visible title, aria-label and placeholder) in `texts/<step>.txt`.

**Outcome:** every criterion item works in Vietnamese. All three jobs saved their files, and all 7 checks passed (exit 0). One fix was committed: `ad51706` `fix(i18n): stop adding an English plural suffix to Vietnamese counts`. Some English is still visible: raw tool and skill names, the office output-card summaries, the `(cleaned)` file-name suffix, "Agent" in several vi strings, and `<html lang="en">`. None of these has an obvious locale-only fix, so they are listed for a decision below.

**How it ran.** `bash tools/offline-check.sh --lang vi`, in the same offline container as before (`--network none`; Ollama only, through the relay).
- The app was set to Vietnamese through its settings file. Both the Rust shell (`src-tauri/src/i18n.rs:181`, which passes `SAI_ATLAS_LANG` to the sidecar at spawn) and the renderer (`src/renderer/lib/i18n.tsx`) read `<appData>/@oh-my-pi/omp-gui/prefs.json`, key `language`. The entrypoint seeds `{"language":"vi"}` there before the first launch, which is the state a user has after switching once and relaunching.
- The inputs were Vietnamese: notes, a CSV with decimal commas, and a project update.
- Without `--lang`, the run is the English check, unchanged. The vi pass has its own spec (`offline-check/offline-vi.e2e.ts`) and helpers (`offline-check/offline-helpers.ts`), which read every label from the app's locale files by key.

| Check | Result | Visible text (excerpt) | Evidence |
|---|---|---|---|
| Welcome / Get started | pass | "Thiết lập trợ lý cục bộ của bạn … Ollama đang chạy (4 mô hình) … Dùng mô hình này … Thiết lập sau · Bắt đầu" (opened through "Chạy lại thiết lập", because Ollama already lists models) | `welcome.png`, `ollama-window.png` |
| Starter cards | pass | "Biến ghi chú thành báo cáo Word", "Dọn dẹp bảng tính và thêm tổng", "Tạo slide từ báo cáo", "Trợ giúp máy tính" | `empty-state.png` |
| Attach button | pass | aria-label and title both "Đính kèm tệp" | `attach-hover.png` |
| Word report job | pass | Saved `Báo cáo cuộc họp ngày 3 tháng 10.docx` | `word-report-output.png` |
| Spreadsheet job | pass | Saved `doanh-so-cua-hang (cleaned).xlsx`. The comma decimals were converted ("10 numbers converted"), which shows the sidecar got `vi`. | `spreadsheet-cleanup-output.png` |
| Slides job | pass | Saved `Cập nhật dự án chuyển văn phòng.pptx` | `slide-deck-output.png` |
| Approval prompt (all three jobs) | pass, with English | Title "Phê duyệt công cụ"; sentence "Sai ATLAS muốn tạo báo cáo Word. Cho phép không?" (and "…tạo bản sao đã dọn dẹp của bảng tính", "…tạo bộ slide"); buttons "Từ chối / Phê duyệt"; tier "ghi". English: raw tool name `office_report`, and the hint "**Agent** sẽ đợi cho đến khi bạn quyết định." | `*-dialog.png` |
| Output card | pass, with English | Buttons "Mở" and "Mở thư mục"; the step row reads "Đã hoàn thành 1 bước". English: the header shows the tool name `office_clean`, and the summary line is English ("1 sheet, 7 rows kept, …", "1 heading, 0 tables, 5 list items", "5 slides (1 title slide, …)"). | `*-output.png` |
| Helpdesk card and one question | pass | Card turn: "Máy tính của bạn đang gặp vấn đề gì vậy? …". Question about Wi-Fi: the answer was Vietnamese and offered to open the Wi-Fi settings. UI: "Đã hoàn thành 3 bước". English: process row `system_status · ask · diagnose` and skill id `KỸ NĂNG sai-os-helpdesk`. | `helpdesk-card.png`, `helpdesk-answer.png` |
| Runtime language switch | note | Clicking the sidebar EN/VI switcher re-renders the UI, but the sidecar is not restarted (same pid 369 before and after). | `switched-away.png`, `switched-back.png` |

Final listing of `~/Documents/Sai ATLAS`: `Báo cáo cuộc họp ngày 3 tháng 10.docx`, `doanh-so-cua-hang (cleaned).xlsx`, `Cập nhật dự án chuyển văn phòng.pptx`.

### English found in the vi UI

| # | What shows | Where it comes from | Action |
|---|---|---|---|
| 1 | "7 bướcs", "22 dòngs", "3 bướcs" | 23 vi values carried `{plural}`, which callers fill with "s"/"es" (`chat.process.steps`, `chat.custom.skillLines`, `tools.*`, `modelPicker.count`, …) | **Fixed in `ad51706`.** The vi values drop the placeholder (the locale test already allows vi to drop placeholders), and a new test in `locales.test.ts` blocks a `{plural}` glued to a word. Full vitest (2123 tests), `check:types` and biome pass. A mutation check showed the test fails on the old `vi.ts`. `dag.unresolved` uses `{plural}` as a noun and was left alone. |
| 2 | "Agent sẽ đợi cho đến khi bạn quyết định." (approval hint), "Thẻ Agent Mới" / "Thẻ agent mới (Ctrl+T)" (new-tab aria-label and title), and about 30 more vi values containing "agent" | `approval.waiting`, `tabs.new.agent`, `tabs.new.agentHint`, `input.agentConnecting`, `cmd.*`, … | Not fixed. The English values say "agent" too ("The agent waits until you decide."), so this is a copy decision for both locales (for example "trợ lý"), not a missing translation. |
| 3 | Raw tool names `office_report` / `office_clean` / `office_slides` in the approval dialog and the output-card header; `read`, `system_status · ask · diagnose` in step rows | The approval and tool renderers print the tool id. The same happens in English. | Not fixed: this is a renderer change, not a string. It matters most in the approval dialog, which the criterion wants in plain language. Its sentence is plain Vietnamese, but the id line under it is not. |
| 4 | Output-card summaries "1 sheet, 7 rows kept, …", "1 heading, 0 tables, 5 list items", "5 slides (1 title slide, 1 section divider, 3 bullet slides)" | The pack's English `check` strings (`assistant-pack/src/office/clean.ts:542` and the report and slides builders), which the card shows via `OfficeFileRenderer.tsx:91`. They do not follow `SAI_ATLAS_LANG`. | Not fixed: needs localized pack summaries. |
| 5 | File name suffix `(cleaned)` in `doanh-so-cua-hang (cleaned).xlsx` | `assistant-pack/src/tools/office-tools.ts:222` | Not fixed: the name is a product decision, and existing tests may assert it. |
| 6 | Skill header "KỸ NĂNG sai-os-helpdesk" / "spreadsheet-cleanup" with the skill's file path | The skill renderer shows the skill id and path. | Note. |
| 7 | Tab subtitle "work" ("Chưa có tiêu đề — work") | The working-folder name `~/.omp/work` | Note. |
| 8 | `title: … chế độ điều hướng "one-at-a-time"` | A raw mode value interpolated into a vi tooltip | Note; minor. |
| 9 | `<html lang="en">` while the UI is Vietnamese | The document language is not set from the UI language. | Not visible, but screen readers and hyphenation will read the page as English. Not fixed: this is a code change. |

### Notes on the model's Vietnamese (not fixes)

- Replies were Vietnamese and on task.
- The helpdesk answer wrote "Cài đặt (Settings)", with an English gloss in brackets.
- The slides tool-call intent was written in English ("Create slide deck from report"); this is the model's own text.

### Cleanup

The container, relay and image were removed, and no harness process remains. The virtual display was not used.

### Open questions (Vietnamese pass)

1. **Wording of "agent".** Should "agent" become "assistant" / "trợ lý" in user-facing strings in both locales (item 2)?
2. **Approval dialog id line.** Should the approval dialog hide the raw tool id for pack tools (item 3), so the prompt is only the plain-language sentence?
3. **Pack language.** Should the pack's output-card summaries and the `(cleaned)` suffix follow `SAI_ATLAS_LANG` (items 4–5)?
4. **Runtime switch.** A runtime language switch does not restart the sidecar, so the pack keeps the language it started with (decimal mark, sheet names) until the next launch. Restart it on a switch, or accept this?

## Final build (2026-10-07 14:25)

Integration head `c610616` merges the plain office approvals and language note (`rebrand/ui-lang`) and the pack text that follows the app language (`rebrand/pack-lang`).

- **Gate:** every step and the clean-clone CI check exit 0; vitest gave 2158 passed, 5 skipped.
- **Deb:** sha256 `550c4ca6cb230f5940b570a86e7c087e772d76241e7be2bc0f4b0dbba325827a`, built with `SAI_ATLAS_UPDATE_BASE` unset. The sidecar is unchanged (`573cf751…`).
- **English offline check** (`offline-check-261007-final-en/`): three files were made, `run ls` started no shell, and the LibreOffice timeout left no survivor (`pgrep` exit 1).
- **Vietnamese pass** (`offline-check-261007-final-vi/`): welcome, attach button, the three starter cards, help desk card and question all passed.
  - Saved files: `Họp nhóm ngày 3 tháng 10.docx`, `doanh-so-cua-hang (đã làm sạch).xlsx` and `Cập nhật dự án chuyển văn phòng.pptx`.
  - Approvals show only the plain sentence, and no `office_*` id appears.
  - Output summaries are in Vietnamese ("1 trang tính, giữ 7 dòng…", "5 trang chiếu (1 trang tiêu đề…)").
  - The sidecar pid did not change across a language switch, as intended.
