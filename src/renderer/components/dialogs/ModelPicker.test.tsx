/**
 * ModelPicker contracts: the filter tags are real toggles backed only by data
 * the picker already loads (login-provider auth state and the catalog's
 * `reasoning` flag), the caption counts what the list shows, and the footer
 * hands off to the existing model-roles and providers windows.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { LoginProvider, ModelInfo, ProviderInfo } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
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
const fail = (error: string) => ({ type: "response" as const, command: "x", success: false as const, error });

const SONNET: ModelInfo = {
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	reasoning: true,
};
const HAIKU: ModelInfo = { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false };
const GEMINI: ModelInfo = { provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning: false };
const GPT: ModelInfo = { provider: "openai", id: "gpt-5.2", name: "GPT-5.2", reasoning: false };

const PROVIDERS: LoginProvider[] = [
	{ id: "anthropic", name: "Anthropic", available: true, authenticated: true },
	{ id: "google", name: "Google", available: true, authenticated: false },
];
/** Credential state from get_providers; OpenAI is an API-key provider with no login flow. */
function providerInfo(overrides: Partial<Record<string, Partial<ProviderInfo>>> = {}): ProviderInfo[] {
	const base: ProviderInfo[] = [
		{
			id: "anthropic",
			name: "Anthropic",
			authenticated: true,
			authKind: "oauth",
			loginAvailable: true,
			disabled: false,
			modelCount: 2,
		},
		{ id: "google", name: "Google", authenticated: false, loginAvailable: true, disabled: false, modelCount: 1 },
		{
			id: "openai",
			name: "OpenAI",
			authenticated: true,
			authKind: "apikey",
			loginAvailable: false,
			disabled: false,
			modelCount: 1,
		},
	];
	return base.map(provider => ({ ...provider, ...overrides[provider.id] }));
}

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
	catalog = [SONNET, HAIKU, GEMINI];
	rpc = {
		getLoginProviders: vi.fn(async () => ok({ providers: PROVIDERS })),
		getProviders: vi.fn(async () => ok({ providers: providerInfo() })),
		getAvailableModels: vi.fn(async () => ok({ models: catalog, generation: 1 })),
	};
	(window as unknown as { omp: { rpc: Record<string, Mock> } }).omp = { rpc };
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	useUiStore.setState({ modelPickerOpen: false, modelRolesOpen: false, providersOpen: false });
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
});

describe("filters and count", () => {
	it("renders All, Connected, and Reasoning tags with the model count and the unchanged search field", async () => {
		await mount();

		expect(filterTags().map(candidate => candidate.textContent?.trim())).toEqual(["All", "Connected", "Reasoning"]);
		expect(filterTags().some(candidate => candidate.textContent?.includes("Fast"))).toBe(false);
		expect(tag("All").getAttribute("aria-pressed")).toBe("true");
		expect(tag("Connected").getAttribute("aria-pressed")).toBe("false");
		expect(body().textContent).toContain("3 models");

		const input = body().querySelector('input[aria-label="Search models"]');
		expect(input?.getAttribute("placeholder")).toBe("Search models…");
	});

	it("hides models of unauthenticated providers under Connected and recounts", async () => {
		await mount();
		expect(optionNames().some(name => name.includes("Gemini 3 Pro"))).toBe(true);

		await click(tag("Connected"));

		expect(tag("Connected").getAttribute("aria-pressed")).toBe("true");
		expect(tag("All").getAttribute("aria-pressed")).toBe("false");
		const names = optionNames();
		expect(names.some(name => name.includes("Claude Sonnet 4.5"))).toBe(true);
		expect(names.some(name => name.includes("Claude Haiku 4.5"))).toBe(true);
		expect(names.some(name => name.includes("Gemini 3 Pro"))).toBe(false);
		expect(body().textContent).toContain("2 models");
	});

	it("keeps models of API-key providers under Connected", async () => {
		catalog = [SONNET, HAIKU, GEMINI, GPT];
		await mount();
		await click(tag("Connected"));
		const names = optionNames();
		expect(names.some(name => name.includes("GPT-5.2"))).toBe(true);
		expect(names.some(name => name.includes("Gemini 3 Pro"))).toBe(false);
		expect(body().textContent).toContain("3 models");
	});

	it("drops a disabled provider's models under Connected even when it has credentials", async () => {
		catalog = [SONNET, HAIKU, GEMINI, GPT];
		rpc.getProviders = vi.fn(async () => ok({ providers: providerInfo({ openai: { disabled: true } }) }));
		await mount();
		await click(tag("Connected"));
		expect(optionNames().some(name => name.includes("GPT-5.2"))).toBe(false);
		expect(body().textContent).toContain("2 models");
	});

	it("keeps only reasoning models under Reasoning", async () => {
		await mount();
		await click(tag("Reasoning"));
		const names = optionNames();
		expect(names).toHaveLength(1);
		expect(names[0]).toContain("Claude Sonnet 4.5");
	});

	it("offers no Reasoning tag when no model reports reasoning", async () => {
		catalog = [HAIKU, GEMINI];
		await mount();
		expect(filterTags().map(candidate => candidate.textContent?.trim())).toEqual(["All", "Connected"]);
	});

	it("shows the count instead of a search miss when Connected has no provider data to match", async () => {
		rpc.getProviders = vi.fn(async () => fail("providers unavailable"));
		await mount();
		await click(tag("Connected"));
		expect(optionNames()).toEqual([]);
		expect(body().textContent).toContain("0 models");
		expect(body().textContent).not.toContain("No models match");
	});

	it("starts from All every time the picker opens", async () => {
		await mount();
		await click(tag("Connected"));
		expect(tag("Connected").getAttribute("aria-pressed")).toBe("true");

		await act(async () => useUiStore.setState({ modelPickerOpen: false }));
		await act(async () => useUiStore.setState({ modelPickerOpen: true }));
		await flush();

		expect(tag("All").getAttribute("aria-pressed")).toBe("true");
		expect(body().textContent).toContain("3 models");
	});
});

describe("footer", () => {
	it("Assign roles closes the picker and opens the model roles window", async () => {
		await mount();
		await click(button("Assign roles"));
		expect(useUiStore.getState().modelRolesOpen).toBe(true);
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
	});

	it("Manage providers closes the picker and opens the providers window", async () => {
		await mount();
		await click(button("Manage providers"));
		expect(useUiStore.getState().providersOpen).toBe(true);
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
	});
});
