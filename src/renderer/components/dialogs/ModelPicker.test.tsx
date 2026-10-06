/**
 * ModelPicker contracts: only Ollama models are listed, with no provider
 * headers or sign-in state; the filter tags are real toggles backed by the
 * catalog's `reasoning` flag; the caption counts what the list shows; and the
 * footer and empty state hand off to the model-roles and Ollama windows.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ModelInfo } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { ModelPicker } from "./ModelPicker";

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

interface TestElement {
	textContent: string | null;
	getAttribute(name: string): string | null;
	dispatchEvent(event: object): boolean;
	remove(): void;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): TestElement[];
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

const QWEN: ModelInfo = { provider: "ollama", id: "qwen3:8b", name: "Qwen3 8B", reasoning: true };
const GEMMA: ModelInfo = { provider: "ollama", id: "gemma3:4b", name: "Gemma 3 4B", reasoning: false };
const LLAMA: ModelInfo = { provider: "ollama", id: "llama3.2:3b", name: "Llama 3.2 3B", reasoning: false };
const KIMI_CLOUD: ModelInfo = { provider: "ollama", id: "kimi-k2:cloud", name: "Kimi K2 cloud", reasoning: false };
const SONNET: ModelInfo = {
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	reasoning: true,
};
let container: TestElement;
let root: Root;
let rpc: Record<string, Mock>;
let catalog: ModelInfo[];

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
	await flush();
}

async function mount(): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	useUiStore.setState({ modelPickerOpen: true });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as unknown as Node);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ModelPicker />
			</I18nProvider>,
		);
	});
	await flush();
}

/** The Modal portals into document.body, so every query starts there. */
function body(): TestElement {
	return document.body as unknown as TestElement;
}

function filterGroup(): TestElement {
	const group = body().querySelector('[role="group"][aria-label="Filter models"]');
	if (!group) throw new Error("filter group not found");
	return group;
}

function filterTags(): TestElement[] {
	return filterGroup().querySelectorAll("button[aria-pressed]");
}

function tag(label: string): TestElement {
	const found = filterTags().find(candidate => candidate.textContent?.trim() === label);
	if (!found) throw new Error(`filter tag not found: ${label}`);
	return found;
}

function button(label: string): TestElement {
	const found = body()
		.querySelectorAll("button")
		.find(candidate => candidate.textContent?.trim() === label);
	if (!found) throw new Error(`button not found: ${label}`);
	return found;
}

function optionNames(): string[] {
	return body()
		.querySelectorAll('[role="option"]')
		.map(option => option.textContent ?? "");
}

beforeEach(() => {
	catalog = [QWEN, GEMMA, LLAMA];
	rpc = {
		getAvailableModels: vi.fn(async () => ok({ models: catalog, generation: 1 })),
	};
	(window as unknown as { omp: { rpc: Record<string, Mock> } }).omp = { rpc };
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	useUiStore.setState({ modelPickerOpen: false, providersOpen: false });
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
});

describe("filters and count", () => {
	it("renders All and Reasoning tags with the model count and the unchanged search field", async () => {
		await mount();

		expect(filterTags().map(candidate => candidate.textContent?.trim())).toEqual(["All", "Reasoning"]);
		expect(filterTags().some(candidate => /Fast|Connected/.test(candidate.textContent ?? ""))).toBe(false);
		expect(tag("All").getAttribute("aria-pressed")).toBe("true");
		expect(tag("Reasoning").getAttribute("aria-pressed")).toBe("false");
		expect(body().textContent).toContain("3 models");

		const input = body().querySelector('input[aria-label="Search models"]');
		expect(input?.getAttribute("placeholder")).toBe("Search models…");
	});

	it("keeps only reasoning models under Reasoning and recounts", async () => {
		await mount();
		await click(tag("Reasoning"));

		expect(tag("Reasoning").getAttribute("aria-pressed")).toBe("true");
		expect(tag("All").getAttribute("aria-pressed")).toBe("false");
		const names = optionNames();
		expect(names).toHaveLength(1);
		expect(names[0]).toContain("Qwen3 8B");
		expect(body().textContent).toContain("1 model");
		expect(body().textContent).not.toContain("1 models");
	});

	it("offers no filter tags when no model reports reasoning, and still shows the count", async () => {
		catalog = [GEMMA, LLAMA];
		await mount();
		expect(body().querySelector('[role="group"][aria-label="Filter models"]')).toBeNull();
		expect(body().textContent).toContain("2 models");
	});

	it("starts from All every time the picker opens", async () => {
		await mount();
		await click(tag("Reasoning"));
		expect(tag("Reasoning").getAttribute("aria-pressed")).toBe("true");

		await act(async () => useUiStore.setState({ modelPickerOpen: false }));
		await act(async () => useUiStore.setState({ modelPickerOpen: true }));
		await flush();

		expect(tag("All").getAttribute("aria-pressed")).toBe("true");
		expect(body().textContent).toContain("3 models");
	});
});

describe("footer", () => {
	it("Open Ollama settings closes the picker and opens the Ollama window", async () => {
		await mount();
		await click(button("Open Ollama settings"));
		expect(useUiStore.getState().providersOpen).toBe(true);
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
	});
});

describe("Ollama only", () => {
	it("lists only the Ollama models when other providers arrive in the catalog", async () => {
		catalog = [SONNET, QWEN, { provider: "openai", id: "gpt-5", name: "GPT-5" }, GEMMA];
		await mount();

		const names = optionNames();
		expect(names).toHaveLength(2);
		expect(names[0]).toContain("Qwen3 8B");
		expect(names[1]).toContain("Gemma 3 4B");
		const text = body().textContent ?? "";
		expect(text).not.toContain("Claude Sonnet 4.5");
		expect(text).not.toContain("GPT-5");
		expect(text).toContain("2 models");
		// No provider header and no sign-in state on a local-only list.
		expect(body().querySelector('section[role="group"]')).toBeNull();
		expect(text).not.toContain("authenticated");
		expect(text).not.toContain("not signed in");
		expect(rpc.getLoginProviders).toBeUndefined();
	});

	it("shows the empty local state with a way into Ollama settings when only remote models arrive", async () => {
		catalog = [SONNET];
		await mount();

		const empty = body().querySelector("[data-model-picker-empty]");
		expect(empty?.textContent).toContain("No local models yet");
		const open = empty?.querySelector("button");
		expect(open?.textContent?.trim()).toBe("Open Ollama settings");
		if (!open) throw new Error("empty-state button missing");
		await click(open);
		expect(useUiStore.getState().providersOpen).toBe(true);
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
	});

	it("selects an Ollama model through set_model", async () => {
		rpc.setModel = vi.fn(async () => ok(QWEN));
		await mount();

		const option = body()
			.querySelectorAll('[role="option"]')
			.find(candidate => candidate.textContent?.includes("Qwen3 8B"));
		if (!option) throw new Error("option missing");
		await click(option);

		expect(rpc.setModel).toHaveBeenCalledWith("ollama", "qwen3:8b");
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
	});
});

describe("cloud models", () => {
	function cloudOption(): TestElement {
		const option = body()
			.querySelectorAll('[role="option"]')
			.find(candidate => candidate.textContent?.includes("Kimi K2 cloud"));
		if (!option) throw new Error("cloud option missing");
		return option;
	}

	it("shows a cloud model disabled with the refusal, and selecting it sends nothing", async () => {
		catalog = [KIMI_CLOUD, QWEN];
		rpc.setModel = vi.fn(async () => ok(QWEN));
		await mount();

		const refusal = translate("ollama.settings.cloudRefused");
		const option = cloudOption();
		expect(option.getAttribute("disabled")).not.toBeNull();
		expect(option.getAttribute("aria-disabled")).toBe("true");
		expect(option.getAttribute("title")).toBe(refusal);
		expect(option.textContent).toContain(refusal);

		await click(option);
		const input = body().querySelector('input[aria-label="Search models"]');
		if (!input) throw new Error("search input missing");
		const enter = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(enter, "key", { value: "Enter" });
		await dispatch(input, enter);
		await flush();

		expect(rpc.setModel).not.toHaveBeenCalled();
		expect(useUiStore.getState().modelPickerOpen).toBe(true);
	});

	it("still switches to a local model listed beside a cloud one", async () => {
		catalog = [KIMI_CLOUD, QWEN];
		rpc.setModel = vi.fn(async () => ok(QWEN));
		await mount();

		const option = body()
			.querySelectorAll('[role="option"]')
			.find(candidate => candidate.textContent?.includes("Qwen3 8B"));
		if (!option) throw new Error("local option missing");
		await click(option);

		expect(rpc.setModel).toHaveBeenCalledTimes(1);
		expect(rpc.setModel).toHaveBeenCalledWith("ollama", "qwen3:8b");
	});
});
