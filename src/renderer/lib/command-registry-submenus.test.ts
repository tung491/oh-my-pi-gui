/**
 * Nativization contract guard: the prompt-passthrough commands that gained
 * native GUI affordances (RPC actions, panels, dialogs) must never regress
 * to kind:"prompt", and the verbs covered by the contract's non-goals must
 * stay prompt. Exercises buildCommandMenu directly — no stores or RPC.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { useToastStore } from "../stores/toast";
import {
	buildCommandMenu,
	type CommandAffordance,
	type CommandMenuItem,
	type CommandRegistryContext,
} from "./command-registry";
import { translate } from "./i18n";

const ctx: CommandRegistryContext = {
	t: translate,
	tabKind: "agent",
	isStreaming: false,
	fastModeEnabled: false,
	autoCompaction: false,
	autoRetry: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	planModeEnabled: false,
	prewalkArmed: false,
	availableCommands: [],
	openModelPicker: () => {},
	openSettings: () => {},
	openProviders: () => {},
	openCommandPalette: () => {},
	openRenameDialog: () => {},
	openSessionPicker: () => {},
	openBranchPicker: () => {},
	openSessionTree: () => {},
	openSessionInfo: () => {},
	openHandoffDialog: () => {},
	openThemePicker: () => {},
	openModes: () => {},
	openAgentHub: () => {},
	openPrCenter: () => {},
	openHotkeys: () => {},
	focusDockCard: () => {},
	retryTurn: async () => {},
	retryLastTurn: async () => {},
	forkSession: async () => {},
	hydrateSession: async () => {},
	rpc: {
		setFastMode: async () => ({ type: "response", command: "set_fast_mode", success: true }),
		setAutoCompaction: async () => ({ type: "response", command: "set_auto_compaction", success: true }),
		setAutoRetry: async () => ({ type: "response", command: "set_auto_retry", success: true }),
		setSteeringMode: async () => {},
		setFollowUpMode: async () => {},
		setInterruptMode: async () => {},
		compact: async () => ({ type: "response", command: "compact", success: true }),
		newSession: async () => {},
		handoff: async () => {},
		prompt: async () => {},
		setPlanMode: async () => ({ type: "response", command: "set_plan_mode", success: true }),
		setPrewalk: async () => ({ type: "response", command: "set_prewalk", success: true }),
		exportHtml: async () => {},
		setSessionName: async () => {},
		cycleModel: async () => {},
		cycleThinkingLevel: async () => {},
	},
};

function affordanceOf(name: string): CommandAffordance {
	const items = buildCommandMenu(ctx);
	const [top, sub] = name.split(" ");
	const topItem = items.find(item => item.name === top);
	if (!topItem) throw new Error(`missing menu item: ${top}`);
	if (sub === undefined) return topItem.affordance;
	if (topItem.affordance.kind !== "submenu") throw new Error(`${top} is not a submenu`);
	const subItem = topItem.affordance.items.find((item: CommandMenuItem) => item.name === name);
	if (!subItem) throw new Error(`missing submenu item: ${name}`);
	return subItem.affordance;
}

describe("nativized command affordances", () => {
	it.each([
		["dump", "action"],
		["changelog", "window"],
		["queue", "action"],
		["prewalk", "toggle"],
		["shake elide", "action"],
		["shake images", "action"],
		["fresh", "action"],
		["advisor on", "action"],
		["advisor off", "action"],
		["todo edit", "action"],
		["todo copy", "action"],
		["todo export", "action"],
		["todo import", "action"],
	] as const)("%s is %s, never prompt", (name, kind) => {
		const affordance = affordanceOf(name);
		expect(affordance.kind).toBe(kind);
	});

	it.each(["advisor status", "advisor dump"] as const)("%s stays prompt per contract non-goals", name => {
		expect(affordanceOf(name).kind).toBe("prompt");
	});
});

describe("nativized action wiring", () => {
	const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });
	let rpc: Record<string, Mock>;
	let openSettings: Mock;
	let hydrateSession: Mock;
	let wiredCtx: CommandRegistryContext;

	const wired = (name: string): CommandAffordance => {
		const [top, sub] = name.split(" ");
		const topItem = buildCommandMenu(wiredCtx).find(item => item.name === top);
		if (!topItem) throw new Error(`missing menu item: ${top}`);
		if (sub === undefined) return topItem.affordance;
		if (topItem.affordance.kind !== "submenu") throw new Error(`${top} is not a submenu`);
		const item = topItem.affordance.items.find((candidate: CommandMenuItem) => candidate.name === name);
		if (!item) throw new Error(`missing submenu item: ${name}`);
		return item.affordance;
	};

	const lastToast = () => useToastStore.getState().toasts.at(-1);

	beforeEach(() => {
		rpc = {
			setSetting: vi.fn(async () => ok({ advisorEnabled: true, advisorActive: true })),
		};
		(globalThis as Record<string, unknown>).window = { omp: { rpc } };
		openSettings = vi.fn();
		hydrateSession = vi.fn(async () => {});
		wiredCtx = {
			...ctx,
			openSettings,
			hydrateSession,
		};
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		delete (globalThis as Record<string, unknown>).window;
	});

	it("advisor on writes advisor.enabled and reports activation state", async () => {
		const affordance = wired("advisor on");
		if (affordance.kind !== "action") throw new Error("expected action");
		await affordance.run();
		expect(rpc.setSetting).toHaveBeenCalledWith("advisor.enabled", true);
		expect(lastToast()?.variant).toBe("success");
		rpc.setSetting.mockResolvedValueOnce(ok({ advisorEnabled: true, advisorActive: false }));
		await affordance.run();
		expect(lastToast()?.variant).toBe("info");
	});
});
