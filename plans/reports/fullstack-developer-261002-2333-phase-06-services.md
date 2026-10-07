# Phase 6 Implementation Report — module `services`

- Plan: `/home/tung491/WORK/oh-my-pi-gui/plans/261002-1441-tauri-shell-migration/phase-06-data-system-services.md`
- Worktree: `/home/tung491/WORK/worktrees/tauri-services`, branch `tauri/services`, base `10cf8a5`
- Status: **DONE**

## Commits (in order)

| Commit | Task | Summary |
|---|---|---|
| `8feb21b` | 6.1 | `session_cache.rs`, `models_config.rs`, `provider_cleanup.rs`, `dialog_memory.rs`, `open_path_target.rs` |
| `47bbd93` | 6.2 | `session_index.rs` + sessions:*, session:open-new-window/consume-pending handlers |
| `e8cd909` | 6.3 | `fs.rs` + fs:list/read/read-plan/read-image handlers |
| `43b98b8` | 6.4 | `dialogs.rs`, `system.rs`, `editor.rs` + system:*/editor:open-external handlers |
| `b786b62` | 6.5 | `log_watcher.rs`, `host_tools.rs` + prefs:*/models:*/provider-cleanup:*/log:snapshot, `execute_host_tool` |
| `d2717c7` | 6.6 | `legacy_storage.rs` (one-time Electron localStorage import) |
| `4534a7d` | — | merged from `tauri/foundation` (controller's fix to the frozen `bridge.rs` test; see Task 6.7) |
| `604c448` | 6.7 | clippy-gate fixes |
| `04a3bff` | 6.7 | merge of `tauri/foundation` |
| `c42f652` | 6.7 | module-gate capstone commit |

## Task 6.1 — Pure ports with tests

Ported `StampedLru` (`session_cache.rs`), `models-config.ts` (`models_config.rs`, using `serde_yml::Value` for YAML access since the TS `yaml` package's CST editing has no stable-Rust equivalent in this crate's frozen dependency set), `provider-cleanup.ts` (`provider_cleanup.rs`), `dialog-memory.ts` (`dialog_memory.rs`), and `open-path-target.ts` (`open_path_target.rs`, with `launchable-path.ts`'s needed functions ported privately since that file is frozen shared code).

- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- services::session_cache services::models_config services::provider_cleanup services::dialog_memory services::open_path_target` → **31 passed** (≥ 30 required).

**Deviation (documented, not a workaround):** `provider_cleanup.rs`'s YAML editing uses `serde_yml::Value`/`Mapping` (which preserves key order via its internal `IndexMap`) rather than a comment-preserving CST like the TS `yaml` package. To still pass "backs up byte-identically... and a second run is a no-op" (which checks the file still contains the original leading `# hand-written config` comment), the function manually preserves the file's leading contiguous comment/blank-line block and prepends it to the re-serialized document. Inline/trailing comments elsewhere in the file are not preserved after an edit — this only matters the one time this migration runs per install, and the backup keeps the original byte-for-byte. The top-level-alias refusal (`providers: *anchor`) is detected with a line-anchored string check (`strip_prefix("providers:")` at column 0) rather than full YAML anchor/alias introspection, since `serde_yml` resolves aliases away during deserialization. Both are proportionate to the one ported test file's actual assertions; flagging here in case a future `models.yml` with unusual structure needs stronger handling.

## Task 6.2 — Session index and watcher

`session_index.rs`: directory-parameterized `SessionIndex` (list/search/kind-lookup/delete, parse+search caches via `StampedLru`, a `notify`-backed directory watcher). `Services::new` wires it to `paths::agent_dir().join("sessions")`; `services::init` registers the change listener that broadcasts `sessions:changed` and starts the watcher. Ported `sessions:list/delete/rename/search`, `session:open-new-window`, `session:consume-pending` in `ipc.rs`, matching the ownership/live-sidecar rules in `ipc.ts:577-654` exactly (including the mid-task clarification from the `tabs` module integration note: `command_for_idle_session`'s `None` means "no live idle owner", a delivery failure is `Some(response)` with `success:false`, both already handled correctly by the shared `rpc_response_ok` helper).

- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::session_index` → **3 passed**.

**Deviation:** no dispatch-level (`bridge::dispatch_for_test`) tests were added for `sessions:*`/`models:*`/`provider-cleanup:*` channels, because the production `Services::new` resolves `paths::agent_dir()` for real; a dispatch test exercising those handlers without an explicit directory override would read/list the user's actual `~/.omp` tree, which the harness's baseline-protection rule forbids. `SessionIndex`'s own logic is fully unit-tested against temp directories instead; only the handler glue (payload parsing, routing) is uncovered by a dispatch test, and it was reviewed by hand against `ipc.ts` line-by-line.

## Task 6.3 — Workspace files

`fs.rs`: `resolve_within`, gitignore-style `load_ignore_rules`/`walk_workspace`, `clamp_int`, `read_file_capped`, `sniff_image_mime`, keeping the trust contract exactly (relative paths workspace-confined via lexical resolution, absolute/`~` paths read as given) and every constant (`FS_LIST_*`, `FS_READ_*`, `FS_IMAGE_MAX_BYTES`). `fs:list/read/read-plan/read-image` ported in `ipc.rs`.

- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::fs` → **7 passed**.

## Task 6.4 — Dialogs, system actions, editor

`dialogs.rs` (per-window `DialogMemory`, cleared on `ctx.desktop.on_window_closed`), `system.rs` (allowed-URL check, `NotifyDedupe`, the open-path launch decision wired to `open_path_target`), `editor.rs` (temp file + `tokio::process` spawn, `PATH` from `ctx.omp.spawn_env()`). All `system:*` and `editor:open-external` handlers ported in `ipc.rs`.

- Verify: `cargo test --manifest-path src-tauri/Cargo.toml -- services::system services::dialogs services::editor` → **13 passed**, including one `bridge::dispatch_for_test` dispatch test per `system:*` channel (open-external, open-path, save-dialog, open-dialog, clipboard-read, notify) using the `testing.rs` fakes.

## Task 6.5 — Prefs, logs, models, provider cleanup, host tools

`log_watcher.rs`: directory-parameterized `LogWatcher` (1,000-line ring buffer, 150 ms flush, poll-based tail that also covers new-file discovery — a deliberate simplification of the TS source's `fs.watch` + 15 s poll fallback into one mechanism, since no test exercises the exact mixed-mechanism timing, only the eventually-consistent line delivery). `host_tools.rs`: `gui_open_url`/`gui_notify`/`gui_clipboard_read`. `prefs:get/set` wired over `ctx.prefs` with the main-owned-key refusal, the `language` → `rebuild_menu()` call, and `StoreError::Unreadable` rejected as `IpcError`. `models:providers-list` and `provider-cleanup:config` wired to their Task 6.1 modules. `ServicesPort::execute_host_tool` and `ServicesPort::shutdown` (stops both the session-index watcher and the log watcher) implemented.

- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::` → **63 passed**; `grep -c "IpcError::not_ported" src-tauri/src/services/ipc.rs` → **0**.

## Task 6.6 — One-time Electron localStorage import

`legacy_storage.rs`: copies `Local Storage/leveldb` to a scratch directory (own hand-rolled temp-dir guard, since `tempfile` is a dev-only dependency and this code path runs in production), opens the copy read-only with `rusty-leveldb`, decodes Chromium's `0x01`-Latin-1 / `0x00`-UTF-16LE value format for the five `RENDERER_STORAGE_KEYS`, writes them under `rendererStorage.*` in `prefs.json`. Runs only when `prefs.json` has no `rendererStorage` subtree. Any failure logs one runtime entry and imports nothing; never blocks startup.

- Verify: `cargo test --manifest-path src-tauri/Cargo.toml services::legacy_storage` → **4 passed**.
- **On-machine validation performed:** copied `~/.config/@oh-my-pi/omp-gui` (read-only copy, original untouched) to a scratchpad path and ran the importer against the copy via a temporary `#[ignore]` test (removed before committing — never left in the tree). Raw-key dump of the copy's LevelDB showed this machine's profile is from a **dev-mode** Electron run (keys prefixed `_http://localhost:5173\0\x01...`), not a packaged build (`_file://...`), so the import correctly found nothing (`rendererStorage = null`) — expected, not a bug: the phase pins the key prefix to `file://` deliberately (the packaged app's real origin), and the dump confirmed the value-decoding logic is correct against real Chromium bytes (`omp.lang` → format byte `0x01` + `en`).
- **NEEDS-HUMAN:** comparing the imported values against a packaged 0.9.15 build's own DevTools localStorage requires an actual packaged build and visually opening DevTools, which this session cannot do. Steps for a human: (1) launch the packaged `Sai ATLAS`/`omp` 0.9.x build once so it writes to `~/.config/@oh-my-pi/omp-gui/Local Storage/leveldb`; (2) open its DevTools (if available) or inspect `localStorage` via a debug build, and note the five `omp.*` key values; (3) run the Tauri build once against a copy of that same profile with `--user-data-dir=<copy>`; (4) confirm `<copy>/prefs.json`'s `rendererStorage.*` values match what DevTools showed.

## Task 6.7 — Module gate and commit

**Failure Protocol invoked once**, per the phase's explicit instruction. `cargo test --all-features` (gate 8) failed on exactly one test, `bridge::tests::runtime_log_path_answers_through_the_dispatcher` in the frozen `src-tauri/src/bridge.rs`, which (from Phase 2) hard-coded the assumption that `services`'s `fs:read` channel would remain an unported stub forever — a structural conflict with Task 6.3/6.5's explicit requirement that `fs:read` be fully ported. I could not edit `bridge.rs` (frozen, outside module ownership), so I spawned `kongming` with the full evidence (exact command/output, the frozen test body, why no in-module workaround exists) rather than self-reasoning around it. Kongming's verdict: a plan bug in the frozen test, to be reported `BLOCKED` with a proposed fix (replace the `fs:read` probe with a test-local `not_ported` channel) for the controller to land on `tauri/foundation`.

Before I could report `BLOCKED`, the controller intervened directly: it had already landed the fix on `tauri/foundation` (commit `4534a7d`, replacing the probe with a dedicated `test:stub` channel and renaming the test to `a_stub_handler_error_reaches_the_caller`) — the same class of fix kongming recommended. I merged `tauri/foundation` into `tauri/services` (`git merge --no-edit tauri/foundation`, clean merge, only `bridge.rs` touched, via the merge — not by me) and re-ran the gate.

- Verify: `bash scripts/check-module.sh services` → **`check-module services: PASS`** (gate 9's two cross-target WARNs are expected on this host, no Apple/MSVC SDK; per Wave rules these prove nothing about those platforms).
- `cargo test --manifest-path src-tauri/Cargo.toml --all-features`: both the default and `--features e2e-hooks` runs are green (143 passed in `--lib`, plus `channels.rs`'s 2 tests).
- `git diff 10cf8a5 -- src-tauri/contracts` → empty.
- `bun scripts/check-test-parity.ts services` → `35 tests mirrored across 7 files`.
- No `todo!`, `unimplemented!`, `#[ignore]`, or `IpcError::not_ported` remains anywhere in the module.
- Also fixed, in the same pass: the `check-module.sh` clippy gate (gate 4) flagged several issues across the earlier commits (a regex-based SVG sniff and a YAML-alias check each using `Regex::new(...).unwrap()`, two `Options::default()` + field-reassignment patterns in `legeacy_storage.rs`, a complex `Mutex<Option<Box<dyn Fn…>>>>` field type, a `let-else` clippy preferred as `?`, and a `&String` test-helper parameter required by a generic bound). All fixed in `604c448` with `cargo clippy --all-targets --all-features -- -D warnings -D clippy::unwrap_used -D clippy::expect_used` now clean.

## Deviations summary

1. `provider_cleanup.rs` round-trips YAML through `serde_yml::Value` (key order preserved via its `IndexMap`-backed `Mapping`) with a manually preserved leading-comment header, rather than a comment-preserving CST; the top-level-alias refusal is a line-anchored string check rather than full anchor/alias introspection. Both satisfy every ported test; noted as a fidelity trade-off forced by the frozen dependency set (`serde_yml` only).
2. `log_watcher.rs` uses one polling mechanism (tick well under the 150 ms flush interval) for both new-file discovery and tailing, rather than the TS source's `fs.watch` + separate 15 s poll fallback. Simpler, and at least as responsive; the ported test only asserts eventually-consistent delivery, not the specific dual-mechanism.
3. No dispatch-level tests for `sessions:*`, `models:*`, `provider-cleanup:*` channels (handler logic reviewed by hand instead), to avoid any test touching the real `~/.omp` tree through `Services::new`'s production `paths::agent_dir()` resolution. `SessionIndex`, `models_config`, and `provider_cleanup`'s own logic is fully unit-tested against temp directories.
4. `legacy_storage.rs`'s production code builds its own tiny temp-directory guard instead of using the `tempfile` crate, because `tempfile` is a dev-only dependency and the import runs at real startup, not just in tests.

## Processes

No long-running processes were started or left running by this phase (all work was `cargo build`/`cargo test`/`bash scripts/check-module.sh`, each completing synchronously). Confirmed no stray `tauri-services`/`sai-atlas` processes at the end of the session.

## Baseline protection

`prefs.json` mtime: `1790910017` (unchanged, start and end). `logs/gui-runtime.jsonl` mtime: `1790951349` (unchanged, start and end). The one read of the real profile (Task 6.6's on-machine validation) was read-only, against a throwaway copy in the scratchpad directory, which was deleted afterward; the temporary test code that drove it was never committed.

## Unresolved questions

None blocking. The one NEEDS-HUMAN item (Task 6.6's DevTools comparison against a packaged build) is optional corroboration, not a blocker: the decoder logic is independently verified against real Chromium-encoded bytes found in the dev-mode profile's LevelDB, and all 4 of the task's own tests (including a from-scratch LevelDB fixture built with real Chromium-shaped keys) pass.

Status: DONE
Summary: All seven tasks of Phase 6 ("services") are implemented, tested, and committed on `tauri/services`; the module gate passes (`check-module services: PASS`), `cargo test --all-features` is green, contracts are untouched, and test parity holds. One Failure Protocol stop (a frozen foundation test's stale assumption) was resolved by the controller landing a fix on `tauri/foundation`, which I merged in cleanly.
Concerns/Blockers: None. One NEEDS-HUMAN item recorded above (optional DevTools corroboration for Task 6.6, not required by the phase's own Verify).
