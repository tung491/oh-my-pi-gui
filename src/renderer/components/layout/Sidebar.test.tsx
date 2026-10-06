/**
 * Sidebar integration contracts: one task lane listing every session, session
 * row context menu (6 items), pinned-first ordering, per-task busy gates, and
 * tab-first opening.
 * Same linkedom + react-dom harness as TabBar.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSessionOpenNewWindowResult, SessionInfo } from "../../../shared/ipc-types";
import { useSidebarRecency } from "../../hooks/use-sidebar-recency";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Sidebar } from "./Sidebar";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(HTMLElement.prototype as unknown as { select: () => void }).select = () => {};

interface TestElement {
	textContent: string | null;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

interface MockOmp {
	sidecar: {
		defaultWorkspace: Mock<() => Promise<string>>;
		selectProject: Mock<() => Promise<string | null>>;
		setProject: Mock<(cwd: string) => Promise<boolean>>;
	};
	sessions: {
		list: Mock<(scope: string) => Promise<SessionInfo[]>>;
		delete: Mock<(path: string) => Promise<void>>;
		rename: Mock<(path: string, name: string) => Promise<void>>;
		search: Mock<(query: string, scope: string) => Promise<string[]>>;
		openInNewWindow: Mock<(payload: { sessionPath?: string }) => Promise<IpcSessionOpenNewWindowResult>>;
	};
	events: {
		onSessionsChanged: Mock<() => () => void>;
		onTabStatus: Mock<() => () => void>;
		onMenuAction: Mock<() => () => void>;
	};
	tabs: {
		list: Mock<() => Promise<unknown[]>>;
		spawn: Mock<(payload: unknown) => Promise<{ tabId: string; cwd?: string } | null>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
		close: Mock<(tabId: string) => Promise<boolean>>;
		getSessionOwner: Mock<(path: string) => Promise<null>>;
	};
	prefs: {
		get: Mock<(key: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
	updater: {
		version: Mock<() => Promise<string>>;
	};
	rpc: Record<string, Mock<(...args: unknown[]) => Promise<unknown>>>;
}

function installMockOmp(sessionList: SessionInfo[]): MockOmp {
	const omp: MockOmp = {
		sidecar: {
			defaultWorkspace: vi.fn(async () => "/default/work"),
			selectProject: vi.fn(async () => null),
			setProject: vi.fn(async () => true),
		},
		sessions: {
			list: vi.fn(async () => sessionList),
			delete: vi.fn(async () => {}),
			rename: vi.fn(async () => {}),
			search: vi.fn(async () => []),
			openInNewWindow: vi.fn(async (): Promise<IpcSessionOpenNewWindowResult> => true),
		},
		events: {
			onSessionsChanged: vi.fn(() => () => {}),
			onTabStatus: vi.fn(() => () => {}),
			onMenuAction: vi.fn(() => () => {}),
		},
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async payload => ({
				tabId: "t-new",
				...((payload as { defaultWorkspace?: boolean }).defaultWorkspace ? { cwd: "/default/work" } : {}),
			})),
			setActive: vi.fn(async () => true),
			close: vi.fn(async () => true),
			getSessionOwner: vi.fn(async () => null),
		},
		prefs: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => {}),
		},
		updater: {
			version: vi.fn(async () => "0.9.10"),
		},
		rpc: new Proxy({} as MockOmp["rpc"], {
			get: (target, prop) => {
				if (!(prop in target)) {
					(target as Record<string | symbol, unknown>)[prop] = vi.fn(async () => ({
						type: "response",
						command: "mock",
						success: true,
						data: {},
					}));
				}
				return (target as Record<string | symbol, unknown>)[prop];
			},
		}),
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

function session(path: string, cwd: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path,
		id: path,
		title: `Session ${path}`,
		cwd,
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		messageCount: 3,
		size: 100,
		status: "complete",
		firstMessage: "hello",
		...overrides,
	};
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

/** Drive a React onClick/onContextMenu prop on an element. */
async function fire(element: Element | TestElement | null, prop: "onClick" | "onContextMenu"): Promise<void> {
	if (!element) throw new Error("fire: element is null");
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as Record<string, (event: unknown) => void> | undefined) : undefined;
	const handler = props?.[prop];
	if (!handler) throw new Error(`fire: ${prop} not found on element`);
	await act(async () =>
		handler({
			stopPropagation: () => {},
			preventDefault: () => {},
			clientX: 20,
			clientY: 30,
			currentTarget: element,
		}),
	);
	await flush();
}

function menuItemLabels(): string[] {
	return [...document.body.querySelectorAll('[role="menu"] button')].map(b => (b.textContent ?? "").trim());
}

const TEXT_NODE = 3;

interface NameNode {
	nodeType: number;
	textContent: string | null;
	childNodes: ArrayLike<NameNode>;
	getAttribute?: (name: string) => string | null;
}

/** The name assistive tech reads: aria-label, else the text outside aria-hidden subtrees. */
function accessibleName(element: TestElement): string {
	const label = element.getAttribute("aria-label");
	if (label !== null) return label.trim();
	const visibleText = (node: NameNode): string => {
		if (node.nodeType === TEXT_NODE) return node.textContent ?? "";
		if (node.getAttribute?.("aria-hidden") === "true") return "";
		return Array.from(node.childNodes, visibleText).join("");
	};
	return visibleText(element as unknown as NameNode).trim();
}

function listedTitles(): string[] {
	return [...container.querySelectorAll("[data-session-list] .omp-sidebar-session-row")].map(
		element => element.textContent ?? "",
	);
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useSidebarPrefs.getState().reset();
	useToastStore.setState({ toasts: [] });
	useUiStore.setState({
		panelVisible: false,
		sessionPickerOpen: false,
		hotkeysOpen: false,
		providersOpen: false,
	});
});

const LIST = [
	session("/work/alpha/one.jsonl", "/work/alpha", { modified: "2026-01-02T00:00:00Z" }),
	session("/work/alpha/two.jsonl", "/work/alpha", { modified: "2026-01-01T00:00:00Z" }),
	session("/work/beta/three.jsonl", "/work/beta", { modified: "2026-01-03T00:00:00Z" }),
];

function seedStores(): void {
	useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function SidebarWithRecency() {
	useSidebarRecency();
	return <Sidebar />;
}

describe("Sidebar menus and pinned ordering", () => {
	it("lists the navigation below New task and collapses it as one menu", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const navigation = container.querySelector("[data-sidebar-navigation]");
		for (const label of ["Commands", "Ollama", "Settings"]) {
			expect(navigation?.textContent).toContain(label);
		}
		const commandCenter = navigation?.querySelector('button[data-command-center-entry="true"]');
		expect(commandCenter?.textContent).toContain("⌘K / ⌃K");
		await act(async () => useUiStore.setState({ keymapOverrides: { palette: ["⌘⇧K"] } }));
		expect(commandCenter?.textContent).toContain("⇧⌘K");
		expect(commandCenter?.textContent).not.toContain("⌃K");
		await act(async () => useUiStore.setState({ keymapOverrides: {} }));

		const collapse = navigation!.querySelector('[aria-label="Collapse navigation"]');
		expect(collapse?.getAttribute("title")).toBe("Collapse navigation");
		await fire(collapse, "onClick");
		expect((navigation!.querySelector(".omp-sidebar-group") as unknown as Element).getAttribute("aria-hidden")).toBe(
			"true",
		);
	});
	it("moves the most recently used session to the front immediately", async () => {
		const omp = installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "", cwd: "/neutral", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "chat", cwd: "/neutral", status: "ready", kind: "chat", unreadDone: false }],
			activeTabId: "chat",
			bundles: new Map(),
		});
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<SidebarWithRecency />);

		expect(listedTitles()[0]).toContain("Session /work/beta/three");

		await act(async () => {
			useTabsStore.setState({
				tabs: [{ id: "agent", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false }],
				activeTabId: "agent",
			});
			useSessionStore.setState({
				sessionId: "/work/alpha/two.jsonl",
				sessionFile: "/work/alpha/two.jsonl",
				cwd: "/work/alpha",
			});
		});
		await flush();

		expect(listedTitles()[0]).toContain("Session /work/alpha/two");
		expect(useSidebarPrefs.getState().sessionLastUsed["/work/alpha/two.jsonl"]).toBeGreaterThan(0);
		expect(omp.prefs.set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({
				sessionLastUsed: expect.objectContaining({ "/work/alpha/two.jsonl": expect.any(Number) }),
			}),
		);
	});
	it("starts a task in the default workspace from New task, even from an active chat", async () => {
		const omp = installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "chat", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "chat", cwd: "/work/alpha", status: "ready", kind: "chat", unreadDone: false }],
			activeTabId: "chat",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		expect(container.querySelector("[data-sidebar-new-chat]")).toBeNull();
		await fire(container.querySelector("[data-sidebar-new-agent]"), "onClick");

		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: undefined,
			sessionPath: undefined,
			kind: "agent",
			defaultWorkspace: true,
			worktree: undefined,
		});
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t-new");
		expect(useTabsStore.getState()).toMatchObject({
			activeTabId: "t-new",
			tabs: expect.arrayContaining([expect.objectContaining({ id: "t-new", kind: "agent", cwd: "/default/work" })]),
		});
		expect(omp.sidecar.setProject).not.toHaveBeenCalled();
	});
	it("opens the existing global session picker from the header", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		await fire(container.querySelector('[aria-label="Search sessions"], [aria-label="搜索会话"]'), "onClick");

		expect(useUiStore.getState().sessionPickerOpen).toBe(true);
	});

	it("uses visible vertical signal lights for session state", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const rows = container.querySelectorAll(".omp-sidebar-session-row");
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every(row => row.querySelector(".omp-signal-light") !== null)).toBe(true);
		expect(rows.every(row => row.querySelector(".omp-signal-light--active") === null)).toBe(true);
		expect(rows[0]?.querySelector('[aria-label="Completed"]')).not.toBeNull();
	});

	it("uses the open tab's live status instead of the session file's stale completion status", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id", status: "complete" });
		installMockOmp([attached]);
		seedStores();
		useTabsStore.setState({
			tabs: [
				{
					id: "t0",
					cwd: "/work/alpha",
					status: "ready",
					kind: "agent",
					sessionId: "attached-id",
					unreadDone: false,
				},
			],
		});
		await mount(<Sidebar />);

		const signal = () => container.querySelector('[data-active="true"] .omp-signal-light') as unknown as Element;
		expect(signal().getAttribute("aria-label")).toBe("Ready");
		const readyStyle = signal().getAttribute("style") ?? "";
		expect(readyStyle).toContain("var(--omp-sidebar-muted)");
		expect(readyStyle).not.toContain("--omp-sidebar-success");
		expect(readyStyle).not.toContain("--omp-success");

		await act(async () => {
			useTabsStore.setState({ tabs: [{ ...useTabsStore.getState().tabs[0]!, status: "running" }] });
		});
		expect(signal().getAttribute("aria-label")).toBe("Working");
		expect(signal().className).toContain("omp-signal-light--active");
	});

	it("marks chat sessions with an icon and leaves task rows unmarked", async () => {
		installMockOmp([...LIST, session("/work/alpha/chat.jsonl", "/work/alpha", { kind: "chat" })]);
		seedStores();
		await mount(<Sidebar />);

		const chatRow = container.querySelector('[data-session-kind="chat"]');
		const taskRow = container.querySelector('[data-session-kind="agent"]');
		expect(chatRow?.querySelector("svg[data-sidebar-session-icon]")).not.toBeNull();
		expect(taskRow).not.toBeNull();
		expect(taskRow?.querySelector("[data-sidebar-session-icon]")).toBeNull();
	});
	it("right-click on a session row opens the 6-item session menu", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		expect(row).not.toBeUndefined();
		await fire(row as Element, "onContextMenu");

		const labels = menuItemLabels();
		for (const expected of ["Open", "Open in new tab", "Open in new window", "Rename", "Pin to top", "Delete"]) {
			expect(
				labels.some(label => label.includes(expected)),
				`missing item: ${expected}`,
			).toBe(true);
		}
		expect(labels).toHaveLength(6);

		const pinItem = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("Pin to top"),
		);
		await fire(pinItem as Element, "onClick");
		expect(omp.rpc.setSessionPinned).toHaveBeenCalledWith("/work/alpha/one.jsonl", true);
	});

	it("tells the user to start a new task when a chat session cannot open in a new window", async () => {
		const chat = session("/work/alpha/chat.jsonl", "/work/alpha", { kind: "chat" });
		const omp = installMockOmp([chat]);
		omp.sessions.openInNewWindow.mockResolvedValue({ refusal: "kind-mismatch" });
		seedStores();
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/chat"),
		);
		await fire(row as Element, "onContextMenu");
		const openWindow = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("Open in new window"),
		);
		await fire(openWindow as Element, "onClick");
		await flush();

		expect(omp.sessions.openInNewWindow).toHaveBeenCalledWith({
			sessionPath: "/work/alpha/chat.jsonl",
			cwd: "/work/alpha",
		});
		const messages = useToastStore.getState().toasts.map(item => item.message);
		expect(messages).toContain(en["sidebar.kindMismatch"]);
		expect(messages).not.toContain(en["sidebar.parallelCap"]);
	});

	it("rename and delete stay enabled for idle tasks while another task runs", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		const omp = installMockOmp([attached, ...LIST]);
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		// The attached running task stays protected.
		const attachedRow = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/mine"),
		);
		await fire(attachedRow as Element, "onContextMenu");
		const renameItem = [...document.body.querySelectorAll('[role="menu"] button')].find(b =>
			(b.textContent ?? "").includes("Rename"),
		);
		expect((renameItem as HTMLButtonElement | undefined)?.disabled).toBe(true);
		await fire(document.body.querySelector('[role="menu"] button') as Element, "onClick");

		// An idle sibling remains editable and deletable despite the active run.
		const foreignRow = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		await fire(foreignRow as Element, "onContextMenu");
		const foreignMenu = [...document.body.querySelectorAll('[role="menu"] button')];
		const idleRename = foreignMenu.find(b => (b.textContent ?? "").includes("Rename"));
		const idleDelete = foreignMenu.find(b => (b.textContent ?? "").includes("Delete"));
		expect((idleRename as HTMLButtonElement | undefined)?.disabled).toBe(false);
		expect((idleDelete as HTMLButtonElement | undefined)?.disabled).toBe(false);
		await fire(idleRename as Element, "onClick");
		const input = container.querySelector(
			'input[value="Session /work/alpha/one.jsonl"]',
		) as unknown as HTMLInputElement;
		expect(input).not.toBeNull();
		const inputRecord = input as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(inputRecord).find(key => key.startsWith("__reactProps$"));
		const inputProps = propsKey
			? (inputRecord[propsKey] as {
					onChange: (event: { target: { value: string } }) => void;
					onBlur: (event: { currentTarget: { value: string } }) => void;
				})
			: undefined;
		if (!inputProps) throw new Error("rename input React props missing");
		await act(async () => {
			inputProps.onChange({ target: { value: "Renamed idle task" } });
		});
		await act(async () => {
			inputProps.onBlur({ currentTarget: { value: "Renamed idle task" } });
		});
		await flush();
		expect(omp.sessions.rename).toHaveBeenCalledWith("/work/alpha/one.jsonl", "Renamed idle task");
	});

	it("clicking an idle task opens it in a new tab by default", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		await fire(row as unknown as Element, "onClick");

		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/work/alpha",
			kind: "agent",
			sessionPath: "/work/alpha/one.jsonl",
			worktree: undefined,
		});
		expect(omp.sessions.openInNewWindow).not.toHaveBeenCalled();
	});

	it("lists chat sessions in the one lane and opens them, with no way to start a new chat", async () => {
		const chat = session("/work/alpha/chat.jsonl", "/work/alpha", { kind: "chat" });
		const agent = session("/work/alpha/agent.jsonl", "/work/alpha");
		const omp = installMockOmp([chat, agent]);
		seedStores();
		await mount(<Sidebar />);

		const list = container.querySelector("[data-session-list]");
		expect(list?.textContent).toContain("Session /work/alpha/agent");
		expect(list?.textContent).toContain("Session /work/alpha/chat");
		const chatRow = [...list!.querySelectorAll('div[role="button"]')].find(element =>
			(element.textContent ?? "").includes("Session /work/alpha/chat"),
		);
		await fire(chatRow as unknown as Element, "onClick");
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith({
			cwd: "/work/alpha",
			kind: "chat",
			sessionPath: "/work/alpha/chat.jsonl",
			worktree: undefined,
		});
		expect(container.querySelector("[data-sidebar-new-chat]")).toBeNull();
	});
	it("keeps the active task protected while it is compacting", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		installMockOmp([attached]);
		seedStores();
		useSessionStore.setState({ isCompacting: true });
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/mine"),
		);
		await fire(row as Element, "onContextMenu");
		const items = [...document.body.querySelectorAll('[role="menu"] button')];
		expect((items.find(item => (item.textContent ?? "").includes("Rename")) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((items.find(item => (item.textContent ?? "").includes("Delete")) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("keeps a pinned session first in the one list", async () => {
		installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ pinnedSessions: ["/work/alpha/two.jsonl"], hydrated: true });
		await mount(<Sidebar />);

		const titles = listedTitles();
		expect(titles[0]).toContain("Session /work/alpha/two");
		expect(titles[1]).toContain("Session /work/beta/three");
		expect(titles[2]).toContain("Session /work/alpha/one");
		expect(container.querySelector("[data-workspace-group]")).toBeNull();
	});
	it("session titles truncate in place and hover actions do not claim row width", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll(".omp-sidebar-session-row")].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		expect(row).toBeDefined();
		const title = row?.querySelector(".omp-sidebar-title");
		const actions = row?.querySelector(".omp-sidebar-session-actions");
		expect(title).not.toBeNull();
		expect(title?.className).toContain("truncate");
		expect(actions).not.toBeNull();
		expect(actions?.className).not.toMatch(/\bw-\d|\bwidth/);
		expect(row?.querySelector("[data-overflow]")).toBeNull();
	});

	it("asks before removing a session transcript, and only deletes once confirmed", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll(".omp-sidebar-session-row")].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		) as unknown as Element;
		await fire(row.querySelector('[aria-label="Delete session"]') as Element, "onClick");

		// Queued, not executed: the trash click must never reach the hard delete.
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("/work/alpha/one");
		expect(dialog?.textContent).toContain("cannot be undone");

		const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
		await fire(buttons.find(b => (b.textContent ?? "").trim() === "Cancel") as unknown as Element, "onClick");
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();

		await fire(row.querySelector('[aria-label="Delete session"]') as Element, "onClick");
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			b => (b.textContent ?? "").trim() === "Delete",
		) as unknown as Element;
		await fire(confirm, "onClick");
		expect(omp.sessions.delete).toHaveBeenCalledWith("/work/alpha/one.jsonl");
	});
});

describe("Sidebar single task lane", () => {
	it("keeps only the everyday nav items, no lane switch and one New task button", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const navIds = [...container.querySelectorAll("[data-sidebar-nav]")].map(item =>
			item.getAttribute("data-sidebar-nav"),
		);
		expect(navIds).toEqual(["commands", "providers", "settings"]);
		const codeLabel = en["sidebar.mode.code"];
		expect(
			[...container.querySelectorAll("*")].filter(element => (element.textContent ?? "").trim() === codeLabel),
		).toHaveLength(0);
		const newWork = en["sidebar.newWork"];
		expect(
			[...container.querySelectorAll("button")].filter(button => (button.textContent ?? "").trim() === newWork),
		).toHaveLength(1);
	});

	it("lists project sessions in the one lane", async () => {
		const work = session("/default/work/plan.jsonl", "/default/work", { modified: "2026-01-04T00:00:00Z" });
		const chat = session("/work/gamma/chat.jsonl", "/work/gamma", { kind: "chat", modified: "2026-01-05T00:00:00Z" });
		installMockOmp([...LIST, work, chat]);
		seedStores();
		await mount(<Sidebar />);

		// Work-folder, project-folder and chat sessions share one list by last activity,
		// with no project group headers.
		const titles = listedTitles();
		expect(titles).toHaveLength(5);
		expect(titles[0]).toContain("Session /work/gamma/chat");
		expect(titles[1]).toContain("Session /default/work/plan");
		expect(titles[2]).toContain("Session /work/beta/three");
		expect(titles[3]).toContain("Session /work/alpha/one");
		expect(titles[4]).toContain("Session /work/alpha/two");
		expect(container.querySelector("[data-workspace-group]")).toBeNull();
	});
});

describe("Sidebar VIF rail", () => {
	it("renders the VIF rail", async () => {
		const omp = installMockOmp(LIST);
		omp.prefs.get.mockImplementation(async () => undefined);
		seedStores();
		useUiStore.setState({ settingsOpen: false });
		await mount(<Sidebar />);

		const header = container.querySelector(".drag-region");
		const lockup = Array.from(header?.querySelectorAll('img[alt="Sai ATLAS"]') ?? []);
		expect(lockup.map(img => img.getAttribute("data-logo-tone"))).toEqual(["dark", "light"]);
		expect(container.querySelector('img[alt="VIF"]')).toBeNull();
		const aside = container.querySelector("aside") as unknown as HTMLElement;
		expect(aside.style.width).toBe("264px");

		const navigation = container.querySelector("[data-sidebar-navigation]");
		if (!navigation) throw new Error("sidebar navigation missing");
		const navButtons = navigation.querySelectorAll("button");
		for (const [index, label] of ["Commands", "Ollama", "Settings"].entries()) {
			expect((navButtons[index]?.textContent ?? "").startsWith(label), `navigation item ${index}: ${label}`).toBe(
				true,
			);
		}
		const commands = navButtons[0];
		if (!commands) throw new Error("Commands navigation item missing");
		expect(commands.querySelector("kbd")?.textContent).toBe("⌘K / ⌃K");
		expect(accessibleName(commands)).toBe("Commands");
		expect(commands.getAttribute("title")).toBe("Open Command Center (⌘K / ⌃K)");

		// Strict e2e clicks resolve `{ name: "Settings", exact: true }`: only the nav item may carry it.
		const sidebarButtons = container.querySelectorAll("aside button");
		expect(sidebarButtons.filter(button => accessibleName(button) === "Settings")).toHaveLength(1);

		const footer = () => container.querySelector("[data-sidebar-footer]");
		expect(footer()).not.toBeNull();
		await fire(footer()?.querySelector('button[aria-label="Open settings"]') ?? null, "onClick");
		expect(useUiStore.getState().settingsOpen).toBe(true);

		const footerText = () => footer()?.textContent ?? "";
		expect(omp.updater.version).toHaveBeenCalled();
		expect(footerText()).toContain("Sai ATLAS 0.9.10");

		await act(async () => {
			useTabsStore.setState({
				tabs: [{ id: "t0", cwd: "/work/alpha", status: "asleep", kind: "agent", unreadDone: false }],
				activeTabId: "t0",
			});
		});
		expect(footerText()).toContain(en["titlebar.status.asleep"]);
		expect(footerText()).not.toContain(en["titlebar.status.ready"]);

		await act(async () => {
			useTabsStore.setState({ tabs: [], activeTabId: null });
		});
		expect(footer()).not.toBeNull();
		expect(footerText()).not.toContain("Sai ATLAS 0.9");
		for (const key of [
			"titlebar.status.working",
			"titlebar.status.ready",
			"titlebar.status.connecting",
			"titlebar.status.asleep",
			"titlebar.status.error",
			"titlebar.status.exited",
			"titlebar.status.restarting",
			"tabs.done",
		]) {
			expect(footerText(), key).not.toContain(en[key]);
		}
	});

	it("shows the whole footer status on hover, since the rail truncates it", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const status = () =>
			Array.from(container.querySelectorAll("[data-sidebar-footer] span")).find(span =>
				span.textContent?.startsWith("Sai ATLAS"),
			);
		expect(status()?.textContent).toBe(`Sai ATLAS 0.9.10 · ${en["titlebar.status.ready"]}`);
		expect(status()?.getAttribute("title")).toBe(status()?.textContent);

		await act(async () => {
			useTabsStore.setState({
				tabs: [{ id: "t0", cwd: "/work/alpha", status: "asleep", kind: "agent", unreadDone: false }],
			});
		});
		expect(status()?.getAttribute("title")).toBe(`Sai ATLAS 0.9.10 · ${en["titlebar.status.asleep"]}`);
	});
});

describe("Sidebar session-list failures", () => {
	it("names the failed read instead of claiming there are no sessions", async () => {
		const omp = installMockOmp([]);
		omp.sessions.list.mockRejectedValue(new Error("session index unreadable"));
		seedStores();
		await mount(<Sidebar />);

		// A read that never answered is not a read that found nothing: the dashed
		// "No code sessions yet" card is a false all-clear about the user's history.
		const text = document.body.textContent ?? "";
		expect(text).toContain("Could not load your sessions.");
		expect(text).toContain("session index unreadable");
		expect(text).not.toContain("No code sessions yet");

		const callsBeforeRetry = omp.sessions.list.mock.calls.length;
		const retry = [...document.body.querySelectorAll("button")].find(b => (b.textContent ?? "") === "Retry");
		if (!retry) throw new Error("retry button not found");
		await fire(retry as unknown as Element, "onClick");
		await flush();
		expect(omp.sessions.list.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
	});
});
