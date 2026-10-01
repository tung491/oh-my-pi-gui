/**
 * A quick-entry prompt lands in a fresh tab's composer and must go out exactly
 * once, through the normal submit pipeline, only after the tab is ready. Text
 * the composer would run as a shell command is shown but never sent.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { InputArea } from "./InputArea";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
elementPrototype.getBoundingClientRect = () => ({
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
	toJSON: () => ({}),
});
Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: { remove(): void };
let root: Root;
let prompt: Mock;
let bash: Mock;
let evalCode: Mock;
let ackPrompt: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(status: "starting" | "ready"): Promise<void> {
	prompt = vi.fn(async () => ok());
	bash = vi.fn(async () => ok({ output: "", exitCode: 0 }));
	evalCode = vi.fn(async () => ok({ output: "" }));
	ackPrompt = vi.fn(async () => {});
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })) },
		events: { onCommandsUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			prompt,
			bash,
			eval: evalCode,
			followUp: vi.fn(async () => ok()),
			steer: vi.fn(async () => ok()),
			abort: vi.fn(async () => ok()),
		},
		quickEntry: { ack: ackPrompt, claimPending: vi.fn(async () => []), returnToBar: vi.fn(async () => {}) },
	};
	useSessionStore.setState({
		status,
		isStreaming: false,
		queuedMessageCount: 0,
		cwd: "/tmp",
		sessionId: "s1",
		sessionName: null,
	});
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "starting", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
	const element = document.createElement("div");
	document.body.appendChild(element);
	container = element as unknown as { remove(): void };
	root = createRoot(element as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<InputArea />
			</I18nProvider>,
		);
	});
	await flush();
}

async function queue(text: string, id = "q1"): Promise<void> {
	await act(async () => useComposerStore.getState().queueAutoSubmit({ id, text }));
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useSettingsStore.getState().reset();
	useTabsStore.getState().reset();
	vi.restoreAllMocks();
});

describe("InputArea quick-entry auto-submit", () => {
	it("waits while the tab is starting, then sends once and acknowledges", async () => {
		await mount("starting");
		await queue("hello from quick entry");
		expect(prompt).not.toHaveBeenCalled();
		expect(ackPrompt).not.toHaveBeenCalled();

		await act(async () => useSessionStore.setState({ status: "ready" }));
		await flush();
		await flush();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("hello from quick entry", []);
		expect(ackPrompt).toHaveBeenCalledTimes(1);
		expect(ackPrompt).toHaveBeenCalledWith("q1");
		expect(useComposerStore.getState().autoSubmit).toBeNull();
	});

	it("leaves shell-mode text in the composer without running it", async () => {
		await mount("ready");
		await queue("!rm -rf ~", "bang");
		await queue("$ print(1)", "dollar");
		await flush();

		expect(bash).not.toHaveBeenCalled();
		expect(evalCode).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("$ print(1)");
		expect(ackPrompt.mock.calls).toEqual([["bang"], ["dollar"]]);
		expect(useComposerStore.getState().autoSubmit).toBeNull();
	});

	it("does not touch a composer whose last submission is uncertain", async () => {
		await mount("ready");
		await act(async () => useComposerStore.getState().setSubmissionUncertain(true));
		await queue("held text");

		expect(prompt).not.toHaveBeenCalled();
		expect(ackPrompt).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("held text");
		expect(useComposerStore.getState().autoSubmit).toEqual({ id: "q1" });
	});
});
