/**
 * Quick entry end to end on the e2e-hooks build: the bar is summoned through
 * the real second-instance path (`sai-atlas --quick-entry`, through the
 * `test:second-instance` hook), its prompt is handed to a new tab in the main
 * window, and the sidecar fixture records what that tab sent. The restore list
 * needs a window to close between lease and acknowledgement, which e2e cannot
 * time; unit tests cover it.
 *
 * The bar is its own webview, so it is a second WebDriver window handle. The
 * test hooks and `window.omp` live in the chat window, so every helper that
 * reads them switches there and back.
 */

import * as fs from "node:fs/promises";
import { $, browser, expect } from "@wdio/globals";
import type { IpcTabInfo } from "../src/shared/ipc-types";
import { awaitMainWindow, type Launch, launch, recorded, until } from "./session";
import { quickEntryVisible, secondInstance } from "./test-hooks";

/** The bar's content size (Phase 5's 680×168 window, no empty band below the input). */
const BAR_SIZE = [680, 168];

let app: Launch;
let main: string;

const isBarUrl = (url: string) => url.includes("quick-entry.html");

/** Run `read` in the chat window, then return to whichever window was current. */
async function inMain<T>(read: () => Promise<T>): Promise<T> {
	const current = await browser.getWindowHandle();
	if (current !== main) await browser.switchToWindow(main);
	try {
		return await read();
	} finally {
		if (current !== main) await browser.switchToWindow(current);
	}
}

function tabs(): Promise<IpcTabInfo[]> {
	return inMain(async () => await browser.execute(() => window.omp.tabs.list()));
}

function barVisible(): Promise<boolean> {
	return inMain(() => quickEntryVisible(browser));
}

async function barHandle(): Promise<string | null> {
	const others = (await browser.getWindowHandles()).filter(handle => handle !== main);
	return others[0] ?? null;
}

function prompts(): Promise<{ type: string; message?: string }[]> {
	return recorded(app.record, "prompt");
}

/** What `sai-atlas --quick-entry` does against the running app; leaves the session on the bar. */
async function openQuickEntry(): Promise<string> {
	await browser.switchToWindow(main);
	await secondInstance(browser, ["sai-atlas", "--quick-entry"]);
	const handle = await until(barHandle, found => found !== null);
	if (!handle) throw new Error("quick entry window not found");
	await browser.switchToWindow(handle);
	if (!isBarUrl(await browser.getUrl()))
		throw new Error(`the second window is not the bar: ${await browser.getUrl()}`);
	await browser.waitUntil(() => browser.execute(() => document.querySelector("textarea") !== null), {
		timeoutMsg: "the quick entry bar never rendered its input",
	});
	await browser.waitUntil(async () => barVisible(), { timeoutMsg: "the quick entry bar never became visible" });
	expect(await browser.execute(() => [window.innerWidth, window.innerHeight])).toEqual(BAR_SIZE);
	return handle;
}

async function send(text: string): Promise<void> {
	await $("textarea").setValue(text);
	await browser.keys("Enter");
}

describe("quick entry", () => {
	before(async () => {
		app = await launch({
			name: "quick-entry",
			prefs: { firstRunComplete: true },
		});
		await awaitMainWindow(browser);
		main = await browser.getWindowHandle();
	});

	after(async () => {
		if (app) await fs.copyFile(app.record, "test-results/quick-entry-rpc.jsonl").catch(() => {});
	});

	it("quick entry sends a new task and focuses the main window", async () => {
		const before = await tabs();
		const count = (await prompts()).length;
		await openQuickEntry();
		await send("hello from quick entry");

		expect(
			await until(
				async () => (await prompts()).map(command => command.message),
				messages => messages.includes("hello from quick entry"),
			),
		).toContain("hello from quick entry");
		expect((await prompts()).length).toBe(count + 1);
		const after = await tabs();
		expect(after).toHaveLength(before.length + 1);
		expect(after.find(tab => !before.some(old => old.tabId === tab.tabId))?.kind).toBe("agent");
		expect(await until(barVisible, visible => !visible)).toBe(false);
	});

	it("quick entry sends from the Send button", async () => {
		const before = await tabs();
		const count = (await prompts()).length;
		await openQuickEntry();
		const sendButton = $("button=Send");
		// Nothing to send yet: the button only arms once the draft has text.
		await expect(sendButton).toBeDisabled();
		await $("textarea").setValue("sent with the button");
		await expect(sendButton).toBeEnabled();
		await sendButton.click();

		expect(
			await until(
				async () => (await prompts()).map(command => command.message),
				messages => messages.includes("sent with the button"),
			),
		).toContain("sent with the button");
		expect((await prompts()).length).toBe(count + 1);
		const after = await tabs();
		expect(after).toHaveLength(before.length + 1);
		expect(after.find(tab => !before.some(old => old.tabId === tab.tabId))?.kind).toBe("agent");
		expect(await until(barVisible, visible => !visible)).toBe(false);
	});

	it("quick entry opens the Work workspace by default", async () => {
		const before = await tabs();
		await openQuickEntry();
		await expect($('select[aria-label="Agent workspace"]')).toHaveValue("");
		await send("work on this");

		expect(
			await until(
				async () => (await prompts()).map(command => command.message),
				messages => messages.includes("work on this"),
			),
		).toContain("work on this");
		const work = await inMain(async () => await browser.execute(() => window.omp.sidecar.defaultWorkspace()));
		const opened = (await tabs()).find(tab => !before.some(old => old.tabId === tab.tabId));
		expect(opened?.kind).toBe("agent");
		expect(opened?.cwd).toBe(work);
	});

	it("quick entry ignores an empty message and keeps multiline text", async () => {
		const count = (await prompts()).length;
		await openQuickEntry();
		const input = $("textarea");
		await input.setValue("   ");
		await browser.keys("Enter");
		await input.setValue("first line");
		await browser.keys(["Shift", "Enter"]);
		await browser.keys("second line");

		await expect(input).toHaveValue("first line\nsecond line");
		expect(await barVisible()).toBe(true);
		expect((await prompts()).length).toBe(count);
		// WebDriver's Element Clear blurs the field; Playwright's press focused it again.
		await input.clearValue();
		await input.click();
		await browser.keys("Escape");
		expect(await until(barVisible, visible => !visible)).toBe(false);
	});

	it("quick entry leaves a running task alone", async () => {
		await browser.switchToWindow(main);
		await $("textarea").setValue("fixture running");
		await $('button[aria-label="Send (Enter)"]').click();
		await expect($('button[aria-label="Abort"]')).toBeDisplayed();
		const counts = async () => ({
			steer: (await recorded(app.record, "steer")).length,
			followUp: (await recorded(app.record, "follow_up")).length,
			abort: (await recorded(app.record, "abort")).length,
		});
		const before = await counts();
		const count = (await prompts()).length;

		await openQuickEntry();
		await send("a separate question");

		expect(
			await until(
				async () => (await prompts()).length,
				length => length === count + 1,
			),
		).toBe(count + 1);
		expect(await counts()).toEqual(before);
	});

	it("quick entry sends a leading ! as text, never as a shell command", async () => {
		const before = await tabs();
		const counts = async () => ({
			bash: (await recorded(app.record, "bash")).length,
			prompt: (await prompts()).length,
		});
		const sent = await counts();
		await openQuickEntry();
		await send("!echo hi");

		expect(
			await until(
				async () => (await tabs()).length,
				length => length === before.length + 1,
			),
		).toBe(before.length + 1);
		// The composer has no shell mode: the text reaches the agent as a prompt.
		expect(
			await until(
				async () => (await prompts()).map(command => command.message),
				messages => messages.includes("!echo hi"),
			),
		).toContain("!echo hi");
		expect(await counts()).toEqual({ bash: sent.bash, prompt: sent.prompt + 1 });
	});

	it("the quick entry page has no app API", async () => {
		await openQuickEntry();
		expect(await browser.execute(() => typeof (window as unknown as { omp?: unknown }).omp)).toBe("undefined");
		expect(await browser.execute(() => typeof window.ompQuickEntry?.submit)).toBe("function");
		await $("textarea").click();
		await browser.keys("Escape");
	});

	it("Escape hides quick entry", async () => {
		await openQuickEntry();
		await $("textarea").click();
		await browser.keys("Escape");
		expect(await until(barVisible, visible => !visible)).toBe(false);
	});

	it("quick entry at the tab limit keeps the text and explains why", async () => {
		await browser.switchToWindow(main);
		await browser.execute(async () => {
			while (await window.omp.tabs.spawn({ kind: "chat" })) {}
		});
		await openQuickEntry();
		await send("one more");

		// Playwright's toContainText reads textContent; WebKitWebDriver's element text
		// comes back empty in the bar's webview even while the alert is displayed.
		await expect($('[role="alert"]')).toHaveElementProperty("textContent", "Parallel limit reached", {
			containing: true,
		});
		await expect($("textarea")).toHaveValue("one more");
		expect(await barVisible()).toBe(true);
	}).timeout(120_000);
});
