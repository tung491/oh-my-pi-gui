/**
 * The quick-entry bar sends only what the user meant to send: Enter submits the
 * trimmed text once, Shift+Enter and IME composition never submit, Esc closes,
 * and a message that came back unsent fills the draft only when nothing would
 * be overwritten.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	QuickEntryBarApi,
	QuickEntryBarState,
	QuickEntrySubmitPayload,
	QuickEntrySubmitResult,
} from "../../shared/ipc-types";
import { I18nProvider } from "../lib/i18n";
import { en } from "../locales/en";
import { zh } from "../locales/zh";
import { QuickEntryBar } from "./QuickEntryBar";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.setSelectionRange !== "function") elementPrototype.setSelectionRange = () => {};

interface TestElement {
	textContent: string | null;
	value: string;
	remove(): void;
	dispatchEvent(event: object): boolean;
	getAttribute(name: string): string | null;
	querySelectorAll(selector: string): TestElement[];
}

interface BarStub {
	api: QuickEntryBarApi;
	submit: Mock<(payload: QuickEntrySubmitPayload) => Promise<QuickEntrySubmitResult>>;
	consumeRestored: Mock<(id: string) => void>;
	dismiss: Mock<() => void>;
	push(state: QuickEntryBarState): Promise<void>;
}

/** A hand-written window.ompQuickEntry: the state replays to each subscriber, like the preload's. */
function barStub(): BarStub {
	let latest: QuickEntryBarState | undefined;
	const listeners = new Set<(state: QuickEntryBarState) => void>();
	const submit = vi.fn(async (_payload: QuickEntrySubmitPayload): Promise<QuickEntrySubmitResult> => ({ ok: true }));
	const consumeRestored = vi.fn((_id: string) => {});
	const dismiss = vi.fn(() => {});
	return {
		api: {
			platform: "linux",
			onState(callback) {
				listeners.add(callback);
				if (latest) callback(latest);
				return () => {
					listeners.delete(callback);
				};
			},
			submit,
			consumeRestored,
			dismiss,
		},
		submit,
		consumeRestored,
		dismiss,
		async push(state) {
			latest = state;
			await act(async () => {
				for (const listener of listeners) listener(state);
			});
		},
	};
}

const baseState = (overrides: Partial<QuickEntryBarState> = {}): QuickEntryBarState => ({
	language: "en",
	target: { kind: "chat" },
	workspaces: [
		{ cwd: "/code/alpha", name: "alpha" },
		{ cwd: "/code/beta", name: "beta" },
	],
	restored: [],
	showId: 1,
	...overrides,
});

let container: TestElement;
let root: Root;
let bar: BarStub;

async function mount(state: QuickEntryBarState = baseState()): Promise<void> {
	bar = barStub();
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<QuickEntryBar api={bar.api} />
			</I18nProvider>,
		);
	});
	await bar.push(state);
}

function reactProps<T>(element: TestElement): T {
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("React props not found");
	return record[key] as T;
}

function textarea(): TestElement {
	const element = document.querySelector("textarea") as unknown as TestElement | null;
	if (!element) throw new Error("textarea not found");
	return element;
}

async function type(value: string): Promise<void> {
	const element = textarea();
	element.value = value;
	await act(async () => reactProps<{ onChange(event: object): void }>(element).onChange({ target: element }));
}

async function keyDown(
	element: TestElement,
	key: string,
	options: { shiftKey?: boolean; isComposing?: boolean } = {},
): Promise<Mock> {
	const preventDefault = vi.fn();
	await act(async () =>
		reactProps<{ onKeyDown(event: object): void }>(element).onKeyDown({
			key,
			shiftKey: options.shiftKey ?? false,
			keyCode: options.isComposing ? 229 : 13,
			nativeEvent: { isComposing: options.isComposing ?? false },
			preventDefault,
		}),
	);
	return preventDefault;
}

function button(label: string): TestElement {
	const found = (Array.from(document.querySelectorAll("button")) as unknown as TestElement[]).find(
		element => element.textContent?.trim() === label,
	);
	if (!found) throw new Error(`button ${label} not found`);
	return found;
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	try {
		localStorage.removeItem("omp.lang");
	} catch {
		// No storage in this runtime.
	}
});

describe("QuickEntryBar", () => {
	it("submits the trimmed text once on Enter", async () => {
		await mount();
		await type("  hello there \n");
		const preventDefault = await keyDown(textarea(), "Enter");

		expect(preventDefault).toHaveBeenCalled();
		expect(bar.submit).toHaveBeenCalledTimes(1);
		expect(bar.submit).toHaveBeenCalledWith({ text: "hello there", target: { kind: "chat" } });
		expect(textarea().value).toBe("");
	});

	it("leaves Shift+Enter to the textarea as a new line", async () => {
		await mount();
		await type("first line");
		const preventDefault = await keyDown(textarea(), "Enter", { shiftKey: true });

		expect(preventDefault).not.toHaveBeenCalled();
		expect(bar.submit).not.toHaveBeenCalled();
	});

	it("does not submit empty or whitespace-only text", async () => {
		await mount();
		await keyDown(textarea(), "Enter");
		await type("   \n ");
		await keyDown(textarea(), "Enter");

		expect(bar.submit).not.toHaveBeenCalled();
	});

	it("never submits while an IME composition is live", async () => {
		await mount();
		await type("ke fu");
		await keyDown(textarea(), "Enter", { isComposing: true });

		expect(bar.submit).not.toHaveBeenCalled();
	});

	it("closes on Esc", async () => {
		await mount();
		const shell = container.querySelectorAll("div")[0];
		await keyDown(shell, "Escape");

		expect(bar.dismiss).toHaveBeenCalledTimes(1);
	});

	it("keeps the text and shows why when main refuses the submit", async () => {
		await mount();
		bar.submit.mockResolvedValueOnce({ ok: false, reason: "tab-cap" });
		await type("keep me");
		await keyDown(textarea(), "Enter");

		expect(textarea().value).toBe("keep me");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(en["tabs.parallelCap"]);
	});

	it("reveals the workspace picker with Work first when Agent is picked", async () => {
		await mount();
		expect(document.querySelector("select")).toBeNull();
		await act(async () => {
			button(en["quickEntry.target.agent"]).dispatchEvent(new Event("click", { bubbles: true }));
		});

		const options = Array.from(document.querySelectorAll("select option")) as unknown as TestElement[];
		expect(options.map(option => option.textContent)).toEqual([en["sidebar.mode.work"], "alpha", "beta"]);
		expect(options[1].getAttribute("title")).toBe("/code/alpha");

		await type("run the tests");
		await keyDown(textarea(), "Enter");
		expect(bar.submit).toHaveBeenCalledWith({ text: "run the tests", target: { kind: "work" } });
	});

	it("keeps the target of a draft kept across summons", async () => {
		await mount();
		await act(async () => {
			button(en["quickEntry.target.agent"]).dispatchEvent(new Event("click", { bubbles: true }));
		});
		await type("half written");
		await bar.push(baseState({ showId: 2 }));
		await keyDown(textarea(), "Enter");
		expect(bar.submit).toHaveBeenCalledWith({ text: "half written", target: { kind: "work" } });
	});

	it("fills an empty draft with a restored message and consumes it once", async () => {
		const restored = {
			id: "r1",
			text: "came back",
			target: { kind: "work" } as const,
			reason: "interrupted" as const,
		};
		await mount(baseState({ restored: [restored] }));

		expect(textarea().value).toBe("came back");
		expect(document.querySelector("select")).not.toBeNull();
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(en["quickEntry.error.interrupted"]);
		expect(bar.consumeRestored).toHaveBeenCalledTimes(1);
		expect(bar.consumeRestored).toHaveBeenCalledWith("r1");

		// Main's own state may still list it until the consume lands.
		await bar.push(baseState({ restored: [restored] }));
		expect(bar.consumeRestored).toHaveBeenCalledTimes(1);
	});

	it("offers a restore button instead of overwriting a draft", async () => {
		await mount();
		await type("my own draft");
		const restored = {
			id: "r2",
			text: "came back",
			target: { kind: "chat" } as const,
			reason: "tab-failed" as const,
		};
		await bar.push(baseState({ restored: [restored], showId: 2 }));

		expect(textarea().value).toBe("my own draft");
		expect(bar.consumeRestored).not.toHaveBeenCalled();
		const restore = button(en["quickEntry.restore"].replace("{count}", "1"));

		await act(async () => {
			restore.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(textarea().value).toBe("came back");
		expect(bar.consumeRestored).toHaveBeenCalledWith("r2");
		// The swapped-out draft waits in the list in turn.
		expect(button(en["quickEntry.restore"].replace("{count}", "1"))).toBeDefined();
	});

	it("renders in the language main sends", async () => {
		await mount(baseState({ language: "zh" }));

		expect(textarea().getAttribute("placeholder")).toBe(zh["quickEntry.placeholder"]);
		expect(button(zh["quickEntry.target.chat"])).toBeDefined();
	});
});
