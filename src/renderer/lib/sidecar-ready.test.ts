import { describe, expect, it } from "vitest";
import type { IpcSidecarStatusPayload } from "../../shared/ipc-types";
import { whenSidecarReady } from "./sidecar-ready";

type Listener = (status: IpcSidecarStatusPayload) => void;

function statusSource(initial: string) {
	const listeners = new Set<Listener>();
	return {
		listeners,
		getStatus: async () => ({ status: initial }) as IpcSidecarStatusPayload,
		onStatus: (listener: Listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (status: string) => {
			for (const listener of [...listeners]) listener({ status } as IpcSidecarStatusPayload);
		},
	};
}

describe("whenSidecarReady", () => {
	it("resolves at once when the sidecar is already ready", async () => {
		const source = statusSource("ready");
		await whenSidecarReady(source.getStatus, source.onStatus);
		expect(source.listeners.size).toBe(0);
	});

	it("waits through non-ready statuses and unsubscribes once ready", async () => {
		const source = statusSource("starting");
		let resolved = false;
		const waiting = whenSidecarReady(source.getStatus, source.onStatus).then(() => {
			resolved = true;
		});
		await Promise.resolve();
		source.emit("starting");
		await Promise.resolve();
		expect(resolved).toBe(false);
		source.emit("ready");
		await waiting;
		expect(resolved).toBe(true);
		expect(source.listeners.size).toBe(0);
	});
});
