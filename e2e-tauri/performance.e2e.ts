import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { awaitBridge, collectPageErrors, launch, nextFrame, pageErrors, ROOT } from "./session";

const TABS = '[role="tablist"] [role="tab"]';

/** A checkout's e2e-hooks debug binary, for comparing a baseline build. */
const binaryOf = (root: string) => path.join(root, "src-tauri", "target", "debug", "sai-atlas");

describe("performance", () => {
	it("bounded history rendering and input responsiveness across 5k, 20k and 50k messages", async function () {
		// Explicit local performance audit.
		if (process.env.OMP_GUI_PERFORMANCE !== "1") this.skip();
		const results: object[] = [];
		const roots = [
			{ name: "candidate", root: ROOT },
			...(process.env.OMP_GUI_BASELINE_DIR ? [{ name: "baseline", root: process.env.OMP_GUI_BASELINE_DIR }] : []),
		];
		for (const count of [5_000, 20_000, 50_000])
			for (let run = 0; run < 3; run++)
				for (const subject of run % 2 ? [...roots].reverse() : roots) {
					const started = performance.now();
					await launch({
						name: `perf-${subject.name}-${count}`,
						history: count,
						prefs: { firstRunComplete: true },
						binary: binaryOf(subject.root),
					});
					await awaitBridge(browser);
					await collectPageErrors(browser);
					await expect($("[data-transcript-kind]")).toBeDisplayed({ wait: 60_000 });
					const startupMs = performance.now() - started;
					const mountedRows = (await $$("[data-transcript-kind]")).length;
					expect(mountedRows).toBeLessThan(150);
					const input = $("textarea");
					await input.click();
					const inputMs: number[] = [];
					for (const character of "abcdefghijklmnopqrst") {
						const before = performance.now();
						await browser.keys(character);
						await nextFrame(browser);
						inputMs.push(performance.now() - before);
					}
					await expect(input).toHaveValue("abcdefghijklmnopqrst");
					const switchMs: number[] = [];
					if (count === 5000 && run === 0) {
						await input.setValue("fixture stream");
						await browser.keys("Enter");
						await expect($('button[aria-label="Abort"]')).toBeDisplayed();
						for (let index = 1; index < 5; index++) {
							await browser.keys(["Control", "t"]);
							await expect($$(TABS)).toBeElementsArrayOfSize(index + 1);
							await expect($("[data-transcript-kind]")).toBeDisplayed();
						}
						for (let index = 0; index < 20; index++) {
							const before = performance.now();
							await $$(TABS)[index % 5].click();
							await expect($("textarea")).toBeEnabled();
							await nextFrame(browser);
							switchMs.push(performance.now() - before);
						}
					}
					const errors = await pageErrors(browser);
					const item = { subject: subject.name, count, run, startupMs, mountedRows, inputMs, switchMs, errors };
					results.push(item);
					await fs.writeFile("test-results/performance.json", JSON.stringify(results, null, 2));
					expect(errors).toEqual([]);
				}
	}).timeout(900_000);
});
