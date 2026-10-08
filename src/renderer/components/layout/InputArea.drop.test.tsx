/**
 * Files dropped on the composer, or picked with the paperclip, become cards:
 * images as image attachments (a spinner card while each is read), every other
 * file as a document the send names by its quoted path. Drags without files
 * (text, links, tabs) keep their default behaviour.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcFsReadImageResult } from "../../../shared/ipc-types";
import { isFileDrag } from "../../lib/dropped-files";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { InputArea } from "./InputArea";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
elementPrototype.getBoundingClientRect = () => ({
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
	toJSON: () => ({}),
});
Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

const PNG_DATA_URL = "data:image/png;base64,iVBOR";
const PNG_READ: IpcFsReadImageResult = { ok: true, dataUrl: PNG_DATA_URL, mime: "image/png", size: 5 };

interface TestNode {
	dispatchEvent(event: object): boolean;
	querySelector(selector: string): TestNode | null;
	querySelectorAll(selector: string): ArrayLike<TestNode>;
	getAttribute(name: string): string | null;
	textContent: string | null;
	remove(): void;
}

let container: TestNode;
let root: Root;
let prompt: Mock;
let readImage: Mock<(path: string) => Promise<IpcFsReadImageResult>>;
let showOpenDialog: Mock<() => Promise<string[] | null>>;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	prompt = vi.fn(async () => ok());
	readImage = vi.fn(async () => PNG_READ);
	showOpenDialog = vi.fn(async () => null);
	(window as unknown as Record<string, unknown>).omp = {
		fs: {
			list: vi.fn(async () => ({ entries: [] })),
			readImage,
			// PDF cards ask for their first page; these tests look at the cards only.
			readPdf: vi.fn(() => new Promise(() => {})),
		},
		system: { showOpenDialog },
		events: { onCommandsUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			prompt,
			followUp: vi.fn(async () => ok()),
			steer: vi.fn(async () => ok()),
			abort: vi.fn(async () => ok()),
		},
		quickEntry: {
			ack: vi.fn(async () => {}),
			claimPending: vi.fn(async () => []),
			returnToBar: vi.fn(async () => {}),
		},
	};
	useSessionStore.setState({
		status: "ready",
		isStreaming: false,
		queuedMessageCount: 0,
		cwd: "/tmp",
		sessionId: "s1",
		sessionName: null,
	});
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
	const element = document.createElement("div");
	document.body.appendChild(element);
	container = element as unknown as TestNode;
	root = createRoot(element as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<InputArea />
			</I18nProvider>,
		);
	});
	await flush();
}

/** The parts of a DataTransfer the drop handlers read. */
function dataTransfer(types: string[], data: Record<string, string> = {}) {
	return { types, files: [], dropEffect: "none", getData: (format: string) => data[format] ?? "" };
}

/** Dispatches a drag event on `target`; returns whether the page cancelled it. */
async function drag(
	type: "dragenter" | "dragover" | "dragleave" | "drop",
	transfer: ReturnType<typeof dataTransfer>,
	target: TestNode = textarea(),
): Promise<boolean> {
	const event = new Event(type, { bubbles: true, cancelable: true });
	// linkedom's Event has a getter-only eventPhase React writes to.
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	Object.defineProperty(event, "dataTransfer", { value: transfer });
	await act(async () => {
		target.dispatchEvent(event);
	});
	return event.defaultPrevented;
}

async function click(target: TestNode): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

/**
 * A Tauri-like shell that sends dropped paths natively; returns the push. The
 * app subscribes when the drop module loads, after `window.omp` exists; here
 * `window.omp` is replaced per test, so the subscription is made explicitly.
 */
function nativeDropSource(): (paths: string[]) => void {
	let listener: (paths: string[]) => void = () => {};
	const system = (window as unknown as { omp: { system: Record<string, unknown> } }).omp.system;
	system.onNativeDropPaths = (callback: (paths: string[]) => void) => {
		listener = callback;
		return () => {};
	};
	isFileDrag(null);
	return paths => listener(paths);
}

const textarea = () => container.querySelector("textarea") as TestNode;
const cards = () => Array.from(container.querySelectorAll("figure"));
const cardNames = () => cards().map(card => card.querySelector("figcaption")?.textContent);
const fileDrop = (...paths: string[]) =>
	dataTransfer(["text/uri-list", "Files"], {
		"text/uri-list": paths.map(path => `file://${encodeURI(path)}`).join("\r\n"),
	});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useSettingsStore.getState().reset();
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	useUiStore.setState({ filePreview: null, panelVisible: false, panelTab: "files" });
	vi.restoreAllMocks();
});

describe("InputArea file drop", () => {
	it("turns dropped files into cards and leaves the draft empty", async () => {
		await mount();
		const files = fileDrop("/home/u/Q3 report.pdf", "/home/u/photo.png", "/home/u/song.mp3", "/home/u/backup.zip");

		expect(await drag("dragenter", files)).toBe(true);
		expect(await drag("dragover", files)).toBe(true);
		expect(await drag("drop", files)).toBe(true);
		await flush();

		const composer = useComposerStore.getState();
		expect(composer.draft).toBe("");
		expect(composer.documents.map(document => document.path)).toEqual([
			"/home/u/Q3 report.pdf",
			"/home/u/song.mp3",
			"/home/u/backup.zip",
		]);
		expect(readImage).toHaveBeenCalledWith("/home/u/photo.png");
		expect(composer.images.map(image => image.path)).toEqual(["/home/u/photo.png"]);
		expect(cardNames()).toEqual(["photo.png", "Q3 report.pdf", "song.mp3", "backup.zip"]);
		expect(cards()[0]?.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
		expect(cards()[1]?.getAttribute("title")).toBe("/home/u/Q3 report.pdf");
	});

	it("attaches the paths the shell sends for a WebKitGTK drop, whose URI list the page cannot read", async () => {
		await mount();
		const pushNative = nativeDropSource();
		const webkit = dataTransfer(["text/uri-list", "text/html"]);

		// The shell sends the paths as the drag enters the window, before the page sees it.
		pushNative(["/home/u/song.mp3", "/home/u/backup.zip"]);
		expect(await drag("dragenter", webkit)).toBe(true);
		expect(await drag("dragover", webkit)).toBe(true);
		expect(container.textContent).toContain(en["input.drop.hint"]);
		expect(await drag("drop", webkit)).toBe(true);
		await flush();

		expect(useComposerStore.getState().draft).toBe("");
		expect(cardNames()).toEqual(["song.mp3", "backup.zip"]);
	});

	it("shows an image card with a spinner while the image is read", async () => {
		await mount();
		const { promise, resolve } = Promise.withResolvers<IpcFsReadImageResult>();
		readImage.mockImplementation(() => promise);

		await drag("drop", fileDrop("/home/u/photo.png"));
		await flush();
		expect(cardNames()).toEqual(["photo.png"]);
		expect(cards()[0]?.querySelector('[role="status"]')).not.toBeNull();
		expect(useComposerStore.getState().images).toEqual([]);

		await act(async () => resolve(PNG_READ));
		await flush();
		expect(cards()).toHaveLength(1);
		expect(cards()[0]?.querySelector('[role="status"]')).toBeNull();
		expect(useComposerStore.getState().images).toHaveLength(1);
	});

	it("opens a dropped document in the preview, pinned to the composer's tab", async () => {
		await mount();
		await drag("drop", fileDrop("/home/u/Q3 report.pdf"));
		await flush();

		const open = cards()[0]?.querySelector('button[aria-label="Preview Q3 report.pdf"]');
		expect(open).not.toBeNull();
		await click(open as TestNode);
		const ui = useUiStore.getState();
		expect(ui.filePreview).toEqual({ kind: "path", path: "/home/u/Q3 report.pdf", tabId: "t0" });
		expect(ui.panelVisible).toBe(true);
		expect(ui.panelTab).toBe("files");
	});

	it("opens a dropped image from its path once read, but offers no preview while it is read", async () => {
		await mount();
		const { promise, resolve } = Promise.withResolvers<IpcFsReadImageResult>();
		readImage.mockImplementation(() => promise);

		await drag("drop", fileDrop("/home/u/photo.png"));
		await flush();
		expect(cards()[0]?.querySelector('button[aria-label="Preview photo.png"]')).toBeNull();

		await act(async () => resolve(PNG_READ));
		await flush();
		const open = cards()[0]?.querySelector('button[aria-label="Preview photo.png"]');
		expect(open).not.toBeNull();
		await click(open as TestNode);
		expect(useUiStore.getState().filePreview).toEqual({ kind: "path", path: "/home/u/photo.png", tabId: "t0" });
	});

	it("opens a pasted image, which has no path, as an in-memory image preview", async () => {
		await mount();
		await act(async () =>
			useComposerStore
				.getState()
				.setImages([{ content: { type: "image", data: "iVBOR", mimeType: "image/png" }, preview: PNG_DATA_URL }]),
		);

		const open = cards()[0]?.querySelector('button[aria-label="Preview attachment 1"]');
		expect(open).not.toBeNull();
		await click(open as TestNode);
		expect(useUiStore.getState().filePreview).toMatchObject({
			kind: "image",
			dataUrl: PNG_DATA_URL,
			name: "attachment 1",
		});
	});

	it("drops a failed image read with an error toast", async () => {
		await mount();
		readImage.mockImplementation(async () => ({
			ok: false,
			dataUrl: null,
			mime: null,
			size: 0,
			error: "not an image",
		}));

		await drag("drop", fileDrop("/home/u/broken.png"));
		await flush();

		expect(cards()).toHaveLength(0);
		expect(useComposerStore.getState().images).toEqual([]);
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toEqual([en["input.attach.failed"]]);
	});

	it("discards an image whose spinner card was removed", async () => {
		await mount();
		const { promise, resolve } = Promise.withResolvers<IpcFsReadImageResult>();
		readImage.mockImplementation(() => promise);

		await drag("drop", fileDrop("/home/u/photo.png"));
		await flush();
		await click(cards()[0]?.querySelector("button") as TestNode);
		expect(cards()).toHaveLength(0);

		await act(async () => resolve(PNG_READ));
		await flush();
		expect(cards()).toHaveLength(0);
		expect(useComposerStore.getState().images).toEqual([]);
	});

	it("does not attach the same document twice", async () => {
		await mount();
		await drag("drop", fileDrop("/home/u/a.pdf"));
		await drag("drop", fileDrop("/home/u/a.pdf", "/home/u/b.txt"));
		await flush();

		expect(useComposerStore.getState().documents.map(document => document.name)).toEqual(["a.pdf", "b.txt"]);
	});

	it("warns about a file name no prompt line can hold and leaves it out", async () => {
		await mount();
		await drag("drop", fileDrop("/home/u/a\nb.pdf", "/home/u/fine.pdf"));
		await flush();

		expect(useComposerStore.getState().documents.map(document => document.name)).toEqual(["fine.pdf"]);
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual([en["input.attach.unusualName"]]);
	});

	it("removes a document card from its keyboard-reachable button", async () => {
		await mount();
		await drag("drop", fileDrop("/home/u/a.pdf", "/home/u/b.zip"));
		await flush();

		const remove = cards()[0]?.querySelector('button[aria-label^="Remove"]');
		expect(remove?.getAttribute("aria-label")).toBe("Remove a.pdf");
		expect(remove?.getAttribute("type")).toBe("button");
		await click(remove as TestNode);

		expect(cardNames()).toEqual(["b.zip"]);
		expect(useComposerStore.getState().documents.map(document => document.name)).toEqual(["b.zip"]);
	});

	it("sends images in the payload and documents as quoted lines after the text", async () => {
		await mount();
		await drag("drop", fileDrop("/home/u/photo.png", "/home/u/Q3 report.pdf"));
		await flush();
		await act(async () => useComposerStore.getState().setDraft("Summarise"));

		await click(container.querySelector(`button[aria-label="${en["input.send"]}"]`) as TestNode);
		await flush();

		expect(prompt).toHaveBeenCalledWith("Summarise\n'/home/u/Q3 report.pdf'", [
			{ type: "image", data: "iVBOR", mimeType: "image/png" },
		]);
		expect(cards()).toHaveLength(0);
	});

	it("keeps images in drop order whatever order their reads finish in", async () => {
		await mount();
		const reads = new Map<string, (result: IpcFsReadImageResult) => void>();
		readImage.mockImplementation(path => {
			const { promise, resolve } = Promise.withResolvers<IpcFsReadImageResult>();
			reads.set(path, resolve);
			return promise;
		});
		const imageRead = (name: string): IpcFsReadImageResult => ({
			...PNG_READ,
			dataUrl: `data:image/png;base64,${name}`,
		});

		await drag("drop", fileDrop("/home/u/first.png", "/home/u/second.png", "/home/u/third.png"));
		await flush();
		await act(async () => reads.get("/home/u/third.png")?.(imageRead("third")));
		await act(async () => reads.get("/home/u/second.png")?.(imageRead("second")));
		await flush();

		// The finished reads wait behind the first one, their thumbnails already shown in place.
		expect(useComposerStore.getState().images).toEqual([]);
		expect(cardNames()).toEqual(["first.png", "second.png", "third.png"]);
		expect(cards()[0]?.querySelector('[role="status"]')).not.toBeNull();
		expect(cards()[2]?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,third");

		await act(async () => reads.get("/home/u/first.png")?.(imageRead("first")));
		await flush();
		expect(useComposerStore.getState().images.map(image => image.name)).toEqual([
			"first.png",
			"second.png",
			"third.png",
		]);
		expect(cardNames()).toEqual(["first.png", "second.png", "third.png"]);
	});

	it("lands later images once an earlier one fails or its card is removed", async () => {
		await mount();
		const reads = new Map<string, (result: IpcFsReadImageResult) => void>();
		readImage.mockImplementation(path => {
			const { promise, resolve } = Promise.withResolvers<IpcFsReadImageResult>();
			reads.set(path, resolve);
			return promise;
		});

		await drag("drop", fileDrop("/home/u/a.png", "/home/u/b.png", "/home/u/c.png"));
		await flush();
		await act(async () => reads.get("/home/u/c.png")?.(PNG_READ));
		await act(async () =>
			reads.get("/home/u/a.png")?.({ ok: false, dataUrl: null, mime: null, size: 0, error: "not an image" }),
		);
		await flush();
		expect(useComposerStore.getState().images).toEqual([]);

		await click(cards()[0]?.querySelector("button") as TestNode);
		await flush();
		expect(useComposerStore.getState().images.map(image => image.name)).toEqual(["c.png"]);
		expect(cardNames()).toEqual(["c.png"]);
	});

	it("does not read an image again while it loads or once it is attached", async () => {
		await mount();
		const { promise, resolve } = Promise.withResolvers<IpcFsReadImageResult>();
		readImage.mockImplementation(() => promise);

		await drag("drop", fileDrop("/home/u/photo.png"));
		await drag("drop", fileDrop("/home/u/photo.png"));
		await flush();
		expect(readImage).toHaveBeenCalledTimes(1);
		expect(cardNames()).toEqual(["photo.png"]);

		await act(async () => resolve(PNG_READ));
		await flush();
		await drag("drop", fileDrop("/home/u/photo.png"));
		await flush();
		expect(readImage).toHaveBeenCalledTimes(1);
		expect(useComposerStore.getState().images).toHaveLength(1);
	});

	it("enables send for documents alone", async () => {
		await mount();
		const send = () => container.querySelector(`button[aria-label="${en["input.send"]}"]`);
		expect(send()?.getAttribute("disabled")).not.toBeNull();

		await drag("drop", fileDrop("/home/u/song.mp3"));
		await flush();
		expect(send()?.getAttribute("disabled")).toBeNull();
	});
});

describe("InputArea drags without files", () => {
	it("leaves a plain-text drop to the textarea", async () => {
		await mount();
		const text = dataTransfer(["text/plain"], { "text/plain": "hello" });

		expect(await drag("dragenter", text)).toBe(false);
		expect(await drag("dragover", text)).toBe(false);
		expect(await drag("drop", text)).toBe(false);
		await flush();

		expect(cards()).toHaveLength(0);
		expect(useComposerStore.getState().documents).toEqual([]);
	});

	it("leaves a dropped link to the textarea", async () => {
		await mount();
		const link = dataTransfer(["text/uri-list", "text/plain"], { "text/uri-list": "https://example.com/" });

		expect(await drag("drop", link)).toBe(false);
		await flush();

		expect(cards()).toHaveLength(0);
		expect(container.textContent).not.toContain(en["input.drop.hint"]);
	});

	it("leaves a WebKitGTK link drag unclaimed so the text field inserts it", async () => {
		await mount();
		const pushNative = nativeDropSource();
		const link = dataTransfer(["text/uri-list", "text/html"]);

		// A link carries no local file: the shell sends an empty list.
		pushNative([]);
		expect(await drag("dragenter", link)).toBe(false);
		expect(await drag("dragover", link)).toBe(false);
		expect(container.textContent).not.toContain(en["input.drop.hint"]);
		expect(await drag("drop", link)).toBe(false);
		await flush();

		expect(cards()).toHaveLength(0);
	});

	it("inserts dropped text even while an abandoned file drag's native paths are fresh", async () => {
		await mount();
		const pushNative = nativeDropSource();
		// A file dragged over the window but never dropped on the composer.
		pushNative(["/home/u/abandoned.pdf"]);
		const text = dataTransfer(["text/plain", "text/html"], { "text/plain": "hello" });

		expect(await drag("dragenter", text)).toBe(false);
		expect(await drag("dragover", text)).toBe(false);
		expect(await drag("drop", text)).toBe(false);
		await flush();

		expect(cards()).toHaveLength(0);
		expect(useComposerStore.getState().documents).toEqual([]);
	});

	it("attaches nothing for a tab dropped while native paths are fresh", async () => {
		await mount();
		const pushNative = nativeDropSource();
		pushNative(["/home/u/abandoned.pdf"]);
		const tab = dataTransfer(["application/x-omp-tab"]);

		expect(await drag("dragenter", tab)).toBe(false);
		expect(await drag("dragover", tab)).toBe(false);
		expect(await drag("drop", tab)).toBe(false);
		await flush();

		expect(cards()).toHaveLength(0);
		expect(useComposerStore.getState().documents).toEqual([]);
	});

	it("ignores a tab drag", async () => {
		await mount();
		const tab = dataTransfer(["application/x-omp-tab"]);

		expect(await drag("dragenter", tab)).toBe(false);
		expect(await drag("dragover", tab)).toBe(false);
		expect(container.textContent).not.toContain(en["input.drop.hint"]);
	});
});

describe("InputArea drop hint", () => {
	it("shows while a file drag is over the composer, through child elements", async () => {
		await mount();
		const files = fileDrop("/home/u/a.pdf");
		const shell = container.querySelector(".omp-composer-shell") as TestNode;

		await drag("dragenter", files, shell);
		await drag("dragenter", files);
		await drag("dragleave", files, shell);
		expect(container.textContent).toContain(en["input.drop.hint"]);

		await drag("dragleave", files);
		expect(container.textContent).not.toContain(en["input.drop.hint"]);

		await drag("dragenter", files);
		await drag("drop", files);
		expect(container.textContent).not.toContain(en["input.drop.hint"]);
	});

	it("is not shown and nothing attaches while the shared session is read-only", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ collab: { role: "guest", readOnly: true, participants: [] } }));
		const files = fileDrop("/home/u/a.pdf");

		expect(await drag("dragenter", files)).toBe(false);
		expect(await drag("drop", files)).toBe(false);
		await flush();

		expect(container.textContent).not.toContain(en["input.drop.hint"]);
		expect(useComposerStore.getState().documents).toEqual([]);
	});
});

describe("InputArea paperclip", () => {
	it("attaches picked files as cards instead of writing paths into the draft", async () => {
		await mount();
		showOpenDialog.mockImplementation(async () => ["/home/u/notes.docx", "/home/u/photo.png"]);
		await act(async () => useComposerStore.getState().setDraft("typed"));

		await click(container.querySelector(`button[aria-label="${en["input.attach"]}"]`) as TestNode);
		await flush();
		await flush();

		const composer = useComposerStore.getState();
		expect(composer.draft).toBe("typed");
		expect(composer.documents.map(document => document.path)).toEqual(["/home/u/notes.docx"]);
		expect(composer.images.map(image => image.name)).toEqual(["photo.png"]);
		expect(cardNames()).toEqual(["photo.png", "notes.docx"]);
	});
});
