/**
 * Plan mode has no surface in the assistant: nothing shows a plan proposal or
 * lets the person leave the read-only planning state. The agent can still
 * come back armed (a resumed session journal, or a config that starts in plan
 * mode), so hydration turns it off through the session's own command channel
 * and the store follows the agent's answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { SessionStore } from "../stores/session";
import { useSessionStore } from "../stores/session";
import { sessionRuntimeStore, setFocusedSessionRuntime } from "../stores/session-runtime-context";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { useTabsStore } from "../stores/tabs";
import { hydrateSession, hydrateTabSession } from "./session-hydration";

function success(data: unknown, command = "test"): RpcResponse {
	return { type: "response", command, success: true, data };
}

function sessionState(planModeEnabled: boolean) {
	return {
		sessionId: "s1",
		sessionName: null,
		sessionFile: null,
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		contextUsage: null,
		messageCount: 0,
		queuedMessageCount: 0,
		planModeEnabled,
		todoPhases: [],
	};
}

function answer(command: RpcCommand, planModeEnabled: boolean): RpcResponse {
	switch (command.type) {
		case "get_state":
			return success(sessionState(planModeEnabled));
		case "get_transcript":
			return success({ messages: [] });
		case "get_subagents":
			return success({ subagents: [] });
		case "get_goal":
		case "get_vibe_mode":
			return success({ enabled: false });
		case "get_queue":
			return success({ steering: [], followUp: [] });
		case "get_settings":
			return success({ values: {} });
		case "set_plan_mode":
			return success({ enabled: command.enabled }, "set_plan_mode");
		default:
			return success({});
	}
}

function installTabRoutedOmp(planModeEnabled: boolean) {
	const commandForTab = vi.fn(async (_tabId: string, command: RpcCommand) => answer(command, planModeEnabled));
	(globalThis as Record<string, unknown>).window = { omp: { rpc: { commandForTab } } };
	return commandForTab;
}

function seedTab(tabId: string): void {
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: tabId, cwd: "/tmp", status: "ready", unreadDone: false }],
		activeTabId: tabId,
	});
	ensureTabRuntime(tabId);
	setFocusedSessionRuntime(tabId);
}

function planModeCommands(calls: ReadonlyArray<readonly [string, RpcCommand, ...unknown[]]>): RpcCommand[] {
	return calls.map(call => call[1]).filter(command => command.type === "set_plan_mode");
}

afterEach(() => {
	setFocusedSessionRuntime(null);
	useTabsStore.getState().reset();
	useSessionStore.getState().reset();
	delete (globalThis as Record<string, unknown>).window;
	vi.restoreAllMocks();
});

describe("session hydration plan mode", () => {
	it("disarms a resumed plan-mode session at ready", async () => {
		const commandForTab = installTabRoutedOmp(true);
		seedTab("t-plan");

		await hydrateTabSession("t-plan");

		expect(planModeCommands(commandForTab.mock.calls)).toEqual([{ type: "set_plan_mode", enabled: false }]);
		expect(sessionRuntimeStore<SessionStore>("t-plan", "session")?.getState().planModeEnabled).toBe(false);
	});

	it("sends no plan command when the session is not in plan mode", async () => {
		const commandForTab = installTabRoutedOmp(false);
		seedTab("t-plain");

		await hydrateTabSession("t-plain");

		expect(planModeCommands(commandForTab.mock.calls)).toEqual([]);
		expect(sessionRuntimeStore<SessionStore>("t-plain", "session")?.getState().planModeEnabled).toBe(false);
	});

	it("disarms plan mode on the window-level session too", async () => {
		const setPlanMode = vi.fn(async (enabled: boolean) => success({ enabled }, "set_plan_mode"));
		const rpc = {
			getState: vi.fn(async () => success(sessionState(true))),
			getTranscript: vi.fn(async () => success({ messages: [] })),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
			getGoal: vi.fn(async () => success({ enabled: false })),
			getVibeMode: vi.fn(async () => success({ enabled: false })),
			getQueue: vi.fn(async () => success({ steering: [], followUp: [] })),
			getSettings: vi.fn(async () => success({ values: {} })),
			setSubagentSubscription: vi.fn(async () => success({})),
			setPlanMode,
		};
		(globalThis as Record<string, unknown>).window = { omp: { rpc } };

		await hydrateSession();

		expect(setPlanMode).toHaveBeenCalledTimes(1);
		expect(setPlanMode).toHaveBeenCalledWith(false);
		expect(useSessionStore.getState().planModeEnabled).toBe(false);
	});
});
