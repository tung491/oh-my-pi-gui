/**
 * WebdriverIO-side helpers for the Tauri `test:*` bridge channels
 * (`src-tauri/src/test_hooks.rs`, compiled only with `--features e2e-hooks`).
 * They replace the Electron specs' `app.evaluate` main-process reach-ins
 * (`e2e-tauri/reach-ins.json`).
 *
 * Every helper runs a self-contained script in the chat window's page through
 * `browser.execute` (the function is serialized, so it may use only its own
 * arguments and `window`). The page calls the `omp_invoke` Tauri command on the
 * `e2e-hooks` page generation, which `bridge.rs` dispatches out of band of the
 * page's ordered queue; that is why a `test:release` can free a call the page
 * itself has in flight. The hooks are `Scope::Main`: run them from a chat
 * window, never from the quick-entry bar.
 */

/** The page generation `bridge::E2E_HOOK_GEN` dispatches without queueing. */
const HOOK_GENERATION = "e2e-hooks";

/** The browser the helpers drive; pass the `browser` global from `@wdio/globals`. */
export type HookBrowser = WebdriverIO.Browser;

/** What `window.__TAURI_INTERNALS__` offers the page; Tauri injects it before any page script. */
interface TauriInternals {
	invoke<Result>(command: string, args: Record<string, unknown>): Promise<Result>;
}

/** Fault scripts `test:fault` accepts; `null` clears the channel's script. */
export type FaultSpec =
	| { error: string }
	| { value: unknown }
	| { delayMs: number }
	| { barrier: string }
	| { barrier: string; error: string }
	| { barrier: string; value: unknown }
	| null;

/** One row of `test:windows`. */
export interface HookWindow {
	winId: number;
	label: string;
	kind: "main" | "quick-entry";
	attached: boolean;
	cwd: string | null;
	/** `null` when the desktop cannot tell (never in the real app). */
	visible: boolean | null;
	/** The outer footprint in logical pixels, as `window-state.json` saves it; `null` when unknown. */
	bounds: { x: number; y: number; width: number; height: number } | null;
}

/** What `test:runtime` reports. */
export interface HookRuntime {
	pid: number;
	executable: string;
	debugBuild: boolean;
	/** The `--user-data-dir` the process was started with, or `null`. */
	userDataDir: string | null;
	/** The bundled sidecar the app resolved; `sidecarError` says why when `null`. */
	sidecar: string | null;
	sidecarError: string | null;
}

/** What `test:navigation-probe` reports for a URL. */
export interface NavigationProbe {
	navigation: boolean;
	newWindow: string;
}

/**
 * Invoke one `test:*` channel from the page and return its reply. The page
 * script returns a promise, which WebDriver's Execute Script awaits before
 * replying (the W3C command settles promise results; no `executeAsync` needed).
 */
async function callHook<Result>(browser: HookBrowser, channel: string, payload: unknown): Promise<Result> {
	return await browser.execute(
		(channel: string, payload: unknown, gen: string) => {
			const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
			if (!internals) throw new Error("window.__TAURI_INTERNALS__ is missing; this page is not a Tauri webview");
			return internals.invoke<Result>("omp_invoke", { channel, args: [payload], seq: 0, gen });
		},
		channel,
		payload,
		HOOK_GENERATION,
	);
}

/** The chat window's own id, as the bootstrap script set it (`window.__OMP_BOOTSTRAP__.winId`). */
export function currentWindowId(browser: HookBrowser): Promise<number> {
	return browser.execute(() => {
		const id = window.__OMP_BOOTSTRAP__?.winId;
		if (typeof id !== "number")
			throw new Error("window.__OMP_BOOTSTRAP__.winId is missing; the page did not boot under Tauri");
		return id;
	});
}

/** Script `channel`: reject, answer with canned data, delay, hold at a barrier, or hold then reject/answer; `null` clears it. */
export function setFault(browser: HookBrowser, channel: string, fault: FaultSpec): Promise<void> {
	return callHook<null>(browser, "test:fault", { channel, fault }).then(() => undefined);
}

/** Like `setFault`, but only for calls whose first argument deep-equals `firstArg` (`{}` is the unkeyed `prefs:get`). */
export function setFaultWhen(
	browser: HookBrowser,
	channel: string,
	firstArg: unknown,
	fault: FaultSpec,
): Promise<void> {
	return callHook<null>(browser, "test:fault", { channel, when: firstArg, fault }).then(() => undefined);
}

/** Free every call held at barrier `id`; `false` when no call was ever held there. */
export function releaseBarrier(browser: HookBrowser, id: string): Promise<boolean> {
	return callHook<boolean>(browser, "test:release", { id });
}

/** How many calls are held at barrier `id` right now (poll this where Electron polled an `audit*Requested` flag). */
export function barrierWaiters(browser: HookBrowser, id: string): Promise<number> {
	return callHook<number>(browser, "test:barrier-waiters", { id });
}

/** Calls that reached `channel` since the app started, faulted ones included. */
export function callsTo(browser: HookBrowser, channel: string): Promise<number> {
	return callHook<number>(browser, "test:calls", { channel });
}

/** Inject a main→renderer message into window `winId`, as `webContents.send(channel, payload)` did. */
export function emitToWindow(browser: HookBrowser, winId: number, channel: string, payload: unknown): Promise<void> {
	return callHook<null>(browser, "test:emit", { winId, channel, payload }).then(() => undefined);
}

/** The known windows with their attach and visibility state. */
export function listWindows(browser: HookBrowser): Promise<HookWindow[]> {
	return callHook<HookWindow[]>(browser, "test:windows", null);
}

/** Whether the quick-entry bar exists and is shown (the Electron specs' `barVisible`). */
export async function quickEntryVisible(browser: HookBrowser): Promise<boolean> {
	const windows = await listWindows(browser);
	return windows.some(window => window.kind === "quick-entry" && window.visible === true);
}

/**
 * Hand `argv` to the running app as a refused second instance would
 * (`argv[0]` is the executable; `["sai-atlas", "--quick-entry"]` summons the bar).
 */
export function secondInstance(browser: HookBrowser, argv: string[], cwd?: string): Promise<void> {
	return callHook<null>(browser, "test:second-instance", { argv, cwd: cwd ?? null }).then(() => undefined);
}

/** What the navigation lock decides for `url` from this window (`navigation: false` means it is blocked). */
export function navigationProbe(browser: HookBrowser, url: string): Promise<NavigationProbe> {
	return callHook<NavigationProbe>(browser, "test:navigation-probe", { url });
}

/** Process, build and sidecar facts for the evidence files the specs write. */
export function runtimeFacts(browser: HookBrowser): Promise<HookRuntime> {
	return callHook<HookRuntime>(browser, "test:runtime", null);
}

/**
 * Quit the app through the approved quit path (no confirmation dialog), as the
 * Electron specs' `app.exit(0)` teardown did. The call is fire-and-forget:
 * the process exits before it could reply, so the page script returns at once.
 */
export function quitApp(browser: HookBrowser): Promise<void> {
	return browser.execute(
		(channel: string, gen: string) => {
			const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
			if (!internals) throw new Error("window.__TAURI_INTERNALS__ is missing; this page is not a Tauri webview");
			void internals.invoke("omp_invoke", { channel, args: [null], seq: 0, gen }).catch(() => {
				// The bridge is shutting down; a rejection here carries no information.
			});
		},
		"test:quit",
		HOOK_GENERATION,
	);
}

/**
 * Scale the page like `webContents.setZoomFactor` did, through CSS zoom on the
 * root element (the renderer has no zoom channel; the window's zoom API is not
 * granted to the page). `1` restores the default.
 */
export function setPageZoom(browser: HookBrowser, factor: number): Promise<void> {
	return browser.execute((zoom: number) => {
		document.documentElement.style.zoom = zoom === 1 ? "" : String(zoom);
	}, factor);
}
