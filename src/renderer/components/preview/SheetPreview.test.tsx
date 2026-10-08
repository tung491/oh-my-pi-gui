/**
 * SheetPreview: the parse waits for a yield (nothing parses during render),
 * hidden sheets get no tab, formula cells without a value are marked, the
 * selected sheet survives a refresh by name, the truncation notes, and parse
 * failures reaching `onError`. Same linkedom harness as ThinkingBlock.test.tsx.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { utils, write } from "xlsx";
import { I18nProvider } from "../../lib/i18n";
import type { PreviewContent } from "./renderers";
import SheetPreview from "./SheetPreview";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const FIXTURES = path.resolve(import.meta.dirname, "../../../../e2e/fixtures/document-preview");
const tableXlsx = (): PreviewContent => ({ bytes: new Uint8Array(readFileSync(path.join(FIXTURES, "table.xlsx"))) });
const CSV: PreviewContent = { text: "Region,Revenue\nNorth,120\n", truncated: false };

interface TestElement {
	textContent: string | null;
	getAttribute(name: string): string | null;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): ArrayLike<TestElement>;
	click(): void;
	remove(): void;
}

let container: TestElement;
let root: Root;

function render(content: PreviewContent, onError: (error: unknown) => void = vi.fn()): void {
	root.render(
		<I18nProvider>
			<SheetPreview
				content={content}
				kind={"bytes" in content ? "sheet" : "csv"}
				path="/w/table"
				onError={onError}
			/>
		</I18nProvider>,
	);
}

async function mount(content: PreviewContent, onError?: (error: unknown) => void): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as never);
	await act(async () => render(content, onError));
}

/** Lets pending timers fire and React commit their results. */
async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

const SETTLE_DEADLINE_MS = 5_000;

/**
 * Flushes until `done` holds or a wall-clock deadline passes. Under a parallel
 * run the parse timer can need more than one tick; the callers' assertions
 * decide the outcome either way.
 */
async function settle(done: () => boolean): Promise<void> {
	const deadline = performance.now() + SETTLE_DEADLINE_MS;
	while (!done() && performance.now() < deadline) await flush();
}

/** A Sales + Notes workbook whose Notes sheet holds `note`. */
function salesAndNotes(note: string): PreviewContent {
	const book = utils.book_new();
	utils.book_append_sheet(book, utils.aoa_to_sheet([["Region", "Revenue"]]), "Sales");
	utils.book_append_sheet(book, utils.aoa_to_sheet([[note]]), "Notes");
	return { bytes: new Uint8Array(write(book, { bookType: "xlsx", type: "array" })) };
}

const all = (selector: string): TestElement[] => Array.from(container.querySelectorAll(selector));
const tabs = (): string[] => all('[role="tab"]').map(tab => tab.textContent ?? "");
const selectedTab = (): string | null =>
	container.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null;
const cells = (): string[] => all("td").map(cell => cell.textContent ?? "");

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("SheetPreview", () => {
	it("parses only after a yield, then shows the CSV as a table", async () => {
		await mount(CSV);
		expect(all("table")).toHaveLength(0);

		await settle(() => all("tr").length > 0);

		expect(all("tr")).toHaveLength(2);
		expect(cells()).toEqual(["Region", "Revenue", "North", "120"]);
		expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Sheets");
		expect(container.textContent).not.toContain("Showing the first");
	});

	it("shows a tab per visible sheet and marks a formula without a saved value", async () => {
		await mount(tableXlsx());
		await settle(() => tabs().length > 0);

		expect(tabs()).toEqual(["Sales", "Notes"]);
		expect(selectedTab()).toBe("Sales");
		const formula = all("td").find(cell => cell.textContent === "=SUM(B2:B4)");
		expect(formula?.getAttribute("title")).toBe("Formula without a saved value");
		expect(formula?.getAttribute("class")).toContain("text-(--omp-muted)");
		expect(all("td[title]")).toHaveLength(1);
	});

	it("keeps the selected sheet by name across a refresh and falls back to the first sheet", async () => {
		await mount(tableXlsx());
		await settle(() => tabs().length > 0);
		await act(async () => all('[role="tab"]')[1].click());
		expect(selectedTab()).toBe("Notes");
		expect(cells()).toEqual(["Prepared by Sai ATLAS"]);

		// A refreshed workbook whose Notes text differs, so the wait sees the re-parse land.
		await act(async () => render(salesAndNotes("Revised notes")));
		await settle(() => cells()[0] === "Revised notes");
		expect(selectedTab()).toBe("Notes");
		expect(cells()).toEqual(["Revised notes"]);

		await act(async () => render(CSV));
		await settle(() => tabs().length === 1);
		expect(tabs()).toHaveLength(1);
		expect(cells()[0]).toBe("Region");
	});

	it("notes a truncated CSV read and a sheet larger than the caps", async () => {
		await mount({ text: "a,b\n1,2\n", truncated: true });
		await settle(() => all("tr").length > 0);
		expect(container.textContent).toContain("Only the first 2 MB of this file is shown.");

		const book = utils.book_new();
		const rows = Array.from({ length: 600 }, (_, r) => Array.from({ length: 60 }, (_, c) => r * 60 + c));
		utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Big");
		await act(async () => render({ bytes: new Uint8Array(write(book, { bookType: "xlsx", type: "array" })) }));
		await settle(() => all("tr").length === 500);

		expect(container.textContent).toContain("Showing the first 500 rows and 50 columns.");
		expect(container.textContent).not.toContain("Only the first 2 MB");
		expect(all("tr")).toHaveLength(500);
	});

	it("reports a workbook SheetJS cannot read through onError, after render", async () => {
		const onError = vi.fn();
		await mount({ bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]) }, onError);
		expect(onError).not.toHaveBeenCalled();

		await settle(() => onError.mock.calls.length > 0);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
	});

	it("drops a parse whose content was replaced before the timer fired", async () => {
		const onError = vi.fn();
		await mount({ bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) }, onError);
		await act(async () => render(CSV, onError));
		await settle(() => cells()[0] === "Region");
		// One more tick, so a stale parse that was not cancelled would have reported by now.
		await flush();

		expect(onError).not.toHaveBeenCalled();
		expect(cells()[0]).toBe("Region");
	});
});
