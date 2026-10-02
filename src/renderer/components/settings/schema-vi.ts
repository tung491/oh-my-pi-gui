/**
 * Vietnamese (vi) translations for the agent settings schema content:
 * group titles keyed by schema group name, setting labels/descriptions
 * keyed by setting path. SettingsWindow consults these only when the
 * active language is vi and falls back to the schema's English text
 * for anything missing.
 *
 * Boundary: the named tabs (appearance…providers) and the Advanced tab
 * (schema settings without ui metadata) are both fully covered.
 */

/** Section headings declared in the schema's TAB_GROUPS. */
export const VI_GROUP_TITLES: Record<string, string> = {
	Theme: "Chủ đề",
	"Status Line": "Dòng trạng thái",
	Display: "Hiển thị",
	Images: "Hình ảnh",
	Thinking: "Suy nghĩ",
	Sampling: "Lấy mẫu",
	Prompt: "Lời nhắc (Prompt)",
	"Retry & Fallback": "Thử lại & Dự phòng",
	Advisor: "Cố vấn (Advisor)",
	Prewalk: "Prewalk",
	Vision: "Thị giác (Vision)",
	Input: "Đầu vào",
	Approvals: "Phê duyệt",
	Notifications: "Thông báo",
	Speech: "Giọng nói",
	Collab: "Cộng tác",
	"Magic Keywords": "Từ khóa ma thuật",
	"Startup & Updates": "Khởi động & Cập nhật",
	"Power (macOS)": "Nguồn điện (macOS)",
	Power: "Nguồn điện",
	Agent: "Agent",
	Git: "Git",
	General: "Chung",
	Compaction: "Nén ngữ cảnh",
	"Rules (TTSR)": "Quy tắc (TTSR)",
	Experimental: "Thử nghiệm",
	"Auto-Learn": "Tự động học",
	Mnemopi: "Mnemopi",
	Hindsight: "Hindsight",
	Editing: "Chỉnh sửa",
	Reading: "Đọc",
	"Read Summaries": "Tóm tắt nội dung đọc",
	LSP: "LSP",
	Bash: "Bash",
	"Eval & Runtimes": "Eval & Môi trường chạy",
	"Available Tools": "Công cụ khả dụng",
	Todos: "Việc cần làm",
	"Grep & Browser": "Grep & Trình duyệt",
	Computer: "Điều khiển máy tính",
	GitHub: "GitHub",
	"Output Limits": "Giới hạn đầu ra",
	Execution: "Thực thi",
	"Discovery & MCP": "Khám phá & MCP",
	Extensions: "Tiện ích mở rộng",
	Developer: "Nhà phát triển",
	Modes: "Chế độ",
	Subagents: "Agent phụ (Subagent)",
	Isolation: "Cách ly",
	"Commands & Skills": "Lệnh & Kỹ năng",
	Services: "Dịch vụ",
	Fireworks: "Fireworks",
	"Tiny Model": "Mô hình thu nhỏ",
	Protocol: "Giao thức",
	Timeouts: "Thời gian chờ (Timeout)",
	Privacy: "Quyền riêng tư",
};

/** Per-setting row text, keyed by schema setting path. */
export const VI_SETTINGS: Record<string, { label: string; description?: string }> = {
	"providers.openai-codex.codeMode": {
		label: "Chế độ mã Codex (Code Mode)",
		description:
			"Điều hướng các mô hình code_mode_only của Codex (GPT-5.6) qua eval; các công cụ phiên khác do eval gọi. Chế độ tự động tuân theo cờ trong danh mục mô hình.",
	},
	"providers.openai-codex.codeModeDirectTools": {
		label: "Công cụ trực tiếp bổ sung cho Code Mode",
		description: "Các công cụ được phép gọi trực tiếp ngoài eval, ask, todo, yield, think, checkpoint và rewind.",
	},
	"update.channel": {
		label: "Kênh cập nhật Core",
		description:
			"Kênh cập nhật được sử dụng bởi omp update và kiểm tra cập nhật khi khởi động Core. Cập nhật ứng dụng máy tính được quản lý trên trang Cập nhật.",
	},
	"edit.autoRepair.enabled": {
		label: "Tự động sửa lỗi phân tích cú pháp",
		description:
			"Khi chỉnh sửa khiến tệp không thể phân tích cú pháp, yêu cầu mô hình nhỏ sửa vùng bị lỗi và phân tích lại để xác thực; hiển thị cảnh báo nếu sửa thất bại.",
	},
	"providers.cacheRetention": {
		label: "Thời gian giữ bộ nhớ đệm prompt",
		description:
			"Gửi chính sách giữ bộ nhớ đệm prompt tới các nhà cung cấp hỗ trợ; chế độ tự động sử dụng mặc định của nhà cung cấp, tắt sẽ đồng thời vô hiệu hóa định tuyến ưu tiên cache.",
	},
	"commit.mapReduceThreshold": { label: "Ngưỡng chia đợt tạo thông điệp commit" },
	"commit.mapBatchTokenBudget": { label: "Ngân sách token mỗi đợt phân tích commit" },
	"commit.cacheEnabled": { label: "Bật bộ nhớ đệm phân tích commit" },
	"commit.cacheTtlDays": { label: "Thời gian lưu đệm phân tích commit (ngày)" },
	"extensionHandlers.toolCallTimeoutMs": {
		label: "Thời gian chờ gọi công cụ mở rộng (ms)",
		description:
			"Thời gian chờ làm việc thực tế cho trình xử lý tool_call của tiện ích mở rộng; không tính thời gian chờ hộp thoại OMP, giá trị không hợp lệ sẽ dùng mặc định 30000 ms.",
	},
	// ── appearance ──────────────────────────────────────────────────────────
	"theme.dark": {
		label: "Giao diện tối",
		description: "Bảng màu giao diện khi TUI và GUI sử dụng chế độ tối",
	},
	"theme.light": {
		label: "Giao diện sáng",
		description: "Bảng màu giao diện khi TUI và GUI sử dụng chế độ sáng",
	},
	symbolPreset: {
		label: "Bộ ký hiệu",
		description: "Bộ ký tự glyph cho biểu tượng và ký hiệu (Unicode, Nerd Font hoặc ASCII)",
	},
	colorBlindMode: {
		label: "Chế độ mù màu",
		description: "Sử dụng màu xanh dương thay vì xanh lá cho các dòng diff mới thêm",
	},
	"statusLine.preset": {
		label: "Bố cục dòng trạng thái",
		description: "Bố cục dòng trạng thái dùng chung cho TUI và GUI",
	},
	"statusLine.separator": {
		label: "Dấu phân cách dòng trạng thái",
		description: "Kiểu dáng dấu phân cách giữa các phần",
	},
	"statusLine.sessionAccent": {
		label: "Màu nhấn phiên",
		description: "Sử dụng màu của tên phiên cho viền trình chỉnh sửa và khoảng cách trạng thái",
	},
	"statusLine.transparent": {
		label: "Dòng trạng thái trong suốt",
		description:
			"Dòng trạng thái sử dụng nền mặc định của terminal thay vì `statusLineBg`. Các đầu mũ Powerline sẽ bị bỏ vì cần phần đệm màu tương phản để chuyển tiếp sang vùng terminal xung quanh.",
	},
	"statusLine.compactThinkingLevel": {
		label: "Mức suy nghĩ thu gọn",
		description: "Hiển thị biểu tượng đơn lẻ cho mức suy nghĩ thay vì gắn hậu tố ` · <mức>` riêng.",
	},
	"statusLine.showHookStatus": {
		label: "Hiển thị trạng thái hook",
		description: "Hiển thị thông báo trạng thái hook bên dưới dòng trạng thái",
	},
	"terminal.showImages": {
		label: "Hiển thị hình ảnh nội dòng",
		description: "Hiển thị hình ảnh nội dòng trong terminal",
	},
	"images.autoResize": {
		label: "Tự động đổi kích thước ảnh",
		description: "Thu nhỏ ảnh lớn xuống tối đa 2000x2000 để tương thích mô hình tốt hơn",
	},
	"images.blockImages": { label: "Chặn hình ảnh", description: "Không gửi hình ảnh đến nhà cung cấp LLM" },
	"terminal.showProgress": {
		label: "Tiến trình chạy gốc",
		description:
			"Hiển thị tiến trình chạy gốc: terminal dùng OSC 9;4, GUI dùng huy hiệu Dock và thanh tiến trình cửa sổ",
	},
	"tui.textSizing": {
		label: "Tiêu đề lớn (Kitty)",
		description:
			"Sử dụng giao thức kích thước văn bản OSC 66 của Kitty để kết xuất tiêu đề Markdown H1 gấp đôi kích thước. Chỉ có tác dụng trên terminal Kitty, bị bỏ qua ở nơi khác. Mặc định tắt.",
	},
	"tui.renderMermaid": {
		label: "Hiển thị sơ đồ Mermaid",
		description: "Cho phép agent sử dụng sơ đồ Mermaid: TUI kết xuất dạng ASCII, GUI kết xuất dạng đồ họa",
	},
	"tui.reactions": {
		label: "Cảm xúc phản hồi của agent",
		description: "Cho phép agent phản hồi tin nhắn của bạn bằng huy hiệu emoji trên bong bóng hội thoại",
	},
	"tui.codexResetFireworks": {
		label: "Pháo hoa đặt lại Codex",
		description:
			"Hiển thị pháo hoa chúc mừng ở 1/3 phía trên màn hình khi hạn mức tuần của Codex được đặt lại đột xuất hoặc có lượt đặt lại mới được lưu, bấm Escape để đóng",
	},
	"tui.titleState": {
		label: "Trạng thái chạy trên tiêu đề",
		description:
			"Hiển thị trạng thái chạy của agent trên tiêu đề terminal hoặc tiêu đề cửa sổ GUI (đang xử lý, đang chờ và đến lượt người dùng)",
	},
	"tui.hyperlinks": {
		label: "Siêu liên kết terminal",
		description:
			"Bọc đường dẫn và URL thành siêu liên kết OSC 8 để nhấp mở trực tiếp trong terminal (auto: phát hiện hỗ trợ; off: không bao giờ; always: vô điều kiện)",
	},
	"tui.tight": {
		label: "Giao diện thu gọn",
		description: "Nén khoảng cách đầu ra TUI và khoảng cách đệm trên giao diện GUI",
	},
	"tui.scrollbackRebuild": {
		label: "Tái tạo lịch sử cuộn",
		description:
			"Xóa và phát lại lịch sử cuộn terminal khi dạng cuối cùng của khối thay thế bản xem trước trực tiếp. Khi tắt (mặc định), bản xem trước cũ được giữ lại trong lịch sử và nội dung cuối được thêm vào phía dưới.",
	},
	"display.shimmer": {
		label: "Hiệu ứng ánh sáng",
		description: "Kiểu hoạt ảnh cho thông báo đang làm việc/tải",
	},
	"display.smoothStreaming": {
		label: "Truyền phát mượt mà",
		description:
			"Hiển thị văn bản của trợ lý và dữ liệu nhập công cụ dạng luồng một cách mượt mà khi các đoạn dữ liệu đến",
	},
	"display.showTokenUsage": {
		label: "Hiển thị lượng token sử dụng",
		description: "Hiển thị số lượng token đã dùng cho mỗi lượt trên tin nhắn của trợ lý",
	},
	"display.cacheMissMarker": {
		label: "Dấu hiệu không trúng cache",
		description: "Hiển thị đường phân cách phía trên khi lượt yêu cầu của trợ lý bị lỡ (miss) bộ nhớ đệm prompt",
	},
	"display.collapseCompacted": {
		label: "Thu gọn lịch sử đã nén",
		description:
			"Thu gọn lịch sử trước khi nén phía sau vạch phân cách tóm tắt trong bản ghi trực tiếp; tắt để giữ toàn bộ bản ghi với các vạch phân cách tại mỗi điểm nén",
	},
	showHardwareCursor: {
		label: "Hiển thị con trỏ phần cứng",
		description: "Hiển thị con trỏ terminal để hỗ trợ bộ gõ tiếng Việt (IME)",
	},
	"tui.imeSafeCursor": {
		label: "Bố cục prompt an toàn cho IME",
		description:
			"Chuyển đường viền dưới của prompt sang một dòng riêng để tránh vùng gõ thử trước của IME trên macOS làm lệch vị trí",
	},
	"task.showResolvedModelBadge": {
		label: "Hiển thị huy hiệu mô hình đã giải quyết",
		description: "Hiển thị ID mô hình thực tế mà mỗi subagent sử dụng trên dòng trạng thái widget tác vụ",
	},
	// ── model ───────────────────────────────────────────────────────────────
	"advisor.enabled": {
		label: "Bật Advisor",
		description:
			"Ghép đôi mô hình thứ hai (gán cho vai trò 'advisor') để đánh giá thụ động từng lượt và chèn thêm ghi chú.",
	},
	"prewalk.enabled": {
		label: "Bật Prewalk",
		description:
			"Bắt đầu bằng mô hình hiện tại, sau đó chuyển sang mô hình nhanh/tiết kiệm (mặc định là vai trò 'smol') ở lần chỉnh sửa/ghi đầu tiên sau khi danh sách việc cần làm (todo) của gợi ý kế hoạch xuất hiện — mô hình mạnh sẽ lập kế hoạch, lưu danh sách việc cần làm và bắt đầu triển khai trước khi bàn giao. Có thể ghi đè theo từng phiên bằng --prewalk / --no-prewalk.",
	},
	"task.agentAdvisor": {
		label: "Advisor cho subagent (theo agent)",
		description:
			'Cấu hình mô hình advisor theo tên agent (thay thế advisor.subagents đã bị gỡ bỏ), ví dụ { task: "on" } để bật advisor mặc định cho subagent task.',
	},
	"advisor.syncBacklog": {
		label: "Tồn đọng đồng bộ Advisor",
		description:
			"Tạm dừng agent chính tối đa 30 giây nếu advisor bị tụt lại sau số lượt này. Chọn Off để tắt độ trễ bắt kịp.",
	},
	"advisor.immuneTurns": {
		label: "Số lượt miễn trừ Advisor",
		description:
			"Sau khi một lo ngại hoặc cảnh báo chặn từ advisor gây gián đoạn, các lo ngại/cảnh báo chặn tiếp theo sẽ được chuyển tiếp không gián đoạn trong số lượt chính này.",
	},
	modelRoleStorage: {
		label: "Nơi lưu vai trò mô hình",
		description: "Nơi lưu trữ các chỉ định vai trò trong bộ chọn mô hình",
	},
	"images.describeForTextModels": {
		label: "Mô tả hình ảnh cho mô hình văn bản",
		description:
			"Khi hình ảnh được đính kèm vào mô hình không hỗ trợ thị giác, lưu ảnh dưới local:// và chèn mô tả từ mô hình hỗ trợ thị giác thay vì bỏ qua",
	},
	"images.urls.enabled": {
		label: "Gửi hình ảnh dưới dạng URL",
		description:
			"Phát hành hình ảnh gửi đi qua chuỗi backend đã cấu hình và gửi URL ngắn thay vì chuỗi base64 nội dòng cho các nhà cung cấp hỗ trợ tải URL; tự động chuyển sang nội dòng nếu tất cả backend thất bại",
	},
	"images.urls.backends": {
		label: "Backend URL hình ảnh",
		description: "Thứ tự các đích đến được thử khi phát hành hình ảnh cho nhà cung cấp truy cập",
	},
	"images.urls.options": {
		label: "Tùy chọn backend URL hình ảnh",
		description: "Các tùy chọn JSON được sử dụng bởi từng backend phát hành",
	},
	"images.urls.credentials": {
		label: "Thông tin xác thực backend URL hình ảnh",
		description: "Thông tin xác thực được sử dụng bởi các backend phát hành; giao diện sẽ ẩn giá trị này",
	},
	"images.urls.command": {
		label: "Lệnh tải lên hình ảnh",
		description:
			"Mẫu argv cho backend command; {file} là đường dẫn ảnh, {mime}/{ext} là tùy chọn. URL cuối cùng in ra stdout sẽ được sử dụng",
	},
	"images.urls.publicBaseUrl": {
		label: "URL công khai của hình ảnh",
		description: "URL cơ sở có thể truy cập từ bên ngoài trỏ tới máy chủ blob hình ảnh",
	},
	"images.urls.ttlHours": {
		label: "Thời gian tồn tại URL hình ảnh (giờ)",
		description:
			"Thời gian phục vụ URL hình ảnh lưu trữ cục bộ, tính từ lần cuối cuộc trò chuyện gửi ảnh; 0 giữ liên kết tồn tại trong khi broker chạy",
	},
	"images.urls.bindHost": {
		label: "Host lắng nghe của dịch vụ ảnh",
		description: "Địa chỉ host mà máy chủ blob lắng nghe; loopback cho tunnel, 0.0.0.0 cho phục vụ trực tiếp",
	},
	"images.urls.sshTarget": {
		label: "Đích SSH của hình ảnh",
		description: "Đích user@host để thiết lập chuyển tiếp ngược SSH",
	},
	"images.urls.sshRemotePort": {
		label: "Cổng SSH từ xa của hình ảnh",
		description: "Cổng lắng nghe từ xa của chuyển tiếp ngược SSH mà máy chủ web của bạn chuyển tiếp tới",
	},
	defaultThinkingLevel: {
		label: "Mức độ suy nghĩ",
		description: "Độ sâu suy luận cho các mô hình có khả năng suy nghĩ",
	},
	hideThinkingBlock: {
		label: "Ẩn khối suy nghĩ",
		description: "Ẩn các khối suy nghĩ trong câu trả lời của trợ lý",
	},
	proseOnlyThinking: {
		label: "Chỉ hiển thị văn bản suy nghĩ",
		description: "Lược bỏ các khối mã khỏi bản tóm tắt suy nghĩ và thay thế bằng dấu ba chấm",
	},
	omitThinking: {
		label: "Bỏ qua tóm tắt suy nghĩ",
		description:
			"Yêu cầu nhà cung cấp thượng nguồn bỏ qua hoàn toàn tóm tắt suy nghĩ trong phản hồi (nếu được hỗ trợ)",
	},
	"model.loopGuard.enabled": {
		label: "Bảo vệ chống lặp (Loop Guard)",
		description: "Bật tính năng tự động phát hiện luồng lặp cho suy luận và văn bản của mô hình",
	},
	"model.loopGuard.checkAssistantContent": {
		label: "Quét văn bản chống lặp",
		description: "Áp dụng cơ chế chống lặp cho tin nhắn văn bản của trợ lý ngoài nhật ký suy nghĩ",
	},
	"model.loopGuard.toolCallReminder": {
		label: "Nhắc nhở gọi công cụ chống lặp",
		description:
			"Khi luồng suy luận của Gemini liên tục xuất ra nhiều tiêu đề lập kế hoạch mà không gọi công cụ, ngắt luồng và chèn lời nhắc yêu cầu gọi công cụ (yêu cầu bật Loop Guard)",
	},
	"model.toolCallLoopGuard.enabled": {
		label: "Bảo vệ chống lặp gọi công cụ",
		description: "Phát hiện các lượt gọi công cụ giống hệt nhau liên tiếp qua nhiều lượt và chèn chỉ dẫn điều chỉnh",
	},
	"model.toolCallLoopGuard.threshold": {
		label: "Ngưỡng lặp gọi công cụ",
		description: "Số lần gọi công cụ giống hệt nhau liên tiếp cần thiết trước khi chèn chỉ dẫn điều chỉnh",
	},
	"model.toolCallLoopGuard.exemptTools": {
		label: "Công cụ miễn trừ chống lặp",
		description: "Tên các công cụ được phép lặp lại liên tiếp mà không kích hoạt cơ chế chống lặp giữa các lượt",
	},
	inlineToolDescriptors: {
		label: "Mô tả công cụ nội dòng",
		description:
			"Kết xuất mô tả công cụ đầy đủ trong prompt hệ thống và loại bỏ mô tả cấp cao/lồng nhau khỏi schema công cụ của nhà cung cấp để chỉ gửi văn bản mô tả một lần. Auto bật cho Gemini và tắt cho các mô hình khác",
	},
	includeModelInPrompt: {
		label: "Đưa mô hình vào prompt",
		description:
			"Hiển thị định danh mô hình đang hoạt động trong prompt hệ thống để agent biết mình đang dùng mô hình nào",
	},
	includeWorkspaceTree: {
		label: "Đưa cây thư mục làm việc vào prompt",
		description:
			"Kết xuất cây thư mục không gian làm việc trong prompt hệ thống. Cảnh báo: Việc này có thể làm mất cache prompt giữa các phiên khi tệp bị sửa đổi.",
	},
	skillful: {
		label: "Liệt kê kỹ năng trong prompt",
		description:
			"Liệt kê các kỹ năng khả dụng trong prompt hệ thống; tắt để tiết kiệm ngữ cảnh và bật/tắt theo từng phiên bằng /skillful",
	},
	personality: {
		label: "Tính cách",
		description: "Phong cách giao tiếp được đưa vào khối tính cách trong prompt hệ thống",
	},
	temperature: {
		label: "Nhiệt độ (Temperature)",
		description: "Nhiệt độ lấy mẫu (0 = tất định, 1 = sáng tạo, -1 = mặc định của nhà cung cấp)",
	},
	topP: {
		label: "Top P",
		description: "Ngưỡng lấy mẫu hạt nhân (0-1, -1 = mặc định của nhà cung cấp)",
	},
	topK: {
		label: "Top K",
		description: "Lấy mẫu từ K token có xác suất cao nhất (-1 = mặc định của nhà cung cấp)",
	},
	minP: {
		label: "Min P",
		description: "Ngưỡng xác suất tối thiểu (0-1, -1 = mặc định của nhà cung cấp)",
	},
	presencePenalty: {
		label: "Phạt sự hiện diện (Presence Penalty)",
		description: "Hình phạt khi đưa vào các token đã xuất hiện (-1 = mặc định của nhà cung cấp)",
	},
	repetitionPenalty: {
		label: "Phạt lặp từ (Repetition Penalty)",
		description: "Hình phạt đối với các token lặp lại (-1 = mặc định của nhà cung cấp)",
	},
	textVerbosity: {
		label: "Độ dài chi tiết văn bản",
		description: "Mức độ chi tiết của phản hồi OpenAI Responses và Codex (low, medium hoặc high)",
	},
	"tier.openai": {
		label: "Gói dịch vụ — OpenAI",
		description:
			"Gói xử lý cho yêu cầu OpenAI / OpenAI-Codex và các mô hình thuộc họ OpenAI được định tuyến qua OpenRouter (none = không gửi). Được gửi dưới dạng `service_tier`.",
	},
	"tier.anthropic": {
		label: "Gói dịch vụ — Anthropic",
		description:
			'Gói xử lý cho yêu cầu Claude. `priority` kích hoạt chế độ nhanh (`speed: "fast"`) trên các mô hình Anthropic trực tiếp được hỗ trợ; bị bỏ qua trên Bedrock/Vertex Claude và qua OpenRouter.',
	},
	"tier.google": {
		label: "Gói dịch vụ — Google",
		description:
			"Gói xử lý cho yêu cầu Gemini (Google AI Studio + Vertex) và các mô hình họ Google được định tuyến qua OpenRouter (none = không gửi). Được gửi dưới dạng trường `serviceTier` cấp cao nhất.",
	},
	"tier.subagent": {
		label: "Gói dịch vụ — Subagent",
		description:
			"Gói dịch vụ cho các subagent task/eval được khởi tạo. Inherit = theo gói dịch vụ theo từng họ mô hình hiện tại của agent chính (theo dõi /fast); chọn một giá trị cụ thể để áp dụng cho họ mô hình của subagent.",
	},
	"tier.advisor": {
		label: "Gói dịch vụ — Advisor",
		description:
			"Gói dịch vụ cho mô hình advisor. None = xử lý tiêu chuẩn; Inherit = theo gói dịch vụ theo từng họ mô hình hiện tại của agent chính; chọn một giá trị cụ thể để áp dụng cho họ mô hình của advisor.",
	},
	"retry.maxRetries": { label: "Số lần thử lại", description: "Số lần thử lại tối đa khi gặp lỗi API" },
	"retry.maxDelayMs": {
		label: "Thời gian chờ thử lại tối đa",
		description:
			"Thời gian chờ tối đa giữa các lần thử lại (ms). Khi nhà cung cấp yêu cầu chờ lâu hơn giá trị này và không có thông tin xác thực hoặc mô hình dự phòng nào thành công, yêu cầu sẽ thất bại ngay thay vì ngủ chờ (ví dụ: khoảng giới hạn tốc độ 3 giờ của Anthropic). 0 vô hiệu hóa giới hạn này.",
	},
	"retry.modelFallback": {
		label: "Dự phòng mô hình khi thử lại",
		description: "Cho phép quá trình khôi phục thử lại chuyển sang các mô hình dự phòng đã cấu hình",
	},
	"retry.waitForUsageReset": {
		label: "Chờ đặt lại hạn mức",
		description:
			"Khi nhà cung cấp báo hết hạn mức kèm theo thời gian đặt lại, tạm dừng cho đến khi được đặt lại thay vì báo lỗi nhanh vượt quá retry.maxDelayMs. Có thể hủy bỏ việc chờ; subagent cũng sẽ cùng chờ.",
	},
	"retry.usageAwareFallback": {
		label: "Dự phòng nhận biết mức sử dụng",
		description:
			"Sử dụng báo cáo hạn mức đáng tin cậy của gói lập trình để ưu tiên các tài khoản cùng nhà cung cấp, sau đó đến các mô hình dự phòng đã cấu hình trước khi chạm giới hạn sử dụng cứng. Khóa API thông thường không tham gia.",
	},
	"retry.usageReservePct": {
		label: "Phần trăm dự trữ",
		description:
			"Coi mô hình gói lập trình gần chạm giới hạn khi phần trăm còn lại dưới mức này. Mức sử dụng không xác định sẽ giữ lại mô hình chính.",
	},
	"retry.usageReservePolicy": {
		label: "Chính sách dự trữ",
		description: "Cách xử lý khi tất cả tài khoản gói lập trình cùng nhà cung cấp đều nằm trong ngưỡng dự trữ.",
	},
	"retry.fallbackChains": {
		label: "Chuỗi dự phòng thử lại",
		description:
			'Đối tượng JSON ánh xạ vai trò mô hình, bộ chọn mô hình ("provider/model-id") hoặc ký tự đại diện nhà cung cấp ("provider/*") tới các bộ chọn dự phòng có thứ tự, ví dụ {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}.',
	},
	"retry.fallbackRevertPolicy": {
		label: "Chính sách quay lại sau dự phòng",
		description: "Thời điểm quay trở lại mô hình chính sau khi đã chuyển sang dự phòng",
	},
	"providers.anthropic.serverSideFallback": {
		label: "Dự phòng phía máy chủ Anthropic (Fable 5)",
		description:
			"Khi yêu cầu Claude Fable 5 / Mythos 5 bị bộ phân loại an toàn của Anthropic chặn, thử lại trên Claude Opus 5 ở phía máy chủ (bản thử nghiệm `server-side-fallback-2026-06-01` của Anthropic). Cần bật thủ công — giữ tắt thì tất cả yêu cầu sẽ duy trì hành vi trước khi dự phòng.",
	},
	"providers.autoThinkingModel": {
		label: "Mô hình suy nghĩ tự động",
		description:
			"Bộ phân loại độ khó cho mức suy nghĩ `auto`: mặc định trực tuyến (vai trò TINY trong /models, nếu không thì là smol), hoặc mô hình cục bộ trên thiết bị",
	},
	"providers.autoThinkingMaxEffort": {
		label: "Mức suy nghĩ tự động tối đa",
		description:
			"Mức nỗ lực cao nhất mà bộ phân loại `auto` có thể phân giải. `xhigh` giữ bộ phân loại thấp hơn một bậc so với mức cao nhất, để chỉ `ultrathink` rõ ràng mới đạt `max`; `max` cho phép các lượt được đánh giá là ngoại lệ sử dụng mức cao nhất trên các mô hình có hỗ trợ.",
	},
	// ── interaction ─────────────────────────────────────────────────────────
	autoResume: {
		label: "Tự động khôi phục",
		description: "Tự động khôi phục phiên gần đây nhất trong thư mục hiện tại",
	},
	"power.sleepPrevention": {
		label: "Ngăn chế độ ngủ",
		description:
			"Ngăn hệ thống chuyển sang chế độ ngủ trong các phiên hoạt động (trên macOS). Mỗi mức có tính tích lũy — bổ sung thêm cờ của tất cả các mức thấp hơn.",
	},
	"git.enabled": {
		label: "Bật tích hợp Git",
		description: "Hiển thị nhánh Git, trạng thái và thông tin PR trong TUI và theo dõi siêu dữ liệu kho lưu trữ.",
	},
	steeringMode: {
		label: "Chế độ điều hướng (Steering Mode)",
		description: "Cách xử lý tin nhắn trong hàng đợi khi agent đang hoạt động",
	},
	followUpMode: {
		label: "Chế độ theo dõi tiếp (Follow-Up Mode)",
		description: "Cách giải phóng tin nhắn theo dõi tiếp sau khi một lượt hoàn thành",
	},
	interruptMode: {
		label: "Chế độ ngắt quãng",
		description: "Khi nào tin nhắn điều hướng được phép ngắt thực thi công cụ",
	},
	"loop.mode": {
		label: "Chế độ lặp",
		description: "Hành động diễn ra giữa các lần lặp /loop trước khi gửi lại prompt",
	},
	doubleEscapeAction: {
		label: "Thao tác nhấn đúp Escape",
		description: "Hành động kích hoạt khi nhấn phím Escape hai lần liên tiếp khi trình chỉnh sửa trống",
	},
	treeFilterMode: { label: "Bộ lọc cây phiên", description: "Chế độ lọc mặc định khi mở cây phiên" },
	autocompleteMaxVisible: {
		label: "Số mục tự động điền",
		description: "Số mục tối đa hiển thị trong danh sách thả xuống tự động điền (3-20)",
	},
	emojiAutocomplete: {
		label: "Tự động hoàn thành Emoji",
		description: "Gợi ý emoji từ mã ngắn `:name:` và mở rộng các biểu tượng cảm xúc dạng văn bản như `:D` hoặc `:-)`",
	},
	"paste.largeMenuThreshold": {
		label: "Menu dán văn bản lớn",
		description:
			"Khi đoạn văn bản dán đạt số dòng này, hiển thị menu để bọc vào khối mã, bọc trong thẻ XML hoặc lưu thành tệp. 0 sẽ tắt menu (văn bản lớn vẫn thu gọn thành dấu [Paste]).",
	},
	"startup.quiet": {
		label: "Khởi động im lặng",
		description: "Bỏ qua màn hình chào mừng và thông báo trạng thái khởi động",
	},
	"startup.showSplash": {
		label: "Hiển thị màn hình khởi động",
		description:
			"Hiển thị toàn bộ màn hình hoạt ảnh thiết lập khi khởi động tương tác thông thường mà không chạy lại cài đặt. Khởi động im lặng vẫn sẽ ẩn nó.",
	},
	"startup.setupWizard": {
		label: "Trình hướng dẫn thiết lập",
		description: "Hiển thị các bước làm quen mới được thêm một lần cho mỗi phiên bản cài đặt",
	},
	"startup.checkUpdate": {
		label: "Kiểm tra cập nhật",
		description: "Kiểm tra bản cập nhật omp khi khởi động",
	},
	"marketplace.autoUpdate": {
		label: "Tự động cập nhật chợ tiện ích",
		description: "Kiểm tra bản cập nhật plugin khi khởi động",
	},
	"startup.changelogMode": {
		label: "Nhật ký thay đổi khi khởi động",
		description: "Chọn hiển thị ghi chú cập nhật dưới dạng tóm tắt, chi tiết đầy đủ hoặc luôn ẩn",
	},
	"magicKeywords.enabled": {
		label: "Từ khóa ma thuật",
		description: "Bật thông báo ẩn cho các từ khóa đứng riêng lẻ như ultrathink, orchestrate, workflowz, jevify",
	},
	"magicKeywords.ultrathink": {
		label: "Từ khóa Ultrathink",
		description:
			"Cho phép từ khóa ultrathink đứng riêng yêu cầu mức suy nghĩ tự động tối đa và đính kèm thông báo ẩn",
	},
	"magicKeywords.orchestrate": {
		label: "Từ khóa Orchestrate",
		description: "Cho phép từ khóa orchestrate đứng riêng đính kèm thông báo điều phối nhiều agent ẩn",
	},
	"magicKeywords.workflow": {
		label: "Từ khóa Workflow",
		description: "Cho phép từ khóa workflowz đứng riêng đính kèm thông báo quy trình eval ẩn",
	},
	"completion.notify": {
		label: "Thông báo hoàn thành",
		description: "Thông báo khi agent hoàn thành một lượt xử lý",
	},
	"error.notify": { label: "Thông báo lỗi", description: "Thông báo khi agent dừng lại do gặp lỗi" },
	"ask.timeout": {
		label: "Thời gian chờ câu hỏi",
		description: "Tự động chọn phương án được đề xuất sau số giây này (0 để tắt)",
	},
	"ask.notify": {
		label: "Thông báo câu hỏi",
		description: "Thông báo khi công cụ ask đang chờ bạn nhập dữ liệu",
	},
	"recap.enabled": {
		label: "Tóm tắt khi nhàn rỗi",
		description: "Tạo tóm tắt ngắn từ LLM về tiến độ công việc sau khi terminal ở trạng thái nhàn rỗi",
	},
	"recap.idleSeconds": {
		label: "Độ trễ tóm tắt khi nhàn rỗi",
		description: "Số giây chờ trong trạng thái nhàn rỗi trước khi hiển thị bản tóm tắt",
	},
	"collab.relayUrl": {
		label: "URL chuyển tiếp (Relay URL)",
		description: "Máy chủ chuyển tiếp do /collab sử dụng (wss://host[:port])",
	},
	"collab.webUrl": {
		label: "URL giao diện Web",
		description:
			"Giao diện trình duyệt được sử dụng bởi các liên kết /collab; để trống sẽ suy ra từ collab.relayUrl; http:// rõ ràng chỉ dùng cho localhost",
	},
	"collab.displayName": {
		label: "Tên hiển thị",
		description: "Tên hiển thị với những người cùng tham gia cộng tác (mặc định: tên người dùng hệ điều hành)",
	},
	"share.serverUrl": {
		label: "Máy chủ chia sẻ",
		description:
			"/share sử dụng địa chỉ cơ sở xem/tải lên chia sẻ (tải lên blob mã hóa + trình xem; liên kết có dạng <base>/<id>#<key>)",
	},
	"share.store": {
		label: "Bộ lưu trữ chia sẻ",
		description: "Nơi /share tải lên blob phiên được mã hóa",
	},
	"share.redactSecrets": {
		label: "Khử nhạy cảm thông tin bí mật khi chia sẻ",
		description:
			"Chạy trình làm mờ thông tin bí mật trên các bản chụp nhanh /share trước khi tải lên (sử dụng cấu hình secrets.*)",
	},
	"stt.enabled": {
		label: "Chuyển giọng nói thành văn bản",
		description: "Bật nhập liệu bằng giọng nói thành văn bản qua micro",
	},
	"stt.modelName": {
		label: "Mô hình nhận dạng giọng nói",
		description:
			"Mô hình giọng nói cục bộ trên thiết bị. Parakeet TDT v3 (sherpa-onnx) là mặc định SoTA; Whisper base/small/large-v3-turbo (transformers.js) đánh đổi kích thước lấy độ phủ đa ngôn ngữ. Tải xuống trong lần sử dụng đầu tiên.",
	},
	"stt.submitTrigger": {
		label: "Kích hoạt gửi khi đọc chính tả",
		description:
			"Chọn thời điểm tự động gửi khi đọc chính tả: Không bao giờ, Nhả phím (từ 2 từ trở lên), Nhả phím khi câu hoàn chỉnh, hoặc Khi tôi nói 'Gửi'.",
	},
	"tools.approval": {
		label: "Chính sách phê duyệt công cụ",
		description:
			"Cấu hình chính sách phê duyệt cho từng công cụ. Đặt thành 'allow' để tự động phê duyệt, 'prompt' để yêu cầu xác nhận, 'deny' để chặn. Các ghi đè này có hiệu lực trong mọi chế độ phê duyệt.",
	},
	"tools.approvalMode": {
		label: "Phê duyệt công cụ",
		description:
			"Hành vi phê duyệt mặc định cho các lệnh gọi công cụ. 'Luôn hỏi' chỉ tự động phê duyệt công cụ chỉ đọc; 'Ghi' tự động phê duyệt công cụ đọc và ghi không gian làm việc; 'Yolo' tự động phê duyệt tất cả các cấp, nhưng chính sách của người dùng vẫn có thể nhắc nhở hoặc chặn.",
	},
	"features.unexpectedStopDetection": {
		label: "Phát hiện dừng đột ngột",
		description:
			"Sử dụng mô hình nhỏ để phát hiện trường hợp trợ lý tuyên bố tiếp tục nhưng lại dừng mà không gọi công cụ; tự động nhắc nó tiếp tục.",
	},
	// ── context ─────────────────────────────────────────────────────────────
	"workspace.additionalDirectories": {
		label: "Thư mục không gian làm việc bổ sung",
		description:
			"Các thư mục không gian làm việc bổ sung được thêm vào mỗi phiên làm thư mục gốc phụ (không gian làm việc đa gốc). Được quản lý trực tiếp qua /add-dir và /remove-dir. Đường dẫn phân giải tương đối với cwd; khuyến nghị dùng đường dẫn tuyệt đối. Agent sẽ được thông báo về các thư mục gốc này và có thể read/grep/glob trên chúng.",
	},
	"contextPromotion.enabled": {
		label: "Tự động nâng cấp ngữ cảnh",
		description: "Nâng cấp lên mô hình có ngữ cảnh lớn hơn khi tràn ngữ cảnh thay vì nén",
	},
	extendedContext: {
		label: "Mở rộng ngữ cảnh",
		description:
			"Sử dụng cửa sổ ngữ cảnh lớn hơn ở những nơi được hỗ trợ; có thể phát sinh chi phí cao hơn. Tắt để giữ cửa sổ mặc định hoặc giá tiêu chuẩn.",
	},
	"compaction.enabled": { label: "Tự động nén", description: "Tự động nén khi ngữ cảnh tăng" },
	"compaction.midTurnEnabled": {
		label: "Nén giữa lượt",
		description:
			"Kiểm tra các ngưỡng tại ranh giới vòng lặp công cụ an toàn giữa lượt trước yêu cầu tiếp theo tới nhà cung cấp; subagent luôn kiểm tra vì toàn bộ nhiệm vụ của chúng là một lượt",
	},
	"compaction.methodOrder": {
		label: "Thứ tự phương pháp nén",
		description:
			"Thứ tự ưu tiên dự phòng cho việc tự động duy trì ngữ cảnh; các phương pháp không khả dụng hoặc thất bại sẽ chuyển sang lựa chọn tiếp theo",
	},
	"compaction.thresholdPercent": {
		label: "Ngưỡng nén",
		description: "Ngưỡng phần trăm để duy trì ngữ cảnh; đặt thành Default để sử dụng hành vi dựa trên dự trữ cũ",
	},
	"compaction.thresholdTokens": {
		label: "Giới hạn token nén",
		description: "Giới hạn token cố định để duy trì ngữ cảnh; ghi đè phần trăm nếu được thiết lập",
	},
	"compaction.handoffSaveToDisk": {
		label: "Lưu tài liệu bàn giao",
		description: "Lưu các tài liệu bàn giao được tạo thành tệp markdown cho quy trình tự động bàn giao",
	},
	"compaction.remoteStreamingV2Enabled": {
		label: "Nén từ xa V2",
		description: "Sử dụng tính năng nén truyền phát Responses cho các mô hình nén từ xa tương thích",
	},
	"compaction.asyncEnabled": {
		label: "Nén bất đồng bộ",
		description:
			"Tóm tắt trước trong nền khi ngữ cảnh tiến gần đến ngưỡng nén, sau đó ghép nối kết quả đã sẵn sàng vào khi vượt ngưỡng",
	},
	"compaction.idleEnabled": {
		label: "Nén khi nhàn rỗi",
		description: "Nén ngữ cảnh khi ở trạng thái nhàn rỗi nếu số lượng token vượt quá ngưỡng",
	},
	"compaction.idleThresholdTokens": {
		label: "Ngưỡng nén khi nhàn rỗi",
		description: "Số lượng token kích hoạt việc nén khi nhàn rỗi",
	},
	"compaction.idleTimeoutSeconds": {
		label: "Độ trễ nén khi nhàn rỗi",
		description: "Số giây chờ trong trạng thái nhàn rỗi trước khi bắt đầu nén",
	},
	"compaction.supersedeReads": {
		label: "Thay thế các lần đọc cũ",
		description: "Cắt tỉa các kết quả đọc cũ hơn khi cùng một tệp được đọc lại (nhận biết cache, chạy mỗi lượt)",
	},
	"compaction.dropUseless": {
		label: "Lược bỏ kết quả vô ích",
		description:
			"Cắt tỉa các kết quả công cụ bị đánh dấu là vô ích về mặt ngữ cảnh (không có kết quả khớp, chờ quá thời gian) sau khi đã tiêu thụ (nhận biết cache)",
	},
	"snapcompact.systemPrompt": {
		label: "Prompt hệ thống Snapcompact",
		description:
			"Thử nghiệm: kết xuất văn bản prompt hệ thống đã chọn thành (các) hình ảnh PNG dày đặc và đính kèm vào tin nhắn đầu tiên của người dùng (chỉ áp dụng cho mô hình thị giác). Tiết kiệm token; mất cache prompt cho phần văn bản được chuyển thành hình ảnh.",
	},
	"snapcompact.toolResults": {
		label: "Kết quả công cụ Snapcompact",
		description:
			"Thử nghiệm: kết xuất kết quả công cụ lịch sử kích thước lớn thành (các) hình ảnh PNG dày đặc thay vì văn bản (chỉ áp dụng cho mô hình thị giác). Tiết kiệm token từ đầu ra đọc/tìm kiếm tích lũy.",
	},
	"tools.format": {
		label: "Chế độ gọi công cụ",
		description:
			"Kiểm soát cách thức công cụ hiển thị với mô hình. Auto sử dụng lệnh gọi công cụ gốc của nhà cung cấp trừ khi mô hình được chọn bị đánh dấu là không hỗ trợ, khi đó sẽ dùng phương ngữ riêng của GLM. Native bắt buộc dùng công cụ gốc của nhà cung cấp; các giá trị khác bắt buộc phương ngữ riêng được chỉ định.",
	},
	"snapcompact.shape": {
		label: "Khuôn dạng Snapcompact",
		description:
			"Hình dạng khung mà snapcompact dùng để in văn bản (lưu trữ nén và chụp ảnh nội dòng). Auto sẽ chọn hình dạng được điều chỉnh tối ưu cho mô hình hiện tại.",
	},
	"branchSummary.enabled": {
		label: "Tóm tắt nhánh",
		description: "Nhắc nhở tạo tóm tắt khi rời khỏi một nhánh",
	},
	"ttsr.enabled": {
		label: "TTSR",
		description:
			"Ngắt dòng xuất của agent ngay trong luồng khi đầu ra khớp với các mẫu quy tắc (Time-Traveling Stream Rules)",
	},
	"ttsr.contextMode": {
		label: "Chế độ ngữ cảnh TTSR",
		description: "Cách xử lý phần đầu ra một phần khi TTSR được kích hoạt",
	},
	"ttsr.interruptMode": {
		label: "Chế độ ngắt quãng TTSR",
		description: "Khi nào nên ngắt ngay giữa luồng so với việc chèn cảnh báo sau khi hoàn thành",
	},
	"ttsr.repeatMode": {
		label: "Chế độ lặp lại TTSR",
		description: "Cách các quy tắc có thể lặp lại: một lần mỗi phiên hoặc sau khoảng cách tin nhắn",
	},
	"ttsr.repeatGap": {
		label: "Khoảng cách lặp lại TTSR",
		description: "Số lượng tin nhắn trước khi một quy tắc có thể kích hoạt lại",
	},
	"ttsr.builtinRules": {
		label: "Quy tắc tích hợp sẵn",
		description:
			"Tải các quy tắc mặc định đi kèm với agent (có thể ghi đè riêng từng quy tắc bằng ttsr.disabledRules)",
	},
	"ttsr.disabledRules": {
		label: "Vô hiệu hóa quy tắc",
		description:
			"Tên các quy tắc cần bỏ qua hoàn toàn (áp dụng cho cả quy tắc mặc định đi kèm và quy tắc của riêng bạn)",
	},
	// ── memory ──────────────────────────────────────────────────────────────
	"memory.backend": {
		label: "Backend bộ nhớ",
		description:
			"Tắt, đường ống tóm tắt cục bộ, SQLite Mnemopi, bộ nhớ từ xa Hindsight, hoặc bộ nhớ quyết định dự án Sharpshooter",
	},
	"sharpshooter.model": {
		label: "Mô hình Sharpshooter",
		description: "Bộ chọn mô hình để trích xuất/hợp nhất quyết định dự án; để trống sẽ dùng vai trò smol",
	},
	"sharpshooter.intervalMinutes": {
		label: "Khoảng thời gian hợp nhất Sharpshooter",
		description: "Số phút giữa các lần hợp nhất quyết định dự án đang chờ xử lý trong nền",
	},
	"sharpshooter.injectionTokenLimit": {
		label: "Giới hạn token chèn Sharpshooter",
		description: "Số token tối đa của bộ nhớ quyết định dự án được chèn vào ngữ cảnh mỗi lượt",
	},
	"autolearn.enabled": {
		label: "Tự động học (thử nghiệm)",
		description:
			"Sau khi agent dừng, nhắc nó ghi lại các bài học kinh nghiệm vào bộ nhớ và tạo/hoàn thiện các kỹ năng được quản lý cô lập",
	},
	"autolearn.autoContinue": {
		label: "Tự động ghi lại khi dừng",
		description:
			"Khi bật, tự động chạy một lượt ghi lại riêng tư khi dừng (sử dụng thêm token). Khi tắt, chỉ giữ lại hướng dẫn tự động học thường trực.",
	},
	"mnemopi.dbPath": {
		label: "Đường dẫn cơ sở dữ liệu Mnemopi",
		description: "Đường dẫn tệp DB SQLite tùy chọn. Mặc định là thư mục bộ nhớ của agent.",
	},
	"mnemopi.bank": {
		label: "Ngân hàng bộ nhớ Mnemopi",
		description:
			"Tên cơ sở của ngân hàng bộ nhớ dùng chung tùy chọn. Các chế độ theo dự án sẽ suy ra ngân hàng cục bộ của dự án từ tên này.",
	},
	"mnemopi.scoping": {
		label: "Phạm vi Mnemopi",
		description:
			"global = một ngân hàng dùng chung; per-project = ngân hàng cô lập cho từng cwd; per-project-tagged = ghi vào cục bộ dự án kèm hiển thị tìm kiếm toàn cục",
	},
	"mnemopi.embeddingVariant": {
		label: "Biến thể mô hình embedding",
		description:
			"Họ mô hình embedding cục bộ. en = mô hình tiếng Anh mạnh hơn; multilingual = mô hình đa ngôn ngữ. Thay đổi mục này sẽ xây dựng lại embedding bộ nhớ hiện có trong lần khởi động tiếp theo.",
	},
	"mnemopi.autoRecall": {
		label: "Tự động gọi lại Mnemopi",
		description: "Gọi lại ký ức cục bộ vào lượt đầu tiên của mỗi phiên",
	},
	"mnemopi.autoRetain": {
		label: "Tự động lưu giữ Mnemopi",
		description: "Lưu giữ các lượt hội thoại đã hoàn thành vào bộ nhớ Mnemopi cục bộ",
	},
	"mnemopi.polyphonicRecall": {
		label: "Gọi lại đa âm Mnemopi",
		description:
			"Kết hợp tìm kiếm với các luồng đồ thị, sự kiện, vector và thời gian để các ký ức liên kết xuất hiện mà không cần khớp từ khóa",
	},
	"mnemopi.enhancedRecall": {
		label: "Gọi lại nâng cao Mnemopi",
		description:
			"Lưu bộ nhớ đệm kết quả tìm kiếm cho các truy vấn lặp lại và tương tự có tùy chọn giống nhau; bất kỳ thao tác ghi bộ nhớ nào cũng sẽ xóa bộ nhớ đệm này",
	},
	"mnemopi.proactiveLinking": {
		label: "Chủ động liên kết Mnemopi",
		description:
			"Đưa các ký ức mới vào đồ thị tình huống ngay khi lưu trữ, liên kết chúng với các thực thể và ký ức liên quan",
	},
	"mnemopi.noEmbeddings": {
		label: "Vô hiệu hóa embedding Mnemopi",
		description: "Bắt buộc chỉ dùng tìm kiếm toàn văn (FTS) tất định thay vì embedding vector",
	},
	"mnemopi.embeddingModel": {
		label: "Mô hình embedding Mnemopi",
		description:
			"Nâng cao: ID mô hình embedding rõ ràng ghi đè thiết lập biến thể. Để trống để sử dụng mnemopi.embeddingVariant.",
	},
	"mnemopi.embeddingApiUrl": {
		label: "URL API embedding Mnemopi",
		description: "Điểm cuối API embedding tương thích OpenAI tùy chọn truyền cho Mnemopi",
	},
	"mnemopi.embeddingApiKey": {
		label: "Khóa API embedding Mnemopi",
		description: "Khóa API embedding tùy chọn truyền cho Mnemopi",
	},
	"mnemopi.llmMode": {
		label: "Chế độ LLM Mnemopi",
		description:
			"Không dùng LLM, dùng mô hình nhỏ trực tuyến (vai trò TINY từ /models, nếu không thì là @smol), hoặc điểm cuối từ xa tương thích OpenAI",
	},
	"mnemopi.llmBaseUrl": {
		label: "URL cơ sở LLM Mnemopi",
		description: "Điểm cuối LLM tương thích OpenAI tùy chọn cho chế độ từ xa của Mnemopi",
	},
	"mnemopi.llmApiKey": {
		label: "Khóa API LLM Mnemopi",
		description: "Khóa API LLM tùy chọn cho chế độ từ xa của Mnemopi",
	},
	"mnemopi.llmModel": {
		label: "Mô hình LLM Mnemopi",
		description: "Tên mô hình LLM tùy chọn cho chế độ từ xa của Mnemopi",
	},
	"hindsight.apiUrl": {
		label: "URL API Hindsight",
		description: "URL máy chủ Hindsight (Đám mây hoặc tự lưu trữ)",
	},
	"hindsight.apiToken": {
		label: "Token API Hindsight",
		description: "Token Bearer cho các máy chủ Hindsight có xác thực",
	},
	"hindsight.bankId": {
		label: "ID ngân hàng Hindsight",
		description: "Định danh ngân hàng bộ nhớ (mặc định: tên dự án)",
	},
	"hindsight.scoping": {
		label: "Phạm vi Hindsight",
		description:
			"global = một ngân hàng dùng chung; per-project = ngân hàng cô lập cho từng cwd; per-project-tagged = ngân hàng dùng chung gắn thẻ dự án để ký ức toàn cục và dự án hòa nhập khi tìm kiếm",
	},
	"hindsight.autoRecall": {
		label: "Tự động gọi lại Hindsight",
		description: "Gọi lại ký ức vào lượt đầu tiên của mỗi phiên",
	},
	"hindsight.autoRetain": {
		label: "Tự động lưu giữ Hindsight",
		description: "Lưu giữ bản ghi sau mỗi N lượt và tại các ranh giới phiên",
	},
	"hindsight.retainMode": {
		label: "Chế độ lưu giữ Hindsight",
		description: "full-session = cập nhật/chèn một tài liệu cho mỗi phiên, last-turn = chia khối",
	},
	"hindsight.mentalModelsEnabled": {
		label: "Mô hình nhận thức Hindsight",
		description:
			"Đọc các bản tóm tắt phản tư chọn lọc (mô hình nhận thức) vào chỉ dẫn của nhà phát triển khi khởi động. Tải các mô hình hiện có trên ngân hàng — không ghi. Kết hợp với hindsight.mentalModelAutoSeed để tự động tạo tập giống tích hợp sẵn.",
	},
	"hindsight.mentalModelAutoSeed": {
		label: "Tự động tạo giống mô hình nhận thức Hindsight",
		description:
			"Khi bắt đầu phiên, tạo bất kỳ mô hình nhận thức tích hợp sẵn nào (quy ước dự án, quyết định dự án, tùy chọn người dùng) chưa tồn tại trên ngân hàng.",
	},
	"providers.memoryModel": {
		label: "Mô hình bộ nhớ",
		description:
			"LLM được Mnemopi sử dụng để trích xuất và củng cố sự kiện: mặc định trực tuyến (vai trò TINY trong /models, nếu không thì là smol/từ xa), hoặc mô hình cục bộ trên thiết bị",
	},
	// ── files ───────────────────────────────────────────────────────────────
	"edit.mode": {
		label: "Chế độ chỉnh sửa",
		description: "Chọn biến thể công cụ chỉnh sửa (replace, patch, hashline hoặc apply_patch)",
	},
	"edit.fuzzyMatch": {
		label: "Khớp mờ (Fuzzy Match)",
		description: "Chấp nhận khớp mờ độ tin cậy cao đối với khác biệt khoảng trắng",
	},
	"edit.fuzzyThreshold": {
		label: "Ngưỡng khớp mờ",
		description: "Ngưỡng độ tương đồng (0-1) để chấp nhận khớp mờ",
	},
	"edit.streamingAbort": {
		label: "Hủy khi xem trước thất bại",
		description: "Hủy lệnh gọi công cụ chỉnh sửa dạng luồng khi xem trước bản vá thất bại",
	},
	"edit.recoverInlineEdits": {
		label: "Khôi phục nội dung chỉnh sửa nội dòng",
		description:
			"Chuyển đổi tải trọng chỉnh sửa mà mô hình xuất ra dưới dạng văn bản thuần túy thành các lệnh gọi công cụ edit và thực thi",
	},
	"edit.blockAutoGenerated": {
		label: "Chặn tệp tự động tạo",
		description: "Ngăn chặn chỉnh sửa các tệp có vẻ được tạo tự động (protoc, sqlc, swagger, v.v.)",
	},
	"edit.enforceSeenLines": {
		label: "Bắt buộc kiểm tra dòng đã thấy",
		description: "Từ chối các chỉnh sửa neo trên các dòng mà lệnh đọc/tìm kiếm trước đó chưa từng hiển thị đầy đủ",
	},
	"edit.blackbox.enabled": {
		label: "Ghi lại lỗi phân tích cú pháp chỉnh sửa",
		description:
			"Ghi lại mã nguồn trước/sau đầy đủ vào nhật ký chẩn đoán cục bộ khi chỉnh sửa dẫn đến lỗi phân tích cú pháp AST",
	},
	readLineNumbers: {
		label: "Số dòng",
		description: "Thêm số dòng vào đầu đầu ra của công cụ read theo mặc định",
	},
	"read.defaultLimit": {
		label: "Số dòng đọc mặc định",
		description: "Số dòng mặc định được trả về khi agent gọi read mà không chỉ định giới hạn",
	},
	"read.renderMarkdown": {
		label: "Xem trước Markdown",
		description:
			"Kết xuất kết quả đọc Markdown dưới dạng bản xem trước Markdown được định dạng trong terminal thay vì mã nguồn thô",
	},
	"read.summarize.enabled": {
		label: "Tóm tắt nội dung đọc",
		description: "Trả về bản tóm tắt mã có cấu trúc khi gọi read mà không có bộ chọn rõ ràng",
	},
	"read.summarize.prose": {
		label: "Tóm tắt văn bản",
		description: "Trả về bản tóm tắt có cấu trúc khi đọc Markdown và văn bản thuần túy",
	},
	"read.summarize.minBodyLines": {
		label: "Số dòng thân hàm tối thiểu để thu gọn",
		description: "Độ dài thân hàm hoặc giá trị đa dòng tối thiểu trước khi tóm tắt nội dung đọc thu gọn nó",
	},
	"read.summarize.minCommentLines": {
		label: "Số dòng chú thích tối thiểu để thu gọn",
		description: "Độ dài khối chú thích đa dòng tối thiểu trước khi tóm tắt nội dung đọc thu gọn nó",
	},
	"read.summarize.minTotalLines": {
		label: "Số dòng tệp tối thiểu để tóm tắt",
		description: "Các tệp có tổng số dòng ít hơn giá trị này sẽ được đọc nguyên văn thay vì tóm tắt có cấu trúc",
	},
	"read.summarize.unfoldUntil": {
		label: "Mục tiêu mở rộng tóm tắt",
		description:
			"Mở rộng BFS các đoạn có thể lược bỏ cho đến khi bản tóm tắt đạt ít nhất số dòng hiển thị này. 0 chỉ giữ lại các phần lược bỏ ngoài cùng.",
	},
	"read.summarize.unfoldLimit": {
		label: "Giới hạn mở rộng tóm tắt",
		description:
			"Giới hạn cứng về kích thước tóm tắt khi mở rộng BFS. Một thao tác mở rộng vượt quá giới hạn này sẽ bị bỏ qua (đoạn đó vẫn thu gọn) và tiếp tục với các đoạn còn lại.",
	},
	"read.toolResultPreview": {
		label: "Xem trước kết quả đọc nội dòng",
		description: "Kết xuất kết quả công cụ read nội dòng trong bản ghi thay vì các dòng tóm tắt",
	},
	"lsp.enabled": {
		label: "LSP",
		description: "Bật công cụ lsp để hỗ trợ trí thông minh mã nguồn (định nghĩa, tham chiếu, chẩn đoán, đổi tên)",
	},
	"lsp.lazy": {
		label: "Khởi động LSP lười (Lazy)",
		description:
			"Chỉ khởi động máy chủ ngôn ngữ ở lần sử dụng đầu tiên (công cụ lsp hoặc chỉnh sửa loại tệp phù hợp) thay vì khi bắt đầu phiên",
	},
	"lsp.formatOnWrite": {
		label: "Định dạng sau khi ghi",
		description: "Tự động định dạng tệp mã nguồn bằng LSP sau khi ghi",
	},
	"lsp.diagnosticsOnWrite": {
		label: "Chẩn đoán sau khi ghi",
		description: "Trả về chẩn đoán LSP sau khi ghi tệp mã nguồn",
	},
	"lsp.diagnosticsOnEdit": {
		label: "Chẩn đoán sau khi chỉnh sửa",
		description: "Trả về chẩn đoán LSP sau khi chỉnh sửa tệp mã nguồn",
	},
	"lsp.diagnosticsDeduplicate": {
		label: "Khử trùng lặp chẩn đoán",
		description:
			"Ẩn các chẩn đoán LSP sau chỉnh sửa đã hiển thị trước đó cho tệp; chỉ hiển thị các chẩn đoán mới hoặc đã thay đổi",
	},
	// ── shell ───────────────────────────────────────────────────────────────
	"bash.enabled": { label: "Bash", description: "Bật công cụ bash để thực thi lệnh shell" },
	"bash.allowCompoundCommands": {
		label: "Phê duyệt từng lệnh trong chuỗi lệnh kép",
		description:
			"Đánh giá từng lệnh đơn lẻ trong chuỗi &&; các lệnh không khớp sẽ tuân theo chính sách và chế độ phê duyệt bash thông thường",
	},
	"bash.autoBackground.enabled": {
		label: "Tự động chuyển Bash vào nền",
		description: "Tự động chuyển các lệnh bash chạy lâu vào chế độ nền và trả về kết quả sau",
	},
	"bash.patterns": {
		label: "Mẫu phê duyệt Bash",
		description:
			"Các quy tắc phê duyệt lệnh bash có thứ tự. Mỗi mục chứa các trường match và approval; chỉ hỗ trợ ký tự đại diện '*'.",
	},
	"bashInterceptor.enabled": {
		label: "Trình chặn lệnh Bash",
		description: "Chặn các lệnh shell đã có công cụ chuyên dụng tương ứng",
	},
	"bash.direnv": {
		label: "Tự động tải direnv",
		description:
			"Tự động tải `.envrc` direnv/devenv của kho lưu trữ vào phiên bash để các công cụ và biến môi trường devenv sẵn sàng mà không cần chạy `direnv exec` thủ công. Tuân thủ danh sách cho phép của direnv: `.envrc` chưa qua `direnv allow` sẽ không bao giờ được thực thi",
	},
	"bash.direnvLoadTimeoutMs": {
		label: "Thời gian chờ tải direnv (ms)",
		description:
			"Thời gian chờ tối đa cho lần `direnv export` đầu tiên (shell devenv khởi động nguội có thể chậm); khi quá thời gian chờ, phiên sẽ chạy mà không có môi trường direnv",
	},
	"shellMinimizer.enabled": {
		label: "Thu gọn đầu ra Shell",
		description: "Nén đầu ra shell dài dòng (git, npm, cargo, v.v.) trước khi trả về cho agent",
	},
	"shellMinimizer.sourceOutlineLevel": {
		label: "Đề cương mã nguồn thu gọn Shell",
		description: "Chế độ phác thảo mã nguồn khi cat/read tệp mã nguồn: default hoặc aggressive",
	},
	"eval.py": {
		label: "Backend Eval Python",
		description: "Cho phép công cụ eval gửi các ô Python tới kernel IPython",
	},
	"eval.js": {
		label: "Backend Eval JavaScript",
		description: "Cho phép công cụ eval gửi các ô JavaScript tới môi trường chạy trong tiến trình",
	},
	"eval.tools.enabled": {
		label: "Công cụ do Eval định nghĩa",
		description:
			"Cho phép các ô eval định nghĩa công cụ (@tool trong Python, tool(fn) trong JS) mà các subagent task, agent() và workpool() có thể gọi",
	},
	"eval.workpool.freshAgents": {
		label: "Agent mới cho Workpool",
		description:
			"Khởi tạo subagent mới cho mỗi mục workpool thay vì tái sử dụng worker hoặc xử lý hàng loạt các mục trong hàng đợi",
	},
	"eval.rb": {
		label: "Backend Eval Ruby",
		description: "Cho phép công cụ eval gửi các ô Ruby tới kernel Ruby tồn tại lâu dài",
	},
	"eval.jl": {
		label: "Backend Eval Julia",
		description: "Cho phép công cụ eval gửi các ô Julia tới kernel Julia tồn tại lâu dài",
	},
	"python.kernelMode": {
		label: "Chế độ Kernel Python",
		description: "Giữ kernel IPython tồn tại giữa các lệnh gọi eval hoặc khởi động mới mỗi lần",
	},
	"python.interpreter": {
		label: "Trình thông dịch Python",
		description:
			"Đường dẫn tùy chọn tới tệp thực thi Python chính xác. Khi được đặt, việc tự động dò tìm môi trường chạy Python sẽ được bỏ qua.",
	},
	"ruby.interpreter": {
		label: "Trình thông dịch Ruby",
		description:
			"Đường dẫn tùy chọn tới tệp thực thi Ruby chính xác. Khi được đặt, việc tự động dò tìm môi trường chạy Ruby sẽ được bỏ qua.",
	},
	"julia.interpreter": {
		label: "Trình thông dịch Julia",
		description:
			"Đường dẫn tùy chọn tới tệp thực thi Julia chính xác. Khi được đặt, việc tự động dò tìm môi trường chạy Julia sẽ được bỏ qua.",
	},
	// ── tools ───────────────────────────────────────────────────────────────
	"tools.artifactSpillThreshold": {
		label: "Ngưỡng tràn Artifact (KB)",
		description: "Đầu ra công cụ vượt quá kích thước này sẽ được lưu thành artifact; phần đuôi được giữ nội dòng",
	},
	"tools.artifactTailBytes": {
		label: "Kích thước đuôi Artifact (KB)",
		description: "Lượng nội dung đuôi được giữ nội dòng khi đầu ra tràn thành artifact",
	},
	"tools.artifactHeadBytes": {
		label: "Kích thước đầu Artifact (KB)",
		description:
			"Lượng nội dung đầu được giữ nội dòng cùng với phần đuôi khi đầu ra tràn thành artifact (lược bỏ phần giữa). 0 để tắt — chỉ giữ phần đuôi.",
	},
	"tools.outputMaxColumns": {
		label: "Giới hạn số cột đầu ra",
		description:
			"Giới hạn byte trên mỗi dòng cho đầu ra công cụ dạng luồng (bash, python, js eval) và `read`. Các dòng rộng hơn mức này sẽ bị cắt bớt bằng dấu ba chấm; các byte còn lại cho đến dòng mới tiếp theo sẽ bị bỏ qua. 0 để tắt.",
	},
	"tools.artifactTailLines": {
		label: "Số dòng đuôi Artifact",
		description: "Số dòng nội dung đuôi tối đa được giữ nội dòng khi đầu ra tràn thành artifact",
	},
	"todo.enabled": { label: "Việc cần làm (Todo)", description: "Bật công cụ todo để theo dõi tác vụ" },
	"todo.reminders": {
		label: "Nhắc nhở việc cần làm",
		description: "Nhắc nhở agent hoàn thành danh sách việc cần làm trước khi dừng",
	},
	"todo.remindersMax": {
		label: "Giới hạn nhắc nhở việc cần làm",
		description: "Số lần nhắc nhở việc cần làm tối đa trước khi từ bỏ",
	},
	"todo.eager": {
		label: "Tự động tạo việc cần làm",
		description: "Mức độ thúc đẩy việc tự động tạo danh sách việc cần làm sau tin nhắn đầu tiên",
	},
	"glob.enabled": { label: "Glob", description: "Bật công cụ glob để tìm kiếm tệp dựa trên mẫu glob" },
	"grep.enabled": {
		label: "Grep",
		description: "Bật công cụ grep để tìm kiếm nội dung bằng biểu thức chính quy (regex)",
	},
	"grep.contextBefore": {
		label: "Số dòng ngữ cảnh phía trước Grep",
		description: "Số dòng ngữ cảnh hiển thị trước mỗi kết quả khớp grep",
	},
	"grep.contextAfter": {
		label: "Số dòng ngữ cảnh phía sau Grep",
		description: "Số dòng ngữ cảnh hiển thị sau mỗi kết quả khớp grep",
	},
	"astGrep.enabled": {
		label: "AST Grep",
		description: "Bật công cụ ast_grep để tìm kiếm AST có cấu trúc",
	},
	"astEdit.enabled": {
		label: "AST Edit",
		description: "Bật công cụ ast_edit để viết lại AST có cấu trúc",
	},
	"debug.enabled": { label: "Gỡ lỗi (Debug)", description: "Bật công cụ debug để gỡ lỗi dựa trên DAP" },
	"launch.enabled": {
		label: "Dịch vụ (Services)",
		description: "Bật các dịch vụ bash có tên và giám sát proc:// cho các tiến trình dự án dài hạn dùng chung",
	},
	"speechgen.enabled": {
		label: "Tạo giọng nói",
		description: "Bật công cụ tts để tổng hợp tệp giọng nói trên thiết bị (Kokoro) hoặc xAI Grok Voice",
	},
	"generate_image.enabled": {
		label: "Tạo hình ảnh",
		description:
			"Bật công cụ generate_image (tạo ảnh từ văn bản và chỉnh sửa ảnh). Được hiển thị dưới dạng thiết bị xd:// khi tools.xdev bật.",
	},
	"computer.enabled": {
		label: "Điều khiển máy tính",
		description:
			"Bật tiền đề eval điều khiển máy tính máy chủ có thể viết kịch bản (chụp ảnh màn hình, nhập liệu, trợ năng)",
	},
	"computer.backend": {
		label: "Backend điều khiển máy tính",
		description: "Chọn tự động hoặc chỉ định rõ ràng cơ chế chụp màn hình và nhập liệu gốc của nền tảng",
	},
	"computer.display": {
		label: "Màn hình điều khiển máy tính",
		description: "Ghép tất cả màn hình hoặc chọn một ID màn hình gốc",
	},
	"computer.maxWidth": {
		label: "Chiều rộng ảnh chụp màn hình tối đa",
		description: "Chiều rộng ảnh chụp màn hình ghép tối đa tính bằng pixel",
	},
	"computer.maxHeight": {
		label: "Chiều cao ảnh chụp màn hình tối đa",
		description: "Chiều cao ảnh chụp màn hình ghép tối đa tính bằng pixel",
	},
	"images.questionTimeoutMs": {
		label: "Thời gian chờ câu hỏi hình ảnh",
		description:
			"Thời gian chờ cho mỗi yêu cầu gọi mô hình thị giác đằng sau câu hỏi ảnh ?q= của read (ms). Cung cấp lỗi hết thời gian chờ thay vì chặn đến khi hủy thủ công. Đặt thành 0 để tắt thời gian chờ.",
	},
	"checkpoint.enabled": {
		label: "Điểm kiểm tra/Hoàn tác",
		description: "Bật các công cụ checkpoint và rewind để quản lý điểm kiểm tra ngữ cảnh",
	},
	"fetch.enabled": { label: "Đọc URL", description: "Cho phép công cụ read tìm nạp và xử lý các URL" },
	"vault.enabled": {
		label: "Obsidian Vault",
		description:
			"Bật URL nội bộ vault:// để đọc và chỉnh sửa nội dung vault Obsidian qua Obsidian CLI. Khi tắt, việc phân giải vault:// bị từ chối và mục vault:// bị bỏ khỏi prompt hệ thống.",
	},
	"github.enabled": {
		label: "GitHub CLI",
		description:
			"Bật công cụ github (điều phối dựa trên tác vụ cho kho lưu trữ, issue, pull request, diff, tìm kiếm, checkout, push và theo dõi Actions)",
	},
	"github.cache.enabled": {
		label: "Bộ nhớ đệm xem GitHub",
		description:
			"Lưu kết quả hiển thị issue/PR vào ~/.omp/cache/github-cache.db để các lần đọc lặp lại không tốn chi phí",
	},
	"github.cache.softTtlSec": {
		label: "TTL mềm bộ nhớ đệm GitHub",
		description:
			"Trong khoảng thời gian này, các dòng xem issue/PR đã lưu trong cache sẽ được trả về trực tiếp (giây; mặc định 5 phút)",
	},
	"github.cache.hardTtlSec": {
		label: "TTL cứng bộ nhớ đệm GitHub",
		description:
			"Sau TTL mềm, dòng lưu trong cache sẽ được trả về và làm mới trong nền; sau TTL cứng sẽ bị hủy bỏ (giây; mặc định 7 ngày)",
	},
	"web_search.enabled": {
		label: "Tìm kiếm Web",
		description: "Bật công cụ web_search để lấy kết quả web trực tiếp",
	},
	"security.enabled": {
		label: "Bảo mật",
		description: "Bật lập kế hoạch, thực thi quét bảo mật gốc của omp và không gian tài nguyên security:// chỉ đọc",
	},
	"ask.enabled": {
		label: "Hỏi người dùng (Ask)",
		description: "Bật công cụ ask để đặt câu hỏi tương tác với người dùng",
	},
	"browser.enabled": {
		label: "Trình duyệt",
		description: "Bật tiền đề eval trình duyệt để tự động hóa Chromium bằng kịch bản (Puppeteer)",
	},
	"browser.cdpUrl": {
		label: "URL CDP của trình duyệt",
		description:
			"Điểm cuối khám phá CDP HTTP mặc định (ví dụ http://127.0.0.1:9222) để gắn vào thay vì khởi chạy trình duyệt mới. app.cdp_url hoặc app.path rõ ràng trên lệnh gọi công cụ được ưu tiên.",
	},
	"browser.headless": {
		label: "Trình duyệt không giao diện (Headless)",
		description: "Khởi chạy trình duyệt ở chế độ không đầu (tắt để hiển thị giao diện người dùng trình duyệt)",
	},
	"browser.cmux": {
		label: "Trình duyệt cmux",
		description:
			"Sử dụng bề mặt cmux WKWebView cho tự động hóa trình duyệt khi có socket cmux. Đặt PI_BROWSER_CMUX=0 hoặc PI_BROWSER_CMUX=1 để ghi đè.",
	},
	"browser.screenshotDir": {
		label: "Thư mục ảnh chụp màn hình",
		description:
			"Thư mục để lưu ảnh chụp màn hình. Nếu chưa đặt, ảnh chụp sẽ được lưu vào tệp tạm thời. Hỗ trợ ~. Ví dụ: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
	},
	"tools.intentTracing": {
		label: "Theo dõi ý định",
		description: "Yêu cầu agent mô tả ý định của từng lệnh gọi công cụ trước khi thực thi",
	},
	"tools.abortOnFabricatedResult": {
		label: "Hủy bỏ khi kết quả công cụ bị bịa đặt",
		description:
			"Với các lệnh gọi công cụ nội băng, dừng mô hình ngay lập tức khi nó bắt đầu ảo giác bịa đặt kết quả công cụ giữa lượt. Tắt để cho phép mô hình hoàn thành việc tạo và loại bỏ phần tiếp tục bịa đặt.",
	},
	"tools.maxTimeout": {
		label: "Thời gian chờ công cụ tối đa",
		description:
			"Thời gian chờ tối đa tính bằng giây mà agent có thể đặt cho bất kỳ công cụ nào (0 = không giới hạn)",
	},
	"async.enabled": {
		label: "Thực thi bất đồng bộ",
		description: "Bật các lệnh bash bất đồng bộ và thực thi tác vụ nền",
	},
	"async.pollWaitDuration": {
		label: "Thời gian chờ thăm dò tối đa",
		description:
			"Thời gian `hub` chờ để giám sát các tác vụ nền. Giá trị cố định chờ khoảng thời gian đó mỗi lần. `smart` thích ứng: bắt đầu từ 5 giây, tăng dần khi chờ liên tục (tối đa 5 phút), đặt lại về 5 giây sau khoảng một phút không còn chờ.",
	},
	"irc.timeoutMs": {
		label: "Thời gian chờ IRC",
		description:
			"Thời gian chờ mặc định cho việc chờ tin nhắn hub (cũng như send await:true) tính bằng ms; 0 để tắt thời gian chờ",
	},
	"tools.xdev": {
		label: "Công cụ xd://",
		description:
			"Gắn các công cụ ít dùng (có thể khám phá) dưới các URL thiết bị xd:// được điều khiển qua read/write thay vì gửi schema của chúng trong mọi yêu cầu. Tắt để hiển thị tất cả các công cụ đã bật ở cấp cao nhất.",
	},
	"tools.xdevDocs": {
		label: "Tài liệu prompt xd://",
		description:
			"Chọn tài liệu và schema của thiết bị gắn kết nào được đưa vào nội dòng trong prompt hệ thống. Built-ins giữ các công cụ cốt lõi nội dòng trong khi MCP và các công cụ mở rộng vẫn duy trì theo yêu cầu.",
	},
	"tools.xdevInlineDevices": {
		label: "Thiết bị nội dòng xd://",
		description:
			"Khi tài liệu prompt xd:// là Chỉ tích hợp sẵn, đưa vào nội dòng các thiết bị động có tên khớp với các mẫu glob này (ví dụ mcp__context_mode_*). Chỉ danh mục bỏ qua thiết lập này.",
	},
	"mcp.enableProjectConfig": {
		label: "Cấu hình dự án MCP",
		description: "Tải .mcp.json/mcp.json từ thư mục gốc của dự án",
	},
	"mcp.renderMarkdownResults": {
		label: "Kết quả Markdown MCP",
		description: "Kết xuất kết quả văn bản MCP không phải JSON dưới dạng Markdown trong bản ghi",
	},
	"mcp.notifications": {
		label: "Chèn cập nhật MCP",
		description: "Chèn các bản cập nhật tài nguyên MCP vào cuộc trò chuyện của agent",
	},
	"mcp.notificationDebounceMs": {
		label: "Khử rung thông báo MCP",
		description:
			"Cửa sổ khử rung tính bằng mili giây cho các bản cập nhật tài nguyên MCP trước khi chèn chúng vào cuộc trò chuyện",
	},
	"tasks.todoClearDelay": {
		label: "Độ trễ tự động xóa việc cần làm",
		description:
			"Khoảng thời gian trễ trước khi các việc cần làm đã hoàn thành hoặc bị hủy bỏ bị xóa khỏi tiện ích việc cần làm",
	},
	"dev.autoqa": {
		label: "Tự động báo cáo lỗi (Auto QA)",
		description:
			"Báo cáo sự cố công cụ tự động (xd://report_issue). Mặc định bật; báo cáo đầu tiên sẽ hỏi ý kiến đồng ý, từ chối sẽ tắt báo cáo cho đến khi được bật lại rõ ràng",
	},
	"dev.autoqaPush.endpoint": {
		label: "Điểm cuối đẩy Auto QA",
		description: "URL đầy đủ nhận báo cáo JSON của Auto QA (mặc định https://qa.omp.sh/v1/grievances)",
	},
	// ── tasks ───────────────────────────────────────────────────────────────
	"plan.enabled": {
		label: "Chế độ kế hoạch (Plan Mode)",
		description: "Bật chế độ kế hoạch để khám phá và lập kế hoạch chỉ đọc trước khi thực thi",
	},
	"plan.defaultOnStartup": {
		label: "Khởi động ở chế độ kế hoạch",
		description: "Tự động vào chế độ kế hoạch khi bắt đầu mỗi phiên mới",
	},
	"goal.enabled": {
		label: "Chế độ mục tiêu (Goal Mode)",
		description: "Bật chế độ mục tiêu theo từng phiên và công cụ goal ẩn",
	},
	"goal.statusInFooter": {
		label: "Hiển thị trạng thái mục tiêu ở chân trang",
		description: "Hiển thị ngân sách token bên cạnh chỉ báo mục tiêu trên dòng trạng thái",
	},
	"goal.continuationModes": {
		label: "Chế độ tiếp tục mục tiêu",
		description: "Các chế độ chạy nơi các mục tiêu đang hoạt động có thể tự động tiếp tục giữa các lượt",
	},
	"title.refreshOnReplan": {
		label: "Làm mới tiêu đề khi lập lại kế hoạch",
		description:
			"Làm mới tiêu đề phiên được tạo sau khi khởi tạo việc cần làm lập lại kế hoạch, trừ khi tiêu đề do người dùng đặt",
	},
	"task.isolation.enabled": {
		label: "Cách ly subagent",
		description: "Chạy các subagent trong một bản sao checkout cô lập và tích hợp các thay đổi sau đó",
	},
	"isolation.backend": {
		label: "Backend cách ly",
		description: "Backend được sử dụng cho việc cách ly subagent và nhân bản worktree",
	},
	"worktree.clone": {
		label: "Nhân bản checkout vào Worktree",
		description:
			"Các worktree mới từ `github pr_checkout` và `git worktree add` trong bash bắt đầu dưới dạng bản sao chép-khi-ghi (copy-on-write) của bản checkout hiện tại để các sản phẩm build bị bỏ qua (node_modules, target) được mang theo; chuyển về checkout thông thường khi hệ thống tệp không hỗ trợ nhân bản",
	},
	"worktree.cleanSource": {
		label: "Dọn dẹp checkout nguồn khi tạo /wt",
		description:
			"Khi tạo worktree bằng `/wt`, đặt lại các thay đổi đã theo dõi và xóa các tệp chưa theo dõi khỏi bản checkout gốc sau khi đã chuyển chúng đi",
	},
	"task.isolation.apply": {
		label: "Áp dụng thay đổi cách ly",
		description:
			"Tự động áp dụng các thay đổi tác vụ cách ly thành công vào bản checkout cha; tắt để giữ lại các sản phẩm patch hoặc nhánh",
	},
	"task.isolation.merge": {
		label: "Chiến lược hợp nhất cách ly",
		description: "Cách thức tích hợp các thay đổi tác vụ cách ly (áp dụng patch hoặc hợp nhất nhánh)",
	},
	"task.isolation.commits": {
		label: "Phong cách commit cách ly",
		description: "Phong cách thông điệp commit cho các thay đổi kho lưu trữ lồng nhau (chung hoặc do AI tạo)",
	},
	"worktree.base": {
		label: "Thư mục cơ sở Worktree",
		description:
			"Thư mục cơ sở cho các worktree do agent quản lý — các bản sao cách ly tác vụ, checkout PR `github` và dọn dẹp `omp worktree` đều nằm ở đây. Để trống sẽ dùng ~/.omp/wt. Phải là đường dẫn tuyệt đối hoặc tương đối với ~; đường dẫn tương đối sẽ bị bỏ qua. Biến môi trường OMP_WORKTREE_DIR có thể ghi đè mục này.",
	},
	"task.eager": {
		label: "Ưu tiên ủy quyền tác vụ",
		description: "Mức độ thúc đẩy việc ủy quyền công việc cho các subagent",
	},
	"task.batch": {
		label: "Gọi tác vụ hàng loạt",
		description:
			"Chuyển công cụ task sang dạng hàng loạt: một lệnh gọi mang theo { context, tasks[] } — một subagent cho mỗi mục, kèm theo agent tùy chọn cho từng mục (mặc định là agent chính sách tạo phiên), cách ly theo từng mục và ngữ cảnh dùng chung được thêm vào đầu mỗi nhiệm vụ. Khi async.enabled=true, mỗi lần tạo sẽ chạy như một agent nền độc lập với vòng đời idle/parked bình thường; ngược lại lệnh gọi sẽ chặn để chờ kết quả hợp nhất. Tắt để khôi phục schema tạo đơn lẻ phẳng.",
	},
	"task.enableEffort": {
		label: "Mức độ suy nghĩ theo từng tác vụ",
		description:
			"Hiển thị tham số effort tùy chọn khi tạo tác vụ, cho phép bên gọi ghi đè mức độ suy nghĩ của từng subagent",
	},
	"task.maxConcurrency": {
		label: "Số tác vụ đồng thời tối đa",
		description: "Số lượng subagent tối đa chạy đồng thời",
	},
	"task.enableLsp": {
		label: "LSP trong Subagent",
		description:
			"Cho phép các subagent được tạo qua công cụ task sử dụng công cụ lsp. Mặc định tắt để giữ chi phí subagent thấp; bật khi việc ủy quyền nhận biết LSP xứng đáng với lượng token tăng thêm.",
	},
	"task.maxRecursionDepth": {
		label: "Độ sâu đệ quy tác vụ tối đa",
		description: "Độ sâu các cấp mà subagent có thể tạo ra các subagent của riêng mình",
	},
	"task.maxRuntimeMs": {
		label: "Thời gian chạy tối đa của Subagent",
		description:
			"Giới hạn thời gian thực tế tối đa cho mỗi subagent (ms). 0 để tắt. Dùng để phòng vệ trước các trường hợp treo luồng phía nhà cung cấp vượt khỏi cơ chế giám sát suy luận; kích hoạt hủy subagent bình thường với lý do 'hết thời gian chờ'.",
	},
	"task.agentIdleTtlMs": {
		label: "TTL nhàn rỗi của Agent",
		description:
			"Thời gian một subagent nhàn rỗi duy trì hoạt động trong bộ nhớ trước khi được lưu tạm vào đĩa (ms). Các agent được lưu tạm sẽ tự động phục hồi khi có tin nhắn hoặc được tiếp tục. 0 giữ các agent nhàn rỗi tồn tại đến khi thoát.",
	},
	"task.softRequestBudget": {
		label: "Ngân sách yêu cầu mềm của Subagent",
		description:
			"Ngân sách yêu cầu mềm cho mỗi subagent (số yêu cầu trợ lý mỗi lần chạy). Vượt quá sẽ chèn thông báo điều hướng kết thúc (xem task.softRequestBudgetNotice); ở mức 1.5 lần ngân sách sẽ buộc dừng và agent phải giao nộp các kết quả một phần. 0 để tắt bảo vệ. Các agent scout/sonic đi kèm có ngân sách tích hợp thấp hơn, nên giá trị dưới mức đó vẫn áp dụng cho chúng.",
	},
	"task.softRequestBudgetNotice": {
		label: "Thông báo ngân sách yêu cầu mềm",
		description:
			"Chèn một thông báo điều hướng khi subagent vượt quá ngân sách yêu cầu mềm, yêu cầu nó kết thúc trước khi bị buộc dừng ở mức 1.5 lần.",
	},
	"task.maxEffort": {
		label: "Mức độ nỗ lực tối đa mỗi lần tạo",
		description:
			"Mức độ nỗ lực suy luận tối đa được phép cho gợi ý effort mỗi lần tạo của công cụ task. Giá trị thấp hơn ngăn bên gọi nâng subagent vượt mức trần này; mặc định giữ nguyên toàn bộ phạm vi của mô hình.",
	},
	"task.prewalk": {
		label: "Prewalk cho tác vụ chung",
		description:
			"Kích hoạt prewalk cho subagent `task` chung đi kèm: nó bắt đầu trên mô hình đã giải quyết, lập kế hoạch và bắt đầu triển khai, sau đó chuyển giao cho vai trò 'smol' ở lần chỉnh sửa/ghi đầu tiên. Các ghi đè theo từng agent (task.agentPrewalk) và frontmatter `prewalk` của agent người dùng vẫn áp dụng bất kể cài đặt này.",
	},
	"skills.enableSkillCommands": {
		label: "Lệnh kỹ năng",
		description: "Đăng ký các kỹ năng dưới dạng lệnh /skill:name",
	},
	"commands.enableClaudeUser": {
		label: "Lệnh người dùng Claude",
		description: "Tải các lệnh từ ~/.claude/commands/",
	},
	"commands.enableClaudeProject": { label: "Lệnh dự án Claude", description: "Tải các lệnh từ .claude/commands/" },
	"commands.enableOpencodeUser": {
		label: "Lệnh người dùng OpenCode",
		description: "Tải các lệnh từ ~/.config/opencode/commands/",
	},
	"commands.enableOpencodeProject": {
		label: "Lệnh dự án OpenCode",
		description: "Tải các lệnh từ .opencode/commands/",
	},
	// ── providers ───────────────────────────────────────────────────────────
	"providers.maxInFlightRequests": {
		label: "Số yêu cầu đang xử lý tối đa",
		description:
			'Số lượng yêu cầu LLM đồng thời tối đa cho mỗi ID nhà cung cấp (ví dụ "openai" hoặc "anthropic"), được dùng chung giữa các tiến trình OMP cục bộ có thư mục gốc cấu hình này. Các nhà cung cấp không liệt kê sẽ không giới hạn.',
	},
	"secrets.enabled": {
		label: "Ẩn thông tin bí mật",
		description: "Làm mờ các bí mật đã cấu hình và khử thông tin nhận dạng token trước khi gửi tới nhà cung cấp AI",
	},
	"providers.ollama-cloud.maxConcurrency": {
		label: "Độ đồng thời tối đa Ollama Cloud",
		description:
			"Giới hạn số lần chạy subagent đồng thời của Ollama Cloud trên mỗi tiến trình; 0 để tắt giới hạn riêng của nhà cung cấp này",
	},
	"providers.webSearchOrder": {
		label: "Thứ tự nhà cung cấp tìm kiếm Web",
		description:
			"Thứ tự ưu tiên các nhà cung cấp cho công cụ web_search; các nhà cung cấp không liệt kê sẽ theo thứ tự mặc định phía sau",
	},
	"providers.webSearchExclude": {
		label: "Loại trừ nhà cung cấp tìm kiếm Web",
		description: "Các nhà cung cấp mà web_search không bao giờ sử dụng, ngay cả khi làm phương án dự phòng",
	},
	"providers.webSearchGeminiModel": {
		label: "Mô hình web_search Gemini",
		description:
			"ID mô hình được sử dụng cho tính năng tìm kiếm Google Grounding của Gemini. Mặc định là gemini-2.5-flash.",
	},
	"providers.antigravityEndpoint": {
		label: "Chế độ điểm cuối Antigravity",
		description:
			"Chiến lược định tuyến điểm cuối cho các nhà cung cấp google-antigravity (chat, search, image, discovery)",
	},
	"providers.imageOrder": {
		label: "Thứ tự nhà cung cấp tạo ảnh",
		description:
			"Thứ tự ưu tiên các nhà cung cấp tạo ảnh; các nhà cung cấp không liệt kê sẽ theo nhà cung cấp của phiên hiện tại và thứ tự tích hợp sẵn",
	},
	"providers.fireworksTier": {
		label: "Gói Fireworks",
		description:
			'Đường dẫn phục vụ cho các yêu cầu Fireworks. Priority gửi `service_tier: "priority"` để có độ tin cậy cao hơn trong giờ cao điểm với mức giá cao hơn; Standard bỏ qua trường này. Các mô hình Fast (`-fast`) bỏ qua tùy chọn này vì Fast là một đường dẫn phục vụ riêng.',
	},
	"live.voice": {
		label: "Giọng nói thời gian thực",
		description: "Giọng nói được sử dụng bởi các phiên thoại thời gian thực do Codex hỗ trợ",
	},
	"providers.tts": {
		label: "Nhà cung cấp chuyển văn bản thành giọng nói (TTS)",
		description: "Backend của công cụ tts: TTS mạng nơ-ron cục bộ trên thiết bị (Kokoro-82M) hoặc xAI Grok Voice",
	},
	"tts.localModel": {
		label: "Mô hình TTS cục bộ",
		description: "Mô hình TTS mạng nơ-ron trên thiết bị (Kokoro-82M) được sử dụng bởi backend TTS cục bộ",
	},
	"tts.localVoice": {
		label: "Giọng TTS cục bộ",
		description: "Giọng Kokoro được sử dụng bởi backend TTS cục bộ (Anh-Mỹ/Anh-Anh, giọng nữ/nam)",
	},
	"speech.enabled": {
		label: "Phát âm giọng nói",
		description: "Đọc to câu trả lời của trợ lý qua loa khi nội dung đang được truyền phát đến",
	},
	"speech.mode": {
		label: "Chế độ phát âm giọng nói",
		description:
			"Nội dung cần đọc: all = tin nhắn trợ lý + suy nghĩ; assistant = chỉ tin nhắn; yield = chỉ tin nhắn cuối cùng khi kết thúc lượt",
	},
	"speech.enhanced": {
		label: "Viết lại lời nói nâng cao",
		description:
			"Viết lại đầu ra của trợ lý thành văn bản nói tự nhiên bằng mô hình nhỏ/smol trước khi tổng hợp (mô tả mã, bỏ liên kết và markdown). Quay lại dọn dẹp cơ học nếu thất bại",
	},
	"speech.voice": {
		label: "Giọng phát âm lời nói",
		description: "Giọng Kokoro được sử dụng khi đọc to câu trả lời của trợ lý",
	},
	"providers.tinyModel": {
		label: "Mô hình thu nhỏ (Tiny Model)",
		description:
			"Mô hình tạo tiêu đề phiên: mặc định trực tuyến (vai trò TINY trong /models, nếu không thì là @smol), hoặc mô hình cục bộ trên thiết bị",
	},
	"providers.tinyModelDevice": {
		label: "Thiết bị mô hình thu nhỏ",
		description:
			"Backend suy luận cho mô hình thu nhỏ cục bộ (tiêu đề + bộ nhớ): nhà cung cấp thực thi ONNX, hoặc `mlx` để tải trọng số MLX và chạy qua mlx-lm trên chip Apple. Mặc định chỉ dùng CPU ONNX. Biến môi trường PI_TINY_DEVICE có thể ghi đè.",
	},
	"providers.tinyModelDtype": {
		label: "Độ chính xác mô hình thu nhỏ",
		description:
			"Định lượng/độ chính xác ONNX cho mô hình thu nhỏ cục bộ. Mặc định sử dụng dtype đi kèm của từng mô hình (q4); độ chính xác thấp hơn sẽ nhanh hơn, cao hơn sẽ chuẩn xác hơn. Biến môi trường PI_TINY_DTYPE có thể ghi đè.",
	},
	"providers.unexpectedStopModel": {
		label: "Mô hình phát hiện dừng đột ngột",
		description:
			"Bộ phân loại phát hiện dừng đột ngột: mặc định trực tuyến (vai trò TINY trong /models, nếu không thì là smol), hoặc mô hình cục bộ trên thiết bị.",
	},
	"providers.kimiApiFormat": {
		label: "Định dạng API Kimi",
		description: "Định dạng API cho nhà cung cấp Kimi Code (auto sẽ theo siêu dữ liệu mô hình trực tiếp)",
	},
	"providers.openaiWebsockets": {
		label: "OpenAI WebSockets",
		description:
			"Chính sách websocket cho các mô hình OpenAI Codex (auto sử dụng mặc định của mô hình, on bắt buộc bật, off tắt)",
	},
	"providers.streamFirstEventTimeoutSeconds": {
		label: "Thời gian chờ sự kiện luồng đầu tiên",
		description:
			"Số giây chờ sự kiện đầu tiên từ luồng mô hình; -1 sử dụng mặc định của nhà cung cấp/biến môi trường, 0 tắt cơ chế giám sát watchdog",
	},
	"providers.streamIdleTimeoutSeconds": {
		label: "Thời gian chờ luồng nhàn rỗi",
		description:
			"Số giây luồng mô hình được phép giữ im lặng giữa các sự kiện; -1 sử dụng mặc định của nhà cung cấp/biến môi trường, 0 tắt cơ chế giám sát watchdog",
	},
	"providers.openrouterVariant": {
		label: "Định tuyến OpenRouter",
		description:
			"Hậu tố biến thể định tuyến mặc định được gắn vào ID mô hình OpenRouter (bị ghi đè khi bộ chọn đã chỉ định biến thể)",
	},
	"providers.fetch": {
		label: "Nhà cung cấp tìm nạp (Fetch)",
		description: "Mức độ ưu tiên của backend trình đọc cho công cụ tìm nạp/đọc URL",
	},
	"codexResets.autoRedeem": {
		label: "Tự động đổi lượt đặt lại Codex đã lưu",
		description:
			"Tự động sử dụng các lượt đặt lại hạn mức tốc độ Codex đã lưu: khôi phục tài khoản bị khóa do hết cửa sổ 5 giờ hoặc hàng tuần khi một lượt bị kẹt và không có tài khoản nào khác có thể tiếp quản, và cứu các hạn mức sắp hết hạn. unset sẽ hỏi trước lần chi tiêu đầu tiên, yes chi tiêu không cần nhắc nhở, no tắt cả hai kiểm tra.",
	},
	"codexResets.minBlockedMinutes": {
		label: "Thời gian khóa tối thiểu để tự động đổi Codex",
		description:
			"Chỉ tự động đổi khi thời điểm mở khóa tự nhiên — lượt đặt lại muộn nhất trong các cửa sổ 5 giờ/hàng tuần đã cạn kiệt — cách xa ít nhất số phút này (không lãng phí hạn mức quý giá để tiết kiệm thời gian chờ ngắn). Tăng lên (ví dụ 360) để bỏ qua các khóa chỉ trong 5 giờ.",
	},
	"codexResets.keepCredits": {
		label: "Dự trữ đổi Codex tự động",
		description:
			"Không bao giờ tự động chi tiêu xuống dưới số lượng lượt đặt lại đã lưu này (0 = có thể tự động chi tiêu cả hạn mức cuối cùng). Các hạn mức sắp hết hạn được miễn trừ — giữ lại một hạn mức mà để nó hết hạn thì không bảo toàn được gì.",
	},
	"codexResets.salvageHorizonHours": {
		label: "Khung thời gian cứu lượt đặt lại Codex",
		description:
			"Tự động sử dụng lượt đặt lại Codex đã lưu khi nó sẽ hết hạn trong số giờ này và một trong các cửa sổ trò chuyện (5 giờ hoặc hàng tuần) có lượng sử dụng đáng kể cần khôi phục (0 tắt tính năng cứu hạn mức hết hạn).",
	},
	"provider.appendOnlyContext": {
		label: "Ngữ cảnh chỉ nối thêm (Append-Only)",
		description:
			"Lưu bộ nhớ đệm prompt hệ thống + đặc tả công cụ và duy trì nhật ký tin nhắn chỉ nối thêm để bộ nhớ đệm tiền tố của nhà cung cấp (DeepSeek, Xiaomi/SGLang, Anthropic) đạt tỷ lệ trúng tối đa. Auto bật cho các nhà cung cấp có hỗ trợ bộ nhớ đệm tiền tố đã biết.",
	},
	"exa.enabled": { label: "Exa", description: "Bật nhà cung cấp tìm kiếm web Exa" },
	"exa.enableSearch": {
		label: "Tìm kiếm Exa",
		description: "Bật các công cụ tìm kiếm cơ bản, tìm kiếm sâu, tìm kiếm mã nguồn và thu thập dữ liệu của Exa",
	},
	"exa.searchDelayMs": {
		label: "Độ trễ tìm kiếm Exa",
		description:
			"Độ trễ tối thiểu giữa các yêu cầu tìm kiếm web Exa tính bằng mili giây; đặt 0 để tắt điều tiết nhịp độ",
	},
	"exa.enableResearcher": {
		label: "Nghiên cứu Exa (Researcher)",
		description: "Bật công cụ researcher của Exa để tiến hành nghiên cứu chuyên sâu do AI hỗ trợ",
	},
	"exa.enableWebsets": {
		label: "Exa Websets",
		description: "Bật các công cụ quản lý và làm giàu tập webset của Exa",
	},
	"searxng.endpoint": {
		label: "Điểm cuối SearXNG",
		description: "URL cơ sở của phiên bản SearXNG tự lưu trữ được sử dụng để tìm kiếm web",
	},
	// ── advanced（无 ui 元数据，归入 Advanced 选项卡）─────────────────────────
	setupVersion: {
		label: "Phiên bản trình hướng dẫn thiết lập",
		description:
			"Ghi lại phiên bản trình hướng dẫn thiết lập đã chạy gần đây nhất, dùng để chỉ hiển thị các bước làm quen mới theo từng phiên bản",
	},
	"auth.broker.url": {
		label: "URL xác thực ủy quyền (Auth Broker)",
		description:
			"Địa chỉ máy chủ `omp auth-broker serve` từ xa nơi thông tin xác thực được ủy quyền qua; thường được đặt bởi biến môi trường OMP_AUTH_BROKER_URL",
	},
	"auth.broker.token": {
		label: "Token xác thực ủy quyền",
		description:
			"Token để truy cập máy chủ ủy quyền xác thực; thường được đặt bởi biến môi trường OMP_AUTH_BROKER_TOKEN",
	},
	shellPath: {
		label: "Đường dẫn Shell",
		description: "Đường dẫn tệp thực thi shell tùy chỉnh, ghi đè kết quả tự động phát hiện",
	},
	extensions: {
		label: "Đường dẫn tiện ích mở rộng",
		description: "Danh sách các đường dẫn tiện ích mở rộng được tải thêm khi khởi động",
	},
	enabledModels: {
		label: "Danh sách mô hình được phép",
		description:
			"Danh sách mẫu bộ chọn giới hạn các mô hình khả dụng; để trống nghĩa là không giới hạn (hỗ trợ cấu hình theo phạm vi đường dẫn)",
	},
	enabledProviders: {
		label: "Nhà cung cấp khả năng được bật",
		description:
			"Danh sách ID nhà cung cấp khám phá khả năng được bật bổ sung (hỗ trợ cấu hình theo phạm vi đường dẫn)",
	},
	disabledProviders: {
		label: "Nhà cung cấp bị vô hiệu hóa",
		description:
			"Danh sách ID nhà cung cấp bị vô hiệu hóa — dùng chung cho nguồn khám phá khả năng và bộ chọn mô hình",
	},
	disabledExtensions: {
		label: "Tiện ích mở rộng bị vô hiệu hóa",
		description: "Danh sách tiện ích mở rộng bị vô hiệu hóa theo ID (quản lý trong bảng Tiện ích mở rộng)",
	},
	modelRoles: {
		label: "Phân bổ vai trò mô hình",
		description: "Ánh xạ vai trò (default, smol, slow, advisor, v.v.) tới các bộ chọn mô hình",
	},
	modelTags: {
		label: "Thẻ mô hình",
		description: "Cấu hình tên, màu sắc và mức hiển thị của các thẻ mô hình tùy chỉnh",
	},
	modelProviderOrder: {
		label: "Thứ tự nhà cung cấp",
		description: "Thứ tự hiển thị các nhà cung cấp trong bộ chọn mô hình",
	},
	cycleOrder: {
		label: "Vòng chuyển đổi nhanh",
		description: "Thứ tự vai trò trong vòng lặp chuyển đổi mô hình nhanh (mặc định smol → default → slow)",
	},
	"statusLine.leftSegments": {
		label: "Phân đoạn bên trái dòng trạng thái",
		description: "Danh sách ID các phân đoạn hiển thị theo thứ tự ở bên trái dòng trạng thái",
	},
	"statusLine.rightSegments": {
		label: "Phân đoạn bên phải dòng trạng thái",
		description: "Danh sách ID các phân đoạn hiển thị theo thứ tự ở bên phải dòng trạng thái",
	},
	"statusLine.segmentOptions": {
		label: "Tùy chọn phân đoạn dòng trạng thái",
		description: "Ghi đè tùy chọn hiển thị từng phân đoạn theo ID phân đoạn (khóa là ID phân đoạn)",
	},
	"tui.maxInlineImageColumns": {
		label: "Giới hạn cột ảnh nội dòng",
		description:
			"Chiều rộng tối đa của ảnh nội dòng (số cột terminal, mặc định 100). Đặt 0 nghĩa là không giới hạn (chỉ bị giới hạn bởi độ rộng terminal).",
	},
	"tui.maxInlineImageRows": {
		label: "Giới hạn hàng ảnh nội dòng",
		description:
			"Chiều cao tối đa của ảnh nội dòng (số hàng terminal, mặc định 20). Đặt 0 nghĩa là chỉ dùng giới hạn dựa trên khung nhìn (60% chiều cao terminal).",
	},
	"tui.maxInlineImages": {
		label: "Giới hạn số lượng ảnh nội dòng",
		description:
			"Số lượng ảnh nội dòng tối đa được giữ lại dưới dạng đồ họa terminal trực tiếp (mặc định 8). Vượt quá giới hạn, các ảnh cũ hơn sẽ được thay thế bằng văn bản giữ chỗ khi vẽ lại đầy đủ. Đặt 0 nghĩa là giữ tất cả ảnh (không giới hạn).",
	},
	"retry.enabled": {
		label: "Bật thử lại",
		description: "Công tắc chung để tự động thử lại khi yêu cầu API thất bại",
	},
	"retry.baseDelayMs": {
		label: "Độ trễ thử lại cơ sở",
		description: "Thời gian chờ cơ sở cho hàm mũ thoái lui giữa các lần thử lại (ms, mặc định 500)",
	},
	"stt.language": {
		label: "Ngôn ngữ nhận dạng giọng nói",
		description: "Mã ngôn ngữ nhận dạng cho tính năng chuyển giọng nói thành văn bản (mặc định en)",
	},
	"compaction.reserveTokens": {
		label: "Token dự trữ nén",
		description:
			"Số token dự trữ cho phản hồi của mô hình sau khi nén. Để trống là chưa chọn rõ ràng — khi phục hồi cửa sổ nhỏ có thể dùng dự trữ tính theo tỷ lệ.",
	},
	"compaction.keepRecentTokens": {
		label: "Token gần đây giữ lại khi nén",
		description: "Số token tin nhắn gần đây được giữ nguyên khi nén (mặc định 20000)",
	},
	"compaction.autoContinue": {
		label: "Tự động tiếp tục sau khi nén",
		description: "Tự động tiếp tục lượt hiện tại sau khi quá trình tự động nén hoàn tất",
	},
	"compaction.remoteEndpoint": {
		label: "Điểm cuối nén từ xa",
		description: "URL điểm cuối của dịch vụ nén từ xa; để trống sẽ sử dụng điểm cuối mặc định",
	},
	"compaction.v2RetainedMessageBudget": {
		label: "Ngân sách giữ lại nén từ xa V2",
		description: "Ngân sách token tin nhắn được giữ nguyên trong nén từ xa V2 (mặc định 64000)",
	},
	"branchSummary.reserveTokens": {
		label: "Token dự trữ tóm tắt nhánh",
		description: "Số token ngữ cảnh được dự trữ để tạo tóm tắt nhánh (mặc định 16384)",
	},
	"memories.enabled": {
		label: "Bộ nhớ cục bộ (công tắc cũ)",
		description:
			"Công tắc bộ nhớ cục bộ cũ, chỉ giữ lại để tương thích ngược — vui lòng chuyển sang dùng memory.backend",
	},
	"memories.maxRolloutsPerStartup": {
		label: "Giới hạn trích xuất mỗi lần khởi động",
		description: "Số đợt trích xuất bộ nhớ (rollout) tối đa chạy trong một lần khởi động (mặc định 64)",
	},
	"memories.maxRolloutAgeDays": {
		label: "Độ tuổi phiên trích xuất tối đa",
		description: "Độ tuổi tối đa của phiên được đưa vào trích xuất bộ nhớ (ngày, mặc định 30)",
	},
	"memories.minRolloutIdleHours": {
		label: "Thời gian nhàn rỗi phiên trích xuất",
		description:
			"Phiên phải ở trạng thái nhàn rỗi ít nhất số giờ này mới được đưa vào trích xuất bộ nhớ (mặc định 12)",
	},
	"memories.threadScanLimit": {
		label: "Giới hạn quét luồng",
		description:
			"Số lượng luồng phiên tối đa được quét để tìm ứng viên trích xuất bộ nhớ khi khởi động (mặc định 300)",
	},
	"memories.maxRawMemoriesForGlobal": {
		label: "Giới hạn bộ nhớ thô cho tổng hợp toàn cục",
		description: "Số lượng bộ nhớ thô tối đa cho phép trước khi kích hoạt tổng hợp toàn cục (mặc định 200)",
	},
	"memories.stage1Concurrency": {
		label: "Độ đồng thời giai đoạn 1",
		description: "Số tác vụ đồng thời trong giai đoạn 1 (trích xuất theo từng luồng) (mặc định 8)",
	},
	"memories.stage1LeaseSeconds": {
		label: "Thời hạn thuê giai đoạn 1",
		description: "Thời hạn thuê (lease) của tác vụ trích xuất giai đoạn 1 (giây, mặc định 120)",
	},
	"memories.stage1RetryDelaySeconds": {
		label: "Độ trễ thử lại giai đoạn 1",
		description: "Thời gian chờ thử lại cho tác vụ giai đoạn 1 bị thất bại (giây, mặc định 120)",
	},
	"memories.phase2LeaseSeconds": {
		label: "Thời hạn thuê giai đoạn 2",
		description: "Thời hạn thuê của tác vụ giai đoạn 2 (tổng hợp toàn cục) (giây, mặc định 180)",
	},
	"memories.phase2RetryDelaySeconds": {
		label: "Độ trễ thử lại giai đoạn 2",
		description: "Thời gian chờ thử lại sau khi giai đoạn 2 thất bại (giây, mặc định 180)",
	},
	"memories.phase2HeartbeatSeconds": {
		label: "Khoảng cách nhịp tim giai đoạn 2",
		description: "Khoảng thời gian gửi nhịp tim khi giai đoạn 2 đang chạy (giây, mặc định 30)",
	},
	"memories.rolloutPayloadPercent": {
		label: "Tỷ lệ tải trích xuất trong ngữ cảnh",
		description:
			"Tỷ lệ đầu vào của một đợt trích xuất được phép chiếm trong cửa sổ ngữ cảnh của mô hình (mặc định 0.7)",
	},
	"memories.phase1InputTokenLimit": {
		label: "Giới hạn token đầu vào giai đoạn 1",
		description: "Giới hạn token đầu vào cho mỗi luồng trong giai đoạn 1 (mặc định 4000)",
	},
	"memories.fallbackTokenLimit": {
		label: "Giới hạn token dự phòng",
		description: "Giới hạn token dự phòng được sử dụng khi chưa biết cửa sổ ngữ cảnh của mô hình (mặc định 16000)",
	},
	"memories.summaryInjectionTokenLimit": {
		label: "Giới hạn chèn tóm tắt bộ nhớ",
		description: "Giới hạn token tóm tắt bộ nhớ được chèn vào phiên (mặc định 5000)",
	},
	"autolearn.minToolCalls": {
		label: "Số lượng gọi công cụ tối thiểu để tự động học",
		description:
			"Số lượng lệnh gọi công cụ trong phiên cần đạt được trước khi kích hoạt đúc kết bài học tự động (mặc định 5)",
	},
	"mnemopi.retainEveryNTurns": {
		label: "Khoảng thời gian lưu giữ Mnemopi",
		description: "Số lượt giữa các lần lưu giữ bản ghi (mặc định 4)",
	},
	"mnemopi.recallLimit": {
		label: "Giới hạn số mục gọi lại Mnemopi",
		description: "Số lượng mục ký ức tối đa trả về trong mỗi lần gọi lại (mặc định 8)",
	},
	"mnemopi.recallContextTurns": {
		label: "Số lượt ngữ cảnh gọi lại Mnemopi",
		description: "Số lượt hội thoại gần đây được đưa vào khi xây dựng truy vấn gọi lại (mặc định 3)",
	},
	"mnemopi.recallMaxQueryChars": {
		label: "Độ dài truy vấn gọi lại Mnemopi tối đa",
		description: "Số ký tự tối đa của một truy vấn gọi lại (mặc định 4000)",
	},
	"mnemopi.injectionTokenLimit": {
		label: "Giới hạn token chèn Mnemopi",
		description: "Giới hạn token ký ức gọi lại được chèn vào prompt (mặc định 5000)",
	},
	"mnemopi.debug": {
		label: "Nhật ký gỡ lỗi Mnemopi",
		description: "Xuất nhật ký gỡ lỗi cho backend bộ nhớ Mnemopi",
	},
	"hindsight.bankIdPrefix": {
		label: "Tiền tố ID ngân hàng Hindsight",
		description: "Thêm tiền tố này vào ID ngân hàng bộ nhớ được tạo tự động",
	},
	"hindsight.bankMission": {
		label: "Sứ mệnh phản tư Hindsight",
		description:
			"Sứ mệnh phản tư (reflect mission) được ghi vào khi tạo ngân hàng bộ nhớ, định hướng cho các phản tư của ngân hàng đó",
	},
	"hindsight.retainMission": {
		label: "Sứ mệnh lưu giữ Hindsight",
		description:
			"Sứ mệnh lưu giữ (retain mission) được ghi vào khi tạo ngân hàng bộ nhớ, định hướng những ký ức nào cần trích xuất từ bản ghi",
	},
	"hindsight.retainEveryNTurns": {
		label: "Khoảng thời gian lưu giữ Hindsight",
		description: "Số lượt giữa các lần lưu giữ bản ghi (mặc định 3)",
	},
	"hindsight.retainOverlapTurns": {
		label: "Số lượt gối đầu lưu giữ Hindsight",
		description:
			"Số lượt gối đầu giữa các khối lưu giữ liền kề để tránh mất ngữ cảnh ở các điểm ranh giới (mặc định 2)",
	},
	"hindsight.retainContext": {
		label: "Thẻ ngữ cảnh lưu giữ Hindsight",
		description: "Thẻ ngữ cảnh đính kèm với tài liệu lưu giữ (mặc định omp)",
	},
	"hindsight.recallBudget": {
		label: "Ngân sách gọi lại Hindsight",
		description: "Cấp độ sâu khi gọi lại: low, mid hoặc high (mặc định mid)",
	},
	"hindsight.recallMaxTokens": {
		label: "Giới hạn token gọi lại Hindsight",
		description: "Số token tối đa của ký ức được gọi lại chèn vào (mặc định 1024)",
	},
	"hindsight.recallContextTurns": {
		label: "Số lượt ngữ cảnh gọi lại Hindsight",
		description: "Số lượt hội thoại gần đây được đưa vào khi xây dựng truy vấn gọi lại (mặc định 1)",
	},
	"hindsight.recallMaxQueryChars": {
		label: "Độ dài truy vấn gọi lại Hindsight tối đa",
		description: "Số ký tự tối đa của một truy vấn gọi lại (mặc định 800)",
	},
	"hindsight.recallTypes": {
		label: "Loại ký ức gọi lại Hindsight",
		description: "Các loại ký ức tham gia vào việc gọi lại (mặc định world và experience)",
	},
	"hindsight.debug": {
		label: "Nhật ký gỡ lỗi Hindsight",
		description: "Xuất nhật ký gỡ lỗi cho backend bộ nhớ Hindsight",
	},
	"hindsight.requestTimeoutMs": {
		label: "Thời gian chờ yêu cầu Hindsight",
		description: "Thời gian chờ cho các yêu cầu Hindsight thông thường (ms, mặc định 30000)",
	},
	"hindsight.reflectTimeoutMs": {
		label: "Thời gian chờ phản tư Hindsight",
		description: "Thời gian chờ cho các yêu cầu phản tư Hindsight (ms, mặc định 120000)",
	},
	"hindsight.recallTimeoutMs": {
		label: "Thời gian chờ gọi lại Hindsight",
		description: "Thời gian chờ cho các yêu cầu gọi lại Hindsight (ms, mặc định 30000)",
	},
	"hindsight.retainTimeoutMs": {
		label: "Thời gian chờ lưu giữ Hindsight",
		description: "Thời gian chờ cho các yêu cầu lưu giữ Hindsight (ms, mặc định 60000)",
	},
	"hindsight.mentalModelRefreshIntervalMs": {
		label: "Khoảng thời gian làm mới mô hình nhận thức Hindsight",
		description: "Khoảng thời gian đọc lại mô hình nhận thức (ms, mặc định 5 phút)",
	},
	"hindsight.mentalModelMaxRenderChars": {
		label: "Giới hạn kết xuất mô hình nhận thức Hindsight",
		description: "Số ký tự tối đa khi kết xuất mô hình nhận thức vào chỉ dẫn (mặc định 16000)",
	},
	"bashInterceptor.patterns": {
		label: "Quy tắc chặn Bash",
		description:
			"Các quy tắc chặn bash có thứ tự: khi khớp mẫu regex sẽ nhắc nhở chuyển sang công cụ chuyên dụng tương ứng",
	},
	"shellMinimizer.settingsPath": {
		label: "Tệp cài đặt thu gọn Shell",
		description: "Đường dẫn tùy chọn tới tệp cài đặt TOML ghi đè giá trị mặc định của bộ thu gọn (hỗ trợ ~)",
	},
	"shellMinimizer.only": {
		label: "Danh sách cho phép thu gọn Shell",
		description:
			"Chỉ bật tính năng nén đầu ra cho các tên chương trình này (như git); để trống nghĩa là bật tất cả bộ lọc tích hợp",
	},
	"shellMinimizer.except": {
		label: "Danh sách loại trừ thu gọn Shell",
		description: "Các tên chương trình không thực hiện nén đầu ra",
	},
	"shellMinimizer.maxCaptureBytes": {
		label: "Giới hạn chụp thu gọn Shell",
		description: "Số byte chụp tối đa cho mỗi lệnh, vượt quá sẽ quay về đầu ra gốc chưa nén (mặc định 4 MiB)",
	},
	"shellMinimizer.legacyFilters": {
		label: "Bộ lọc Shell phiên bản cũ",
		description:
			"Quay về hành vi lọc kiểu cũ cho grep/find/pytest; để trống sẽ theo biến môi trường OMP_MINIMIZER_LEGACY_FILTERS",
	},
	"async.maxJobs": {
		label: "Giới hạn số tác vụ nền",
		description: "Số lượng tác vụ nền chạy đồng thời tối đa (mặc định 100)",
	},
	"bash.autoBackground.thresholdMs": {
		label: "Ngưỡng tự động chuyển nền",
		description: "Thời gian lệnh bash chạy vượt quá số mili giây này sẽ tự động chuyển vào nền (mặc định 60000)",
	},
	"eval.autoBackground.enabled": {
		label: "Tự động chuyển Eval vào nền",
		description: "Tự động chuyển các ô eval chạy lâu vào nền và trả về kết quả sau khi hoàn thành.",
	},
	"eval.autoBackground.thresholdMs": {
		label: "Ngưỡng tự động chuyển nền Eval",
		description: "Thời gian ô eval chạy vượt quá số mili giây này sẽ tự động chuyển vào nền (mặc định 60000).",
	},
	"task.disabledAgents": {
		label: "Subagent bị vô hiệu hóa",
		description:
			"Danh sách tên các subagent bị vô hiệu hóa, công cụ task sẽ không còn cung cấp (quản lý trong bảng /agents)",
	},
	"task.agentModelOverrides": {
		label: "Ghi đè mô hình theo subagent",
		description:
			"Ánh xạ tên subagent tới bộ chọn mô hình, ghi đè mô hình mặc định của từng agent (quản lý trong bảng /agents)",
	},
	"task.agentPrewalk": {
		label: "Ghi đè Prewalk theo subagent",
		description: "Ánh xạ tên subagent tới trạng thái bật/tắt prewalk (nhấn P trong bảng /agents để chuyển đổi)",
	},
	"skills.enabled": {
		label: "Bật kỹ năng",
		description: "Công tắc chung cho việc khám phá và tải kỹ năng",
	},
	"skills.enableCodexUser": { label: "Kỹ năng người dùng Codex", description: "Tải kỹ năng từ ~/.codex/skills" },
	"skills.enableClaudeUser": {
		label: "Kỹ năng người dùng Claude",
		description: "Tải kỹ năng từ ~/.claude/skills",
	},
	"skills.enableClaudeProject": { label: "Kỹ năng dự án Claude", description: "Tải kỹ năng từ .claude/skills" },
	"skills.enablePiUser": { label: "Kỹ năng người dùng Pi", description: "Tải kỹ năng từ ~/.omp/agent/skills" },
	"skills.enablePiProject": { label: "Kỹ năng dự án Pi", description: "Tải kỹ năng từ .omp/skills" },
	"skills.enableAgentsUser": {
		label: "Kỹ năng người dùng Agents",
		description: "Tải kỹ năng từ ~/.agent/skills và ~/.agents/skills",
	},
	"skills.enableAgentsProject": {
		label: "Kỹ năng dự án Agents",
		description: "Tải kỹ năng từ .agent/skills và .agents/skills",
	},
	"skills.customDirectories": {
		label: "Thư mục kỹ năng tùy chỉnh",
		description: "Danh sách các thư mục tùy chỉnh để quét thêm kỹ năng",
	},
	"skills.ignoredSkills": {
		label: "Kỹ năng bị bỏ qua",
		description: "Danh sách các kỹ năng bị bỏ qua theo mẫu glob tên",
	},
	"skills.includeSkills": {
		label: "Chỉ bao gồm các kỹ năng",
		description: "Khi không rỗng, chỉ tải các kỹ năng có tên khớp với các mẫu glob này",
	},
	"searxng.token": {
		label: "Token truy cập SearXNG",
		description: "Token truy cập cho phiên bản SearXNG (xác thực token)",
	},
	"searxng.basicUsername": {
		label: "Tên người dùng Basic SearXNG",
		description: "Tên người dùng xác thực HTTP Basic cho phiên bản SearXNG",
	},
	"searxng.basicPassword": {
		label: "Mật khẩu Basic SearXNG",
		description: "Mật khẩu xác thực HTTP Basic cho phiên bản SearXNG",
	},
	"searxng.categories": {
		label: "Danh mục SearXNG",
		description: "Giới hạn danh mục tìm kiếm (phân cách bằng dấu phẩy, ví dụ general,news)",
	},
	"searxng.engines": {
		label: "Công cụ tìm kiếm SearXNG",
		description: "Giới hạn các công cụ tìm kiếm được sử dụng (phân cách bằng dấu phẩy)",
	},
	"searxng.language": {
		label: "Ngôn ngữ SearXNG",
		description: "Mã ngôn ngữ ưa thích cho kết quả tìm kiếm",
	},
	"commit.mapReduceEnabled": {
		label: "Map-Reduce phân tích commit",
		description:
			"Tạo thông điệp commit cho diff lớn chuyển sang quy trình map-reduce: phân tích song song từng tệp rồi tổng hợp",
	},
	"commit.mapReduceMinFiles": {
		label: "Số tệp tối thiểu cho Map-Reduce",
		description: "Số lượng tệp thay đổi đạt giá trị này mới bật phân tích map-reduce (mặc định 4)",
	},
	"commit.mapReduceMaxFileTokens": {
		label: "Giới hạn token đơn tệp cho Map-Reduce",
		description: "Diff của một tệp vượt quá số token này sẽ bật phân tích map-reduce (mặc định 50000)",
	},
	"commit.mapReduceTimeoutMs": {
		label: "Thời gian chờ Map-Reduce",
		description: "Thời gian chờ cho phân tích map-reduce (ms, mặc định 120000)",
	},
	"commit.mapReduceMaxConcurrency": {
		label: "Độ đồng thời tối đa Map-Reduce",
		description: "Giới hạn đồng thời khi phân tích từng tệp của map-reduce (mặc định 5)",
	},
	"commit.changelogMaxDiffChars": {
		label: "Giới hạn ký tự Diff nhật ký thay đổi",
		description: "Số ký tự diff tối đa cung cấp cho mô hình khi tạo nhật ký thay đổi (mặc định 120000)",
	},
	"dev.autoqaPush.token": {
		label: "Token đẩy Auto QA",
		description: "Token xác thực được sử dụng khi gửi báo cáo Auto QA",
	},
	"dev.autoqaConsent": {
		label: "Trạng thái đồng ý Auto QA",
		description:
			"Đồng ý chia sẻ báo cáo sự cố công cụ tự động: unset = hỏi lần đầu; granted = ghi lại và gửi (khi đã cấu hình); denied = bỏ qua trong im lặng",
	},
	"gc.blobs": {
		label: "GC dọn dẹp Blob",
		description: "Dọn dẹp các blob phiên không còn được tham chiếu khi chạy `omp gc`",
	},
	"gc.archive": {
		label: "GC lưu trữ phiên cũ",
		description: "Chuyển các phiên không hoạt động trong thời gian dài vào lưu trữ khi chạy `omp gc`",
	},
	"gc.wal": {
		label: "GC xử lý WAL",
		description: "Xử lý nhật ký ghi trước (WAL) của bộ lưu trữ phiên khi chạy `omp gc`",
	},
	"gc.coldArchiveAfterDays": {
		label: "Số ngày lưu trữ lạnh",
		description: "Các phiên không hoạt động quá số ngày này mới được chuyển vào lưu trữ (mặc định 30)",
	},
	"gc.retainNewestGlobal": {
		label: "Số phiên mới nhất giữ lại toàn cục",
		description: "Số lượng phiên không hoạt động mới nhất được giữ lại dù cũ đến đâu (toàn cục, mặc định 20)",
	},
	"gc.retainNewestPerCwd": {
		label: "Số phiên mới nhất giữ lại theo thư mục",
		description: "Số lượng phiên không hoạt động mới nhất được giữ lại cho mỗi thư mục làm việc (mặc định 10)",
	},
	"thinkingBudgets.minimal": {
		label: "Ngân sách suy nghĩ (minimal)",
		description: "Ngân sách token suy luận cho mức suy nghĩ minimal (mặc định 1024)",
	},
	"thinkingBudgets.low": {
		label: "Ngân sách suy nghĩ (low)",
		description: "Ngân sách token suy luận cho mức suy nghĩ low (mặc định 2048)",
	},
	"thinkingBudgets.medium": {
		label: "Ngân sách suy nghĩ (medium)",
		description: "Ngân sách token suy luận cho mức suy nghĩ medium (mặc định 8192)",
	},
	"thinkingBudgets.high": {
		label: "Ngân sách suy nghĩ (high)",
		description: "Ngân sách token suy luận cho mức suy nghĩ high (mặc định 16384)",
	},
	"thinkingBudgets.xhigh": {
		label: "Ngân sách suy nghĩ (xhigh)",
		description: "Ngân sách token suy luận cho mức suy nghĩ xhigh (mặc định 32768)",
	},
	"thinkingBudgets.max": {
		label: "Ngân sách suy nghĩ (max)",
		description: "Ngân sách token suy luận cho mức suy nghĩ max (mặc định 32768)",
	},
	"display.hideToolActivity": {
		label: "Ẩn hoạt động công cụ",
		description: "Ẩn các lệnh gọi công cụ do mô hình khởi tạo và kết quả của chúng trong bản ghi",
	},
	externalThinking: {
		label: "Suy nghĩ bên ngoài",
		description: "Sử dụng công cụ think riêng tư và giao phó công việc suy luận cho mô hình GPT Responses",
	},
	"lsp.shared": {
		label: "Máy chủ ngôn ngữ dùng chung",
		description:
			"Cho phép các phiên bản omp trong cùng dự án chia sẻ một máy chủ ngôn ngữ qua daemon broker; quay lại máy chủ riêng nếu không khả dụng",
	},
	"browser.relay": {
		label: "Bộ chuyển tiếp trình duyệt",
		description:
			"Điều khiển các tab Chrome của riêng bạn qua bộ chuyển tiếp trình duyệt omp. Cài đặt tiện ích mở rộng một lần (`omp browser-relay install`); máy chủ chuyển tiếp sẽ tự khởi động khi cần. Nó được ưu tiên hơn URL CDP trình duyệt; đặt PI_BROWSER_RELAY=0 hoặc 1 để ghi đè.",
	},
	"browser.relayUrl": {
		label: "URL bộ chuyển tiếp trình duyệt",
		description: "Điểm cuối bộ chuyển tiếp trình duyệt omp (mặc định http://127.0.0.1:9224)",
	},
	"providers.webSearchTimeoutSeconds": {
		label: "Thời gian chờ tìm kiếm Web",
		description:
			"Thời gian chờ truyền tải tìm kiếm cứng cho mỗi nhà cung cấp trước khi web_search chuyển sang phương án dự phòng tiếp theo, tính bằng giây (tối đa 300)",
	},
	"searxng.safesearch": { label: "Tìm kiếm an toàn SearXNG" },
	// ── omp 18.2.x 上游新增设置 ─────────────────────────────────────────────
	"advisor.maxNotesPerUpdate": {
		label: "Số ghi chú tối đa mỗi lần cập nhật Advisor",
		description:
			"Số lượng ghi chú tư vấn tối đa được chấp nhận cho mỗi lần cập nhật prompt của advisor; giá trị thấp hơn sẽ chặt chẽ hơn và chống tràn màn hình.",
	},
	"browser.freezeOnTurnEnd": {
		label: "Đóng băng tab trình duyệt khi kết thúc lượt",
		description:
			"Đóng băng các tab trình duyệt không đầu do OMP quản lý khi một lượt kết thúc để các trang động ngừng tiêu tốn CPU/GPU khi nhàn rỗi.",
	},
	"browser.idleCloseSec": {
		label: "Thời gian chờ đóng trình duyệt khi nhàn rỗi",
		description: "Đóng các tab trình duyệt do OMP quản lý sau số giây nhàn rỗi này (0 = không bao giờ đóng).",
	},
	"collab.autoStart": {
		label: "Tự động bắt đầu cộng tác",
		description:
			"Tự động lưu trữ mọi phiên tương tác qua collab.relayUrl khi bắt đầu và phát hành lên sổ đăng ký cục bộ; tắt để chỉ chia sẻ khi chạy /collab.",
	},
	"compaction.experimentalContextManagement": {
		label: "Cửa sổ ngữ cảnh hỗ trợ ghi chú (thử nghiệm)",
		description: "Giữ ghi chú liên tục và lịch sử thô có thể tìm kiếm qua các cửa sổ ngữ cảnh.",
	},
	"composer.recallClearedDrafts": {
		label: "Khôi phục bản nháp đã xóa",
		description: "Giữ các bản nháp đã xóa bằng Ctrl+C trong lịch sử ↑/↓ cục bộ cho đến khi thoát.",
	},
	"composer.shape": {
		label: "Khuôn dạng khung nhập liệu",
		description: "Bố cục trực quan của trình chỉnh sửa nhập liệu và dòng trạng thái.",
	},
	"composer.tokenRate": {
		label: "Tốc độ tạo token",
		description:
			"Hiển thị tốc độ đọc tok/s trực tiếp theo thời gian thực trên dòng làm việc, ngay cạnh tiêu đề phiên.",
	},
	"display.pinnedAgents": {
		label: "Danh sách agent đã ghim",
		description:
			"Danh sách nhảy agent trực tiếp đã ghim phía trên trình chỉnh sửa (off ẩn; collapsed thu gọn hiển thị vài dòng kèm nút mở rộng; full liệt kê tất cả).",
	},
	"display.showTurnTime": {
		label: "Hiển thị thời gian lượt",
		description:
			"Hiển thị tổng thời gian từ lúc gửi prompt đến khi trả lời (bao gồm các lệnh gọi công cụ) trên các dòng sử dụng của tin nhắn trợ lý.",
	},
	"find.enabled": {
		label: "Find (tìm kiếm ngữ nghĩa)",
		description:
			"Bật công cụ find: tìm kiếm tệp và phạm vi dòng bằng ngôn ngữ tự nhiên, được đánh giá bởi mô hình vai trò judge.",
	},
	"loop.conditionTimeoutMs": {
		label: "Thời gian chờ điều kiện vòng lặp (ms)",
		description:
			"Thời gian chờ tối đa cho lệnh điều kiện `/loop --while` / `--until` trước khi coi là lỗi và dừng vòng lặp. Đặt 0 để chờ vô hạn.",
	},
	"plan.autosave": {
		label: "Tự động lưu kế hoạch",
		description: "Tự động lưu các kế hoạch đã được phê duyệt vào đĩa khi chế độ kế hoạch hoàn tất.",
	},
	"plan.autosaveDir": {
		label: "Thư mục tự động lưu kế hoạch",
		description:
			"Thư mục lưu các kế hoạch tự động lưu. Hỗ trợ ~, đường dẫn tuyệt đối và tương đối với cwd. Để trống sẽ dùng <project>/.omp/plans/.",
	},
	"spelling.autocomplete": {
		label: "Tự động hoàn thành từ (macOS)",
		description:
			"Hiển thị gợi ý hoàn thành từ dự đoán dưới dạng gợi ý nội dòng: ⇥ chấp nhận kèm dấu cách, → không kèm dấu cách.",
	},
	"spelling.autocorrect": {
		label: "Tự động sửa lỗi chính tả (macOS)",
		description: "Áp dụng các sửa lỗi chính tả macOS tự tin sau các từ đã hoàn thành.",
	},
	"spelling.typoDetection": {
		label: "Phát hiện lỗi chính tả (macOS)",
		description: "Đánh dấu các từ viết sai chính tả trong prompt bằng từ điển macOS đang hoạt động.",
	},
	"statusLine.contextLine": {
		label: "Đường phản hồi ngữ cảnh",
		description:
			"Cách đường kẻ giữa các phần trái và phải phản ánh mức sử dụng ngữ cảnh (chỉ dành cho khung nhập dạng box).",
	},
	"stream.redactPatterns": {
		label: "Mẫu khử nhạy cảm bổ sung",
		description:
			"Các biểu thức chính quy bổ sung được khử nhạy cảm khỏi mọi dòng truyền phát trực tiếp, trên các giá trị env/secrets.yml và các dạng thông tin xác thực tích hợp.",
	},
	"stream.serverUrl": {
		label: "Máy chủ truyền phát trực tiếp",
		description: "Máy chủ truyền phát trực tiếp được sử dụng bởi `omp stream` (https://host[:port]).",
	},
	"task.agentServiceTierOverrides": {
		label: "Ghi đè gói dịch vụ cho tác vụ phụ",
		description: "Ánh xạ khóa-giá trị ghi đè gói dịch vụ theo từng agent/tác vụ.",
	},
	"tools.speculativeExecution.enabled": {
		label: "Thực thi suy đoán thử nghiệm",
		description:
			"Bật thực thi an toàn cho các thao tác đọc cục bộ đã xác thực trước khi gửi đi bình thường nhằm giảm độ trễ.",
	},
	"tools.speculativeExecution.maxInFlight": {
		label: "Độ đồng thời thực thi suy đoán",
		description:
			"Số lượng thao tác đọc cục bộ đã xác thực tối đa được phép chạy song song trước khi gửi đi bình thường.",
	},
	"tui.mouse": {
		label: "Nhấp chuột để lấy nét",
		description:
			"Bắt sự kiện nhấp chuột trong phiên chính để thẻ subagent trực tiếp và các dòng HUD được lấy nét khi nhấp.",
	},
	"tui.resizeScrollback": {
		label: "Đổi kích thước bộ đệm cuộn",
		description:
			"Cách làm mới các dòng bản ghi được giữ lại trong bộ đệm cuộn terminal sau khi kích thước terminal ổn định.",
	},
	"tui.titleSpinner": {
		label: "Biểu tượng xoay tiêu đề terminal",
		description: "Bộ ký tự glyph cho con xoay trạng thái đang làm việc trên tiêu đề terminal.",
	},
	"tui.vimMode": {
		label: "Chế độ chỉnh sửa Vim",
		description: "Bật chế độ chỉnh sửa phím Vim trong khung nhập prompt.",
	},
	"tui.vimModeDisplay": {
		label: "Chỉ báo chế độ Vim",
		description: "Cách hiển thị chế độ Vim hiện tại trên dòng trạng thái.",
	},
};
