import type { IpcSidecarStatusPayload } from "../../shared/ipc-types";

/**
 * Resolve once the active tab's sidecar reports ready. A cold-start omp://
 * link reaches the renderer while the sidecar is still spawning, and every
 * RPC is refused until then.
 */
export function whenSidecarReady(
	getStatus: () => Promise<IpcSidecarStatusPayload>,
	onStatus: (callback: (status: IpcSidecarStatusPayload) => void) => () => void,
): Promise<void> {
	return new Promise(resolve => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const settle = () => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			resolve();
		};
		unsubscribe = onStatus(status => {
			if (status.status === "ready") settle();
		});
		if (settled) unsubscribe();
		void getStatus().then(
			status => {
				if (status.status === "ready") settle();
			},
			() => {},
		);
	});
}
