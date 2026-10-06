import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelChoice, PullProgress } from "../../../shared/ollama-types";
import { I18nProvider } from "../../lib/i18n";
import { MachineFacts } from "./MachineFacts";
import { ModelCard, type ModelCardProps } from "./ModelCard";

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

function choice(overrides: Partial<ModelChoice> = {}): ModelChoice {
	return {
		tag: "qwen3:8b",
		label: "Qwen3 8B",
		params: 8,
		activeParams: 4.5,
		sizeBytes: 5.2e9,
		needBytes: 7.6e9,
		fit: "vram",
		speed: "fast",
		tiers: ["recommended", "maximum"],
		installed: false,
		tight: false,
		...overrides,
	};
}

interface Calls {
	used: string[];
	downloads: string[];
	cancels: string[];
}

async function render(props: Partial<ModelCardProps> = {}): Promise<Calls> {
	const calls: Calls = { used: [], downloads: [], cancels: [] };
	await mount(
		<ModelCard
			choice={choice()}
			downloadDisabled={false}
			onCancel={tag => calls.cancels.push(tag)}
			onDownload={tag => calls.downloads.push(tag)}
			onUse={tag => calls.used.push(tag)}
			picked={false}
			progress={null}
			{...props}
		/>,
	);
	return calls;
}

function button(name: string): TestElement | null {
	return container.querySelector(`[data-action="${name}"]`);
}

function frame(overrides: Partial<PullProgress> = {}): PullProgress {
	return { tag: "qwen3:8b", status: "downloading", completed: 1, total: 4, percent: 25, done: false, ...overrides };
}

describe("ModelCard", () => {
	it("shows its tiers, tag and what it needs from the machine", async () => {
		await render();
		const tiers = container.querySelectorAll(".omp-model-tier").map(tier => tier.textContent);
		expect(tiers).toEqual(["Recommended", "Maximum"]);
		expect(container.textContent).toContain("Qwen3 8B");
		expect(container.textContent).toContain("qwen3:8b");
		const terms = container.querySelectorAll("dt").map(term => term.textContent);
		const values = container.querySelectorAll("dd").map(value => value.textContent);
		expect(terms).toEqual(["Parameters", "Active per token", "Download", "Needs", "Runs in", "Speed"]);
		expect(values).toEqual(["8B", "4.5B", "5.2 GB", "7.6 GB", "Graphics memory", "Fast"]);
		expect(container.querySelector("[data-tight]")).toBeNull();
	});

	it("warns when the model is offered only as a tight fit", async () => {
		await render({ choice: choice({ tight: true, fit: "ram", speed: "slow", tiers: ["minimal"] }) });
		expect(container.querySelector("[data-tight]")?.textContent).toBe(
			"Tight fit: this machine may slow down while the model runs.",
		);
	});

	it("offers Download for a model that is not on the machine", async () => {
		const calls = await render();
		expect(container.textContent).toContain("Not downloaded yet.");
		expect(button("use-model")).toBeNull();
		await act(async () => button("download-model")?.click());
		expect(calls.downloads).toEqual(["qwen3:8b"]);
	});

	it("labels the Download button as an action, apart from the download size, in Vietnamese", async () => {
		globals.localStorage = {
			getItem: (key: string) => (key === "omp.lang" ? "vi" : null),
			setItem: () => {},
			removeItem: () => {},
		};
		try {
			await render();
			expect(button("download-model")?.textContent).toBe("Tải về");
			expect(container.textContent).toContain("Dung lượng tải");
		} finally {
			delete globals.localStorage;
		}
	});

	it("disables Download while another model downloads", async () => {
		await render({ downloadDisabled: true });
		expect(button("download-model")?.disabled).toBe(true);
	});

	it("cannot download when Ollama did not say whether the model is there", async () => {
		await render({ choice: choice({ installed: null }) });
		expect(container.textContent).toContain("Already downloaded? Unknown");
		expect(button("download-model")?.disabled).toBe(true);
	});

	it("swaps Download for the progress bar and its Cancel while downloading", async () => {
		const calls = await render({ progress: frame() });
		expect(button("download-model")).toBeNull();
		expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25");
		await act(async () => button("cancel-pull")?.click());
		expect(calls.cancels).toEqual(["qwen3:8b"]);
	});

	it("brings Download back beside a failed download", async () => {
		await render({ progress: frame({ done: true, error: "disk full" }) });
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("disk full");
		expect(button("download-model")).not.toBeNull();
	});

	it("marks a downloaded model ready and picks it on Use", async () => {
		const calls = await render({ choice: choice({ installed: true }) });
		expect(container.textContent).toContain("On this machine, ready to use");
		expect(container.querySelector(".omp-model-ready-badge")).not.toBeNull();
		expect(button("download-model")).toBeNull();
		expect(button("use-model")?.getAttribute("aria-pressed")).toBe("false");
		await act(async () => button("use-model")?.click());
		expect(calls.used).toEqual(["qwen3:8b"]);
	});

	it("rings the picked card", async () => {
		await render({ choice: choice({ installed: true }), picked: true });
		const article = container.querySelector("article");
		expect(article?.getAttribute("data-picked")).toBe("true");
		expect(button("use-model")?.getAttribute("aria-pressed")).toBe("true");
	});
});

describe("MachineFacts", () => {
	it("draws two placeholder slots while the machine is read", async () => {
		await mount(<MachineFacts machine={undefined} />);
		expect(container.querySelectorAll("[data-fact]")).toHaveLength(2);
		expect(container.querySelectorAll(".omp-skeleton")).toHaveLength(2);
	});

	it("reports memory and a discrete GPU", async () => {
		await mount(
			<MachineFacts
				machine={{ ramBytes: 16e9, vramBytes: 8e9, gpuName: "RTX 3070", unifiedMemory: false, threads: 8 }}
			/>,
		);
		expect(container.textContent).toContain("Memory: 16.0 GB");
		expect(container.textContent).toContain("Graphics: RTX 3070, 8.0 GB");
	});

	it("reports shared memory on Apple Silicon and no GPU elsewhere", async () => {
		await mount(
			<MachineFacts machine={{ ramBytes: 16e9, vramBytes: null, gpuName: "M2", unifiedMemory: true, threads: 8 }} />,
		);
		expect(container.textContent).toContain("Graphics: M2, sharing system memory");
		await act(async () => {
			root.render(
				<I18nProvider>
					<MachineFacts
						machine={{ ramBytes: 8e9, vramBytes: null, gpuName: null, unifiedMemory: false, threads: 8 }}
					/>
				</I18nProvider>,
			);
		});
		expect(container.textContent).toContain("Graphics: no dedicated GPU");
	});

	it("reports nothing when the machine could not be read", async () => {
		await mount(<MachineFacts machine={null} />);
		expect(container.textContent).toBe("");
		expect(container.querySelectorAll(".omp-skeleton")).toHaveLength(0);
	});
});
