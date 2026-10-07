# Settings landing page copy for everyday users

Branch `rebrand/updates-app-only` in `/home/tung491/WORK/worktrees/rebrand-updates`, commit `1a90f86` on top of `0ca1df3`. Nothing was merged, tagged or pushed.

## Outcome

The Settings landing page (`src/renderer/components/settings/pages/CapabilitiesHome.tsx`) now introduces Sai ATLAS in plain words. It has five cards: action search, model, Ollama, this conversation, and the app itself. No string on it says "OMP", and no locale value in `en.ts` or `vi.ts` says "OMP" any more.

## What was removed and why

| Element | Why it went |
|---|---|
| Quick actions card (`/btw`, `/tan`, `/omfg`, queue `->`) | Developer slash commands. `/omfg` writes a TTSR rule, but pack sessions run with `--no-rules`. `/tan` starts background helper work, but `task` is not in `--tools`. |
| "Mid-stream correction · TTSR" card | Rules are off (`--no-rules`, `--no-context-files`). |
| "Parallel helpers" card (Open Agent Hub) | Helpers were removed from v1: `task` is not loaded and `task.disabledAgents` is pinned in `assistant-pack/config.yml`. |
| "Second-model advisor" card | A developer feature that the request named for removal. Its status came from `advisorActive`, so that state was dropped from `SettingsWindow.tsx`. |
| "Cross-session project memory" card | The pack pins `memory.backend: "off"`. |
| "Auditable native toolchain" card | It advertised edit, LSP, debugger and browser tools. The pack loads only `read, glob, write, ask`, the office tools and the Linux OS tools, and denies `edit`, `ast_edit`, `eval` and `browser`. |
| Session card description ("Import a Claude or Codex session as an OMP copy") | `import` is in `REMOVED_COMMANDS`. The `cmd.import.desc` key had no other user and was deleted. |
| Dump Transcript and Fork Session buttons | Developer session tools, named in the request. |
| Background Jobs card | It showed async bash and helper jobs, and pack sessions have neither. |

Removed `CapabilityTarget` members: `dump`, `fork`, `btw`, `tan`, `omfg`, `queue`, `jobs`. Their cases were removed from `openCapabilityTarget` in `SettingsWindow.tsx`, along with the now-unused imports and the `prefill` helper. The palette commands themselves were not touched.

Kept: `model`, `providers`, `agents` (its routing case is unchanged; see the questions at the end), and `updates`, plus `clear`, `sessionInfo`, `export`, `retry`, `resend`, `copy`, `hotkeys`, `theme`, `settings` and `changelog`. The Copy button moved into the "This conversation" card.

## Before and after copy

| Key | en before | en after | vi after |
|---|---|---|---|
| `settings.tabs.capabilities` (nav label) | OMP Capabilities | Overview | Tổng quan (was "Khả năng OMP") |
| `settings.capabilities.eyebrow` | Start with OMP | Sai ATLAS | Sai ATLAS |
| `settings.capabilities.title` | Start with what makes OMP different | What Sai ATLAS can do for you | Sai ATLAS có thể giúp gì cho bạn |
| `settings.capabilities.description` | These controls change how work is executed… route model roles, and keep project memory. | Sai ATLAS helps with everyday work: Word reports, tidy spreadsheets, slide decks and, on SAI OS, help with your computer. It uses only models on this computer, so your files and conversations stay here. | Sai ATLAS giúp bạn trong công việc hằng ngày: soạn báo cáo Word, dọn dẹp bảng tính, làm trang trình chiếu và, trên SAI OS, hỗ trợ sử dụng máy tính. Sai ATLAS chỉ dùng mô hình chạy trên máy tính này, nên tệp và cuộc trò chuyện của bạn luôn ở lại trên máy. |
| `settings.capabilities.commandCenter` | Command Center | Find an action | Tìm thao tác |
| `settings.capabilities.commandCenterDesc` | Browse every GUI command, mode, provider action, extension action… | Search everything Sai ATLAS can do by name and run it with one click. | Tìm theo tên mọi việc Sai ATLAS có thể làm và chạy chỉ với một cú nhấp. |
| `settings.capabilities.openCommandCenter` | Browse all commands | Search actions | Tìm kiếm thao tác |
| `settings.capabilities.conversation` (new) | — | This conversation | Cuộc trò chuyện này |
| `settings.capabilities.conversationDesc` (new) | — | Try your last request again, copy or save the answers, see details about this task, or clear it to start fresh. | Thử lại yêu cầu gần nhất, sao chép hoặc lưu câu trả lời, xem thông tin về việc này, hoặc xóa để bắt đầu lại. |
| `settings.capabilities.applicationDesc` (new; the card used `cmd.settings.desc` "Open settings") | — | Change how Sai ATLAS looks, see keyboard shortcuts, read what's new and get updates. | Đổi giao diện của Sai ATLAS, xem phím tắt, đọc có gì mới và cập nhật ứng dụng. |
| `cmd.providers` / `.desc` (vi only) | vi: "Nhà cung cấp & Đăng nhập" / "Quản lý xác thực nhà cung cấp" | (en already "Ollama" / "Local models, downloads and setup") | Ollama / Mô hình cục bộ, tải xuống và cài đặt |

Deleted keys in both languages: `cmd.import.desc`, plus these `settings.capabilities.*` keys: `quickActions`, `quickActionsDesc`, `enabled`, `disabled`, `loading`, `ttsr`, `ttsrDesc`, `configureRules`, `agents`, `agentsDesc`, `openAgentHub`, `advisor`, `advisorDesc`, `configureAdvisor`, `advisorInactive`, `memory`, `memoryDesc`, `memoryBackend`, `unconfigured`, `configureMemory`, `tools`, `toolsDesc` and `configureTools`.

**OMP sweep.** `rg -n '\bOMP\b'` over `en.ts` and `vi.ts` now returns nothing. Before the change, every hit in both files was one of the keys above.

## Tests

The new file `src/renderer/components/settings/pages/CapabilitiesHome.test.tsx` uses the linkedom harness and checks four things:

- the page introduces Sai ATLAS without naming OMP, in both languages;
- it does not offer developer commands or features that assistant sessions lack;
- every kept target opens from its button: the action search, `model`, `providers` and `updates`;
- no button routes to a removed command.

The old server-rendered `CapabilitiesHome` test in `SettingsWindow.test.tsx`, which asserted the OMP copy, was removed. The new file replaces it.

Red, run against the old page: 3 failed and 1 passed. The failures were assertion errors: the page text matched `\bOMP\b`, it contained "Side Question", and the button targets included `btw`. The kept-targets test passed because those targets already worked. Green: 4 of 4 pass.

## Gates (all exited 0 in the worktree)

- `bun install`
- `bun run check:types`
- `bunx vitest run`: 209 files passed and 1 skipped; 2112 tests passed and 5 skipped
- `bun run build`
- `bun run build:renderer:tauri`
- `bunx biome check` on the 6 touched files
- `bun e2e-tauri/check-twins.ts`

No Rust string changed, so cargo and the parity loop were not needed. No e2e spec drives the removed items: `e2e/deep-audit.e2e.ts` uses only `[data-command-center-entry]`, which is kept. No GUI process was started.

## Unresolved questions

1. **Agent Hub.** The instructions said to keep the `agents` target working, but the only element on the page that opened the Agent Hub was the "Parallel helpers" card. Helpers do not exist in pack sessions, so the card went. The `agents` target and its routing case stay, but nothing on the page uses them any more. The Hub is still reachable from the `/agents` command and the `agents.hub` hotkey. If the Hub is meant to stay prominent, or should be removed from the app altogether, that needs a product decision.
2. **Command labels.** The kept buttons still use the shared `cmd.*` labels: "Clear Context", "Session Info", "Export HTML", "Retry Last Turn", "Resend Last Message". The app menu repeats these in `src/main/i18n.ts` and `src-tauri/src/i18n.rs`, so renaming them for plain language would touch the palette, both menus and Rust parity. That was left out of scope here.
3. **Possible merge conflict.** The vi `cmd.providers` and `cmd.providers.desc` values were changed so the kept Ollama card stops mentioning sign-in. If the delegate editing the Ollama setup sentence also changes those keys, the merge will conflict there.
