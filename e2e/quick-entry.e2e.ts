/**
 * Quick entry end to end on the dev build: the bar is summoned through the
 * real `second-instance` handler (`sai-atlas --quick-entry`), its prompt is
 * handed to a new tab in the main window, and the sidecar fixture records what
 * that tab sent. The restore list needs a window to close between lease and
 * acknowledgement, which e2e cannot time; unit tests cover it.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import type { IpcTabInfo } from "../src/shared/ipc-types";
import { writeDesktopPrefs } from "./desktop-prefs";

let app: ElectronApplication;
let profile: string;
let record: string;

async function recorded(type: string): Promise<{ type: string; message?: string }[]> {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line))
		.filter(command => command.type === type);
}

const isBarUrl = (url: string) => url.includes("quick-entry.html");

/** The chat window; the bar is a second BrowserWindow once summoned. */
function mainPage(): Page {
	const page = app.windows().find(window => !isBarUrl(window.url()));
	if (!page) throw new Error("main window not found");
	return page;
}

function tabs(): Promise<IpcTabInfo[]> {
	return mainPage().evaluate(() => window.omp.tabs.list());
}

async function barVisible(): Promise<boolean> {
	return app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().some(
			win => win.webContents.getURL().includes("quick-entry.html") && win.isVisible(),
		),
	);
}

/** What `sai-atlas --quick-entry` does against the running app. */
async function openQuickEntry(): Promise<Page> {
	await app.evaluate(({ app }) => {
		app.emit("second-instance", {}, [process.execPath, process.argv[1], "--quick-entry"], process.cwd(), {});
	});
	await expect.poll(() => app.windows().some(window => isBarUrl(window.url()))).toBe(true);
	const bar = app.windows().find(window => isBarUrl(window.url()));
	if (!bar) throw new Error("quick entry window not found");
	await bar.waitForFunction(() => document.querySelector("textarea") !== null);
	await expect.poll(barVisible).toBe(true);
	return bar;
}

async function send(bar: Page, text: string): Promise<void> {
	const input = bar.locator("textarea");
	await input.fill(text);
	await input.press("Enter");
}

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-quick-entry-"));
	const project = path.join(profile, "project");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await writeDesktopPrefs(userData, { language: "en", firstRunComplete: true });
	const fixture = path.resolve("e2e/sidecar-fixture.ts");
	await fs.chmod(fixture, 0o755);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: fixture,
		OMP_GUI_TEST_RECORD: record,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${userData}`],
		env,
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterAll(async () => {
	// Test teardown bypasses the production quit confirmation.
	if (app) await app.evaluate(({ app }) => app.exit(0));
	if (record) await fs.copyFile(record, "test-results/quick-entry-rpc.jsonl").catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("quick entry sends a new chat and focuses the main window", async () => {
	const before = await tabs();
	const prompts = (await recorded("prompt")).length;
	const bar = await openQuickEntry();
	await send(bar, "hello from quick entry");

	await expect
		.poll(async () => (await recorded("prompt")).map(command => command.message))
		.toContain("hello from quick entry");
	expect((await recorded("prompt")).length).toBe(prompts + 1);
	const after = await tabs();
	expect(after).toHaveLength(before.length + 1);
	expect(after.find(tab => !before.some(old => old.tabId === tab.tabId))?.kind).toBe("chat");
	await expect.poll(barVisible).toBe(false);
});

test("quick entry sends from the Send button", async () => {
	const before = await tabs();
	const prompts = (await recorded("prompt")).length;
	const bar = await openQuickEntry();
	const sendButton = bar.getByRole("button", { name: "Send", exact: true });
	// Nothing to send yet: the button only arms once the draft has text.
	await expect(sendButton).toBeDisabled();
	await bar.locator("textarea").fill("sent with the button");
	await expect(sendButton).toBeEnabled();
	await sendButton.click();

	await expect
		.poll(async () => (await recorded("prompt")).map(command => command.message))
		.toContain("sent with the button");
	expect((await recorded("prompt")).length).toBe(prompts + 1);
	const after = await tabs();
	expect(after).toHaveLength(before.length + 1);
	expect(after.find(tab => !before.some(old => old.tabId === tab.tabId))?.kind).toBe("chat");
	await expect.poll(barVisible).toBe(false);
});

test("quick entry agent target opens the Work workspace", async () => {
	const before = await tabs();
	const bar = await openQuickEntry();
	await bar.getByRole("button", { name: "Agent", exact: true }).click();
	await expect(bar.getByRole("combobox", { name: "Agent workspace" })).toHaveValue("");
	await send(bar, "work on this");

	await expect.poll(async () => (await recorded("prompt")).map(command => command.message)).toContain("work on this");
	const work = await mainPage().evaluate(() => window.omp.sidecar.defaultWorkspace());
	const opened = (await tabs()).find(tab => !before.some(old => old.tabId === tab.tabId));
	expect(opened?.kind).toBe("agent");
	expect(opened?.cwd).toBe(work);
});

test("quick entry ignores an empty message and keeps multiline text", async () => {
	const prompts = (await recorded("prompt")).length;
	const bar = await openQuickEntry();
	const input = bar.locator("textarea");
	await input.fill("   ");
	await input.press("Enter");
	await input.fill("first line");
	await input.press("Shift+Enter");
	await input.pressSequentially("second line");

	await expect(input).toHaveValue("first line\nsecond line");
	expect(await barVisible()).toBe(true);
	expect((await recorded("prompt")).length).toBe(prompts);
	await input.fill("");
	await input.press("Escape");
	await expect.poll(barVisible).toBe(false);
});

test("quick entry leaves a running task alone", async () => {
	const page = mainPage();
	await page.locator("textarea").first().fill("fixture running");
	await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
	await expect(page.getByRole("button", { name: "Abort", exact: true })).toBeVisible();
	const counts = async () => ({
		steer: (await recorded("steer")).length,
		followUp: (await recorded("follow_up")).length,
		abort: (await recorded("abort")).length,
	});
	const before = await counts();
	const prompts = (await recorded("prompt")).length;

	const bar = await openQuickEntry();
	await send(bar, "a separate question");

	await expect.poll(async () => (await recorded("prompt")).length).toBe(prompts + 1);
	expect(await counts()).toEqual(before);
});

test("quick entry leaves shell commands unsent", async () => {
	const before = await tabs();
	const counts = async () => ({
		bash: (await recorded("bash")).length,
		prompt: (await recorded("prompt")).length,
	});
	const sent = await counts();
	const bar = await openQuickEntry();
	await send(bar, "!echo hi");

	await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
	const known = new Set(before.map(tab => tab.tabId));
	// The composer hands off once its tab is ready, so a shell command that slipped
	// through would reach the fixture within moments of that.
	await expect
		.poll(async () => (await tabs()).find(tab => !known.has(tab.tabId))?.status, { timeout: 30_000 })
		.toBe("ready");
	await mainPage().waitForTimeout(1_500);
	await expect(mainPage().locator("textarea").first()).toHaveValue("!echo hi");
	expect(await counts()).toEqual(sent);
});

test("the quick entry page has no app API", async () => {
	const bar = await openQuickEntry();
	expect(await bar.evaluate(() => typeof (window as unknown as { omp?: unknown }).omp)).toBe("undefined");
	expect(await bar.evaluate(() => typeof window.ompQuickEntry?.submit)).toBe("function");
	await bar.locator("textarea").press("Escape");
});

test("Escape hides quick entry", async () => {
	const bar = await openQuickEntry();
	await bar.locator("textarea").press("Escape");
	await expect.poll(barVisible).toBe(false);
});

test("quick entry at the tab limit keeps the text and explains why", async () => {
	test.setTimeout(120_000);
	const page = mainPage();
	await page.evaluate(async () => {
		while (await window.omp.tabs.spawn({ kind: "chat" })) {}
	});
	const bar = await openQuickEntry();
	await send(bar, "one more");

	await expect(bar.getByRole("alert")).toContainText("Parallel limit reached");
	await expect(bar.locator("textarea")).toHaveValue("one more");
	expect(await barVisible()).toBe(true);
});
