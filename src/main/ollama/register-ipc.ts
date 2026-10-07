/**
 * IPC for the local Ollama service. The only module here that touches
 * Electron (`ipcMain`, `app`, `shell`, `webContents`); the rest is plain Node
 * so it can be unit-tested against a fake daemon.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain, shell, type WebContents, webContents } from "electron";
import Store from "electron-store";
import { CONTEXT_FIT_PREF, CONTEXT_LIMITS_OVERLAY_FILE } from "../../shared/context-fit-store";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import { chooseModels, OLLAMA_CATALOG } from "../../shared/ollama-catalog";
import type {
	ContextFitEntry,
	ContextFitList,
	MachineFacts,
	ModelScreen,
	OllamaInstallProgress,
	OllamaRemedyResult,
	OllamaStatus,
	PullProgress,
} from "../../shared/ollama-types";
import { listModelsProviders } from "../models-config";
import { resolveLoginShellEnv } from "../shell-env";
import type { SidecarPool } from "../sidecar-pool";
import { resolveOllamaBaseUrl } from "./base-url";
import {
	ContextFitScheduler,
	fetchTagRows,
	parseEnvCap,
	parseMeasureRequest,
	parseSetCapRequest,
} from "./context-fit-scheduler";
import { readMachine } from "./hardware";
import { throttleInstallProgress } from "./install-progress";
import { isRecord, probeOllama } from "./probe";
import { isValidModelTag, OllamaPuller, type PullListener } from "./pull";
import { createRemedyGate, isRemedyId, runRemedy } from "./remedy";
import { warmModel } from "./warm";

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

/** The renderer's flag for a closed welcome dialog (`WELCOME_COMPLETED_PREF`). */
const WELCOME_COMPLETED_PREF = "welcome.completed";

/** Send to every live window: the welcome screen and Settings may both be watching. */
function broadcast(channel: string, payload: unknown): void {
	for (const contents of webContents.getAllWebContents()) {
		if (!contents.isDestroyed()) contents.send(channel, payload);
	}
}

function broadcastInstallProgress(frame: OllamaInstallProgress): void {
	broadcast(IPC_EVENTS.OLLAMA_INSTALL_PROGRESS, frame);
}

/** Where every sidecar reads its per-model Ollama context limits. */
export function contextLimitsOverlayPath(): string {
	return join(app.getPath("userData"), CONTEXT_LIMITS_OVERLAY_FILE);
}

/** A temp file then a rename, so a sidecar never reads a half-written overlay. */
function writeFileAtomically(file: string, text: string): void {
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, text);
	renameSync(temp, file);
}

function readMachineFacts(): Promise<MachineFacts | null> {
	return readMachine({ gpuInfo: () => app.getGPUInfo("complete") });
}

function hasConfiguredOllamaProvider(): boolean {
	try {
		return listModelsProviders().some(provider => provider.id === "ollama");
	} catch (error) {
		console.warn(
			`[ollama] reading the models config failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/** The app-wide context-fit queue, wired to the pool, the prefs file and the overlay. */
function createContextFitScheduler(pool: SidecarPool): ContextFitScheduler {
	const prefs = new Store<Record<string, unknown>>({ name: "prefs" });
	const overlay = contextLimitsOverlayPath();
	// The user's own value: the launch env wins, as it does for the sidecar; the GUI's default never appears here.
	let shellEnvCap: string | undefined;
	const scheduler = new ContextFitScheduler({
		baseUrl: resolveOllamaBaseUrl,
		listRows: baseUrl => fetchTagRows(baseUrl),
		readMachine: readMachineFacts,
		isBusy: () => pool.anyInFlight(),
		welcomeDone: () => Boolean(prefs.get(WELCOME_COMPLETED_PREF)),
		configuredProvider: hasConfiguredOllamaProvider,
		envCap: () => parseEnvCap(process.env.OLLAMA_CONTEXT_LENGTH ?? shellEnvCap),
		readStore: () => prefs.get(CONTEXT_FIT_PREF),
		writeStore: store => prefs.set(CONTEXT_FIT_PREF, store),
		writeOverlay: yaml => writeFileAtomically(overlay, yaml),
		onProgress: progress => broadcast(IPC_EVENTS.OLLAMA_CONTEXT_PROGRESS, progress),
		onChanged: change => broadcast(IPC_EVENTS.OLLAMA_CONTEXT_CHANGED, change),
		idleSessions: () =>
			pool.idleTabIds().map(tabId => ({ command: command => pool.commandForIdleTab(tabId, command) })),
	});
	scheduler.start();
	void resolveLoginShellEnv().then(
		shell => {
			shellEnvCap = shell.env.OLLAMA_CONTEXT_LENGTH;
			scheduler.refreshOverlay();
		},
		error => console.warn(`[ollama] reading the login shell env failed: ${String(error)}`),
	);
	return scheduler;
}

function tagOf(payload: unknown): unknown {
	return isRecord(payload) ? payload.tag : undefined;
}

export interface OllamaIpcDeps {
	sidecarPool: SidecarPool;
}

export function registerOllamaIpc(deps: OllamaIpcDeps): void {
	// Start the login-shell probe now so the first status request is not the one paying for it.
	void resolveOllamaBaseUrl();
	const contextFit = createContextFitScheduler(deps.sidecarPool);

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

	ipcMain.handle(IPC_COMMANDS.OLLAMA_STATUS, async (): Promise<OllamaStatus> => {
		const status = await probeOllama();
		if (status.state === "ok") contextFit.noteOllamaAnswered();
		return status;
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_MODEL_SCREEN, async (): Promise<ModelScreen> => {
		const [machine, status] = await Promise.all([readMachineFacts(), probeOllama()]);
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
		// The gate joins repeat requests to one run, so each run gets one throttled broadcaster.
		id =>
			runRemedy(id, { probe: () => probeOllama(), onProgress: throttleInstallProgress(broadcastInstallProgress) }),
	);
	ipcMain.handle(IPC_COMMANDS.OLLAMA_REMEDY, (_event, payload: unknown): Promise<OllamaRemedyResult> => {
		const id = isRecord(payload) ? payload.id : undefined;
		if (!isRemedyId(id)) throw new Error("Unknown Ollama remedy");
		return remedy(id);
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_OPEN_DOWNLOAD, async () => {
		await shell.openExternal(OLLAMA_DOWNLOAD_URL);
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_CONTEXT_LIST, (): Promise<ContextFitList> => contextFit.list());

	ipcMain.handle(IPC_COMMANDS.OLLAMA_CONTEXT_MEASURE, async (_event, payload: unknown): Promise<{ queued: true }> => {
		const { tag, reason } = parseMeasureRequest(payload);
		await contextFit.enqueue(tag, reason);
		return { queued: true };
	});

	ipcMain.handle(IPC_COMMANDS.OLLAMA_CONTEXT_SET_CAP, (_event, payload: unknown): Promise<ContextFitEntry> => {
		const { tag, cap } = parseSetCapRequest(payload);
		return contextFit.setCap(tag, cap);
	});
}
