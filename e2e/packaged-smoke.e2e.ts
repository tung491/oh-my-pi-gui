/**
 * Installed-package smoke test. Point OMP_GUI_TEST_APP at an installed
 * executable, e.g. OMP_GUI_TEST_APP="/opt/Sai ATLAS/sai-atlas" bunx playwright test
 * e2e/packaged-smoke.e2e.ts. Each launch gets a throwaway profile, so the
 * user's omp settings and sessions are never touched. On Linux the app still
 * registers itself as the omp:// handler in ~/.config/mimeapps.list; back that
 * file up before a run and restore it afterwards.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import type { RpcSessionState } from "../src/shared/rpc-types";

const executablePath = process.env.OMP_GUI_TEST_APP;
/** XWayland on Linux, so no case asks the developer's desktop to bind global shortcuts through the portal. */
const PLATFORM_ARGS = process.platform === "linux" ? ["--ozone-platform=x11"] : [];

/** Inferred, like e2e/real-core.e2e.ts: a ProcessEnv annotation would not satisfy electron.launch. */
function buildEnv(agent: string, root: string) {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
}

interface Profile {
	root: string;
	project: string;
	otherProject: string;
	desktop: string;
	env: ReturnType<typeof buildEnv>;
}

async function createProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-packaged-")));
	const project = path.join(root, "project");
	const otherProject = path.join(root, "other-project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(otherProject), fs.mkdir(desktop), fs.mkdir(agent)]);
	const quiet = { noExtensions: true, noSkills: true, noRules: true };
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", launchProfiles: { [project]: quiet, [otherProject]: quiet } }),
	);
	const env = buildEnv(agent, root);
	for (const key of ["ELECTRON_RUN_AS_NODE", "OMP_SIDECAR", "OMP_BUNDLED_OMP"]) Reflect.deleteProperty(env, key);
	return { root, project, otherProject, desktop, env };
}

async function waitForSidecar(page: Page): Promise<void> {
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
}

/** The first chat window: the quick-entry bar is a window too, without the app API. */
async function chatWindow(app: ElectronApplication): Promise<Page> {
	await app.firstWindow();
	let chat: Page | undefined;
	await expect
		.poll(
			async () => {
				for (const page of app.windows()) {
					if (await page.evaluate(() => window.omp?.rpc != null).catch(() => false)) {
						chat = page;
						return true;
					}
				}
				return false;
			},
			{ timeout: 30_000 },
		)
		.toBe(true);
	if (!chat) throw new Error("chat window not found");
	return chat;
}

/** cwd is the profile root, never a project: a launch that ignores its argv lands somewhere else. */
async function launch(profile: Profile, args: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		executablePath,
		args: [...PLATFORM_ARGS, ...args, `--user-data-dir=${profile.desktop}`],
		// Playwright prepends --no-sandbox on Linux unless told the sandbox is wanted.
		chromiumSandbox: true,
		env: profile.env,
		cwd: profile.root,
	});
	const page = await chatWindow(app);
	await waitForSidecar(page);
	return { app, page };
}

async function sessionState(page: Page): Promise<RpcSessionState> {
	const response = await page.evaluate(() => window.omp.rpc.getState());
	if (!response.success) throw new Error(JSON.stringify(response));
	return response.data as RpcSessionState;
}

/** A refused second instance: hands its argv to the running app and exits. */
async function secondInstance(profile: Profile, args: string[]): Promise<void> {
	if (!executablePath) throw new Error("OMP_GUI_TEST_APP is not set");
	const child = spawn(executablePath, [...PLATFORM_ARGS, ...args, `--user-data-dir=${profile.desktop}`], {
		env: profile.env,
		cwd: profile.root,
		stdio: "ignore",
	});
	await once(child, "exit");
}

const isBarUrl = (url: string) => url.includes("quick-entry.html");

async function barVisible(app: ElectronApplication): Promise<boolean> {
	return app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().some(
			win => win.webContents.getURL().includes("quick-entry.html") && win.isVisible(),
		),
	);
}

/** The quick-entry bar once main has created it and it is on screen. */
async function quickEntryBar(app: ElectronApplication): Promise<Page> {
	await expect.poll(() => app.windows().some(window => isBarUrl(window.url())), { timeout: 30_000 }).toBe(true);
	const bar = app.windows().find(window => isBarUrl(window.url()));
	if (!bar) throw new Error("quick entry window not found");
	await bar.waitForFunction(() => document.querySelector("textarea") !== null);
	await expect.poll(() => barVisible(app), { timeout: 30_000 }).toBe(true);
	return bar;
}

test.describe("installed package", () => {
	test.skip(!executablePath, "set OMP_GUI_TEST_APP to an installed omp executable");

	test("boots sandboxed and renders with a ready sidecar", async () => {
		test.setTimeout(180_000);
		const profile = await createProfile();
		const { app, page } = await launch(profile);
		try {
			const main = await app.evaluate(({ app: electronApp }) => ({
				argv: process.argv,
				noSandbox: electronApp.commandLine.hasSwitch("no-sandbox"),
			}));
			expect(main.noSandbox).toBe(false);
			expect(main.argv).not.toContain("--no-sandbox");
			if (process.platform === "linux") {
				const rendererPid = await app.evaluate(
					({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? 0,
				);
				// Seccomp mode 2: the Chromium sandbox's syscall filter is active.
				expect(await fs.readFile(`/proc/${rendererPid}/status`, "utf8")).toMatch(/^Seccomp:\s+2$/m);
			}
			await expect(page.locator("#root > *").first()).toBeVisible();
			const settings = await page.evaluate(() => window.omp.rpc.getSettings());
			expect(settings.success, JSON.stringify(settings)).toBe(true);
		} finally {
			await app.close();
		}
	});

	test("persists a settings toggle across a relaunch", async () => {
		test.setTimeout(180_000);
		const profile = await createProfile();
		const first = await launch(profile, [profile.project]);
		try {
			const changed = await first.page.evaluate(() => window.omp.rpc.setSetting("compaction.enabled", false));
			expect(changed.success, JSON.stringify(changed)).toBe(true);
		} finally {
			await first.app.close();
		}
		const second = await launch(profile, [profile.project]);
		try {
			expect((await sessionState(second.page)).autoCompactionEnabled).toBe(false);
		} finally {
			await second.app.close();
		}
	});

	test("opens a workspace passed on the command line, cold and warm", async () => {
		test.setTimeout(180_000);
		const profile = await createProfile();
		const { app, page } = await launch(profile, [profile.project]);
		try {
			expect((await sessionState(page)).cwd).toBe(profile.project);
			const opened = app.waitForEvent("window");
			await secondInstance(profile, [profile.otherProject]);
			const other = await opened;
			await waitForSidecar(other);
			await expect.poll(async () => (await sessionState(other)).cwd, { timeout: 30_000 }).toBe(profile.otherProject);
		} finally {
			await app.close();
		}
	});

	test("opens quick entry from the command line, cold and warm", async () => {
		test.setTimeout(240_000);
		const profile = await createProfile();
		const warm = await launch(profile, [profile.project]);
		try {
			const before = (await warm.page.evaluate(() => window.omp.tabs.list())).length;
			await secondInstance(profile, ["--quick-entry"]);
			const bar = await quickEntryBar(warm.app);
			const text = "quick entry from the command line";
			await bar.locator("textarea").fill(text);
			await bar.locator("textarea").press("Enter");
			await expect.poll(() => barVisible(warm.app)).toBe(false);
			await expect
				.poll(async () => (await warm.page.evaluate(() => window.omp.tabs.list())).length, { timeout: 30_000 })
				.toBe(before + 1);
			await expect(warm.page.getByText(text).first()).toBeVisible({ timeout: 30_000 });
		} finally {
			await warm.app.close();
		}
		// Cold: the bar waits for the restored window, and that window's first
		// focus must not blur it away. A maximized window is already visible
		// before its page paints, so it is the case most likely to steal focus late.
		await fs.writeFile(
			path.join(profile.desktop, "window-state.json"),
			JSON.stringify({ windowState: { width: 1400, height: 900, isMaximized: true } }),
		);
		const cold = await launch(profile, ["--quick-entry"]);
		try {
			await quickEntryBar(cold.app);
			await cold.page.waitForTimeout(2_000);
			expect(await barVisible(cold.app)).toBe(true);
		} finally {
			await cold.app.close();
		}
	});

	test("follows omp:// links, cold and warm", async () => {
		test.setTimeout(240_000);
		const profile = await createProfile();
		let targetId = "";
		const first = await launch(profile, [profile.project]);
		try {
			const marked = await first.page.evaluate(() => window.omp.rpc.bash("printf 'deep link target'"));
			expect(marked.success, JSON.stringify(marked)).toBe(true);
			targetId = (await sessionState(first.page)).sessionId;
			// A newer, non-empty session is what a plain relaunch restores instead.
			const fresh = await first.page.evaluate(() => window.omp.rpc.newSession());
			expect(fresh.success, JSON.stringify(fresh)).toBe(true);
			const newer = await first.page.evaluate(() => window.omp.rpc.bash("printf 'newer session'"));
			expect(newer.success, JSON.stringify(newer)).toBe(true);
		} finally {
			await first.app.close();
		}
		expect(targetId).not.toBe("");
		const second = await launch(profile, [`omp://session/${targetId}`]);
		try {
			await expect.poll(async () => (await sessionState(second.page)).sessionId, { timeout: 30_000 }).toBe(targetId);
			await secondInstance(profile, ["omp://new"]);
			await expect
				.poll(async () => (await sessionState(second.page)).sessionId, { timeout: 30_000 })
				.not.toBe(targetId);
		} finally {
			await second.app.close();
		}
	});

	test("exposes the host platform to the renderer", async () => {
		test.setTimeout(120_000);
		const profile = await createProfile();
		const { app, page } = await launch(profile);
		try {
			const platform = await page.evaluate(() => window.omp.platform);
			expect(platform).toBe(process.platform);
		} finally {
			await app.close();
		}
	});

	test("checks for updates against latest-linux.yml", async () => {
		test.skip(process.platform !== "linux", "Linux update channel only");
		test.setTimeout(120_000);
		const profile = await createProfile();
		const { app, page } = await launch(profile);
		try {
			const status = await page.evaluate(() => window.omp.updater.check());
			// A release without Linux metadata fails naming the channel file; one
			// with it resolves to a version verdict. Both prove the channel.
			expect(JSON.stringify(status)).toMatch(/latest-linux\.yml|"state":"(not-available|available)"/);
		} finally {
			await app.close();
		}
	});
});
