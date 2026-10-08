/**
 * Packaged smoke check for the macOS app, run from outside it because
 * tauri-driver cannot drive WKWebView (the macOS counterpart of
 * `e2e-tauri/packaged-smoke.e2e.ts`; page-level checks stay manual):
 *
 *   bun scripts/tauri-mac-smoke.ts "<path>/Sai ATLAS.app"
 *
 * Cases, in order:
 *   bundle layout                 sai-atlas, omp (mode 755) and every assistant-pack file
 *   app signature                 codesign --verify --strict --deep; identifier and hardened runtime
 *   app entitlements              exactly the keys of src-tauri/macos/app.entitlements
 *   sidecar entitlements          exactly the keys of src-tauri/macos/omp.entitlements
 *   info plist                    omp URL scheme, LSMinimumSystemVersion 13.3, microphone string
 *   pack check                    scripts/check-assistant-pack.ts against the bundled sidecar and pack
 *   boots a supervised sidecar    GUI → --omp-supervise → omp --mode rpc-ui with the bundled pack, stable for 10 s
 *   single instance per profile   a second launch on the same profile hands off and exits 0; another profile keeps running
 *   hard kill leaves nothing      SIGKILL the GUI; its supervisor and omp are gone within 10 s
 *
 * Prints `PASS <case>` or `FAIL <case>: <reason>` per case, then
 * `tauri-mac-smoke: PASS` (exit 0) or `tauri-mac-smoke: FAIL (<n>)` (exit 1).
 * Exit 2: not macOS, or bad usage.
 *
 * Every launch uses a fresh `mkdtemp` profile (`--user-data-dir`) and agent dir
 * (`PI_CODING_AGENT_DIR`), so the user's real profile is never touched. Every
 * process the harness starts, and every sidecar it saw under them, is stopped
 * before it exits.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PsRow {
	pid: number;
	ppid: number;
	command: string;
}

/** Rows of `ps -axo pid=,ppid=,command=` output; a header line or blank line is skipped. */
export function parsePs(output: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
		if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
	}
	return rows;
}

/** Every descendant of `pid`, breadth first. */
export function descendantsOf(rows: readonly PsRow[], pid: number): number[] {
	const found: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const parent = queue.shift() as number;
		for (const row of rows) {
			if (row.ppid === parent && row.pid !== pid && !found.includes(row.pid)) {
				found.push(row.pid);
				queue.push(row.pid);
			}
		}
	}
	return found;
}

/** The `<key>` texts of a plist, in order; keys inside XML comments are ignored. */
export function plistKeys(text: string): string[] {
	const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
	return [...withoutComments.matchAll(/<key>([^<]*)<\/key>/g)].map(match => match[1]);
}

/** The entitlement keys in `codesign -d --entitlements - --xml` output, in order. */
export function entitlementKeysFromXml(xml: string): string[] {
	const start = xml.indexOf("<plist");
	return plistKeys(start === -1 ? xml : xml.slice(start));
}

/** `undefined` when both key sets are equal, else what differs. */
export function sameKeys(actual: readonly string[], expected: readonly string[]): string | undefined {
	const missing = expected.filter(key => !actual.includes(key));
	const extra = actual.filter(key => !expected.includes(key));
	if (missing.length === 0 && extra.length === 0) return undefined;
	return `missing [${missing.join(", ")}], extra [${extra.join(", ")}]`;
}

/** The identifier and CodeDirectory flags `codesign -dv` prints. */
export function codesignDetails(text: string): { identifier: string | undefined; flags: string[] } {
	const identifier = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim();
	const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(text)?.[1];
	return { identifier, flags: flags ? flags.split(",").map(flag => flag.trim()) : [] };
}

export const MIN_SYSTEM_VERSION = "13.3";

/** What the bundle's Info.plist (as JSON) lacks; empty when it is complete. */
export function infoPlistProblems(info: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const urlTypes = Array.isArray(info.CFBundleURLTypes) ? info.CFBundleURLTypes : [];
	const hasOmp = urlTypes.some(
		(type: unknown) =>
			typeof type === "object" &&
			type !== null &&
			Array.isArray((type as { CFBundleURLSchemes?: unknown }).CFBundleURLSchemes) &&
			((type as { CFBundleURLSchemes: unknown[] }).CFBundleURLSchemes as unknown[]).includes("omp"),
	);
	if (!hasOmp) problems.push("CFBundleURLTypes has no omp scheme");
	if (info.LSMinimumSystemVersion !== MIN_SYSTEM_VERSION) {
		problems.push(`LSMinimumSystemVersion is ${String(info.LSMinimumSystemVersion)}, expected ${MIN_SYSTEM_VERSION}`);
	}
	const mic = info.NSMicrophoneUsageDescription;
	if (typeof mic !== "string" || mic.trim() === "") problems.push("NSMicrophoneUsageDescription is missing");
	return problems;
}

// Copied from `ASSISTANT_PACK_FILES` in src-tauri/src/omp/assistant_pack.rs; a test keeps them equal.
export const ASSISTANT_PACK_FILES = [
	"package.json",
	"tools.js",
	"system-prompt.md",
	"append-system-prompt.md",
	"config.yml",
	"skills/word-report/SKILL.md",
	"skills/spreadsheet-cleanup/SKILL.md",
	"skills/slides-from-report/SKILL.md",
	"skills/sai-os-helpdesk/SKILL.md",
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_MS = 250;
const BOOT_TIMEOUT_MS = 30_000;
const STABLE_MS = 10_000;
/** The supervisor's 5 s TERM grace plus its 2 s sweep, with a margin. */
const CLEAN_STOP_TIMEOUT_MS = 8_000;
const HANDOFF_TIMEOUT_MS = 10_000;
const HARD_KILL_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function run(argv: string[]): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function ps(): PsRow[] {
	const result = run(["ps", "-axww", "-o", "pid=,ppid=,command="]);
	if (result.code !== 0) throw new Error(`ps exited ${result.code}: ${result.stderr.trim()}`);
	return parsePs(result.stdout);
}

/** Alive means signal 0 is accepted, or refused only for permission. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function fail(reason: string): never {
	throw new Error(reason);
}

interface SidecarTree {
	supervisor: number;
	omp: number;
}

class Harness {
	readonly #app: string;
	readonly #root: string;
	readonly #launched: Bun.Subprocess[] = [];
	readonly #sidecarPids = new Set<number>();
	#profiles = 0;

	constructor(app: string, root: string) {
		this.#app = app;
		this.#root = root;
	}

	get #macos(): string {
		return join(this.#app, "Contents", "MacOS");
	}

	get #packDir(): string {
		return join(this.#app, "Contents", "Resources", "assistant-pack");
	}

	/** A fresh profile dir, agent dir and project folder under the harness's temp root. */
	newProfile(): { profile: string; agent: string; project: string } {
		const base = join(this.#root, `run-${++this.#profiles}`);
		const dirs = { profile: join(base, "profile"), agent: join(base, "agent"), project: join(base, "project") };
		for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
		return dirs;
	}

	launch(dirs: { profile: string; agent: string; project: string }): Bun.Subprocess {
		const child = Bun.spawn([join(this.#macos, "sai-atlas"), `--user-data-dir=${dirs.profile}`, dirs.project], {
			env: { ...process.env, PI_CODING_AGENT_DIR: dirs.agent },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		this.#launched.push(child);
		return child;
	}

	/** Waits for GUI → `--omp-supervise` → `omp --mode rpc-ui … --extension <pack>`. */
	async waitForSidecar(gui: Bun.Subprocess): Promise<SidecarTree> {
		const omp = join(this.#macos, "omp");
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (gui.exitCode !== null || gui.signalCode !== null) {
				fail(`the GUI exited (${gui.exitCode ?? gui.signalCode}) before its sidecar started`);
			}
			const rows = ps();
			for (const pid of descendantsOf(rows, gui.pid)) this.#sidecarPids.add(pid);
			const supervisor = rows.find(row => row.ppid === gui.pid && row.command.includes(" --omp-supervise "));
			const child = supervisor && rows.find(row => row.ppid === supervisor.pid && row.command.startsWith(`${omp} `));
			if (supervisor && child) {
				if (!child.command.includes(" --mode rpc-ui ")) fail(`omp runs without --mode rpc-ui: ${child.command}`);
				if (!child.command.includes(`--extension ${this.#packDir}`)) {
					fail(`omp does not load the bundled pack: ${child.command}`);
				}
				return { supervisor: supervisor.pid, omp: child.pid };
			}
			await sleep(POLL_MS);
		}
		fail(`no supervised omp under GUI pid ${gui.pid} within ${BOOT_TIMEOUT_MS / 1000} s`);
	}

	bundleLayout(): void {
		const problems: string[] = [];
		const exe = (path: string) => {
			try {
				const mode = statSync(path).mode & 0o777;
				if (mode !== 0o755) problems.push(`${path} has mode ${mode.toString(8)}, expected 755`);
			} catch {
				problems.push(`${path} is missing`);
			}
		};
		exe(join(this.#macos, "sai-atlas"));
		exe(join(this.#macos, "omp"));
		for (const file of ASSISTANT_PACK_FILES) {
			try {
				if (!statSync(join(this.#packDir, file)).isFile()) problems.push(`assistant-pack/${file} is not a file`);
			} catch {
				problems.push(`assistant-pack/${file} is missing`);
			}
		}
		if (problems.length > 0) fail(problems.join("; "));
	}

	appSignature(): void {
		const verify = run(["codesign", "--verify", "--strict", "--deep", this.#app]);
		if (verify.code !== 0) fail(`codesign --verify exited ${verify.code}: ${verify.stderr.trim()}`);
		const display = run(["codesign", "-dv", this.#app]);
		if (display.code !== 0) fail(`codesign -dv exited ${display.code}: ${display.stderr.trim()}`);
		const { identifier, flags } = codesignDetails(`${display.stdout}\n${display.stderr}`);
		if (identifier !== "vn.io.vif.saiatlas") fail(`Identifier=${identifier ?? "<none>"}`);
		if (!flags.includes("runtime")) fail(`flags (${flags.join(",")}) lack runtime`);
	}

	entitlements(path: string, entitlementsFile: string): void {
		const expected = plistKeys(readFileSync(join(REPO_ROOT, "src-tauri", "macos", entitlementsFile), "utf8"));
		const result = run(["codesign", "-d", "--entitlements", "-", "--xml", path]);
		if (result.code !== 0) fail(`codesign -d --entitlements exited ${result.code}: ${result.stderr.trim()}`);
		const difference = sameKeys(entitlementKeysFromXml(result.stdout), expected);
		if (difference) fail(`entitlements differ from ${entitlementsFile}: ${difference}`);
	}

	appEntitlements(): void {
		this.entitlements(this.#app, "app.entitlements");
	}

	sidecarEntitlements(): void {
		const omp = join(this.#macos, "omp");
		// The entitlements bind only under the hardened runtime.
		const display = run(["codesign", "-dv", omp]);
		if (display.code !== 0) fail(`codesign -dv exited ${display.code}: ${display.stderr.trim()}`);
		const { flags } = codesignDetails(`${display.stdout}\n${display.stderr}`);
		if (!flags.includes("runtime")) fail(`sidecar flags (${flags.join(",")}) lack runtime`);
		this.entitlements(omp, "omp.entitlements");
	}

	infoPlist(): void {
		const result = run(["plutil", "-convert", "json", "-o", "-", join(this.#app, "Contents", "Info.plist")]);
		if (result.code !== 0) fail(`plutil exited ${result.code}: ${result.stderr.trim()}`);
		const problems = infoPlistProblems(JSON.parse(result.stdout) as Record<string, unknown>);
		if (problems.length > 0) fail(problems.join("; "));
	}

	packCheck(): void {
		const script = join(REPO_ROOT, "scripts", "check-assistant-pack.ts");
		const result = run([process.execPath, script, join(this.#macos, "omp"), this.#packDir]);
		if (result.code !== 0) {
			const lines = `${result.stdout}\n${result.stderr}`.split("\n").filter(line => /FAIL|^\s+- /.test(line));
			fail(`check-assistant-pack exited ${result.code}: ${lines.join(" | ") || "no FAIL line"}`);
		}
	}

	async bootsASupervisedSidecar(): Promise<void> {
		const dirs = this.newProfile();
		const gui = this.launch(dirs);
		try {
			const tree = await this.waitForSidecar(gui);
			await sleep(STABLE_MS);
			for (const [name, pid] of Object.entries({ gui: gui.pid, ...tree })) {
				if (!alive(pid)) fail(`${name} pid ${pid} died within ${STABLE_MS / 1000} s`);
			}
			let log = "";
			try {
				log = readFileSync(join(dirs.profile, "logs", "gui-runtime.jsonl"), "utf8");
			} catch {
				// No runtime log means nothing was reported, restarts included.
			}
			const restarts = log.split("\n").filter(line => line.includes('"sidecar-restart"'));
			if (restarts.length > 0) fail(`gui-runtime.jsonl has ${restarts.length} sidecar-restart entries`);
		} finally {
			await this.stop([gui]);
		}
	}

	async singleInstancePerProfile(): Promise<void> {
		const first = this.newProfile();
		const firstGui = this.launch(first);
		const started: Bun.Subprocess[] = [firstGui];
		try {
			await this.waitForSidecar(firstGui);
			const second = this.launch(first);
			started.push(second);
			const exited = await Promise.race([
				second.exited.then(() => true),
				sleep(HANDOFF_TIMEOUT_MS).then(() => false),
			]);
			if (!exited) fail(`a second launch on the same profile still runs after ${HANDOFF_TIMEOUT_MS / 1000} s`);
			if (second.exitCode !== 0) {
				fail(`a second launch on the same profile exited ${second.exitCode ?? second.signalCode}, expected 0`);
			}
			if (!alive(firstGui.pid) || firstGui.exitCode !== null) fail("the first instance exited after the handoff");

			const other = this.launch(this.newProfile());
			started.push(other);
			await this.waitForSidecar(other);
			if (other.exitCode !== null) fail(`a launch on another profile exited ${other.exitCode}`);
			if (!alive(firstGui.pid)) fail("the first instance exited when another profile started");
		} finally {
			await this.stop(started);
		}
	}

	async hardKillLeavesNothing(): Promise<void> {
		const gui = this.launch(this.newProfile());
		try {
			const tree = await this.waitForSidecar(gui);
			const recorded = [tree.supervisor, tree.omp, ...descendantsOf(ps(), tree.omp)].filter(
				(pid, index, all) => all.indexOf(pid) === index,
			);
			process.kill(gui.pid, "SIGKILL");
			const deadline = Date.now() + HARD_KILL_TIMEOUT_MS;
			let survivors = recorded.filter(alive);
			while (survivors.length > 0 && Date.now() < deadline) {
				await sleep(POLL_MS);
				survivors = recorded.filter(alive);
			}
			if (survivors.length > 0) {
				fail(`still alive ${HARD_KILL_TIMEOUT_MS / 1000} s after SIGKILL: ${survivors.join(", ")}`);
			}
		} finally {
			await this.stop([gui]);
		}
	}

	/** SIGTERM, then SIGKILL after the grace period. */
	async stop(children: readonly Bun.Subprocess[]): Promise<void> {
		const running = children.filter(child => child.exitCode === null && child.signalCode === null);
		for (const child of running) child.kill("SIGTERM");
		await Promise.race([Promise.all(running.map(child => child.exited)), sleep(STOP_GRACE_MS)]);
		for (const child of running) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await Promise.all(running.map(child => child.exited));
	}

	/**
	 * Stops every launch still running, gives their sidecars the supervisor's
	 * shutdown time to exit, then kills any that are still this app's and
	 * returns them: a sidecar alive after a clean stop is a leak.
	 */
	async cleanup(): Promise<number[]> {
		await this.stop(this.#launched);
		const deadline = Date.now() + CLEAN_STOP_TIMEOUT_MS;
		let leftovers = [...this.#sidecarPids].filter(alive);
		while (leftovers.length > 0 && Date.now() < deadline) {
			await sleep(POLL_MS);
			leftovers = leftovers.filter(alive);
		}
		const ours = new Set(
			ps()
				.filter(row => row.command.startsWith(`${this.#macos}/`))
				.map(row => row.pid),
		);
		leftovers = leftovers.filter(pid => ours.has(pid));
		for (const pid of leftovers) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		return leftovers;
	}
}

export async function main(appArg: string): Promise<number> {
	const app = resolve(appArg);
	if (app.startsWith("/Applications/")) {
		console.error("tauri-mac-smoke: refusing to run a build from /Applications");
		return 2;
	}
	const root = mkdtempSync(join(tmpdir(), "tauri-mac-smoke-"));
	const harness = new Harness(app, root);
	const cases: [string, () => void | Promise<void>][] = [
		["bundle layout", () => harness.bundleLayout()],
		["app signature", () => harness.appSignature()],
		["app entitlements", () => harness.appEntitlements()],
		["sidecar entitlements", () => harness.sidecarEntitlements()],
		["info plist", () => harness.infoPlist()],
		["pack check", () => harness.packCheck()],
		["boots a supervised sidecar", () => harness.bootsASupervisedSidecar()],
		["single instance per profile", () => harness.singleInstancePerProfile()],
		["hard kill leaves nothing", () => harness.hardKillLeavesNothing()],
	];
	let failed = 0;
	try {
		for (const [name, check] of cases) {
			try {
				await check();
				console.log(`PASS ${name}`);
			} catch (error) {
				failed++;
				console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} finally {
		const leaked = await harness.cleanup();
		if (leaked.length > 0) {
			failed++;
			console.log(
				`FAIL clean stop: sidecar pids ${leaked.join(", ")} outlived the app by ${CLEAN_STOP_TIMEOUT_MS / 1000} s`,
			);
		}
	}
	if (failed > 0) {
		console.error(`tauri-mac-smoke: throwaway profiles kept at ${root}`);
		console.log(`tauri-mac-smoke: FAIL (${failed})`);
		return 1;
	}
	rmSync(root, { recursive: true, force: true });
	console.log("tauri-mac-smoke: PASS");
	return 0;
}

if (import.meta.main) {
	if (process.platform !== "darwin") {
		console.log("tauri-mac-smoke: macOS only");
		process.exit(2);
	}
	const app = process.argv[2];
	if (!app || process.argv.length > 3) {
		console.error('usage: bun scripts/tauri-mac-smoke.ts "<path>/Sai ATLAS.app"');
		process.exit(2);
	}
	process.exit(await main(app));
}
