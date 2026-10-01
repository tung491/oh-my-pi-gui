/**
 * The quick-entry bar: a small frameless window summoned over whatever the
 * user is doing, which hands its prompt to a new tab in the main window.
 *
 * The bar is never a WindowManager record, so the tray, the menus, tab-layout
 * persistence and `getTargetWindow` never see it. Its page gets only
 * window.ompQuickEntry. Main keeps every accepted prompt until the chat window
 * acknowledges it, and gives back to the bar's restore list whatever a closed
 * window or a failed tab never delivered; the pure rules live in
 * ./quick-entry-core.
 */

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
	app,
	BrowserWindow,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
	ipcMain,
	nativeTheme,
	screen,
	type WebContents,
} from "electron";
import {
	IPC_COMMANDS,
	IPC_EVENTS,
	type QuickEntryBarState,
	type QuickEntryFailure,
	type QuickEntryReturned,
	type QuickEntrySubmitResult,
	type QuickEntryTarget,
	type QuickEntryWorkspace,
	type SessionInfo,
} from "../shared/ipc-types";
import { recentWorkspaceCwds } from "../shared/recent-workspaces";
import { getMainLanguage } from "./i18n";
import { isExistingDirectory } from "./launch-argv";
import {
	ack,
	claim,
	closeWindow,
	consumeRestored,
	enqueue,
	isBlockedMenuChord,
	QUICK_ENTRY_SIZE,
	QUICK_ENTRY_WORKSPACE_LIMIT,
	type QuickEntryQueue,
	quickEntryBounds,
	releaseLeases,
	resolveInitialTarget,
	returnPrompt,
	validateSubmit,
} from "./quick-entry-core";
import { writeRuntimeLog } from "./runtime-log";
import type { SessionIndex } from "./session-index";
import type { SidecarPool } from "./sidecar-pool";
import {
	applyWebContentsGuards,
	loadRendererPage,
	type SpawnWindow,
	sendWhenLoaded,
	type WindowManager,
} from "./window";

/** How long a summon waits for the startup windows before showing the bar anyway. */
const STARTUP_SETTLE_CEILING_MS = 5_000;

const FAILURES: ReadonlySet<string> = new Set<QuickEntryFailure>([
	"tab-cap",
	"no-window",
	"workspace-missing",
	"tab-failed",
	"interrupted",
	"invalid",
]);

export interface QuickEntryDeps {
	windowManager: WindowManager;
	spawnWindow: SpawnWindow;
	sidecarPool: Pick<SidecarPool, "atCap">;
	sessionIndex: Pick<SessionIndex, "list">;
	/** The Work workspace, which the bar offers as its own option. */
	defaultWorkspace: () => string;
	readTarget: () => unknown;
	saveTarget: (target: QuickEntryTarget) => void;
	/** Native Wayland: the compositor places and focuses new windows. */
	portalSession: boolean;
}

export class QuickEntryController {
	readonly #deps: QuickEntryDeps;
	#win: BrowserWindow | null = null;
	/** The page has painted once; showing earlier would flash an empty frame. */
	#ready = false;
	#revealOnReady = false;
	#showId = 0;
	#queue: QuickEntryQueue = new Map();
	#restored: QuickEntryReturned[] = [];
	#workspaces: QuickEntryWorkspace[] = [];
	/** Workspaces offered during the current show: the cached list plus the refreshed one. */
	#offered = new Set<string>();
	/** Workspaces of prompts that came back to the bar; still offered once the bar took them. */
	readonly #restoredCwds = new Set<string>();
	/** Chat windows whose reloads release their leases. */
	readonly #watched = new Set<number>();
	/** Every startup window has shown or closed. */
	#settled = false;
	#ceilingPassed = false;
	#showWhenSettled = false;

	constructor(deps: QuickEntryDeps) {
		this.#deps = deps;
		setTimeout(() => {
			this.#ceilingPassed = true;
			this.#flushDeferredShow();
		}, STARTUP_SETTLE_CEILING_MS);
	}

	registerIpc(): void {
		ipcMain.handle(IPC_COMMANDS.QUICK_ENTRY_SUBMIT, (event, payload: unknown) => this.#submit(event, payload));
		ipcMain.on(IPC_COMMANDS.QUICK_ENTRY_CONSUME_RESTORED, (event: IpcMainEvent, id: unknown) => {
			if (!this.#isBar(event.sender) || typeof id !== "string") return;
			this.#restored = consumeRestored(this.#restored, id);
		});
		ipcMain.on(IPC_COMMANDS.QUICK_ENTRY_DISMISS, (event: IpcMainEvent) => {
			if (this.#isBar(event.sender)) this.hide();
		});
		ipcMain.handle(IPC_COMMANDS.QUICK_ENTRY_CLAIM, event => {
			const windowId = this.#chatWindowId(event);
			if (windowId === null) return [];
			const result = claim(this.#queue, windowId);
			this.#queue = result.queue;
			return result.claimed;
		});
		ipcMain.handle(IPC_COMMANDS.QUICK_ENTRY_ACK, (event, id: unknown) => {
			const windowId = this.#chatWindowId(event);
			if (windowId === null || typeof id !== "string") return;
			this.#queue = ack(this.#queue, windowId, id);
		});
		ipcMain.handle(IPC_COMMANDS.QUICK_ENTRY_RETURN, (event, payload: unknown) => {
			const windowId = this.#chatWindowId(event);
			if (windowId === null || typeof payload !== "object" || payload === null) return;
			const { prompt, reason } = payload as { prompt?: { id?: unknown }; reason?: unknown };
			if (typeof prompt?.id !== "string" || typeof reason !== "string" || !FAILURES.has(reason)) return;
			const result = returnPrompt(this.#queue, windowId, prompt.id, reason as QuickEntryFailure);
			this.#queue = result.queue;
			if (result.returned) this.#restore([result.returned]);
		});

		this.#deps.windowManager.subscribeWindowClosed(record => {
			this.#watched.delete(record.id);
			const result = closeWindow(this.#queue, record.id);
			this.#queue = result.queue;
			if (result.returned.length > 0) this.#restore(result.returned);
		});

		// Warm the workspace list so the first summon already offers the saved one.
		void this.#refreshWorkspaces();
	}

	/**
	 * The windows the app opens at startup each show and take focus once their
	 * page is ready (WindowManager's ready-to-show listener, which runs before
	 * this one). A summon before then would be blurred away, so the bar waits for
	 * all of them (or the ceiling). Visibility is no guide: maximize() shows a
	 * restored window before its page has painted.
	 */
	markStartupWindows(windows: readonly BrowserWindow[]): void {
		const waiting = windows.filter(win => !win.isDestroyed());
		if (waiting.length === 0) {
			this.#markSettled();
			return;
		}
		let left = waiting.length;
		for (const win of waiting) {
			let counted = false;
			const settleOne = () => {
				if (counted) return;
				counted = true;
				left -= 1;
				if (left === 0) this.#markSettled();
			};
			win.once("ready-to-show", settleOne);
			win.once("closed", settleOne);
		}
	}

	/** Show the bar now, or once startup has settled. */
	showWhenSettled(): void {
		if (this.#settled || this.#ceilingPassed) {
			this.show();
			return;
		}
		this.#showWhenSettled = true;
	}

	show(): void {
		const win = this.#ensureWindow();
		this.#showId += 1;
		this.#offered = new Set([...this.#workspaces.map(workspace => workspace.cwd), ...this.#restoredCwds]);
		this.#pushState();
		void this.#refreshWorkspaces();
		if (this.#ready) this.#reveal(win);
		else this.#revealOnReady = true;
	}

	hide(): void {
		this.#revealOnReady = false;
		const win = this.#liveWindow();
		if (win?.isVisible()) win.hide();
	}

	toggle(): void {
		if (this.#isShowing()) this.hide();
		else this.showWhenSettled();
	}

	/** Win/Linux: a hidden bar would keep the app alive after its last chat window closed. */
	destroyWindow(): void {
		this.#liveWindow()?.destroy();
		this.#win = null;
		this.#ready = false;
	}

	/** The bar's window, or null before it is built and once it is destroyed. */
	#liveWindow(): BrowserWindow | null {
		return this.#win && !this.#win.isDestroyed() ? this.#win : null;
	}

	#markSettled(): void {
		this.#settled = true;
		this.#flushDeferredShow();
	}

	#flushDeferredShow(): void {
		if (!this.#showWhenSettled) return;
		this.#showWhenSettled = false;
		this.show();
	}

	#ensureWindow(): BrowserWindow {
		const existing = this.#liveWindow();
		if (existing) return existing;
		const darwin = process.platform === "darwin";
		const win = new BrowserWindow({
			...QUICK_ENTRY_SIZE,
			show: false,
			frame: false,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			// Matches pre-paint.js, so the frame never flashes the wrong colour.
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a1a33" : "#f7f9fc",
			// A panel floats over full-screen apps on every Space without activating the app.
			...(darwin ? { type: "panel", hiddenInMissionControl: true } : {}),
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				spellcheck: true,
				preload: join(__dirname, "../preload/index.cjs"),
				additionalArguments: ["--omp-quick-entry"],
			},
		});
		this.#win = win;
		this.#ready = false;
		if (!darwin) win.removeMenu();
		applyWebContentsGuards(win);
		this.#observe(win);
		win.once("ready-to-show", () => {
			this.#ready = true;
			if (!this.#revealOnReady) return;
			this.#revealOnReady = false;
			this.#reveal(win);
		});
		win.on("blur", () => this.#onBlur());
		win.on("closed", () => {
			if (this.#win !== win) return;
			this.#win = null;
			this.#ready = false;
		});
		win.webContents.on("before-input-event", (event, input) => {
			if (isBlockedMenuChord(process.platform, input)) event.preventDefault();
		});
		loadRendererPage(win, "quick-entry");
		return win;
	}

	#observe(win: BrowserWindow): void {
		const log = (message: string, details?: Record<string, string | number | boolean>) =>
			writeRuntimeLog({ source: "quick-entry", message, ...(details ? { details } : {}) });
		win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
			if (errorCode !== -3 && isMainFrame) log(`Quick entry failed to load: ${errorDescription}`, { errorCode });
		});
		win.webContents.on("preload-error", (_event, _path, error) =>
			log(`Quick entry preload failed: ${error.message}`),
		);
		win.webContents.on("console-message", details => {
			if (details.level === "error") log(details.message, { line: details.lineNumber, url: details.sourceId });
		});
		// A crashed bar is rebuilt on the next summon rather than reloaded behind the user's back.
		win.webContents.on("render-process-gone", (_event, details) => {
			log(`Quick entry renderer exited: ${details.reason}`, { exitCode: details.exitCode });
			if (this.#win === win) this.destroyWindow();
		});
	}

	#reveal(win: BrowserWindow): void {
		if (win.isDestroyed()) return;
		if (this.#deps.portalSession) {
			// Native Wayland cannot place a window, and focus() raises mutter's
			// "is ready" notification; a newly mapped window gets focus anyway.
			win.show();
			return;
		}
		const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
		win.setBounds(quickEntryBounds(display.workArea, QUICK_ENTRY_SIZE));
		win.show();
		win.focus();
		win.webContents.focus();
	}

	#onBlur(): void {
		// While startup windows are still appearing, the one that just took focus
		// is the app's own; hiding would lose the summon the user asked for.
		if (!this.#settled) {
			const focused = BrowserWindow.getFocusedWindow();
			if (focused && this.#deps.windowManager.recordFor(focused)) return;
		}
		this.hide();
	}

	#isBar(sender: WebContents): boolean {
		const win = this.#liveWindow();
		return win !== null && sender.id === win.webContents.id;
	}

	/** The chat window behind an IPC call, or null for any other sender (the bar included). */
	#chatWindowId(event: IpcMainInvokeEvent): number | null {
		const win = BrowserWindow.fromWebContents(event.sender);
		const record = win ? this.#deps.windowManager.recordFor(win) : undefined;
		return record ? record.id : null;
	}

	#submit(event: IpcMainInvokeEvent, payload: unknown): QuickEntrySubmitResult {
		if (!this.#isBar(event.sender)) return { ok: false, reason: "invalid" };
		const valid = validateSubmit(payload, this.#offered, isExistingDirectory);
		if (!valid.ok) return valid;
		const { windowManager, sidecarPool, spawnWindow } = this.#deps;
		const existing = windowManager.getMainWindow();
		// Fast path only: the tab spawn in the chat window is the authoritative cap check.
		if (existing && sidecarPool.atCap) return { ok: false, reason: "tab-cap" };
		const win = existing ?? spawnWindow();
		if (!win || win.isDestroyed()) return { ok: false, reason: "no-window" };
		const windowId = win.webContents.id;
		this.#watchReloads(win);
		this.#queue = enqueue(this.#queue, windowId, { id: randomUUID(), text: valid.text, target: valid.target });
		this.#deps.saveTarget(valid.target);
		if (process.platform === "darwin") app.focus({ steal: true });
		// A window spawned just now shows itself once its page is ready.
		if (existing) windowManager.focusWindowById(windowId);
		// A nudge only: the renderer claims the queue itself, and also drains at boot.
		sendWhenLoaded(win, IPC_EVENTS.DEEP_LINK, { action: "quick-entry" });
		this.hide();
		return { ok: true };
	}

	/**
	 * A reloaded renderer keeps its webContents id but lost whatever it had
	 * claimed. `did-navigate` fires only for a committed main-frame load, so an
	 * iframe or a refused drop-navigation never re-delivers a prompt.
	 */
	#watchReloads(win: BrowserWindow): void {
		const windowId = win.webContents.id;
		if (this.#watched.has(windowId)) return;
		this.#watched.add(windowId);
		win.webContents.on("did-navigate", () => {
			this.#queue = releaseLeases(this.#queue, windowId);
		});
	}

	#restore(returned: readonly QuickEntryReturned[]): void {
		this.#restored = [...this.#restored, ...returned];
		this.#offerRestoredWorkspaces(returned);
		// An open bar picks them up now; otherwise the next summon shows them.
		if (this.#isShowing()) this.#pushState();
	}

	/**
	 * A restored prompt's workspace was offered when it was first sent, and the
	 * bar lists it again; it may have dropped out of the recent list since.
	 * Submit still checks that it exists.
	 */
	#offerRestoredWorkspaces(entries: readonly QuickEntryReturned[]): void {
		for (const entry of entries) {
			if (entry.target.kind !== "workspace") continue;
			this.#restoredCwds.add(entry.target.cwd);
			this.#offered.add(entry.target.cwd);
		}
	}

	/** Visible, or about to be once its page has painted. */
	#isShowing(): boolean {
		const win = this.#liveWindow();
		return win !== null && (win.isVisible() || this.#revealOnReady);
	}

	#state(): QuickEntryBarState {
		return {
			language: getMainLanguage(),
			target: resolveInitialTarget(this.#deps.readTarget(), this.#offered),
			workspaces: this.#workspaces,
			restored: this.#restored,
			showId: this.#showId,
		};
	}

	#pushState(): void {
		const win = this.#liveWindow();
		if (win) sendWhenLoaded(win, IPC_EVENTS.QUICK_ENTRY_STATE, this.#state());
	}

	async #refreshWorkspaces(): Promise<void> {
		let sessions: SessionInfo[];
		try {
			sessions = await this.#deps.sessionIndex.list("global");
		} catch (error) {
			writeRuntimeLog({
				source: "quick-entry",
				message: `Quick entry could not list workspaces: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}
		const work = this.#deps.defaultWorkspace();
		const agentSessions = sessions.filter(session => session.kind !== "chat");
		const workspaces: QuickEntryWorkspace[] = [];
		for (const cwd of recentWorkspaceCwds(agentSessions, null, Number.POSITIVE_INFINITY)) {
			if (workspaces.length === QUICK_ENTRY_WORKSPACE_LIMIT) break;
			if (cwd === work || !isExistingDirectory(cwd)) continue;
			workspaces.push({ cwd, name: basename(cwd) || cwd });
		}
		this.#workspaces = workspaces;
		for (const workspace of workspaces) this.#offered.add(workspace.cwd);
		if (this.#isShowing()) this.#pushState();
	}
}
