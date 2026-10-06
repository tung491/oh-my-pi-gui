/**
 * A starter card sends its skill prompt through the composer's send pipeline
 * without the composer's own draft: the typed text and pasted images stay in
 * the composer, and the prompt carries no image. The composer's placeholder
 * says why it cannot send while the agent is not ready.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SidecarStatus } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
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

async function mount(status: SidecarStatus): Promise<void> {
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

const screenshot = {
	content: { type: "image" as const, data: "AAAA", mimeType: "image/png" },
	preview: "data:image/png;base64,AAAA",
};

async function startCard(text: string): Promise<void> {
	await act(async () => {
		window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text, tabId: "t0", submit: true } }));
	});
	await flush();
	await flush();
}

describe("InputArea starter card send", () => {
	it("sends the skill prompt without images and keeps the typed draft and images", async () => {
		await mount("ready");
		await act(async () => {
			useComposerStore.getState().setDraft("my unrelated paragraph");
			useComposerStore.getState().setImages([screenshot]);
		});
		await flush();

		await startCard("/skill:word-report '/home/u/notes.md'");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("/skill:word-report '/home/u/notes.md'");
		expect(prompt.mock.calls[0]?.[1] ?? []).toEqual([]);
		expect(useComposerStore.getState().draft).toBe("my unrelated paragraph");
		expect(useComposerStore.getState().images).toEqual([screenshot]);
	});

	it("keeps the typed draft when the starter send fails", async () => {
		await mount("ready");
		prompt.mockImplementation(async () => ({
			type: "response" as const,
			command: "prompt",
			success: false as const,
			error: "busy",
		}));
		await act(async () => useComposerStore.getState().setDraft("my unrelated paragraph"));
		await flush();

		await startCard("/skill:word-report '/home/u/notes.md'");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(useComposerStore.getState().draft).toBe("my unrelated paragraph");
	});

	it("sends a starter from an empty composer", async () => {
		await mount("ready");
		await startCard("/skill:sai-os-helpdesk I need help with my computer.");
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("/skill:sai-os-helpdesk I need help with my computer.");
		expect(useComposerStore.getState().draft).toBe("");
	});
});

describe("InputArea placeholder", () => {
	const placeholder = () => document.querySelector("textarea")?.getAttribute("placeholder");

	it("says it is connecting while the agent starts", async () => {
		await mount("starting");
		expect(placeholder()).toBe(en["input.placeholder.connecting"]);
	});

	it("points at the refusal instead of connecting when the agent cannot start", async () => {
		await mount("error");
		expect(placeholder()).toBe(en["input.placeholder.unavailable"]);
	});
});
