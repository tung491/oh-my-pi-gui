import * as fs from "node:fs/promises";
import { $, $$, browser, expect } from "@wdio/globals";
import { awaitBridge, collectPageErrors, launch, nextFrame, nodeOf, pageErrors, until, wheel } from "./session";

const SCROLL = ".omp-transcript-scroll";
const TABS = '[role="tablist"] [role="tab"]';
const SEND = 'button[aria-label="Send (Enter)"]';
const ABORT = 'button[aria-label="Abort"]';

const sidecarStatus = async () => (await browser.execute(() => window.omp.sidecar.getStatus())).status;

describe("runtime", () => {
	it("streaming with 50k history preserves the reading anchor, supports five tasks, and recovers a draft after restart", async () => {
		await launch({ name: "runtime", history: 50_000 });
		await awaitBridge(browser);
		await collectPageErrors(browser);

		await expect($("[data-transcript-kind]")).toBeDisplayed({ wait: 60_000 });
		const input = $("textarea");
		await input.setValue("fixture stream");
		await $(SEND).click();
		await expect($(ABORT)).toBeDisplayed();
		await wheel(SCROLL, -1500);
		await expect($('button[aria-label="Jump to latest"]')).toBeDisplayed();
		const readAnchor = async () =>
			browser.execute(
				node => {
					if (node.scrollHeight - node.scrollTop - node.clientHeight < 100) return null;
					const top = node.getBoundingClientRect().top;
					const row = Array.from(node.querySelectorAll("[data-transcript-kind]")).find(
						item => item.getBoundingClientRect().bottom > top + 4,
					);
					return row
						? { index: row.getAttribute("data-index"), offset: row.getBoundingClientRect().top - top }
						: null;
				},
				await nodeOf(SCROLL),
			);
		expect(await until(readAnchor, anchor => anchor !== null)).not.toBeNull();
		const anchor = await readAnchor();
		if (!anchor) throw new Error("No visible reading anchor");
		const progress = async () =>
			browser.execute(async () => {
				const response = await window.omp.rpc.bash("fixture:progress");
				return (response.data as { chunks: number }).chunks;
			});
		const before = await progress();
		await browser.execute(() => window.omp.rpc.bash("fixture:large-tool"));
		expect(await until(progress, chunks => chunks > before + 30)).toBeGreaterThan(before + 30);
		const after = await browser.execute(
			(node, index) => {
				const row = node.querySelector(`[data-index="${index}"]`);
				if (!row) throw new Error("Reading anchor left the viewport during streaming");
				return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
			},
			await nodeOf(SCROLL),
			anchor.index,
		);
		expect(Math.abs(after - anchor.offset)).toBeLessThan(4);
		const inputMs: number[] = [];
		await input.click();
		for (const character of "retained stream draft") {
			const started = performance.now();
			await browser.keys(character);
			await nextFrame(browser);
			inputMs.push(performance.now() - started);
		}
		await expect(input).toHaveValue("retained stream draft");
		for (let index = 1; index < 5; index++) {
			await browser.keys(["Control", "t"]);
			await expect($$(TABS)).toBeElementsArrayOfSize(index + 1);
			await expect($("[data-transcript-kind]")).toBeDisplayed();
		}
		// The Electron spec could record a CPU profile over Chromium's devtools
		// protocol; WebKit offers no such channel through WebDriver.
		const switchMs: number[] = [];
		for (let index = 0; index < 20; index++) {
			const started = performance.now();
			await $$(TABS)[index % 5].click();
			await expect(input).toBeEnabled();
			switchMs.push(performance.now() - started);
		}
		await $$(TABS)[0].click();
		await expect(input).toHaveValue("retained stream draft");
		await $(ABORT).click();
		await expect($(ABORT)).not.toBeExisting();
		await browser.execute(() => window.omp.sidecar.restart());
		expect(await until(sidecarStatus, status => status === "ready")).toBe("ready");
		await expect(input).toHaveValue("retained stream draft");
		await expect(input).toBeEnabled();
		const errors = await pageErrors(browser);
		await fs.writeFile(
			"test-results/runtime.json",
			JSON.stringify({ history: 50000, inputMs, switchMs, anchor, after, errors }, null, 2),
		);
		await browser.saveScreenshot("test-results/runtime-recovered.png");
		expect(errors).toEqual([]);
	}).timeout(180_000);

	it("an older real core reports unavailable capabilities and retains the editable draft", async function () {
		// Set a preserved pre-refactor sidecar path for the compatibility audit.
		const legacyCore = process.env.OMP_GUI_LEGACY_CORE;
		if (!legacyCore) this.skip();
		await launch({ name: "legacy", omp: legacyCore });
		await awaitBridge(browser);
		await collectPageErrors(browser);

		expect(await until(sidecarStatus, status => status === "ready", { timeout: 60_000 })).toBe("ready");
		const responses = await browser.execute(async () => ({
			state: await window.omp.rpc.getState(),
			git: await window.omp.rpc.getGitChanges(),
			share: await window.omp.rpc.previewShareSession(),
		}));
		expect(responses.state.success).toBe(true);
		expect(responses.git.success).toBe(false);
		expect(responses.share.success).toBe(false);
		if (await $('[role="dialog"]').isExisting()) {
			await browser.keys("Escape");
			await expect($$('[role="dialog"]')).toBeElementsArrayOfSize(0);
		}
		await $("textarea").setValue("/share");
		await $(SEND).click();
		const modal = $('[role="dialog"]');
		await expect(modal).toBeDisplayed();
		await expect(modal.$("aria/Refresh preview")).toBeDisplayed();
		await expect(modal.$("aria/Upload and create link")).not.toBeExisting();
		await browser.saveScreenshot("test-results/legacy-unavailable.png");
		await browser.keys("Escape");
		await $("textarea").setValue("legacy draft retained");
		await browser.execute(() => window.omp.sidecar.restart());
		expect(await until(sidecarStatus, status => status === "ready")).toBe("ready");
		await expect($("textarea")).toHaveValue("legacy draft retained");
		const errors = await pageErrors(browser);
		await fs.writeFile("test-results/legacy.json", JSON.stringify({ responses, errors }, null, 2));
		expect(errors).toEqual([]);
	});
});
