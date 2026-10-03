/**
 * CommandPalette contracts for the single availability source: a command that
 * cannot run in this tab kind renders disabled (and is never the keyboard
 * selection), a row that needs an argument hands its slash form to the composer
 * instead of being dispatched without it, Escape closes the panel wherever
 * focus sits inside it, and a failed sidecar command fetch says so with a retry.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SessionKind } from "../../../shared/ipc-types";
import type { AvailableCommand } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { CommandPalette } from "./CommandPalette";

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
	className: string;
	getAttribute(name: string): string | null;
	dispatchEvent(event: object): boolean;
	remove(): void;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): TestElement[];
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });
const fail = (error: string) => ({ type: "response" as const, command: "x", success: false as const, error });

/** Takes an argument, so the palette must prefill instead of dispatching. */
const DEPLOY: AvailableCommand = {
	name: "deploy",
	description: "Deploy the build",
	input: { hint: "<environment>" },
	textModeExecutable: true,
};
/** No argument, so the palette dispatches it. */
const HELLO: AvailableCommand = { name: "hello", description: "Say hello", textModeExecutable: true };

let container: TestElement;
let root: Root;
let rpc: Record<string, Mock>;
let sidecarCommands: AvailableCommand[];
let prefills: string[];

function onFillComposer(event: unknown): void {
	prefills.push((event as { detail: { text: string } }).detail.text);
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: object): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

async function keyDown(element: TestElement, key: string): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: key, configurable: true });
	await dispatch(element, event);
}

function seedTab(kind: SessionKind): void {
	useTabsStore.setState({
		tabs: [{ id: `t-${kind}`, cwd: "/tmp", status: "ready", kind, unreadDone: false }],
		activeTabId: `t-${kind}`,
	});
}

async function mount(): Promise<void> {
	useUiStore.setState({ commandPaletteOpen: true });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as unknown as Node);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<CommandPalette />
			</I18nProvider>,
		);
	});
	await flush();
}

function rows(): TestElement[] {
	return container.querySelectorAll("button").filter(row => row.getAttribute("data-palette-index") !== null);
}

function rowByLabel(label: string): TestElement {
	const row = rows().find(candidate => candidate.textContent?.includes(label));
	if (!row) throw new Error(`row not found: ${label}`);
	return row;
}

/** Index of the highlighted row, or -1 when none is. */
function selectedIndex(): number {
	return rows().findIndex(row => row.className.includes("omp-selected"));
}

beforeEach(() => {
	useSessionStore.setState({ status: "ready" });
	sidecarCommands = [];
	prefills = [];
	rpc = {
		getAvailableCommands: vi.fn(async () => ok({ commands: sidecarCommands })),
		prompt: vi.fn(async () => ok()),
	};
	(window as unknown as { omp: { rpc: Record<string, Mock> } }).omp = { rpc };
	window.addEventListener("omp:fill-composer", onFillComposer);
});

afterEach(async () => {
	window.removeEventListener("omp:fill-composer", onFillComposer);
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	useUiStore.setState({ commandPaletteOpen: false });
	useSessionStore.getState().reset();
	useTabsStore.setState({ tabs: [], activeTabId: null });
});

describe("chat-tab rows", () => {
	it("renders a tool command disabled, with the reason, and never as the selection", async () => {
		sidecarCommands = [DEPLOY];
		seedTab("chat");
		await mount();

		const plan = rowByLabel(translate("cmd.plan"));
		expect(plan.getAttribute("disabled")).not.toBeNull();
		expect(plan.getAttribute("aria-disabled")).toBe("true");
		expect(plan.textContent).toContain(translate("unavailable.chatSession"));

		// Keyboard navigation must never be able to rest on a disabled row.
		expect(selectedIndex()).toBeGreaterThan(-1);
		expect(rows()[selectedIndex()].getAttribute("disabled")).toBeNull();
		await keyDown(rows()[selectedIndex()], "ArrowDown");
		expect(rows()[selectedIndex()].getAttribute("disabled")).toBeNull();
	});

	it("keeps the same command executable in an agent tab", async () => {
		sidecarCommands = [DEPLOY];
		seedTab("agent");
		await mount();
		const plan = rowByLabel(translate("cmd.plan"));
		expect(plan.getAttribute("disabled")).toBeNull();
		expect(plan.getAttribute("aria-disabled")).toBe("false");
	});
});

describe("panel keyboard handling", () => {
	it("closes on Escape from a row, not only from the search input", async () => {
		// Clicking a row leaves focus on its button; an input-only handler made the
		// palette uncloseable by the keyboard after that.
		seedTab("agent");
		await mount();
		expect(useUiStore.getState().commandPaletteOpen).toBe(true);
		await keyDown(rows()[3], "Escape");
		expect(useUiStore.getState().commandPaletteOpen).toBe(false);
	});

	it("still goes back and then closes on Escape after focus fell out of the panel", async () => {
		// Switching levels unmounts the focused row, and Chromium then parks focus
		// on <body>, outside the panel. Escape must keep working from there.
		seedTab("agent");
		await mount();
		await click(rowByLabel(translate("cmd.security")));
		expect(rows().some(row => row.getAttribute("data-command-kind") === "submenu")).toBe(false);

		await keyDown(document.body as unknown as TestElement, "Escape");
		expect(useUiStore.getState().commandPaletteOpen).toBe(true);
		expect(rows().some(row => row.getAttribute("data-command-name") === "security")).toBe(true);

		await keyDown(document.body as unknown as TestElement, "Escape");
		expect(useUiStore.getState().commandPaletteOpen).toBe(false);
	});
});

describe("row execution", () => {
	it("fills the composer for a command that needs an argument", async () => {
		sidecarCommands = [DEPLOY];
		seedTab("agent");
		await mount();
		await click(rowByLabel("/deploy"));
		expect(prefills).toEqual(["/deploy "]);
		expect(rpc.prompt).not.toHaveBeenCalled();
		expect(useUiStore.getState().commandPaletteOpen).toBe(false);
	});

	it("dispatches a parameterless command straight to the session", async () => {
		sidecarCommands = [HELLO];
		seedTab("agent");
		await mount();
		await click(rowByLabel("/hello"));
		expect(rpc.prompt).toHaveBeenCalledWith("/hello");
		expect(prefills).toEqual([]);
	});

	it("drills into a submenu row instead of executing anything", async () => {
		seedTab("agent");
		await mount();
		await click(rowByLabel(translate("cmd.security")));
		expect(rpc.prompt).not.toHaveBeenCalled();
		expect(useUiStore.getState().commandPaletteOpen).toBe(true);
		// The top level is replaced by the submenu's own rows.
		expect(rows().some(row => row.textContent?.includes(translate("cmd.plan")))).toBe(false);
	});
});

describe("sidecar command fetch failure", () => {
	it("surfaces the failure with a retry that clears it", async () => {
		rpc.getAvailableCommands = vi
			.fn()
			.mockResolvedValueOnce(fail("sidecar not ready"))
			.mockResolvedValue(ok({ commands: [DEPLOY] }));
		seedTab("agent");
		await mount();

		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toBe(translate("palette.commandsFailed"));
		expect(alert?.getAttribute("title")).toBe("sidecar not ready");

		const retry = container
			.querySelectorAll("button")
			.find(button => button.textContent?.trim() === translate("common.retry"));
		if (!retry) throw new Error("retry button not found");
		await click(retry);

		expect(rpc.getAvailableCommands).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});
});

describe("footer", () => {
	/** The palette's recents key; Node's own localStorage is unavailable without --localstorage-file. */
	const RECENT_KEY = "omp.palette.recent";
	let storageDescriptor: PropertyDescriptor | undefined;

	/** A Map-backed localStorage, so recents persist the way the palette stores them. */
	function installLocalStorage(seed: Record<string, string>): void {
		storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const entries = new Map(Object.entries(seed));
		const storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> = {
			getItem: key => entries.get(key) ?? null,
			setItem: (key, value) => {
				entries.set(key, String(value));
			},
			removeItem: key => {
				entries.delete(key);
			},
			clear: () => entries.clear(),
		};
		Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
	}

	afterEach(() => {
		if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
		else Reflect.deleteProperty(globalThis, "localStorage");
		storageDescriptor = undefined;
	});

	it("hints navigation and run, and counts each command once even when recents pin a copy", async () => {
		installLocalStorage({ [RECENT_KEY]: JSON.stringify(["settings", "theme"]) });
		seedTab("agent");
		await mount();

		const footerText = (): string => container.querySelector("[data-palette-footer]")?.textContent ?? "";
		const countText = (count: number): string =>
			translate("palette.footer.count", { count, plural: count === 1 ? "" : "s" });
		expect(footerText()).toContain(translate("palette.footer.navigate"));
		expect(footerText()).toContain(translate("palette.footer.run"));

		// Both recents render twice: pinned on top, and again in their category.
		const names = rows().map(row => row.getAttribute("data-command-name"));
		const distinct = new Set(names).size;
		expect(names.filter(name => name === "settings")).toHaveLength(2);
		expect(names.filter(name => name === "theme")).toHaveLength(2);
		expect(names).toHaveLength(distinct + 2);
		expect(footerText().endsWith(countText(distinct))).toBe(true);

		// Drilling into a submenu swaps the rows (no recents there), and the count follows them.
		await click(rowByLabel(translate("cmd.security")));
		expect(rows().length).toBeGreaterThan(0);
		expect(footerText().endsWith(countText(rows().length))).toBe(true);
	});
});
