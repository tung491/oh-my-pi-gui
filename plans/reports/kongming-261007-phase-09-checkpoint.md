# Kongming counsel: Phase 9 handover checkpoint

- Date: 2026-10-07 (Asia/Seoul). Advisory only; nothing edited outside this report.
- Inputs: `plan.md` (acceptance criteria, Decisions, Follow-ups), `phase-09-copy-and-release.md` (Tasks 9.6, 9.7), `egress-audit-261005-everyday-work-rebrand.md`, `tester-261007-release-readiness.md`, `kongming-261006-wave-c-fixed-checkpoint.md`; code at `/home/tung491/WORK/worktrees/rebrand-integration` HEAD `89a610d` (branch `rebrand/everyday-work`, clean tree, `main` is an ancestor); the six commits since the egress audit.
- Runtime: Claude Fable 5.1.

## TL;DR

Hand it over. No blocker in the code or the evidence; `89a610d` is correct. Three things to settle first, all small: (1) record the full-gate exit codes on `89a610d` (the acceptance criterion "full gates green" is evidenced at `f45e3f4`, not at HEAD; I re-ran the supervisor tests, the three narrow vitest files and the twins check at HEAD, all green); (2) fix one public claim: the `.deb`'s Ollama drop-in is not "picked up the next time Ollama starts" but after the next `systemctl daemon-reload` or reboot, because the package ships no maintainer script by design and dpkg's systemd triggers do not cover `/usr/lib/systemd/system`; (3) the "en and vi" criterion has no recorded run in Vietnamese, only string-level checks.

## Verdict per commit since the egress audit

| Commit | Verdict | Notes |
|---|---|---|
| `f45e3f4` Rust restart label | OK | One string in `src-tauri/src/i18n.rs`. |
| `8e24148` deb ships `/usr/lib/systemd/system/ollama.service.d/sai-atlas.conf` | OK, wording risk | Vendor drop-in dirs apply to a unit that lives in `/etc` (systemd merges `<unit>.d` from every unit path), and `scripts/tauri-packaging-config.test.ts:377-388` pins the content to the welcome-screen command's. But systemd only reads a new drop-in at `daemon-reload`; a plain `systemctl restart ollama` keeps the loaded unit. The deb has no `postinst` (asserted by `src-tauri/linux/finalize-deb.ts`, a user-accepted design), and the systemd package's own dpkg triggers are `catalog`, `binfmt.d`, `sysctl.d`, `libc-upgrade` only (`/var/lib/dpkg/info/systemd.triggers` on this host; Debian has shipped that list for years), so installing the deb reloads nothing. The welcome-screen path is fine: `src/shared/ollama-types.ts:36` runs `systemctl daemon-reload`. Removing the deb removes the drop-in, so Ollama's cloud features return at the next reload; consistent with the decision, worth one line in the README. |
| `7b3cb1b` hard-kill smoke without `!` | OK | The sidecar/supervisor survivor check stays; tool-child teardown is now covered only by the Rust supervisor tests, which is enough. |
| `98e1c8b` shortcuts dialog drops `!`/`$` rows | OK | Touches `HotkeysDialog.tsx`, outside Phase 9's ownership list; no test referenced the keys; vitest green afterwards. Process note only. |
| `88ea3cd` LibreOffice in its own group | OK | `runInGroup` (`assistant-pack/src/office/clean.ts:130-176`): `detached: true` gives LibreOffice its own group, `kill(-pid, SIGKILL)` on timeout and abort, `settled` guard, ENOENT still reaches the `libreoffice` fallback, a stop is reported as a stop (`throwIfStopped` at `:205`). Proven under the Bun sidecar in the deb (`offline-check-261007-reaper/2b-pgrep.txt`: nothing 5 s after the timeout). Side effect to know: LibreOffice is now outside omp's process group, so the supervisor's `killpg(omp)` no longer reaches it; on Linux the subreaper sweep (`supervisor.rs:244-258`) does. On macOS (Electron, no subreaper) a LibreOffice group whose sidecar died mid-conversion is not cleaned up by anyone; its own timer dies with the sidecar. Follow-up, not a release risk for Linux. |
| `89a610d` supervisor reaps orphans on SIGCHLD | OK | Detailed below. |

## `89a610d` scrutiny (`src-tauri/src/omp/supervisor.rs`)

- **WNOWAIT peek vs tokio's `child.wait()`.** Safe. `reap_orphans` (`:278-290`) peeks with `waitid(P_ALL, WEXITED|WNOHANG|WNOWAIT)` and only ever calls `waitpid(pid, WNOHANG)` for `pid != omp`. tokio 1.53.1 collects omp by its own pid (pidfd on Linux, else SIGCHLD plus `try_wait`), so omp's status cannot be stolen. The test asserts exactly that: omp SIGKILLed after the orphan is reaped, supervisor exits 137 (`:442-444`).
- **omp's zombie peeked while other orphan zombies are waitable.** The loop returns at `:286-287` and those zombies stay unreaped, but only until `child.wait()` resolves, which is immediate because omp is already a zombie; that `select!` arm runs `sweep_orphans()` → `reap()` (`:179`, `:251`, `:297-304`) and collects them before the supervisor exits. No leak, no spin.
- **Signal stream.** tokio allows several `Signal` registrations for one signal, so this listener coexists with tokio's process driver. Coalesced SIGCHLDs are fine because the loop drains until the peek returns nothing. The listener registers at the first poll of the `select!`, after `spawn`; a zombie that arrived before that is collected on the next SIGCHLD. An orphan that was already a zombie when it was reparented gets a fresh SIGCHLD from the kernel at reparent time, which is the `oosplash`→`soffice.bin` case; the reaper evidence confirms it. If the listener cannot be created the future parks forever and the shutdown sweep still runs (`:263-266`).
- **macOS cfg.** `reap_orphans` is a no-op outside Linux (`:293-294`); there is no subreaper there (`:95-103`), orphans go to launchd, and the supervisor is not shipped on macOS (Electron). The test module is `cfg(all(test, target_os = "linux"))` (`:334`), so CI's ubuntu job runs it; it needs `bash` and `/usr/bin/sleep`, both present on `ubuntu-latest`.
- **Hardening nit, not for this release.** `let _ = waitpid(pid, ...)` at `:284` ignores the result. If `waitpid` ever returned `Err` or `StillAlive` while the peek kept reporting the same pid, the loop would spin on the single-thread runtime and starve `child.wait()`. No kernel path I know produces that (waitid and waitpid use the same child filter), but one `return` on anything other than `Ok(Exited|Signaled)` would make it impossible. Follow-up.
- **Verified at HEAD:** `cargo test --all-features supervisor` → 9 passed, including `an_orphan_that_exits_is_reaped_while_omp_runs`; `bunx vitest run assistant-pack/test/clean.test.ts scripts/tauri-packaging-config.test.ts scripts/finalize-deb.test.ts` → 78 passed; `bun e2e-tauri/check-twins.ts` → 42 tests, every twin matches.

## Acceptance criteria in `plan.md` versus evidence

| Criterion | Evidence | Gap |
|---|---|---|
| Spike gate | Decisions "Spike gate result", `spike-261005-everyday-work-rebrand.md` | none |
| One lane, surfaces deleted | wave gates and absence greps in the wave reports | none |
| Spawn flags, env, twins, refusal of chat sessions | Wave B/C reports, pack check PASS | none |
| deb creates the three files offline, no bash, no helper | `offline-check-261007-reaper/step2-listing.txt`, `bash-grep.txt`; `--tools` list in the tester report | none |
| Starter cards, attach, output card, approvals, helpdesk **in en and vi** | locale parity test; reviewer read the strings (`code-reviewer-261006-wave-c.md:254`) | **No run in vi is recorded**: both e2e suites, the egress run and the offline check ran in English. Do one 5-minute pass on the installed deb or the virtual display with the language set to Vietnamese (starter cards, attach button, one office card through approval to the output card, one helpdesk card) and record it, or state in the handover that the criterion is met at string level only. |
| No "coding agent" copy; README en+vi, site, package descriptions, CHANGELOG; egress audit | `rg -i "coding agent" …` prints nothing at HEAD (re-run); egress audit pass | wording accuracy of the drop-in claim (below); `README.vi.md:85` describes only the welcome-screen drop-in and tells the user to `systemctl edit` by hand, while `README.md:85` describes the `.deb` drop-in; bring vi in line with en. |
| Full gates green on the integration branch | all green at `f45e3f4`; re-run on `89a610d` reported in progress, no process or log visible at 13:45 | record the exit codes of every Shared command on `89a610d` (or state that the gate ran and where) before the handover; my narrow runs above cover the files the last two commits touch. |

Also: every acceptance checkbox in `plan.md` is still `[ ]` and every phase row reads `Pending`. Update them with the evidence paths above before handing over; the plan is the user's map of what was proven.

## What to do before the handover

1. Finish (or locate) the full gate on `89a610d` and write its exit codes into the tester report's follow-up section.
2. Copy fix, within Phase 9's ownership, one commit `docs: say when the Ollama drop-in from the deb takes effect`: `CHANGELOG.md:8` "picks up the next time it starts" → "after the next restart of the computer, or `sudo systemctl daemon-reload && sudo systemctl restart ollama.service`"; same phrase at `README.md:85` (it already gives the command, so only the "next time it starts" clause changes); add the `.deb` sentence to `README.vi.md:85`; amend the Decisions row "Network after the egress audit" the same way. Leave the egress audit report as the stateful record it is.
3. Vietnamese pass as in the table, or an explicit statement of the gap.
4. Hand over with these notes for step 4 of Task 9.7:
   - Keep `resources/omp.linux-x64` sha256 `573cf751…` as the Linux release sidecar: it carries patches 0002–0004 (`--help` lists `--no-context-files`; pack check PASS), and it is the exact binary inside the audited deb `222fd01d…` and every smoke run. Rebuilding it produces a functionally identical binary but breaks the evidence chain and forces a new deb plus the three smoke runs. Rebuild only the two macOS sidecars from `/home/tung491/WORK/oh-my-pi/packages/gui` at the same monorepo commit; run `--help | grep -c -- --no-context-files` and `check-assistant-pack` on each as Task 9.7 says. If the user rebuilds Linux anyway, rebuild the deb and re-run `tauri-deb-smoke.sh`, the fake-mic run and `tauri-wm-geometry-check.sh` on it.
   - Four backups exist, not two: `resources/omp.linux-x64.pre-context-files`, `.pre-local-only`, `.pre-loopback`, `.pre-mcp` (1.2 GB). Delete all four after the rebuilt sidecars pass.
   - The main checkout's `resources/omp` is the 4 October unpatched binary; replace it only in step 4, as planned.
   - Version bump: `package.json` and `src-tauri/Cargo.toml` are both `0.9.16`; `scripts/release-feeds.ts:73` names the deb `sai-atlas_<version>_amd64.deb`, which matches the `0.9.17` the CHANGELOG and both READMEs already cite (`CHANGELOG.md:26`, `README.md:69`, `README.vi.md:69`); the macOS install links in both READMEs still point at `nornzach/oh-my-pi-gui` v0.9.10 (inherited from `main`), so the release-step link update should move them to the publishing repo.
   - Build with `SAI_ATLAS_UPDATE_BASE` unset (it was for every audited build), run `bun scripts/release-feeds.ts` after the finalize scripts, draft the release, publish only after every asset is up.

## What to avoid

- A `postinst` with `daemon-reload` to make the deb claim true: it reverses the no-maintainer-script design that `finalize-deb.ts` asserts and that the 0.9.x updater's `apt-get install -f` path relies on. Fix the sentence, not the package.
- A second reaping mechanism in `clean.ts` or a Linux-only `kill -pid` in the Electron shell for the macOS case: it is a follow-up, and the Linux release is covered by the subreaper.
- Rewriting the six commits (for the AI trailers): `main` carries the same trailers, so the branch is consistent with the repo's own history.

## Alternatives on the drop-in claim

- Accept the wording as is: cheap, but the privacy section is the one place the README must be exact, and `README.md:85` already contradicts itself by giving the manual command.
- Make the welcome screen write the `/etc` drop-in on every launch when `/usr/lib/.../sai-atlas.conf` exists and Ollama is running without `OLLAMA_NO_CLOUD`: real behaviour change with a password prompt at launch; out of scope for this release.

## Follow-ups to add to `plan.md`

- `supervisor.rs:284`: stop the loop on a non-`Exited`/`Signaled` `waitpid` result.
- macOS Electron: a LibreOffice group whose sidecar died is not cleaned up (no subreaper, timer lives in the sidecar).
- `patches/omp/0001`, `0002`, `0004` carry AI co-author trailers in their headers; harmless (`git apply`), drop on the next regeneration.

## Assumptions

- Ubuntu 24.04's `systemd.triggers` equals this 26.04 host's (no `/usr/lib/systemd/system` interest). Confidence high: Debian's systemd package has used that list since before bookworm, and it is why packages run `deb-systemd-helper` themselves. If a 24.04 container shows such a trigger, the claim is true and item 2 is moot.
- The orchestrator's full-gate re-run on `89a610d` will pass: medium-high; the two commits since `f45e3f4` with code touch only `supervisor.rs` and `clean.ts`, both green in my narrow runs, and `98e1c8b`'s locale deletions passed the full vitest run in the tester report.
- The user wants the Linux sidecar's evidence chain kept over a byte-for-byte rebuild. Medium; Task 9.7 step 4 says rebuild every sidecar, so the handover should state the choice and let the user pick.
