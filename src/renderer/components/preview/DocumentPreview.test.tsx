/**
 * DocumentPreview shell: which channel each kind reads through (always with
 * the target's own tab), the loading/error/unsupported states, the hand-off
 * to injectable renderers, and the event-driven refresh (an `ifChanged`
 * re-read after a matching write, re-rendering the same renderer instance).
 * Same linkedom + react-dom harness as PanelContainer.test.tsx.
 */

import JSZip from "jszip";
import { parseHTML } from "linkedom";
import { act, type ReactElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	IpcFsReadDocumentResult,
	IpcFsReadDocumentStamp,
	IpcFsReadImageResult,
	IpcFsReadResult,
} from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import type { PreviewTarget } from "../../stores/ui";
import { DocumentPreview } from "./DocumentPreview";
import { notifyFileWritten } from "./file-writes";
import type { PreviewRendererProps, PreviewRenderers } from "./renderers";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
const ompWindow = window as unknown as { omp?: unknown };
const initialOmp = ompWindow.omp;

interface TestElement {
	textContent: string | null;
	remove: () => void;
}

let container: TestElement | null = null;
let root: Root | null = null;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

const SETTLE_DEADLINE_MS = 5_000;

/**
 * Flushes until `done` holds or a wall-clock deadline passes; the ZIP guard
 * inflates through real streams, which take many more ticks when the suite
 * runs in parallel, so a fixed tick count starves under load. The callers'
 * assertions decide the outcome either way.
 */
async function settle(done: () => boolean): Promise<void> {
	const deadline = performance.now() + SETTLE_DEADLINE_MS;
	while (!done() && performance.now() < deadline) await flush();
}

async function render(element: ReactElement): Promise<void> {
	if (!root) {
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
	}
	const mounted = root;
	await act(async () => {
		mounted.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	vi.useRealTimers();
	const mounted = root;
	if (mounted) {
		await act(async () => {
			mounted.unmount();
		});
	}
	root = null;
	container?.remove();
	container = null;
	if (initialOmp === undefined) delete ompWindow.omp;
	else ompWindow.omp = initialOmp;
});

let mounts = 0;

function Stub({ content }: PreviewRendererProps) {
	useEffect(() => {
		mounts += 1;
	}, []);
	return (
		<div data-stub="">
			{"bytes" in content ? content.bytes.length : `${content.text.length}:${content.truncated}`}
		</div>
	);
}

const stubRenderers: PreviewRenderers = { docx: Stub, sheet: Stub };

type ReadDocumentMock = Mock<
	(path: string, options?: { tabId?: string; ifChanged?: IpcFsReadDocumentStamp }) => Promise<IpcFsReadDocumentResult>
>;

interface FsMock {
	read: Mock<(path: string, maxBytes?: number, tabId?: string) => Promise<IpcFsReadResult>>;
	readImage: Mock<(path: string, tabId?: string) => Promise<IpcFsReadImageResult>>;
	readDocument: ReadDocumentMock;
}

function installFs(overrides: Partial<FsMock> = {}): FsMock {
	const fs: FsMock = {
		read: vi.fn(async () => ({ ok: true, content: "", truncated: false, binary: false, size: 0 })),
		readImage: vi.fn(async () => ({ ok: false, dataUrl: null, mime: null, size: 0, error: "missing" })),
		readDocument: vi.fn(async () => ({ ok: false, size: 0, mtimeMs: 0, error: "not-a-file" })),
		...overrides,
	};
	ompWindow.omp = { fs };
	return fs;
}

async function zipBytes(content: string): Promise<Uint8Array> {
	return new JSZip().file("a", content).generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function documentReply(bytes: Uint8Array, overrides: Partial<IpcFsReadDocumentResult> = {}): IpcFsReadDocumentResult {
	return {
		ok: true,
		size: bytes.length,
		mtimeMs: 100,
		resolvedPath: "/w/a.docx",
		data: Buffer.from(bytes).toString("base64"),
		signature: "zip",
		...overrides,
	};
}

function pathTarget(path: string, tabId: string | null = "t0"): PreviewTarget {
	return { kind: "path", path, tabId };
}

function previewRoot(): Element | null {
	return document.querySelector("[data-preview-state]") as Element | null;
}

function previewState(): string | null {
	return previewRoot()?.getAttribute("data-preview-state") ?? null;
}

function stubText(): string | null {
	return document.querySelector("[data-stub]")?.textContent ?? null;
}

beforeEach(() => {
	mounts = 0;
});

describe("DocumentPreview channels", () => {
	it("reads markdown through fs.read with the target's tab and renders it", async () => {
		const fs = installFs({
			read: vi.fn(async () => ({
				ok: true,
				content: "# Heading\n\nBody.",
				truncated: false,
				binary: false,
				size: 16,
			})),
		});
		await render(<DocumentPreview target={pathTarget("docs/a.md")} reloadToken={0} renderers={stubRenderers} />);

		expect(fs.read).toHaveBeenCalledWith("docs/a.md", 200_000, "t0");
		expect(previewState()).toBe("text");
		expect(previewRoot()?.getAttribute("data-preview-kind")).toBe("markdown");
		expect(document.querySelector("h1")?.textContent).toBe("Heading");
		expect(fs.readDocument).not.toHaveBeenCalled();
	});

	it("reads a docx through readDocument and hands its bytes to the renderer", async () => {
		const bytes = await zipBytes("b");
		const fs = installFs({ readDocument: vi.fn(async () => documentReply(bytes)) });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => stubText() !== null);

		expect(fs.readDocument).toHaveBeenCalledWith("a.docx", { tabId: "t0" });
		expect(previewState()).toBe("rich");
		expect(stubText()).toBe(String(bytes.length));
	});

	it("reads an image path through readImage, never readDocument", async () => {
		const fs = installFs({
			readImage: vi.fn(async () => ({
				ok: true,
				dataUrl: "data:image/png;base64,AA==",
				mime: "image/png",
				size: 1,
			})),
		});
		await render(<DocumentPreview target={pathTarget("pics/p.png")} reloadToken={0} renderers={stubRenderers} />);

		expect(fs.readImage).toHaveBeenCalledWith("pics/p.png", "t0");
		expect(fs.readDocument).not.toHaveBeenCalled();
		expect(previewState()).toBe("image");
		expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
	});

	it("renders an in-memory image target without reading anything", async () => {
		const fs = installFs();
		await render(
			<DocumentPreview
				target={{ kind: "image", id: 1, dataUrl: "data:image/png;base64,BB==", name: "paste.png" }}
				reloadToken={0}
				renderers={stubRenderers}
			/>,
		);

		expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,BB==");
		expect(fs.read).not.toHaveBeenCalled();
		expect(fs.readImage).not.toHaveBeenCalled();
		expect(fs.readDocument).not.toHaveBeenCalled();
	});

	it("shows the unsupported text for an archive and reads nothing", async () => {
		const fs = installFs();
		await render(<DocumentPreview target={pathTarget("bundle.zip")} reloadToken={0} renderers={stubRenderers} />);

		expect(previewState()).toBe("error");
		expect(previewRoot()?.textContent).toContain("Preview is not available for this type of file.");
		expect(fs.read).not.toHaveBeenCalled();
		expect(fs.readImage).not.toHaveBeenCalled();
		expect(fs.readDocument).not.toHaveBeenCalled();
	});
});

describe("DocumentPreview failures", () => {
	it("refuses a docx whose bytes carry another signature", async () => {
		const bytes = await zipBytes("b");
		installFs({ readDocument: vi.fn(async () => documentReply(bytes, { signature: "pdf" })) });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => previewState() === "error");

		expect(previewState()).toBe("error");
		expect(previewRoot()?.textContent).toContain("This file could not be shown here.");
		expect(stubText()).toBeNull();
	});

	it("shows the too-large text for a too-large reply", async () => {
		installFs({ readDocument: vi.fn(async () => ({ ok: false, size: 0, mtimeMs: 0, error: "too-large" })) });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);

		expect(previewState()).toBe("error");
		expect(previewRoot()?.textContent).toContain("This file is too large to preview here.");
	});

	it("shows the too-large text for a docx over the parse cap", async () => {
		const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
		bytes.set([0x50, 0x4b, 0x03, 0x04]);
		installFs({ readDocument: vi.fn(async () => documentReply(bytes)) });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => previewState() === "error");

		expect(previewRoot()?.textContent).toContain("This file is too large to preview here.");
		expect(stubText()).toBeNull();
	});

	it.each([
		["binary", { ok: true, content: "", truncated: false, binary: true, size: 4 }],
		["unreadable", { ok: false, content: "", truncated: false, binary: false, size: 0, error: "EACCES" }],
	] as const)("shows the failed text for a %s csv", async (_label, reply) => {
		installFs({ read: vi.fn(async () => ({ ...reply })) });
		await render(<DocumentPreview target={pathTarget("table.csv")} reloadToken={0} renderers={stubRenderers} />);

		expect(previewState()).toBe("error");
		expect(previewRoot()?.textContent).toContain("This file could not be shown here.");
	});

	it("passes a truncated csv to the sheet renderer as text", async () => {
		const fs = installFs({
			read: vi.fn(async () => ({ ok: true, content: "a,b\n1,2", truncated: true, binary: false, size: 9_000_000 })),
		});
		await render(<DocumentPreview target={pathTarget("table.csv")} reloadToken={0} renderers={stubRenderers} />);

		expect(fs.read).toHaveBeenCalledWith("table.csv", 2_000_000, "t0");
		expect(previewState()).toBe("rich");
		expect(stubText()).toBe("7:true");
	});
});

describe("DocumentPreview refresh", () => {
	it("re-reads with ifChanged after a matching write and keeps the renderer when unchanged", async () => {
		const bytes = await zipBytes("b");
		const readDocument: ReadDocumentMock = vi.fn(async () => documentReply(bytes));
		installFs({ readDocument });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => stubText() !== null);

		readDocument.mockImplementation(async () => ({
			ok: true,
			unchanged: true,
			size: bytes.length,
			mtimeMs: 100,
			resolvedPath: "/w/a.docx",
		}));
		await act(async () => {
			notifyFileWritten("t0", "/w/a.docx");
		});
		await settle(() => readDocument.mock.calls.length === 2);
		await flush();

		expect(readDocument).toHaveBeenCalledTimes(2);
		expect(readDocument.mock.calls[1]).toEqual([
			"a.docx",
			{ tabId: "t0", ifChanged: { size: bytes.length, mtimeMs: 100 } },
		]);
		expect(previewState()).toBe("rich");
		expect(stubText()).toBe(String(bytes.length));
		expect(mounts).toBe(1);
	});

	it("re-renders the same renderer instance with new bytes after a matching write", async () => {
		const first = await zipBytes("b");
		const second = await zipBytes("a much longer body that changes the archive length");
		const readDocument: ReadDocumentMock = vi.fn(async () => documentReply(first));
		installFs({ readDocument });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => stubText() !== null);

		readDocument.mockImplementation(async () => documentReply(second, { mtimeMs: 200 }));
		await act(async () => {
			notifyFileWritten("t0", "/w/a.docx");
		});
		await settle(() => stubText() === String(second.length));

		expect(readDocument.mock.calls[1]?.[1]).toEqual({ tabId: "t0", ifChanged: { size: first.length, mtimeMs: 100 } });
		expect(stubText()).toBe(String(second.length));
		expect(mounts).toBe(1);
	});

	it("never reads again for another path's write or the passage of time", async () => {
		const bytes = await zipBytes("b");
		const readDocument: ReadDocumentMock = vi.fn(async () => documentReply(bytes));
		installFs({ readDocument });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => stubText() !== null);

		await act(async () => {
			notifyFileWritten("t0", "/w/other.docx");
		});
		vi.useFakeTimers();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		vi.useRealTimers();
		await flush();

		expect(readDocument).toHaveBeenCalledTimes(1);
	});

	it("re-reads in full when the reload token changes", async () => {
		const bytes = await zipBytes("b");
		const readDocument: ReadDocumentMock = vi.fn(async () => documentReply(bytes));
		installFs({ readDocument });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => stubText() !== null);

		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={1} renderers={stubRenderers} />);
		await settle(() => readDocument.mock.calls.length === 2 && stubText() !== null);

		expect(readDocument).toHaveBeenCalledTimes(2);
		expect(readDocument.mock.calls[1]).toEqual(["a.docx", { tabId: "t0" }]);
		expect(stubText()).toBe(String(bytes.length));
	});

	it("ignores Reload while a full read of the same file is still pending", async () => {
		const pending = Promise.withResolvers<IpcFsReadDocumentResult>();
		const readDocument: ReadDocumentMock = vi.fn(() => pending.promise);
		installFs({ readDocument });
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={0} renderers={stubRenderers} />);
		await render(<DocumentPreview target={pathTarget("a.docx")} reloadToken={1} renderers={stubRenderers} />);

		expect(readDocument).toHaveBeenCalledTimes(1);
		expect(previewState()).toBe("loading");

		const bytes = await zipBytes("b");
		await act(async () => {
			pending.resolve(documentReply(bytes));
		});
		await settle(() => stubText() !== null);
		expect(stubText()).toBe(String(bytes.length));
	});

	it("drops a read superseded by a newer target", async () => {
		const stale = Promise.withResolvers<IpcFsReadDocumentResult>();
		const fresh = await zipBytes("fresh body");
		const readDocument: ReadDocumentMock = vi.fn(async path =>
			path === "old.docx" ? stale.promise : documentReply(fresh, { resolvedPath: "/w/new.docx" }),
		);
		installFs({ readDocument });
		await render(<DocumentPreview target={pathTarget("old.docx")} reloadToken={0} renderers={stubRenderers} />);
		await render(<DocumentPreview target={pathTarget("new.docx")} reloadToken={0} renderers={stubRenderers} />);
		await settle(() => stubText() !== null);

		await act(async () => {
			stale.resolve(documentReply(await zipBytes("b"), { resolvedPath: "/w/old.docx" }));
		});
		await flush();
		await flush();

		expect(stubText()).toBe(String(fresh.length));
	});
});
