import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { AgentTypeStats, AggregatedStats, TimeSeriesPoint } from "../../stats/src/shared-types";
import type {
	AgentMessage,
	AvailableCommand,
	AvailableModelsResult,
	ContextUsage,
	MessagesPage,
	ModelInfo,
	ModelRoleCandidate,
	ModelRoleMetadata,
	ModelRoleMetadataResult,
	ModelRolesResult,
	PlanModeState,
	ProvidersResult,
	RpcActiveToolsResult,
	RpcAgentDefinitionsResult,
	RpcCollabState,
	RpcCommand,
	RpcContextReportResult,
	RpcGetQueueResult,
	RpcGitChanges,
	RpcGitDiff,
	RpcGitStatus,
	RpcGoalState,
	RpcGuiThemesResult,
	RpcHooksResult,
	RpcJobsResult,
	RpcLiveState,
	RpcLoopModeState,
	RpcMarketplacesResult,
	RpcMcpServersResult,
	RpcMemoryReport,
	RpcPluginsResult,
	RpcPromptTemplatesResult,
	RpcSecurityDashboardResult,
	RpcSessionState,
	RpcSessionTreeResult,
	RpcSkillsResult,
	RpcSshHostsResult,
	RpcThemesResult,
	RpcVibeModeState,
	RpcWorkspaceDirectoriesResult,
	SessionStats,
	SettingsSchemaResult,
	SubagentSnapshot,
	UsageResult,
} from "../src/shared/rpc-types";

export const showcaseTimestamp = Date.UTC(2026, 8, 21, 10, 30);
const dayMs = 86_400_000;
const preferencesPath = "src/components/Preferences.tsx";
const testsPath = "tests/Preferences.test.tsx";

const preferencesBefore = `interface PreferencesLabels {
  title: string;
  highContrast: string;
  reduceMotion: string;
}

export function Preferences({ labels }: { labels: PreferencesLabels }) {
  return (
    <div>
      <h2>{labels.title}</h2>
      <input type="checkbox" name="highContrast" aria-label={labels.highContrast} />
      <input type="checkbox" name="reduceMotion" aria-label={labels.reduceMotion} />
    </div>
  );
}
`;
const testsBefore = `import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Preferences } from "../src/components/Preferences";

const labels = { title: "aurora-web", highContrast: "highContrast", reduceMotion: "reduceMotion" };
const html = () => renderToStaticMarkup(<Preferences labels={labels} />);

test("Preferences/native-checkbox", () => {
  expect(html().match(/type="checkbox"/g)).toHaveLength(2);
});
`;
export const projectFiles: Record<string, string> = {
	[preferencesPath]: `interface PreferencesLabels {
  title: string;
  highContrast: string;
  reduceMotion: string;
}

export function Preferences({ labels }: { labels: PreferencesLabels }) {
  return (
    <section aria-labelledby="preferences-title">
      <h2 id="preferences-title">{labels.title}</h2>
      <label htmlFor="contrast">{labels.highContrast}</label>
      <input id="contrast" type="checkbox" name="highContrast" />
      <label htmlFor="motion">{labels.reduceMotion}</label>
      <input id="motion" type="checkbox" name="reduceMotion" />
    </section>
  );
}
`,
	[testsPath]: `${testsBefore}
test("Preferences/aria-labelledby", () => {
  expect(html()).toContain('aria-labelledby="preferences-title"');
  expect(html()).toContain('<h2 id="preferences-title">aurora-web</h2>');
});

test("Preferences/label-for", () => {
  expect(html()).toContain('<label for="contrast">highContrast</label>');
  expect(html()).toContain('<input id="contrast"');
  expect(html()).toContain('<label for="motion">reduceMotion</label>');
  expect(html()).toContain('<input id="motion"');
});
`,
};

export const projectDiffs: Record<string, RpcGitDiff> = Object.fromEntries(
	Object.entries({ [preferencesPath]: preferencesBefore, [testsPath]: testsBefore }).map(([path, before]) => [
		path,
		{
			path,
			diff: createTwoFilesPatch(`a/${path}`, `b/${path}`, before, projectFiles[path], undefined, undefined, {
				context: 2,
				headerOptions: FILE_HEADERS_ONLY,
			}),
			kind: "text",
			truncated: false,
		} satisfies RpcGitDiff,
	]),
);

export function createShowcaseData(
	locale: "en" | "vi",
	cwd: string,
): { replies: Record<string, unknown>; stats: Record<string, unknown> } {
	const text = (en: string, vi: string): string => (locale === "vi" ? vi : en);
	const demo = text("Demo", "Minh họa");
	const notice = text(
		"Synthetic demo data · no external requests",
		"Dữ liệu minh họa tổng hợp · không có yêu cầu bên ngoài",
	);
	const sessionId = `showcase-aurora-web-${locale}`;
	const sessionName = text("Build accessible settings", "Xây dựng trang cài đặt trợ năng");
	const rateCard = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
	const model: ModelInfo = {
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		name: `Claude Sonnet 4.5 · ${demo}`,
		description: text(
			"Demo coding model · illustrative prices and limits",
			"Mô hình lập trình minh họa · giá và giới hạn chỉ mang tính minh họa",
		),
		contextWindow: 200_000,
		maxTokens: 16_384,
		cost: rateCard,
		tps: 72,
		isRecommended: true,
	};
	const models: ModelInfo[] = [
		model,
		{
			provider: "anthropic",
			id: "claude-opus-4-5",
			name: `Claude Opus 4.5 · ${demo}`,
			description: text("Demo deep-reasoning model · not connected", "Mô hình suy luận sâu minh họa · chưa kết nối"),
			contextWindow: 200_000,
			maxTokens: 16_384,
			cost: rateCard,
			tps: 48,
		},
		{
			provider: "openai",
			id: "gpt-5.2",
			name: `GPT-5.2 · ${demo}`,
			description: text("Demo general-purpose model · not connected", "Mô hình đa năng minh họa · chưa kết nối"),
			contextWindow: 200_000,
			maxTokens: 16_384,
			cost: rateCard,
			tps: 94,
		},
		{
			provider: "openai",
			id: "gpt-5.2-codex",
			name: `GPT-5.2 Codex · ${demo}`,
			description: text(
				"Demo code-review model · not connected",
				"Mô hình đánh giá mã nguồn minh họa · chưa kết nối",
			),
			contextWindow: 200_000,
			maxTokens: 16_384,
			cost: rateCard,
			tps: 88,
		},
		{
			provider: "google",
			id: "gemini-3-pro-preview",
			name: `Gemini 3 Pro · ${demo}`,
			description: text("Demo planning model · not connected", "Mô hình lập kế hoạch minh họa · chưa kết nối"),
			contextWindow: 1_000_000,
			maxTokens: 16_384,
			cost: rateCard,
			tps: 105,
		},
		{
			provider: "google",
			id: "gemini-3-flash-preview",
			name: `Gemini 3 Flash · ${demo}`,
			description: text(
				"Demo fast-exploration model · not connected",
				"Mô hình khám phá nhanh minh họa · chưa kết nối",
			),
			contextWindow: 1_000_000,
			maxTokens: 16_384,
			cost: rateCard,
			tps: 152,
		},
	];
	const availableModels: AvailableModelsResult = {
		models,
		discoveryStates: [],
		refreshPending: false,
		generation: 1,
	};
	const providers: ProvidersResult = {
		...availableModels,
		providers: [
			{ id: "anthropic", name: `Anthropic · ${demo}` },
			{ id: "openai", name: `OpenAI · ${demo}` },
			{ id: "google", name: `Google · ${demo}` },
		].map(provider => ({
			...provider,
			authenticated: false,
			loginAvailable: false,
			disabled: false,
			modelCount: 2,
			account: text("Example catalog · no account connected", "Danh mục mẫu · chưa kết nối tài khoản"),
		})),
	};

	const summary = text(
		"## Accessible settings, ready\n\n- Added a named settings region and visible labels.\n- Kept native checkboxes for keyboard navigation.\n- Added coverage for labels and heading associations in `Preferences.test.tsx`.\n\n**Demo test result:** 3/3 passed. Synthetic data; no external requests.",
		"## Trang cài đặt trợ năng đã sẵn sàng\n\n- Đã thêm vùng cài đặt có tên và nhãn hiển thị rõ ràng.\n- Giữ nguyên các hộp kiểm gốc để điều hướng bằng bàn phím.\n- Bổ sung kiểm thử cho nhãn và liên kết tiêu đề trong `Preferences.test.tsx`.\n\n**Kết quả kiểm thử minh họa:** 3/3 vượt qua. Dữ liệu tổng hợp; không có yêu cầu ra ngoài.",
	);
	const editIntent = text("Add accessible labels and regression coverage", "Thêm nhãn trợ năng và kiểm thử hồi quy");
	const messages: AgentMessage[] = [
		{
			role: "user",
			entryId: "showcase-user",
			timestamp: showcaseTimestamp - 70_000,
			content: [
				{
					type: "text",
					text: text(
						"In the aurora-web demo project, make the preferences page accessible: add visible labels, preserve keyboard navigation, and cover the changes with tests.",
						"Trong dự án minh họa aurora-web, hãy làm cho trang tùy chọn có khả năng trợ năng: thêm nhãn hiển thị, bảo toàn điều hướng bằng bàn phím và bổ sung kiểm thử cho các thay đổi.",
					),
				},
			],
		},
		{
			role: "assistant",
			entryId: "showcase-edit",
			timestamp: showcaseTimestamp - 60_000,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			duration: 5_800,
			ttft: 380,
			content: [
				{
					type: "thinking",
					thinking: text(
						"I’ll keep the native controls, associate each visible label with its input, and name the settings region. The demo checks will cover these semantics without contacting a provider.",
						"Tôi sẽ giữ nguyên các điều khiển gốc, liên kết từng nhãn hiển thị với ô nhập tương ứng và đặt tên cho vùng cài đặt. Các kiểm tra minh họa sẽ bao quát các ngữ nghĩa này mà không cần gọi đến nhà cung cấp.",
					),
				},
				{
					type: "toolCall",
					id: "showcase-edit-preferences",
					name: "edit",
					intent: editIntent,
					arguments: {
						edits: [preferencesPath, testsPath].map(path => ({
							path,
							op: "update",
							diff: projectDiffs[path].diff,
						})),
					},
				},
			],
		},
		{
			role: "toolResult",
			entryId: "showcase-edit-result",
			timestamp: showcaseTimestamp - 53_000,
			toolCallId: "showcase-edit-preferences",
			toolName: "edit",
			isError: false,
			content: [
				{
					type: "text",
					text: text("Demo: updated two synthetic files.", "Minh họa: đã cập nhật hai tệp tổng hợp."),
				},
			],
			details: {
				perFileResults: [preferencesPath, testsPath].map(path => ({
					path,
					diff: projectDiffs[path].diff,
					op: "update",
					firstChangedLine: path === preferencesPath ? 9 : 12,
				})),
			},
		},
		{
			role: "assistant",
			entryId: "showcase-summary",
			timestamp: showcaseTimestamp - 48_000,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			duration: 4_200,
			ttft: 340,
			content: [{ type: "text", text: summary }],
		},
	];
	const contextUsage: ContextUsage = { tokens: 18_400, contextWindow: 200_000, percent: 9.2 };
	const collab: RpcCollabState = { role: null, readOnly: false, participants: [] };
	const state: RpcSessionState = {
		model,
		thinkingLevel: "high",
		thinkingConfigured: "high",
		availableThinkingLevels: ["low", "medium", "high"],
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionFile: null,
		cwd,
		sessionId,
		sessionName,
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond: 72,
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
		collab,
	};
	const sessionStats: SessionStats = {
		sessionId,
		userMessages: 1,
		assistantMessages: 2,
		toolCalls: 1,
		toolResults: 1,
		totalMessages: messages.length,
		tokens: { input: 6_600, output: 1_200, reasoning: 320, cacheRead: 14_400, cacheWrite: 2_400, total: 24_600 },
		premiumRequests: 2,
		cost: 0.05112,
		contextUsage,
	};
	const contextReport: RpcContextReportResult = {
		contextWindow: contextUsage.contextWindow,
		model: model.id,
		breakdown: {
			contextWindow: contextUsage.contextWindow,
			anchored: true,
			usedTokens: contextUsage.tokens,
			systemPromptTokens: 2_100,
			systemToolsTokens: 4_600,
			systemContextTokens: 900,
			skillsTokens: 400,
			messagesTokens: 10_400,
		},
	};
	const usage: UsageResult = {
		reports: [
			{
				provider: `Anthropic · ${demo}`,
				fetchedAt: showcaseTimestamp,
				notes: [notice],
				limits: [
					{
						id: "demo-session",
						label: text("Session allowance (example)", "Hạn mức phiên (minh họa)"),
						usedFraction: 0.32,
						remainingFraction: 0.68,
						resetsAt: showcaseTimestamp + 2 * 3_600_000,
						status: "ok",
					},
					{
						id: "demo-week",
						label: text("Weekly allowance (example)", "Hạn mức hàng tuần (minh họa)"),
						usedFraction: 0.18,
						remainingFraction: 0.82,
						resetsAt: showcaseTimestamp + 4 * dayMs,
						status: "ok",
					},
				],
			},
			{
				provider: `OpenAI · ${demo}`,
				fetchedAt: showcaseTimestamp,
				notes: [notice],
				limits: [
					{
						id: "demo-requests",
						label: text("Request allowance (example)", "Hạn mức yêu cầu (minh họa)"),
						used: 42,
						limit: 200,
						usedFraction: 0.21,
						unit: text("requests", "yêu cầu"),
						status: "ok",
					},
				],
			},
		],
		session: {
			input: sessionStats.tokens.input,
			output: sessionStats.tokens.output,
			cacheRead: sessionStats.tokens.cacheRead,
			cacheWrite: sessionStats.tokens.cacheWrite,
			totalTokens: sessionStats.tokens.total,
			orchestrationTokens: 0,
			premiumRequests: sessionStats.premiumRequests,
			cost: sessionStats.cost,
		},
	};

	const candidates: ModelRoleCandidate[] = models.map(candidate => ({
		provider: candidate.provider,
		id: candidate.id,
		name: candidate.name ?? candidate.id,
		kind: "chat",
	}));
	const roleMetadata: ModelRoleMetadata[] = [
		{
			id: "default",
			name: text("Default", "Mặc định"),
			tag: text("DEFAULT", "MẶC ĐỊNH"),
			color: "success",
			section: "chat",
		},
		{ id: "smol", name: text("Fast", "Nhanh"), tag: text("FAST", "NHANH"), color: "warning", section: "chat" },
		{
			id: "slow",
			name: text("Thinking", "Suy nghĩ"),
			tag: text("THINK", "SUY NGHĨ"),
			color: "accent",
			section: "chat",
		},
		{
			id: "plan",
			name: text("Architect", "Kiến trúc"),
			tag: text("PLAN", "KẾ HOẠCH"),
			color: "muted",
			section: "chat",
		},
		{ id: "task", name: text("Subtask", "Tác vụ con"), tag: text("TASK", "TÁC VỤ"), color: "muted", section: "chat" },
		{
			id: "advisor",
			name: text("Advisor", "Cố vấn"),
			tag: text("REVIEW", "ĐÁNH GIÁ"),
			color: "accent",
			section: "chat",
		},
	];
	const assignments: Record<string, string> = {
		default: "anthropic/claude-sonnet-4-5",
		smol: "google/gemini-3-flash-preview",
		slow: "anthropic/claude-opus-4-5",
		plan: "google/gemini-3-pro-preview",
		task: "openai/gpt-5.2-codex",
		advisor: "openai/gpt-5.2",
	};
	const modelRoles: ModelRolesResult = {
		roles: roleMetadata.map(role => ({ ...role, model: assignments[role.id], source: notice, candidates })),
	};

	const agentRows = [
		{
			agent: "scout",
			status: "completed",
			role: "smol",
			tokens: 9_200,
			cost: 0.012,
			durationMs: 28_000,
			toolCount: 4,
			task: text("Demo · map the existing form patterns", "Minh họa · khảo sát các mẫu biểu mẫu hiện có"),
			note: text(
				"Found reusable labels and native controls",
				"Đã tìm thấy nhãn có thể tái sử dụng và điều khiển gốc",
			),
		},
		{
			agent: "task",
			status: "running",
			role: "task",
			tokens: 6_800,
			cost: 0.018,
			durationMs: 38_000,
			toolCount: 3,
			task: text("Demo · check the narrow-screen layout", "Minh họa · kiểm tra bố cục màn hình hẹp"),
			note: text("Checking spacing at 320 px · 2/3 checks", "Đang kiểm tra khoảng cách ở 320 px · 2/3 kiểm tra"),
		},
		{
			agent: "reviewer",
			status: "parked",
			role: "advisor",
			tokens: 4_300,
			cost: 0.0098,
			durationMs: 19_000,
			toolCount: 2,
			task: text("Demo · review keyboard and label semantics", "Minh họa · đánh giá ngữ nghĩa bàn phím và nhãn"),
			note: text("Review complete · parked for follow-up", "Đã đánh giá xong · tạm dừng chờ tiếp tục"),
		},
	];
	const subagents: SubagentSnapshot[] = agentRows.map((row, index) => {
		const id = `showcase-${row.agent}`;
		return {
			id,
			index: index + 1,
			agent: row.agent,
			agentSource: "bundled",
			kind: "sub",
			status: row.status,
			live: row.status === "running",
			lastUpdate: showcaseTimestamp,
			task: row.task,
			assignment: row.task,
			description: row.task,
			progress: {
				id,
				index,
				agent: row.agent,
				agentSource: "bundled",
				status: row.status === "running" ? "running" : "completed",
				task: row.task,
				assignment: row.task,
				description: row.note,
				lastIntent: row.note,
				recentTools: [{ tool: "read", args: preferencesPath, endMs: showcaseTimestamp - 2_000 }],
				recentOutput: [row.note, notice],
				toolCount: row.toolCount,
				requests: 2,
				tokens: row.tokens,
				contextTokens: row.tokens,
				contextWindow: 200_000,
				cost: row.cost,
				durationMs: row.durationMs,
				modelRole: row.role,
				resolvedModel: assignments[row.role],
			},
		};
	});
	const agentDefinitions: RpcAgentDefinitionsResult = {
		agents: agentRows.map(row => ({
			name: row.agent,
			description: `${row.task} · ${notice}`,
			source: "bundled",
			model: [`@${row.role}`],
			thinkingLevel: "medium",
			effectiveThinkingLevel: "medium",
			tools: row.agent === "task" ? ["read", "edit", "bash"] : ["read", "grep", "find"],
			spawns: [],
			blocking: false,
			defaultPatterns: [`@${row.role}`],
			defaultResolved: assignments[row.role],
			effectivePatterns: [`@${row.role}`],
			effectiveResolved: assignments[row.role],
		})),
	};

	const schema: SettingsSchemaResult = {
		tabs: [
			{ id: "context", label: text("Context", "Ngữ cảnh"), groups: [] },
			{ id: "model", label: text("Models", "Mô hình"), groups: [] },
			{ id: "providers", label: text("Providers", "Nhà cung cấp"), groups: [] },
			{ id: "tasks", label: text("Tasks", "Tác vụ"), groups: [] },
			{ id: "files", label: text("Files", "Tệp"), groups: [] },
			{ id: "shell", label: text("Shell", "Dòng lệnh"), groups: [] },
			{ id: "tools", label: text("Tools", "Công cụ"), groups: [] },
			{ id: "memory", label: text("Memory", "Bộ nhớ"), groups: [] },
			{ id: "interaction", label: text("Interaction", "Tương tác"), groups: [] },
		],
		entries: [
			{
				path: "compaction.enabled",
				type: "boolean",
				tab: "context",
				value: true,
				default: true,
				label: text("Automatic compaction", "Tự động nén"),
				description: text(
					"Demo: preserve room for the next task by summarizing older context.",
					"Minh họa: giữ chỗ cho tác vụ tiếp theo bằng cách tóm tắt ngữ cảnh cũ hơn.",
				),
			},
			{
				path: "compaction.thresholdPercent",
				type: "number",
				tab: "context",
				value: 80,
				default: 80,
				label: text("Context threshold (%)", "Ngưỡng ngữ cảnh (%)"),
				description: text(
					"Demo: compact when context reaches this percentage.",
					"Minh họa: nén khi ngữ cảnh đạt đến tỷ lệ phần trăm này.",
				),
			},
			{
				path: "compaction.reserveTokens",
				type: "number",
				tab: "context",
				value: 16_384,
				default: 16_384,
				label: text("Reserved output tokens", "Token đầu ra dự lưu"),
				description: text(
					"Demo: keep a response budget available after compaction.",
					"Minh họa: duy trì ngân sách phản hồi khả dụng sau khi nén.",
				),
			},
			{
				path: "hideThinkingBlock",
				type: "boolean",
				tab: "model",
				value: false,
				default: false,
				label: text("Hide reasoning blocks", "Ẩn khối suy luận"),
				description: text(
					"Demo: keep reasoning visible alongside the answer.",
					"Minh họa: giữ hiển thị phần suy luận bên cạnh câu trả lời.",
				),
			},
			{
				path: "task.showResolvedModelBadge",
				type: "boolean",
				tab: "tasks",
				value: true,
				default: true,
				label: text("Show agent models", "Hiển thị mô hình của agent"),
				description: text(
					"Demo: identify the model assigned to each delegated task.",
					"Minh họa: xác định mô hình được chỉ định cho từng tác vụ được ủy quyền.",
				),
			},
			{
				path: "bash.enabled",
				type: "boolean",
				tab: "shell",
				value: true,
				default: true,
				label: text("Shell tool", "Công cụ dòng lệnh"),
				description: text(
					"Demo capability only; no commands are executed.",
					"Chỉ là khả năng minh họa; không có lệnh nào được thực thi.",
				),
			},
			{
				path: "tools.approvalMode",
				type: "enum",
				tab: "tools",
				value: "always-ask",
				default: "always-ask",
				label: text("Tool approvals", "Phê duyệt công cụ"),
				description: text(
					"Demo: request confirmation before a tool changes the workspace.",
					"Minh họa: yêu cầu xác nhận trước khi một công cụ thay đổi không gian làm việc.",
				),
				options: [
					{ value: "always-ask", label: text("Always ask", "Luôn hỏi") },
					{ value: "write", label: text("Ask before writes", "Hỏi trước khi ghi") },
					{ value: "yolo", label: text("Do not ask", "Không hỏi") },
				],
			},
			{
				path: "memory.backend",
				type: "enum",
				tab: "memory",
				value: "off",
				default: "off",
				options: [{ value: "off", label: text("Off", "Tắt") }],
				label: text("Persistent memory", "Bộ nhớ bền vững"),
				description: text(
					"Disabled in the demo; no personal history is loaded.",
					"Đã tắt trong bản minh họa; không có lịch sử cá nhân nào được tải.",
				),
			},
			{
				path: "display.showTokenUsage",
				type: "boolean",
				tab: "interaction",
				value: true,
				default: false,
				label: text("Show token usage", "Hiển thị lượng dùng token"),
				description: text(
					"Demo: display synthetic usage figures for the session.",
					"Minh họa: hiển thị số liệu sử dụng tổng hợp cho phiên làm việc.",
				),
			},
		],
	};
	const values: Record<string, unknown> = {
		...Object.fromEntries(schema.entries.map(entry => [entry.path, entry.value])),
		"theme.dark": "dark",
		"theme.light": "light",
		"theme.mode": "dark",
		"security.enabled": false,
		"speech.enabled": false,
		"stt.enabled": false,
		"display.collapseCompacted": true,
		"terminal.showProgress": true,
		proseOnlyThinking: true,
		omitThinking: false,
	};
	const skills: RpcSkillsResult = {
		skills: [
			{
				name: text("Accessibility review", "Đánh giá trợ năng"),
				slug: "accessibility",
				description: text(
					"Demo skill: inspect labels, focus order, and native controls.",
					"Kỹ năng minh họa: kiểm tra nhãn, thứ tự lấy tiêu điểm và các điều khiển gốc.",
				),
			},
			{
				name: text("React testing", "Kiểm thử React"),
				slug: "react-testing",
				description: text(
					"Demo skill: protect component behavior with focused regression tests.",
					"Kỹ năng minh họa: bảo vệ hành vi thành phần bằng các kiểm thử hồi quy tập trung.",
				),
			},
		].map(skill => ({
			name: skill.name,
			description: skill.description,
			source: "native:project",
			provider: "native",
			providerName: text("Demo project", "Dự án minh họa"),
			level: "project",
			location: `${cwd}/.showcase/skills/${skill.slug}/SKILL.md`,
			enabled: true,
			managed: false,
			hidden: false,
		})),
	};
	const mcpServers: RpcMcpServersResult = {
		servers: [
			{
				name: text("Design references · demo", "Tài liệu thiết kế tham khảo · minh họa"),
				transport: "http",
				url: "https://design.example.invalid/mcp",
			},
			{
				name: text("Project documentation · demo", "Tài liệu dự án · minh họa"),
				transport: "http",
				url: "https://docs.example.invalid/mcp",
			},
		].map(server => ({
			...server,
			transport: "http",
			scope: "project",
			status: "disconnected",
			toolCount: 0,
			enabled: false,
			authed: false,
			authState: "none",
			lastError: notice,
		})),
	};
	const gitChanges: RpcGitChanges = {
		isRepo: true,
		root: cwd,
		base: "HEAD",
		truncated: false,
		files: [
			{ path: preferencesPath, status: "M" },
			{ path: testsPath, status: "M" },
		],
	};
	const commands: AvailableCommand[] = [
		{ name: "settings", description: text("Open demo settings", "Mở cài đặt minh họa") },
		{ name: "models", description: text("Browse the demo model catalog", "Duyệt danh mục mô hình minh họa") },
		{
			name: "context",
			description: text("Inspect synthetic context usage", "Kiểm tra lượng dùng ngữ cảnh tổng hợp"),
		},
		{ name: "stats", description: text("Open synthetic activity statistics", "Mở thống kê hoạt động tổng hợp") },
		{
			name: "providers",
			description: text("Inspect disconnected demo providers", "Xem các nhà cung cấp minh họa chưa kết nối"),
		},
	].map(command => ({ ...command, source: "builtin", textModeExecutable: false }));

	const replies = {
		get_state: state,
		get_messages: { messages },
		get_transcript: { messages },
		get_messages_page: { messages, totalMessages: messages.length } satisfies MessagesPage,
		get_available_models: availableModels,
		get_providers: providers,
		get_login_providers: { providers: [] },
		get_model_roles: modelRoles,
		get_model_role_metadata: { roles: roleMetadata } satisfies ModelRoleMetadataResult,
		get_subagents: { subagents },
		get_subagent_messages: { messages: [], nextByte: 0 },
		get_agent_definitions: agentDefinitions,
		get_session_stats: sessionStats,
		get_context_report: contextReport,
		get_usage: usage,
		get_git_status: {
			isRepo: true,
			branch: "demo/accessible-settings",
			staged: 0,
			unstaged: 2,
			untracked: 0,
		} satisfies RpcGitStatus,
		get_git_changes: gitChanges,
		get_git_diff: projectDiffs[preferencesPath],
		get_settings: { values, advisorEnabled: false, advisorActive: false },
		get_settings_schema: schema,
		get_skills: skills,
		get_mcp_servers: mcpServers,
		get_queue: { steering: [], followUp: [] } satisfies RpcGetQueueResult,
		get_goal: { enabled: false, status: "none" } satisfies RpcGoalState,
		get_loop_mode: { enabled: false, state: "off" } satisfies RpcLoopModeState,
		get_vibe_mode: { enabled: false } satisfies RpcVibeModeState,
		get_plan_mode: { enabled: false } satisfies PlanModeState,
		get_plugins: { plugins: [] } satisfies RpcPluginsResult,
		get_hooks: { hooks: [] } satisfies RpcHooksResult,
		get_themes: { themes: [] } satisfies RpcThemesResult,
		get_gui_themes: { themes: [] } satisfies RpcGuiThemesResult,
		get_collab_state: collab,
		get_marketplaces: { marketplaces: [] } satisfies RpcMarketplacesResult,
		get_prompt_templates: { templates: [] } satisfies RpcPromptTemplatesResult,
		get_jobs: { jobs: [] } satisfies RpcJobsResult,
		get_directories: { directories: [{ path: cwd, primary: true }] } satisfies RpcWorkspaceDirectoriesResult,
		get_active_tools: {
			tools: [
				{
					name: "read",
					source: "builtin",
					description: text("Demo: inspect synthetic project files", "Minh họa: kiểm tra các tệp dự án tổng hợp"),
				},
				{
					name: "edit",
					source: "builtin",
					description: text("Demo: preview a two-file change", "Minh họa: xem trước thay đổi trên hai tệp"),
				},
				{
					name: "task",
					source: "builtin",
					description: text("Demo: display delegated work", "Minh họa: hiển thị công việc được ủy quyền"),
				},
			],
		} satisfies RpcActiveToolsResult,
		get_available_commands: { commands },
		get_live_state: {
			active: false,
			phase: "connecting",
			muted: false,
			inputLevel: 0,
			outputLevel: 0,
		} satisfies RpcLiveState,
		get_memory_report: {
			backend: "off",
			entryCount: 0,
			status: { active: false, writable: false, searchable: false, message: notice },
		} satisfies RpcMemoryReport,
		get_security_dashboard: {
			enabled: false,
			modelReady: false,
			repositoryRoot: cwd,
			scans: [],
			operations: [],
		} satisfies RpcSecurityDashboardResult,
		get_ssh_hosts: { hosts: [], warnings: [], openSshAvailable: false } satisfies RpcSshHostsResult,
		list_foreign_sessions: { sessions: [] },
		get_session_tree: { tree: [], activeLeafId: null } satisfies RpcSessionTreeResult,
		get_copy_targets: { targets: [] },
		get_last_assistant_text: { text: summary },
		get_force_tool: { tool: null },
		set_subagent_subscription: {},
		set_host_tools: {},
		set_host_uri_schemes: {},
	} satisfies Partial<Record<RpcCommand["type"], unknown>>;

	// The renderer prints agentType verbatim, so localize this display column.
	const byAgentType: Array<Omit<AgentTypeStats, "agentType"> & { agentType: string }> = [
		{ agentType: text("Main · demo", "Chính · minh họa"), requests: 290 },
		{ agentType: text("Subagents · demo", "Agent phụ · minh họa"), requests: 174 },
		{ agentType: text("Advisor · demo", "Cố vấn · minh họa"), requests: 44 },
	].map(row => ({
		agentType: row.agentType,
		totalRequests: row.requests,
		totalInputTokens: row.requests * 1_500,
		totalOutputTokens: row.requests * 800,
		totalCacheReadTokens: row.requests * 7_000,
		totalCacheWriteTokens: row.requests * 700,
		totalCost: row.requests * 0.02,
	}));
	const dailyRequests = [48, 62, 57, 84, 73, 96, 88];
	const dailyErrors = [0, 1, 0, 1, 0, 0, 1];
	const firstDay = Date.UTC(2026, 8, 15);
	const timeSeries: TimeSeriesPoint[] = dailyRequests.map((requests, index) => ({
		timestamp: firstDay + index * dayMs,
		requests,
		errors: dailyErrors[index],
		tokens: requests * 10_000,
		cost: requests * 0.02,
	}));
	const totalRequests = dailyRequests.reduce((sum, requests) => sum + requests, 0);
	// Overview top lists; the model requests add up to the agent-type totals above.
	const byModel = [
		{ model: "claude-sonnet-4-5", provider: "anthropic", totalRequests: 290 },
		{ model: "gemini-3-flash-preview", provider: "google", totalRequests: 110 },
		{ model: "gpt-5.2-codex", provider: "openai", totalRequests: 64 },
		{ model: "gpt-5.2", provider: "openai", totalRequests: 44 },
	];
	const byTool = [
		{ tool: "read", calls: 412 },
		{ tool: "edit", calls: 168 },
		{ tool: "bash", calls: 121 },
		{ tool: "grep", calls: 96 },
		{ tool: "find", calls: 38 },
	];
	const failedRequests = dailyErrors.reduce((sum, errors) => sum + errors, 0);
	const overall: AggregatedStats = {
		totalRequests,
		successfulRequests: totalRequests - failedRequests,
		failedRequests,
		errorRate: failedRequests / totalRequests,
		totalInputTokens: totalRequests * 1_500,
		totalOutputTokens: totalRequests * 800,
		totalCacheReadTokens: totalRequests * 7_000,
		totalCacheWriteTokens: totalRequests * 700,
		cacheRate: 7_000 / (1_500 + 7_000 + 700),
		cacheSavings: 0.64,
		totalCost: totalRequests * 0.02,
		unpricedRequests: 0,
		totalPremiumRequests: totalRequests,
		avgDuration: 11_100,
		avgTtft: 420,
		avgTokensPerSecond: 72,
		firstTimestamp: firstDay,
		lastTimestamp: showcaseTimestamp,
	};
	return {
		replies,
		stats: {
			"/api/stats/overview": { overall, byAgentType, timeSeries, source: notice },
			"/api/stats/model-dashboard": { byModel },
			"/api/stats/tools": { byTool },
		},
	};
}
