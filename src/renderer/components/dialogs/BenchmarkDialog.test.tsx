/**
 * BenchmarkDialog seeds its model list from the session's live model, but only
 * when that model belongs to a provider the GUI offers.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { BenchmarkDialog } from "./BenchmarkDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let root: Root | null = null;

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<BenchmarkDialog open onClose={() => {}} />
			</I18nProvider>,
		);
	});
}

function seeded(model: string): boolean {
	const label = translate("benchmark.removeModel", { model });
	return Array.from(document.body.querySelectorAll("button")).some(
		button => button.getAttribute("aria-label") === label,
	);
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
});

describe("BenchmarkDialog", () => {
	it("seeds the run with the session's Ollama model", async () => {
		useModelStore.setState({ model: { provider: "ollama", id: "qwen3:8b" } });
		await mount();
		expect(seeded("ollama/qwen3:8b")).toBe(true);
	});

	it("does not seed a model from a provider the GUI no longer offers", async () => {
		useModelStore.setState({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
		await mount();
		expect(seeded("anthropic/claude-sonnet-4-5")).toBe(false);
	});
});
