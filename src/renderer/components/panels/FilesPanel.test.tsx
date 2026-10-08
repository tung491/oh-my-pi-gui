/**
 * File preview header: Open externally and Insert @mention act on the tab the
 * preview is pinned to, not the focused one, so a relative path never resolves
 * in the other pane's workspace; opening the same file again re-checks it.
 * Same linkedom harness as PanelsCrashRepro.test.tsx.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcFsListResult, IpcFsReadResult, IpcOpenPathResult } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { FilePreviewPanel } from "./FilesPanel";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
// The panel builds its mention event from the global; it must be linkedom's to dispatch.
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const openPath = vi.fn(
	async (path: string, _options?: { tabId?: string }): Promise<IpcOpenPathResult> => ({
		ok: true,
		resolvedPath: `/ws/${path}`,
	}),
);
const list = vi.fn(async (): Promise<IpcFsListResult> => ({ ok: true, entries: [], truncated: false }));
const read = vi.fn(
	async (): Promise<IpcFsReadResult> => ({ ok: true, content: "hello", truncated: false, binary: false, size: 5 }),
);
const ompWindow = window as unknown as { omp: unknown };
ompWindow.omp = { system: { openPath }, fs: { list, read } };

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function buttonWithText(text: string): HTMLElement {
	const button = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes(text));
	if (!button) throw new Error(`${text} button not rendered`);
	return button as unknown as HTMLElement;
}

function openExternallyButton(): HTMLElement {
	return buttonWithText("Open");
}

function captureMentions(): { detail: unknown }[] {
	const seen: { detail: unknown }[] = [];
	const listener = (event: Event) => seen.push({ detail: (event as CustomEvent).detail });
	window.addEventListener("omp:insert-mention", listener);
	cleanups.push(() => window.removeEventListener("omp:insert-mention", listener));
	return seen;
}

const cleanups: (() => void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useUiStore.getState().closeFilePreview();
	setFocusedSessionRuntime(null);
	openPath.mockClear();
	list.mockClear();
	read.mockClear();
});

describe("FilesPanel preview header", () => {
	it("opens the previewed file externally in the tab the preview is pinned to", async () => {
		useUiStore.getState().openFilePreview("notes/a.txt", "pinned-tab");
		await mount(<FilePreviewPanel />);
		await act(async () => {
			openExternallyButton().dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(openPath).toHaveBeenCalledWith("notes/a.txt", { tabId: "pinned-tab" });
	});

	it("opens a preview without a pinned tab against the window workspace", async () => {
		useUiStore.getState().openFilePreview("notes/a.txt");
		await mount(<FilePreviewPanel />);
		await act(async () => {
			openExternallyButton().dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(openPath).toHaveBeenCalledWith("notes/a.txt");
	});
});

describe("FilePreviewPanel insert mention", () => {
	it("inserts the mention into the pinned tab's composer, not the focused one", async () => {
		setFocusedSessionRuntime("focused-tab");
		useUiStore.getState().openFilePreview("notes/a.txt", "pinned-tab");
		const mentions = captureMentions();
		await mount(<FilePreviewPanel />);
		await act(async () => {
			buttonWithText("Insert @mention").dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});

		expect(mentions).toEqual([{ detail: { path: "notes/a.txt", tabId: "pinned-tab" } }]);
		expect(useUiStore.getState().filePreview).toBeNull();
	});

	it("falls back to the focused tab for a preview pinned to no tab", async () => {
		setFocusedSessionRuntime("focused-tab");
		useUiStore.getState().openFilePreview("notes/a.txt");
		const mentions = captureMentions();
		await mount(<FilePreviewPanel />);
		await act(async () => {
			buttonWithText("Insert @mention").dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});

		expect(mentions).toEqual([{ detail: { path: "notes/a.txt", tabId: "focused-tab" } }]);
	});
});

describe("FilePreviewPanel re-open", () => {
	it("re-reads the previewed file when the same target is opened again", async () => {
		useUiStore.getState().openFilePreview("notes/a.txt", "pinned-tab");
		await mount(<FilePreviewPanel />);
		expect(read).toHaveBeenCalledTimes(1);

		read.mockImplementationOnce(async () => ({
			ok: true,
			content: "changed",
			truncated: false,
			binary: false,
			size: 7,
		}));
		await act(async () => {
			useUiStore.getState().openFilePreview("notes/a.txt", "pinned-tab");
		});
		const deadline = performance.now() + 2_000;
		while (document.querySelector("pre")?.textContent !== "changed" && performance.now() < deadline) await flush();

		expect(read).toHaveBeenCalledTimes(2);
		expect(document.querySelector("pre")?.textContent).toBe("changed");
	});
});
