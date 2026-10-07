# Assistant pack office output follows the app language

The office tools' output-card summaries, file names and slide "continued" marks now come out in Vietnamese when `SAI_ATLAS_LANG=vi` and in English otherwise, including when the variable is unknown or missing.

- Worktree: /home/tung491/WORK/worktrees/rebrand-pack-lang
- Branch: `rebrand/pack-lang`
- Commit: `10fcba3` feat(assistant-pack): follow the app language in office output. Not merged, tagged or pushed.

## How it works

The pack already reads `SAI_ATLAS_LANG` once, in `defaultOfficeEnv()` (`assistant-pack/src/tools/office-tools.ts`), into `OfficeEnv.lang`. Before this change only `cleanWorkbook` used it, for the decimal mark and the sheet labels (its `LABELS` table). I reused that approach. `OfficeEnv.lang` is now also passed to `buildReport` and `buildSlides` as a required `lang` field, and each module keeps a small `en`/`vi` table. Any value other than `vi` selects English. I added no new i18n module.

English text still goes through `countOf`, which adds an "s" for plurals. Vietnamese text puts the plain number in front of the noun and never adds a plural ending.

`safeBaseName(name, fallback)` in `output.ts` now accepts a fallback name for the case where the cleaned name comes out empty. Its default is still "Document".

## Strings changed (en → vi)

| Where | English | Vietnamese |
|---|---|---|
| Clean check (`clean.ts` `SUMMARY`) | `N sheet(s)` | `N trang tính` |
| | `N row(s) kept` | `giữ N dòng` |
| | `N empty row(s) removed` | `xóa N dòng trống` |
| | `N duplicate row(s) removed` | `xóa N dòng trùng lặp` |
| | `N cell(s) trimmed` | `bỏ khoảng trắng thừa ở N ô` |
| | `N number(s) converted` | `chuyển N giá trị thành số` |
| | `N formula(s) replaced by values` | `thay N công thức bằng giá trị` |
| | `N merged range(s) unmerged` | `tách N vùng ô gộp` |
| | `kept as text: A, B` | `giữ dạng chữ: A, B` |
| | `totals row added` | `đã thêm dòng tổng` |
| Report check (`report.ts`) | `N heading(s), N table(s), N list item(s)` | `N đề mục, N bảng, N mục danh sách` |
| Slides check (`slides.ts` `DECK_TEXT`) | `N slide(s) (…)` | `N trang chiếu (…)` |
| | `split onto N slides: <title>` | `chia thành N trang chiếu: <title>` |
| Slide kinds | title slide | trang tiêu đề |
| | section divider | trang chuyển phần |
| | card grid | trang dạng thẻ |
| | big number | trang số liệu lớn |
| | chart | biểu đồ |
| | table | bảng |
| | bullet slide | trang gạch đầu dòng |
| Continued slide title (inside the .pptx) | `<title> (cont.)` | `<title> (tiếp)` |
| Cleaned file name (`office-tools.ts` `NAMES`) | `<name> (cleaned).xlsx` | `<name> (đã làm sạch).xlsx` |
| Untitled report (file name and document title) | `Report` | `Báo cáo` |
| Untitled deck (file name and deck title) | `Slides` | `Bài trình chiếu` |
| Name made only of reserved characters | `Document` | `Tài liệu` |

None of the file names contain `/`, `:` or any other character reserved on Windows. The tests assert that, and also assert that the names are in NFC form.

## Tests

New tests cover both languages, plus fallback to English for an unknown value (`fr`) and an empty one:

- `clean.test.ts`: the full English check, the full Vietnamese check, and the unknown-language fallback.
- `report.test.ts`: the Vietnamese check and the unknown-language fallback.
- `slides.test.ts`: the Vietnamese check and `(tiếp)` on the split slide, and the English `(cont.)` for an unknown language.
- `office-tools.test.ts`: the Vietnamese file names `Báo cáo`, `Bài trình chiếu` and `Tài liệu`, the `(đã làm sạch)` suffix with a Vietnamese check, a filesystem-safety check on the names, and English fallbacks.
- `compiled.test.ts`: an end-to-end run of the compiled sidecar with `SAI_ATLAS_LANG=vi`. It produces `doanh-so (đã làm sạch).xlsx` with a Vietnamese check, which proves the env value reaches the built pack.

Existing call sites in `visual.test.ts` now pass `lang: "en"`.

## Results

| Check | Result |
|---|---|
| `bunx vitest run assistant-pack` | 221 passed, 5 skipped |
| `bunx vitest run` (full suite) | 2134 passed, 5 skipped; 209 files passed |
| `bun run check:types` | clean |
| `bunx biome check assistant-pack` | clean |
| `bun run build:pack` | succeeded |
| `bun scripts/check-assistant-pack.ts resources/omp.linux-x64` | `PACK LOAD CHECK: PASS` |

The 5 skipped tests are the LibreOffice visual suite. It only runs when `CI_VISUAL=1`, and it was already skipped before this change.

The sidecar symlinks `resources/omp` and `resources/omp.linux-x64` are gitignored and were not committed. No processes were left running.

## Not translated: messages the model reads

These are tool error messages. The model reads them and rephrases them for the person, so I left them in English as instructed. The renderer's office card shows only successful results; for an error, the tool's text goes through the generic tool display.

- From `PlainError`, whose class comment calls them "safe to show the person". They may reach the user verbatim inside an error tool block, so they are a candidate for a later decision:
  - "I stopped before the file was made."
  - "I could not save the file in the Sai ATLAS folder."
  - "There are too many files with this name in the Sai ATLAS folder."
  - "The Sai ATLAS folder in Documents leads to another place, so I did not save the file."
  - "There are no slides yet. Start each slide with a line beginning with ##."
  - "I could not create the slides."
  - The clean errors: formulas without results, save as .xlsx, too large (20 MB), too many cells, no sheet with that name or no sheets, could not read the spreadsheet.
  - "Something went wrong while making the file."
- Argument-validation messages aimed at the model ("The markdown text is missing.", "Totals must be true or false.", and so on).
- Tool `label` values ("Word report", "Slides", "Clean spreadsheet"). They are tool metadata; the GUI renderer may show its own localized labels, which I could not check because `src/` is out of scope.

## Follow-up: error sentences in the app language

The coordinator asked for this after the first commit.

- Commit: `7f43e24` feat(assistant-pack): show office error sentences in the app language, on `rebrand/pack-lang`. Not merged, tagged or pushed.

`PlainError` (`assistant-pack/src/office/output.ts`) now takes either an `{ en, vi }` sentence or a plain string. Its `message` is always the English sentence, so callers and tests that match on `message` are unchanged. `inLanguage(lang)` returns the Vietnamese sentence for `vi` and English otherwise; a plain string is the same in both.

The office tools' `run()` (`src/tools/office-tools.ts`) now receives `env.lang`. It returns `PlainError` sentences in that language, returns `ArgumentError` text in English, and replaces any other error with the localized "something went wrong" sentence. A raw system error therefore still never reaches the result. Each module keeps its own `PlainText` constants, the same pattern as its other en/vi tables.

### Translated (written for the person)

| Module | English | Vietnamese |
|---|---|---|
| output.ts | I stopped before the file was made. | Tôi đã dừng trước khi tạo xong tệp. |
| output.ts | There are too many files with this name in the Sai ATLAS folder. | Thư mục Sai ATLAS đã có quá nhiều tệp trùng tên này. |
| output.ts | The Sai ATLAS folder in Documents leads to another place, so I did not save the file. | Thư mục Sai ATLAS trong Documents dẫn đến một nơi khác, nên tôi không lưu tệp. |
| office-tools.ts | I could not save the file in the Sai ATLAS folder. | Tôi không lưu được tệp vào thư mục Sai ATLAS. |
| office-tools.ts | Something went wrong while making the file. | Đã có lỗi khi tạo tệp. |
| clean.ts | This file has formulas without saved results. Open it in your spreadsheet app, save it, then try again. | Tệp này có công thức chưa lưu kết quả. Hãy mở tệp trong ứng dụng bảng tính, lưu lại rồi thử lại. |
| clean.ts | Save this file as .xlsx in your spreadsheet app, then try again. | Hãy lưu tệp này dưới dạng .xlsx trong ứng dụng bảng tính rồi thử lại. |
| clean.ts | This file is too large for me to clean. The limit is 20 MB. | Tệp này quá lớn nên tôi không làm sạch được. Giới hạn là 20 MB. |
| clean.ts | This spreadsheet has too many cells for me to clean. | Bảng tính này có quá nhiều ô nên tôi không làm sạch được. |
| clean.ts | I could not find that file. | Tôi không tìm thấy tệp đó. |
| clean.ts | I can only clean .xlsx, .xls, .ods and .csv files. | Tôi chỉ làm sạch được tệp .xlsx, .xls, .ods và .csv. |
| clean.ts | I could not read this spreadsheet. | Tôi không đọc được bảng tính này. |
| clean.ts | This file has no sheet with that name. | Tệp này không có trang tính nào mang tên đó. |
| clean.ts | This file has no sheets. | Tệp này không có trang tính nào. |
| slides.ts | I could not create the slides. | Tôi không tạo được bài trình chiếu. |

"Documents" stays as the folder's real name in the folder-elsewhere sentence, because that is the name on disk.

### Left in English (only the model acts on these)

- `ArgumentError` checks in `office-tools.ts`:
  - "The markdown text is missing." / "The markdown must be text."
  - "The title must be text." / "The file name must be text."
  - "The spreadsheet path is missing." / "The spreadsheet path must be text."
  - "The sheet name must be text."
  - "Totals must be true or false."
  - "The decimal mark must be comma or dot."
  - "Read the file first, then pass its text as markdown."
  - "The text is too long for one file. Split it into smaller parts."
  - "The tool needs its arguments." (in `types.ts`)
- `NO_SLIDES` in `slides.ts`: "There are no slides yet. Start each slide with a line beginning with ##." It is a `PlainError`, but it tells the model how to write the Markdown, so a comment now marks it as model-facing.

No message includes a raw system error string. The LibreOffice and file-system failures are already caught and replaced by the fixed sentences above; anything unexpected becomes the localized "something went wrong" sentence.

### Out of scope, needs a decision

`os-commands.ts` (`open_item`, `os_setting`, `system_status`, `diagnose`) also has sentences written for the person. Examples are "I could not find that file or folder.", "This works only on SAI OS.", "I could not open it.", "Opened." and "Done: …", along with the status and diagnose lines. They share `PlainError` and still pass plain strings, so they read in English exactly as before. Translating them is a mechanical follow-up with the same `{ en, vi }` constants and `env.lang`. I left them alone because this task covered the office tools.

### Tests added

- `office-tools.test.ts`:
  - In Vietnamese: "Tôi không tìm thấy tệp đó.", "Tôi chỉ làm sạch được tệp .xlsx, .xls, .ods và .csv." and the cancelled-call "Tôi đã dừng trước khi tạo xong tệp." (no file written).
  - The missing-file sentence stays English for `en` and for an unknown language (`fr`).
  - Argument checks and `NO_SLIDES` stay English under `vi`.
- `output.ts` tests: `PlainError.inLanguage` returns the right sentence for `vi`, `en` and an empty value, and a plain string reads the same in every language.

### Results (all six checks re-run after the second commit)

| Check | Result |
|---|---|
| `bunx vitest run assistant-pack` | 227 passed, 5 skipped |
| Full `bunx vitest run` | 2140 passed, 5 skipped |
| `bun run check:types` | clean |
| `bunx biome check assistant-pack` | clean |
| `bun run build:pack` | succeeded |
| `bun scripts/check-assistant-pack.ts resources/omp.linux-x64` | `PACK LOAD CHECK: PASS` |

The 5 skipped tests are the LibreOffice visual suite, which only runs with `CI_VISUAL=1`. No processes were left running.

## Follow-up 2: help desk tools in the app language

- Commit: `b3c5236` feat(assistant-pack): show help desk sentences in the app language, on `rebrand/pack-lang`. Not merged, tagged or pushed.

The four help desk tools now answer in the app language: open_item, os_setting, system_status and diagnose. They use the same pattern as the office tools: `PlainError` `{ en, vi }` pairs for errors and small `PlainText` constants for success sentences, chosen with `env.lang`, English unless `vi`.

`output.ts` gained `inLanguage(text, lang)`, which `PlainError.inLanguage` now calls, so there is one place that decides the language. `guard()` in `os-commands.ts` mirrors the office `run()`: a `PlainError` comes back in the session language, an `ArgumentError` in English, and anything else as the translated "something went wrong" sentence, so no raw system error is shown. `Check.label` is now a `PlainText` pair.

### Translated

| Kind | English | Vietnamese |
|---|---|---|
| Success | Opened. | Đã mở. |
| Success | Done: <approval sentence>. | Đã xong: <approval sentence in Vietnamese>. (for example "Đã xong: Đặt âm lượng 30%.") |
| Error | This works only on SAI OS. | Tính năng này chỉ dùng được trên SAI OS. |
| Error | This is not available on this computer. | Máy tính này không có tính năng này. |
| Error | I can only open documents and pictures. | Tôi chỉ mở được tài liệu và hình ảnh. |
| Error | I could not find that file or folder. | Tôi không tìm thấy tệp hoặc thư mục đó. |
| Error | I can only open files and folders in your home folder. | Tôi chỉ mở được tệp và thư mục trong thư mục nhà của bạn. |
| Error | That is not a folder. | Đó không phải là thư mục. |
| Error | That is not a file. | Đó không phải là tệp. |
| Error | I could not find that app. | Tôi không tìm thấy ứng dụng đó. |
| Error | I can only open these settings: network, wifi, … | Tôi chỉ mở được các mục cài đặt sau: mạng, Wi-Fi, Bluetooth, màn hình, âm thanh, máy in, nguồn điện, bàn phím, thông báo, giao diện. |
| Error | I could not open it. | Tôi không mở được mục này. |
| Error | I could not change that setting. | Tôi không thay đổi được cài đặt đó. |
| Error | Something went wrong on this computer. | Đã có lỗi trên máy tính này. |
| Check filler | nothing found / not available / no battery found | không tìm thấy gì / không có trên máy này / không tìm thấy pin |
| Status labels | Disk, Memory, Battery, Network, Printers | Ổ đĩa, Bộ nhớ, Pin, Mạng, Máy in |
| Diagnose labels | Connection, Wi-Fi radio, Devices | Kết nối, Sóng Wi-Fi, Thiết bị |
| | Default output, Volume and mute | Đầu ra mặc định, Âm lượng và tắt tiếng |
| | Printers, Waiting print jobs | Máy in, Lệnh in đang chờ |
| | Home disk, System disk | Ổ đĩa thư mục nhà, Ổ đĩa hệ thống |
| | Running time and load, Memory, Busiest programs | Thời gian chạy và mức tải, Bộ nhớ, Chương trình bận nhất |
| | Bluetooth radio, Bluetooth adapter | Sóng Bluetooth, Bộ điều hợp Bluetooth |
| | Screens (XWayland view, may not list every screen or its real size) | Màn hình (theo XWayland, có thể thiếu màn hình hoặc sai kích thước thật) |
| | Colour scheme, Night light, Text size | Bảng màu, Ánh sáng ban đêm, Cỡ chữ |
| | Input method setting, IBus running, Fcitx running | Cài đặt bộ gõ, IBus đang chạy, Fcitx đang chạy |
| | Waiting updates | Bản cập nhật đang chờ |

The Vietnamese settings list names the panels by the same Vietnamese names the approval dialog already uses (`PANEL_NAMES`). The English list keeps the panel ids, as before.

### Boundary: left as is

- Command output is data, not sentences: the `gsettings`, `wpctl`, `nmcli`, `df`, `free`, `lpstat`, `upower`, `xrandr`, `apt` and other text after each label, printed under `LC_ALL=C.UTF-8`. The battery filter still matches upower's English field names.
- The diagnose line "Fixes you may offer, one at a time and each approved by the person: …" and its "none on this computer; tell the person …" variant stay English, because they are instructions to the model naming tool calls.
- Argument checks only the model acts on stay English:
  - "I can change only dark mode, night light, do not disturb, volume and text size."
  - "This setting needs true or false."
  - "The volume must be a number from 0 to 100."
  - "The text size must be a number from 1.0 to 2.0."
  - "Tell me what to open."
  - "I can only open a file, a folder, an app or a settings panel."
  - "Choose one of these areas: …"
- Tool `label`/`description` metadata is unchanged.
- The approval sentences were already bilingual before this change.

### Tests added (`os-commands.test.ts`, "sentences in the app language")

- open_item (vi): "Đã mở." on success, "Tôi không tìm thấy tệp hoặc thư mục đó." for a missing file, and the Vietnamese settings list.
- os_setting (vi): "Đã xong: Đặt âm lượng 30%." on success, "Tôi không thay đổi được cài đặt đó." on failure.
- system_status (vi): the exact Vietnamese labelled lines with the command output kept as printed, and "Tính năng này chỉ dùng được trên SAI OS." off Linux.
- diagnose (vi): the Vietnamese labels with raw wpctl output kept, the English fixes hint, and the off-Linux error.
- Argument checks stay English under vi, for both os_setting and diagnose.
- English fallback for `fr`: "Opened.", "Done: Set the volume to 30%." and "Printers: not available".
- The XWayland label test now checks both languages.

### Results (all six checks re-run after the third commit)

| Check | Result |
|---|---|
| `bunx vitest run assistant-pack` | 233 passed, 5 skipped |
| Full `bunx vitest run` | 2146 passed, 5 skipped |
| `bun run check:types` | clean |
| `bunx biome check assistant-pack` | clean |
| `bun run build:pack` | succeeded |
| `bun scripts/check-assistant-pack.ts resources/omp.linux-x64` | `PACK LOAD CHECK: PASS` |

The 5 skipped tests are the LibreOffice visual suite, which only runs with `CI_VISUAL=1`. No processes were left running.

Status: DONE
Summary: All of the pack's text for the person now follows `SAI_ATLAS_LANG` with an English fallback: the office checks, file names, continued-slide titles and error sentences, plus the help desk results, errors and check labels. The work is three commits on `rebrand/pack-lang` (`10fcba3`, `7f43e24`, `b3c5236`), and all six acceptance checks pass.
Concerns/Blockers: None. The only English left is command output, argument checks and hints for the model, and tool metadata, as listed above.
