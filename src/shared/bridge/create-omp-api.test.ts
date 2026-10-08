import { describe, expect, it } from "vitest";
import { IPC_COMMANDS, IPC_EVENTS } from "../ipc-types";
import { createOmpApi } from "./create-omp-api";
import type { IpcPort } from "./ipc-port";

interface Call {
	channel: string;
	args: unknown[];
}

/** A port that records what the API sends and lets the test emit main→renderer messages. */
function fakePort(respond: (call: Call) => unknown = () => undefined) {
	const invokes: Call[] = [];
	const sends: Call[] = [];
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const port: IpcPort = {
		invoke(channel, ...args) {
			const call = { channel, args };
			invokes.push(call);
			return Promise.resolve(respond(call));
		},
		send(channel, ...args) {
			sends.push({ channel, args });
		},
		on(channel, listener) {
			let set = listeners.get(channel);
			if (!set) {
				set = new Set();
				listeners.set(channel, set);
			}
			set.add(listener);
			return () => {
				listeners.get(channel)?.delete(listener);
			};
		},
	};
	const emit = (channel: string, payload: unknown) => {
		for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
	};
	const listenerCount = (channel: string) => listeners.get(channel)?.size ?? 0;
	return { port, invokes, sends, emit, listenerCount };
}

describe("createOmpApi", () => {
	it("forwards invokes with their channel and positional args, and exposes the platform", async () => {
		const { port, invokes } = fakePort(() => "/profile/logs/gui-runtime.jsonl");
		const api = createOmpApi(port, "linux", "/home/u");
		expect(api.platform).toBe("linux");
		expect(api.homeDir).toBe("/home/u");
		expect(createOmpApi(port, "linux").homeDir).toBe("");
		await expect(api.runtime.logPath()).resolves.toBe("/profile/logs/gui-runtime.jsonl");
		await api.system.showSaveDialog("a.html", [{ name: "HTML", extensions: ["html"] }]);
		await api.system.showSaveDialog();
		expect(invokes).toEqual([
			{ channel: IPC_COMMANDS.RUNTIME_LOG_PATH, args: [] },
			{ channel: IPC_COMMANDS.SYSTEM_SAVE_DIALOG, args: ["a.html", [{ name: "HTML", extensions: ["html"] }]] },
			{ channel: IPC_COMMANDS.SYSTEM_SAVE_DIALOG, args: [undefined, undefined] },
		]);
	});

	it("uses send for fire-and-forget channels", () => {
		const { port, sends, invokes } = fakePort();
		const api = createOmpApi(port, "linux");
		api.runtime.report({ source: "window-error", message: "boom" });
		api.app.quit();
		api.quickEntry.suspendShortcuts(true);
		expect(sends).toEqual([
			{ channel: IPC_COMMANDS.RUNTIME_ERROR_REPORT, args: [{ source: "window-error", message: "boom" }] },
			{ channel: IPC_COMMANDS.APP_QUIT, args: [] },
			{ channel: IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_SUSPEND, args: [true] },
		]);
		expect(invokes).toEqual([]);
	});

	it("filters active-tab streams once a tab is active, and setActive only moves on success", async () => {
		const { port, emit } = fakePort(call =>
			call.channel === IPC_COMMANDS.SET_ACTIVE_TAB && call.args[0] !== undefined
				? (call.args[0] as { tabId: string }).tabId !== "refused"
				: undefined,
		);
		const api = createOmpApi(port, "linux");
		const seen: string[] = [];
		api.events.onBatch(events => seen.push(...(events as unknown as string[])));
		// No active tab yet: every tab's batch is delivered.
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t1", payload: ["a"] });
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t2", payload: ["b"] });
		expect(seen).toEqual(["a", "b"]);
		await expect(api.tabs.setActive("refused")).resolves.toBe(false);
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t2", payload: ["c"] });
		expect(seen).toEqual(["a", "b", "c"]);
		await expect(api.tabs.setActive("t1")).resolves.toBe(true);
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t1", payload: ["d"] });
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t2", payload: ["e"] });
		expect(seen).toEqual(["a", "b", "c", "d"]);
	});

	it("setView moves the active tab to the focused tab only when main agrees", async () => {
		let accept = false;
		const { port, emit } = fakePort(() => accept);
		const api = createOmpApi(port, "linux");
		const seen: string[] = [];
		api.events.onSidecarStatus(status => seen.push(status as unknown as string));
		await expect(api.tabs.setActive("t1")).resolves.toBe(false);
		await expect(api.tabs.setView("t2", ["t2"], undefined)).resolves.toBe(false);
		emit(IPC_EVENTS.SIDECAR_STATUS, { tabId: "t2", payload: "still unfiltered" });
		expect(seen).toEqual(["still unfiltered"]);
		accept = true;
		const split = { axis: "columns" as const, firstTabId: "t1", secondTabId: "t2", ratio: 0.5 };
		await expect(api.tabs.setView("t2", ["t1", "t2"], split)).resolves.toBe(true);
		emit(IPC_EVENTS.SIDECAR_STATUS, { tabId: "t1", payload: "dropped" });
		emit(IPC_EVENTS.SIDECAR_STATUS, { tabId: "t2", payload: "kept" });
		expect(seen).toEqual(["still unfiltered", "kept"]);
	});

	it("per-tab streams deliver every tab with its id, and the remover stops delivery", () => {
		const { port, emit, listenerCount } = fakePort();
		const api = createOmpApi(port, "linux");
		const seen: [string, string][] = [];
		const stop = api.events.onTabBatch((events, tabId) => seen.push([tabId, (events as unknown as string[])[0]]));
		expect(listenerCount(IPC_EVENTS.EVENTS_BATCH)).toBe(1);
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t1", payload: ["a"] });
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t2", payload: ["b"] });
		stop();
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "t1", payload: ["c"] });
		expect(seen).toEqual([
			["t1", "a"],
			["t2", "b"],
		]);
		expect(listenerCount(IPC_EVENTS.EVENTS_BATCH)).toBe(0);
	});

	it("sends the context-fit requests as payload objects and streams their events", async () => {
		const { port, invokes, emit, listenerCount } = fakePort();
		const api = createOmpApi(port, "linux");
		await api.ollama.contextList();
		await api.ollama.measureContext("qwen3:8b");
		await api.ollama.measureContext("qwen3", "pulled");
		await api.ollama.setContextCap("qwen3:8b", 32_768);
		await api.ollama.setContextCap("qwen3:8b", null);
		expect(invokes).toEqual([
			{ channel: IPC_COMMANDS.OLLAMA_CONTEXT_LIST, args: [] },
			{ channel: IPC_COMMANDS.OLLAMA_CONTEXT_MEASURE, args: [{ tag: "qwen3:8b" }] },
			{ channel: IPC_COMMANDS.OLLAMA_CONTEXT_MEASURE, args: [{ tag: "qwen3", reason: "pulled" }] },
			{ channel: IPC_COMMANDS.OLLAMA_CONTEXT_SET_CAP, args: [{ tag: "qwen3:8b", cap: 32_768 }] },
			{ channel: IPC_COMMANDS.OLLAMA_CONTEXT_SET_CAP, args: [{ tag: "qwen3:8b", cap: null }] },
		]);

		const seen: unknown[] = [];
		const stopProgress = api.ollama.onContextProgress(progress => seen.push(progress));
		const stopChanged = api.ollama.onContextChanged(change => seen.push(change));
		emit(IPC_EVENTS.OLLAMA_CONTEXT_PROGRESS, { tag: "qwen3:8b", state: "running", numCtx: 16_384 });
		emit(IPC_EVENTS.OLLAMA_CONTEXT_CHANGED, { tag: "qwen3:8b" });
		stopProgress();
		stopChanged();
		expect(seen).toEqual([{ tag: "qwen3:8b", state: "running", numCtx: 16_384 }, { tag: "qwen3:8b" }]);
		expect(listenerCount(IPC_EVENTS.OLLAMA_CONTEXT_PROGRESS)).toBe(0);
		expect(listenerCount(IPC_EVENTS.OLLAMA_CONTEXT_CHANGED)).toBe(0);
	});

	it("holds a cold-start deep link for the first subscriber but never a quick-entry nudge", () => {
		const { port, emit } = fakePort();
		const api = createOmpApi(port, "linux");
		emit(IPC_EVENTS.DEEP_LINK, { action: "quick-entry" });
		emit(IPC_EVENTS.DEEP_LINK, { action: "switch-session", sessionId: "s1" });
		emit(IPC_EVENTS.DEEP_LINK, { action: "quick-entry" });
		const links: unknown[] = [];
		api.events.onDeepLink(link => links.push(link));
		expect(links).toEqual([{ action: "switch-session", sessionId: "s1" }]);
		emit(IPC_EVENTS.DEEP_LINK, { action: "quick-entry" });
		emit(IPC_EVENTS.DEEP_LINK, { action: "new-session" });
		expect(links).toEqual([
			{ action: "switch-session", sessionId: "s1" },
			{ action: "quick-entry" },
			{ action: "new-session" },
		]);
	});

	it("isolates a throwing listener: the others still run and the failure is reported", () => {
		const { port, emit, sends } = fakePort();
		const api = createOmpApi(port, "linux");
		const seen: string[] = [];
		api.events.onSessionsChanged(() => {
			throw new Error("listener exploded");
		});
		api.events.onSessionsChanged(() => seen.push("second"));
		emit(IPC_EVENTS.SESSIONS_CHANGED, undefined);
		expect(seen).toEqual(["second"]);
		expect(sends).toHaveLength(1);
		const [report] = sends;
		expect(report.channel).toBe(IPC_COMMANDS.RUNTIME_ERROR_REPORT);
		expect(report.args[0]).toMatchObject({
			source: "preload",
			message: `IPC handler for "${IPC_EVENTS.SESSIONS_CHANGED}" failed: listener exploded`,
			details: { channel: IPC_EVENTS.SESSIONS_CHANGED },
		});
		expect((report.args[0] as { stack?: string }).stack).toContain("listener exploded");
	});

	it("reports a throwing deep-link listener the same way", () => {
		const { port, emit, sends } = fakePort();
		const api = createOmpApi(port, "linux");
		api.events.onDeepLink(() => {
			throw new Error("link handler exploded");
		});
		emit(IPC_EVENTS.DEEP_LINK, { action: "new-session" });
		expect(sends).toHaveLength(1);
		expect(sends[0].args[0]).toMatchObject({
			source: "preload",
			details: { channel: IPC_EVENTS.DEEP_LINK },
		});
	});

	it("reads a PDF over its own channel and passes the shell's pathForFile through", async () => {
		const { port, invokes } = fakePort(() => ({ ok: true, data: "JVBERi0=", size: 5 }));
		const api = createOmpApi(port, "linux");
		await expect(api.fs.readPdf("/docs/a.pdf")).resolves.toEqual({ ok: true, data: "JVBERi0=", size: 5 });
		expect(invokes).toEqual([{ channel: IPC_COMMANDS.FS_READ_PDF, args: [{ path: "/docs/a.pdf" }] }]);
		expect(api.system.pathForFile).toBeUndefined();

		const pathForFile = (file: File) => `/dropped/${file.name}`;
		const electronApi = createOmpApi(port, "darwin", "/Users/u", { pathForFile });
		expect(electronApi.system.pathForFile?.(new File(["x"], "b.txt"))).toBe("/dropped/b.txt");
		expect(electronApi.system.onNativeDropPaths).toBeUndefined();
	});

	it("delivers native drop paths only when the shell emits them, dropping malformed entries", () => {
		const { port, emit, listenerCount } = fakePort();
		expect(createOmpApi(port, "linux").system.onNativeDropPaths).toBeUndefined();

		const api = createOmpApi(port, "linux", "/home/u", { nativeDropPaths: true });
		const seen: string[][] = [];
		const unsubscribe = api.system.onNativeDropPaths?.(paths => seen.push(paths));
		emit(IPC_EVENTS.NATIVE_DROP_PATHS, { paths: ["/a b.pdf", 7, "", "/c.txt"] });
		emit(IPC_EVENTS.NATIVE_DROP_PATHS, { paths: "nope" });
		emit(IPC_EVENTS.NATIVE_DROP_PATHS, null);
		expect(seen).toEqual([["/a b.pdf", "/c.txt"], [], []]);
		unsubscribe?.();
		expect(listenerCount(IPC_EVENTS.NATIVE_DROP_PATHS)).toBe(0);
	});
});
