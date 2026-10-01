/**
 * window.ompQuickEntry: the whole surface of the quick-entry bar page. The
 * bar's preload exposes this instead of window.omp, so the page reaches no
 * chat-window channel.
 */
import { ipcRenderer } from "electron";
import type {
	QuickEntryBarApi,
	QuickEntryBarState,
	QuickEntrySubmitPayload,
	QuickEntrySubmitResult,
} from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";

export function buildQuickEntryBarApi(): QuickEntryBarApi {
	// Main pushes the state on every show, possibly before React subscribes, and
	// a remounting subscriber still needs the current show. So the latest state
	// is kept and replayed to each new subscriber rather than consumed once.
	let latest: QuickEntryBarState | undefined;
	const listeners = new Set<(state: QuickEntryBarState) => void>();
	ipcRenderer.on(IPC_EVENTS.QUICK_ENTRY_STATE, (_event, state: QuickEntryBarState) => {
		latest = state;
		for (const listener of listeners) listener(state);
	});

	return {
		platform: process.platform,
		onState(callback) {
			listeners.add(callback);
			if (latest) callback(latest);
			return () => {
				listeners.delete(callback);
			};
		},
		submit: (payload: QuickEntrySubmitPayload) =>
			ipcRenderer.invoke(IPC_COMMANDS.QUICK_ENTRY_SUBMIT, payload) as Promise<QuickEntrySubmitResult>,
		consumeRestored: (id: string) => ipcRenderer.send(IPC_COMMANDS.QUICK_ENTRY_CONSUME_RESTORED, id),
		dismiss: () => ipcRenderer.send(IPC_COMMANDS.QUICK_ENTRY_DISMISS),
	};
}
