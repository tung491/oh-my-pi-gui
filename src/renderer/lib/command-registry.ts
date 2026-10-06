import {
	activeTabCommand,
	focusedSessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
	withSessionRuntime,
} from "../stores/session-runtime-context";
import { createTabRpc, type TabRpc } from "./tab-rpc";

/**
 * Declarative command registry: maps every known slash command to a typed
 * UI affordance so the GUI can present them as first-class menu actions
 * instead of injecting "/command" text into the composer.
 *
 * Affordance kinds:
 * - `action`      — fire an RPC command or store action immediately
 * - `toggle`      — boolean state toggle with live on/off status
 * - `picker`      — open a picker dialog (model, thinking level)
 * - `window`      — open a dedicated window (usage, providers, settings)
 * - `submenu`     — expand into subcommands (mcp, marketplace, security…)
 * - `prompt`      — send the command text as a prompt (text-mode fallback)
 * - `unavailable` — non-text command lacking a native GUI affordance
 */

import type { SessionKind } from "../../shared/ipc-types";
import { HIDDEN_ACCOUNT_COMMANDS } from "../../shared/provider-policy";
import type { AvailableCommand, CopyTarget, RpcResponse } from "../../shared/rpc-types";
import { applyModelInfo, hydrateSession, hydrateTabSession } from "../hooks/use-rpc-events";
import { newSessionNow } from "../hooks/use-session-switch";
import { useModelStore } from "../stores/model";
import { type SessionStore, useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { activeTabKind, useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { useTodoStore } from "../stores/todo";
import { type DockCardId, useUiStore } from "../stores/ui";
import { isCommandAvailable, REMOVED_COMMANDS } from "./command-availability";
import { exportSessionHtml } from "./export-session";
import { copyText } from "./format";
import { translate } from "./i18n";
import { clearSessionContext, retryLastTurn as retryLastTurnShared } from "./messages";
import { isCloudTag } from "./ollama-cloud";
import { copyTodosToClipboard, dumpTranscriptToClipboard, exportTodos, importTodosFromFile } from "./transcript-copy";

/**
 * `action` and `prompt` carry `argUsage` when the command needs user text
 * before it can run: the palette has no argument entry, so those rows hand the
 * command back to the composer instead of dispatching it argument-less.
 */
export type CommandAffordance =
	| { kind: "action"; run: (args?: string) => unknown; status?: string; argUsage?: string }
	| { kind: "toggle"; get: () => boolean; set: (enabled: boolean) => unknown }
	| { kind: "picker"; open: () => void }
	| { kind: "window"; open: () => void }
	| { kind: "submenu"; items: CommandMenuItem[] }
	| { kind: "prompt"; text: string; argUsage?: string }
	| { kind: "unavailable"; reason: string };

export interface CommandMenuItem {
	name: string;
	label: string;
	description?: string;
	category: CommandCategory;
	affordance: CommandAffordance;
	shortcut?: string;
	aliases?: string[];
}

export type CommandCategory =
	| "session"
	| "model"
	| "context"
	| "tools"
	| "providers"
	| "extensions"
	| "modes"
	| "view"
	| "workspace"
	| "other";

export interface CommandRegistryContext {
	/**
	 * Translator for built-in labels/descriptions. Components pass their
	 * reactive `useT()` so the memoized menu rebuilds on locale switch;
	 * non-component callers pass the module-scope `translate()`.
	 */
	t: (key: string, params?: Record<string, string | number>) => string;
	/**
	 * Kind of the tab this menu is built for. Required: chat tabs run without
	 * tools, and a menu that ignores it offers commands that do nothing.
	 */
	tabKind: SessionKind;
	isStreaming: boolean;
	fastModeEnabled: boolean;
	autoCompaction: boolean;
	autoRetry: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	planModeEnabled: boolean;
	prewalkArmed: boolean;
	availableCommands: AvailableCommand[];
	openModelPicker: () => void;
	openSettings: (tab?: string) => void;
	openProviders: () => void;
	openCommandPalette: () => void;
	openRenameDialog: () => void;
	openSessionPicker: () => void;
	openSessionInfo: () => void;
	openThemePicker: () => void;
	openAgentHub: (tab?: "definitions" | "hub") => void;
	openHotkeys: () => void;
	/** Deep-link a center-dock card (todo/plan/agents): expand + flash. */
	focusDockCard: (id: DockCardId) => void;
	/** Retry the last failed turn server-side (retry RPC). */
	retryTurn: () => Promise<unknown>;
	/** Re-send the most recent user message (abortAndPrompt while streaming). */
	retryLastTurn: () => Promise<unknown>;
	/** Clone the whole session at head (true /fork) into a new session. */
	forkSession: () => Promise<unknown>;
	/** Refresh session state after a mutation (compact, fork, etc). */
	hydrateSession: () => Promise<void>;
	rpc: {
		setFastMode: (enabled: boolean) => Promise<RpcResponse>;
		setAutoCompaction: (enabled: boolean) => Promise<RpcResponse>;
		setAutoRetry: (enabled: boolean) => Promise<RpcResponse>;
		setSteeringMode: (mode: "all" | "one-at-a-time") => Promise<unknown>;
		setFollowUpMode: (mode: "all" | "one-at-a-time") => Promise<unknown>;
		setInterruptMode: (mode: "immediate" | "wait") => Promise<unknown>;
		compact: (instructions?: string) => Promise<RpcResponse>;
		newSession: () => Promise<unknown>;
		prompt: (message: string) => Promise<unknown>;
		setPlanMode: (enabled: boolean) => Promise<RpcResponse>;
		setPrewalk: (enabled: boolean) => Promise<RpcResponse>;
		exportHtml: (path?: string) => Promise<unknown>;
		setSessionName: (name: string) => Promise<unknown>;
		cycleModel: () => Promise<unknown>;
		cycleThinkingLevel: () => Promise<unknown>;
	};
}

/**
 * Commands left as kind:"prompt" forward `/cmd` text to the agent, which
 * runs the logic agent-side and replies with TUI-rendered text. Nativizing
 * them needs a dedicated RPC per command (structured result instead of text)
 * — tracked as P1: security, session delete, session pin.
 */

/** Helper to build a prompt affordance. */
const p = (text: string, argUsage?: string): CommandAffordance => ({ kind: "prompt", text, argUsage });

/**
 * Locale key stem for a command name: hyphens camelCase, spaces become dots
 * ("model cycle" → "cmd.model.cycle", "mcp smithery-search" → "cmd.mcp.smitherySearch").
 */
const keyOf = (name: string): string =>
	name.replace(/-(\w)/g, (_hyphen, ch: string) => ch.toUpperCase()).replace(/ /g, ".");

/**
 * Runtime toggle applier (mirrors SettingsWindow's apply* pattern): toast on
 * RPC failure, otherwise apply the returned state to the owning store so the
 * UI reflects the server truth immediately instead of waiting for a push.
 */
export async function runSessionCommand(
	promise: Promise<RpcResponse>,
	title: string,
	apply?: (data: unknown) => void,
): Promise<void> {
	const runtime = focusedSessionRuntime();
	const sessionId = useSessionStore.getState().sessionId;
	try {
		const res = await promise;
		if (!res.success) {
			toast({ variant: "error", title, message: res.error });
			return;
		}
		if (!apply) return;
		if (runtime) {
			if (
				sessionRuntime(runtime.tabId) !== runtime ||
				sessionRuntimeStore<SessionStore>(runtime.tabId, "session")?.getState().sessionId !== sessionId
			)
				return;
			withSessionRuntime(runtime.tabId, () => apply(res.data));
		} else if (useSessionStore.getState().sessionId === sessionId) apply(res.data);
	} catch (cause) {
		toast({ variant: "error", title, message: String(cause) });
	}
}

/**
 * Step the focused tab to the next (or previous) model in the store's catalog,
 * wrapping at either end. The agent's own `cycle_model` walks every provider
 * it has credentials for, so the GUI cycles over the allowed list itself and
 * switches with `set_model`. With nothing else to move to it does nothing, as
 * `cycle_model` does; a failed switch toasts under `palette.failed`.
 */
export async function cycleAllowedModel(
	rpc: Pick<TabRpc, "setModel">,
	direction: "forward" | "backward" = "forward",
): Promise<void> {
	const { availableModels, model: current } = useModelStore.getState();
	// A cloud model would send the conversation online: never step onto one.
	const models = availableModels.filter(model => !isCloudTag(model.id));
	if (models.length === 0) return;
	const index = current
		? models.findIndex(model => model.provider === current.provider && model.id === current.id)
		: -1;
	const step = direction === "forward" ? 1 : -1;
	const next =
		index < 0
			? models[direction === "forward" ? 0 : models.length - 1]
			: models[(index + step + models.length) % models.length];
	if (!next || (current && next.provider === current.provider && next.id === current.id)) return;
	const tabId = focusedSessionRuntime()?.tabId ?? null;
	await runSessionCommand(rpc.setModel(next.provider, next.id), translate("palette.failed"), data =>
		applyModelInfo(data, tabId),
	);
}

/** Restart the focused tab's sidecar without interrupting an active turn. */
export async function restartSidecarFromGui(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const session = runtime
		? sessionRuntimeStore<SessionStore>(runtime.tabId, "session")?.getState()
		: useSessionStore.getState();
	if (session?.isStreaming || session?.isCompacting) {
		toast({ variant: "warning", message: translate("sessionSwitch.busyBlocked") });
		return;
	}
	try {
		await window.omp.sidecar.restart({ tabId: runtime?.tabId, sessionPath: session?.sessionFile ?? undefined });
		toast({ variant: "info", message: translate("settings.launch.restarting") });
	} catch (cause) {
		toast({ variant: "error", title: translate("app.actionFailed"), message: String(cause) });
	}
}

export function buildCommandMenu(ctx: CommandRegistryContext): CommandMenuItem[] {
	const { t } = ctx;
	const runtime = focusedSessionRuntime();
	const boundRpc = runtime
		? createTabRpc(runtime.command)
		: typeof window === "undefined"
			? createTabRpc(activeTabCommand)
			: window.omp.rpc;
	const items: CommandMenuItem[] = [];
	/** Every name the menu claims: item names plus their aliases. */
	const claimed = new Set<string>();

	/**
	 * Single insertion point. A command that cannot run in this tab kind is
	 * downgraded to a disabled row carrying the reason, so no surface can
	 * offer (or execute) a silent no-op.
	 */
	const add = (item: CommandMenuItem) => {
		if (claimed.has(item.name)) return;
		claimed.add(item.name);
		for (const alias of item.aliases ?? []) claimed.add(alias);
		items.push(
			isCommandAvailable(ctx.tabKind, item.name)
				? item
				: { ...item, affordance: { kind: "unavailable", reason: t("unavailable.chatSession") } },
		);
	};

	/** Helper to build a submenu item; the label resolves through the ctx translator. */
	const sub = (name: string, text: string, argUsage?: string): CommandMenuItem => ({
		name,
		label: t(`cmd.${keyOf(name)}`),
		category: "extensions",
		affordance: p(text, argUsage),
	});

	/** Helper to build a submenu item executing a native action (RPC/store) instead of prompt text. */
	const subAction = (name: string, run: (args?: string) => unknown): CommandMenuItem => ({
		name,
		label: t(`cmd.${keyOf(name)}`),
		category: "extensions",
		affordance: { kind: "action", run },
	});

	const restartSidecar = restartSidecarFromGui;

	/** /advisor on|off — set_setting live-applies advisor.enabled and reports activation state. */
	const setAdvisor = async (enabled: boolean): Promise<void> => {
		const res = await boundRpc.setSetting("advisor.enabled", enabled);
		if (!res.success) throw new Error(res.error);
		const data = res.data as { advisorEnabled?: boolean; advisorActive?: boolean } | undefined;
		if (enabled && data?.advisorEnabled === true && data.advisorActive !== true) {
			toast({ variant: "info", message: t("advisor.noModel") });
			return;
		}
		toast({ variant: "success", message: t(enabled ? "advisor.enabled" : "advisor.disabled") });
	};

	// ═══════════════════════════════════════════════════════════════════
	// SESSION
	// ═══════════════════════════════════════════════════════════════════
	// /new and /clear replace the session server-side and would silently abort
	// an in-flight run — block while busy, same guard as the menu/deep-link
	// paths.
	const newSessionGuarded = (): Promise<unknown> | undefined => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
			return undefined;
		}
		return ctx.rpc.newSession();
	};
	// /clear drops context in place (clear_context RPC) — the server refuses
	// while streaming; guard client-side with the same busy toast.
	const clearContextGuarded = (): Promise<boolean> | undefined => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
			return undefined;
		}
		return clearSessionContext();
	};
	// /fresh rotates provider stream state (fresh RPC) — same busy boundary as
	// /clear, so it gets the same client-side guard.
	const freshGuarded = (): Promise<void> | undefined => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
			return undefined;
		}
		return freshProviderStateFromGui();
	};
	add({
		name: "new",
		label: t("cmd.new"),
		description: t("cmd.new.desc"),
		category: "session",
		shortcut: "⌘N",
		affordance: { kind: "action", run: () => newSessionGuarded() },
	});
	add({
		name: "new-tab",
		label: t("cmd.newTab"),
		description: t("cmd.newTab.desc"),
		category: "session",
		shortcut: "⌘T",
		affordance: { kind: "action", run: () => useTabsStore.getState().openTab() },
	});
	add({
		name: "clear",
		label: t("cmd.clear"),
		description: t("cmd.clear.desc"),
		category: "session",
		affordance: { kind: "action", run: () => clearContextGuarded() },
	});
	add({
		name: "resume",
		label: t("cmd.resume"),
		description: t("cmd.resume.desc"),
		category: "session",
		affordance: { kind: "picker", open: ctx.openSessionPicker },
	});
	add({
		name: "session",
		label: t("cmd.session"),
		description: t("cmd.session.desc"),
		category: "session",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "session info",
					label: t("cmd.session.info"),
					category: "extensions",
					affordance: { kind: "window", open: ctx.openSessionInfo },
				},
				// /session delete + /session pin stay forwarded — need dedicated RPC (P1).
				sub("session delete", "/session delete"),
				sub("session pin", "/session pin ", "[account]"),
			],
		},
	});
	add({
		name: "rename",
		label: t("cmd.rename"),
		description: t("cmd.rename.desc"),
		category: "session",
		affordance: { kind: "picker", open: ctx.openRenameDialog },
	});
	add({
		name: "export",
		label: t("cmd.export"),
		description: t("cmd.export.desc"),
		category: "session",
		affordance: { kind: "action", run: () => exportSessionHtml() },
	});
	add({
		name: "dump",
		label: t("cmd.dump"),
		description: t("cmd.dump.desc"),
		category: "session",
		affordance: { kind: "action", run: () => dumpTranscriptToClipboard() },
	});
	add({
		name: "fork",
		label: t("cmd.fork"),
		description: t("cmd.fork.desc"),
		category: "session",
		affordance: { kind: "action", run: () => ctx.forkSession() },
	});
	add({
		name: "delete",
		aliases: ["drop"],
		label: t("cmd.delete"),
		description: t("cmd.drop.desc"),
		category: "session",
		affordance: { kind: "action", run: dropSessionFromGui },
	});
	add({
		name: "close",
		label: t("cmd.close"),
		description: t("cmd.close.desc"),
		category: "session",
		affordance: { kind: "action", run: () => window.close() },
	});
	add({
		name: "restart",
		label: t("cmd.restart"),
		description: t("cmd.restart.desc"),
		category: "other",
		affordance: { kind: "action", run: restartSidecar },
	});
	add({
		// `window.close()` used to hide behind this name, which left every other
		// window (and its running agents) open while reporting the app as quit.
		name: "quit",
		aliases: ["exit"],
		label: t("cmd.quit"),
		description: t("cmd.quit.desc"),
		category: "session",
		affordance: { kind: "action", run: () => window.omp.app.quit() },
	});
	add({
		name: "retry",
		label: t("cmd.retry"),
		description: t("cmd.retry.desc"),
		category: "session",
		shortcut: "⌥R",
		affordance: { kind: "action", run: () => ctx.retryTurn() },
	});
	add({
		name: "resend",
		label: t("cmd.resend"),
		description: t("cmd.resend.desc"),
		category: "session",
		affordance: { kind: "action", run: () => ctx.retryLastTurn() },
	});
	// /queue focuses the composer prefilled with the yield-queue shorthand
	// ("-> ") via the same omp:fill-composer channel the starter cards and the
	// session-tree draft restore use — the composer submits the queue over RPC.
	add({
		name: "queue",
		label: t("cmd.queue"),
		description: t("cmd.queue.desc"),
		category: "session",
		affordance: { kind: "action", run: () => prefillQueueShorthand() },
	});

	// ═══════════════════════════════════════════════════════════════════
	// MODEL
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "model",
		label: t("cmd.model"),
		description: t("cmd.model.desc"),
		category: "model",
		aliases: ["models"],
		affordance: { kind: "picker", open: ctx.openModelPicker },
	});
	add({
		name: "switch",
		label: t("cmd.switch"),
		description: t("cmd.switch.desc"),
		category: "model",
		affordance: { kind: "picker", open: ctx.openModelPicker },
	});
	add({
		name: "model cycle",
		label: t("cmd.model.cycle"),
		description: t("cmd.model.cycle.desc"),
		category: "model",
		shortcut: "⌃P",
		affordance: { kind: "action", run: () => ctx.rpc.cycleModel() },
	});
	add({
		name: "thinking cycle",
		label: t("cmd.thinking.cycle"),
		description: t("cmd.thinking.cycle.desc"),
		category: "model",
		shortcut: "⇧Tab",
		affordance: { kind: "action", run: () => ctx.rpc.cycleThinkingLevel() },
	});
	add({
		name: "fast",
		label: t("cmd.fast"),
		description: t("cmd.fast.desc"),
		category: "model",
		affordance: {
			kind: "toggle",
			get: () => ctx.fastModeEnabled,
			set: e =>
				runSessionCommand(ctx.rpc.setFastMode(e), "Fast mode", data => {
					const d = data as { enabled?: boolean; active?: boolean } | undefined;
					useModelStore.setState({ fastModeEnabled: d?.enabled ?? e, fastModeActive: d?.active ?? false });
				}),
		},
	});
	add({
		name: "prewalk",
		label: t("cmd.prewalk"),
		description: t("cmd.prewalk.desc"),
		category: "model",
		affordance: {
			kind: "toggle",
			get: () => ctx.prewalkArmed,
			set: e =>
				runSessionCommand(ctx.rpc.setPrewalk(e), t("cmd.prewalk"), data => {
					const d = data as { enabled?: boolean } | undefined;
					useSessionStore.setState({ prewalkArmed: d?.enabled ?? e });
				}),
		},
	});
	add({
		name: "advisor",
		label: t("cmd.advisor"),
		description: t("cmd.advisor.desc"),
		category: "model",
		affordance: {
			kind: "submenu",
			items: [
				subAction("advisor on", () => setAdvisor(true)),
				subAction("advisor off", () => setAdvisor(false)),
				// Text reports stay forwarded until a structured RPC exists (contract).
				sub("advisor status", "/advisor status"),
				sub("advisor dump", "/advisor dump"),
			],
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// CONTEXT
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "compact",
		label: t("cmd.compact"),
		description: t("cmd.compact.desc"),
		category: "context",
		affordance: {
			kind: "action",
			run: async () => {
				const res = await ctx.rpc.compact();
				if (!res.success) throw new Error(res.error);
				await ctx.hydrateSession();
				toast({ variant: "success", title: t("command.compactedTitle"), message: t("command.compactedMessage") });
			},
		},
	});
	add({
		name: "shake",
		label: t("cmd.shake"),
		description: t("cmd.shake.desc"),
		category: "context",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "shake elide",
					label: t("cmd.shake.elide"),
					category: "extensions",
					affordance: { kind: "action", run: () => shakeContextFromGui("elide") },
				},
				{
					name: "shake images",
					label: t("cmd.shake.images"),
					category: "extensions",
					affordance: { kind: "action", run: () => shakeContextFromGui("images") },
				},
				{
					name: "shake thinking",
					label: t("cmd.shake.thinking"),
					category: "extensions",
					affordance: { kind: "action", run: () => shakeContextFromGui("thinking") },
				},
			],
		},
	});
	add({
		name: "auto-compact",
		label: t("cmd.autoCompact"),
		description: t("cmd.autoCompact.desc"),
		category: "context",
		affordance: {
			kind: "toggle",
			get: () => ctx.autoCompaction,
			set: e =>
				runSessionCommand(ctx.rpc.setAutoCompaction(e), "Auto-compaction", data =>
					useSettingsStore
						.getState()
						.update({ autoCompaction: (data as { enabled?: boolean } | undefined)?.enabled ?? e }),
				),
		},
	});
	add({
		name: "auto-retry",
		label: t("cmd.autoRetry"),
		description: t("cmd.autoRetry.desc"),
		category: "context",
		affordance: {
			kind: "toggle",
			get: () => ctx.autoRetry,
			set: e =>
				runSessionCommand(ctx.rpc.setAutoRetry(e), "Auto-retry", data =>
					useSettingsStore
						.getState()
						.update({ autoRetry: (data as { enabled?: boolean } | undefined)?.enabled ?? e }),
				),
		},
	});
	add({
		name: "fresh",
		label: t("cmd.fresh"),
		description: t("cmd.fresh.desc"),
		category: "context",
		affordance: { kind: "action", run: () => freshGuarded() },
	});

	add({
		name: "todo",
		label: t("cmd.todo"),
		description: t("cmd.todo.desc"),
		category: "tools",
		affordance: {
			kind: "submenu",
			items: [
				subAction("todo edit", () => {
					// The dock card self-hides with no todos — say so instead of no-oping.
					const hasTodos = useTodoStore.getState().phases.some(phase => phase.tasks.length > 0);
					if (!hasTodos) {
						toast({ variant: "info", message: translate("todoPanel.empty") });
						return;
					}
					ctx.focusDockCard("todo");
				}),
				subAction("todo copy", () => copyTodosToClipboard()),
				subAction("todo export", () => exportTodos()),
				subAction("todo import", () => importTodosFromFile()),
			],
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// PROVIDERS
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "providers",
		label: t("cmd.providers"),
		description: t("cmd.providers.desc"),
		category: "providers",
		aliases: ["setup"],
		affordance: { kind: "window", open: ctx.openProviders },
	});

	// ═══════════════════════════════════════════════════════════════════
	// VIEW
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "theme",
		label: t("cmd.theme"),
		description: t("cmd.theme.desc"),
		category: "view",
		affordance: { kind: "picker", open: ctx.openThemePicker },
	});
	add({
		name: "settings",
		label: t("cmd.settings"),
		description: t("cmd.settings.desc"),
		category: "view",
		shortcut: "⌘,",
		affordance: { kind: "window", open: ctx.openSettings },
	});
	add({
		name: "jobs",
		label: t("cmd.jobs"),
		description: t("cmd.jobs.desc"),
		category: "view",
		affordance: { kind: "window", open: () => useUiStore.getState().openJobs() },
	});
	add({
		name: "changelog",
		label: t("cmd.changelog"),
		description: t("cmd.changelog.desc"),
		category: "view",
		affordance: { kind: "window", open: () => useUiStore.getState().openChangelog() },
	});
	add({
		name: "copy",
		label: t("cmd.copy"),
		description: t("cmd.copy.desc"),
		category: "view",
		affordance: { kind: "action", run: args => copyFromChat(args) },
	});
	add({
		name: "hotkeys",
		label: t("cmd.hotkeys"),
		description: t("cmd.hotkeys.desc"),
		category: "view",
		affordance: { kind: "window", open: () => ctx.openHotkeys() },
	});
	add({
		name: "agents",
		label: t("cmd.agents"),
		description: t("cmd.agents.desc"),
		category: "view",
		affordance: { kind: "window", open: () => ctx.openAgentHub() },
	});
	add({
		name: "hub",
		label: t("cmd.hub"),
		description: t("cmd.hub.desc"),
		category: "view",
		affordance: { kind: "window", open: () => ctx.openAgentHub("hub") },
	});

	// ═══════════════════════════════════════════════════════════════════
	// NATIVE INTERACTIVE SURFACES
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "btw",
		label: t("cmd.btw"),
		description: t("cmd.btw.desc"),
		category: "other",
		affordance: {
			kind: "action",
			argUsage: "<question>",
			run: question => {
				const trimmed = question?.trim();
				if (!trimmed) {
					toast({ variant: "info", message: translate("btw.usage") });
					return;
				}
				useUiStore.getState().openBtw(trimmed);
			},
		},
	});
	add({
		name: "tan",
		label: t("cmd.tan"),
		description: t("cmd.tan.desc"),
		category: "other",
		affordance: { kind: "action", argUsage: "<work>", run: work => dispatchTan(work) },
	});
	add({
		name: "omfg",
		label: t("cmd.omfg"),
		description: t("cmd.omfg.desc"),
		category: "other",
		affordance: { kind: "action", argUsage: "<complaint>", run: complaint => forgeTtsrRule(complaint) },
	});
	add({
		name: "pause",
		label: t("cmd.pause"),
		description: t("cmd.pause.desc"),
		category: "other",
		affordance: {
			kind: "toggle",
			get: () => useSessionStore.getState().agentsPaused,
			set: async enabled => {
				await runSessionCommand(boundRpc.setAgentsPaused(enabled), t("cmd.pause"), data => {
					const state = data as { paused: boolean; pausedAt?: number };
					useSessionStore.setState({ agentsPaused: state.paused, agentsPausedAt: state.pausedAt ?? null });
				});
			},
		},
	});

	// Merge sidecar-advertised commands not already covered. A name claimed by
	// a native item — as its name OR one of its aliases — is dropped: `/models`
	// and `/modes` must not appear as dead rows next to the working picker.
	for (const cmd of ctx.availableCommands) {
		if (claimed.has(cmd.name) || HIDDEN_ACCOUNT_COMMANDS.has(cmd.name) || REMOVED_COMMANDS.has(cmd.name)) continue;
		// Keep terminal-only commands visible as disabled rows. The palette is
		// the GUI's command index; hiding a command makes its client limitation opaque.
		if (cmd.textModeExecutable === false) {
			add({
				name: cmd.name,
				label: `/${cmd.name}`,
				description: cmd.description,
				category: "other",
				affordance: { kind: "unavailable", reason: t("palette.tuiOnly") },
			});
			continue;
		}
		add({
			name: cmd.name,
			label: `/${cmd.name}`,
			description: cmd.description,
			category: "other",
			affordance: p(`/${cmd.name}${cmd.input?.hint ? " " : ""}`, cmd.input?.hint),
		});
	}

	return items;
}

/** Hand text to the composer and focus it (the omp:fill-composer channel also
 *  serves starter cards, dequeue restore, and session-tree restore). */
export function prefillComposer(text: string): void {
	window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text } }));
}

/** /queue prefill: focus the composer with the yield-queue shorthand ("-> "). */
function prefillQueueShorthand(): void {
	prefillComposer("-> ");
}

/**
 * The composer text a palette row needs from the user, or null when the row can
 * run as-is. The palette has no argument entry, so a parameterized command
 * returns its own slash form for the composer instead of being dispatched
 * without its argument (which only ever produced a `Usage:` reply).
 */
export function commandArgPrefill(item: CommandMenuItem): string | null {
	const affordance = item.affordance;
	if (affordance.kind === "prompt") return affordance.argUsage === undefined ? null : affordance.text;
	if (affordance.kind === "action") return affordance.argUsage === undefined ? null : `/${item.name} `;
	return null;
}

/** /shake elide|images|thinking: confirm, then drop context via shake_context RPC;
 *  the toast carries the agent's removed summary. */
async function shakeContextFromGui(mode: "elide" | "images" | "thinking"): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const confirmKey =
		mode === "images" ? "shake.confirmImages" : mode === "thinking" ? "shake.confirmThinking" : "shake.confirmElide";
	if (!window.confirm(translate(confirmKey))) return;
	const response = await rpc.shakeContext(mode);
	if (!response.success) {
		toast({ variant: "error", title: translate("cmd.shake"), message: response.error });
		return;
	}
	const removed = (response.data as { removed?: string } | undefined)?.removed;
	toast({ variant: "success", title: translate("cmd.shake"), message: removed ?? translate("shake.success") });
}

/** /fresh: rotate provider stream state via the fresh RPC; the server's busy
 *  refusal (mid-stream) rides a warning toast instead of failing hard. */
async function freshProviderStateFromGui(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const response = await rpc.fresh();
	if (!response.success) {
		toast({ variant: "warning", message: response.error });
		return;
	}
	toast({ variant: "success", message: translate("fresh.success") });
}

async function copyFromChat(args?: string): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const kind = args?.trim().toLowerCase();
	if (!kind) {
		useUiStore.getState().openCopySelector();
		return;
	}
	if (kind !== "code" && kind !== "cmd" && kind !== "command") {
		toast({ variant: "info", message: translate("copySelector.usage") });
		return;
	}
	const response = await rpc.getCopyTargets();
	if (!response.success) throw new Error(response.error);
	const targets = (response.data as { targets?: CopyTarget[] } | undefined)?.targets ?? [];
	let target: CopyTarget | undefined;
	if (kind === "code") {
		for (const root of targets) {
			const blocks = root.children?.filter(child => child.id.includes(":code:"));
			if (blocks?.length) {
				target = blocks[blocks.length - 1];
				break;
			}
		}
	} else {
		target = targets.find(candidate => candidate.id.startsWith("cmd:"));
	}
	if (target?.content === undefined) {
		toast({
			variant: "info",
			message: translate(kind === "code" ? "copySelector.noCode" : "copySelector.noCommand"),
		});
		return;
	}
	if (!(await copyText(target.content))) throw new Error(translate("copySelector.failed"));
	toast({ variant: "success", message: target.copyMessage ?? translate("copySelector.copied") });
}

async function dispatchTan(work?: string): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const trimmed = work?.trim();
	if (!trimmed) {
		toast({ variant: "info", message: translate("tan.usage") });
		return;
	}
	const response = await rpc.tan(trimmed);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { jobId?: string } | undefined;
	toast({ variant: "success", message: translate("tan.dispatched", { id: data?.jobId ?? "" }) });
	if (runtime) await hydrateTabSession(runtime.tabId);
	else await hydrateSession();
}

async function forgeTtsrRule(complaint?: string): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const trimmed = complaint?.trim();
	if (!trimmed) {
		toast({ variant: "info", message: translate("omfg.usage") });
		return;
	}
	const response = await rpc.omfg(trimmed);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { state?: "saved" | "rejected" | "aborted"; savedPath?: string } | undefined;
	if (data?.state === "saved") {
		toast({ variant: "success", message: translate("omfg.saved", { path: data.savedPath ?? "" }) });
	} else {
		toast({ variant: "info", message: translate(data?.state === "rejected" ? "omfg.rejected" : "omfg.aborted") });
	}
}

export async function retryFailedTurn(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const response = await rpc.retry();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { retried?: boolean } | undefined;
	if (!data?.retried) {
		toast({
			variant: "warning",
			title: translate("palette.retryNothing"),
			message: translate("palette.retryNothingDesc"),
		});
	}
}

export async function dropSessionFromGui(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	if (!window.confirm(translate("drop.confirm"))) return;
	const response = await rpc.dropSession();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { cancelled?: boolean } | undefined;
	if (data?.cancelled) {
		toast({ variant: "info", message: translate("drop.cancelled") });
		return;
	}
	if (runtime) await hydrateTabSession(runtime.tabId);
	else await hydrateSession();
	toast({ variant: "success", message: translate("drop.success") });
}

export async function forkSessionFromGui(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const response = await rpc.fork();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { cancelled?: boolean } | undefined;
	if (data?.cancelled) {
		toast({ variant: "info", message: translate("fork.cancelled") });
		return;
	}
	if (runtime) await hydrateTabSession(runtime.tabId);
	else await hydrateSession();
	toast({ variant: "success", message: translate("fork.success") });
}

/**
 * Build the same canonical affordance list used by CommandPalette from the
 * live stores. Non-component submit paths use this to execute GUI-native
 * builtins instead of forwarding TUI-only command text to the model.
 */
export function buildCurrentCommandMenu(availableCommands: AvailableCommand[]): CommandMenuItem[] {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const session = useSessionStore.getState();
	const model = useModelStore.getState();
	const settings = useSettingsStore.getState();
	const ui = useUiStore.getState();
	return buildCommandMenu({
		t: translate,
		tabKind: activeTabKind(),
		isStreaming: session.isStreaming,
		fastModeEnabled: model.fastModeEnabled,
		autoCompaction: settings.autoCompaction,
		autoRetry: settings.autoRetry,
		steeringMode: settings.steeringMode,
		followUpMode: settings.followUpMode,
		interruptMode: settings.interruptMode,
		planModeEnabled: session.planModeEnabled,
		prewalkArmed: session.prewalkArmed,
		availableCommands,
		openModelPicker: ui.openModelPicker,
		openSettings: ui.openSettings,
		openProviders: ui.openProviders,
		openCommandPalette: ui.openCommandPalette,
		openRenameDialog: ui.openRenameDialog,
		openSessionPicker: ui.openSessionPicker,
		openSessionInfo: ui.openSessionInfo,
		openThemePicker: ui.openThemePicker,
		openAgentHub: ui.openAgentHub,
		openHotkeys: ui.openHotkeys,
		focusDockCard: ui.focusDockCard,
		retryTurn: retryFailedTurn,
		retryLastTurn: () =>
			retryLastTurnShared(() =>
				toast({
					variant: "warning",
					title: translate("palette.retryNothing"),
					message: translate("palette.retryNothingDesc"),
				}),
			),
		forkSession: forkSessionFromGui,
		hydrateSession: () => (runtime ? hydrateTabSession(runtime.tabId) : hydrateSession()),
		rpc: {
			setFastMode: enabled => rpc.setFastMode(enabled),
			setAutoCompaction: enabled => rpc.setAutoCompaction(enabled),
			setAutoRetry: enabled => rpc.setAutoRetry(enabled),
			setSteeringMode: mode => rpc.setSteeringMode(mode),
			setFollowUpMode: mode => rpc.setFollowUpMode(mode),
			setInterruptMode: mode => rpc.setInterruptMode(mode),
			compact: instructions => rpc.compact(instructions),
			newSession: async () => {
				return newSessionNow();
			},
			prompt: message => rpc.prompt(message),
			setPlanMode: enabled => rpc.setPlanMode(enabled),
			setPrewalk: enabled => rpc.setPrewalk(enabled),
			exportHtml: path => rpc.exportHtml(path),
			setSessionName: name => rpc.setSessionName(name),
			cycleModel: () => cycleAllowedModel(rpc),
			cycleThinkingLevel: () => rpc.cycleThinkingLevel(),
		},
	});
}

export function groupByCategory(items: CommandMenuItem[]): Map<CommandCategory, CommandMenuItem[]> {
	const groups = new Map<CommandCategory, CommandMenuItem[]>();
	for (const item of items) {
		const list = groups.get(item.category) ?? [];
		list.push(item);
		groups.set(item.category, list);
	}
	return groups;
}
