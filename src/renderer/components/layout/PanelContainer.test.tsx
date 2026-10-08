/**
 * PanelContainer drawer tabs: chat and agent tabs both render the files + logs
 * drawer tabs. Todo/plan/agents/queue moved to the center dock — they must not
 * appear here. Same linkedom + react-dom harness as mode-visibility.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { PanelContainer } from "./PanelContainer";

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
type MatchMedia = (query: string) => {
	matches: boolean;
	addEventListener: (type: string, listener: () => void) => void;
	removeEventListener: (type: string, listener: () => void) => void;
};
const mediaWindow = window as unknown as { matchMedia?: MatchMedia };
const initialMatchMedia = mediaWindow.matchMedia;

interface TestElement {
	textContent: string | null;
	remove: () => void;
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ panelTab: "files", panelVisible: true, filePreview: null, sidebarVisible: true });
	if (initialOmp === undefined) delete ompWindow.omp;
	else ompWindow.omp = initialOmp;
	if (initialMatchMedia === undefined) delete mediaWindow.matchMedia;
	else mediaWindow.matchMedia = initialMatchMedia;
	vi.useRealTimers();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
});

function seedActiveTab(kind: "agent" | "chat"): void {
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work", status: "ready", kind, unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function drawerTabLabels(): string[] {
	return [...document.querySelectorAll("aside button")].map(button => (button.textContent ?? "").trim());
}

function dispatchPointer(element: Element, type: string, clientX: number): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		pointerId: { value: 1 },
	});
	element.dispatchEvent(event);
}

function FileLinkHarness({ content = "[report](docs/report.md)" }: { content?: string }) {
	const panelVisible = useUiStore(s => s.panelVisible);
	return (
		<>
			<MarkdownRenderer content={content} />
			{panelVisible && <PanelContainer />}
		</>
	);
}

function DrawerHarness() {
	const panelVisible = useUiStore(s => s.panelVisible);
	return panelVisible ? <PanelContainer /> : null;
}

describe("PanelContainer drawer tabs", () => {
	it.each(["chat", "agent"] as const)("renders the files and logs tabs in a %s tab", async kind => {
		seedActiveTab(kind);
		useUiStore.setState({ panelTab: "files", panelVisible: true });
		await mount(<PanelContainer />);

		const labels = drawerTabLabels();
		expect(labels).toContain("Files");
		expect(labels).toContain("Logs");
		expect(labels).not.toContain("Diff");
		// The drawer's old live-execution tabs moved to the center dock.
		for (const moved of ["Todo", "Plan", "Agents", "Queue"]) {
			expect(labels).not.toContain(moved);
		}
	});

	it("uses the available window width instead of a fixed narrow drawer", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 2400 });
		seedActiveTab("agent");
		await mount(<PanelContainer />);

		expect((document.querySelector("aside") as HTMLElement | null)?.style.width).toBe("672px");
	});

	it("resizes from the window edge in both directions without snapping closed", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
		seedActiveTab("agent");
		await mount(<PanelContainer />);

		const aside = document.querySelector("aside") as HTMLElement;
		const separator = document.querySelector('[role="separator"]') as HTMLElement & {
			setPointerCapture: (pointerId: number) => void;
		};
		separator.setPointerCapture = vi.fn();

		await act(async () => {
			dispatchPointer(separator, "pointerdown", 1037);
			dispatchPointer(separator, "pointermove", 900);
		});
		expect(aside.style.width).toBe("540px");

		await act(async () => {
			dispatchPointer(separator, "pointermove", 1000);
			dispatchPointer(separator, "pointerup", 1000);
		});
		expect(aside.style.width).toBe("440px");
		expect(useUiStore.getState().panelVisible).toBe(true);
	});

	it("opens a local markdown link inside the Files drawer", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelVisible: false, filePreview: null });
		const read = vi.fn(async () => ({
			ok: true,
			content: "# Preview heading\n\nRendered body.",
			truncated: false,
			binary: false,
			size: 34,
		}));
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
				read,
			},
			system: {
				openExternal: vi.fn(async () => {}),
				openPath: vi.fn(async () => ({ ok: true })),
			},
		};
		await mount(<FileLinkHarness />);

		await act(async () => {
			document.querySelector("a")?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(useUiStore.getState()).toMatchObject({
			panelVisible: true,
			panelTab: "files",
			filePreview: { kind: "path", path: "docs/report.md", tabId: null },
		});
		expect(read).toHaveBeenCalledWith("docs/report.md", 200_000);
		expect(document.querySelector("aside h1")?.textContent).toBe("Preview heading");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("decodes an absolute file URL and renders non-Markdown text as code", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelVisible: false, filePreview: null });
		const read = vi.fn(async () => ({
			ok: true,
			content: "SELECT 1;",
			truncated: false,
			binary: false,
			size: 9,
		}));
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
				read,
			},
			system: {
				openExternal: vi.fn(async () => {}),
				openPath: vi.fn(async () => ({ ok: true })),
			},
		};
		await mount(<FileLinkHarness content="[sql](file:///tmp/my%20query.sql)" />);

		await act(async () => {
			document.querySelector("a")?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(read).toHaveBeenCalledWith("/tmp/my query.sql", 200_000);
		expect(document.querySelector("aside pre")?.textContent).toContain("SELECT 1;");
	});

	it("opens a local Word document link in the side-by-side preview", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelVisible: false, filePreview: null });
		const readDocument = vi.fn(async (_path: string, _options?: { tabId?: string }) => ({
			ok: false,
			size: 0,
			mtimeMs: 0,
			error: "unsupported",
		}));
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
				read: vi.fn(async () => ({ ok: false, error: "not text" })),
				readDocument,
			},
			system: {
				openExternal: vi.fn(async () => {}),
				openPath: vi.fn(async () => ({ ok: true })),
			},
		};
		const path = "/home/u/Documents/Sai ATLAS/r.docx";
		await mount(<FileLinkHarness content="[r](file:///home/u/Documents/Sai%20ATLAS/r.docx)" />);

		await act(async () => {
			document.querySelector("a")?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		const deadline = Date.now() + 2_000;
		while (readDocument.mock.calls.length === 0 && Date.now() < deadline) await flush();

		expect(useUiStore.getState()).toMatchObject({
			panelVisible: true,
			filePreview: { kind: "path", path },
		});
		expect(readDocument).toHaveBeenCalled();
		expect(readDocument.mock.calls[0]?.[0]).toBe(path);
	});

	it("keeps the workspace heading and a named close control", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelTab: "files", panelVisible: true });
		await mount(<PanelContainer />);

		expect(document.querySelector("aside h2")?.textContent).toBe("Workspace");
		const close = document.querySelector('aside button[aria-label="Close workspace"]');
		expect(close?.getAttribute("title")).toBe("Close workspace");
		const tabs = [...document.querySelectorAll("aside button[aria-pressed]")].map(button => [
			button.getAttribute("aria-label"),
			button.getAttribute("aria-pressed"),
		]);
		expect(tabs).toEqual([
			["Files", "true"],
			["Logs", "false"],
		]);

		await act(async () => {
			close?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(useUiStore.getState().panelVisible).toBe(false);
	});
});

function seedSplitTabs(): void {
	useTabsStore.setState({
		tabs: [
			{ id: "t0", cwd: "/work", status: "ready", kind: "agent", unreadDone: false },
			{ id: "t1", cwd: "/other", status: "ready", kind: "agent", unreadDone: false },
		],
		activeTabId: "t0",
		bundles: new Map(),
		split: { axis: "columns", firstTabId: "t0", secondTabId: "t1", ratio: 0.5 },
	});
}

function installPreviewOmp(prefsWidth: number | null = null) {
	const readDocument = vi.fn(async (_path: string, _options?: { tabId?: string }) => ({
		ok: false,
		size: 0,
		mtimeMs: 0,
		error: "not-a-file",
	}));
	const prefsSet = vi.fn(async (_key: string, _value: unknown) => {});
	ompWindow.omp = {
		fs: {
			list: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
			read: vi.fn(async () => ({ ok: true, content: "# Report", truncated: false, binary: false, size: 8 })),
			readImage: vi.fn(async () => ({ ok: false, dataUrl: null, mime: null, size: 0, error: "missing" })),
			readDocument,
		},
		prefs: {
			get: vi.fn(async (key: string) => (key === "gui.panelWidth" ? prefsWidth : undefined)),
			set: prefsSet,
		},
		system: {
			openExternal: vi.fn(async () => {}),
			openPath: vi.fn(async () => ({ ok: true })),
		},
	};
	return { readDocument, prefsSet };
}

function compactViewport(): void {
	mediaWindow.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
}

function aside(): HTMLElement {
	return document.querySelector("aside") as HTMLElement;
}

describe("PanelContainer docking beside the chat", () => {
	it("keeps the preview mounted and pinned to its tab when focus moves to the other pane", async () => {
		seedSplitTabs();
		const { readDocument } = installPreviewOmp();
		useUiStore.getState().openFilePreview("a.pdf", "t0");
		await mount(<PanelContainer />);

		await act(async () => {
			useTabsStore.setState({ activeTabId: "t1" });
		});
		await flush();

		expect(readDocument).toHaveBeenCalledTimes(1);
		expect(readDocument.mock.calls[0]?.[1]).toMatchObject({ tabId: "t0" });
	});

	it("docks the preview in a split workspace instead of overlaying the chat", async () => {
		seedSplitTabs();
		installPreviewOmp();
		useUiStore.getState().openFilePreview("docs/report.md", "t0");
		await mount(<PanelContainer />);

		expect(aside().className).not.toContain("absolute");
		expect(aside().hasAttribute("data-docked-preview")).toBe(true);
	});

	it("still overlays a split workspace when nothing is previewed", async () => {
		seedSplitTabs();
		installPreviewOmp();
		await mount(<PanelContainer />);

		expect(aside().className).toContain("absolute");
		expect(aside().hasAttribute("data-docked-preview")).toBe(false);
	});

	it("widens for a preview without saving the derived width", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
		seedActiveTab("agent");
		const { prefsSet } = installPreviewOmp(403);
		await mount(<PanelContainer />);
		expect(aside().style.width).toBe("403px");

		vi.useFakeTimers();
		await act(async () => {
			useUiStore.getState().openFilePreview("docs/report.md", "t0");
		});
		expect(aside().style.width).toBe("576px");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});

		expect(prefsSet.mock.calls.some(([key, value]) => key === "gui.panelWidth" && value === 576)).toBe(false);
	});

	it("hides the sidebar while docked in a narrow window and gives it back on close", async () => {
		compactViewport();
		seedActiveTab("agent");
		installPreviewOmp();
		useUiStore.setState({ sidebarVisible: true });
		useUiStore.getState().openFilePreview("docs/report.md", "t0");
		await mount(<PanelContainer />);

		expect(useUiStore.getState().sidebarVisible).toBe(false);
		expect(aside().hasAttribute("data-docked-preview")).toBe(true);

		await act(async () => {
			useUiStore.getState().closeFilePreview();
		});

		expect(useUiStore.getState().sidebarVisible).toBe(true);
		expect(aside().hasAttribute("data-docked-preview")).toBe(false);
	});

	it("gives the sidebar back when the drawer is hidden while previewing", async () => {
		compactViewport();
		seedActiveTab("agent");
		installPreviewOmp();
		useUiStore.setState({ sidebarVisible: true, panelVisible: true });
		useUiStore.getState().openFilePreview("docs/report.md", "t0");
		await mount(<DrawerHarness />);
		expect(useUiStore.getState().sidebarVisible).toBe(false);

		await act(async () => {
			useUiStore.getState().togglePanel();
		});

		expect(document.querySelector("aside")).toBeNull();
		expect(useUiStore.getState().filePreview).not.toBeNull();
		expect(useUiStore.getState().sidebarVisible).toBe(true);
	});

	it("respects a sidebar the user reopened during the preview", async () => {
		compactViewport();
		seedActiveTab("agent");
		installPreviewOmp();
		useUiStore.setState({ sidebarVisible: true });
		useUiStore.getState().openFilePreview("docs/report.md", "t0");
		await mount(<PanelContainer />);
		expect(useUiStore.getState().sidebarVisible).toBe(false);

		await act(async () => {
			useUiStore.getState().toggleSidebar();
		});
		await act(async () => {
			useUiStore.getState().closeFilePreview();
		});

		expect(useUiStore.getState().sidebarVisible).toBe(true);
	});

	it("steps the keyboard resize from the preview's derived width", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
		seedActiveTab("agent");
		installPreviewOmp(403);
		useUiStore.getState().openFilePreview("docs/report.md", "t0");
		await mount(<PanelContainer />);
		expect(aside().style.width).toBe("576px");

		const separator = document.querySelector('[role="separator"]') as HTMLElement;
		await act(async () => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "ArrowLeft" });
			separator.dispatchEvent(event);
		});

		expect(aside().style.width).toBe("600px");
	});

	it("leaves an already hidden sidebar hidden after the preview closes", async () => {
		compactViewport();
		seedActiveTab("agent");
		installPreviewOmp();
		useUiStore.setState({ sidebarVisible: false });
		useUiStore.getState().openFilePreview("docs/report.md", "t0");
		await mount(<PanelContainer />);

		await act(async () => {
			useUiStore.getState().closeFilePreview();
		});

		expect(useUiStore.getState().sidebarVisible).toBe(false);
	});
});
