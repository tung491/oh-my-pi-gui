import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcFsReadPdfResult } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { AttachmentCard } from "./AttachmentCard";
import { AttachmentStrip } from "./AttachmentStrip";

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
	click: () => void;
	getAttribute: (name: string) => string | null;
	dispatchEvent: (event: unknown) => boolean;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

type ReadPdf = (path: string) => Promise<IpcFsReadPdfResult>;

/** Installs a `window.omp.fs.readPdf` test double on the linkedom window. */
function stubReadPdf(readPdf: ReadPdf): void {
	(window as unknown as { omp: unknown }).omp = { fs: { readPdf } };
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

function query(selector: string): TestElement | null {
	return container.querySelector(selector);
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
	delete (window as unknown as { omp?: unknown }).omp;
	vi.restoreAllMocks();
});

describe("AttachmentCard", () => {
	it("shows the name and uses the full path as the tooltip", async () => {
		await mount(<AttachmentCard name="quarterly-report.docx" kind="word" path="/home/me/quarterly-report.docx" />);

		expect(query("figcaption")?.textContent).toBe("quarterly-report.docx");
		expect(query("figure")?.getAttribute("title")).toBe("/home/me/quarterly-report.docx");
		expect(query("figure")?.getAttribute("role")).toBe("listitem");
	});

	it("falls back to the name as the tooltip without a path", async () => {
		await mount(<AttachmentCard name="photo.png" kind="image" preview="data:image/png;base64,AAAA" />);

		expect(query("figure")?.getAttribute("title")).toBe("photo.png");
	});

	it("calls onRemove from a labelled remove button", async () => {
		const onRemove = vi.fn();
		await mount(<AttachmentCard name="song.mp3" kind="audio" path="/music/song.mp3" onRemove={onRemove} />);

		const button = query("button");
		expect(button?.getAttribute("type")).toBe("button");
		expect(button?.getAttribute("aria-label")).toBe("Remove song.mp3");
		await act(async () => {
			button?.click();
		});
		expect(onRemove).toHaveBeenCalledTimes(1);
	});

	it("has no remove button without onRemove", async () => {
		await mount(<AttachmentCard name="song.mp3" kind="audio" path="/music/song.mp3" />);

		expect(query("button")).toBeNull();
	});

	it("shows an image card's preview", async () => {
		await mount(<AttachmentCard name="photo.png" kind="image" preview="data:image/png;base64,AAAA" />);

		expect(query("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
	});

	it("shows a spinner instead of the preview while the file is being read", async () => {
		await mount(<AttachmentCard name="photo.png" kind="image" path="/pics/photo.png" loading onRemove={() => {}} />);

		expect(query("img")).toBeNull();
		expect(query('[role="status"]')?.getAttribute("aria-label")).toBe("Loading preview…");
		expect(query("figcaption")?.textContent).toBe("photo.png");
		expect(query("button")).not.toBeNull();
	});

	it("opens the file from a labelled preview button", async () => {
		const onOpen = vi.fn();
		const onRemove = vi.fn();
		await mount(
			<AttachmentCard name="report.pdf" kind="word" path="/docs/report.pdf" onOpen={onOpen} onRemove={onRemove} />,
		);

		const open = query('button[aria-label="Preview report.pdf"]');
		expect(open?.getAttribute("type")).toBe("button");
		await act(async () => {
			open?.click();
		});
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onRemove).not.toHaveBeenCalled();
	});

	it("keeps the remove button outside the preview button and does not open from it", async () => {
		const onOpen = vi.fn();
		const onRemove = vi.fn();
		await mount(<AttachmentCard name="report.pdf" kind="word" onOpen={onOpen} onRemove={onRemove} />);

		expect(query("button button")).toBeNull();
		expect(query('button[aria-label="Preview report.pdf"] figcaption')).toBeNull();
		await act(async () => {
			query('button[aria-label="Remove report.pdf"]')?.click();
		});
		expect(onRemove).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("has no preview button without onOpen", async () => {
		await mount(<AttachmentCard name="report.pdf" kind="word" path="/docs/report.pdf" />);

		expect(query('button[aria-label="Preview report.pdf"]')).toBeNull();
	});

	it("has no preview button while the file is being read", async () => {
		const onOpen = vi.fn();
		await mount(<AttachmentCard name="photo.png" kind="image" path="/pics/photo.png" loading onOpen={onOpen} />);

		expect(query('button[aria-label="Preview photo.png"]')).toBeNull();
		expect(query("button")).toBeNull();
	});

	it("gives an unknown file the generic icon and no image", async () => {
		await mount(<AttachmentCard name="scene.blend" kind="file" path="/work/scene.blend" />);

		expect(query("img")).toBeNull();
		expect(query("svg.lucide-file")).not.toBeNull();
	});

	it("shows a spinner while a PDF's first page loads", async () => {
		const requested: string[] = [];
		stubReadPdf(path => {
			requested.push(path);
			return new Promise<IpcFsReadPdfResult>(() => {});
		});
		await mount(<AttachmentCard name="spec.pdf" kind="pdf" path="/docs/spec-loading.pdf" />);

		expect(requested).toEqual(["/docs/spec-loading.pdf"]);
		expect(query('[role="status"]')?.getAttribute("aria-label")).toBe("Loading preview…");
		expect(query(".animate-spin")).not.toBeNull();
	});

	it("falls back to the PDF icon when the preview cannot be read", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		stubReadPdf(async () => ({ ok: false, size: 0, error: "Not a PDF file" }));
		await mount(<AttachmentCard name="fake.pdf" kind="pdf" path="/docs/fake.pdf" />);
		await act(async () => {
			await Promise.resolve();
		});

		expect(query('[role="status"]')).toBeNull();
		expect(query("img")).toBeNull();
		expect(query("svg.lucide-file-text")).not.toBeNull();
		expect(container.textContent).toContain("Preview unavailable");
	});
});

describe("AttachmentStrip", () => {
	it("lays cards out as a scrolling list", async () => {
		await mount(
			<AttachmentStrip>
				<AttachmentCard name="a.zip" kind="archive" />
				<AttachmentCard name="b.mp4" kind="video" />
			</AttachmentStrip>,
		);

		const list = query('[role="list"]');
		expect(list?.getAttribute("class")).toContain("overflow-x-auto");
		expect(list?.querySelectorAll('[role="listitem"]')).toHaveLength(2);
	});
});
