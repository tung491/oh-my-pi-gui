/**
 * PdfPreview: the page layout and its limits, drawing only near the viewport,
 * freeing pages that leave it, and handing each document's teardown to the
 * right moment (unmount, or after a refreshed document replaced it). pdf.js
 * and IntersectionObserver are faked; the harness is ThinkingBlock.test.tsx's.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import type { PdfDocumentHandle } from "../../lib/pdfjs";
import PdfPreview from "./PdfPreview";
import type { PreviewContent } from "./renderers";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove(): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): TestElement[];
}

interface TestCanvas extends TestElement {
	width: number;
	height: number;
}

/** Records observed slots; `show` plays an intersection change. */
class FakeObserver {
	static current: FakeObserver | null = null;
	readonly targets: TestElement[] = [];
	disconnected = false;
	constructor(readonly callback: (entries: Array<{ target: TestElement; isIntersecting: boolean }>) => void) {
		FakeObserver.current = this;
	}
	observe(target: TestElement): void {
		this.targets.push(target);
	}
	disconnect(): void {
		this.disconnected = true;
	}
	show(pages: number[], hidden: number[] = []): void {
		const slot = (page: number) => {
			const target = this.targets.find(item => item.getAttribute("data-page") === String(page));
			if (!target) throw new Error(`no slot for page ${page}`);
			return target;
		};
		this.callback([
			...pages.map(page => ({ target: slot(page), isIntersecting: true })),
			...hidden.map(page => ({ target: slot(page), isIntersecting: false })),
		]);
	}
}

interface FakeDoc {
	handle: PdfDocumentHandle;
	destroy: ReturnType<typeof vi.fn>;
	resolve(): void;
	reject(error: Error): void;
	rendered: number[];
	cancelled: number[];
}

/** A fake document of `numPages` pages; `sizeOf` gives each page's scale-1 size. */
function fakeDoc(numPages: number, sizeOf: (page: number) => { width: number; height: number }): FakeDoc {
	const deferred = Promise.withResolvers<never>();
	const rendered: number[] = [];
	const cancelled: number[] = [];
	const proxy = {
		numPages,
		getPage: async (page: number) => ({
			getViewport: ({ scale }: { scale: number }) => ({
				width: sizeOf(page).width * scale,
				height: sizeOf(page).height * scale,
			}),
			render: () => {
				rendered.push(page);
				const task = Promise.withResolvers<void>();
				return {
					promise: task.promise,
					cancel: () => {
						cancelled.push(page);
						task.reject(new Error("Rendering cancelled"));
					},
				};
			},
		}),
	};
	const destroy = vi.fn(async () => {});
	return {
		handle: { promise: deferred.promise, destroy },
		destroy,
		resolve: () => deferred.resolve(proxy as never),
		reject: error => deferred.reject(error),
		rendered,
		cancelled,
	};
}

const A4 = () => ({ width: 595, height: 842 });

let container: TestElement;
let root: Root;
let onError: ReturnType<typeof vi.fn>;
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

beforeEach(() => {
	onError = vi.fn();
	FakeObserver.current = null;
	globals.IntersectionObserver = FakeObserver;
	Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 840 });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	delete globals.IntersectionObserver;
	if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
	else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

async function show(content: PreviewContent, open: (bytes: Uint8Array) => PdfDocumentHandle): Promise<void> {
	await act(async () => {
		root.render(
			<I18nProvider>
				<PdfPreview content={content} kind="pdf" path="/docs/a.pdf" onError={onError} openDocument={open} />
			</I18nProvider>,
		);
	});
	await flush();
}

const canvas = (page: number) => container.querySelector(`canvas[data-page="${page}"]`) as TestCanvas | null;

describe("PdfPreview", () => {
	it("lays out the first 50 pages, notes the rest and draws only near the visible page", async () => {
		const doc = fakeDoc(60, A4);
		await show({ bytes: new Uint8Array([1]) }, () => doc.handle);
		doc.resolve();
		await flush();

		expect(container.querySelectorAll("[data-pdf-slot]")).toHaveLength(50);
		expect(container.textContent).toContain("Pages not shown here: 10");
		await act(async () => FakeObserver.current?.show([5]));
		await flush();

		expect([...doc.rendered].sort((a, b) => a - b)).toEqual([4, 5, 6]);
		// 816 CSS px at dpr 1 across a 595 pt page.
		expect(canvas(5)?.width).toBe(816);
		expect(canvas(9)?.width).not.toBe(816);
		expect(onError).not.toHaveBeenCalled();
	});

	it("cancels and frees the pages that scroll away", async () => {
		const doc = fakeDoc(20, A4);
		await show({ bytes: new Uint8Array([1]) }, () => doc.handle);
		doc.resolve();
		await flush();
		await act(async () => FakeObserver.current?.show([5]));
		await flush();

		await act(async () => FakeObserver.current?.show([15], [5]));
		await flush();

		expect(doc.cancelled.sort((a, b) => a - b)).toEqual([4, 5, 6]);
		expect(canvas(5)?.width).toBe(0);
		expect(canvas(5)?.height).toBe(0);
		expect(doc.rendered).toEqual(expect.arrayContaining([14, 15, 16]));
		expect(onError).not.toHaveBeenCalled();
	});

	it("holds no bitmap for a page it has not drawn", async () => {
		const doc = fakeDoc(20, A4);
		await show({ bytes: new Uint8Array([1]) }, () => doc.handle);
		doc.resolve();
		await flush();
		await act(async () => FakeObserver.current?.show([5]));
		await flush();

		// A canvas without a size holds the default 300×150 bitmap, so every
		// undrawn page starts as freed as one that scrolled away.
		expect([canvas(9)?.getAttribute("width"), canvas(9)?.getAttribute("height")]).toEqual(["0", "0"]);
		expect(canvas(5)?.width).toBe(816);
		expect(onError).not.toHaveBeenCalled();
	});

	it("skips a page with an extreme aspect ratio and says so", async () => {
		const doc = fakeDoc(2, page => (page === 2 ? { width: 10, height: 14_400 } : A4()));
		await show({ bytes: new Uint8Array([1]) }, () => doc.handle);
		doc.resolve();
		await flush();
		await act(async () => FakeObserver.current?.show([1, 2]));
		await flush();

		expect(container.textContent).toContain("Page 2 is too large to show here.");
		expect(canvas(2)).toBeNull();
		expect(doc.rendered).toEqual([1]);
	});

	it("reports a document that does not open", async () => {
		const doc = fakeDoc(1, A4);
		await show({ bytes: new Uint8Array([1]) }, () => doc.handle);
		doc.reject(new Error("The PDF took too long to open"));
		await flush();

		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("keeps the old document until a refreshed one replaces it, then destroys the old one", async () => {
		const first = fakeDoc(1, A4);
		const second = fakeDoc(2, A4);
		const opened: Uint8Array[] = [];
		const docs = [first, second];
		const open = (bytes: Uint8Array) => {
			opened.push(bytes);
			const next = docs.shift();
			if (!next) throw new Error("unexpected open");
			return next.handle;
		};
		await show({ bytes: new Uint8Array([1]) }, open);
		first.resolve();
		await flush();

		await show({ bytes: new Uint8Array([2]) }, open);
		expect(container.querySelectorAll("[data-pdf-slot]")).toHaveLength(1);
		expect(first.destroy).not.toHaveBeenCalled();

		second.resolve();
		await flush();
		expect(container.querySelectorAll("[data-pdf-slot]")).toHaveLength(2);
		expect(first.destroy).toHaveBeenCalledTimes(1);
		expect(second.destroy).not.toHaveBeenCalled();

		await act(async () => {
			root.render(<div />);
		});
		expect(second.destroy).toHaveBeenCalledTimes(1);
		expect(FakeObserver.current?.disconnected).toBe(true);
		expect(opened).toHaveLength(2);
	});

	it("destroys a document whose state update React dropped before committing it", async () => {
		const doc = fakeDoc(1, A4);
		const opened = Promise.withResolvers<void>();
		const handle: PdfDocumentHandle = {
			promise: doc.handle.promise.then(proxy => {
				opened.resolve();
				return proxy;
			}),
			destroy: doc.destroy,
		};
		await show({ bytes: new Uint8Array([1]) }, () => handle);
		doc.resolve();
		// Outside act: the load finishes and calls setPdf, but React only
		// schedules that render; microtasks never let it commit.
		await opened.promise;
		for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
		expect(container.querySelector("[data-pdf-slot]")).toBeNull();

		await act(async () => {
			root.unmount();
		});
		root = createRoot(container as unknown as Element);

		expect(doc.destroy).toHaveBeenCalledTimes(1);
	});

	it("destroys a document still opening when it unmounts", async () => {
		const doc = fakeDoc(1, A4);
		await show({ bytes: new Uint8Array([1]) }, () => doc.handle);
		await act(async () => {
			root.render(<div />);
		});

		expect(doc.destroy).toHaveBeenCalledTimes(1);
		expect(onError).not.toHaveBeenCalled();
	});
});
