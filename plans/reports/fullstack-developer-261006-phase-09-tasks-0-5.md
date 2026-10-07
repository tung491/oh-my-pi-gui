# Phase 9 Implementation Report: Tasks 9.0–9.5

## Executed Phase
- Phase: phase-09-copy-and-release, Tasks 9.0 through 9.5 (stop before 9.6)
- Plan: /home/tung491/WORK/oh-my-pi-gui/plans/261005-0812-everyday-work-rebrand
- Worktree / branch: /home/tung491/WORK/worktrees/rebrand-integration, `rebrand/everyday-work`, started at a8cd2c5 (`rebrand-wave-c-fixed`)
- Status: **completed through Task 9.5; stopped before Task 9.6.** Nothing was tagged or pushed.

Task 9.0 closed after the coordinator approved the two Electron spec fixes and step 2e. With both applied, both e2e suites and the full gate pass. **Commit to tag `rebrand-pre-release`: bd1936b.** I did not create the tag. Tasks 9.1 to 9.5 followed. The full gate passes at the final commit, 18d2806.

One Verify command was defective. In Task 9.4, `rg -o … README.md README.vi.md | xargs ls` can never pass, because rg prefixes each match with its file name when it searches two files. kongming confirmed this is a command defect, and the phase file's Verify line is corrected (details under Task 9.4).

## Commits on `rebrand/everyday-work` (oldest first)

| Commit | Step | Message |
|---|---|---|
| 7c06533 | 9.0 step 2 | refactor(ipc): drop menu and tray actions that no longer exist |
| 32e479f | 9.0 step 2a | refactor(quick-entry): read a sent or saved chat target as Work |
| 597af19 | 9.0 step 2b | build(linux): recommend libglib2.0-bin for opening apps with gio |
| 20bb7cb | 9.0 step 2c | fix(ui): refuse the model preset command |
| a39e8da | 9.0 step 2d | fix(ui): say why no model is listed when Ollama runs elsewhere |
| 06bab66 | 9.0 step 3 | test(e2e): follow the everyday-work UI |
| fcd779a | 9.0 step 2e | fix(ui): count a local Ollama with models as set up |
| bd1936b | 9.0 step 3 (approved fixes) | test(e2e): wait for the scroll and resolve dotted preference keys |
| 6f82e3f | 9.1 | build: describe Sai ATLAS as an everyday-work assistant |
| 14b2aea | 9.2 | fix(ui): use everyday words for the new task, welcome and composer copy |
| ffb80da | 9.3 | docs: describe Sai ATLAS as a private assistant for everyday work |
| d141c44 | 9.4 | docs: show three office tasks in the screenshots |
| 18d2806 | 9.5 | docs: record the move to everyday work in the changelog |

## Task 9.0, step by step

### Step 0: sidecar link
- `resources/omp` did not exist; I created it as a symlink to `/home/tung491/WORK/oh-my-pi-gui/resources/omp.linux-x64` (gitignored).

### Step 1: merge local `main`
- `git merge --no-ff main` printed `Already up to date.` (exit 0). This is a no-op, as expected, because `main` (7677ba1) was already an ancestor.

### Step 2: `MenuAction` trim (7c06533)
- The union now holds:
  - the 16 menu Keep ids from Phase 7 Context;
  - the four ids the tray still sends and `App.tsx` still handles: `toggle-fast`, `cycle-thinking`, `toggle-language`, `switch-project`.
- 19 ids are removed, `set-approval` among them.
- `MenuActionPayload.approvalMode` is removed; only `set-approval` carried it. The bridge (`create-omp-api.ts`) forwards the payload generically and names no `set-approval` entry, so nothing there needed deleting.
- **Deviation:** the step says `check:types` must pass with no other edit. It failed only because `src/main/menu.test.ts` (from Phase 7) typed its list of removed ids as `MenuAction[]`.
  - kongming confirmed my reading of the Keep set and approved retyping that list as `readonly string[]` (and `Set<string>`), with the same 18 ids and the same assertions.
  - The edit is folded into this commit. `src/main/menu.test.ts` is outside Phase 9's ownership list.

### Step 2a: quick-entry `chat` target (32e479f)
- The `{ kind: "chat" }` member and `QuickEntryTarget::Chat` are gone.
- `parseTarget` / `parse_target` read `"chat"` as Work, and both initial-target resolvers fall back to Work.
- The renderer mappings `taskTarget` and `case "chat"` are deleted.
- Tests were renamed exactly as the phase file specifies, with their Rust twins renamed the same way.
- The bar test "turns a stored chat target into the Work task target" is deleted: the bar can no longer receive a chat target, and the mapping is now covered by the main-process cases in both shells.

### Step 2b: `libglib2.0-bin` (597af19)
- Added as the last Recommends entry in all three places, with one comment line naming `gio launch`.
- Confirmed in `assistant-pack/src/tools/os-commands.ts:286` (`[context.gioPath, "launch", desktop]`).

### Step 2c: `/modelpreset` (20bb7cb)
- Added to `REMOVED_COMMANDS` with the one-line reason.
- Added the case "blocks the model preset command, which writes the user's global config", covering `/modelpreset` and `/modelpreset list`.
- omp registers no alias for it (`builtin-modes.ts:814`).

### Step 2d: Ollama on another computer (a39e8da)
I ran the Tauri dev build on display :99 with a throwaway HOME and profile and `OLLAMA_HOST=http://192.168.1.50:11434`:
- The welcome screen showed "Ollama is installed but not answering. Starting its service should be enough." with a Start Ollama button. Every card said "Already downloaded? Unknown — Ollama did not answer."
- After "Set up later", the model chooser showed only "No local models yet" and "Open Ollama settings" (0 models). Nothing said why.
- Fix: the chooser's empty state now adds "Sai ATLAS only uses Ollama running on this computer." / "Sai ATLAS chỉ dùng Ollama chạy trên máy tính này." (key `modelPicker.localOnly`, in both locales).
- Component test: "says the empty list holds only Ollama running on this computer". It failed first, then passed.
- The welcome screen's misleading "start its service" advice for an off-box `OLLAMA_HOST` is outside this step's ownership (only the empty-model-list component); see Unresolved questions.

### Step 3: e2e (06bab66, both shells)
Changes by category:
- **Removed controls (Phases 2, 3, 7):**
  - deleted "opening sharing…" (`/share`);
  - deleted "security distinguishes…" (the Permissions & security page);
  - removed the `/live` half of "voice and side question…", renamed "a side question requires an explicit start" (`/btw` still exists).
- **Counted or named removed surfaces:**
  - "settings expose seven groups…" (count 7);
  - real-core names "Hệ thống & Nâng cao" and loops over 7 groups;
  - deep-audit: removed commands must now be absent from the palette (`removedListed` must be empty), where the old check listed 22 removed commands as "missing".
- **Phase 8 UI (342b354 dropped the launch-profile system-prompt field):** the two settings cases now drive the session-directory field, which goes through the same save path. Every assertion is kept.
- **Quick entry:**
  - new tabs are `agent`;
  - "quick entry opens the Work workspace by default" (the "Agent" button is gone);
  - "quick entry sends a leading ! as text, never as a shell command": Phase 2 (dcff2af) removed the composer's shell mode, and the bash count must stay unchanged.
- **Deep-audit local-only rules:**
  - (a) A condition gate is skipped (`write: "skipped-no-control"`, note "condition gate `<path>` is pack-pinned") when the gate key's schema entry has the `overlay` provenance layer and its effective value differs from the gate's value. This covers `memory.backend` (hindsight, mnemopi) and, by the same rule, `plan.enabled` (`plan.defaultOnStartup`, `plan.autosave`, `plan.autosaveDir`). kongming accepted the generalisation.
  - (b) Model and provider custom strings assert "Only models that run on this computer can be used." and record `skipped-no-control` with the specified note.
- `bun e2e-tauri/check-twins.ts`: "9 spec file(s), 42 test(s), every twin matches".

## Verify lines (Task 9.0)

| Verify | Output | Met |
|---|---|---|
| `git merge-base --is-ancestor main HEAD` | exit 0 | yes |
| Full gate (below) | every command exit 0 | yes |
| Both e2e suites exit 0 | at bd1936b: Electron exit 0 (33 passed, 9 skipped by their env gates); Tauri exit 0 (9 of 9 spec files) | yes |
| `rg -n 'awaiting user confirmation' plans/reports/spike-261005-everyday-work-rebrand.md` | nothing | yes |
| the three `QuickEntryTarget`/`"chat"`/`::Chat` greps | nothing (rc 1 each) | yes |
| `bunx vitest run src/renderer/lib/command-availability.test.ts`; `rg -n '"modelpreset"' …` | 30 passed; one line (`90: "modelpreset",`) | yes |
| `bunx vitest run scripts/tauri-packaging-config.test.ts scripts/finalize-deb.test.ts`; `grep -c libglib2.0-bin …` | 51 passed; `1` and `1` | yes |

### Full gate at 06bab66 (`plan.md` "Shared commands")
- `bun run check:types`: 0
- `bunx vitest run`: 0. Test files: 208 passed, 1 skipped. Tests: 2104 passed, 5 skipped.
- `bunx biome check` on the 23 TS files touched since a8cd2c5: 0
- clippy `--all-targets --all-features -D warnings`: 0
- `cargo test --all-features`: 0 (764 + 3 + 2 + 3 passed)
- parity loop: 0. Counts: desktop 114, foundation 14, ollama 96, omp 37, services 39, tabs 46, updater 19.
- `bash scripts/check-module.sh snapshots`: PASS
- check-twins: 0

### e2e runs (display :99, throwaway HOME)

| Run | Electron (`bunx playwright test`) | Tauri (`bun run test:e2e:tauri`) |
|---|---|---|
| First, at 20bb7cb/a39e8da | 13 failed, 22 passed, 9 skipped | 5 of 9 spec files passed |
| Final, at 06bab66 | 2 failed, 31 passed, 9 skipped | 9 of 9 spec files passed (exit 0) |

Both builds were refreshed before the runs: `bun run build`, and `cargo tauri build --debug --features e2e-hooks --no-bundle`.

## Electron spec fixes (approved 2026-10-06, applied in bd1936b)

Both fixes change one line each, change no assertion and touch no app code. The analysis that led to the approval is kept below.

1. **`e2e/auto-follow.e2e.ts:64`, Electron only. Cause: a test timing race; this has been failing since before the rebrand.**
   - Baseline: the case fails identically on `main` 7677ba1 (temporary baseline worktree, same display, "Received: 59"). The spec has not changed since before the rebrand.
   - Trace: sampling the gap every 20 ms after the wheel gives `[59,1618,…]`, `[99,1658,…]`, `[0,1500,1500,…]`. The "jump to latest" control appears before Chromium's animated wheel scroll lands.
   - The Tauri twin passes, and no CI job runs e2e.
   - Fix: `expect(await gap()).toBeGreaterThan(LIVE_EDGE_PX)` → `await expect.poll(gap).toBeGreaterThan(LIVE_EDGE_PX)`. Optionally mirror it with `until` in the twin; the twin checker counts both forms the same.
2. **`e2e/real-core.e2e.ts:204`, Electron only. Cause: a defect in the spec's stand-in handler.**
   - The stand-in `prefs:get` returns `prefs[payload.key]`, a flat lookup. The seed stores `welcome.completed` nested, and the real handler resolves dotted keys (`prefsStore.get`, `src/main/ipc.ts:820-822`).
   - So the welcome gate gets `undefined` and opens the welcome over the window after the reload, and the welcome overlay intercepts the theme-button click at line 214.
   - The same flat lookup is on `main`; it was masked there and surfaced now. The Tauri twin overrides only the keyless boot call and passes.
   - Fix: resolve `payload.key.split(".")` over the snapshot, as the real handler does.

## Closing Task 9.0 after the approvals

- **Step 2e (fcd779a):** `hasUsableModelProvider` counts an allowed, non-disabled provider with at least one model, whatever its `authenticated` flag says. The startup gate reads the providers through `tabRpc.getProviders()`. A new test covers an unauthenticated Ollama with four models; it was red against the old code and is green now.
- **Spec fixes (bd1936b):**
  - `e2e/auto-follow.e2e.ts` polls the gap with `expect.poll`.
  - `e2e/real-core.e2e.ts`'s stand-in `prefs:get` resolves a dotted key as a nested path.
  - The Tauri twins have neither defect, so they are unchanged: the auto-follow twin's wheel lands within WebDriver's action, and the real-core twin overrides only the keyless call. `bun e2e-tauri/check-twins.ts` reports 42 tests and every twin matches.
- **Formatting fix:** while closing, the gate's Biome step flagged formatting in the step 2e files. I folded the formatting into fcd779a; the change was whitespace only.
- **Results at bd1936b, after `bun run build` and the e2e-hooks Tauri build:**
  - Electron: 33 passed, 9 skipped. The skips are the env-gated performance, legacy-core and packaged specs.
  - Tauri: 9 of 9 spec files passed.
  - The full gate: every command exits 0.

## Tasks 9.1–9.5

| Task | What changed | Verify |
|---|---|---|
| 9.1 | Tests first. `scripts/tauri-packaging-config.test.ts` asserts the description and `bundle.category` `Productivity`, and `src/main/packaging-config.test.ts` asserts `mac.category` `public.app-category.productivity` in both mac configs. These were red (2 failed), then I edited `package.json` `description`, `tauri.linux.conf.json` short and long descriptions, `tauri.conf.json` `bundle.category` and both electron-builder `mac.category` lines. | 72 passed (both files plus `finalize-deb.test.ts`) |
| 9.2 | `sidebar.newWork` "New task" / "Việc mới"; `welcome.continue` "Get started" / "Bắt đầu"; composer placeholder "Ask Sai ATLAS to draft a letter, tidy a spreadsheet, or make slides…" / "Nhờ Sai ATLAS soạn thư, sắp xếp bảng tính hoặc làm trang trình chiếu…". No locale value holds a tagline, and `rg -i "coding\|code agent\|developer"` on en.ts already printed nothing, so nothing else changed. No e2e spec matches the old strings. | locales and touched component tests: 95 passed; both rg checks print nothing |
| 9.3 | `README.md` is rewritten around the eight lines: what it is, privacy, local, Word, spreadsheet, slides, computer help and "your work stays yours". It keeps Install, Ollama, Shortcuts, Troubleshooting, Development and Release process, with no Windows steps. I deleted the Chinese half, the feature table, "What's new" and the gallery. The new `README.vi.md` covers the same sections in Vietnamese, using the app's own vi labels, and the two READMEs link to each other. `site/index.html` has the new hero, Word, Excel and PowerPoint blocks, a computer-help block, a privacy block with the exact sentence, and an install panel without Windows. The release-API script is byte-identical. | rg checks print nothing; the privacy sentence count is `1` in README.md and in site/index.html |
| 9.4 | `showcase-data.ts`, `showcase-fixture.ts` and `capture-showcase.ts` now replay one office task per app launch (`OMP_SHOWCASE_SCENARIO`): a local `gemma4:e4b` with an `office_report`, `office_clean` or `office_slides` card whose result is the pack's real `{file, kind, check}` JSON. Captures are made in en and vi. I removed `docs/screenshots/{en,zh}` and the top-level `*.webp`, added `docs/screenshots/{en,vi}/01-word-report.png`, `02-spreadsheet-cleanup.png` and `03-slides.png`, and replaced `site/assets/*.webp` with the three en shots (the logo svg is kept). I inspected the shots: each shows the new copy and the office card. The display was stopped afterwards. | `ls docs/screenshots/en \| wc -l` = 3. The literal rg command exits 123 (`ls: cannot access 'README.md:docs/screenshots/en/01-word-report.png'`), because rg prefixes the file name when it searches two files. The corrected command, `rg -o --no-filename 'docs/screenshots/[^)" ]+' README.md README.vi.md \| sort -u \| xargs ls`, exits 0, and the site's `assets/` references all exist (exit 0). The phase file's Verify line now carries the corrected command, on kongming's advice. |
| 9.5 | Under `[Unreleased]` → `### Changed`: the everyday-work entry (removed developer features, the omp terminal app for power users, no Windows builds) and the worktree-tab line. The existing line "macOS and Windows are unchanged…" now reads "macOS is unchanged…", so the section does not contradict itself. | "everyday work" prints line 7, under `[Unreleased]`; the worktree count is `1` |

### Final gate at 18d2806
Every command exits 0: types, vitest (2106 passed, 5 skipped), Biome on the touched TS files, clippy, cargo test, the parity loop, snapshots and check-twins. I also re-ran the Task 9.0 Verify greps at 18d2806, and they are unchanged.

## Files modified (whole phase so far)
- Task 9.0:
  - `src/shared/ipc-types.ts`
  - `src/main/menu.test.ts` (types only; ratified)
  - `src/main/quick-entry-core.ts` and its test
  - `src-tauri/src/desktop/quick_entry_core.rs`; the tests in `quick_entry.rs`
  - `src/renderer/quick-entry/QuickEntryBar.tsx` and its test
  - `src/renderer/lib/quick-entry-delivery.ts` and its test
  - `src-tauri/linux/finalize-deb.ts`
  - `src/renderer/lib/command-availability.ts` and its test
  - `src/renderer/components/dialogs/ModelPicker.tsx` and its test
  - `src/renderer/components/dialogs/FirstRunOnboardingDialog.tsx` and its test
  - `e2e/{auto-follow,deep-audit,desktop,quick-entry,real-core}.e2e.ts`, with twins for all but auto-follow
- Tasks 9.1–9.5:
  - `package.json` (description only)
  - `src-tauri/tauri.conf.json` (category only)
  - `src-tauri/tauri.linux.conf.json`
  - `electron-builder.yml` and `electron-builder.x64.yml` (mac.category only)
  - `scripts/tauri-packaging-config.test.ts`, `src/main/packaging-config.test.ts`
  - `src/renderer/locales/en.ts`, `vi.ts`
  - `README.md`, `README.vi.md` (new)
  - `site/index.html`, `site/assets/*`
  - `scripts/capture-showcase.ts`, `showcase-data.ts`, `showcase-fixture.ts`
  - `docs/screenshots/**`
  - `CHANGELOG.md`
- Plan record: the Task 9.4 Verify line in `phase-09-copy-and-release.md`.

## Cleanup
- Every process I started is stopped. `scripts/virtual-display.sh status` reports "display :99: not running" and "viewer: not running".
- The throwaway home is deleted, along with every `/tmp/omp-gui-audit-*` profile. The capture script deletes its own `/tmp/omp-showcase-*` homes.
- `resources/omp` stays, as step 0 intends.

## Unresolved questions
1. Tag `rebrand-pre-release` at **bd1936b**. I did not create it.
2. **`welcome.card.download` in vi.ts reads "Dung lượng tải" ("download size").** `ModelCard.tsx` uses the same key both for the size label and for the download button, so the Vietnamese button is mislabelled. This predates the rebrand (1c150f4). The fix needs a second key and a `ModelCard.tsx` edit, which is outside Phase 9's ownership. Should a follow-up split the key?
3. The keymap still defines `agents.hub` (⌥A) in `src/renderer/lib/keymap.ts`, although the agent hub was removed. The README does not mention it. Is this a leftover for a cleanup phase?
4. The deep-audit `overlay` note from the earlier report stands. I believe no action is needed.
