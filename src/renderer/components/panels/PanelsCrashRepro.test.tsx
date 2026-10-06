/**
 * Reproduction: mounting the agents panel against RUNNING-state stores
 * (partial tool executions, live subagents) must not crash the renderer.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { useToolsStore } from "../../stores/tools";
import { AgentsDockCard } from "../chat/dock/AgentsDockCard";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// Minimal omp bridge: SubagentTranscript fetches transcripts on mount.
const getSubagentMessages = vi.fn(async () => ({
	type: "response",
	command: "get_subagent_messages",
	success: true,
	data: { messages: [] as AgentMessage[] },
}));
const ompWindow = window as unknown as { omp: { rpc: { getSubagentMessages: typeof getSubagentMessages } } };
ompWindow.omp = { rpc: { getSubagentMessages } };

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
	useMessagesStore.getState().reset();
	getSubagentMessages.mockClear();
	getSubagentMessages.mockResolvedValue({
		type: "response",
		command: "get_subagent_messages",
		success: true,
		data: { messages: [] },
	});
});

describe("panels under running state", () => {
	it("AgentsDockCard expands a transcript and switches to graph view", async () => {
		const snapshot: SubagentSnapshot = {
			id: "sub-1",
			agent: "scout",
			description: "Read-only research",
			assignment: "# Target\nRead every related source file and report the implementation details.",
			status: "started",
			index: 0,
			sessionFile: "/tmp/sub-1.jsonl",
			lastUpdate: Date.now(),
		};
		getSubagentMessages.mockResolvedValueOnce({
			type: "response",
			command: "get_subagent_messages",
			success: true,
			data: {
				messages: [{ role: "assistant", content: "Transcript loaded" }],
			},
		});
		useSubagentsStore.getState().setSnapshots([snapshot]);
		await mount(<AgentsDockCard />);
		expect(document.body.textContent).toContain("Read-only research");
		expect(document.body.textContent).not.toContain("# Target");

		const row = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("scout"));
		expect(row).toBeDefined();
		if (!row) return;
		await act(async () => {
			row.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();
		expect(getSubagentMessages).toHaveBeenCalledWith("sub-1", "/tmp/sub-1.jsonl", 0);
		expect(document.body.textContent).toContain("Transcript loaded");

		const graphButton = Array.from(document.querySelectorAll('button[aria-pressed="false"]')).at(-1);
		expect(graphButton).toBeDefined();
		if (!graphButton) return;
		await act(async () => {
			graphButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(graphButton.getAttribute("aria-pressed")).toBe("true");
		expect(document.querySelector('[role="tree"]')).toBeNull();
	});
});
