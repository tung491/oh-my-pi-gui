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
import { spawn, spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser } from "@wdio/globals";
import { type ChainablePromiseElement, remote } from "webdriverio";
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
	/**
	 * The sidecar binary (`OMP_BUNDLED_OMP`); the fixture unless a spec brings
	 * another. `null` sets none, so the app resolves its own bundled sidecar.
	 */
	omp?: string | null;
	/** The app binary; the e2e-hooks debug build unless a spec compares another. */
	binary?: string;
	/** Arguments after the project directory. */
	args?: string[];
	/** Start without the project directory argument, as a launcher or menu would. */
	noProject?: boolean;
	/** Start the app in the launch directory (a launch that ignores its argv lands there). */
	startInLaunchDir?: boolean;
	/** Send the app's stdout and stderr to `PreparedLaunch.output`. */
	captureOutput?: boolean;
	/** Runs once the profile directories and prefs exist, before the app starts. */
	setup?: (launch: Launch) => Promise<void>;
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

/** A launch this process prepared, with the environment the app starts in. */
export interface PreparedLaunch extends Launch {
	/** Exactly what `launch-app.sh` exports on top of the driver's environment. */
	env: Record<string, string>;
	/** The app's stdout and stderr, when `captureOutput` was set. */
	output: string | null;
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

export function shellQuote(value: string): string {
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
export async function prepareLaunch(options: LaunchOptions): Promise<PreparedLaunch> {
	const dir = await fsp.mkdtemp(path.join(runDir(), `${options.name}-`));
	const desktop = path.join(dir, "desktop");
	const agent = path.join(dir, "agent");
	const project = path.join(dir, "project");
	const record = path.join(dir, "rpc.jsonl");
	const output = options.captureOutput ? path.join(dir, "app-output.log") : null;
	await Promise.all([fsp.mkdir(desktop), fsp.mkdir(agent), fsp.mkdir(project)]);
	await writeDesktopPrefs(desktop, { language: "en", ...options.prefs }, { freshWelcome: options.freshWelcome });

	const env: Record<string, string> = {
		OMP_E2E_APP_BINARY: options.binary ?? APP_BINARY,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), dir),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		...(options.omp === null ? {} : { OMP_BUNDLED_OMP: options.omp ?? FIXTURE }),
		OMP_GUI_TEST_RECORD: record,
		...(options.history === undefined ? {} : { OMP_GUI_TEST_HISTORY: String(options.history) }),
		...(options.startInLaunchDir ? { OMP_E2E_APP_CWD: dir } : {}),
		...(output ? { OMP_E2E_APP_LOG: output } : {}),
		...options.env,
	};
	const envFile = path.join(dir, "launch.env");
	const lines = Object.entries(env).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`not an environment variable name: ${key}`);
		return `${key}=${shellQuote(value)}`;
	});
	await fsp.writeFile(envFile, `${lines.join("\n")}\n`);

	const prepared: PreparedLaunch = {
		dir,
		desktop,
		agent,
		project,
		record,
		env,
		output,
		capabilities: capabilitiesFor(envFile, desktop, [
			...(options.noProject ? [] : [project]),
			...(options.args ?? []),
		]),
	};
	await options.setup?.(prepared);
	return prepared;
}

function capabilitiesFor(envFile: string, desktop: string, argv: string[]): TauriCapabilities {
	return {
		"tauri:options": { application: LAUNCHER, args: [envFile, ...argv, `${USER_DATA_SWITCH}${desktop}`] },
		"wdio:enforceWebDriverClassic": true,
	};
}

let current: Launch | null = null;

/** Replace the running session with a fresh launch. */
export async function launch(options: LaunchOptions): Promise<PreparedLaunch> {
	const prepared = await prepareLaunch(options);
	await browser.reloadSession(prepared.capabilities);
	current = prepared;
	return prepared;
}

/**
 * Start the same profile again, as a user reopening the app would; `argv`
 * replaces the app arguments of the earlier launch (the profile stays).
 */
export async function relaunch(previous: Launch, argv?: string[]): Promise<void> {
	const [envFile, ...rest] = previous.capabilities["tauri:options"].args;
	const capabilities = argv
		? capabilitiesFor(envFile, previous.desktop, argv)
		: capabilitiesFor(
				envFile,
				previous.desktop,
				rest.filter(arg => !arg.startsWith(USER_DATA_SWITCH)),
			);
	await browser.reloadSession(capabilities);
	current = { ...previous, capabilities };
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

/** The ARIA roles the specs look elements up by, with the elements that carry each one. */
const ROLE_SELECTORS = {
	button: 'button:not([role]), [role="button"], input[type="button"], input[type="submit"]',
	switch: '[role="switch"]',
	img: '[role="img"], img[alt]:not([role])',
	dialog: '[role="dialog"], dialog:not([role])',
} as const;

export interface RoleQuery {
	/** Playwright's accessible-name filter: a substring (case-insensitive), the exact name, or a pattern. */
	name: string | RegExp;
	exact?: boolean;
	/** Only inside the first element this selector matches (a dialog, a tab). */
	within?: string;
	timeout?: number;
}

/**
 * Playwright's `getByRole(role, { name })` for the roles the specs use: the
 * first rendered element with that role whose accessible name (aria-label,
 * aria-labelledby, alt, else its text content, whitespace-collapsed) matches.
 * Waits for it to appear.
 */
export async function byRole(role: keyof typeof ROLE_SELECTORS, query: RoleQuery): Promise<WebdriverIO.Element> {
	const deadline = Date.now() + (query.timeout ?? 10_000);
	let found = await queryRole(role, query);
	while (!found && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 100));
		found = await queryRole(role, query);
	}
	if (!found)
		throw new Error(`no ${role} named ${String(query.name)}${query.within ? ` inside ${query.within}` : ""}`);
	return found;
}

/** `byRole` without the wait: the element now, or null (Playwright's `count() > 0` checks). */
export async function queryRole(
	role: keyof typeof ROLE_SELECTORS,
	{ name, exact = false, within }: RoleQuery,
): Promise<WebdriverIO.Element | null> {
	const pattern = name instanceof RegExp ? { source: name.source, flags: name.flags } : null;
	const plain = typeof name === "string" ? name : null;
	const find = () =>
		browser.execute(
			(
				selector: string,
				scope: string | null,
				regex: { source: string; flags: string } | null,
				text: string | null,
				whole: boolean,
			) => {
				const root = scope ? document.querySelector(scope) : document;
				if (!root) return null;
				const hidden = (element: Element) => {
					for (let node: Element | null = element; node; node = node.parentElement) {
						if (node.getAttribute("aria-hidden") === "true") return true;
					}
					return getComputedStyle(element).visibility === "hidden" || element.getClientRects().length === 0;
				};
				const nameOf = (element: Element) => {
					const label = element.getAttribute("aria-label");
					if (label) return label;
					const labelledBy = element.getAttribute("aria-labelledby");
					if (labelledBy)
						return labelledBy
							.split(/\s+/)
							.map(id => document.getElementById(id)?.textContent ?? "")
							.join(" ");
					if (element instanceof HTMLImageElement) return element.alt;
					// Name from content, as the accessible-name algorithm walks it: DOM text
					// (CSS text-transform does not apply), hidden children skipped, a child's
					// own label used, and non-inline children kept apart by spaces.
					const fromContent = (node: Node): string => {
						if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
						if (!(node instanceof Element)) return "";
						if (node.getAttribute("aria-hidden") === "true") return "";
						const style = getComputedStyle(node);
						if (style.display === "none" || style.visibility === "hidden") return "";
						const own =
							node.getAttribute("aria-label") ??
							(node instanceof HTMLImageElement ? node.alt : null) ??
							Array.from(node.childNodes).map(fromContent).join("");
						return style.display.startsWith("inline") ? own : ` ${own} `;
					};
					return Array.from(element.childNodes).map(fromContent).join("") || element.getAttribute("title") || "";
				};
				const matches = (accessible: string) => {
					if (regex) return new RegExp(regex.source, regex.flags).test(accessible);
					if (text === null) return true;
					return whole ? accessible === text : accessible.toLowerCase().includes(text.toLowerCase());
				};
				return (
					Array.from(root.querySelectorAll(selector)).find(
						element => !hidden(element) && matches(nameOf(element).replace(/\s+/g, " ").trim()),
					) ?? null
				);
			},
			ROLE_SELECTORS[role],
			within ?? null,
			pattern,
			plain,
			exact,
		);
	const found = await find();
	// WebDriver hands a DOM node back as an element reference, which `$` wraps.
	return found ? $(found as unknown as WebdriverIO.Element).getElement() : null;
}

/**
 * Playwright's `getByText(text, { exact: true })` inside `scope`: the innermost
 * elements whose whitespace-collapsed text content is exactly `text`.
 */
export function exactTextCount(text: string, scope = "body"): Promise<number> {
	return browser.execute(
		(root: string, wanted: string) => {
			const normal = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim();
			return Array.from(document.querySelectorAll(`${root} *`)).filter(
				element =>
					normal(element) === wanted && !Array.from(element.children).some(child => normal(child) === wanted),
			).length;
		},
		scope,
		text,
	);
}

/** The last element `exactTextCount` counts, or null. */
export async function lastExactText(text: string, scope = "body"): Promise<WebdriverIO.Element | null> {
	const found = await browser.execute(
		(root: string, wanted: string) => {
			const normal = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim();
			const matches = Array.from(document.querySelectorAll(`${root} *`)).filter(
				element =>
					normal(element) === wanted && !Array.from(element.children).some(child => normal(child) === wanted),
			);
			return matches[matches.length - 1] ?? null;
		},
		scope,
		text,
	);
	return found ? $(found as unknown as WebdriverIO.Element).getElement() : null;
}

/**
 * Playwright's `fill`: focus the field, select its contents and insert the
 * text as one edit (an empty string deletes). WebDriver's Element Clear would
 * blur the field first, which commits blur-saved settings fields early.
 */
export async function fill(element: ChainablePromiseElement | WebdriverIO.Element, text: string): Promise<void> {
	const node = (await element.getElement()) as unknown as HTMLElement;
	await browser.execute(
		(field: HTMLElement, value: string) => {
			field.focus();
			document.execCommand("selectAll");
			if (value) document.execCommand("insertText", false, value);
			else document.execCommand("delete");
		},
		node,
		text,
	);
}

/** The element's `textContent`, which Playwright's text matchers compare (hidden text included). */
export async function textOf(element: ChainablePromiseElement | WebdriverIO.Element): Promise<string> {
	const node = (await element.getElement()) as unknown as HTMLElement;
	return browser.execute((target: HTMLElement) => target.textContent ?? "", node);
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

/**
 * Page errors across reloads: a reload replaces the page and its error list,
 * so the errors seen so far are kept here, and `reload()` installs collection
 * on the new page, as Playwright's `pageerror` kept listening.
 */
export function pageErrorLog(page: WebdriverIO.Browser): { all(): Promise<string[]>; reload(): Promise<void> } {
	const earlier: string[] = [];
	return {
		all: async () => [...earlier, ...(await pageErrors(page))],
		reload: async () => {
			earlier.push(...(await pageErrors(page)));
			await page.refresh();
			await awaitBridge(page);
			await collectPageErrors(page);
		},
	};
}

/** A second WebKitWebDriver, for documents that must open outside the app. */
const OUTSIDE_DRIVER = "/usr/bin/WebKitWebDriver";
const OUTSIDE_DRIVER_PORT = 4446;
/** WebKit's own test browser, the same engine (webkit2gtk-4.1) the app embeds. */
const OUTSIDE_BROWSER = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser";

/** WebKitGTK's driver-specific capability: which browser binary to start, with which arguments. */
interface WebKitGtkCapabilities extends WebdriverIO.Capabilities {
	"webkitgtk:browserOptions": { binary: string; args: string[] };
}

export interface OutsideBrowser {
	page: WebdriverIO.Browser;
	close(): Promise<void>;
}

/**
 * Open `url` in a browser outside the app (a WebDriver-driven MiniBrowser on
 * its own driver), as a user opening an exported file would; never in an app
 * window. A busy driver port is an error naming its owner. `close()` ends the
 * session and stops the driver by PID.
 */
export async function openOutsideBrowser(url: string): Promise<OutsideBrowser> {
	const owner = spawnSync("ss", ["-ltnp", `sport = :${OUTSIDE_DRIVER_PORT}`], { encoding: "utf8" })
		.stdout.split("\n")
		.slice(1)
		.filter(line => line.trim());
	if (owner.length > 0) throw new Error(`Port ${OUTSIDE_DRIVER_PORT} is in use; stop its owner:\n${owner.join("\n")}`);
	const driver = spawn(OUTSIDE_DRIVER, [`--port=${OUTSIDE_DRIVER_PORT}`], { stdio: ["ignore", "ignore", "inherit"] });
	await new Promise<void>((resolve, reject) => {
		driver.once("spawn", resolve);
		driver.once("error", reject);
	});
	const stopDriver = async () => {
		if (driver.exitCode !== null || driver.signalCode !== null) return;
		const exited = new Promise(resolve => driver.once("exit", resolve));
		driver.kill("SIGTERM");
		const timer = setTimeout(() => driver.kill("SIGKILL"), 5_000);
		await exited;
		clearTimeout(timer);
	};
	try {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const ready = await fetch(`http://127.0.0.1:${OUTSIDE_DRIVER_PORT}/status`).then(
				response => response.ok,
				() => false,
			);
			if (ready) break;
			if (Date.now() > deadline) throw new Error(`WebKitWebDriver did not answer on port ${OUTSIDE_DRIVER_PORT}`);
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		const page = await remote({
			hostname: "127.0.0.1",
			port: OUTSIDE_DRIVER_PORT,
			logLevel: "warn",
			capabilities: {
				"webkitgtk:browserOptions": { binary: OUTSIDE_BROWSER, args: ["--automation"] },
			} satisfies WebKitGtkCapabilities as WebdriverIO.Capabilities,
		});
		await page.url(url);
		return {
			page,
			close: async () => {
				await page.deleteSession().catch(() => {});
				await stopDriver();
			},
		};
	} catch (error) {
		await stopDriver();
		throw error;
	}
}
