/**
 * Electron preload: exposes `window.omp` through contextBridge, or only
 * `window.ompQuickEntry` in the quick-entry bar (main passes --omp-quick-entry).
 * The API itself is built by the shared bridge code over an ipcRenderer port.
 */
import { contextBridge, ipcRenderer } from "electron";
import { createOmpApi } from "../shared/bridge/create-omp-api";
import { createQuickEntryApi } from "../shared/bridge/create-quick-entry-api";
import type { IpcPort } from "../shared/bridge/ipc-port";

const port: IpcPort = {
	invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
	send: (channel, ...args) => ipcRenderer.send(channel, ...args),
	on: (channel, listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
		ipcRenderer.on(channel, wrapped);
		return () => {
			ipcRenderer.removeListener(channel, wrapped);
		};
	},
};

// One sandboxed bundle serves both pages: a sandboxed preload cannot require a
// shared chunk, so the bar is told apart by the argument main adds for it.
const isQuickEntry = process.argv.includes("--omp-quick-entry");

if (isQuickEntry) contextBridge.exposeInMainWorld("ompQuickEntry", createQuickEntryApi(port, process.platform));
// A sandboxed preload still sees the process env; the sidecar inherits the same HOME.
else contextBridge.exposeInMainWorld("omp", createOmpApi(port, process.platform, process.env.HOME ?? ""));
