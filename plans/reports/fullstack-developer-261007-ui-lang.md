# UI language fixes (Vietnamese pass): implementation report

Worktree: `/home/tung491/WORK/worktrees/rebrand-ui-lang`, branch `rebrand/ui-lang` (from `ad51706`). Not merged, tagged or pushed.

## Commits

| Hash | Message |
|---|---|
| `5f2e166` | feat(tools): name office jobs in plain words instead of their tool ids |
| `113b480` | feat(i18n): mark the page language and say when the assistant follows a switch |
| `7056f5a` | fix(i18n): translate the steering mode in the send button tooltip |

## What changed

1. **Office tool names hidden.** `src/renderer/components/tools/office-tools.ts` now holds one mapping, `OFFICE_TOOL_TEXT`, from each office tool to its card-title key and its approval-action key. Both surfaces use it.
   - `ApprovalDialog.tsx`: the office tools show only the plain sentence. The id line beside the tier badge is gone, and the tier badge stays. The same applies to the tools that already had a plain sentence: a `write` whose path resolves, and `open_item`/`os_setting` with a reason. A tool with no plain words (e.g. `diagnose`) and the unclear-write warning still show the id. The old `OFFICE_ACTION_KEYS` table was removed.
   - `ToolCard.tsx`: office cards are titled in plain words, in the sans font. Every other tool keeps its id in mono.
2. **Language note.** The renderer has no language row in Settings. The only controls are the sidebar EN/VI button and the `toggle-language` menu/tray action (`App.tsx`), and an earlier audit removed the Settings mount. So the note is not a line under a setting. It is an info toast, shown in the new language each time the user switches. `useSwitchLanguage()` in `LangSwitcher.tsx` powers both entry points. The sidecar is not restarted. Quick-entry's language sync still calls `setLang` directly, so it shows no toast.
3. **Page `lang`.** `I18nProvider` (`src/renderer/lib/i18n.tsx`) sets `document.documentElement.lang` from the active language on mount and on every change.
4. **Tooltip `"one-at-a-time"`.** `InputArea.tsx` now translates the steering mode before it fills `input.streamingTitle`. This was a one-line fix.

## Strings added (en / vi)

| Key | en | vi |
|---|---|---|
| `tools.office.title.report` | Word report | Báo cáo Word |
| `tools.office.title.slides` | Slide deck | Bản trình chiếu |
| `tools.office.title.clean` | Cleaned spreadsheet | Bảng tính đã làm sạch |
| `lang.assistantNextLaunch` | The assistant switches language the next time Sai ATLAS starts. | Trợ lý sẽ chuyển sang ngôn ngữ mới vào lần tới Sai ATLAS khởi động. |
| `input.steeringMode.all` | all | tất cả |
| `input.steeringMode.oneAtATime` | one at a time | từng cái một |

No existing strings changed. The approval sentences reuse the `approval.action.office*` keys. The English tooltip now reads `steering mode "one at a time"` where it used to show the raw `"one-at-a-time"`.

## Tests

- New tests:
  - `ApprovalDialog.test.tsx`: the three office tools in vi, checking the sentence and that the tool id is absent from the DOM; a resolvable write with no id; `diagnose` and an unclear write, which still show the id.
  - `ToolCard.test.tsx`: plain office titles in en and vi with the id absent; other tools keep the id.
  - `LangSwitcher.test.tsx`: the note toast appears in the new language on each switch; `documentElement.lang` follows the language, including a rehydrated `vi`.
- Updated: `office-cards.test.tsx` now expects the card title "Word report" where it expected `office_report`. This is an intended behaviour change.
- `bunx vitest run`: 209 files passed and 1 skipped; 2135 tests passed and 5 skipped. Two things were needed first: `resources/omp` and `resources/omp.linux-x64` symlinked to the main checkout's sidecar, and `bun run build:pack` run to write the gitignored `resources/assistant-pack`, which `assistant-pack/test/compiled.test.ts` needs.
- `bun run check:types`: pass.
- `bunx biome check` on all 14 touched files: clean.
- Locale key sets stay identical; `locales.test.ts` passes.

No dev server or virtual display was started, and no process remains.

## Not fixed (needs a decision)

- **Tab subtitle "work".** This is not a raw enum. It is the session's working-folder name (`~/.omp/work`), shown as the tab/session label and subtitle ("Chưa có tiêu đề — work"). Hiding or renaming it is a product choice: rename the default folder, map that folder to a localized label, or drop the folder from the subtitle.

## Unresolved questions

1. Is a toast at switch time acceptable for the language note? A visible line under a control needs a place to put it, and the sidebar footer button has no room. The alternative is a Language row in Settings → GUI with the note under it, which brings back a settings entry an earlier audit removed.
2. Should the dialog also hide the id for `write`, `open_item` and `os_setting` when their sentence is plain? I hid it under the "unless they already have a plain-language mapping" clause. If the decision was office tools only, the change is limited to `approvalSentence`'s `plain` flag.

Status: DONE_WITH_CONCERNS
Summary: Office approvals and cards show plain words from one shared mapping, the page `lang` follows the UI language, and the "one-at-a-time" tooltip is translated. Full vitest, typecheck and biome pass.
Concerns/Blockers: The language note is a toast on switch, because there is no language row in Settings to put a line under. The "work" subtitle is a folder name and needs a product decision.
