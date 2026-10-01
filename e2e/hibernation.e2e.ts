import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { IpcTabInfo } from "../src/shared/ipc-types";
import type { RpcSessionState } from "../src/shared/rpc-types";

// The pool sweeps once a minute and the shortest idle time is five minutes, so
// a hibernation takes up to six minutes of wall time. There is no main-process
// test hook to shorten that; every case shares one launch and one wait.
test("idle background tabs hibernate, wake with their transcript and plan mode, and a running job keeps a tab awake", async () => {
	test.setTimeout(11 * 60_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-hibernation-"));
	const desktop = path.join(profile, "desktop"),
		agent = path.join(profile, "agent"),
		project = path.join(profile, "project"),
		sessions = path.join(profile, "sessions");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project), fs.mkdir(sessions)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, tabHibernation: { enabled: true, idleMinutes: 5 } }),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: path.resolve("e2e/sidecar-fixture.ts"),
		OMP_GUI_TEST_SESSION_DIR: sessions,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	const tabs = page.locator('[role="tablist"] [role="tab"]');
	const rows = page.locator("[data-transcript-kind]");
	try {
		await expect(page.locator("textarea").first()).toBeEditable({ timeout: 60_000 });

		const plain = await sendInFocusedTab(page, "hibernate plain");
		const plainRows = await rows.count();

		await openTab(page, 2);
		const plan = await sendInFocusedTab(page, "hibernate plan");
		const armed = await page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "set_plan_mode", enabled: true }),
			plan,
		);
		expect(armed.success).toBe(true);

		await openTab(page, 3);
		const busy = await sendInFocusedTab(page, "fixture background job");

		// A fourth, visible tab leaves the other three in the background.
		await openTab(page, 4);

		await expect
			.poll(async () => statusesOf(page, [plain, plan, busy]), { timeout: 8 * 60_000, intervals: [5_000] })
			.toEqual(["asleep", "asleep", "ready"]);

		await tabs.nth(0).click();
		await expect.poll(async () => statusOf(page, plain), { timeout: 30_000 }).toBe("ready");
		await expect(page.getByText("hibernate plain", { exact: true })).toBeVisible();
		await expect(rows).toHaveCount(plainRows);

		await tabs.nth(1).click();
		// `ready` is held back until plan mode is re-armed, so the first state
		// read after it must already have the read-only guard.
		await expect.poll(async () => statusOf(page, plan), { timeout: 30_000, intervals: [50] }).toBe("ready");
		const state = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), plan);
		expect((state.data as RpcSessionState).planModeEnabled).toBe(true);

		expect(await statusOf(page, busy)).toBe("ready");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await fs.rm(profile, { recursive: true, force: true });
	}
});

async function listTabs(page: Page): Promise<IpcTabInfo[]> {
	return page.evaluate(() => window.omp.tabs.list());
}

async function statusOf(page: Page, tabId: string): Promise<string | undefined> {
	return (await listTabs(page)).find(tab => tab.tabId === tabId)?.status;
}

async function statusesOf(page: Page, tabIds: string[]): Promise<Array<string | undefined>> {
	const all = await listTabs(page);
	return tabIds.map(id => all.find(tab => tab.tabId === id)?.status);
}

async function openTab(page: Page, count: number): Promise<void> {
	await page.getByRole("button", { name: "New Agent Tab", exact: true }).click();
	await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveCount(count);
	await expect.poll(async () => (await listTabs(page)).find(tab => tab.active)?.status).toBe("ready");
}

/** Send a prompt in the focused tab, wait for the fixture's reply, return that tab's id. */
async function sendInFocusedTab(page: Page, text: string): Promise<string> {
	const input = page.locator("textarea").first();
	await expect(input).toBeEditable();
	await input.fill(text);
	await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
	await expect(page.getByText(text, { exact: true })).toBeVisible();
	await expect(page.getByText("Local fixture reply", { exact: true })).toBeVisible();
	const active = (await listTabs(page)).find(tab => tab.active);
	if (!active) throw new Error("no active tab");
	await expect.poll(async () => statusOf(page, active.tabId)).toBe("ready");
	return active.tabId;
}
