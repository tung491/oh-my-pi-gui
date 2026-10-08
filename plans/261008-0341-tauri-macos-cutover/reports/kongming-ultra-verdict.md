# Kongming verdict: `ak:plan --ultra` best-of-5, Tauri for macOS cutover

Verifier: kongming (claude-fable-5-1), 2026-10-08, Asia/Seoul. Inputs: `reports/ultra-evidence-packet.md`, `reports/ultra-rubric.md`, `reports/scout-macos-parity-inventory.md`, five anonymized candidates A–E (order carries no meaning). Every load-bearing claim below was spot-checked against the worktree at `83d393c` or against the pinned crate sources; evidence is `file:line`.

## TL;DR

**Winner: Candidate A** (127/140). Runner-up B (119), then D (113), C (109), E (103). No candidate fails a hard constraint, so reject-all does not apply. A wins on four technical catches no other candidate made (the unregistered `tauri_nspanel::init()` plugin, the Phase-1 hardened-runtime signing spike, per-profile WKWebView storage, the most complete `include_str!`/fixture removal inventory) and on the strictest red/green discipline. A still has eleven concrete defects for the red-team pass, listed at the end with evidence; the two that matter most are the missed `e2e/sidecar-fixture.ts` → `src/main/rpc-bridge` import and the stale CSP test line range.

## Verified facts the scores rest on

| Fact | Evidence | Who got it right |
|---|---|---|
| `to_panel()` reads `self.state::<WebviewPanelManager>()`, managed only by `tauri_nspanel::init()`; `lib.rs:446-462` registers no nspanel plugin, so the first quick-entry open on macOS panics (`state()` before `manage()`) | tauri-nspanel `v2/src/lib.rs` (fetched); `src-tauri/src/lib.rs:446-462`; `windows.rs:1027-1035` | A only (Task 5.3 step 1) |
| `RawNSPanel` has `set_collection_behaviour(NSWindowCollectionBehavior)` (British spelling, typed arg), `set_level(i32)`, `make_key_window`, `order_front_regardless`; no `show_and_make_key` | tauri-nspanel `v2/src/raw_nspanel.rs` (fetched) | B, C, D, E grep-guard the name; D names a non-existent method but defers to grep |
| wry 0.57.0 `requestMediaCapturePermissionForOrigin` returns `Grant` when no permission handler is set | `wry-v0.57.0/src/wkwebview/class/wry_web_view_ui_delegate.rs` (fetched) | C (D10), D, E assert it; A, B make the executor grep it |
| single-instance macOS lock is `/tmp/<identifier>_si.sock` from `config.identifier`, so the `lib.rs:440` swap isolates throwaway profiles | plugins-workspace `single-instance/src/platform_impl/macos.rs` (fetched) | all assume it; A, C, D, E add a source check |
| `WebviewWindowBuilder::data_store_identifier([u8;16])` exists, macOS ≥ 14 only; `data_directory` is not available in WKWebView | docs.rs tauri 2.12.1 (fetched) | A only (Task 5.6) |
| `PredefinedMenuItem::bring_all_to_front` exists in Tauri 2.12.1 | docs.rs (fetched) | all |
| `sysinfo_totalmem()` returns 0 off Linux, so `read_machine` returns `None` on every Mac | `src-tauri/src/ollama/hardware.rs:144-162`, `:244-248` | A, B, D fix RAM; **C and E never do** |
| `system_profiler SPDisplaysDataType -json` took 0.26 s on this Mac; `HARDWARE_PROBE_TIMEOUT_MS` is 2 000 | live run; `hardware.rs:15` | D's "1-3 s" justification for `sysctlbyname` is contradicted here |
| CSP tests live at `src/main/packaging-config.test.ts:279`, `:285`, `:340` | grep | C, D correct; **A, B, E cite `361-437`** (stale, copied from parent Phase 12 line 63) |
| `e2e/sidecar-fixture.ts:5` imports `RPC_MAX_FRAME_BYTES, RPC_MAX_REASSEMBLED_BYTES` from `../src/main/rpc-bridge` | file | B (→ `src/shared/rpc-limits.ts`), C (local consts); **A, D, E miss it** |
| Rust reads `e2e/sidecar-fixture.ts` at `manager.rs:1100`, `shell_env.rs:359`; TS at `e2e-tauri/session.ts:30` | grep | A, B list all three; **C misses the two Rust sites; E misses the fixture entirely** |
| `include_str!` of `src/main/**`: `i18n.rs:201`, `app_icons.rs:14`, `assistant_pack.rs:462` (+ string needle `:538`) | grep | A, C, E list all; **B misses `i18n.rs:201`; D misses `i18n.rs:201` and `assistant_pack.rs:462/:538`** |
| `ports.rs:848` asserts `entry.ts.starts_with("src/main/")` on metadata only | file | C, E list it; harmless for the others |
| 41 parity entries point under `src/main/` (11+4+9+4+9+3+1); 3 under `src/shared/` (`ollama.parity.json:39,43,47`) | grep | A, B, E correct; C/D retire the gate wholesale |
| `scripts/tauri-dev.ts:86` probes the dev port with `ss` (absent on macOS) | file | C, D fix it |
| Host bun is 1.3.14; README line 168 requires ≥ 1.4, Dockerfile pins 1.4.2 | `bun --version` | B only |
| `/usr/bin/sleep` and `setsid(1)` do not exist on macOS; supervisor tests use both (`supervisor.rs:342`, `:382`) | file + host | A, B, C, D port `SLEEP_BIN`/`TOOL_TREE`; **E's Task 3.1 leaves both and asserts the existing tests pass** |
| `reach-ins.json` is only mentioned in a comment of `e2e-tauri/test-hooks.ts:5`; `check-twins.ts:14` reads `e2e/` | grep | deleting it (C, D) is safe |
| `libc` 0.2.189 (lock) has `proc_listchildpids`, `proc_pidinfo`, `proc_pidpath`, `sysctlbyname`, `SZOMB`; `nix` 0.30 `event` feature has `Kqueue`, `KEvent::new`, `EventFlag`, `FilterFlag::NOTE_EXIT`, `EventFilter::EVFILT_PROC` | local registry `libc-0.2.186/.../apple/mod.rs:4901`, `nix-0.29.0/src/sys/event.rs` | all; B writes `EvFlags` (wrong type name) |

## Hard constraints

| | H1 six user decisions | H2 Failure Protocol + mechanical Verify | H3 go-ahead / protect the user | H4 no fabrication |
|---|---|---|---|---|
| A | PASS — Decisions table rows 1-6; arm64-only scripts/feeds (Tasks 2.4, 7.2); `~/WORK/oh-my-pi` nesting (1.4); fresh installs, bridge kept (plan.md Population row); Phase 8 precondition `gh release view v0.9.17`; Windows dropped | PASS — block present in all 10 phase files; every task has a Verify | PASS — throwaway profile + `PI_CODING_AGENT_DIR` everywhere; `open -n … --env … --args` for the sitting; pushes/tags/releases ask per command (8.4, 9.1, 10.7); never `/Applications` | PASS — all paths/symbols verified except the stale CSP range `361-437` (titles correct) and `check-module.sh:105` (the renderer build is at :107) |
| B | PASS — same six; adds "nothing merges before v0.9.17 is published" | PASS — 9 files; Task 5.4 says `no verification needed` explicitly | PASS — asks before `bun upgrade`; `lsregister -u` after every launch; `tccutil` only after asking; Task 8.5 is the user installing a published release by choice | PASS — stale CSP range; `EvFlags::EV_ADD` is not a nix type (`EventFlag`); everything else verified, including bun 1.3.14 and README lines 47-49/128/168/187-188/210/267-269 |
| C | PASS — D1–D6 | PASS — 7 files; all tasks verified | PASS — protection baseline per phase; `open omp://` only with a scratch instance running; `tccutil` with consent | PASS — `supervisor.rs` line numbers off by ~7 (63/297/319/327 vs 65/308/329/334); `libc-0.2.186:4901` is the local registry copy (lock pins 0.2.189) — true as stated |
| D | PASS — six rows | PASS — 7 files; all tasks verified | PASS — go-ahead before every push incl. per-phase CI pushes and the site push | PASS — one dubious performance claim (`system_profiler` 1-3 s) used to justify a parent-plan deviation; `show_and_make_key` does not exist but the step defers to grep output |
| E | PASS — six rows | PASS — 7 files; all tasks verified | PASS — go-ahead on pushes/tags/releases; `lsregister -u`; TCC reset only if the user agrees | PASS — stale CSP range; `release-feeds.ts:229-252` is `222-246`; Task 4.3 says the `PredefinedItem` enum is in `menu.rs` (it is `windows.rs:66`) |

No disqualification.

## Scores (1-20)

| Criterion | A | B | C | D | E |
|---|---|---|---|---|---|
| 1 Gap coverage | 18 | 16 | 15 | 17 | 14 |
| 2 Sequencing & risk ordering | 19 | 18 | 14 | 17 | 16 |
| 3 TDD rigor | 19 | 17 | 17 | 17 | 14 |
| 4 Executor-proofness | 18 | 17 | 15 | 17 | 14 |
| 5 macOS verification strategy | 18 | 18 | 17 | 17 | 14 |
| 6 Release & removal correctness | 18 | 16 | 16 | 14 | 15 |
| 7 Proportionality | 17 | 17 | 15 | 14 | 16 |
| **Total** | **127** | **119** | **109** | **113** | **103** |

### Rationale per candidate

**A (127).** Gap coverage: closes every scout gap, plus three the scout missed — nspanel plugin registration (verified panic path), RAM (`sysctl hw.memsize`), per-profile WKWebView storage — and correctly re-classifies the stale "Show-in-Finder PARTIAL" (`updater/mod.rs:452` already calls `reveal_in_folder`; `lib.rs:220-222`). Misses focus-steal (E checks tao's `set_focus` in source) and leaves the Intel buttons on `site/index.html:390,528`. Sequencing: the Phase-1 signing spike (Task 1.7: ad-hoc + `--options runtime` on the real sidecar, pack check, `log show` for library validation, pre-authorized `disable-library-validation`) de-risks the single highest-impact unknown before any bundling; Phases 4/5 are file-disjoint; removal is split move-then-delete with an `electron-final` tag and a one-commit delete. TDD: every behavior change has a red Verify with the expected failure text and "passing is a failure"; the new supervisor test (`a_dead_parent_ends_supervision_even_when_the_control_channel_stays_open`, holder with `FD_CLOEXEC` cleared) is the only candidate test that proves the kqueue arm on both OSes; the regression gate enumerates clippy/test/parity loop/snapshots/vitest/types/biome. Verification: TS harness with unit-tested parsers, nine cases including entitlement key-set equality and hard-kill, `open -n --env` so the app (not Terminal) is the TCC client, 15 exact human rows, and a full LaunchServices/TCC/WebKit cleanup keyed on the Task 1.1 baseline. Removal inventory: 15 rows with `file:line`, all three `include_str!` sites, both Rust fixture paths, 41 parity entries — only the `rpc-bridge` import is missing. Executor-proofness: decision points are written as recorded "fact N" lines; the first-compile fix rules are explicit. Weak spots: the accelerator-mapping chord guard (Task 5.4) is heavier than the id/focus guard B, C and E use; `cargo update -p tauri-nspanel` after removing the dep is the wrong refresh command; Task 2.3 makes a committed test depend on a plan report file.

**B (119).** The most host-aware plan (bun 1.3.14, `assistant-pack` CI job, exact README lines) and the best fixture inventory (`rpc-limits.ts`). Strong smoke (`omp --smoke-test` on the signed sidecar, 16 checks, `lsregister -u` in `finally`), good sitting table, merge-before-v0.9.17 guard, post-release download check. Loses to A on: no nspanel `init()` (runtime panic surfaces only in the sitting), no per-profile storage, no signing spike before packaging, `i18n.rs:201` absent from the removal table (its own Verify grep would flag it, but with no instruction), red-by-commenting-out-code in Task 3.5, `EvFlags` slip, README.vi not updated, Linux cross-check task of little value.

**D (113).** Most thorough supervisor design (zombie filter via `proc_pidinfo`, tracked set swept by `ppid == 1 || pgid == omp`, `an_escaped_tool_dies_when_omp_exits_on_its_own`), real codesign integration test on a fake `.app`, red smoke against the pre-change bundle, zsh-glob and TCC-responsible-process warnings, panel `make_key` on show (the only candidate to act on focus steal). Costs: renderer-side chord blocking touches Electron code before removal and rests on WKWebView consuming ⌘W before the menu (flagged as a risk); new `unsafe` in `hardware.rs` beyond the parent's allow-list on a justification the host contradicts; no unit tests for the bash smoke; removal inventory misses `assistant_pack.rs:462/:538`, `i18n.rs:201`, `manager.rs:1100`, `shell_env.rs:359` and the `rpc-bridge` import — five breaks that surface only at the Task 7.8 `cargo test`.

**C (109).** Excellent precision where it looked (CSP lines, site lines, libc line, `e2e-tauri` importers, `windows.rs:1617`), the only plan with a real update-reveal check (fake feed via `SAI_ATLAS_UPDATE_BASE`), unit tests for the kqueue/descendant primitives, a dev-run in Phase 1, and the fullest `include_str!`/`ports.rs:848` list. Costs: **never fixes RAM**, so its own H1 row ("Ollama window shows this Mac's GPU name") cannot pass (`read_machine` returns `None` at `hardware.rs:245-247` before the GPU probe runs); Phase 6 merges to `main` first and then commits feed/floor/docs/version changes on `main` outside branch CI; H9 depends on Phase 6 Task 6.3 (circular, patched with "DEFERRED"); deletes `tsconfig.node.json` (its `types: ["node"]` scripts coverage would move under the renderer tsconfig); retires the parity gate entirely including the three `src/shared` entries; the sitting launches the binary from Terminal, so the TCC prompt names Terminal; `resolve_pack_dir` candidate is not gated on a `MacOS` parent; misses the two Rust fixture paths.

**E (103).** Exact supervisor line map, correct `ports.rs:848` handling, focus-steal source check, a precise tray-mark `.rgba` layout, the most complete Linux-host command list for the release. Costs: **never fixes RAM**; Task 3.1 asserts the existing supervisor tests pass on macOS without changing `SLEEP_BIN=/usr/bin/sleep` or the `setsid` `TOOL_TREE`, so the executor stops there; proxy implements HTTPS only although its own Decision says "else HTTP"; no nspanel `init()`; removal inventory omits `e2e/sidecar-fixture.ts` entirely (four breaks); `release-feeds.ts` line range stale; weak "red" tests that grep file text; no post-release check; sitting launches from Terminal (TCC naming).

## Ranking, winner, margin, confidence

1. **A — 127** (winner)
2. B — 119
3. D — 113
4. C — 109
5. E — 103

- **Margin: high** by the stated rule — A leads B by 8 overall and by 6 on the deciding criteria 1+3+6 combined (2 points on each). Caveat: no single criterion separates A from B by more than 2; B is a credible plan, not a distant second.
- **Unanimous: yes, with ties** — A is strictly first on criteria 1, 2, 3, 4 and 6 and tied with B on 5 and 7.
- **Confidence: 0.8.** Every path/symbol/line claim that decides the ranking was checked against the repo or the pinned crate source; the residual uncertainty is in judgment calls (how much weight the nspanel panic and the signing spike deserve versus B's bun/fixture catches).

## Defects and gaps in the WINNER (A) for the red-team pass

Ordered by impact. Each is something another candidate got right or a wrong fact.

1. **Removal inventory misses the fixture's own import.** `e2e/sidecar-fixture.ts:5` imports `RPC_MAX_FRAME_BYTES, RPC_MAX_REASSEMBLED_BYTES` from `../src/main/rpc-bridge`. A's Task 9.5 moves the fixture to `e2e-tauri/` but leaves that import; Task 10.1 then deletes `src/main`, and `bun run check:types` (which covers `e2e-tauri` through `tsconfig.wdio.json`, `package.json` `check:types`) fails. Fix in Task 9.5: move the two constants to `src/shared/rpc-limits.ts` (B Phase 9 Context row 4) or inline them (C Task 7.2 step 5), and make Task 9.5's Verify grep include `src/main/` over `e2e-tauri`.

2. **Stale CSP test line range.** Phase 9 table and Task 9.6 cite `src/main/packaging-config.test.ts:361-437`. The three tests are at `:279` ("cannot fetch a remote image for markdown a model wrote"), `:285` ("keeps script execution and network calls inside the app") and `:340` ("the quick-entry page ships the same content security policy"); the range was inherited from `plans/261002-1441-tauri-shell-migration/phase-12-…md:63`. C Task 7.5 and D Context table have the correct lines.

3. **Supervisor snapshot never covers "omp exits first".** Task 4.2 step 4 snapshots before `kill(omp, SIGTERM)` and before `killpg`, but the `status = child.wait()` arm (omp exits on its own) has no snapshot, so a tool that left omp's group survives that path. B Task 3.3 step 4, D Task 3.4 step 2 and E Task 3.3 step 6b refresh the snapshot on a 0.5–1 s interval arm; D adds the test `an_escaped_tool_dies_when_omp_exits_on_its_own`. Either add the interval arm plus that test, or state the limit in the module doc as C Task 3.2 step 5 does.

4. **Host bun version is below the repo floor.** `bun --version` prints 1.3.14; README line 168 requires ≥ 1.4 and `scripts/tauri-linux-build/Dockerfile:58` pins 1.4.2. A's Phase 1 never checks it. Add B's Task 1.1 step 1 (check, then ask before `bun upgrade --version 1.4.2`) before `bun install`, or the lockfile and vitest behaviour may differ from CI.

5. **`cargo update -p tauri-nspanel` is the wrong lock refresh.** Task 1.6 step 3 runs it after removing the dependency; cargo rejects a package spec that is no longer in the graph. B Task 1.5 step 2, C Task 1.5 step 4 and D Task 1.10 step 2 run a plain `cargo check` to let Cargo drop the entry.

6. **`set_collection_behaviour` takes a typed bitflag, not an `i32`.** Task 5.3 step 2 says "use named constants like the existing `NS_NONACTIVATING_PANEL_MASK`" (an `i32`). The crate signature is `set_collection_behaviour(&self, behaviour: NSWindowCollectionBehavior)` (`raw_nspanel.rs`), so the executor needs the cocoa/objc2 type the crate re-exports; `set_style_mask` is the `i32` one. Tell the executor to construct the behaviour from the type fact 1's grep prints (C Task 4.5 step 3 says "converted to the type the grep shows").

7. **`data_store_identifier` needs macOS ≥ 14 while the floor is 13.3.** Task 5.6 step 3 anticipates a panic guard only conditionally ("if fact 3 says it panics below macOS 14"). docs.rs states the ≥ 14 requirement outright; make the version guard unconditional (or accept shared WebKit storage on 13.x and write that down), and note that `data_directory` is a no-op in WKWebView so the Linux call stays harmless.

8. **The Intel download buttons stay on the public site.** `site/index.html:390` and `:528` carry `data-omp-dmg="x64"` buttons, `:7` says "macOS arm64 / x64", and `:648` loops over `["arm64", "x64"]`; with arm64-only releases the Intel button resolves to nothing. C Task 6.4 step 5 and D Task 6.4 step 4 remove them. Add to Phase 7 (a push touching `site/**` deploys Pages, so it needs go-ahead per AGENTS.md).

9. **The chord guard is heavier than it needs to be.** Task 5.4 rebuilds the app-menu model inside `on_menu_id` to find an item's accelerator and maps it onto `is_blocked_menu_chord`. B Task 5.2 step 1, C Task 4.3 and E Task 4.3 step 1 use `platform == Darwin && focused() == Some(WindowId::QUICK_ENTRY) && id is an app-menu id` — the same behaviour (every app-menu action from the bar is dropped; predefined edit items never reach `on_menu_id`, `menu.rs:161-186`) with a two-line change and a simpler red test on the fake backend (`windows.rs:1276` `focused: Mutex<Option<WindowId>>`). Also record E's risk: a non-activating panel may not be reported as focused, in which case the human ⌘W row is the only catch.

10. **A committed test reads a plan report.** Task 2.3 step 4 makes `tauri-packaging-config.test.ts` append `disable-library-validation` "only if the host log holds `entitlements: add disable-library-validation`". Tests must not depend on `plans/**`. Use D Task 2.7 step 3's shape instead: when the spike proves the key is needed, change the test expectation and `omp.entitlements` in the same commit (the existing test at `scripts/tauri-packaging-config.test.ts:546-554` already asserts the exact dict).

11. **Smaller items.** (a) `ports.rs:848` asserts `entry.ts.starts_with("src/main/")` over `contracts/cross-module-calls.json`; it reads no file, so it keeps passing after deletion — note it as kept (E Context table) so the executor does not "fix" it. (b) Task 6.4 runs `tccutil reset Microphone vn.io.vif.saiatlas` without asking; safe given the Task 1.1 baseline, but B/C/E ask first — keep the asking habit. (c) `check-module.sh:105` is the `cargo test --features e2e-hooks` line; the `bun run build:renderer:tauri` caller is `:107`. (d) Task 7.2 deletes `--electron-mac-feed` before the release; harmless only because Phase 8's precondition guarantees Linux 0.9.17 has already shipped from `main` — say so, or keep the branch until Phase 10 as B/C do. (e) Phase 5 could add E's one-line source check that tao's `set_focus` activates the app (Electron used `app.focus({ steal: true })`, `src/main/quick-entry.ts:363`), so the "submit brings the chat window forward" row has a static backing.

## What the controller should carry over from the losers

- B: `src/shared/rpc-limits.ts` move (defect 1); bun version check (defect 4); `omp --smoke-test` run from inside the signed bundle as a smoke case; CI `tauri-macos` job (optional, not in the request).
- C: correct CSP line numbers (defect 2); the fake-feed update-reveal check (`SAI_ATLAS_UPDATE_BASE` is `option_env!` at `updater/feed.rs:17`) if a real pre-release update check is wanted; `tauri-dev.ts:86` `ss` → `lsof` port probe (the process-management rule asks for a deterministic port and a stale-owner check, which silently never fires on macOS today).
- D: zsh-glob advice for every command with a glob (this verifier hit it); the `an_escaped_tool_dies_when_omp_exits_on_its_own` test; the real-codesign test on a fake `.app`.
- E: tao `set_focus` source check; the `include_bytes!` tray-mark layout if the parent plan's `.rgba` decision is kept (A moves the `.ts` instead; both work, A's is smaller).

Status: DONE
Summary: Candidate A wins 127/140 over B 119, D 113, C 109, E 103; all five pass H1–H4; eleven concrete red-team fixes for A are listed with file:line evidence.
