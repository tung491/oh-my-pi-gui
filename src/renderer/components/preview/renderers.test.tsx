/**
 * The default renderer registry: docx, pdf, pptx and sheet load lazily, and
 * csv text renders through the sheet entry. Same linkedom harness as ThinkingBlock.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ComponentType, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { PanelErrorBoundary } from "../common";
import { DEFAULT_PREVIEW_RENDERERS, lazyWithRetry } from "./renderers";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove(): void;
	querySelectorAll(selector: string): TestElement[];
}

let container: TestElement | null = null;
let root: Root | null = null;

afterEach(async () => {
	const mounted = root;
	if (mounted) {
		await act(async () => {
			mounted.unmount();
		});
	}
	container?.remove();
	root = null;
	container = null;
});

describe("DEFAULT_PREVIEW_RENDERERS", () => {
	it("registers docx, pdf, pptx and sheet renderers", () => {
		expect(Object.keys(DEFAULT_PREVIEW_RENDERERS).sort()).toEqual(["docx", "pdf", "pptx", "sheet"]);
		for (const renderer of Object.values(DEFAULT_PREVIEW_RENDERERS)) {
			expect(typeof renderer).toBe("function");
		}
	});

	it("renders csv text through the sheet entry", async () => {
		const Sheet = DEFAULT_PREVIEW_RENDERERS.sheet;
		if (!Sheet) throw new Error("no sheet renderer");
		const onError = vi.fn();
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		const mounted = createRoot(container as unknown as Element);
		root = mounted;
		await act(async () => {
			mounted.render(
				<I18nProvider>
					<Suspense fallback={null}>
						<Sheet
							content={{ text: "Region,Revenue\nNorth,120\n", truncated: false }}
							kind="csv"
							path="table.csv"
							onError={onError}
						/>
					</Suspense>
				</I18nProvider>,
			);
		});
		const cells = () => (container?.querySelectorAll("td") ?? []).map(cell => cell.textContent);
		// The lazy chunk pulls in SheetJS, which takes a while to transform on first import.
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && !cells().includes("North")) {
			await act(async () => {
				await new Promise(resolve => setTimeout(resolve, 10));
			});
		}

		expect(cells()).toContain("North");
		expect(onError).not.toHaveBeenCalled();
	});
});

async function waitFor(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline && !done()) {
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 5));
		});
	}
}

describe("lazyWithRetry", () => {
	it("imports again on the next mount after a failed chunk load", async () => {
		function Loaded({ label }: { label: string }) {
			return <span data-loaded="">{label}</span>;
		}
		// Offline until the user retries: every import fails, so React's own
		// re-render after an error cannot recover it either.
		let online = false;
		const load = vi.fn(async (): Promise<{ default: ComponentType<{ label: string }> }> => {
			if (!online) throw new Error("Failed to fetch dynamically imported module");
			return { default: Loaded };
		});
		const Lazy = lazyWithRetry(load);
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		const mounted = createRoot(container as unknown as Element);
		root = mounted;
		await act(async () => {
			mounted.render(
				<I18nProvider>
					<PanelErrorBoundary>
						<Suspense fallback={null}>
							<Lazy label="ready" />
						</Suspense>
					</PanelErrorBoundary>
				</I18nProvider>,
			);
		});
		const retry = () =>
			[...document.querySelectorAll("button")].find(button => button.textContent === "Retry") ?? null;
		await waitFor(() => retry() !== null);
		expect(retry()).not.toBeNull();
		const failedCalls = load.mock.calls.length;
		expect(failedCalls).toBeGreaterThan(0);

		online = true;
		await act(async () => {
			retry()?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await waitFor(() => document.querySelector("[data-loaded]") !== null);

		expect(load).toHaveBeenCalledTimes(failedCalls + 1);
		expect(document.querySelector("[data-loaded]")?.textContent).toBe("ready");
	});

	it("loads a successful chunk once across mounts", async () => {
		function Loaded() {
			return <span data-loaded="">once</span>;
		}
		const load = vi.fn(async () => ({ default: Loaded }));
		const Lazy = lazyWithRetry(load);
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		const mounted = createRoot(container as unknown as Element);
		root = mounted;
		for (const key of ["a", "b"]) {
			await act(async () => {
				mounted.render(
					<Suspense key={key} fallback={null}>
						<Lazy />
					</Suspense>,
				);
			});
			await waitFor(() => document.querySelector("[data-loaded]") !== null);
		}

		expect(document.querySelector("[data-loaded]")?.textContent).toBe("once");
		expect(load).toHaveBeenCalledTimes(1);
	});
});
