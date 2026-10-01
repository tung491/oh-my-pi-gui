/**
 * The chat window's half of quick entry: claim what main queued, open one new
 * tab per prompt, and hand each prompt to its own tab's composer. Only the
 * visible tab mounts a composer, so prompts go one at a time, and a prompt
 * that never reached a composer goes back to the bar instead of vanishing.
 */

import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSpawnTabResult, IpcTabInfo, QuickEntryPrompt } from "../../shared/ipc-types";
import type { RpcResponse } from "../../shared/rpc-types";
import type { ComposerStore } from "../stores/composer";
import { useComposerStore } from "../stores/composer";
import { useSessionStore } from "../stores/session";
import { sessionRuntimeStore } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useToastStore } from "../stores/toast";
import { translate } from "./i18n";
import { drainQuickEntry, QUICK_ENTRY_HANDOFF_CEILING_MS, quickEntryTabArgs } from "./quick-entry-delivery";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, { document, window, Event, HTMLElement, Node });

const ok = (data: unknown): RpcResponse => ({ type: "response", command: "test", success: true, data });

interface QuickEntryStub {
	claimPending: Mock<() => Promise<QuickEntryPrompt[]>>;
	ack: Mock<(id: string) => Promise<void>>;
	returnToBar: Mock<(prompt: QuickEntryPrompt, reason: string) => Promise<void>>;
}

let quickEntry: QuickEntryStub;
let spawn: Mock<() => Promise<IpcSpawnTabResult | null>>;
let list: Mock<() => Promise<IpcTabInfo[]>>;

const prompt = (id: string, target: QuickEntryPrompt["target"] = { kind: "chat" }): QuickEntryPrompt => ({
	id,
	text: `text ${id}`,
	target,
});

/** main's queue: each claim hands out the next batch, then nothing. */
function queueBatches(...batches: QuickEntryPrompt[][]): void {
	for (const batch of batches) quickEntry.claimPending.mockResolvedValueOnce(batch);
	quickEntry.claimPending.mockResolvedValue([]);
}

function composerOf(tabId: string) {
	const composer = sessionRuntimeStore<ComposerStore>(tabId, "composer");
	if (!composer) throw new Error(`no composer for ${tabId}`);
	return composer;
}

/** What InputArea does once the tab is ready: clear the flag (and ack, here not needed). */
function handOff(tabId: string): void {
	composerOf(tabId).getState().clearAutoSubmit();
}

beforeEach(async () => {
	quickEntry = {
		claimPending: vi.fn(async () => []),
		ack: vi.fn(async () => {}),
		returnToBar: vi.fn(async () => {}),
	};
	spawn = vi.fn(async () => null);
	list = vi.fn(async () => [{ tabId: "t0", cwd: "/alpha", status: "ready", kind: "agent" }]);
	(window as unknown as Record<string, unknown>).omp = {
		quickEntry,
		tabs: { list, spawn, close: vi.fn(async () => true), setActive: vi.fn(async () => true) },
		rpc: {
			getState: vi.fn(async () => ok({ sessionId: "srv", cwd: "/srv", isStreaming: false, todoPhases: [] })),
			getTranscript: vi.fn(async () => ok({ messages: [] })),
			getSubagents: vi.fn(async () => ok({ subagents: [] })),
			getGoal: vi.fn(async () => ok({ enabled: false })),
			getLoopMode: vi.fn(async () => ok({ enabled: false, state: "off" })),
			getVibeMode: vi.fn(async () => ok({ enabled: false })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			setSubagentSubscription: vi.fn(async () => ok({})),
		},
	};
});

afterEach(() => {
	vi.useRealTimers();
	useTabsStore.getState().reset();
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	vi.restoreAllMocks();
});

describe("quick-entry tab arguments", () => {
	it("uses the existing new-chat, Work and workspace shapes", () => {
		expect(quickEntryTabArgs({ kind: "chat" })).toEqual({ kind: "chat" });
		expect(quickEntryTabArgs({ kind: "work" })).toEqual({ kind: "agent", work: true });
		expect(quickEntryTabArgs({ kind: "workspace", cwd: "/w" })).toEqual({ kind: "agent", cwd: "/w" });
	});
});

describe("quick-entry delivery", () => {
	it("waits for boot reconciliation before claiming", async () => {
		const drain = drainQuickEntry();
		await Promise.resolve();
		await Promise.resolve();
		expect(quickEntry.claimPending).not.toHaveBeenCalled();

		await useTabsStore.getState().reconcileTabs();
		await drain;
		expect(quickEntry.claimPending).toHaveBeenCalled();
	});

	it("opens the second tab only after the first prompt was handed off", async () => {
		await useTabsStore.getState().reconcileTabs();
		queueBatches([prompt("a"), prompt("b", { kind: "workspace", cwd: "/beta" })]);
		spawn.mockResolvedValueOnce({ tabId: "t1" }).mockResolvedValueOnce({ tabId: "t2", cwd: "/beta" });

		const drain = drainQuickEntry();
		await vi.waitFor(() => expect(composerOf("t1").getState().autoSubmit).toEqual({ id: "a" }));
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(composerOf("t1").getState().draft).toBe("text a");

		handOff("t1");
		await vi.waitFor(() => expect(composerOf("t2").getState().autoSubmit).toEqual({ id: "b" }));
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/beta", kind: "agent" }));
		expect(composerOf("t2").getState().draft).toBe("text b");
		expect(composerOf("t1").getState().draft).toBe("text a");

		handOff("t2");
		await drain;
		expect(quickEntry.returnToBar).not.toHaveBeenCalled();
		expect(quickEntry.claimPending).toHaveBeenCalledTimes(2);
	});

	it("returns a prompt refused at the tab cap, and one whose spawn failed", async () => {
		await useTabsStore.getState().reconcileTabs();
		queueBatches([prompt("cap"), prompt("boom")]);
		spawn.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("spawn failed"));

		await drainQuickEntry();

		expect(quickEntry.returnToBar.mock.calls).toEqual([
			[prompt("cap"), "tab-cap"],
			[prompt("boom"), "tab-failed"],
		]);
		expect(
			useToastStore.getState().toasts.some(entry => entry.message === translate("quickEntry.toast.returned")),
		).toBe(true);
	});

	it("returns a prompt whose tab closed before the hand-off", async () => {
		await useTabsStore.getState().reconcileTabs();
		queueBatches([prompt("a")]);
		spawn.mockResolvedValueOnce({ tabId: "t1" });

		const drain = drainQuickEntry();
		await vi.waitFor(() => expect(composerOf("t1").getState().autoSubmit).toEqual({ id: "a" }));
		await useTabsStore.getState().closeTab("t1");
		await drain;

		expect(quickEntry.returnToBar).toHaveBeenCalledWith(prompt("a"), "interrupted");
		expect(quickEntry.ack).not.toHaveBeenCalled();
	});

	it("leaves the text in a tab that never became ready, and acknowledges it", async () => {
		vi.useFakeTimers();
		await useTabsStore.getState().reconcileTabs();
		queueBatches([prompt("slow")]);
		spawn.mockResolvedValueOnce({ tabId: "t1" });

		const drain = drainQuickEntry();
		for (let i = 0; i < 20 && !sessionRuntimeStore<ComposerStore>("t1", "composer")?.getState().autoSubmit; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(composerOf("t1").getState().autoSubmit).toEqual({ id: "slow" });
		await vi.advanceTimersByTimeAsync(QUICK_ENTRY_HANDOFF_CEILING_MS);
		await drain;

		expect(quickEntry.ack).toHaveBeenCalledWith("slow");
		expect(quickEntry.returnToBar).not.toHaveBeenCalled();
		expect(composerOf("t1").getState().draft).toBe("text slow");
		expect(composerOf("t1").getState().autoSubmit).toBeNull();
		expect(
			useToastStore.getState().toasts.some(entry => entry.message === translate("quickEntry.toast.leftInTab")),
		).toBe(true);
	});

	it("delivers each prompt once when nudged during a drain", async () => {
		await useTabsStore.getState().reconcileTabs();
		queueBatches([prompt("a")]);
		spawn.mockResolvedValueOnce({ tabId: "t1" });

		const first = drainQuickEntry();
		await vi.waitFor(() => expect(composerOf("t1").getState().autoSubmit).toEqual({ id: "a" }));
		expect(drainQuickEntry()).toBe(first);
		handOff("t1");
		await first;

		expect(spawn).toHaveBeenCalledTimes(1);
		// The nudge made the drain claim once more before ending.
		expect(quickEntry.claimPending).toHaveBeenCalledTimes(3);
	});
});
