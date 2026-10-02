/**
 * The Tauri transport behind `window.omp`: every renderer call becomes one
 * `invoke` of the window's bridge command with a per-page sequence number, and
 * every main→renderer message arrives on one `Channel` attached at boot.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { IpcPort } from "../../shared/bridge/ipc-port";
import { IPC_COMMANDS } from "../../shared/ipc-types";

/** What Rust sends on the page channel. */
export interface BridgeEnvelope {
	channel: string;
	payload: unknown;
}

export type BridgeInvokeCommand = "omp_invoke" | "omp_quick_entry_invoke";

/** The bridge error shape Rust rejects with (`IpcError`). */
function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

/**
 * Build the port for one page. `gen` is the page generation: Rust keys the
 * attach, the ordered dispatcher and the outbound channel on it, so a reload
 * (new gen) drops the previous page's subscribers and queue.
 */
export function createTauriPort(command: BridgeInvokeCommand, gen: string = crypto.randomUUID()): IpcPort {
	let seq = 0;
	const listeners = new Map<string, Set<(payload: unknown) => void>>();

	function report(message: string, details: Record<string, string>): void {
		void invoke(command, {
			channel: IPC_COMMANDS.RUNTIME_ERROR_REPORT,
			args: [{ source: "preload", message, details }],
			seq: seq++,
			gen,
		}).catch(() => {
			// Reporting a failure must never raise a second one.
		});
	}

	function fanOut(envelope: BridgeEnvelope): void {
		const set = listeners.get(envelope.channel);
		if (!set) return;
		// Snapshot: a listener may unsubscribe (or subscribe) while we iterate.
		for (const listener of [...set]) {
			try {
				listener(envelope.payload);
			} catch (error) {
				report(`IPC handler for "${envelope.channel}" failed: ${errorMessage(error)}`, {
					channel: envelope.channel,
				});
			}
		}
	}

	const channel = new Channel<BridgeEnvelope>();
	channel.onmessage = fanOut;
	void invoke("omp_attach", { gen, onMessage: channel }).catch(error => {
		report(`omp_attach failed: ${errorMessage(error)}`, { gen });
	});

	return {
		invoke(channelName, ...args) {
			return invoke(command, {
				channel: channelName,
				args: args.map(arg => (arg === undefined ? null : arg)),
				seq: seq++,
				gen,
			}).catch((error: unknown) => {
				// The renderer's catch sites read `error instanceof Error ? error.message : String(error)`.
				throw new Error(errorMessage(error));
			});
		},
		send(channelName, ...args) {
			void invoke(command, {
				channel: channelName,
				args: args.map(arg => (arg === undefined ? null : arg)),
				seq: seq++,
				gen,
			}).catch(() => {
				// Fire-and-forget: a rejection has no listener.
			});
		},
		on(channelName, listener) {
			let set = listeners.get(channelName);
			if (!set) {
				set = new Set();
				listeners.set(channelName, set);
			}
			set.add(listener);
			return () => {
				const current = listeners.get(channelName);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) listeners.delete(channelName);
			};
		},
	};
}
