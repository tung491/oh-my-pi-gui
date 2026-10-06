import type {
	AgentMessage,
	AvailableCommand,
	AvailableModelsResult,
	ContextUsage,
	MessagesPage,
	ModelInfo,
	PlanModeState,
	ProvidersResult,
	RpcActiveToolsResult,
	RpcCommand,
	RpcContextReportResult,
	RpcGetQueueResult,
	RpcGuiThemesResult,
	RpcSessionState,
	RpcThemesResult,
	RpcWorkspaceDirectoriesResult,
	SessionStats,
	SettingsSchemaResult,
} from "../src/shared/rpc-types";

export const showcaseTimestamp = Date.UTC(2026, 8, 21, 10, 30);

/** The three office jobs the screenshots show, in README order. */
export const SHOWCASE_SCENARIOS = ["report", "spreadsheet", "slides"] as const;
export type ShowcaseScenario = (typeof SHOWCASE_SCENARIOS)[number];

/** Screenshot file name (without extension) of each scenario. */
export const SHOWCASE_SHOTS: Record<ShowcaseScenario, string> = {
	report: "01-word-report",
	spreadsheet: "02-spreadsheet-cleanup",
	slides: "03-slides",
};

export function isShowcaseScenario(value: unknown): value is ShowcaseScenario {
	return typeof value === "string" && (SHOWCASE_SCENARIOS as readonly string[]).includes(value);
}

type Locale = "en" | "vi";
type Text = (en: string, vi: string) => string;

/**
 * The demo home is `/home/demo`, the one home the capture's privacy check accepts.
 * The office tools save every new file under Documents > Sai ATLAS.
 */
const OUTPUT_DIR = "/home/demo/Documents/Sai ATLAS";

/** Past tasks listed in the sidebar, one per office job plus a computer-help task. */
export function showcaseSessionTitles(locale: Locale): string[] {
	return locale === "vi"
		? [
				"Báo cáo doanh số tháng 9",
				"Dọn danh sách khách hàng",
				"Trình chiếu cho cuộc họp nhóm",
				"Máy in không in được",
			]
		: [
				"September sales report",
				"Clean up the customer list",
				"Slides for the team meeting",
				"The printer will not print",
			];
}

interface Scene {
	name: string;
	request: string;
	tool: "office_report" | "office_clean" | "office_slides";
	intent: string;
	args: Record<string, unknown>;
	file: string;
	kind: "docx" | "xlsx" | "pptx";
	check: string;
	summary: string;
}

function reportMarkdown(text: Text): string {
	return text(
		"# September sales report\n\n## Summary\n\nRevenue reached 1.2 billion VND, 8% more than in August.\n\n## By branch\n\n| Branch | Revenue (million VND) | Change |\n|---|---|---|\n| Hanoi | 520 | +14% |\n| Da Nang | 310 | +5% |\n| Ho Chi Minh City | 370 | +3% |\n\n## Highlights\n\n- Hanoi grew fastest after the new opening hours.\n- Two new business customers signed yearly contracts.\n\n## Next month\n\n- Repeat the Hanoi opening hours in Da Nang.\n- Follow up with the two new customers in the first week.",
		"# Báo cáo doanh số tháng 9\n\n## Tóm tắt\n\nDoanh thu đạt 1,2 tỷ đồng, tăng 8% so với tháng 8.\n\n## Theo chi nhánh\n\n| Chi nhánh | Doanh thu (triệu đồng) | Thay đổi |\n|---|---|---|\n| Hà Nội | 520 | +14% |\n| Đà Nẵng | 310 | +5% |\n| TP. Hồ Chí Minh | 370 | +3% |\n\n## Điểm nổi bật\n\n- Hà Nội tăng nhanh nhất nhờ giờ mở cửa mới.\n- Hai khách hàng doanh nghiệp mới đã ký hợp đồng theo năm.\n\n## Tháng tới\n\n- Áp dụng giờ mở cửa của Hà Nội cho Đà Nẵng.\n- Liên hệ lại hai khách hàng mới trong tuần đầu tiên.",
	);
}

function scene(scenario: ShowcaseScenario, text: Text): Scene {
	switch (scenario) {
		case "report": {
			const title = text("September sales report", "Báo cáo doanh số tháng 9");
			return {
				name: title,
				request: text(
					"Write a one-page report on our September sales for the team meeting. Revenue was 1.2 billion VND, 8% more than August. Hanoi 520 million (+14%), Da Nang 310 (+5%), Ho Chi Minh City 370 (+3%). Two new business customers signed yearly contracts.",
					"Viết giúp tôi báo cáo một trang về doanh số tháng 9 cho cuộc họp nhóm. Doanh thu 1,2 tỷ đồng, tăng 8% so với tháng 8. Hà Nội 520 triệu (+14%), Đà Nẵng 310 (+5%), TP. Hồ Chí Minh 370 (+3%). Hai khách hàng doanh nghiệp mới đã ký hợp đồng theo năm.",
				),
				tool: "office_report",
				intent: text("Writing the September sales report", "Đang viết báo cáo doanh số tháng 9"),
				args: { title, markdown: reportMarkdown(text) },
				file: `${OUTPUT_DIR}/${title}.docx`,
				kind: "docx",
				check: "4 headings, 1 table, 4 list items",
				summary: text(
					"Your report is ready: **September sales report.docx**. It has a short summary, a table by branch, the highlights and two steps for next month. Open it from the card above.",
					"Báo cáo đã xong: **Báo cáo doanh số tháng 9.docx**. Báo cáo có phần tóm tắt, bảng theo chi nhánh, các điểm nổi bật và hai việc cho tháng tới. Mở tệp từ thẻ ở trên.",
				),
			};
		}
		case "spreadsheet": {
			const source = text("customers", "khach-hang");
			return {
				name: text("Clean up the customer list", "Dọn danh sách khách hàng"),
				request: text(
					"Please tidy up my customer list and add a totals row.\n\nUser: /home/demo/Documents/customers.xlsx",
					"Dọn giúp tôi danh sách khách hàng và thêm dòng tổng.\n\nUser: /home/demo/Documents/khach-hang.xlsx",
				),
				tool: "office_clean",
				intent: text("Cleaning the customer list", "Đang dọn danh sách khách hàng"),
				args: { file: `/home/demo/Documents/${source}.xlsx`, totals: true },
				file: `${OUTPUT_DIR}/${source} (cleaned).xlsx`,
				kind: "xlsx",
				check: "1 sheet, 236 rows kept, 12 empty rows removed, 5 duplicate rows removed, 31 cells trimmed, 18 numbers converted, totals row added",
				summary: text(
					"Done. The cleaned copy is **customers (cleaned).xlsx**: I removed 12 empty and 5 repeated rows, trimmed extra spaces in 31 cells, turned 18 numbers stored as text into real numbers and added a totals row. Your original file is unchanged.",
					"Xong rồi. Bản đã dọn là **khach-hang (cleaned).xlsx**: tôi đã bỏ 12 dòng trống và 5 dòng lặp, xóa khoảng trắng thừa ở 31 ô, chuyển 18 số đang lưu dạng chữ thành số thật và thêm dòng tổng. Tệp gốc của bạn vẫn giữ nguyên.",
				),
			};
		}
		case "slides": {
			const title = text("September sales", "Doanh số tháng 9");
			return {
				name: text("Slides for the team meeting", "Trình chiếu cho cuộc họp nhóm"),
				request: text(
					"Make slides from the September sales report for tomorrow's team meeting.",
					"Làm trang trình chiếu từ báo cáo doanh số tháng 9 cho cuộc họp nhóm ngày mai.",
				),
				tool: "office_slides",
				intent: text("Making the slides", "Đang làm trang trình chiếu"),
				args: { title, markdown: reportMarkdown(text) },
				file: `${OUTPUT_DIR}/${title}.pptx`,
				kind: "pptx",
				check: "6 slides (1 title slide, 1 big number, 1 table, 3 bullet slides)",
				summary: text(
					"Your deck is ready: **September sales.pptx**, six slides with the headline number, the branch table and the next steps. Open it from the card above.",
					"Bộ trình chiếu đã xong: **Doanh số tháng 9.pptx**, gồm sáu trang với con số chính, bảng theo chi nhánh và các việc tiếp theo. Mở tệp từ thẻ ở trên.",
				),
			};
		}
	}
}

export function createShowcaseData(
	locale: Locale,
	cwd: string,
	scenario: ShowcaseScenario,
): { replies: Partial<Record<RpcCommand["type"], unknown>> } {
	const text: Text = (en, vi) => (locale === "vi" ? vi : en);
	const job = scene(scenario, text);
	const sessionId = `showcase-${scenario}-${locale}`;
	const contextWindow = 128_000;
	const tokensPerSecond = 24;
	const model: ModelInfo = {
		provider: "ollama",
		id: "gemma4:e4b",
		name: "Gemma 4 E4B",
		description: text("Runs on this computer", "Chạy trên máy tính này"),
		contextWindow,
		maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		tps: tokensPerSecond,
		isRecommended: true,
	};
	const availableModels: AvailableModelsResult = {
		models: [model],
		discoveryStates: [],
		refreshPending: false,
		generation: 1,
	};
	// A local Ollama needs no sign-in, so it reports unauthenticated with its models.
	const providers: ProvidersResult = {
		...availableModels,
		providers: [
			{
				id: "ollama",
				name: "Ollama",
				authenticated: false,
				loginAvailable: false,
				disabled: false,
				modelCount: 1,
			},
		],
	};

	const callId = `showcase-${scenario}-call`;
	const messages: AgentMessage[] = [
		{
			role: "user",
			entryId: "showcase-user",
			timestamp: showcaseTimestamp - 70_000,
			content: [{ type: "text", text: job.request }],
		},
		{
			role: "assistant",
			entryId: "showcase-call",
			timestamp: showcaseTimestamp - 60_000,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			duration: 9_400,
			ttft: 620,
			content: [{ type: "toolCall", id: callId, name: job.tool, intent: job.intent, arguments: job.args }],
		},
		{
			role: "toolResult",
			entryId: "showcase-result",
			timestamp: showcaseTimestamp - 52_000,
			toolCallId: callId,
			toolName: job.tool,
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ file: job.file, kind: job.kind, check: job.check }) }],
		},
		{
			role: "assistant",
			entryId: "showcase-summary",
			timestamp: showcaseTimestamp - 48_000,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			duration: 3_900,
			ttft: 540,
			content: [{ type: "text", text: job.summary }],
		},
	];
	const contextUsage: ContextUsage = { tokens: 6_200, contextWindow, percent: 4.8 };
	const state: RpcSessionState = {
		model,
		thinkingLevel: "off",
		thinkingConfigured: "off",
		availableThinkingLevels: ["off"],
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionFile: null,
		cwd,
		sessionId,
		sessionName: job.name,
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		messageCount: messages.length,
		queuedMessageCount: 0,
		todoPhases: [],
		systemPrompt: [],
		dumpTools: [],
		contextUsage,
		planModeEnabled: false,
		prewalkArmed: false,
		agentsPaused: false,
		collab: { role: null, readOnly: false, participants: [] },
	};
	const sessionStats: SessionStats = {
		sessionId,
		userMessages: 1,
		assistantMessages: 2,
		toolCalls: 1,
		toolResults: 1,
		totalMessages: messages.length,
		tokens: { input: 4_100, output: 1_300, reasoning: 0, cacheRead: 800, cacheWrite: 0, total: 6_200 },
		premiumRequests: 0,
		cost: 0,
		contextUsage,
	};
	const contextReport: RpcContextReportResult = {
		contextWindow: contextUsage.contextWindow,
		model: model.id,
		breakdown: {
			contextWindow: contextUsage.contextWindow,
			anchored: true,
			usedTokens: contextUsage.tokens,
			systemPromptTokens: 1_400,
			systemToolsTokens: 2_300,
			systemContextTokens: 0,
			skillsTokens: 300,
			messagesTokens: 2_200,
		},
	};
	const schema: SettingsSchemaResult = { tabs: [], entries: [] };
	const values: Record<string, unknown> = {
		"theme.dark": "dark",
		"theme.light": "light",
		"theme.mode": "dark",
		"speech.enabled": false,
		"stt.enabled": false,
		"display.collapseCompacted": true,
		proseOnlyThinking: true,
		omitThinking: false,
	};
	const commands: AvailableCommand[] = [
		{ name: "settings", description: text("Open settings", "Mở cài đặt") },
		{ name: "models", description: text("Choose a model", "Chọn mô hình") },
	].map(command => ({ ...command, source: "builtin", textModeExecutable: false }));
	const tool = (name: string, en: string, vi: string) => ({
		name,
		source: "extension" as const,
		description: text(en, vi),
	});

	const replies = {
		get_state: state,
		get_messages: { messages },
		get_transcript: { messages },
		get_messages_page: { messages, totalMessages: messages.length } satisfies MessagesPage,
		get_available_models: availableModels,
		get_providers: providers,
		get_login_providers: { providers: [] },
		get_session_stats: sessionStats,
		get_context_report: contextReport,
		get_settings: { values, advisorEnabled: false, advisorActive: false },
		get_settings_schema: schema,
		get_queue: { steering: [], followUp: [] } satisfies RpcGetQueueResult,
		get_plan_mode: { enabled: false } satisfies PlanModeState,
		get_themes: { themes: [] } satisfies RpcThemesResult,
		get_gui_themes: { themes: [] } satisfies RpcGuiThemesResult,
		get_directories: { directories: [{ path: cwd, primary: true }] } satisfies RpcWorkspaceDirectoriesResult,
		get_active_tools: {
			tools: [
				tool("office_report", "Write a Word report", "Viết báo cáo Word"),
				tool("office_clean", "Clean up a spreadsheet", "Dọn dẹp bảng tính"),
				tool("office_slides", "Make PowerPoint slides", "Làm trang trình chiếu PowerPoint"),
			],
		} satisfies RpcActiveToolsResult,
		get_available_commands: { commands },
		list_foreign_sessions: { sessions: [] },
		get_copy_targets: { targets: [] },
		get_last_assistant_text: { text: job.summary },
		get_force_tool: { tool: null },
	} satisfies Partial<Record<RpcCommand["type"], unknown>>;
	return { replies };
}
