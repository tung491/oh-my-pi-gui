import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
	OLLAMA_REMEDY_COMMANDS,
	type OllamaInstallProgress,
	type OllamaRemedyId,
	type OllamaStatus,
} from "../../../shared/ollama-types";
import { I18nProvider } from "../../lib/i18n";
import { OllamaRow } from "./OllamaRow";

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
	disabled?: boolean;
	remove: () => void;
	click: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
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

function status(overrides: Partial<OllamaStatus>): OllamaStatus {
	return {
		state: "ok",
		baseUrl: "http://127.0.0.1:11434",
		modelCount: 0,
		installedTags: [],
		platform: "linux",
		remedy: null,
		...overrides,
	};
}

interface Calls {
	remedies: OllamaRemedyId[];
	checks: number;
	downloads: number;
}

async function render(
	value: OllamaStatus | null,
	busy: OllamaRemedyId | null = null,
	installProgress: OllamaInstallProgress | null = null,
): Promise<Calls> {
	const calls: Calls = { remedies: [], checks: 0, downloads: 0 };
	await mount(
		<OllamaRow
			busy={busy}
			installProgress={installProgress}
			onCheckAgain={() => calls.checks++}
			onOpenDownload={() => calls.downloads++}
			onRemedy={id => calls.remedies.push(id)}
			status={value}
		/>,
	);
	return calls;
}

function row(): TestElement {
	const found = container.querySelector(".omp-ollama-row");
	if (!found) throw new Error("row not rendered");
	return found;
}

function button(action: string): TestElement | null {
	return container.querySelector(`[data-action="${action}"]`);
}

describe("OllamaRow", () => {
	it("shows the reading state before the first probe", async () => {
		await render(null);
		expect(row().getAttribute("data-state")).toBe("loading");
		expect(row().textContent).toContain("Reading this machine…");
	});

	it("shows a running daemon with its model count and no actions", async () => {
		await render(status({ state: "ok", modelCount: 3 }));
		expect(row().getAttribute("data-tone")).toBe("success");
		expect(row().textContent).toContain("Ollama is running (3 models)");
		expect(container.querySelectorAll("button")).toHaveLength(0);
	});

	it("offers the start remedy with its command on Linux", async () => {
		const calls = await render(status({ state: "stopped", remedy: "linux-start" }));
		expect(row().getAttribute("data-tone")).toBe("warning");
		expect(row().textContent).toContain("Starting its service should be enough.");
		const command = container.querySelector(".omp-ollama-command")?.textContent;
		expect(command).toBe(OLLAMA_REMEDY_COMMANDS["linux-start"]);
		expect(command).toContain("/etc/systemd/system/ollama.service.d/sai-atlas.conf");
		expect(command).toContain('Environment="OLLAMA_NO_CLOUD=1"');
		expect(container.querySelector('[data-note="no-cloud"]')?.textContent).toBe(
			"Sai ATLAS also turns off Ollama's online features, so Ollama stays on this computer.",
		);
		expect(button("remedy")?.textContent).toContain("Start Ollama");
		await act(async () => button("remedy")?.click());
		await act(async () => button("check-again")?.click());
		await act(async () => button("open-download")?.click());
		expect(calls).toEqual({ remedies: ["linux-start"], checks: 1, downloads: 1 });
	});

	it("gives a Linux install without a service the manual start and a re-check", async () => {
		const calls = await render(status({ state: "stopped", remedy: null }));
		expect(row().textContent).toContain("Run “ollama serve” in a terminal, then check again.");
		expect(container.querySelector(".omp-ollama-command")).toBeNull();
		expect(button("remedy")).toBeNull();
		expect(button("check-again")?.disabled).toBe(false);
		await act(async () => button("check-again")?.click());
		expect(calls.checks).toBe(1);
	});

	it("warns that the install remedy runs as root", async () => {
		await render(status({ state: "absent", remedy: "linux-install" }));
		expect(row().getAttribute("data-tone")).toBe("error");
		expect(row().textContent).toContain("Ollama is not installed on this machine.");
		const command = container.querySelector(".omp-ollama-command")?.textContent;
		expect(command).toBe(OLLAMA_REMEDY_COMMANDS["linux-install"]);
		expect(command?.startsWith("curl -fsSL https://ollama.com/install.sh | sh &&\n")).toBe(true);
		expect(command).toContain('Environment="OLLAMA_NO_CLOUD=1"');
		expect(container.querySelector('[data-note="no-cloud"]')).not.toBeNull();
		expect(row().textContent).toContain("as root");
		expect(button("remedy")?.textContent).toContain("Install Ollama");
	});

	it("spins the running remedy and disables every other action", async () => {
		await render(status({ state: "stopped", remedy: "linux-start" }), "linux-start");
		expect(button("remedy")?.querySelector('[role="status"]')).not.toBeNull();
		expect(button("remedy")?.disabled).toBe(true);
		expect(button("check-again")?.disabled).toBe(true);
		expect(button("open-download")?.disabled).toBe(true);
	});

	it("shows the waiting install state while its own install has no frame yet", async () => {
		await render(status({ state: "absent", remedy: "linux-install" }), "linux-install");
		const bar = container.querySelector("[data-install-progress]");
		expect(bar?.textContent).toContain("Waiting for authorization…");
		expect(bar?.querySelector("button")).toBeNull();
		// The bar sits under the remedy buttons, leaving the command block in place.
		expect(container.querySelector(".omp-ollama-command")).not.toBeNull();
	});

	it("shows a live install frame even when another window started the install", async () => {
		await render(status({ state: "absent", remedy: "linux-install" }), null, {
			stage: "Downloading ollama...",
			percent: 42,
			done: false,
		});
		expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
		expect(button("remedy")?.disabled).toBe(false);
	});

	it("hides the install bar on a done frame or when the install is no longer offered", async () => {
		// Busy too: the done frame lands just before this window's remedy result.
		await render(status({ state: "absent", remedy: "linux-install" }), "linux-install", {
			stage: "Install complete.",
			percent: -1,
			done: true,
		});
		expect(container.querySelector("[data-install-progress]")).toBeNull();
		await act(async () => {
			root.unmount();
		});
		container.remove();
		await render(status({ state: "stopped", remedy: "linux-start" }), "linux-start", {
			stage: "Downloading ollama...",
			percent: 42,
			done: false,
		});
		expect(container.querySelector("[data-install-progress]")).toBeNull();
	});
});
