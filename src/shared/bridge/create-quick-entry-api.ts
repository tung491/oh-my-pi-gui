/**
 * window.ompQuickEntry: the whole surface of the quick-entry bar page. The
 * bar exposes this instead of window.omp, so the page reaches no chat-window
 * channel.
 */
import type {
	QuickEntryBarApi,
	QuickEntryBarState,
	QuickEntrySubmitPayload,
	QuickEntrySubmitResult,
} from "../ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../ipc-types";
import type { IpcPort } from "./ipc-port";

export function createQuickEntryApi(port: IpcPort, platform: QuickEntryBarApi["platform"]): QuickEntryBarApi {
	// Main pushes the state on every show, possibly before React subscribes, and
	// a remounting subscriber still needs the current show. So the latest state
	// is kept and replayed to each new subscriber rather than consumed once.
	let latest: QuickEntryBarState | undefined;
	const listeners = new Set<(state: QuickEntryBarState) => void>();
	port.on(IPC_EVENTS.QUICK_ENTRY_STATE, payload => {
		const state = payload as QuickEntryBarState;
		latest = state;
		for (const listener of listeners) listener(state);
	});

	return {
		platform,
		onState(callback) {
			listeners.add(callback);
			if (latest) callback(latest);
			return () => {
				listeners.delete(callback);
			};
		},
		submit: (payload: QuickEntrySubmitPayload) =>
			port.invoke(IPC_COMMANDS.QUICK_ENTRY_SUBMIT, payload) as Promise<QuickEntrySubmitResult>,
		consumeRestored: (id: string) => port.send(IPC_COMMANDS.QUICK_ENTRY_CONSUME_RESTORED, id),
		dismiss: () => port.send(IPC_COMMANDS.QUICK_ENTRY_DISMISS),
	};
}
