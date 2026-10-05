/**
 * The transport under `window.omp`. The Electron preload backs it with
 * `ipcRenderer`; the Tauri boot module backs it with one `invoke` command and
 * one `Channel` per page. `createOmpApi` and `createQuickEntryApi` build the
 * renderer-facing API on top of it and know nothing about either shell.
 */
export interface IpcPort {
	/** Request/response. Rejections surface as `Error` objects with the main-side message. */
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	/** Fire-and-forget. Never rejects. */
	send(channel: string, ...args: unknown[]): void;
	/** Synchronous subscription to a main→renderer channel; returns the remover. */
	on(channel: string, listener: (payload: unknown) => void): () => void;
}
