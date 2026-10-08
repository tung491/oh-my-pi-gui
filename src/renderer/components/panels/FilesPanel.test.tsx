/**
 * FilesPanel preview header: Open externally resolves the previewed path in
 * the tab the preview is pinned to, not the focused one, so a relative path
 * never opens a same-named file in the other pane's workspace. Same linkedom
 * harness as PanelsCrashRepro.test.tsx.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcFsListResult, IpcFsReadResult, IpcOpenPathResult } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { FilesPanel } from "./FilesPanel";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
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

function openExternallyButton(): HTMLElement {
	const button = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("Open"));
	if (!button) throw new Error("Open externally button not rendered");
	return button as unknown as HTMLElement;
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useUiStore.getState().closeFilePreview();
	openPath.mockClear();
	list.mockClear();
	read.mockClear();
});

describe("FilesPanel preview header", () => {
	it("opens the previewed file externally in the tab the preview is pinned to", async () => {
		useUiStore.getState().openFilePreview("notes/a.txt", "pinned-tab");
		await mount(<FilesPanel />);
		await act(async () => {
			openExternallyButton().dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(openPath).toHaveBeenCalledWith("notes/a.txt", { tabId: "pinned-tab" });
	});

	it("opens a preview without a pinned tab against the window workspace", async () => {
		useUiStore.getState().openFilePreview("notes/a.txt");
		await mount(<FilesPanel />);
		await act(async () => {
			openExternallyButton().dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(openPath).toHaveBeenCalledWith("notes/a.txt");
	});
});
