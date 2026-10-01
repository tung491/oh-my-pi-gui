/**
 * The quick-entry shortcut on Electron's globalShortcut. It registers once at
 * startup, in the same tick as window.toggle: a Wayland portal session binds
 * once, so a second request later in the session would be dropped. Native mode
 * rebinds live; portal mode only saves the change and says it applies after a
 * restart. The rules live in ./quick-entry-shortcut-core.
 */

import {
	BrowserWindow,
	globalShortcut,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
	ipcMain,
	type WebContents,
} from "electron";
import { chordToAccelerator } from "../shared/chord";
import {
	IPC_COMMANDS,
	type QuickEntryShortcutPref,
	type QuickEntryShortcutResult,
	type QuickEntryShortcutState,
	type QuickEntryShortcutUpdate,
} from "../shared/ipc-types";
import {
	planShortcutUpdate,
	type ShortcutMode,
	sanitizeShortcutPref,
	savedChordReplaced,
	shortcutState,
} from "./quick-entry-shortcut-core";
import { writeRuntimeLog } from "./runtime-log";
import type { WindowManager } from "./window";

export interface QuickEntryShortcutDeps {
	readPref: () => unknown;
	savePref: (pref: QuickEntryShortcutPref) => void;
	mode: ShortcutMode;
	desktopEntryMissing: boolean;
	xwaylandOnly: boolean;
	onActivate: () => void;
}

export class QuickEntryShortcut {
	readonly #deps: QuickEntryShortcutDeps;
	#pref: QuickEntryShortcutPref;
	/** What this session registered (null: nothing). */
	#bound: QuickEntryShortcutPref | null = null;
	#registered: boolean | null = null;
	#notice: QuickEntryShortcutState | null = null;
	#noticeTaken = false;
	/** Windows whose shortcut recorder is capturing; handling stays suspended while any is. */
	readonly #suspendedBy = new Set<number>();
	readonly #watchedSenders = new Set<number>();
	// Reads the live flag, so turning the shortcut off in portal mode (where it
	// stays bound until restart) mutes it at once.
	readonly #activate = () => {
		if (this.#pref.enabled) this.#deps.onActivate();
	};

	constructor(deps: QuickEntryShortcutDeps) {
		this.#deps = deps;
		this.#pref = sanitizeShortcutPref(deps.readPref(), process.platform);
	}

	registerAtStartup(): void {
		const raw = this.#deps.readPref();
		if (savedChordReplaced(raw, this.#pref)) {
			writeRuntimeLog({
				source: "global-shortcut",
				message: "saved quick entry shortcut is not allowed; using the default",
				details: { chord: this.#pref.chord },
			});
		}
		if (!this.#pref.enabled) return;
		const accelerator = chordToAccelerator(this.#pref.chord, process.platform);
		if (!accelerator) return;
		this.#registered = globalShortcut.register(accelerator, this.#activate);
		this.#bound = this.#pref;
		writeRuntimeLog({
			source: "global-shortcut",
			message: this.#registered ? "quick entry registered" : `globalShortcut.register refused ${accelerator}`,
			details: { accelerator, portal: this.#deps.mode === "portal" },
		});
		if (!this.#registered) this.#notice = this.state();
	}

	state(): QuickEntryShortcutState {
		return shortcutState({
			pref: this.#pref,
			bound: this.#bound,
			mode: this.#deps.mode,
			registered: this.#registered,
			desktopEntryMissing: this.#deps.desktopEntryMissing,
			xwaylandOnly: this.#deps.xwaylandOnly,
		});
	}

	/** Apply a change from `senderId`'s shortcuts dialog. Saving ends that window's capture. */
	update(senderId: number, update: QuickEntryShortcutUpdate): QuickEntryShortcutResult {
		const native = this.#deps.mode === "native";
		this.#suspendedBy.delete(senderId);
		// New registrations fail while handling is suspended.
		if (native) globalShortcut.setSuspended(false);
		try {
			const plan = planShortcutUpdate(this.#pref, update, this.#deps.mode, process.platform);
			if (plan.kind === "reject") return { ok: false, reason: plan.reason, state: this.state() };
			const unchanged =
				plan.kind === "rebind" && plan.from === plan.to && (plan.to === null || this.#registered === true);
			if (plan.kind === "rebind" && !unchanged) {
				if (plan.from) globalShortcut.unregister(plan.from);
				if (plan.to && !globalShortcut.register(plan.to, this.#activate)) {
					this.#registered = plan.from ? globalShortcut.register(plan.from, this.#activate) : null;
					writeRuntimeLog({
						source: "global-shortcut",
						message: `globalShortcut.register refused ${plan.to}`,
						details: { accelerator: plan.to, portal: false },
					});
					return { ok: false, reason: "refused", state: this.state() };
				}
				this.#registered = plan.to ? true : null;
				this.#bound = plan.next.enabled ? plan.next : null;
			}
			this.#pref = plan.next;
			this.#deps.savePref(plan.next);
			return { ok: true, state: this.state() };
		} finally {
			if (native) globalShortcut.setSuspended(this.#suspendedBy.size > 0);
		}
	}

	/** Native only: the portal grabs the chord in the compositor, which suspension cannot reach. */
	setSuspended(senderId: number, suspended: boolean): void {
		if (this.#deps.mode !== "native") return;
		if (suspended) this.#suspendedBy.add(senderId);
		else this.#suspendedBy.delete(senderId);
		globalShortcut.setSuspended(this.#suspendedBy.size > 0);
	}

	/** The startup refusal, once, for the first window that asks. */
	takeStartupNotice(): QuickEntryShortcutState | null {
		if (this.#noticeTaken) return null;
		this.#noticeTaken = true;
		return this.#notice;
	}

	registerIpc(windowManager: WindowManager): void {
		const isChatWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => {
			const win = BrowserWindow.fromWebContents(event.sender);
			return win !== null && windowManager.recordFor(win) !== undefined;
		};
		ipcMain.handle(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_GET, event => {
			if (!isChatWindow(event)) throw new Error("Quick entry shortcut is managed by the chat windows");
			return this.state();
		});
		ipcMain.handle(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_SET, (event, update: QuickEntryShortcutUpdate) => {
			if (!isChatWindow(event)) throw new Error("Quick entry shortcut is managed by the chat windows");
			return this.update(event.sender.id, update);
		});
		ipcMain.on(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_SUSPEND, (event, suspended: unknown) => {
			if (!isChatWindow(event) || typeof suspended !== "boolean") return;
			this.#watchSender(event.sender);
			this.setSuspended(event.sender.id, suspended);
		});
		ipcMain.handle(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_NOTICE, event =>
			isChatWindow(event) ? this.takeStartupNotice() : null,
		);
	}

	/** A window that reloads, crashes or closes mid-capture must not leave shortcuts suspended. */
	#watchSender(sender: WebContents): void {
		const id = sender.id;
		if (this.#watchedSenders.has(id)) return;
		this.#watchedSenders.add(id);
		const release = () => {
			if (this.#suspendedBy.has(id)) this.setSuspended(id, false);
		};
		// did-navigate: a committed main-frame load. An iframe loading inside the
		// window must not end a capture that is still running.
		sender.on("did-navigate", release);
		sender.on("render-process-gone", release);
		sender.once("destroyed", () => {
			release();
			this.#watchedSenders.delete(id);
		});
	}
}
