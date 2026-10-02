/**
 * IPC for the local Ollama service. The only module here that touches
 * Electron (`ipcMain`, `app`, `shell`, `webContents`); the rest is plain Node
 * so it can be unit-tested against a fake daemon.
 */
import { app, ipcMain, shell, type WebContents } from "electron";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import { chooseModels, OLLAMA_CATALOG } from "../../shared/ollama-catalog";
import type { ModelScreen, OllamaRemedyResult, OllamaStatus, PullProgress } from "../../shared/ollama-types";
import { resolveOllamaBaseUrl } from "./base-url";
import { readMachine } from "./hardware";
import { isRecord, probeOllama } from "./probe";
import { isValidModelTag, OllamaPuller, type PullListener } from "./pull";
import { createRemedyGate, isRemedyId, runRemedy } from "./remedy";
import { warmModel } from "./warm";

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

function tagOf(payload: unknown): unknown {
	return isRecord(payload) ? payload.tag : undefined;
}

export function registerOllamaIpc(): void {
	// Start the login-shell probe now so the first status request is not the one paying for it.
	void resolveOllamaBaseUrl();

	const puller = new OllamaPuller({ baseUrl: resolveOllamaBaseUrl });
	// One listener per renderer, so a renderer that joins its own running pull is not sent each frame twice.
	const listeners = new WeakMap<WebContents, PullListener>();
	const listenerFor = (contents: WebContents): PullListener => {
		let listener = listeners.get(contents);
		if (!listener) {
			listener = progress => {
				if (!contents.isDestroyed()) contents.send(IPC_EVENTS.OLLAMA_PULL_PROGRESS, progress);
			};
			listeners.set(contents, listener);
		}
		return listener;
	};

	ipcMain.handle(IPC_COMMANDS.OLLAMA_STATUS, (): Promise<OllamaStatus> => probeOllama());

	ipcMain.handle(IPC_COMMANDS.OLLAMA_MODEL_SCREEN, async (): Promise<ModelScreen> => {
		const [machine, status] = await Promise.all([
			readMachine({ gpuInfo: () => app.getGPUInfo("complete") }),
			probeOllama(),
		]);
		return chooseModels(machine, OLLAMA_CATALOG, status.state === "ok" ? status.installedTags : null);
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_PULL, (event, payload: unknown): Promise<PullProgress> => {
		const tag = tagOf(payload);
		// The puller answers an invalid tag with an error frame; pass a string so the frame can echo it.
		return puller.pull(typeof tag === "string" ? tag : "", listenerFor(event.sender));
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_PULL_CANCEL, () => {
		puller.cancel();
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_WARM, async (_event, payload: unknown) => {
		const tag = tagOf(payload);
		if (!isValidModelTag(tag)) throw new Error("Invalid model name");
		const baseUrl = await resolveOllamaBaseUrl();
		// Fire and forget: loading can take minutes and warmModel logs its own failures.
		void warmModel(baseUrl, tag);
	});

	const remedy = createRemedyGate(
		() => probeOllama(),
		id => runRemedy(id, { probe: () => probeOllama() }),
	);
	ipcMain.handle(IPC_COMMANDS.OLLAMA_REMEDY, (_event, payload: unknown): Promise<OllamaRemedyResult> => {
		const id = isRecord(payload) ? payload.id : undefined;
		if (!isRemedyId(id)) throw new Error("Unknown Ollama remedy");
		return remedy(id);
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_OPEN_DOWNLOAD, async () => {
		await shell.openExternal(OLLAMA_DOWNLOAD_URL);
	});
}
