/**
 * One Tauri app launch per WebDriver session.
 *
 * The runner starts a session per spec file (`beforeSession` in wdio.conf.ts
 * prepares a plain launch for it). A spec that needs its own history, prefs,
 * environment or sidecar calls `launch()`, which prepares a fresh profile and
 * replaces the running session through `browser.reloadSession`; `relaunch()`
 * starts the same profile again. Every launch mirrors the Electron specs: an
 * isolated `PI_CODING_AGENT_DIR`, a throwaway `--user-data-dir`, and
 * `OMP_BUNDLED_OMP` naming the sidecar fixture from `e2e/sidecar-fixture.ts`,
 * which the `e2e-hooks` build honours.
 *
 * Profiles live under the run directory wdio.conf.ts creates; it removes them
 * once the run ends and every app process is gone.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser } from "@wdio/globals";
import { writeDesktopPrefs } from "../e2e/desktop-prefs";

export const ROOT = path.resolve(import.meta.dirname, "..");
/** Built by `cargo tauri build --debug --features e2e-hooks --no-bundle`; assets embedded, test hooks on. */
export const APP_BINARY = path.join(ROOT, "src-tauri", "target", "debug", "sai-atlas");
export const BUILD_COMMAND = "cargo tauri build --debug --features e2e-hooks --no-bundle";
export const LAUNCHER = path.join(ROOT, "e2e-tauri", "launch-app.sh");
export const FIXTURE = path.join(ROOT, "e2e", "sidecar-fixture.ts");
/** Set by wdio.conf.ts before any worker starts; every profile is created below it. */
export const RUN_DIR_ENV = "OMP_E2E_RUN_DIR";
const USER_DATA_SWITCH = "--user-data-dir=";

export interface LaunchOptions {
	/** Prefix of the launch directory, normally the spec name. */
	name: string;
	/** Messages the fixture seeds (`OMP_GUI_TEST_HISTORY`). */
	history?: number;
	/** `prefs.json` keys on top of `language: "en"`. */
	prefs?: Record<string, unknown>;
	/** Leave the welcome screen unseen; only onboarding needs it. */
	freshWelcome?: boolean;
	/** Environment for the app and, through it, the sidecar. */
	env?: Record<string, string>;
	/** The sidecar binary (`OMP_BUNDLED_OMP`); the fixture unless a spec brings another. */
	omp?: string;
	/** The app binary; the e2e-hooks debug build unless a spec compares another. */
	binary?: string;
	/** Arguments after the project directory. */
	args?: string[];
}

export interface Launch {
	/** The launch directory; everything below is inside it. */
	dir: string;
	/** `--user-data-dir`: prefs.json, window state, logs. */
	desktop: string;
	/** `PI_CODING_AGENT_DIR`. */
	agent: string;
	/** The workspace the first window opens. */
	project: string;
	/** `OMP_GUI_TEST_RECORD`: every RPC command the fixture received, one JSON line each. */
	record: string;
	capabilities: TauriCapabilities;
}

export interface TauriOptions {
	application: string;
	args: string[];
}

export interface TauriCapabilities extends WebdriverIO.Capabilities {
	"tauri:options": TauriOptions;
}

export function runDir(): string {
	const dir = process.env[RUN_DIR_ENV];
	if (!dir) throw new Error(`${RUN_DIR_ENV} is not set; run the specs through wdio.conf.ts`);
	return dir;
}

/** The spec's base name (`runtime` for `e2e-tauri/runtime.e2e.ts`), for launch directory names. */
export function specName(spec: string): string {
	const file = spec.startsWith("file:") ? fileURLToPath(spec) : spec;
	return path.basename(file).replace(/\.e2e\.ts$/, "");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The runtime log of a launch, for failure artifacts. */
export function runtimeLogPath(launch: Launch): string {
	return path.join(launch.desktop, "logs", "gui-runtime.jsonl");
}

/**
 * Create the profile, prefs and environment file for one launch, and return
 * the capabilities that start it.
 */
export async function prepareLaunch(options: LaunchOptions): Promise<Launch> {
	const dir = await fsp.mkdtemp(path.join(runDir(), `${options.name}-`));
	const desktop = path.join(dir, "desktop");
	const agent = path.join(dir, "agent");
	const project = path.join(dir, "project");
	const record = path.join(dir, "rpc.jsonl");
	await Promise.all([fsp.mkdir(desktop), fsp.mkdir(agent), fsp.mkdir(project)]);
	await writeDesktopPrefs(desktop, { language: "en", ...options.prefs }, { freshWelcome: options.freshWelcome });

	const env: Record<string, string> = {
		OMP_E2E_APP_BINARY: options.binary ?? APP_BINARY,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), dir),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: options.omp ?? FIXTURE,
		OMP_GUI_TEST_RECORD: record,
		...(options.history === undefined ? {} : { OMP_GUI_TEST_HISTORY: String(options.history) }),
		...options.env,
	};
	const envFile = path.join(dir, "launch.env");
	const lines = Object.entries(env).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`not an environment variable name: ${key}`);
		return `${key}=${shellQuote(value)}`;
	});
	await fsp.writeFile(envFile, `${lines.join("\n")}\n`);

	return {
		dir,
		desktop,
		agent,
		project,
		record,
		capabilities: {
			"tauri:options": {
				application: LAUNCHER,
				args: [envFile, project, `${USER_DATA_SWITCH}${desktop}`, ...(options.args ?? [])],
			},
			"wdio:enforceWebDriverClassic": true,
		},
	};
}

let current: Launch | null = null;

/** Replace the running session with a fresh launch. */
export async function launch(options: LaunchOptions): Promise<Launch> {
	const prepared = await prepareLaunch(options);
	await browser.reloadSession(prepared.capabilities);
	current = prepared;
	return prepared;
}

/** Start the same profile again, as a user reopening the app would. */
export async function relaunch(previous: Launch): Promise<void> {
	await browser.reloadSession(previous.capabilities);
	current = previous;
}

/**
 * The launch behind the current session: the last `launch()`/`relaunch()`, or
 * the one `beforeSession` prepared, read back from the requested capabilities.
 */
export function currentLaunch(): Launch {
	if (current) return current;
	const requested = browser.requestedCapabilities as Partial<TauriCapabilities> | undefined;
	const args = requested?.["tauri:options"]?.args ?? [];
	const desktop = args.find(arg => arg.startsWith(USER_DATA_SWITCH))?.slice(USER_DATA_SWITCH.length);
	if (!desktop) throw new Error("the session was not started through prepareLaunch()");
	const dir = path.dirname(desktop);
	current = {
		dir,
		desktop,
		agent: path.join(dir, "agent"),
		project: path.join(dir, "project"),
		record: path.join(dir, "rpc.jsonl"),
		capabilities: requested as TauriCapabilities,
	};
	return current;
}

/** Wait for the chat window's page to have installed `window.omp`. */
export async function awaitBridge(page: WebdriverIO.Browser, timeout = 30_000): Promise<void> {
	await page.waitUntil(() => page.execute(() => window.omp?.rpc != null), {
		timeout,
		timeoutMsg: "window.omp never appeared in the main window",
	});
}

/** Wait for the chat window's bridge and a ready sidecar. */
export async function awaitMainWindow(page: WebdriverIO.Browser, timeout = 30_000): Promise<void> {
	await awaitBridge(page, timeout);
	await page.waitUntil(async () => (await page.execute(() => window.omp.sidecar.getStatus())).status === "ready", {
		timeout,
		interval: 250,
		timeoutMsg: "the sidecar never reached ready",
	});
}

/** The DOM node behind a selector, typed for `browser.execute` callbacks that take it as an argument. */
export async function nodeOf(selector: string): Promise<HTMLElement> {
	return (await $(selector)) as unknown as HTMLElement;
}

/** A real wheel gesture over the element, as a reader scrolling would make. */
export async function wheel(selector: string, deltaY: number): Promise<void> {
	const origin = await $(selector);
	await browser.action("wheel").scroll({ origin, deltaX: 0, deltaY, duration: 50 }).perform();
}

/** Resolve after the page's next animation frame. */
export async function nextFrame(page: WebdriverIO.Browser): Promise<void> {
	await page.execute(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

/**
 * Poll `read` until `accept` holds or the timeout passes, and return the last
 * value either way, so the caller's `expect` reports what was actually seen.
 */
export async function until<T>(
	read: () => Promise<T> | T,
	accept: (value: T) => boolean,
	{ timeout = 10_000, interval = 100 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
	const deadline = Date.now() + timeout;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, interval));
		value = await read();
	}
	return value;
}

/** The RPC commands of one type the fixture recorded, oldest first. */
export async function recorded<T extends { type: string } = { type: string; message?: string }>(
	record: string,
	type: string,
): Promise<T[]> {
	const text = await fsp.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as T)
		.filter(command => command.type === type);
}

interface ErrorSink {
	__ompE2eErrors?: string[];
}

/**
 * WebDriver has no page-error event, so the page keeps its own list from the
 * moment this runs: uncaught errors and unhandled rejections.
 */
export async function collectPageErrors(page: WebdriverIO.Browser): Promise<void> {
	await page.execute(() => {
		const sink = window as unknown as ErrorSink;
		if (sink.__ompE2eErrors) return;
		const errors: string[] = [];
		sink.__ompE2eErrors = errors;
		window.addEventListener("error", event => {
			errors.push(event.message);
		});
		window.addEventListener("unhandledrejection", event => {
			errors.push(String(event.reason));
		});
	});
}

export function pageErrors(page: WebdriverIO.Browser): Promise<string[]> {
	return page.execute(() => (window as unknown as ErrorSink).__ompE2eErrors ?? []);
}
