/**
 * Builds the `window.omp` object over an {@link IpcPort}. Both shells share
 * this file, so the renderer sees one API whether the port is Electron's
 * `ipcRenderer` or Tauri's `invoke` + `Channel` pair.
 */
import type {
	CustomProviderView,
	DeepLinkPayload,
	IpcActiveTabEnvelope,
	IpcFsListResult,
	IpcFsReadDocumentResult,
	IpcFsReadDocumentStamp,
	IpcFsReadImageResult,
	IpcFsReadPdfResult,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcNativeDropPathsPayload,
	IpcOllamaContextMeasurePayload,
	IpcOllamaContextSetCapPayload,
	IpcOpenPathResult,
	IpcSessionOpenNewWindowPayload,
	IpcSessionOpenNewWindowResult,
	IpcSessionOwner,
	IpcSetTabViewPayload,
	IpcSidecarRestartPayload,
	IpcSidecarStatusPayload,
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabStatusPayload,
	LogBatch,
	MenuAction,
	MenuActionPayload,
	OmpApi,
	QuickEntryFailure,
	QuickEntryPrompt,
	QuickEntryShortcutResult,
	QuickEntryShortcutState,
	QuickEntryShortcutUpdate,
	RunProgressState,
	RuntimeErrorReport,
	SessionInfo,
	TrayState,
	UpdateStatus,
} from "../ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../ipc-types";
import type {
	ContextFitChanged,
	ContextFitEntry,
	ContextFitList,
	ContextFitProgress,
	ModelScreen,
	OllamaInstallProgress,
	OllamaRemedyId,
	OllamaRemedyResult,
	OllamaStatus,
	ProviderConfigCleanupResult,
	PullProgress,
} from "../ollama-types";
import { createSessionRpcClient, timeoutForCommand } from "../rpc-client";
import type {
	AgentSessionEvent,
	AvailableCommand,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	ExtensionUIResponse,
	HostToolCallRequest,
	HostToolResult,
	HostToolUpdate,
	HostUriRequest,
	HostUriResult,
	ModelCatalogUpdateFrame,
	PromptResultFrame,
	RpcCommand,
	RpcLiveUpdateFrame,
	RpcResponse,
	SessionInfoUpdateFrame,
	SubagentFrame,
} from "../rpc-types";
import { DeepLinkBuffer } from "./deep-link-buffer";
import type { IpcPort } from "./ipc-port";

/** Shell-specific members the shared bridge cannot build over an {@link IpcPort}. */
export interface OmpApiShellExtras {
	/** Electron preload passes `webUtils.getPathForFile`; Tauri leaves it out. */
	pathForFile?: (file: File) => string;
	/** The Tauri boot sets this: its shell emits `system:native-drop-paths`. */
	nativeDropPaths?: boolean;
}

/** The string entries of a `system:native-drop-paths` payload; anything malformed yields none. */
function nativeDropPathsOf(payload: unknown): string[] {
	const paths = (payload as Partial<IpcNativeDropPathsPayload> | null)?.paths;
	if (!Array.isArray(paths)) return [];
	return paths.filter((path): path is string => typeof path === "string" && path.length > 0);
}

export function createOmpApi(
	port: IpcPort,
	platform: OmpApi["platform"],
	homeDir = "",
	extras: OmpApiShellExtras = {},
): OmpApi {
	function rpcCommand(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		return port.invoke(IPC_COMMANDS.RPC_COMMAND, {
			command: cmd,
			timeoutMs: timeoutMs ?? timeoutForCommand(cmd),
		}) as Promise<RpcResponse>;
	}

	function isolated<T>(channel: string, callback: (data: T) => void): (data: T) => void {
		return data => {
			// One throwing handler must not stop the other listeners of the same
			// main->renderer channel (Node aborted the rest of an emit; the Tauri
			// fan-out is written the same way). Isolate it and report instead.
			try {
				callback(data);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				port.send(IPC_COMMANDS.RUNTIME_ERROR_REPORT, {
					source: "preload",
					message: `IPC handler for "${channel}" failed: ${failure.message}`,
					stack: failure.stack,
					details: { channel },
				} satisfies RuntimeErrorReport);
			}
		};
	}

	function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
		const handle = isolated(channel, callback);
		return port.on(channel, payload => handle(payload as T));
	}

	let activeTabId: string | null = null;

	// Listening from the start: a cold-start link can land before the renderer subscribes.
	const deepLinks = new DeepLinkBuffer<DeepLinkPayload>();
	// A quick-entry nudge is not held for a late subscriber: the renderer drains
	// quick entry when it boots, and holding the nudge would replace a pending link.
	port.on(IPC_EVENTS.DEEP_LINK, payload => {
		const link = payload as DeepLinkPayload;
		deepLinks.deliver(link, link.action !== "quick-entry");
	});

	function subscribeActiveTab<T>(channel: string, callback: (data: T) => void): () => void {
		return subscribe<IpcActiveTabEnvelope<T>>(channel, envelope => {
			if (activeTabId === null || envelope.tabId === activeTabId) callback(envelope.payload);
		});
	}

	function subscribeTab<T>(channel: string, callback: (data: T, tabId: string) => void): () => void {
		return subscribe<IpcActiveTabEnvelope<T>>(channel, envelope => callback(envelope.payload, envelope.tabId));
	}

	return {
		platform,
		homeDir,
		runtime: {
			report: (error: RuntimeErrorReport) => port.send(IPC_COMMANDS.RUNTIME_ERROR_REPORT, error),
			logPath: () => port.invoke(IPC_COMMANDS.RUNTIME_LOG_PATH) as Promise<string>,
			logSnapshot: () => port.invoke(IPC_COMMANDS.LOG_SNAPSHOT) as Promise<LogBatch>,
		},
		// Fire-and-forget: the guard may show a modal, and the renderer has nothing
		// to learn from the outcome.
		app: {
			quit: () => port.send(IPC_COMMANDS.APP_QUIT),
		},

		rpc: {
			...createSessionRpcClient(rpcCommand),
			commandForTab: (tabId: string, cmd: RpcCommand, timeoutMs?: number) =>
				port.invoke(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, {
					tabId,
					command: cmd,
					timeoutMs: timeoutMs ?? timeoutForCommand(cmd),
				}) as Promise<RpcResponse>,
		},

		events: {
			onBatch: (callback: (events: AgentSessionEvent[]) => void) =>
				subscribeActiveTab<AgentSessionEvent[]>(IPC_EVENTS.EVENTS_BATCH, callback),
			onSidecarStatus: (callback: (status: IpcSidecarStatusPayload) => void) =>
				subscribeActiveTab<IpcSidecarStatusPayload>(IPC_EVENTS.SIDECAR_STATUS, callback),
			onTabStatus: (callback: (payload: IpcTabStatusPayload) => void) =>
				subscribe<IpcTabStatusPayload>(IPC_EVENTS.TAB_STATUS, callback),
			onExtensionUi: (callback: (request: ExtensionUIRequest, tabId: string) => void) =>
				subscribe<{ request: ExtensionUIRequest; tabId: string }>(IPC_EVENTS.EXTENSION_UI, data =>
					callback(data.request, data.tabId),
				),
			onHostToolCall: (callback: (request: HostToolCallRequest) => void) =>
				subscribe<{ request: HostToolCallRequest }>(IPC_EVENTS.HOST_TOOL_CALL, data => callback(data.request)),
			onHostUriRequest: (callback: (request: HostUriRequest) => void) =>
				subscribe<{ request: HostUriRequest }>(IPC_EVENTS.HOST_URI_REQUEST, data => callback(data.request)),
			onSubagentFrame: (callback: (frame: SubagentFrame) => void) =>
				subscribeActiveTab<SubagentFrame>(IPC_EVENTS.SUBAGENT_FRAME, callback),
			onLiveUpdate: (callback: (frame: RpcLiveUpdateFrame) => void) =>
				subscribeActiveTab<RpcLiveUpdateFrame>(IPC_EVENTS.LIVE_UPDATE, callback),
			onModelCatalogUpdate: (callback: (frame: ModelCatalogUpdateFrame) => void) =>
				subscribeActiveTab<ModelCatalogUpdateFrame>(IPC_EVENTS.MODEL_CATALOG_UPDATE, callback),
			onCommandsUpdate: (callback: (commands: AvailableCommand[]) => void) =>
				subscribeActiveTab<AvailableCommand[]>(IPC_EVENTS.COMMANDS_UPDATE, callback),
			onConfigUpdate: (callback: (payload: ConfigUpdateFrame) => void) =>
				subscribeActiveTab<ConfigUpdateFrame>(IPC_EVENTS.CONFIG_UPDATE, callback),
			onSessionsChanged: (callback: () => void) =>
				subscribe<undefined>(IPC_EVENTS.SESSIONS_CHANGED, () => callback()),
			onLogLines: (callback: (lines: string[]) => void) =>
				subscribe<LogBatch>(IPC_EVENTS.LOG_LINE, batch => callback(batch.lines)),
			onLogBatch: (callback: (batch: LogBatch) => void) => subscribe<LogBatch>(IPC_EVENTS.LOG_LINE, callback),
			onPromptResult: (callback: (frame: PromptResultFrame) => void) =>
				subscribeActiveTab<PromptResultFrame>(IPC_EVENTS.PROMPT_RESULT, callback),
			onCommandOutput: (callback: (frame: CommandOutputFrame) => void) =>
				subscribeActiveTab<CommandOutputFrame>(IPC_EVENTS.COMMAND_OUTPUT, callback),
			onSessionInfoUpdate: (callback: (frame: SessionInfoUpdateFrame) => void) =>
				subscribeActiveTab<SessionInfoUpdateFrame>(IPC_EVENTS.SESSION_INFO_UPDATE, callback),
			onExtensionError: (callback: (frame: ExtensionErrorFrame) => void) =>
				subscribeActiveTab<ExtensionErrorFrame>(IPC_EVENTS.EXTENSION_ERROR, callback),
			onTabBatch: (callback: (events: AgentSessionEvent[], tabId: string) => void) =>
				subscribeTab<AgentSessionEvent[]>(IPC_EVENTS.EVENTS_BATCH, callback),
			onTabSidecarStatus: (callback: (status: IpcSidecarStatusPayload, tabId: string) => void) =>
				subscribeTab<IpcSidecarStatusPayload>(IPC_EVENTS.SIDECAR_STATUS, callback),
			onTabSubagentFrame: (callback: (frame: SubagentFrame, tabId: string) => void) =>
				subscribeTab<SubagentFrame>(IPC_EVENTS.SUBAGENT_FRAME, callback),
			onTabModelCatalogUpdate: (callback: (frame: ModelCatalogUpdateFrame, tabId: string) => void) =>
				subscribeTab<ModelCatalogUpdateFrame>(IPC_EVENTS.MODEL_CATALOG_UPDATE, callback),
			onTabCommandsUpdate: (callback: (commands: AvailableCommand[], tabId: string) => void) =>
				subscribeTab<AvailableCommand[]>(IPC_EVENTS.COMMANDS_UPDATE, callback),
			onTabConfigUpdate: (callback: (frame: ConfigUpdateFrame, tabId: string) => void) =>
				subscribeTab<ConfigUpdateFrame>(IPC_EVENTS.CONFIG_UPDATE, callback),
			onTabPromptResult: (callback: (frame: PromptResultFrame, tabId: string) => void) =>
				subscribeTab<PromptResultFrame>(IPC_EVENTS.PROMPT_RESULT, callback),
			onTabCommandOutput: (callback: (frame: CommandOutputFrame, tabId: string) => void) =>
				subscribeTab<CommandOutputFrame>(IPC_EVENTS.COMMAND_OUTPUT, callback),
			onTabSessionInfoUpdate: (callback: (frame: SessionInfoUpdateFrame, tabId: string) => void) =>
				subscribeTab<SessionInfoUpdateFrame>(IPC_EVENTS.SESSION_INFO_UPDATE, callback),
			onTabExtensionError: (callback: (frame: ExtensionErrorFrame, tabId: string) => void) =>
				subscribeTab<ExtensionErrorFrame>(IPC_EVENTS.EXTENSION_ERROR, callback),
			onMenuAction: (callback: (action: MenuAction, payload?: MenuActionPayload) => void) =>
				subscribe<{ action: MenuAction } & MenuActionPayload>(IPC_EVENTS.MENU_ACTION, data =>
					callback(data.action, data),
				),
			onDeepLink: (callback: (link: DeepLinkPayload) => void) =>
				deepLinks.subscribe(isolated(IPC_EVENTS.DEEP_LINK, callback)),
			onUpdaterStatus: (callback: (status: UpdateStatus) => void) =>
				subscribe<UpdateStatus>(IPC_EVENTS.UPDATER_STATUS, callback),
		},

		updater: {
			check: () => port.invoke(IPC_COMMANDS.UPDATER_CHECK) as Promise<UpdateStatus>,
			download: () => port.invoke(IPC_COMMANDS.UPDATER_DOWNLOAD) as Promise<UpdateStatus>,
			apply: () => port.invoke(IPC_COMMANDS.UPDATER_APPLY) as Promise<void>,
			getStatus: () => port.invoke(IPC_COMMANDS.UPDATER_GET_STATUS) as Promise<UpdateStatus>,
			version: () => port.invoke(IPC_COMMANDS.UPDATER_VERSION) as Promise<string>,
		},

		ui: {
			respondExtensionUi: (response: ExtensionUIResponse) => {
				void port.invoke(IPC_COMMANDS.EXTENSION_UI_RESPOND, { response });
			},
			sendHostToolResult: (result: HostToolResult) => {
				void port.invoke(IPC_COMMANDS.HOST_TOOL_RESULT, { result });
			},
			sendHostToolUpdate: (update: HostToolUpdate) => {
				void port.invoke(IPC_COMMANDS.HOST_TOOL_UPDATE, { update });
			},
			sendHostUriResult: (result: HostUriResult) => {
				void port.invoke(IPC_COMMANDS.HOST_URI_RESULT, { result });
			},
		},

		sessions: {
			list: (scope: "local" | "global") =>
				port.invoke(IPC_COMMANDS.SESSIONS_LIST, { scope }) as Promise<SessionInfo[]>,
			delete: (sessionPath: string) => port.invoke(IPC_COMMANDS.SESSIONS_DELETE, { sessionPath }) as Promise<void>,
			rename: (sessionPath: string, name: string) =>
				port.invoke(IPC_COMMANDS.SESSIONS_RENAME, { sessionPath, name }) as Promise<void>,
			search: (query: string, scope: "local" | "global") =>
				port.invoke(IPC_COMMANDS.SESSIONS_SEARCH, { query, scope }) as Promise<string[]>,
			openInNewWindow: (payload: IpcSessionOpenNewWindowPayload) =>
				port.invoke(IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW, payload) as Promise<IpcSessionOpenNewWindowResult>,
			consumePendingOpen: () => port.invoke(IPC_COMMANDS.SESSION_CONSUME_PENDING) as Promise<string | null>,
		},

		tabs: {
			list: () => port.invoke(IPC_COMMANDS.GET_TABS) as Promise<IpcTabInfo[]>,
			spawn: (payload: IpcSpawnTabPayload) =>
				port.invoke(IPC_COMMANDS.SPAWN_TAB, payload) as Promise<IpcSpawnTabResult | null>,
			close: (tabId: string) => port.invoke(IPC_COMMANDS.CLOSE_TAB, { tabId }) as Promise<boolean>,
			setActive: async (tabId: string) => {
				const switched = (await port.invoke(IPC_COMMANDS.SET_ACTIVE_TAB, { tabId })) as boolean;
				if (switched) activeTabId = tabId;
				return switched;
			},
			setView: async (focusedTabId: string, visibleTabIds: string[], split?: IpcSetTabViewPayload["split"]) => {
				const switched = (await port.invoke(IPC_COMMANDS.SET_TAB_VIEW, {
					focusedTabId,
					visibleTabIds,
					split,
				})) as boolean;
				if (switched) activeTabId = focusedTabId;
				return switched;
			},
			getSessionOwner: (sessionPath: string) =>
				port.invoke(IPC_COMMANDS.GET_SESSION_OWNER, { sessionPath }) as Promise<IpcSessionOwner | null>,
		},

		system: {
			openExternal: (url: string) => port.invoke(IPC_COMMANDS.SYSTEM_OPEN_EXTERNAL, url) as Promise<void>,
			openPath: (path: string) => port.invoke(IPC_COMMANDS.SYSTEM_OPEN_PATH, path) as Promise<IpcOpenPathResult>,
			showSaveDialog: (defaultPath?: string, filters?: { name: string; extensions: string[] }[]) =>
				port.invoke(IPC_COMMANDS.SYSTEM_SAVE_DIALOG, defaultPath, filters) as Promise<string | null>,
			showOpenDialog: (filters?: { name: string; extensions: string[] }[], options?: { directory?: boolean }) =>
				port.invoke(IPC_COMMANDS.SYSTEM_OPEN_DIALOG, filters, options) as Promise<string[] | null>,
			clipboardRead: () => port.invoke(IPC_COMMANDS.SYSTEM_CLIPBOARD_READ) as Promise<string>,
			notify: (title: string, body?: string) => {
				void port.invoke(IPC_COMMANDS.SYSTEM_NOTIFY, { title, body });
			},
			pathForFile: extras.pathForFile,
			onNativeDropPaths: extras.nativeDropPaths
				? (callback: (paths: string[]) => void) =>
						subscribe<unknown>(IPC_EVENTS.NATIVE_DROP_PATHS, payload => callback(nativeDropPathsOf(payload)))
				: undefined,
		},

		prefs: {
			get: (key?: string) => port.invoke(IPC_COMMANDS.PREFS_GET, { key }),
			set: (key: string, value: unknown) => port.invoke(IPC_COMMANDS.PREFS_SET, { key, value }) as Promise<void>,
			updateLaunchProfile: (cwd, patch) =>
				port.invoke(IPC_COMMANDS.PREFS_UPDATE_LAUNCH_PROFILE, { cwd, patch }) as ReturnType<
					OmpApi["prefs"]["updateLaunchProfile"]
				>,
		},

		sidecar: {
			restart: (payload?: IpcSidecarRestartPayload) =>
				port.invoke(IPC_COMMANDS.SIDECAR_RESTART, payload) as Promise<void>,
			selectProject: () => port.invoke(IPC_COMMANDS.SIDECAR_SELECT_PROJECT) as Promise<string | null>,
			setProject: (cwd: string) => port.invoke(IPC_COMMANDS.SIDECAR_SET_PROJECT, { cwd }) as Promise<boolean>,
			defaultWorkspace: () => port.invoke(IPC_COMMANDS.SIDECAR_DEFAULT_WORKSPACE) as Promise<string>,
			getStatus: () => port.invoke(IPC_COMMANDS.SIDECAR_STATUS_GET) as Promise<IpcSidecarStatusPayload>,
		},

		tray: {
			pushState: (state: TrayState) => port.send(IPC_EVENTS.TRAY_STATE_PUSH, state),
		},

		progress: {
			set: (state: RunProgressState) => port.send(IPC_EVENTS.PROGRESS_SET, state),
		},

		models: {
			listProviders: () => port.invoke(IPC_COMMANDS.MODELS_PROVIDERS_LIST) as Promise<CustomProviderView[]>,
		},

		ollama: {
			status: () => port.invoke(IPC_COMMANDS.OLLAMA_STATUS) as Promise<OllamaStatus>,
			modelScreen: () => port.invoke(IPC_COMMANDS.OLLAMA_MODEL_SCREEN) as Promise<ModelScreen>,
			pull: (tag: string) => port.invoke(IPC_COMMANDS.OLLAMA_PULL, { tag }) as Promise<PullProgress>,
			cancelPull: () => port.invoke(IPC_COMMANDS.OLLAMA_PULL_CANCEL) as Promise<void>,
			warm: (tag: string) => port.invoke(IPC_COMMANDS.OLLAMA_WARM, { tag }) as Promise<void>,
			// Only the id crosses the bridge; main maps it to the command it runs.
			runRemedy: (id: OllamaRemedyId) =>
				port.invoke(IPC_COMMANDS.OLLAMA_REMEDY, { id }) as Promise<OllamaRemedyResult>,
			openDownload: () => port.invoke(IPC_COMMANDS.OLLAMA_OPEN_DOWNLOAD) as Promise<void>,
			onPullProgress: (callback: (progress: PullProgress) => void) =>
				subscribe<PullProgress>(IPC_EVENTS.OLLAMA_PULL_PROGRESS, callback),
			onInstallProgress: (callback: (progress: OllamaInstallProgress) => void) =>
				subscribe<OllamaInstallProgress>(IPC_EVENTS.OLLAMA_INSTALL_PROGRESS, callback),
			contextList: () => port.invoke(IPC_COMMANDS.OLLAMA_CONTEXT_LIST) as Promise<ContextFitList>,
			measureContext: (tag: string, reason?: IpcOllamaContextMeasurePayload["reason"]) =>
				port.invoke(IPC_COMMANDS.OLLAMA_CONTEXT_MEASURE, {
					tag,
					...(reason && { reason }),
				} satisfies IpcOllamaContextMeasurePayload) as Promise<{ queued: true }>,
			setContextCap: (tag: string, cap: number | null) =>
				port.invoke(IPC_COMMANDS.OLLAMA_CONTEXT_SET_CAP, {
					tag,
					cap,
				} satisfies IpcOllamaContextSetCapPayload) as Promise<ContextFitEntry>,
			onContextProgress: (callback: (progress: ContextFitProgress) => void) =>
				subscribe<ContextFitProgress>(IPC_EVENTS.OLLAMA_CONTEXT_PROGRESS, callback),
			onContextChanged: (callback: (change: ContextFitChanged) => void) =>
				subscribe<ContextFitChanged>(IPC_EVENTS.OLLAMA_CONTEXT_CHANGED, callback),
		},

		providerCleanup: {
			cleanConfig: () => port.invoke(IPC_COMMANDS.PROVIDER_CLEANUP_CONFIG) as Promise<ProviderConfigCleanupResult>,
		},

		fs: {
			list: (path?: string, maxDepth?: number, maxEntries?: number, tabId?: string) =>
				port.invoke(IPC_COMMANDS.FS_LIST, { path, maxDepth, maxEntries, tabId }) as Promise<IpcFsListResult>,
			read: (path: string, maxBytes?: number, tabId?: string) =>
				port.invoke(IPC_COMMANDS.FS_READ, { path, maxBytes, tabId }) as Promise<IpcFsReadResult>,
			readPlan: (payload: IpcFsReadPlanPayload) =>
				port.invoke(IPC_COMMANDS.FS_READ_PLAN, payload) as Promise<IpcFsReadPlanResult>,
			readImage: (path: string, tabId?: string) =>
				port.invoke(IPC_COMMANDS.FS_READ_IMAGE, { path, tabId }) as Promise<IpcFsReadImageResult>,
			readPdf: (path: string) => port.invoke(IPC_COMMANDS.FS_READ_PDF, { path }) as Promise<IpcFsReadPdfResult>,
			readDocument: (path: string, options: { tabId?: string; ifChanged?: IpcFsReadDocumentStamp } = {}) =>
				port.invoke(IPC_COMMANDS.FS_READ_DOCUMENT, {
					path,
					tabId: options.tabId,
					ifChanged: options.ifChanged,
				}) as Promise<IpcFsReadDocumentResult>,
		},

		editor: {
			openExternal: (content: string) =>
				port.invoke(IPC_COMMANDS.EDITOR_OPEN_EXTERNAL, { content }) as Promise<{
					ok: boolean;
					unavailable: boolean;
					text: string | null;
					error?: string;
				}>,
		},

		quickEntry: {
			claimPending: () => port.invoke(IPC_COMMANDS.QUICK_ENTRY_CLAIM) as Promise<QuickEntryPrompt[]>,
			ack: (id: string) => port.invoke(IPC_COMMANDS.QUICK_ENTRY_ACK, id) as Promise<void>,
			returnToBar: (prompt: QuickEntryPrompt, reason: QuickEntryFailure) =>
				port.invoke(IPC_COMMANDS.QUICK_ENTRY_RETURN, { prompt, reason }) as Promise<void>,
			getShortcut: () => port.invoke(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_GET) as Promise<QuickEntryShortcutState>,
			setShortcut: (update: QuickEntryShortcutUpdate) =>
				port.invoke(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_SET, update) as Promise<QuickEntryShortcutResult>,
			suspendShortcuts: (suspended: boolean) => port.send(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_SUSPEND, suspended),
			takeStartupNotice: () =>
				port.invoke(IPC_COMMANDS.QUICK_ENTRY_SHORTCUT_NOTICE) as Promise<QuickEntryShortcutState | null>,
		},
	};
}
