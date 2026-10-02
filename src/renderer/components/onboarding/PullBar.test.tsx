import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { PullProgress } from "../../../shared/ollama-types";
import { I18nProvider } from "../../lib/i18n";
import { PullBar } from "./PullBar";

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
	innerHTML: string;
	remove: () => void;
	click: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
}

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
});

function progress(overrides: Partial<PullProgress>): PullProgress {
	return {
		tag: "qwen3:8b",
		status: "pulling manifest",
		completed: 0,
		total: 0,
		percent: -1,
		done: false,
		...overrides,
	};
}

function bar(): TestElement | null {
	return container.querySelector('[role="progressbar"]');
}

describe("PullBar", () => {
	it("renders nothing without a download", async () => {
		await mount(<PullBar onCancel={() => {}} progress={null} />);
		expect(container.innerHTML).toBe("");
	});

	it("stripes while the size is unknown", async () => {
		await mount(<PullBar onCancel={() => {}} progress={progress({})} />);
		expect(bar()?.getAttribute("data-indeterminate")).toBe("true");
		expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
		expect(container.textContent).toContain("Starting download…");
	});

	it("shows percent with Ollama's status once bytes are known", async () => {
		await mount(
			<PullBar
				onCancel={() => {}}
				progress={progress({ status: "downloading", completed: 42, total: 100, percent: 42 })}
			/>,
		);
		expect(bar()?.getAttribute("data-indeterminate")).toBe("false");
		expect(bar()?.getAttribute("aria-valuenow")).toBe("42");
		expect(container.querySelector(".omp-pull-fill")?.getAttribute("style")?.replaceAll(" ", "")).toBe("width:42%");
		expect(container.textContent).toContain("downloading · 42%");
	});

	it("never shows 100% before the download is done", async () => {
		await mount(<PullBar onCancel={() => {}} progress={progress({ status: "verifying", percent: 100 })} />);
		expect(bar()?.getAttribute("aria-valuenow")).toBe("99");
	});

	it("hides once done", async () => {
		await mount(<PullBar onCancel={() => {}} progress={progress({ status: "success", percent: 100, done: true })} />);
		expect(container.innerHTML).toBe("");
	});

	it("shows a failed download instead of the bar", async () => {
		await mount(<PullBar onCancel={() => {}} progress={progress({ done: true, error: "connection reset" })} />);
		expect(bar()).toBeNull();
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("connection reset");
	});

	it("cancels through the parent", async () => {
		let cancelled = 0;
		await mount(<PullBar onCancel={() => cancelled++} progress={progress({ percent: 10 })} />);
		await act(async () => container.querySelector('[data-action="cancel-pull"]')?.click());
		expect(cancelled).toBe(1);
	});
});
