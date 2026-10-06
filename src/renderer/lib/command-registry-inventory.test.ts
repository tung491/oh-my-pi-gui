/**
 * Command inventory for the everyday-work assistant: developer-only commands
 * are gone from the palette, and a deleted GUI command never comes back as
 * the sidecar's own advertised command (`/share` would upload the session).
 * The kept core (new task, settings, providers, agents, model, theme…) stays.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AvailableCommand } from "../../shared/rpc-types";
import { buildCommandMenu, type CommandMenuItem, type CommandRegistryContext } from "./command-registry";
import { translate } from "./i18n";

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

const baseCtx: CommandRegistryContext = {
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
	openAgentHub: () => {},
	openPrCenter: () => {},
	openHotkeys: () => {},
	focusDockCard: () => {},
	retryTurn: async () => {},
	retryLastTurn: async () => {},
	forkSession: async () => {},
	hydrateSession: async () => {},
	rpc: {
		setFastMode: async () => ok(),
		setAutoCompaction: async () => ok(),
		setAutoRetry: async () => ok(),
		setSteeringMode: async () => {},
		setFollowUpMode: async () => {},
		setInterruptMode: async () => {},
		compact: async () => ok(),
		newSession: async () => {},
		handoff: async () => {},
		prompt: async () => {},
		setPlanMode: async () => ok(),
		setPrewalk: async () => ok({ enabled: true }),
		exportHtml: async () => {},
		setSessionName: async () => {},
		cycleModel: async () => {},
		cycleThinkingLevel: async () => {},
	},
};

const DELETED_COMMANDS = [
	"new-chat-tab",
	"import",
	"handoff",
	"share",
	"branch",
	"tree",
	"model-roles",
	"model-compare",
	"benchmark",
	"context",
	"tools",
	"computer",
	"browser",
	"force",
	"usage",
	"skills",
	"hooks",
	"commands",
	"mcp",
	"mcp panel",
	"mcp list",
	"marketplace",
	"marketplace panel",
	"marketplace list",
	"marketplace installed",
	"plugins",
	"plugins panel",
	"reload-plugins",
	"memory",
	"memory panel",
	"security",
	"templates",
	"ssh",
	"plan",
	"vibe",
	"goal",
	"loop",
	"modes",
	"move",
	"add-dir",
	"remove-dir",
	"dirs",
	"git",
	"stats",
	"extensions",
	"prs",
	"collab",
	"join",
	"leave",
	"debug",
	"live",
	"plan-review",
	"guided-goal",
];

const KEPT_COMMANDS = [
	"new",
	"new-tab",
	"settings",
	"providers",
	"agents",
	"hub",
	"jobs",
	"model",
	"theme",
	"hotkeys",
	"quit",
];

function flattenNames(items: CommandMenuItem[]): string[] {
	return items.flatMap(item => [
		item.name,
		...(item.affordance.kind === "submenu" ? flattenNames(item.affordance.items) : []),
	]);
}

beforeEach(() => {
	(globalThis as Record<string, unknown>).window = { omp: { rpc: {} } };
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).window;
});

describe("command inventory", () => {
	const advertised: AvailableCommand[] = DELETED_COMMANDS.map(name => ({
		name,
		description: "x",
		textModeExecutable: true,
	}));

	it("drops every deleted command, GUI-owned and sidecar-advertised alike", () => {
		const names = flattenNames(buildCommandMenu({ ...baseCtx, availableCommands: advertised }));
		expect(DELETED_COMMANDS.filter(name => names.includes(name))).toEqual([]);
	});

	it("keeps the everyday commands", () => {
		const names = flattenNames(buildCommandMenu({ ...baseCtx, availableCommands: advertised }));
		expect(KEPT_COMMANDS.filter(name => !names.includes(name))).toEqual([]);
	});
});
