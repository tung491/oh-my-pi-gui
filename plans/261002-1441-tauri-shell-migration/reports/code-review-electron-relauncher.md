# Code review: Electron relaunch helper + no_new_privs reopen flow

Date: 2026-10-05 (KST). Read-only review of `tauri/integration` in `/home/tung491/WORK/worktrees/tauri-integration`, via `git show` only (no builds).

- `c5a1f59` fix(tauri): play the 0.9.x Electron relaunch helper after a .deb update
- `2c0d840` fix(tauri): ask for a reopen instead of running pkexec under no_new_privs

Spec: `reports/kongming-deb-handover-advice.md`. Failure being fixed: `.checkpoint-sai-atlas-261004/deb-handover/RESULT.txt`.

## Verdict

**Nothing in these two commits blocks.** The protocol is implemented correctly, the normal (NNP=0) relaunch path has not regressed, and the reopen state cannot leave the user stuck. Fix two medium issues before release, because both are cheap: the unit name breaks how portals identify the app, and a `systemd-run` timeout can start the app twice. The review also turned up one problem outside these commits that does affect the plan: the AppImage handover cannot work on its production path (O1).

## What was verified (so it is not re-litigated)

| Claim | Evidence |
|---|---|
| `--setenv=NAME` (no value) makes systemd-run read the value from its own environment | systemd v255 `src/run/run.c:348` -> `strv_env_replace_strdup_passthrough` (`env-util.c:417-436`): `strjoin(name, "=", secure_getenv(name))`. `secure_getenv` only hides values under AT_SECURE, and NNP does not set AT_SECURE (systemd-run is not setuid). `start_with_user_manager` puts exactly the passed pairs into systemd-run's environment (`relaunch.rs:344-349`), so the values do reach the service. Values never appear on a command line. |
| systemd-run --user connects without a session bus and waits for the exec | v255 `run.c:1967-1972`: local user scope without `--wait` uses `bus_connect_transport_systemd` (the private socket under `$XDG_RUNTIME_DIR`). `run.c:1347-1382` waits for the start job unless `--no-block` is given. Because of `Type=exec`, that job finishes when the exec does, so an exec failure gives a non-zero exit and the code falls back. |
| No argv injection | Names are filtered to `[A-Za-z_][A-Za-z0-9_]*` (`relaunch.rs:320-326`), values stay in the environment, cwd and program are single argv elements with no shell, `--` comes before the program, and the unit name is built only from APP_ID, pid and hex digits. |
| The normal self-update relaunch has not regressed since 1bbf9f5 | The NNP=0 branch of `start_pending_relaunch` still calls `relaunch_command` (`lib.rs:287-289`), which applies `scrub_env` only. `INHERITED_LAUNCH_ENV` (which drops APPIMAGE, APPDIR, ARGV0, OWD) is applied only inside `launch_detached` (`relaunch.rs:274`), and that runs only for the relauncher or when NNP=1. The only change to the diff's `-` lines is that `close_inherited_fds_on_exec` now takes a `std::process::Command`. The AppImage runtime sets APPIMAGE, APPDIR, ARGV0 and OWD again for each image it starts, so dropping them on the detached route is correct. |
| Argv detection is strict | The binary enters relauncher mode only when `argv[1] == "--type=relauncher"` exactly (`electron_relauncher.rs:44`). Desktop `%u`/`%f` expansion passes absolute paths or URIs, so `omp://` links and file paths cannot trigger it. Running it by hand only waits up to 60 s for the shell, which is same-user, and nothing crosses a privilege boundary. |
| fd 3 handling | It writes only if fd 3 is a FIFO, uses non-blocking I/O, treats EPIPE/EBADF as failures without dying, and closes the fd. It reads the parent pid before sending the byte, so no reuse race is possible: Electron cannot exit until it reads the byte. The pidfd is CLOEXEC by default, and `getppid()` is checked again after `pidfd_open`. A `pid <= 1` parent counts as already gone. |
| pkexec's NNP signature | polkit 124 `pkexec.c:502` sets `ret = 127`, and `:582` prints `g_printerr ("pkexec must be setuid root\n")` without gettext, so matching the substring does not depend on the locale. |
| The reopen state cannot leave the user stuck | `reopen_required` lives only in memory (it is not persisted). A new process starts at Idle. A manual check sets Available, and the user downloads and applies again. All Linux Ollama remedies go through pkexec (`remedy.rs:37-45`), so blocking them all under NNP is correct. The i18n keys are present in both `en.ts` and `vi.ts`. `OllamaRemedyOutcome` has no exhaustive `never` switch that would break. |
| Manual reopen (rather than a "Restart" button that goes through `launch_detached`) is the right UX | On a systemd host the handover already runs NNP=0, so the reopen state appears only on hosts without a user manager. There `launch_detached` would also fall back to a direct start and could not clear the flag. |

## Findings

### Critical
None.

### High
None in these commits. See O1 for the plan-level issue.

### Medium

**M1. The transient unit name does not follow the XDG service convention, so portals assign the app the wrong app id for the whole handover session.** `relaunch.rs:287-291`
The code produces `app-vn.io.vif.saiatlas-handover-<pid>-<hex>.service`. Per systemd.io/DESKTOP_ENVIRONMENTS, the `-<RANDOM>` suffix belongs to scopes; services use `app[-<launcher>]-<ApplicationID>[@<RANDOM>].service`. xdg-desktop-portal derives a host app's id from that unit name with the regex `^app-(?:[[:alnum:]]+\-)?(.+?)(?:@[[:alnum:]]*|\-autostart)?\.service$`:
- Ubuntu 24.04 ships 1.18.4, which assigns the match without checking for a desktop file (`src/xdp-utils.c:212-224`). The app id becomes `vn.io.vif.saiatlas-handover-1234-0000abcd`, a new random id on every handover.
- Newer releases (`shared/xdp-app-info-host.c:161-176`) look up `<id>.desktop`, find nothing, and fall back to `""`.

Failure scenario: on a Wayland session where the app uses the GlobalShortcuts portal (`desktop/wayland_portal.rs`, ashpd; e.g. Kubuntu 24.04 Plasma 5.27, or GNOME 48 or later), shortcut bindings and permission-store entries are keyed to a throwaway id. The user gets a new bind prompt, or loses their bindings, and leftover entries pile up. This lasts until a manual restart: an in-session deb self-update relaunches as a direct child inside the same unit, so the wrong id survives it.
The doc comment at `relaunch.rs:287` ("XDG `app-<id>-<random>.service` convention") is factually wrong.
Fix: `format!("app-{}@{purpose}{pid}{nanos:08x}.service", APP_ID)`. The instance part must be `[[:alnum:]]` only, so drop the hyphens; KDE's transient `app-<id>@<uuid>.service` units are the precedent. Add a unit test that applies the portal regex and asserts the captured id is `vn.io.vif.saiatlas`.

**M2. If `systemd-run` times out, the fallback can start a second app.** `relaunch.rs:357-361` together with `launch_detached` at `relaunch.rs:277-284`
After 10 s the code kills `systemd-run`, but the start job it queued stays in the manager, and then the app is started directly. Failure scenario: a busy user manager (login storm, heavy I/O) runs the queued job late, so two instances start. The comment hands this to the single-instance plugin. That works only when a session bus is present, and the instance that survives may be the direct one, which keeps NNP=1. That leaves exactly the pkexec-broken session this commit exists to avoid. It also undercuts the module's stated invariant ("two instances never share the profile").
Fix: on timeout, best-effort `systemctl --user stop <unit>`, which cancels a pending start job or stops a late start, before falling back. Alternatively, do not fall back after a timeout and log "may have started". Test it with a fake `systemd-run` on PATH that sleeps past the timeout.

### Low

**L1. The quit-approval prompt comes before the NNP check.** `updater/mod.rs:493` calls `approve_quit_before_install()` (the working-tabs prompt) first; `install.rs:154` checks `can_elevate()` only afterwards. The user agrees to close their tabs, nothing quits, and then they are told to reopen. This happens once per download, since the button is then hidden. Check `privileged.can_elevate()` for `Deb` before asking.

**L2. `systemd-run` is resolved through PATH** (`relaunch.rs:260,345`). The rest of the updater uses absolute paths (`install.rs` `APT_GET`, `DEB_BINARY`). This is same-user, so there is no privilege boundary, but PATH comes from Electron's (or the old mount's scrubbed) environment. Use `/usr/bin/systemd-run`, falling back to a PATH lookup on ENOENT.

**L3. Environment values are copied into the transient unit.** They end up in `$XDG_RUNTIME_DIR/systemd/transient/<unit>.service` and in `systemctl --user show -p Environment` until `--collect` garbage-collects the unit. Any API keys a user exports (e.g. `ANTHROPIC_API_KEY`) go along. They stay readable by the same user only, as they already are in `/proc/<pid>/environ`. Not a vulnerability. Note it in the parity report and do not add more variables to this path.

**L4. The dropped argv is logged verbatim** (`electron_relauncher.rs:60`). An `omp://` link with a token or code in its query would be written to `gui-runtime.jsonl`, which the LogPanel can export. Consider logging only the count plus each argument's scheme or flag name.

**L5. `$` in the program path is expanded by the manager.** systemd-run's `--expand-environment` defaults to yes since v254. This affects only the AppImage branch (`$APPIMAGE` is user-named). Escape `$` as `$$` in the program argument. Do not pass `--expand-environment=no`, because systemd 252 rejects it.

**L6. A subreaper parent gets a 60 s wait and then no launch.** If Electron is killed before `getppid()` (`electron_relauncher.rs:53`), the parent becomes `systemd --user` (a subreaper, pid > 1): the code waits the full 60 s and starts nothing. This degrades acceptably (dpkg is done, so the next manual start runs Tauri).

**L7. An NNP direct fallback with an AppImage target reports success when nothing starts.** `relaunch.rs:283` and `lib.rs:276`: the spawn succeeds, the AppImage runtime cannot mount under NNP (see O1) and exits 127, and the log says `route: direct`. This needs a non-systemd host plus NNP plus an AppImage target, so it is rare. A log line saying an AppImage under NNP will probably not start would make the cause findable.

**L8. Nit:** `reopen_required: Option<bool>` is only ever `None` or `Some(true)` (`state.rs`). A `bool` with `skip_serializing_if = "std::ops::Not::not"` would express the same wire shape without the third state.

### Outside these commits (affects the plan)

**O1. The production AppImage handover cannot relaunch.** After an AppImage update, 0.9.16 calls `app.relaunch({ execPath: appImageTarget })`. Chromium's relauncher, which is the old Electron binary, then starts the new Tauri `.AppImage` with NNP=1. The type-2 runtime mounts through the setuid `fusermount3`, setuid has no effect under NNP, so the mount fails and the runtime exits 127 before any Tauri code runs. Other Electron projects have hit this exact failure ([t3code #4](https://github.com/gidorah/t3code/pull/4), [dsh-desktop #1269](https://github.com/anywhere-labs/dsh-desktop/pull/1269), [fd0.sh #20](https://github.com/k2b-dev/fd0.sh/issues/20)). The Kongming report expected that "the pass conditions should still hold" on that path; they will not. The likely outcome: Electron quits, nothing comes back, and the next manual start runs Tauri because the file is already replaced. A Tauri-side change cannot fix this, since the binary is never reached. When step 3 is re-run on the production path (Kongming finding 4), expect "relaunches on its own: FAIL" and decide whether a manual reopen is acceptable for the 0.9.x AppImage population. Record it in the parity report.

## Test assessment

The tests cover the real risks of the protocol core well. Covered:
- argv split, including the edge cases;
- pipe vs non-pipe vs closed fd, and EPIPE;
- start only after the parent exits;
- never starting after the timeout;
- a parent that is already gone;
- the env denylist, both the dropped and kept sets;
- the `systemd-run` argv shape, including the absence of `--scope`;
- both fallback reasons;
- an end-to-end binary run against a real pipe;
- the hash check before the NNP check;
- the 127-plus-text classification in both places.

The unit and integration tests never contact the real user manager, and the integration test keeps its runtime log in a temp profile.

Gaps:
- `start_with_user_manager` is never run. Add a fake `systemd-run` on PATH that dumps argv and env. That would prove values reach systemd-run's environment while only names appear in argv, that a non-zero exit falls back, and how the timeout path behaves (M2).
- There is no test of the unit name against the portal regex (M1).
- The integration test reaches the marker only through the AppImage branch. The deb branch (`current_exe`) is covered only by `launch_target` unit tests. That is acceptable.

No phantom tests. Style matches the surrounding code, and there are no plan IDs or finding codes in code, tests or commit text.

## Recommended actions
1. M1: change the unit name to `app-<APP_ID>@<alnum>.service` and test it against the portal regex.
2. M2: stop or cancel the unit after a `systemd-run` timeout before falling back, and test it with a fake `systemd-run`.
3. L1: check `can_elevate` before the quit-approval prompt.
4. Plan: mark AppImage step 3 as expected to fail its auto-relaunch on the production path (O1), and decide whether that is acceptable.
5. Optional: L2, L4, L5.

## Unresolved questions
- The host run still has to confirm that `pkexec` from the `systemd-run` service reaches the GNOME agent (polkit's uid-to-display-session fallback). Kongming already flagged this, and the code cannot prove it.
- Electron's omp sidecars may outlive Electron's main process by a few seconds. The pidfd waits only for the main process, so briefly old and new sidecars could share `~/.omp`. Check the step-4 timeline for sidecar PIDs of the old app still alive after the Tauri start.

---

# Review of d477387

Date: 2026-10-05 (KST). `d477387` fix(updater): reopen the app after an Electron AppImage update installs it. Read-only via `git show`; `windows.rs` ignored. Spec: `reports/kongming-appimage-handover-advice.md`. Also checked on the way: `fa5302f` resolves M1 (`app-<APP_ID>@<alnum>.service`), M2 (`systemctl --user stop` after a timeout, `Unconfirmed` route with no second start) and L2 (absolute `/usr/bin/systemd-run`, `/usr/bin/systemctl`).

## Verdict

**Blocks: yes, one finding (C1).** On the direct route, the waiter inherits the install child's stdout/stderr. Those are electron-updater's `execFileSync` pipes, and Node does not return until every holder of those pipes has closed them. Electron's main thread therefore never comes back from the install, the waiter waits for Electron forever, and the old app hangs frozen. That is worse than doing nothing. The fix is one line. Everything else matches the spec:
- the relaunch decision lives in the waiter;
- install-on-quit never relaunches;
- `$$` escaping is correct for systemd 255;
- `setsid` regresses nothing;
- the scrub across two mounts is correct.

## What was verified

| Claim | Evidence |
|---|---|
| The install child always exits 0 and makes no relaunch decision | `main.rs:34-37`: `schedule_relaunch()` then an unconditional `ExitCode::SUCCESS`. `schedule_relaunch` returns `()` and handles every error through `report`. I audited for panics: no `unwrap`/`expect` outside tests on its path (`appimage_handover.rs`, `relaunch.rs` launch path, `runtime_log::note`), and the crate uses the default `panic = "unwind"`. The decision lives only in the waiter (`[ -n "$helper" ] \|\| exit 0`). |
| Install-on-quit never relaunches | electron-updater 6.8.9 `AppImageUpdater.js:111-112` runs `execFileSync(destination, [], { env })` the same way on both paths. 0.9.16 calls `app.relaunch` only from `quitAndInstall` (spec, `updater.ts:367`). The waiter starts the image only after it has seen a `--type=relauncher` child of the old app naming the new image, and exits 0 once the old app is gone otherwise. The unit test `the_waiter_starts_nothing_when_the_old_app_quits_without_a_relaunch_helper` and the integration test `an_install_at_quit_leaves_the_app_closed` cover this. |
| The waiter cannot miss the helper because of start order | `launch_detached` returns only after the waiter has exec'd: `Type=exec` makes systemd-run wait for the exec, and std `spawn` waits through its CLOEXEC error pipe. The helper can only appear after the install child exits, which is after that. So the waiter is already polling when the helper is spawned. |
| `$$` escaping is right for systemd 255 | `dbus-execute.c:1301-1410`: transient `ExecStart` argv is stored exactly as received over D-Bus. Specifiers are not expanded; for the on-disk copy, `%` and `$` are escaped and control characters such as the script's newlines are C-escaped (`escape.c:474-495`), so a daemon-reload restores the same argv. At exec, `exec-invoke.c:5183-5186` runs `replace_env_argv`. In `env-util.c:677-686` a `$$` becomes one `$` and parsing goes back to plain text, so `$${x}` becomes the literal `${x}`. A word that is exactly `$NAME` is split, but escaped words start with `$$` and are excluded (`:856`). A braceless `$NAME` inside a word is never expanded (`flags = 0`, `:897-903`). Doubling every `$` in the arguments after the program is therefore exact. The program path itself goes in `c->path`, which is never expanded, so leaving it unescaped is right. |
| No shell injection | The image path, file name and pid are positional `$1..$3` and always quoted (`exec "$img"`, `grep -e "$name"`, `"/proc/$child/cmdline"`). The only unquoted expansion is `$(children)`, which yields numeric pids. `grep -F -e` handles names that start with `-` and regex metacharacters. |
| The matching is tight enough | Only direct children of the old Electron main process are examined, and a match needs both `--type=relauncher` and the new image's file name. The install child's own command line has the name but not the flag. Electron's zygote, GPU and sidecar children have neither. An unrelated process cannot match without being Electron's child. |
| Liveness is checked correctly | `/proc/<pid>/stat` field 22 (starttime) is `${20}` after the `pid (comm)` prefix is stripped with `${stat##*) }`. That strip is safe even when comm contains `) `. Z and X count as gone, so neither an unreaped zombie nor a reused pid keeps the waiter waiting. |
| `setsid` on every direct launch regresses nothing | The supervisor calls `setsid()` itself (`omp/supervisor.rs:90`) and puts omp in its own group (`:153`), with `killpg` aimed only at omp's group (`:187`). Nothing in `src-tauri` or `e2e/` signals the app's own process group. The app opens no tty, so becoming a session leader without a controlling terminal cannot attach one. |
| The scrub across two mounts is correct | `scrub_env` and `relaunch_cwd` take a slice of mounts, and `is_under` keeps the path boundary (`.mount_a` does not match `.mount_ab`). Test `scrub_env_drops_components_of_every_mount`. The deb and self-update call sites pass `&[]` or a single mount, so their behaviour is unchanged. |

## Findings

### Critical (blocking)

**C1. On the direct route the waiter holds electron-updater's `execFileSync` pipes, so Electron never returns from the install. That is a permanent hang and a deadlock with the waiter.** `relaunch.rs:32-41` (`relaunch_command` inherits stdio), reached through `relaunch.rs:361`, from `appimage_handover.rs:159`.
- electron-updater 6.8.9 `AppImageUpdater.js:112` calls `execFileSync(destination, [], { env })` with the default `stdio: "pipe"`.
- Node's `spawnSync`/`execFileSync` returns only when the child has exited *and* every writer of its stdout and stderr pipes has closed them.
- Measured here with Node 26: `sh -c 'sleep 2 &'` blocks `execFileSync` for 2004 ms, and so does `setsid sleep 2 &`. With the background job's stdio sent to `/dev/null` it returns in 1 ms. `setsid` does not help.

Failure scenario: no user manager (container harness, non-systemd distros, missing `XDG_RUNTIME_DIR`), or systemd-run failed, or it timed out and the stop succeeded. In any of those cases the `/bin/sh` waiter inherits fds 1/2. Electron's main thread stays blocked in `execFileSync`, so the app never calls `app.relaunch()` or quits. The waiter keeps polling for that same Electron to exit. Result:
- "Restart & install": the window freezes for good.
- Install-on-quit: an invisible Electron process hangs at quit, and the waiter with it.

Both last until the user kills Electron. Before this commit, the same path gave "file replaced, reopen by hand". The systemd-run route is not affected, because `run_tool` gives systemd-run null stdin and stdout and its own stderr pipe, and the unit gets journal stdio.

The tests miss it. `tests/appimage_handover.rs:55` runs the install child as `"$0"; echo $?`, which waits for the exit only, never for end-of-file on the output.

Fix: on the direct route of `launch_detached`, set stdin, stdout and stderr to `Stdio::null()`, either for every caller or at least for the handover. A detached app has nobody reading its output, and the systemd route already sends it to the journal. Then model the real caller in the integration test: run the install child with piped stdout and stderr, read both to end-of-file under a timeout (in sh, `out=$("$0" 2>&1)`, or in Rust spawn with `Stdio::piped()` and `wait_with_output` behind a deadline), and assert it returns within about 2 s on the direct route.

### High
None.

### Medium

**M3. Polling cost and lifetime of the waiter.** `appimage_handover.rs:39-75`.
- Each 10 ms tick creates processes. `alive` costs a `$(…)` subshell plus `cat`. Before the helper is seen, `find_helper` adds another subshell, `cat`, and one or two `grep`s per child of Electron main (zygotes, GPU, utility processes, omp sidecars, crashpad: about 8–10). That is roughly 15 fork/execs per tick, on the order of 500 process spawns a second, during Electron's shutdown.
- Normally this lasts well under a second, and it is acceptable then.
- There is no upper bound on how long the waiter runs. If Electron lingers, the waiter polls at that rate for as long as Electron lives: a `beforeunload` that cancels the quit after the helper was spawned, a hung shutdown, or a manual `APPIMAGE_EXIT_AFTER_INSTALL=true` run from a terminal whose parent is a shell.
- A CPU-loaded shutdown also stretches each iteration. That eats into the roughly 150 ms window in which the helper exists, which the spec flagged as the key assumption.

Fix:
- Read stat with the `read -r stat < "/proc/$1/stat"` builtin and set globals instead of echoing through `$(…)`. The crate's own test already uses `read -r stat < /proc/$$/stat`. That makes `alive` cost zero forks.
- Check every child with one `grep -lsF -e --type=relauncher /proc/<c1>/cmdline /proc/<c2>/cmdline …` call, then test the name only on the hits.
- Once the helper is seen, slow the poll to about 100 ms; only spotting the helper is time-critical.
- If no helper has appeared within a few minutes, exit 0. The helper is spawned right after the install child exits, so a missing helper after that long means a quit.

### Low

**L9. `children()` falls back to scanning every process when any one thread exits.** `appimage_handover.rs:51`: `cat /proc/$pid/task/*/children || awk …`. `cat` returns non-zero if any one task file vanished between the glob and the open, which is routine in a thread pool. Each such tick then also scans every `/proc/*/stat` with awk (about 10–30 ms). The output is merely duplicated, so it is still correct. The fallback's `$4 == p` also misreads the parent pid of any child whose comm contains a space. Fix: run the fallback only when the `children` file does not exist (`[ -e /proc/$pid/task/$pid/children ]`), not when `cat` fails.

**L10. Make "always exit 0" structural, not a result of auditing.** Wrap `schedule_relaunch()` in `std::panic::catch_unwind` in `main.rs:36`. Today it holds because nothing on that path panics; a future `expect` in `runtime_log` or `relaunch` would make electron-updater report a failed install after the file was already swapped.

**L11. An unreadable parent executable skips the waiter entirely.** `appimage_handover.rs:131`. `/proc/<ppid>/exe` is needed only to find the old mount to scrub. If it cannot be read, scheduling with just the install child's own mount (and `PATH` scrubbing via `INHERITED_LAUNCH_ENV`) would still reopen the app. The old mount disappears anyway, and stale components only hurt lookups, not the mount lifetime. Not reachable for the same uid with a dumpable Electron (the harness read its exe as uid 1000), so this only matters as defence in depth.

**L12. Electron can stay frozen for up to 15 s on the systemd route.** Worst case is the 10 s systemd-run cap plus 5 s for `systemctl stop`, during which electron-updater's `execFileSync` holds the main thread. This is accepted in the spec. Mention it in the parity report if it is ever observed.

**L13. With AppImageLauncher or binfmt integration, a hung helper means two prompts.** If the helper's exec is intercepted by AppImageLauncher's binfmt handler, its "integrate?" dialog keeps the helper alive. The waiter then starts `$img` after 3 s, which triggers a second dialog. This is rare and needs no code change; mention it if users report it.

## Tests

The waiter's unit tests cover:
- restart (waits for both the old app and the helper, at least 750 ms);
- a plain quit;
- a helper for another image;
- a zombie old app;
- a parent that is already gone.

The `relaunch.rs` tests cover argument order on both routes with a fake `systemd-run`, `$` doubling (with the program path left as written), being a session leader, and the scrub across two mounts.

Gaps:
- C1: no test reads the install child's output to end-of-file the way `execFileSync` does.
- The awk fallback is never exercised. Test the function on its own against a known child.
- No helper appears *after* the waiter starts (the fakes spawn it before). That is the real order.
- No image path or name contains spaces or `$` in the waiter tests; only the argv builder test has one.

Style matches the surrounding code. There are no plan IDs or finding codes, and the commit text is accurate apart from not mentioning the stdio inheritance.

## Recommended actions
1. **C1 (blocking):** null stdio on the direct route of `launch_detached`, and an integration test that models `execFileSync`'s wait for end-of-file on the output.
2. M3: no-fork `alive` through the `read` builtin, one batched `grep`, slower polling once the helper is seen, and a bound on how long the waiter waits without a helper.
3. L9 and L10. Then the harness runs 1–3 from the Kongming spec, plus one direct-route run (container or `XDG_RUNTIME_DIR` unset) to confirm C1 is fixed.

Status: BLOCKED (on C1 only; everything else DONE)
