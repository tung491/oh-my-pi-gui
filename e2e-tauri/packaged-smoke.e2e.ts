/**
 * Installed-package smoke test for the Tauri shell. Point OMP_GUI_TEST_APP at
 * the installed executable and run its own config, never the default one:
 *
 *   OMP_GUI_TEST_APP=/usr/bin/sai-atlas bun run test:e2e:tauri:packaged
 *
 * The package is built without test hooks, so whatever the Electron spec read
 * from the main process is observed from outside instead (e2e-tauri/outside.ts):
 * /proc for processes and the sandbox, the session bus for the single-instance
 * name, the accessibility bus for the windows, and a WAYLAND_DEBUG trace for the
 * app id. Page-level steps still go through WebDriver. Each launch gets a
 * throwaway profile and agent dir, so the user's settings and sessions are
 * never touched.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { writeDesktopPrefs } from "../e2e/desktop-prefs";
import type { RpcSessionState } from "../src/shared/rpc-types";
import {
	APP_ID,
	alive,
	appProcesses,
	appWindows,
	descendants,
	environOf,
	pgrepFull,
	procInfo,
	sessionBusOwner,
	singleInstanceBusName,
	waylandAppIds,
	webProcesses,
} from "./outside";
import { fill, type LaunchOptions, launch, type PreparedLaunch, relaunch, until } from "./session";

const executablePath = process.env.OMP_GUI_TEST_APP;
/** The quick-entry bar's content size; nothing else the app shows has it. */
const BAR = { width: 680, height: 168 };
const QUIT_GRACE_MS = 15_000;

interface Profile {
	launch: PreparedLaunch;
	otherProject: string;
}

/** Run an assertion; when it fails, prefix its message with what was measured. */
function labelled(label: string, assertion: () => void): void {
	try {
		assertion();
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function app(): string {
	if (!executablePath) throw new Error("OMP_GUI_TEST_APP is not set");
	return executablePath;
}

let current: Profile | null = null;

/** A throwaway profile with two quiet workspaces, launched from its own root like the Electron spec. */
async function start(name: string, options: Pick<LaunchOptions, "noProject" | "captureOutput" | "env"> = {}) {
	const launched = await launch({
		name,
		binary: app(),
		omp: null,
		startInLaunchDir: true,
		...options,
		setup: async prepared => {
			const other = path.join(prepared.dir, "other-project");
			await fs.mkdir(other);
			const quiet = { noExtensions: true, noSkills: true, noRules: true };
			await writeDesktopPrefs(prepared.desktop, {
				language: "en",
				launchProfiles: { [prepared.project]: quiet, [other]: quiet },
			});
		},
	});
	current = { launch: launched, otherProject: path.join(launched.dir, "other-project") };
	await chatWindow();
	await waitForSidecar();
	return current;
}

/** Start the same profile again with other arguments, after the previous instance quit. */
async function restart(profile: Profile, argv: string[]): Promise<void> {
	await relaunch(profile.launch, argv);
	current = profile;
	await chatWindow();
	await waitForSidecar();
}

/** The one shell process of this profile. */
function appPid(profile: Profile): number {
	const pids = appProcesses(app(), profile.launch.desktop);
	if (pids.length !== 1) throw new Error(`expected one app process for the profile, found ${JSON.stringify(pids)}`);
	return pids[0];
}

/** Quit as the session's end would on a desktop: SIGTERM takes the app's graceful exit path. */
async function quit(profile: Profile): Promise<void> {
	for (const pid of appProcesses(app(), profile.launch.desktop)) {
		process.kill(pid, "SIGTERM");
		const deadline = Date.now() + QUIT_GRACE_MS;
		while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
		if (alive(pid)) throw new Error(`the app (pid ${pid}) did not exit within ${QUIT_GRACE_MS} ms of SIGTERM`);
	}
}

async function waitForSidecar(): Promise<void> {
	await browser.waitUntil(
		async () => (await browser.execute(() => window.omp.sidecar.getStatus())).status === "ready",
		{
			timeout: 60_000,
			interval: 250,
			timeoutMsg: "the sidecar never reached ready",
		},
	);
}

/** Switch to the first chat window: the quick-entry bar is a window too, without the app API. */
async function chatWindow(): Promise<void> {
	const found = await until(
		async () => {
			for (const handle of await browser.getWindowHandles()) {
				await browser.switchToWindow(handle);
				if (await browser.execute(() => window.omp?.rpc != null).catch(() => false)) return handle;
			}
			return null;
		},
		handle => handle !== null,
		{ timeout: 30_000, interval: 250 },
	);
	if (!found) throw new Error("chat window not found");
}

async function sessionState(): Promise<RpcSessionState> {
	const response = await browser.execute(() => window.omp.rpc.getState());
	if (!response.success) throw new Error(JSON.stringify(response));
	return response.data as RpcSessionState;
}

/** A refused second instance: hands its argv to the running app and exits. */
async function secondInstance(profile: Profile, args: string[]): Promise<void> {
	// The launch's environment, minus the output capture that belongs to the first instance.
	const env = Object.fromEntries(Object.entries(profile.launch.env).filter(([key]) => key !== "OMP_E2E_APP_LOG"));
	const child = spawn(app(), [...args, `--user-data-dir=${profile.launch.desktop}`], {
		env: { ...process.env, ...env },
		cwd: profile.launch.dir,
		stdio: "ignore",
	});
	const [code] = (await Promise.race([
		once(child, "exit"),
		new Promise((_, reject) => setTimeout(() => reject(new Error("the second instance did not exit")), 30_000)),
	])) as [number | null];
	if (code !== 0) throw new Error(`the second instance exited with ${code}`);
}

/** Whether the bar is on screen, from the app's window list (GNOME refuses the compositor's to clients). */
function barVisible(profile: Profile): boolean {
	return appWindows(appPid(profile)).some(
		window => window.showing && window.width === BAR.width && window.height === BAR.height,
	);
}

/** The quick-entry bar once the app shows it; leaves the session on the bar's page. */
async function quickEntryBar(profile: Profile): Promise<void> {
	await browser.waitUntil(() => barVisible(profile), {
		timeout: 30_000,
		timeoutMsg: "the quick entry bar never showed",
	});
	const handle = await until(
		async () => {
			for (const candidate of await browser.getWindowHandles()) {
				await browser.switchToWindow(candidate);
				if ((await browser.getUrl()).includes("quick-entry.html")) return candidate;
			}
			return null;
		},
		found => found !== null,
		{ timeout: 30_000, interval: 250 },
	);
	if (!handle) throw new Error("quick entry window not found");
	await browser.waitUntil(() => browser.execute(() => document.querySelector("textarea") !== null));
}

describe("installed package", () => {
	before(function () {
		if (!executablePath) this.skip();
	});

	afterEach(async () => {
		if (current) await quit(current);
		current = null;
	});

	it("boots sandboxed and renders with a ready sidecar", async () => {
		const profile = await start("boot", { noProject: true, captureOutput: true, env: { WAYLAND_DEBUG: "client" } });
		const pid = appPid(profile);
		const shell = procInfo(pid);
		// WebKit's only switch for running web content unsandboxed is this variable.
		expect(environOf(pid).WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS).toBeUndefined();
		expect(shell?.cmdline).not.toContain("--no-sandbox");
		// A second window, so every web process is checked, not only the first one.
		await secondInstance(profile, [profile.otherProject]);
		expect(
			await until(
				() => appWindows(pid).length,
				count => count >= 2,
				{ timeout: 30_000 },
			),
		).toBeGreaterThanOrEqual(2);
		const web = webProcesses(pid);
		expect(web.length).toBeGreaterThan(0);
		for (const content of web) {
			// Seccomp mode 2: the bubblewrap sandbox's syscall filter is active.
			labelled(`web process ${content.pid} seccomp`, () => expect(content.seccomp).toBe("2"));
			labelled(`web process ${content.pid} NSpid`, () => expect(content.nspid.length).toBeGreaterThan(1));
			labelled(`web process ${content.pid} parent`, () => expect(procInfo(content.ppid)?.comm).toBe("bwrap"));
		}
		// A throwaway profile owns its own single-instance name, never the default profile's.
		expect(sessionBusOwner(singleInstanceBusName(profile.launch.desktop))).toBe(pid);
		const appIds = waylandAppIds(profile.launch.output ?? "");
		expect(appIds.length).toBeGreaterThan(0);
		expect([...new Set(appIds)]).toEqual([APP_ID]);
		await expect($("#root > *")).toBeDisplayed();
		const settings = await browser.execute(() => window.omp.rpc.getSettings());
		labelled(JSON.stringify(settings), () => expect(settings.success).toBe(true));
	}).timeout(180_000);

	it("persists a settings toggle across a relaunch", async () => {
		const profile = await start("persist");
		const changed = await browser.execute(() => window.omp.rpc.setSetting("compaction.enabled", false));
		labelled(JSON.stringify(changed), () => expect(changed.success).toBe(true));
		await quit(profile);
		await restart(profile, [profile.launch.project]);
		expect((await sessionState()).autoCompactionEnabled).toBe(false);
	}).timeout(180_000);

	it("opens a workspace passed on the command line, cold and warm", async () => {
		const profile = await start("workspace");
		expect((await sessionState()).cwd).toBe(profile.launch.project);
		const before = await browser.getWindowHandles();
		await secondInstance(profile, [profile.otherProject]);
		const opened = await until(
			async () => (await browser.getWindowHandles()).find(handle => !before.includes(handle)) ?? null,
			handle => handle !== null,
			{ timeout: 30_000, interval: 250 },
		);
		if (!opened) throw new Error("the second workspace opened no window");
		await browser.switchToWindow(opened);
		await waitForSidecar();
		expect(
			await until(
				async () => (await sessionState()).cwd,
				cwd => cwd === profile.otherProject,
				{ timeout: 30_000 },
			),
		).toBe(profile.otherProject);
	}).timeout(180_000);

	it("opens quick entry from the command line, cold and warm", async () => {
		const profile = await start("quick-entry");
		const main = await browser.getWindowHandle();
		const before = (await browser.execute(() => window.omp.tabs.list())).length;
		await secondInstance(profile, ["--quick-entry"]);
		await quickEntryBar(profile);
		const text = "quick entry from the command line";
		await fill($("textarea"), text);
		await browser.keys("Enter");
		expect(
			await until(
				() => barVisible(profile),
				visible => !visible,
			),
		).toBe(false);
		await browser.switchToWindow(main);
		expect(
			await until(
				async () => (await browser.execute(() => window.omp.tabs.list())).length,
				count => count === before + 1,
				{ timeout: 30_000 },
			),
		).toBe(before + 1);
		await expect($(`//*[contains(text(), "${text}")]`)).toBeDisplayed({ wait: 30_000 });
		await quit(profile);
		// Cold: the bar waits for the restored window, and that window's first
		// focus must not blur it away. A maximized window is already visible
		// before its page paints, so it is the case most likely to steal focus late.
		await fs.writeFile(
			path.join(profile.launch.desktop, "window-state.json"),
			JSON.stringify({ windowState: { width: 1400, height: 900, isMaximized: true } }),
		);
		await restart(profile, ["--quick-entry"]);
		await quickEntryBar(profile);
		await browser.pause(2_000);
		expect(barVisible(profile)).toBe(true);
	}).timeout(240_000);

	it("follows omp:// links, cold and warm", async () => {
		const profile = await start("links");
		const marked = await browser.execute(() => window.omp.rpc.bash("printf 'deep link target'"));
		labelled(JSON.stringify(marked), () => expect(marked.success).toBe(true));
		const targetId = (await sessionState()).sessionId;
		// A newer, non-empty session is what a plain relaunch restores instead.
		const fresh = await browser.execute(() => window.omp.rpc.newSession());
		labelled(JSON.stringify(fresh), () => expect(fresh.success).toBe(true));
		const newer = await browser.execute(() => window.omp.rpc.bash("printf 'newer session'"));
		labelled(JSON.stringify(newer), () => expect(newer.success).toBe(true));
		await quit(profile);
		expect(targetId).not.toBe("");
		await restart(profile, [`omp://session/${targetId}`]);
		expect(
			await until(
				async () => (await sessionState()).sessionId,
				id => id === targetId,
				{ timeout: 30_000 },
			),
		).toBe(targetId);
		await secondInstance(profile, ["omp://new"]);
		expect(
			await until(
				async () => (await sessionState()).sessionId,
				id => id !== targetId,
				{ timeout: 30_000 },
			),
		).not.toBe(targetId);
	}).timeout(240_000);

	it("exposes the host platform to the renderer", async () => {
		await start("platform", { noProject: true });
		const platform = await browser.execute(() => window.omp.platform);
		expect(platform).toBe(process.platform);
	}).timeout(120_000);

	it("checks for updates against latest-linux.yml", async function () {
		if (process.platform !== "linux") this.skip();
		await start("updates", { noProject: true });
		const status = await browser.execute(() => window.omp.updater.check());
		// A release without Linux metadata fails naming the channel file; one
		// with it resolves to a version verdict. Both prove the channel.
		expect(JSON.stringify(status)).toMatch(/latest-linux\.yml|"state":"(not-available|available)"/);
	}).timeout(120_000);

	it("a hard kill leaves no sidecar or supervisor", async () => {
		const profile = await start("hard-kill");
		const pid = appPid(profile);
		const below = (pattern: string) =>
			descendants(pid)
				.filter(info => info.cmdline.join(" ").includes(pattern))
				.map(info => info.pid);
		// A second task (the sidebar's "New task" button) runs its own sidecar beside the first.
		await $("[data-sidebar-new-agent]").click();
		expect(
			await until(
				() => below("--mode rpc-ui").length,
				count => count >= 2,
				{ timeout: 30_000 },
			),
		).toBeGreaterThanOrEqual(2);
		const sidecars = below("--mode rpc-ui");
		const supervisors = below("--omp-supervise");
		expect(sidecars.length).toBeGreaterThan(0);
		expect(supervisors.length).toBeGreaterThan(0);
		process.kill(pid, "SIGKILL");
		const survivors = () => [...sidecars, ...supervisors].filter(alive);
		expect(await until(survivors, left => left.length === 0, { timeout: 10_000, interval: 100 })).toEqual([]);
		// The plan's pgrep checks, scoped to this profile's agent dir so another
		// omp on the machine (the user's own app, another checkout) never counts.
		for (const pattern of ["omp --mode rpc-ui", "--omp-supervise"]) {
			const left = pgrepFull(pattern).filter(other => environOf(other).PI_CODING_AGENT_DIR === profile.launch.agent);
			labelled(pattern, () => expect(left).toEqual([]));
		}
		// The killed session cannot be deleted cleanly; leave a live one for teardown.
		await restart(profile, [profile.launch.project]);
	}).timeout(180_000);
});
