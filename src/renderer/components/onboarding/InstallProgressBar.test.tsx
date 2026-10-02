import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { OllamaInstallProgress } from "../../../shared/ollama-types";
import { I18nProvider } from "../../lib/i18n";
import { InstallProgressBar } from "./InstallProgressBar";

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
	remove: () => void;
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

function progress(overrides: Partial<OllamaInstallProgress> = {}): OllamaInstallProgress {
	return { stage: null, percent: -1, done: false, ...overrides };
}

function bar(): TestElement | null {
	return container.querySelector('[role="progressbar"]');
}

function stage(): string | null | undefined {
	return container.querySelector("[data-install-stage]")?.textContent;
}

describe("InstallProgressBar", () => {
	it("stripes with the waiting text before the installer prints a stage", async () => {
		await mount(<InstallProgressBar progress={progress()} />);
		expect(bar()?.getAttribute("data-indeterminate")).toBe("true");
		expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
		expect(stage()).toBe("Waiting for authorization…");
		expect(container.textContent).toContain("Installing Ollama. This can take a few minutes.");
	});

	it("stripes with the stage text while no percentage is known", async () => {
		await mount(<InstallProgressBar progress={progress({ stage: "Installing ollama to /usr/local" })} />);
		expect(bar()?.getAttribute("data-indeterminate")).toBe("true");
		expect(stage()).toBe("Installing ollama to /usr/local");
		expect(container.textContent).not.toContain("%");
	});

	it("shows a determinate bar with the stage and percent during a download", async () => {
		await mount(<InstallProgressBar progress={progress({ stage: "Downloading ollama...", percent: 42 })} />);
		expect(bar()?.getAttribute("data-indeterminate")).toBe("false");
		expect(bar()?.getAttribute("aria-valuenow")).toBe("42");
		expect(container.querySelector(".omp-pull-fill")?.getAttribute("style")?.replaceAll(" ", "")).toBe("width:42%");
		expect(stage()).toBe("Downloading ollama...");
		expect(container.textContent).toContain("42%");
	});

	it("clamps and rounds the percent", async () => {
		await mount(<InstallProgressBar progress={progress({ stage: "Downloading", percent: 120.4 })} />);
		expect(bar()?.getAttribute("aria-valuenow")).toBe("100");
	});

	it("renders installer output as one plain line", async () => {
		await mount(
			<InstallProgressBar progress={progress({ stage: "\u001b[1m<b>Downloading</b>\u001b[0m\nsecond line" })} />,
		);
		expect(stage()).toBe("<b>Downloading</b>");
		expect(container.querySelector("b")).toBeNull();
	});

	it("offers no cancel control", async () => {
		await mount(<InstallProgressBar progress={progress({ stage: "Downloading", percent: 10 })} />);
		expect(container.querySelector("button")).toBeNull();
	});
});
