/**
 * The default renderer registry: pdf and sheet load lazily, docx and pptx
 * have no entry yet (the shell shows "not available"), and csv text renders
 * through the sheet entry. Same linkedom harness as ThinkingBlock.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { DEFAULT_PREVIEW_RENDERERS } from "./renderers";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove(): void;
	querySelectorAll(selector: string): TestElement[];
}

const LAZY = Symbol.for("react.lazy");

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
	it("registers lazy pdf and sheet renderers and nothing else yet", () => {
		expect(Object.keys(DEFAULT_PREVIEW_RENDERERS).sort()).toEqual(["pdf", "sheet"]);
		for (const renderer of Object.values(DEFAULT_PREVIEW_RENDERERS)) {
			expect((renderer as unknown as { $$typeof: symbol }).$$typeof).toBe(LAZY);
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
