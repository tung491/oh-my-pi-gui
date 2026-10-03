/**
 * WebdriverIO runs the Tauri e2e specs (`e2e-tauri/*.e2e.ts`) against the
 * debug build with test hooks, through tauri-driver and WebKitWebDriver.
 *
 * Sessions. tauri-driver forwards only `tauri:options.application` and `.args`
 * to WebKitWebDriver, which starts the app in the driver's own environment, and
 * it keeps one live session at a time. So `application` is
 * `e2e-tauri/launch-app.sh`, which sources a per-launch environment file named
 * by its first argument and execs the real binary; `beforeSession` prepares
 * such a launch (fresh profile, isolated agent dir, fixture sidecar) for the
 * session the runner opens per spec file, and a spec that needs its own
 * history, prefs, environment or sidecar calls `launch()` from
 * `e2e-tauri/session.ts`, which replaces the session with `reloadSession`.
 * Specs run one at a time (one worker, one driver, ports 4444/4445); a busy
 * port is an error naming its owner, never a different port.
 *
 * Cleanup. Every profile lives under one run directory; `onComplete` stops the
 * app processes started from it and the driver pair by PID, then removes it.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { browser } from "@wdio/globals";
import {
	APP_BINARY,
	BUILD_COMMAND,
	currentLaunch,
	LAUNCHER,
	prepareLaunch,
	ROOT,
	RUN_DIR_ENV,
	runtimeLogPath,
	specName,
	type TauriCapabilities,
} from "./e2e-tauri/session";
import { readRustPins } from "./scripts/tauri-dev";

const DRIVER_PORT = 4444;
const NATIVE_PORT = 4445;
const NATIVE_DRIVER = "/usr/bin/WebKitWebDriver";
const DRIVER_START_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const RESULTS_DIR = path.join(ROOT, "test-results");

let driver: ChildProcess | null = null;
let runDir: string | null = null;

function tauriDriverPath(): string {
	const pins = readRustPins(fs.readFileSync(path.join(ROOT, "scripts", "rust-pins.env"), "utf8"));
	const cargoBin = process.env.CARGO_HOME_BIN || pins.CARGO_HOME_BIN;
	if (!cargoBin) throw new Error("CARGO_HOME_BIN is not set in scripts/rust-pins.env");
	return path.join(cargoBin, "tauri-driver");
}

function requireFile(file: string, hint: string): void {
	if (!fs.existsSync(file)) throw new Error(`${file} is missing. ${hint}`);
}

/** Listening sockets on `port`, as `ss` reports them; null when the port is free. */
function portOwner(port: number): string | null {
	const probe = spawnSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) return null;
	const owners = probe.stdout
		.split("\n")
		.slice(1)
		.filter(line => line.trim().length > 0);
	return owners.length > 0 ? owners.join("\n") : null;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** SIGTERM one process we started, escalate to SIGKILL after the grace period. */
async function stop(pid: number, label: string): Promise<void> {
	if (!alive(pid)) return;
	process.kill(pid, "SIGTERM");
	const deadline = Date.now() + STOP_GRACE_MS;
	while (alive(pid) && Date.now() < deadline) await sleep(100);
	if (alive(pid)) {
		console.warn(`${label} (pid ${pid}) ignored SIGTERM; killing it`);
		process.kill(pid, "SIGKILL");
	}
}

function pgrep(args: string[]): number[] {
	const found = spawnSync("pgrep", args, { encoding: "utf8" });
	if (found.error || found.status !== 0) return [];
	return found.stdout
		.split("\n")
		.map(line => Number.parseInt(line, 10))
		.filter(pid => Number.isInteger(pid) && pid !== process.pid);
}

/** Processes whose command line carries this run's profile root: only apps we launched. */
function appProcesses(dir: string): number[] {
	const literal = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return pgrep(["-f", "--", `--user-data-dir=${literal}`]);
}

async function waitForDriver(child: ChildProcess, port: number): Promise<void> {
	const deadline = Date.now() + DRIVER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`tauri-driver exited with code ${child.exitCode} before serving`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/status`);
			if (response.ok) return;
		} catch {
			// not listening yet
		}
		await sleep(100);
	}
	throw new Error(`tauri-driver did not answer on port ${port} within ${DRIVER_START_TIMEOUT_MS} ms`);
}

/** Replaced in `beforeSession`; on its own the launcher refuses to start (no `--user-data-dir`). */
const placeholder: TauriCapabilities = {
	"tauri:options": { application: LAUNCHER, args: [] },
	"wdio:enforceWebDriverClassic": true,
};

/** A file name for a failed test's artifacts. */
function artifactStem(spec: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);
	return path.join(RESULTS_DIR, `${specName(spec)}-${slug}`);
}

export const config: WebdriverIO.Config = {
	runner: "local",
	tsConfigPath: "./tsconfig.wdio.json",
	specs: ["./e2e-tauri/*.e2e.ts"],
	maxInstances: 1,
	hostname: "127.0.0.1",
	port: DRIVER_PORT,
	path: "/",
	capabilities: [placeholder],
	logLevel: "warn",
	waitforTimeout: 10_000,
	connectionRetryTimeout: 120_000,
	connectionRetryCount: 1,
	framework: "mocha",
	reporters: ["spec"],
	mochaOpts: { ui: "bdd", timeout: 60_000 },

	onPrepare: async () => {
		requireFile(APP_BINARY, `Build it with: ${BUILD_COMMAND}`);
		requireFile(NATIVE_DRIVER, "Install the webkitgtk-webdriver package.");
		const tauriDriver = tauriDriverPath();
		requireFile(tauriDriver, "Install it with: cargo install tauri-driver --locked");
		for (const port of [DRIVER_PORT, NATIVE_PORT]) {
			const owner = portOwner(port);
			if (owner)
				throw new Error(`Port ${port} is in use. Stop its owner instead of picking another port:\n${owner}`);
		}

		runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-gui-wdio-"));
		process.env[RUN_DIR_ENV] = runDir;
		await fsp.mkdir(RESULTS_DIR, { recursive: true });

		driver = spawn(
			tauriDriver,
			["--port", String(DRIVER_PORT), "--native-port", String(NATIVE_PORT), "--native-driver", NATIVE_DRIVER],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		const started = driver;
		await new Promise<void>((resolve, reject) => {
			started.once("spawn", resolve);
			started.once("error", reject);
		});
		console.log(`tauri-driver pid ${started.pid} on port ${DRIVER_PORT}; profiles under ${runDir}`);
		await waitForDriver(started, DRIVER_PORT);
	},

	beforeSession: async (_config, capabilities, specs) => {
		const launch = await prepareLaunch({ name: specName(specs[0] ?? "spec") });
		Object.assign(capabilities, launch.capabilities);
	},

	/** Like Playwright's screenshot-on-failure, plus the shell's runtime log for the launch under test. */
	afterTest: async (test, _context, result) => {
		if (result.passed) return;
		const stem = artifactStem(test.file ?? "spec", test.title);
		await browser.saveScreenshot(`${stem}.png`).catch((error: unknown) => {
			console.warn(`no failure screenshot: ${String(error)}`);
		});
		try {
			await fsp.copyFile(runtimeLogPath(currentLaunch()), `${stem}-runtime.jsonl`);
		} catch (error) {
			console.warn(`no runtime log for the failed test: ${String(error)}`);
		}
	},

	onComplete: async () => {
		if (runDir) {
			for (const pid of appProcesses(runDir)) await stop(pid, "app");
		}
		if (driver?.pid) {
			const natives = pgrep(["-P", String(driver.pid)]);
			await stop(driver.pid, "tauri-driver");
			for (const pid of natives) await stop(pid, "WebKitWebDriver");
		}
		driver = null;
		if (runDir) {
			await fsp.rm(runDir, { recursive: true, force: true });
			runDir = null;
		}
	},
};
