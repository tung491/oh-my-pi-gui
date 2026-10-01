/**
 * Main process entry point for the omp GUI.
 * App lifecycle: ready → window, sidecar, session index, IPC, tray, menu, deep links, updater.
 */

import "./pin-user-data";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, globalShortcut, nativeImage, session } from "electron";
import Store from "electron-store";
import { nativeAccelerator } from "../shared/hotkeys";
import type { QuickEntryShortcutPref, QuickEntryTarget, SessionKind } from "../shared/ipc-types";
import { APP_ID, PRODUCT_NAME } from "../shared/product";
import { installQuitGuard, requestQuit } from "./app-quit";
import { bundledOmpFilename, resolveOmpCandidate } from "./bundled-omp-path";
import { DEEP_LINK_PROTOCOL, setupDeepLinks } from "./deep-link";
import { ensureDefaultWorkspace } from "./default-workspace";
import { firstUsableCwd } from "./initial-cwd";
import { registerIpcHandlers } from "./ipc";
import { launchArguments, parseLaunchArgv } from "./launch-argv";
import { LogWatcher } from "./log-watcher";
import { createMenu } from "./menu";
import { QuickEntryController } from "./quick-entry";
import { QuickEntryShortcut } from "./quick-entry-shortcut";
import { writeRuntimeLog } from "./runtime-log";
import { SessionIndex } from "./session-index";
import { shellSpawnEnv } from "./shell-env";
import { SidecarManager } from "./sidecar";
import { SidecarPool } from "./sidecar-pool";
import { StatsClient } from "./stats-client";
import { StatsServerManager } from "./stats-server";
import { type PersistedTabLayout, sanitizePersistedTabLayouts } from "./tab-layout";
import { createTray, destroyTray } from "./tray";
import { setupUpdater } from "./updater";
import {
	desktopEntryCandidates,
	mergeEnableFeatures,
	PORTAL_SHORTCUT_FEATURES,
	usesShortcutPortal,
} from "./wayland-portal";
import { WindowManager } from "./window";
import { resolveWindowSpawnTarget } from "./window-spawn-target";

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

// Native-Wayland global shortcuts go through the GlobalShortcuts portal, which
// Chromium reaches only with these features on. Chromium keeps one
// --enable-features value, so a user's own list is merged rather than replaced.
// Inert on X11; Chromium reads the list after this script runs.
if (process.platform === "linux") {
	app.commandLine.appendSwitch(
		"enable-features",
		mergeEnableFeatures(app.commandLine.getSwitchValue("enable-features"), PORTAL_SHORTCUT_FEATURES),
	);
}

// App identity: the dev run shows "Electron" + the default atom icon in the
// dock otherwise. Packaged builds get both from the bundle via electron-builder.
// The name no longer decides the profile path (./pin-user-data fixes it), and
// it comes after the lock because Windows keys that lock on the name.
app.setName(PRODUCT_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
{
	const dockIcon = join(app.getAppPath(), "resources", "icon.png");
	if (process.platform === "darwin" && existsSync(dockIcon)) {
		app.dock?.setIcon(nativeImage.createFromPath(dockIcon));
	}
}

/**
 * Locate the GUI's built-in omp binary — the ONLY sidecar the GUI runs in the
 * closed loop. Packaged apps ship it at `process.resourcesPath/omp`; in dev it
 * lives at `packages/gui/resources/omp` (built by `bun --cwd=packages/gui run
 * build:omp`). No system-installed omp is consulted and there is no external
 * fallback: when it is missing the GUI surfaces an error telling the user to
 * build it. The workspace source sidecar is available only as an explicit dev
 * override (`OMP_SIDECAR=source`), never automatically.
 */
function resolveBundledOmp(): string | null {
	const override = process.env.OMP_BUNDLED_OMP;
	if (override && existsSync(override)) return override;
	const name = bundledOmpFilename();
	if (process.resourcesPath) {
		const packaged =
			resolveOmpCandidate(process.resourcesPath, name) ?? resolveOmpCandidate(process.resourcesPath, "omp");
		if (packaged) return packaged;
	}
	for (const start of [app.getAppPath(), process.cwd()]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			const direct = resolveOmpCandidate(dir, "resources", name) ?? resolveOmpCandidate(dir, "resources", "omp");
			if (direct) return direct;
			const nested =
				resolveOmpCandidate(dir, "packages", "gui", "resources", name) ??
				resolveOmpCandidate(dir, "packages", "gui", "resources", "omp");
			if (nested) return nested;
			const parent = join(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

/**
 * Dev-only explicit override (`OMP_SIDECAR=source`): run the workspace
 * coding-agent source CLI instead of the bundled binary. Used to exercise
 * in-repo changes without rebuilding the binary. Returns null otherwise.
 */
function resolveSourceCli(): string | null {
	if (process.env.OMP_SIDECAR !== "source") return null;
	const explicit = process.env.OMP_SIDECAR_CLI;
	if (explicit && existsSync(explicit)) return explicit;
	for (const start of [app.getAppPath(), process.cwd()]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			const cli = join(dir, "packages", "coding-agent", "src", "cli.ts");
			if (existsSync(cli)) return cli;
			const parent = join(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

interface MainPrefs {
	lastProject?: string;
	proxyUrl?: string;
	/** One layout per live window, in window order. */
	tabLayouts?: PersistedTabLayout[];
	/** Pre-multi-window shape, migrated on the first persist. */
	tabLayout?: PersistedTabLayout;
	/** The quick-entry bar's last target. */
	quickEntryTarget?: QuickEntryTarget;
	/** The quick-entry chord; main validates it on every read and write. */
	quickEntryShortcut?: QuickEntryShortcutPref;
	[key: string]: unknown;
}

let mainPrefsStore: Store<MainPrefs> | null = null;

function prefsStore(): Store<MainPrefs> {
	mainPrefsStore ??= new Store<MainPrefs>({ name: "prefs" });
	return mainPrefsStore;
}

function resolveExplicitStartupCwd(): string | undefined {
	// Packaged Linux/Windows argv is [exe, …args]; a dev run is [electron, appDir, …args].
	const request = parseLaunchArgv(launchArguments(process.argv, Boolean(process.defaultApp)), DEEP_LINK_PROTOCOL);
	return request.kind === "path" ? resolve(request.path) : undefined;
}

function resolveInitialCwd(): string {
	const explicitCwd = resolveExplicitStartupCwd();
	if (explicitCwd) return explicitCwd;
	return firstUsableCwd([prefsStore().get("lastProject"), process.cwd()]) ?? homedir();
}

// ──────────────────────────────────────────────────────────────────────────
// Sidecar proxy env
// ──────────────────────────────────────────────────────────────────────────
// The agent reads proxy config from env vars only (PI_PROXY_* → PI_PROXY →
// HTTPS_PROXY → ALL_PROXY). A Finder-launched app has no shell env, so a
// proxy-only network (codex's chatgpt.com backend behind a firewall) would
// silently hang every provider request. Resolution order per spawn:
// explicit GUI pref → inherited env (terminal launch) → macOS system proxy.

/** Expand one proxy URL into the full env-var set the agent and Bun honor. */
function proxyEnvVars(proxyUrl: string): Record<string, string> {
	return {
		PI_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		HTTP_PROXY: proxyUrl,
		ALL_PROXY: proxyUrl,
		https_proxy: proxyUrl,
		http_proxy: proxyUrl,
		all_proxy: proxyUrl,
	};
}

/** Accept "127.0.0.1:7890" shorthand; keep explicit schemes as-is. */
function normalizeProxyUrl(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.includes("://")) return trimmed;
	return `http://${trimmed}`;
}

/** First entry of a Chromium PAC result → URL ("PROXY h:p" / "SOCKS5 h:p" / "DIRECT"). */
function parsePacResult(pac: string): string | undefined {
	const first = pac.split(";")[0]?.trim() ?? "";
	const [kind, endpoint] = first.split(/\s+/, 2);
	if (!endpoint) return undefined;
	if (kind === "PROXY") return `http://${endpoint}`;
	if (kind === "HTTPS") return `https://${endpoint}`;
	if (kind === "SOCKS" || kind === "SOCKS5") return `socks5://${endpoint}`;
	return undefined;
}

/** Representative URL for system-proxy resolution (codex's OAuth backend). */
const SYSTEM_PROXY_PROBE_URL = "https://chatgpt.com";

async function resolveProxyEnvForSpawn(): Promise<Record<string, string>> {
	const pref = prefsStore().get("proxyUrl");
	if (typeof pref === "string" && pref.trim()) return proxyEnvVars(normalizeProxyUrl(pref));
	if (
		process.env.PI_PROXY ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.ALL_PROXY ||
		process.env.all_proxy
	) {
		return {};
	}
	try {
		const pac = await session.defaultSession.resolveProxy(SYSTEM_PROXY_PROBE_URL);
		const systemProxy = parsePacResult(pac);
		return systemProxy ? proxyEnvVars(systemProxy) : {};
	} catch {
		return {};
	}
}

// Module-level instances (alive for app lifetime)
let windowManager: WindowManager;
let sidecarPool: SidecarPool;
let statsServer: StatsServerManager | null = null;
let sessionIndex: SessionIndex;
let statsClient: StatsClient;
let logWatcher: LogWatcher;
let quickEntry: QuickEntryController | null = null;
let quickEntryShortcut: QuickEntryShortcut | null = null;

function errorMessage(value: unknown): { message: string; stack?: string } {
	if (value instanceof Error) return { message: value.message, stack: value.stack };
	if (typeof value === "string") return { message: value };
	try {
		return { message: JSON.stringify(value) ?? String(value) };
	} catch {
		return { message: String(value) };
	}
}

function installMainRuntimeLogging(): void {
	process.on("uncaughtExceptionMonitor", (error, origin) => {
		writeRuntimeLog({ source: "main-uncaught", ...errorMessage(error), details: { origin } });
	});
	process.on("unhandledRejection", reason => {
		writeRuntimeLog({ source: "main-unhandled-rejection", ...errorMessage(reason) });
	});
	app.on("child-process-gone", (_event, details) => {
		writeRuntimeLog({
			source: "child-process",
			message: `${details.type} process exited: ${details.reason}`,
			details: {
				type: details.type,
				reason: details.reason,
				exitCode: details.exitCode,
				serviceName: details.serviceName ?? null,
				name: details.name ?? null,
			},
		});
	});
}

/**
 * The saved session: one tab layout per window. Reads tolerate both the current
 * array and the pre-multi-window single layout written by older builds.
 */
function readSavedTabLayouts(): PersistedTabLayout[] {
	const store = prefsStore();
	const layouts = sanitizePersistedTabLayouts(store.get("tabLayouts"));
	if (layouts.length > 0) return layouts;
	return sanitizePersistedTabLayouts(store.get("tabLayout"));
}

/**
 * Rewrite the saved session from the live windows. Runs on every tab change and
 * every window close, so a window the user closed for good never comes back and
 * a secondary window's tabs are no longer dropped on the floor.
 */
function persistTabLayouts(): void {
	const layouts: PersistedTabLayout[] = [];
	for (const win of windowManager.getAllWindows()) {
		const layout = sidecarPool.tabLayoutForWindow(win);
		if (layout) layouts.push(layout);
	}
	// No live window means the app is quitting (or idle in the dock), not that
	// the session was abandoned — writing an empty set would wipe the restore.
	if (layouts.length === 0) return;
	const store = prefsStore();
	store.set("tabLayouts", layouts);
	store.delete("tabLayout");
}

/** Reopen one saved window: its tabs in order, at the layout's active cwd. */
function spawnWindowWithLayout(layout: PersistedTabLayout): BrowserWindow | null {
	const activeCwd = layout.tabs[layout.activeIndex]?.cwd ?? layout.tabs[0]?.cwd;
	if (!activeCwd) return null;
	const win = windowManager.createWindow({ cwd: activeCwd });
	if (sidecarPool.restoreLayout(win, layout) > 0) return win;
	win.close();
	return null;
}

/** Spawn a window with its own sidecar (the pool's 1:1 owner). Null at cap.
 *  With no target, create a fresh global chat; explicit workspace/session
 *  requests retain their selected/fallback cwd and requested session kind. */
function spawnWindow(cwd?: string, pendingSessionPath?: string, kind?: SessionKind): BrowserWindow | null {
	const restoreSavedLayout = cwd === undefined && pendingSessionPath === undefined && kind === undefined;
	if (restoreSavedLayout) {
		const [saved] = readSavedTabLayouts();
		if (saved) {
			const restored = spawnWindowWithLayout(saved);
			if (restored) return restored;
		}
	}
	const target = resolveWindowSpawnTarget(
		cwd,
		pendingSessionPath,
		kind,
		resolveInitialCwd(),
		ensureDefaultWorkspace(),
	);
	const win = windowManager.createWindow({ cwd: target.cwd, pendingSessionPath });
	const sidecar = sidecarPool.acquire(
		target.cwd,
		win,
		undefined,
		undefined,
		target.kind,
		undefined,
		target.fresh,
		target.placeholder,
	);
	if (!sidecar) {
		win.close();
		return null;
	}
	return win;
}

app.whenReady().then(() => {
	installMainRuntimeLogging();
	windowManager = new WindowManager();

	const initialCwd = resolveInitialCwd();
	const explicitStartupCwd = resolveExplicitStartupCwd();
	const bundledOmp = resolveBundledOmp();
	const sourceCli = resolveSourceCli();
	sidecarPool = new SidecarPool((cwd, kind, fresh) => {
		const sc = new SidecarManager({
			binaryPath: bundledOmp ?? "",
			packaged: app.isPackaged,
			sourceCli: sourceCli ?? undefined,
			cwd,
			kind,
			fresh,
			proxyEnv: resolveProxyEnvForSpawn,
			shellEnv: shellSpawnEnv,
			// Finder-launched omp has no terminal, and a sidecar that dies before
			// it can write its own log only speaks through stderr — land the tail
			// in gui-runtime.jsonl so it is readable after the fact.
			reportFailure: report => {
				writeRuntimeLog(
					{
						source: "sidecar-restart",
						message: report.reason,
						details: { attempt: report.attempt, maxAttempts: report.maxAttempts, stderr: report.stderr },
					},
					{ cwd: report.cwd },
				);
			},
		});
		// Ready-health-check applies to every pooled sidecar, not just the first.
		sc.on("status", ({ status }) => {
			if (status !== "ready") return;
			const client = sc.rpcClient;
			if (!client) return;
			client
				.command({ type: "get_state" })
				.then(res => {
					if (!res.success) sc.markUnhealthy(`Health check failed: ${res.error ?? "unknown"}`);
				})
				.catch(err => {
					sc.markUnhealthy(`Health check timed out: ${err instanceof Error ? err.message : String(err)}`);
				});
		});
		return sc;
	}, 10);
	sidecarPool.onWindowTabsChanged = () => persistTabLayouts();
	// A closed window's tabs have to leave the saved session with it, or the next
	// launch resurrects a window the user deliberately shut.
	windowManager.subscribeWindowClosed(() => persistTabLayouts());
	sessionIndex = new SessionIndex(undefined, initialCwd);
	statsClient = new StatsClient();
	// Built-in stats dashboard: spawned from the SAME bundled binary. No
	// external `omp stats` process is required (closed loop). Not started here:
	// it is a whole second runtime most sessions never read, so the first
	// dashboard request spawns it through the STATS_FETCH revive path.
	if (bundledOmp) {
		statsServer = new StatsServerManager(bundledOmp);
		statsServer.on("ready", (port: number) => {
			statsClient.port = port;
		});
		statsServer.on("exit", () => {
			statsClient.port = 0;
		});
	}
	logWatcher = new LogWatcher();

	// Register all handlers and sidecar listeners before loading the renderer.
	registerIpcHandlers({
		sidecarPool,
		sessionIndex,
		statsClient,
		statsRestart: () => statsServer?.ensureRunning() ?? "exhausted",
		logWatcher,
		windowManager,
		benchmarkBinaryPath: bundledOmp,
		benchmarkEnv: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		spawnWindow,
		initialCwd: resolveInitialCwd,
	});

	const portal = usesShortcutPortal(process.platform, process.env, {
		platform: app.commandLine.getSwitchValue("ozone-platform"),
		hint: app.commandLine.getSwitchValue("ozone-platform-hint"),
	});
	writeRuntimeLog({
		source: "global-shortcut",
		message: "global shortcut mode",
		details: { portal, enableFeatures: app.commandLine.getSwitchValue("enable-features") },
	});
	quickEntry = new QuickEntryController({
		windowManager,
		spawnWindow,
		sidecarPool,
		sessionIndex,
		defaultWorkspace: ensureDefaultWorkspace,
		readTarget: () => prefsStore().get("quickEntryTarget"),
		saveTarget: target => prefsStore().set("quickEntryTarget", target),
		portalSession: portal,
	});
	quickEntry.registerIpc();
	// The bar is not a WindowManager record, so Electron's window-all-closed
	// would never fire on Win/Linux while it exists, hidden or not.
	windowManager.subscribeWindowClosed(() => {
		if (process.platform !== "darwin" && windowManager.getAllWindows().length === 0) quickEntry?.destroyWindow();
	});

	// Both global shortcuts register in this one tick: a portal session binds once.
	// Global shortcut: Cmd+Shift+O — toggle focused window, else show the most
	// recent, else spawn one (multi-window decision tree).
	const toggleAccelerator = nativeAccelerator("window.toggle");
	const toggleRegistered = globalShortcut.register(toggleAccelerator, () => {
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && !focused.isDestroyed() && windowManager.recordFor(focused)) {
			if (focused.isVisible()) focused.hide();
			else {
				focused.show();
				focused.focus();
			}
			return;
		}
		const win = windowManager.getMainWindow();
		if (win) {
			win.show();
			win.focus();
			return;
		}
		spawnWindow();
	});
	// Another client may already hold the chord, and under XWayland the grab
	// only fires while an omp window has focus (README → Linux).
	if (!toggleRegistered) {
		writeRuntimeLog({
			source: "global-shortcut",
			message: `globalShortcut.register refused ${toggleAccelerator}`,
			details: { accelerator: toggleAccelerator },
		});
	}
	quickEntryShortcut = new QuickEntryShortcut({
		registry: globalShortcut,
		log: (message, details) => writeRuntimeLog({ source: "global-shortcut", message, details }),
		readPref: () => prefsStore().get("quickEntryShortcut"),
		savePref: pref => prefsStore().set("quickEntryShortcut", pref),
		mode: portal ? "portal" : "native",
		desktopEntryMissing:
			portal && !desktopEntryCandidates(`${APP_ID}.desktop`, process.env, homedir()).some(existsSync),
		xwaylandOnly: process.platform === "linux" && !portal && process.env.XDG_SESSION_TYPE === "wayland",
		onActivate: () => quickEntry?.toggle(),
	});
	quickEntryShortcut.registerAtStartup();
	quickEntryShortcut.registerIpc(windowManager);
	sessionIndex.start();
	logWatcher.start();
	// Read before the first window restores: every tab change rewrites the store,
	// so a later read would only see the just-restored primary window.
	const savedLayouts = readSavedTabLayouts();
	spawnWindow(explicitStartupCwd);
	// A bare launch restores the saved session in full. The window above carries
	// layout[0]; these are the secondary windows whose tabs used to be dropped at
	// relaunch. An argv cwd is an explicit "open this", not a restore.
	if (!explicitStartupCwd) {
		for (const layout of savedLayouts.slice(1)) spawnWindowWithLayout(layout);
	}
	quickEntry.markStartupWindows(windowManager.getAllWindows());

	// Tray, menu, deep links, updater
	createTray(windowManager, spawnWindow);
	createMenu(windowManager, spawnWindow);
	setupDeepLinks(windowManager, spawnWindow, () => quickEntry?.showWhenSettled());
	setupUpdater();

	// Probe stats server (non-blocking)
	statsClient.probe().catch(() => {});
});

// macOS: re-create window on dock click
app.on("activate", () => {
	if (windowManager && windowManager.getAllWindows().length === 0) {
		spawnWindow();
	}
});

// Quit on all windows closed (except macOS)
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		requestQuit();
	}
});

// Cleanup on quit, behind the "sessions are still working" confirmation: ⌘Q
// used to SIGTERM every live agent run without a word.
installQuitGuard(
	() => (sidecarPool ? sidecarPool.tabInventory() : []),
	() => {
		statsServer?.kill();
		sidecarPool?.disposeAll();
		sessionIndex?.stop();
		logWatcher?.stop();
		destroyTray();
	},
	() => windowManager?.getTargetWindow() ?? null,
);
