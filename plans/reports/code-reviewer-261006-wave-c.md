# Code review: Wave C (Phases 7 and 8), everyday-work rebrand

- Range: `rebrand-wave-b-fixed..rebrand-wave-c` in `/home/tung491/WORK/worktrees/rebrand-integration` (HEAD `6e5ce4b`), 110 files, +3574/−4838.
- Read-only. Nothing edited, no long-running process started.
- Checks I ran:
  - `bun run check:types`: exit 0.
  - `bunx vitest run` on `src/main`, `scripts` and the touched renderer dirs: 148 files, 1445 tests passed.
  - Locale tests: pass.
  - Parity loop over `src-tauri/contracts/*.parity.json`: exit 0.
  - `bun e2e-tauri/check-twins.ts`: 43 twins match.
  - `cargo test --lib` filtered to the status, refusal, menu and tray tests: 31 passed.
  - A grep for leftover stats or bench channels found none.
- Known items from the brief are not repeated here.

## Summary

| # | Severity | Area | Finding |
|---|---|---|---|
| H1 | High | Approvals | The `write` sentence names a different file than the one that is written (multi-line or truncated path) |
| H2 | High | Cloud refusal | Typed `/switch`, fuzzy `/model`, `:level` suffixes and role aliases get past the typed-command check |
| H3 | High | Cloud refusal | Settings can set a cloud model through the `modelRoles` dropdown and any other `*model` setting |
| M1 | Medium | Cloud refusal | Non-Ollama cloud providers are refused nowhere when typed (`/model anthropic/…`, `/login`) |
| M2 | Medium | Starter cards | A card's send deletes the user's draft and sends the composer's images along with the skill prompt |
| L1 | Low | Attach / starters | Paths are wrapped in `'…'` without escaping, so `Bob's notes.docx` breaks the quoting |
| L2 | Low | Approvals | A relative or `~` write path is shown as typed, not resolved |
| L3 | Low | Tests | The end-to-end guard that removed commands stay inert is gone; the starter `submit` branch has no test |

The Phase 7 removals are clean:
- No dangling IPC channel, bridge entry, menu action or tray action.
- TS and Rust menus, trays and parity rows match.
- `status_payload()` is correct in both shells.
- Windows packaging is fully removed, and Linux and macOS configs still parse and are tested.

Details follow.

---

## H1 (High): the `write` approval sentence can name a file other than the one that will be written

**Where**
- `src/renderer/components/dialogs/ApprovalDialog.tsx:85-92`: `parseApprovalTitle` takes `path` from one line only.
- `src/renderer/components/dialogs/ApprovalDialog.tsx:118-120`: the write sentence is built from that path.

**Cause**
- omp builds the details as `` `Path: ${truncateForPrompt(targetPath)}` ``, then `Content:\n…` (`coding-agent/src/tools/write.ts:487-492`).
- `targetPath` is the raw model argument. It can hold newlines, and anything past 2000 characters is cut and gets an `[…Nch elided…]` marker (`tools/approval.ts:126`, `:357-361`).
- `lineValue(PATH_PREFIX)` keeps only the text up to the first newline.
- `resolveToCwd` returns an absolute path unchanged (`tools/path-utils.ts:315-317`). Bun's `mkdir -p` and `write` then resolve the `..` segments after the newline.

**Failure scenario**
1. A document the user attached through the new paperclip (Phase 8 makes this the main path for untrusted text) tells the model to call `write` with path `/home/u/Documents/Sai ATLAS/notes.md\n../../../../.config/autostart/x.desktop`.
2. The dialog's main sentence reads "Save a file to /home/u/Documents/Sai ATLAS/notes.md?".
3. The real target is `/home/u/.config/autostart/x.desktop`. I reproduced the resolution with Bun's `fs.mkdir({recursive:true})` + `Bun.write` in a scratch dir: the file landed outside `Sai ATLAS`. I did not drive omp's write tool end to end.
4. The full path is only in the collapsed `<details>`.
5. The 2000-character truncation gives the same result without a newline: a long, legitimate-looking prefix under `Sai ATLAS/`, and the `../` tail elided.
6. `write` is in the pack's `--tools` (`src/main/assistant-pack.ts:31`, `COMMON_TOOLS`) and is set to `prompt` (`assistant-pack/config.yml`), so this dialog is the only gate.

**Fix**
- Only build the file sentence when the request can be read without ambiguity:
  - the line after `Path: <p>` is exactly `Content:`;
  - `<p>` has no control characters;
  - `<p>` does not end in the `[…ch elided…]` marker.
- Otherwise show a warning sentence (for example "Sai ATLAS wants to save a file with an unusual name. Check the details.") and open the `<details>` by default.
- Add tests for:
  - a path containing `\n`;
  - a path longer than 2000 characters;
  - a path containing `\nContent:\n`.
- Longer term, the pack's `tools.approval` could deny `write` outside the output folder. omp's per-tool policy cannot express that today, so the dialog check is what is needed now.

## H2 (High): the typed `/model` refusal is a string check that `/switch`, fuzzy ids, thinking suffixes and role aliases get past

**Where**
- `src/renderer/lib/command-availability.ts:141-144`: `cloudModelCommand` returns true only when the command resolves to `model` and `isCloudTag(args)` is true.
- `src/renderer/lib/ollama-cloud.ts:8-13`: `isCloudTag` splits at the first `:` after the last `/`.

**Cause**
- `/switch` is an agent builtin with a `handle` (`coding-agent/src/slash-commands/builtin-modes.ts:494-520`), so it is `textModeExecutable` (`available-commands.ts:64`) and is sent to `prompt`. It calls `setModelTemporary`.
- `/model` and `/switch` both resolve through `resolveCliModel`, which accepts:
  - fuzzy ids;
  - `@role` and role names;
  - a trailing `:level` thinking suffix (`builtin-modes.ts:50-69`; `config/model-resolver.ts:142-152`, `:269`).

**Verified with Bun against the real functions**

| Input | Result |
|---|---|
| `cloudModelCommand("/switch kimi-k2:cloud", [])` | false |
| `cloudModelCommand("/model gpt-oss:120b-cloud:high", [])` | false |
| `isCloudTag("kimi-k2:cloud:low")` | false |
| `cloudModelCommand("/model kimi", [])` | false |

**Failure scenario**
- A user who pulled `kimi-k2:cloud` with the CLI types `/switch kimi` or `/model kimi-k2:cloud:low`.
- The session switches to Ollama's cloud and the conversation leaves the computer.
- This breaks the privacy sentence the refusal exists to protect.
- If a role was pointed at a cloud model (see H3), `/model @default` does the same.

**Fix**
Pattern-matching the selector cannot cover the agent's grammar. Guard the result instead:
- In `hydrateSession` / `applyModelInfo` (every `set_model` response, `model_changed` and `get_state` model), refuse when the session's model is an Ollama cloud tag:
  - switch back to the last local model (or the default role) with `set_model`;
  - show `ollama.settings.cloudRefused`.
- Keep the composer check as an early refusal, and extend it as follows:
  - Add `switch` next to `model`.
  - Strip a trailing `:minimal|low|medium|high|xhigh|max|off|auto` before calling `isCloudTag`.
  - Better still, have `isCloudTag` test every `:`-separated part.
- Test cases:
  - `/switch x:cloud`;
  - `/model gpt-oss:120b-cloud:high`;
  - a `model_changed` event that lands on a cloud model.

## H3 (High): Settings can make a cloud model the default role

**Where**
- `src/renderer/components/settings/SchemaSettingRow.tsx:313-369`: the `modelRoles` record gets a model dropdown.
- `src/renderer/components/settings/ModelValueSelect.tsx:28-29`: `settingRefKind` gives every `*model` key a model dropdown.
- `src/renderer/components/settings/ModelValueSelect.tsx:44-55`: `modelOptions` lists every available model.

**Cause**
- Phase 8 added `isCloudTag` to the picker, the model cycle, the welcome screen and the Ollama window, but not to `ModelValueSelect`.
- `modelRoles` is not in `PACK_PINNED_SETTING_KEYS` or any hide list (`settings-schema-utils.ts:82-125`), so its row stays in the Settings window (Advanced and search).

**Failure scenario**
- In Settings, the user sets `modelRoles` → `default` to `ollama/kimi-k2:cloud`, which the dropdown offers.
- Every new task then starts on the cloud model, and no refusal is shown anywhere.
- This is the "settings" entry point the plan's refusal list names. The comment in `ollama-cloud.ts:4-6` says every place that makes a model the default refuses cloud tags; this one does not.

**Fix**
- In `modelOptions`, mark cloud tags `disabled` with the refusal text as their detail, as ModelPicker does.
- Refuse the commit in the row's `onCommit` when the value is a cloud tag, because the record editor value can also be typed or pasted.
- The session-level guard from H2 catches anything that still gets through.
- Add a `SettingsWindow` / `ModelValueSelect` test for a cloud option.

## M1 (Medium): typed commands can still switch to a remote provider

**Where**
- `src/renderer/lib/command-availability.ts:141-144`: only Ollama cloud tags are checked.
- `src/shared/provider-policy.ts:22-27`: `/login` and `/logout` are "still forwarded" when typed.

**Failure scenario**
- The sidecar inherits the login-shell environment and shares `~/.omp/agent` (its auth file) with the user's own omp.
- So a user with `ANTHROPIC_API_KEY` exported, or an earlier omp login, can type `/model anthropic/claude-sonnet-4-5` (verified: `cloudModelCommand` returns false) or `/login`.
- Either sends the conversation online.
- The GUI lists only Ollama models (`filterAllowedModels`), but nothing refuses a typed selector for another provider.
- The plan decision says "refuse Ollama cloud tags". The privacy sentence it protects ("uses only models that run on this computer") covers this case too.

**Fix**
- Make the H2 session guard provider-aware: refuse any session model whose provider fails `isAllowedProvider` or which is a cloud tag.
- Refuse typed `/login` and `/logout` the same way `REMOVED_COMMANDS` is refused.
- If this goes beyond the agreed decision, bring it to the user with the trade-off rather than deciding here.

## M2 (Medium): a starter card wipes the user's draft and sends their attached images with the skill prompt

**Where**
- `src/renderer/components/layout/InputArea.tsx:352-355`: the `submit` branch calls `send(detail.text)`.
- `src/renderer/components/layout/use-composer-submit.ts:238`: `payload = images.map(…)`.
- `src/renderer/components/layout/use-composer-submit.ts:289-290`: `setText("")`, `setImages([])`.

**Cause**
- `send(overrideText)` swaps out only the text. It still attaches the composer's current `images`.
- After sending it clears the composer, which holds the user's unrelated draft.
- If the send fails, `restoreDraft` restores the starter text, not the draft.
- If the sidecar is not `ready`, `send` only shows a toast, and the file the user just picked is dropped.

**Failure scenario**
1. On the empty state, the user types a paragraph and pastes a screenshot.
2. They click "Turn my notes into a Word report" and pick a file.
3. The prompt `/skill:word-report '<path>'` goes out with the screenshot attached.
4. The typed paragraph is gone, with no undo.

**Fix**
- Give the composer a `sendStarter(text)` path that:
  - sends `text` with no images;
  - leaves the current draft and images alone;
  - keeps the picked path in the draft when the sidecar is not ready, so it is not lost.
- Cover the `submit` branch with an `InputArea` linkedom test: a typed draft plus an image survive a starter send, and the prompt carries no image.

## L1 (Low): quoted paths are not escaped

**Where**
- `src/renderer/components/layout/attach-document.ts:20-22`: `quotePromptPath`.
- `src/renderer/components/chat/starters.ts:76`: the starter reuses it.

**Failure scenario**
- `/home/u/Bob's notes.docx` becomes `'/home/u/Bob's notes.docx'`.
- Gemma reads the path as `/home/u/Bob` and the job fails.
- A filename containing a newline also splits the "one path per line" draft format.
- omp passes skill args through as raw text (`extensibility/skills.ts:639-648`), so nothing downstream un-escapes them.

**Fix**
- Quote with a form the skills already document, or switch to `"…"` with `\"` escaping.
- Refuse (with a toast) a picked path that contains a newline.
- Add a test for an apostrophe in a path.

## L2 (Low): a relative or `~` write path is shown as typed

**Where**
- `src/renderer/components/dialogs/ApprovalDialog.tsx:94-109`: `normalizePosixPath` keeps leading `..` and `~` as typed.

**Failure scenario**
- `write` to `../../.config/autostart/x.desktop` shows "Save a file to ../../.config/autostart/x.desktop?".
- The user does not know the session's working folder, so they cannot tell where that is.
- It is not a misstatement, but it is not the "full path" the phase spec asks for.

**Fix**
- Resolve against the session's `cwd`, which the renderer has in the session store, and expand `~` to the home path before normalising.

## L3 (Low): tests

1. The cross-shell e2e guard that removed developer commands stay inert is gone:
   - Deleted: `e2e/desktop.e2e.ts:435` and `e2e-tauri/desktop.e2e.ts:566`, "model benchmark, collaboration, tools and debug open without external mutations". It also asserted `collab_join` was never recorded.
   - Nothing in `e2e*/` now checks that `/collab`, `/tools`, `/debug` or `/import` are refused (grep for `collab_join` is empty).
   - Unit tests cover `REMOVED_COMMANDS`, but not the path from the composer to the agent.
   - Suggest that Phase 9 Task 9.0 rewrites the case: send each removed command, expect the `unavailable.tuiOnly` toast, no dialog, and no recorded `prompt` or `collab_join`.
2. The starter `submit` branch (`InputArea.tsx:352-355`) is covered only by the implementer's manual run on the virtual display. See M2 for the test to add.
3. No weakened assertions found otherwise:
   - The product-identity test now pins the exact list of builder configs, which is stronger.
   - The packaged smoke now requires two or more `--mode rpc-ui` sidecars, also stronger.
   - The renamed copy assertions in `AgentHubWindow.test.tsx` check the same behaviour.

---

## Checked and not reported

- **OfficeFileRenderer**
  - Exact-key JSON, matching kind and extension, absolute path, no `..`, and parent folder exactly `Sai ATLAS`.
  - Rejected: Windows `C:\…`, `file://`, relative paths, `.` segments, trailing spaces, and Unicode look-alikes (exact ASCII compare).
  - A backslash is an ordinary character on POSIX.
  - A symlinked output folder only changes which `.docx` opens.
  - `openPath` still goes through `open_path_target`, which reveals launchable files instead of running them.
  - A `Sai ATLAS` folder anywhere on disk passes the check. That matches the spec, and the only effect is opening a document of the expected kind. Acceptable.
- **Attach**
  - Images are capped at 25 MB each by both shells (`ipc.ts:1009`, `workspace_fs::FS_IMAGE_MAX_BYTES`).
  - Documents are sent only as paths; the model reads them with `read`.
  - The tab and session checks after the dialog match the paste path.
- **Approvals for `open_item` and `os_setting`**
  - The reason is built by the pack from the resolved argv (`os-commands.ts:292-345`), not from model text, so it cannot misstate the target.
  - A file path containing a newline is cut the same way as in H1. Such a file must already exist, which needs an approved `write` first; H1's fix covers this too.
- **Phase 7**
  - `status_payload()` is the only addition to `ports.rs`, and the API snapshot gains exactly that one line.
  - `last_status` is replaced whole on every `set_status_with_refusal`, so no stale message carries over.
  - The cwd is re-read at query time.
  - Electron's `#lastStatus` mirrors this.
  - Refusal reporters write one `child-process` entry each.
  - Test-binary log writes go to a temp file (`runtime_log.rs` `#[cfg(test)] default_path`).
  - The renderer's menu-action handlers match the trimmed menu, and the tray `switch-project`, `new-session`, `toggle-fast`, `cycle-thinking` and `toggle-language` actions are still handled.
  - Removing `OmpPort::shutdown` from the shutdown order is consistent.
  - `EXPECTED_CHANNEL_COUNT` 94 → 90 accounts for 3 channels and 1 emit.
- **Windows removal**
  - The last published release (0.9.16) has no `latest.yml`, so no installed Windows client loses its update feed because of this wave.
- **i18n**
  - en and vi keys match.
  - No hard-coded user-visible strings in the new components.
  - The Vietnamese reads naturally.
  - `jobs.emptyHint` still mentions "long bash commands" in both languages; this belongs to Phase 9 copy.

## Unresolved questions

1. M1 goes beyond the recorded decision (Ollama cloud tags only). Should typed remote-provider switches and `/login` be refused too? That is a user decision on the privacy sentence's scope.
2. For H2 and H3, is a session-level revert-and-toast guard acceptable, or should the refusal live in the pack (for example, an extension hook on model selection)? The pack route would also cover typed and journal-restored models in both shells.

Status: DONE_WITH_CONCERNS
Summary: The Phase 7 removals and the late-subscriber replay are correct, and every gate I ran passes. In Phase 8, a newline or truncated path can make the write approval sentence name the wrong file (H1), and the cloud-model refusal can be bypassed through typed `/switch`, fuzzy ids, `:level` suffixes and Settings' model dropdowns (H2, H3).
Concerns/Blockers: M1 needs a user decision on how far the privacy sentence reaches.
