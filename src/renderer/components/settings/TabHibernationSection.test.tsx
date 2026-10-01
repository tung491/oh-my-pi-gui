import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { TabHibernationSection } from "./TabHibernationSection";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	value?: string;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
}

let container: TestElement;
let root: Root;
let stored: unknown;
let writes: Array<{ key: string; value: unknown }>;

function stubPrefs(initial: unknown): void {
	stored = initial;
	writes = [];
	(window as unknown as { omp: unknown }).omp = {
		prefs: {
			get: async () => stored,
			set: async (key: string, value: unknown) => {
				writes.push({ key, value });
				stored = value;
			},
		},
	};
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

/** React's props on a rendered node: drive handlers without a real event system. */
function reactProps(element: TestElement): Record<string, (event: object) => void> {
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("not a React-rendered element");
	return record[key] as Record<string, (event: object) => void>;
}

function toggle(): TestElement {
	const element = container.querySelector('[role="switch"]');
	if (!element) throw new Error("toggle not rendered");
	return element;
}

function minutesInput(): TestElement {
	const element = container.querySelector('input[type="number"]');
	if (!element) throw new Error("minutes field not rendered");
	return element;
}

async function enterMinutes(value: string): Promise<void> {
	const input = minutesInput();
	await act(async () => reactProps(input).onChange({ target: { value }, currentTarget: input }));
	await act(async () => reactProps(minutesInput()).onBlur({ target: input, currentTarget: input }));
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
	useToastStore.setState({ toasts: [] });
});

describe("TabHibernationSection", () => {
	it("shows the default, off at 30 minutes, when nothing is stored", async () => {
		stubPrefs(undefined);
		await mount(<TabHibernationSection open />);
		expect(toggle().getAttribute("aria-checked")).toBe("false");
		expect(minutesInput().value).toBe("30");
		expect(container.textContent).toContain("Warm LSP and MCP server connections");
	});

	it("shows a malformed stored value as the safe default", async () => {
		stubPrefs({ enabled: "yes", idleMinutes: 0 });
		await mount(<TabHibernationSection open />);
		expect(toggle().getAttribute("aria-checked")).toBe("false");
		expect(minutesInput().value).toBe("5");
	});

	it("writes the whole preference when toggled", async () => {
		stubPrefs({ enabled: false, idleMinutes: 45 });
		await mount(<TabHibernationSection open />);
		await act(async () => reactProps(toggle()).onClick({}));
		expect(writes).toEqual([{ key: "tabHibernation", value: { enabled: true, idleMinutes: 45 } }]);
		expect(toggle().getAttribute("aria-checked")).toBe("true");
	});

	it("saves a new idle time on blur", async () => {
		stubPrefs({ enabled: true, idleMinutes: 30 });
		await mount(<TabHibernationSection open />);
		await enterMinutes("90");
		expect(writes).toEqual([{ key: "tabHibernation", value: { enabled: true, idleMinutes: 90 } }]);
		expect(minutesInput().value).toBe("90");
	});

	it("refuses an idle time outside 5–240 minutes and keeps the saved one", async () => {
		stubPrefs({ enabled: true, idleMinutes: 30 });
		await mount(<TabHibernationSection open />);
		await enterMinutes("0");
		await enterMinutes("");
		await enterMinutes("241");
		expect(writes).toEqual([]);
		expect(minutesInput().value).toBe("30");
		const messages = useToastStore.getState().toasts.map(entry => entry.message);
		expect(messages).toContain("Idle time must be between 5 and 240 minutes");
	});
});
