# Changelog: spike design changes propagated into the Tauri plan

Plan: `/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/`. Revised 2026-10-02 after the Phase 0 spike report, the user's accepted decisions and kongming's Phase 0/1 checkpoint. No `status:` field and no Phases-table Status cell changed. Each phase still has exactly one literal `## Failure Protocol` block.

## plan.md

- Front matter: `effort` 75d → 76d (Phase 3 grew by one day for the supervisor).
- Decisions: the Dictation row now records the WebAudio PCM capture design (worklet from `src/renderer/public/`, `ScriptProcessorNode` fallback, no `cpal`, no voice channel, no `gstreamer1.0-plugins-bad`, owned by Phase 9 Task 9.2 landing on `main` before Phase 2). New rows: Sidecar supervisor (frozen topology, shutdown sequence, Windows Job Object, macOS kqueue/`proc_listchildpids`, SIGTERM through Tauri's exit path), WebKit sandbox hook (`constructed` override, `is_sandbox_enabled()` assertion, Phase 10 Seccomp check, no AppArmor rule, `.deb` depends), App identity (`product.rs`, `set_prgname`/`set_application_name`, `enableGTKAppId`, `StartupWMClass`), Quick-entry bar (equal min/max 680×168, accepted Wayland stacking and tray left-click degradations, S5/S8 human rechecks in Phase 5), Window construction (`WindowSpec`), Bridge generation (page-chosen `gen`, 2 s gap policy, no chunking), Toolchain (rustup PATH shadowing, `scripts/rust-pins.env`).
- Phases table: Phase 3 effort 6d → 7d.
- Execution rules: Phase 2 now also waits for Phase 9 Task 9.2 on `main`, with the reason; the frozen list adds `product.rs`, `src/omp/supervisor.rs`'s `run` signature, `rust-toolchain.toml` and `scripts/rust-pins.env`; a new Cargo rule explains the `/usr/bin/cargo` shadowing and forbids fixing it in the user's shell profile.
- Acceptance criteria: "dictation (S4) works or the plan was revised to make it work" became a concrete condition (`grep -rn MediaRecorder src/renderer` empty, Phase 5 Task 5.3b transcript with the sandbox on, Phase 10 visual-pass row PASS). The Linux parity criterion adds the packaged-smoke hard-kill proof and the 680×168 bar.
- Risks: the sandbox row now describes the proven hook and its loud failure mode; a new row covers sidecar orphans; the microphone row describes the WebAudio capture and the remaining cutover block.
- Validation Log: untouched (Session 2 as the controller wrote it).

## phase-00-go-no-go-spike.md

- Task 0.5 step 2: the `cpal` clause is gone; the step records the actual outcome (WebAudio capture chosen, nothing frozen for voice in Phase 2, Phase 9 Task 9.2 owns it).
- Task 0.5 step 3: names the phases that now carry each recorded result and points at `reports/spike-report.md`.
- The gate table rows (S4, S14) keep their original probe text as the historical record; the report holds the results.

## phase-02-tauri-foundation-contracts.md

- Preconditions: Phase 0 GO with the Session 2 pointer; new precondition that Phase 9 Task 9.2 is merged (`grep -c MediaRecorder src/renderer/lib/voice.ts` = 0).
- Design → Bridge: `omp_invoke` carries `{ channel, args, seq, gen }`; `omp_attach` carries `gen` (`crypto.randomUUID()`); the attach lifecycle explains why Rust never infers the generation from arrival order; a 2 s gap policy plus flush-on-reattach; "responses are never chunked" frozen with the S3 numbers.
- Design → Webview security: `build_window(app, WindowSpec)` with the full field list, spec first and security last, derived labels, the spike's window options as source material and the 680×168 equal-min/max rule. The Sandbox bullet now describes the `constructed` override (`install_sandbox_hook()`, `std::sync::Once`, wry 0.57.0 file:line), the `is_sandbox_enabled()` assertion that exits before the first window, no AppArmor rule, the Phase 10 Seccomp check, and the `file://` note. The init-script bullet says a spec cannot add or replace scripts.
- Design → Profile, single instance and exit: `dispose_all` goes through the supervisors; new SIGTERM/SIGINT bullet (`tokio::signal::unix` → `AppHandle::exit(0)`).
- New Design section "App identity (Linux)": `product.rs` with its mirror test, `set_prgname`/`set_application_name` before GTK, `enableGTKAppId`.
- New Design section "Sidecar supervisor topology (frozen; implemented in Phase 3)": process tree, re-exec with `ports::SUPERVISOR_ARGV = "--omp-supervise"` handled in `main.rs` before `tauri::Builder`, `omp::supervisor::run(args) -> ExitCode` stub, `SidecarHandle::omp_pid()`/`supervisor_pid()`, `socketpair` control channel at fd 3 (EOF = parent death, one `pid <n>` line the other way), Linux primitives, no frame relay (`Stdio::inherit()`), shutdown sequence and exit status, Windows Job Object and macOS kqueue/`proc_listchildpids` deferred to Phase 12, proof in Phase 3 tests and Phase 10 smoke.
- Module ownership and Files: `product.rs` added to the foundation set; `omp/supervisor.rs` stub; `rust-toolchain.toml`; `scripts/rust-pins.env`.
- New "Execution notes": one strongest-model executor in `../worktrees/tauri-foundation` from `main` `2b0b698`, commit per task, spike source files (`sandbox.rs`, `s7.rs`, `lib.rs:280-310`, `webkit_features.rs`), hard-link `resources/omp`, warn the user before Task 2.8 opens a window, read `plans/` by absolute path.
- Task 2.1: `nix` features (`signal`, `process`, `socket`, `fs`, `event`) and `libc`; explicit "no voice dependency"; `glib`, `gobject-sys`, `webkit2gtk-sys`; the rule to resolve `tauri` first and read versions from `cargo tree -i`, never pin first (with the spike's `=2.0.1` → tauri 2.9.5 incident); new step 5 for the toolchain pins (`rust-toolchain.toml`, `scripts/rust-pins.env`, loud failure without `cargo tauri`). Verify adds the `cargo tree` consistency check and `grep -c cpal` = 0.
- Task 2.3: one more port test (`attach and every invoke carry the same page generation`); Verify `7 passed`.
- Task 2.5: `product.rs` step and test; four new bridge tests (invoke before attach, older generation rejected, gap timeout, `later futures do not block the next admission`); `webview.rs` gets `WindowSpec`, `install_sandbox_hook()` and three spec tests; Verify includes `product`.
- Task 2.6: supervisor stub, `SidecarHandle` pid methods, `SUPERVISOR_ARGV` constant.
- Task 2.8: `main.rs` order (supervisor argv → AppImage exit → prgname/application name/sandbox hook → run); no WebKit env vars since S1 needed none; the `unsafe` allowlist names the real sites; `lib.rs` installs the signal listener; the desktop stub uses `WindowSpec`; `tauri.conf.json` adds `enableGTKAppId: true` and the reason for `app.windows: []`. Verify adds the `WAYLAND_DEBUG` `set_app_id("vn.io.vif.saiatlas")` grep, a SIGTERM exit check and the "tell the user first" step.
- Task 2.9: `check-module.sh` and `tauri-dev.ts` read the pins and fail loudly; Verify adds the shadowed-PATH and missing-cargo cases.
- New Task 2.9b: contract review of Phases 3 to 9 before the wave branches, written to `reports/phase-02-contract-review.md`, zero `GAP` rows.
- Risk: the sandbox and chunking bullets are closed with evidence; a supervisor footprint bullet is added.

## phase-03-omp-processes.md

- Effort 6d → 7d; Goal names the supervisor and the stricter shutdown guarantee.
- Wave rules: `main.rs` added to the never-edit list; API snapshots named correctly (`omp.api.txt`, `ports.api.txt`); the single `unsafe` site is the fd 3 dup in `manager.rs`.
- Files: `supervisor.rs` listed.
- Task 3.4 step 4: rewritten from "direct spawn + PDEATHSIG in `pre_exec`" to the supervisor spawn (re-exec with the reserved argv, `socketpair` to fd 3, `pid` line, `kill()` semantics, 8 s wait, Windows direct spawn until Phase 12). Step 7 and Verify cover the supervisor process too.
- New Task 3.4b: `run` implementation steps (setsid, subreaper, PDEATHSIG, ppid check, inherit stdio, process group, wait on three futures, grace, group kill, `/proc` sweep ≤ 2 s, exit status), the macOS/Windows `cfg` split, three Linux tests including the S7b gate as `sigkill of the parent kills the child tree within 10 s`, and a manual hard-kill check against the dev app with exact `pgrep` commands.
- Status report lists the deferred macOS/Windows sidecar-stop branches.

## phase-05-windows-desktop-integration.md

- Task 5.2 step 3: windows are built through `WindowSpec`; editing `webview.rs` is a plan bug.
- Task 5.3b: rewritten around the WebAudio capture already on `main`; Verify is the worklet capability expression plus `grep -c transcribe_audio` ≥ 1; the "S4 degradation accepted" escape is gone.
- Task 5.4 step 2: `WindowSpec` fields, equal min/max 680×168, no `resizable: false` (with the 680×200 evidence), accepted Wayland stacking degradation. Success criteria and Verify cover `[innerWidth, innerHeight]` = `[680, 168]` and the Send button (`2b0b698`).
- Task 5.5: the on-screen chord check is mandatory (S5 verified plumbing only; user deferred the screen check); the "FAIL acceptable" clause is gone.
- Task 5.6: the tray icon and a menu click must be confirmed by the user (S8 verified over D-Bus only); the missing left-click is the accepted degradation.
- Task 5.7 step 2: `parse_launch_argv` ignores `ports::SUPERVISOR_ARGV`, with a test.
- Status report enumerates every manual check and requires PASS on all.

## phase-08-updater-packaging-ci.md

- Owned paths: no AppArmor profile.
- Task 8.3 step 3: `bubblewrap` and `xdg-dbus-proxy` are required with the reason; no `gstreamer1.0-plugins-bad`; no AppArmor rule; the `desktopTemplate` (`src-tauri/linux/vn.io.vif.saiatlas.desktop`, `StartupWMClass=vn.io.vif.saiatlas`) is mandatory with the bundler's default behavior explained; the AppImage host requirement is noted for Phase 11. Verify adds `dpkg -I` Depends checks, the apparmor count, the "Text file busy" warning, and the S12 size baseline (.deb 169.88 MiB, AppImage 245.73 MiB) with a 10% tolerance.
- Task 8.4: new invariant tests (`xdg-dbus-proxy` dependency, no plugins-bad, `StartupWMClass`, `enableGTKAppId`, no AppArmor profile).
- Task 8.6: CI installs the pinned toolchain and `cargo-public-api` from `scripts/rust-pins.env` and runs the foundation snapshot gate.
- Status report records sizes against the baseline.

## phase-09-renderer-webkit-compat.md

- Wave rules: an explicit exception for Task 9.2 (runs on `main` before Phase 2, Electron gate, file list, why).
- Verified facts: the voice fact now records the S4 evidence and the chosen design.
- Task 9.2: rewritten as "Capture dictation with WebAudio PCM instead of MediaRecorder" with the worklet as a static file in `src/renderer/public/` (the Vite 4 KB `data:` inlining reason), `chooseCaptureBackend`, the accumulator, the unchanged resample/WAV/transcribe tail, four pure tests, an Electron manual check and mechanical Verify steps (`grep -rn MediaRecorder src/renderer` empty, worklet present in both outputs).
- Task 9.3: the audit grep adds `MediaRecorder` and `file://` with the sandbox reason.
- Task 9.4: notes the separate Task 9.2 commit on `main`.

## phase-10-integration-e2e-parity.md

- Files: `e2e/**` may gain Playwright tests that pass on Electron.
- Task 10.3 step 2: adds `quick entry sends from the Send button` to `e2e/quick-entry.e2e.ts` first, then its twin, plus the 680×168 assertion. Step 4: Seccomp on every web process, `bwrap` parent, the real-agent hard-kill case with exact `pgrep` commands, and the Wayland app id check.
- Task 10.4: the visual-pass list names the bar size and Send button, dictation under the sandbox, the tray icon/menu click and the Wayland chord, and separates accepted degradations from FAIL.
- Task 10.5: the footprint includes supervisors and sandbox helpers; installer sizes sit next to the S12 baseline.

## phase-11-linux-cutover-release.md

- Task docs target: the README states the sandbox is always on, needs no AppArmor rule, and requires `bubblewrap`/`xdg-dbus-proxy` on the host (AppImage users install them).

## phase-12-macos-windows-cutover-electron-removal.md

- Task 12.1 step 4 replaced: Windows Job Object with `KILL_ON_JOB_CLOSE`, the `CREATE_BREAKAWAY_FROM_JOB` check in pi-natives, a Windows test; new 4b for the macOS supervisor additions (kqueue `NOTE_EXIT`, `proc_listchildpids` snapshot, Phase 3 tests rerun); new 4c for Windows console-event parity with the SIGTERM listener. Verify adds the hard-kill check on both hosts.

## Checks run

- `ak plan validate plans/261002-1441-tauri-shell-migration` → `[OK] … is a valid plan directory`, exit 0 (before and after the edits; no tooling error this time).
- `grep -c "^## Failure Protocol$"` = 1 for every phase file (phase-00 to phase-12).
- Every `./phase-*.md` and `./reports/spike-report.md` link in `plan.md` resolves.
- `status:` is `pending` in every file, unchanged.
- Stale-term sweep (`cpal|MediaRecorder|resizable\(false\)|kill_on_drop|webkit2gtk = "=|plugins-bad|AppArmor|S4 failed|S4 degradation|supervisor_main|control pipe`): the remaining hits are the term being replaced or forbidden (Phase 2 Task 2.1, Phase 5 Task 5.4, Phase 8 Task 8.3, Phase 9 Task 9.2, plan.md Decisions and Risks), the historical records (Phase 0 gate table, plan.md Validation Log and Red Team table), and the Phase 11 README sentence that says no AppArmor rule is needed. No instruction still tells an executor to use `cpal`, `MediaRecorder`, `resizable(false)`, `kill_on_drop`, a pinned webkit2gtk, `gstreamer1.0-plugins-bad` or an AppArmor profile.
- Phases 1, 4, 6, 7 needed no change (Phase 4 disposes sidecars only through the `SidecarHandle` trait).

## Controller checkpoint items (kongming Phase 0/1) and where they landed

1. `WindowSpec` → Phase 2 Design → Webview security, Task 2.5 step 6; Phase 5 Tasks 5.2 and 5.4.
2. Supervisor entry in `main.rs`, `omp::supervisor::run` stub, `SidecarHandle` pids, argv ignored → Phase 2 Design → Sidecar supervisor topology, Tasks 2.6 and 2.8; Phase 3 Tasks 3.4 and 3.4b; Phase 5 Task 5.7.
3. `product.rs`, `set_prgname`/`set_application_name`, sandbox hook behind `Once` → Phase 2 Design → App identity and Webview security, Tasks 2.5 and 2.8.
4. SIGTERM/SIGINT handler → Phase 2 Design → Profile, single instance and exit, Task 2.8 step 2 and Verify; Phase 12 Task 12.1 step 4c for Windows.
5. Page-chosen generation, gap policy, admission test, no chunking → Phase 2 Design → Bridge, Tasks 2.3 and 2.5, Risk.
6. Toolchain pinning → Phase 2 Task 2.1 step 5, Tasks 2.6 and 2.9; Phase 8 Task 8.6; plan.md Execution rules and Decisions.
7. `tauri.conf.json` settings → Phase 2 Task 2.8 step 4; Phase 8 Task 8.4 tests.
8. Worklet as a static file under `src/renderer/public/` → Phase 9 Task 9.2 step 2; plan.md Decisions.
9. Contract-review gate → Phase 2 Task 2.9b.
10. Execution notes → Phase 2 → Execution notes.

## Open points for the controller

- Phase 3's S7b test re-executes the test binary as a stand-in GUI (`current_exe()` with `--exact <helper> --nocapture` and an env var). It is the faithful form of the gate without needing the agent; if that pattern is unwelcome, the control-channel EOF test alone still proves the primary path.
- `SidecarHandle::omp_pid()` is fed by one `pid <n>` line on the `socketpair` control channel. This was my choice to satisfy "expose the omp pid vs the supervisor pid" without a third pipe; Phase 2's executor may pick another carrier as long as the trait method stays.
