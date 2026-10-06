/**
 * Pure tray vocabulary: every string the native menu shows, the menu template,
 * and the signature that decides whether the menu has to be rebuilt. Lives
 * outside `tray.ts` because that module needs electron — the label mapping, the
 * offered actions and the churn guard are the parts worth testing.
 */

import type { MenuItemConstructorOptions } from "electron";
import type { MenuAction, MenuActionPayload, TrayState } from "../shared/ipc-types";
import { PRODUCT_NAME } from "../shared/product";

export type TrayStatus = TrayState["status"];
export type TrayLang = "vi" | "en";
export type TrayApprovalMode = TrayState["approvalMode"];

/** Tray-label strings, translated in main (the renderer reports the language). */
export const TRAY_LABELS = {
	showHide: { vi: "Hiện / Ẩn", en: "Show / Hide" },
	quit: { vi: "Thoát", en: "Quit" },
	newSession: { vi: "Phiên mới", en: "New Session" },
	workspaces: { vi: "Chuyển không gian làm việc", en: "Switch Workspace" },
	quickStart: { vi: "Khởi động nhanh", en: "Quick Start" },
	quickConfig: { vi: "Cấu hình nhanh", en: "Quick Config" },
	fastMode: { vi: "Chế độ nhanh", en: "Fast Mode" },
	thinking: { vi: "Mức suy nghĩ", en: "Thinking" },
	approval: { vi: "Phê duyệt công cụ", en: "Tool Approval" },
	language: { vi: "Ngôn ngữ", en: "Language" },
	approvalYolo: { vi: "Toàn quyền truy cập", en: "Full access" },
	approvalWrite: { vi: "Tự động chỉnh sửa", en: "Auto-edit" },
	approvalAsk: { vi: "Hỏi mỗi lần", en: "Ask every time" },
	context: { vi: "Ngữ cảnh", en: "Context" },
	tokens: { vi: "tokens", en: "tokens" },
	noModel: { vi: "Chưa chọn mô hình", en: "No model" },
	statusIdle: { vi: "Rảnh", en: "Idle" },
	statusStreaming: { vi: "Đang chạy", en: "Running" },
	statusWaiting: { vi: "Chờ phản hồi", en: "Needs input" },
	statusError: { vi: "Lỗi", en: "Error" },
} as const;

export type TrayLabelKey = keyof typeof TRAY_LABELS;

export function t(lang: TrayLang, key: TrayLabelKey): string {
	return TRAY_LABELS[key][lang];
}

/** Which run state to show; the aggregate across windows, never per-window. */
export function statusLabel(lang: TrayLang, status: TrayStatus): string {
	if (status === "error") return t(lang, "statusError");
	if (status === "streaming") return t(lang, "statusStreaming");
	if (status === "waiting") return t(lang, "statusWaiting");
	return t(lang, "statusIdle");
}

/** Collapse per-window statuses to one: any error > streaming > waiting > idle. */
export function aggregateTrayStatus(states: Iterable<TrayState>): TrayStatus {
	// Precedence is app-global, so a single early return on the first window's
	// streaming would hide a later window's error.
	let streaming = false;
	let waiting = false;
	for (const { status } of states) {
		if (status === "error") return "error";
		if (status === "streaming") streaming = true;
		if (status === "waiting") waiting = true;
	}
	return streaming ? "streaming" : waiting ? "waiting" : "idle";
}

export function approvalLabel(lang: TrayLang, mode: TrayApprovalMode): string {
	if (mode === "yolo") return t(lang, "approvalYolo");
	if (mode === "write") return t(lang, "approvalWrite");
	return t(lang, "approvalAsk");
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Hover text: the icon itself stays a static template mark by design. */
export function trayTooltip(state: TrayState | null): string {
	if (!state) return PRODUCT_NAME;
	return `${PRODUCT_NAME} — ${state.projectName} · ${statusLabel(state.language === "en" ? "en" : "vi", state.status)}`;
}

/**
 * Everything a rebuilt menu can differ in, as one string. Session lists refresh
 * every few hundred milliseconds while agents stream; a push whose visible
 * labels are unchanged must not swap the native menu out. Context share is
 * bucketed to what the menu actually prints (whole percent, rendered token
 * string) so token-level streaming stays out.
 */
export function menuSignature(state: TrayState): string {
	const percent = state.contextPercent === null ? "—" : String(Math.round(state.contextPercent));
	const tokens = state.contextTokens === null ? "—" : formatTokens(state.contextTokens);
	const workspaces = state.workspaces.map(ws => `${ws.cwd}\u0000${ws.name}\u0000${ws.current}`).join("\u0001");
	return [
		state.language,
		state.status,
		state.projectName,
		state.modelId ?? "—",
		state.thinkingLevel,
		state.fastMode,
		state.approvalMode,
		percent,
		tokens,
		workspaces,
	].join("\u0002");
}

/** What the tray menu's clickable items do; `tray.ts` binds them to electron. */
export interface TrayMenuHandlers {
	/** Route an action to the renderer, which owns the RPC, i18n and UI stores. */
	send(action: MenuAction, payload?: MenuActionPayload): void;
	showHide(): void;
	quit(): void;
}

/** The tray menu for a snapshot (or none, before the renderer pushed one). */
export function trayMenuTemplate(state: TrayState | null, handlers: TrayMenuHandlers): MenuItemConstructorOptions[] {
	const lang: TrayLang = state?.language === "en" ? "en" : "vi";
	const template: MenuItemConstructorOptions[] = [];

	// Header: app + current project + the aggregate run status. This is where
	// status surfaces — the icon is a static template mark by design.
	template.push({ label: trayTooltip(state), enabled: false }, { type: "separator" });

	// Config info (read-only): model · thinking · fast · approval.
	if (state) {
		const model = state.modelId || t(lang, "noModel");
		template.push({ label: `${model} · ${t(lang, "thinking")} ${state.thinkingLevel}`, enabled: false });
		const fastLabel = `${t(lang, "fastMode")}: ${state.fastMode ? "✓" : "—"}`;
		template.push({
			label: `${fastLabel} · ${t(lang, "approval")}: ${approvalLabel(lang, state.approvalMode)}`,
			enabled: false,
		});
		// Usage / token consumption (read-only). The percent is absent — never 0 —
		// for a model whose context window Core does not know.
		if (state.contextPercent !== null || state.contextTokens !== null) {
			const share = state.contextPercent === null ? "—" : `${Math.round(state.contextPercent)}%`;
			const tokens =
				state.contextTokens !== null ? ` · ${formatTokens(state.contextTokens)} ${t(lang, "tokens")}` : "";
			template.push({ label: `${t(lang, "context")}: ${share}${tokens}`, enabled: false });
		}
		template.push({ type: "separator" });
	}

	// Workspace jumping, when the renderer reports more than nothing.
	const workspaceItems: MenuItemConstructorOptions[] = (state?.workspaces ?? []).map(ws => ({
		label: `${ws.current ? "✓ " : ""}${ws.name}`,
		enabled: !ws.current,
		click: () => handlers.send("switch-project", { cwd: ws.cwd }),
	}));
	if (workspaceItems.length > 0) template.push({ label: t(lang, "workspaces"), submenu: workspaceItems });

	// Quick start.
	template.push({
		label: t(lang, "quickStart"),
		submenu: [{ label: t(lang, "newSession"), click: () => handlers.send("new-session") }],
	});

	// Quick config: fast toggle, thinking cycle, language. The approval mode is
	// read-only here: every session runs the pack's always-ask policy.
	template.push({
		label: t(lang, "quickConfig"),
		submenu: [
			{
				label: t(lang, "fastMode"),
				type: "checkbox",
				checked: state?.fastMode ?? false,
				click: () => handlers.send("toggle-fast"),
			},
			{
				label: `${t(lang, "thinking")}: ${state?.thinkingLevel ?? "off"}`,
				click: () => handlers.send("cycle-thinking"),
			},
			{
				label: `${t(lang, "language")}: ${lang === "vi" ? "Tiếng Việt" : "English"}`,
				click: () => handlers.send("toggle-language"),
			},
		],
	});

	template.push(
		{ type: "separator" },
		{ label: t(lang, "showHide"), click: () => handlers.showHide() },
		{ type: "separator" },
		{ label: t(lang, "quit"), click: () => handlers.quit() },
	);
	return template;
}
