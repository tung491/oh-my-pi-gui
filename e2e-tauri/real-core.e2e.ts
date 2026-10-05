/**
 * The real bundled sidecar (no fixture) behind the e2e-hooks build, with only
 * local operations: state, settings, a shell command, session switching, an
 * HTML export, the stats routes and the Vietnamese settings pages. Set
 * OMP_GUI_TEST_APP to an e2e-hooks release build to check the packaged
 * sidecar selection instead of `resources/omp`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { $, $$, browser, expect } from "@wdio/globals";
import { writeDesktopPrefs } from "../e2e/desktop-prefs";
import type { RpcResponse, RpcSessionState } from "../src/shared/rpc-types";
import {
	awaitBridge,
	byRole,
	collectPageErrors,
	exactTextCount,
	fill,
	launch,
	nodeOf,
	openOutsideBrowser,
	pageErrorLog,
	ROOT,
	textOf,
	until,
} from "./session";
import { barrierWaiters, releaseBarrier, runtimeFacts, setFault, setFaultWhen } from "./test-hooks";

const DIALOG = '[role="dialog"]';
const SEND = 'button[aria-label="Send (Enter)"]';
const TEXT = "textContent";
const containing = { containing: true } as const;
const MAIN_PROCESS_LOG = path.join(ROOT, "test-results", "main-process.log");

/** Run an assertion; when it fails, prefix its message with what was measured. */
function labelled(label: string, assertion: () => void): void {
	try {
		assertion();
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const sidecarStatus = async () => (await browser.execute(() => window.omp.sidecar.getStatus())).status;
const background = () =>
	browser.execute(() => getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"));

/** Pick a theme in the picker the given button opens (Vietnamese labels). */
async function chooseThemeVi(theme: string): Promise<void> {
	await (await byRole("button", { name: "Chọn giao diện", exact: true })).click();
	await byRole("dialog", { name: "Chọn giao diện", exact: true });
	await fill($(`${DIALOG} [placeholder="Tìm kiếm giao diện…"]`), theme);
	await $(`//*[@role="dialog"]//button[@aria-pressed][contains(normalize-space(.), "${theme}")]`).click();
}

describe("real core", () => {
	it("real bundled sidecar persists settings and sessions and serves every stats route", async () => {
		const executablePath = process.env.OMP_GUI_TEST_APP;
		await fs.rm(MAIN_PROCESS_LOG, { force: true });
		const app = await launch({
			name: "real-core",
			binary: executablePath,
			omp: executablePath ? null : path.join(ROOT, "resources", "omp"),
			env: { OMP_E2E_APP_LOG: MAIN_PROCESS_LOG },
			setup: async prepared => {
				await writeDesktopPrefs(prepared.desktop, {
					language: "en",
					launchProfiles: {
						[prepared.project]: { noExtensions: true, noSkills: true, noRules: true },
					},
				});
				await fs.writeFile(path.join(prepared.project, "README.md"), "# Local ARM audit\n");
			},
		});
		const pageLog = pageErrorLog(browser);
		await awaitBridge(browser);
		await collectPageErrors(browser);

		expect(await until(sidecarStatus, status => status === "ready", { timeout: 60_000 })).toBe("ready");
		const runtime = await runtimeFacts(browser);
		if (executablePath) {
			expect(runtime.debugBuild).toBe(false);
			expect(runtime.sidecar).not.toBeNull();
		}
		await fs.writeFile("test-results/runtime-selection.json", JSON.stringify(runtime, null, 2));
		const exportPath = path.join(app.dir, "audit-export.html");
		// Serialized in the page: WebDriver turns an undefined property into null.
		const evidence = JSON.parse(
			await browser.execute(async (target: string) => {
				const rpc = window.omp.rpc;
				const before = await rpc.getState();
				const settings = await rpc.getSettings();
				const schema = await rpc.getSettingsSchema();
				const changed = await rpc.setSetting("compaction.enabled", false);
				const effective = await rpc.getState();
				const changes = await rpc.getGitChanges();
				const jobs = await rpc.getJobs();
				const shell = await rpc.bash("printf 'arm audit ok'");
				const saved = await rpc.getState();
				const sessionPath = saved.success && (saved.data as RpcSessionState).sessionFile;
				if (!sessionPath) throw new Error("Local command did not persist a restorable session");
				const fresh = await rpc.newSession();
				const restored = await rpc.switchSession(sessionPath);
				const transcript = await rpc.getTranscript();
				const exported = await rpc.exportHtml(target);
				return JSON.stringify({
					before,
					settings,
					schema,
					changed,
					effective,
					changes,
					jobs,
					shell,
					saved,
					fresh,
					restored,
					transcript,
					exported,
				});
			}, exportPath),
		) as Record<string, RpcResponse>;
		for (const response of Object.values(evidence))
			labelled(JSON.stringify(response), () => expect(response.success).toBe(true));
		expect(evidence.changed.data).toMatchObject({ value: false });
		expect(evidence.effective.data).toMatchObject({ autoCompactionEnabled: false });
		expect(evidence.changes.data).toMatchObject({ isRepo: false });
		await fs.writeFile("test-results/real-core-contract.json", JSON.stringify(evidence, null, 2));
		expect(JSON.stringify(evidence.transcript.data)).toContain("arm audit ok");
		// The exported file opens in a browser outside the app, never in an app window.
		const outside = await openOutsideBrowser(pathToFileURL(exportPath).href);
		try {
			await expect(outside.page.$("#messages")).toHaveElementProperty(TEXT, "arm audit ok", containing);
			await outside.page.saveScreenshot("test-results/exported-session.png");
		} finally {
			await outside.close();
		}
		await browser.saveScreenshot("test-results/04-real-core.png");
		// The profile is seeded with a completed welcome, so the first-run screen stays closed.
		await expect($$(`${DIALOG}[aria-label="Set up your local assistant"]`)).toBeElementsArrayOfSize(0);
		await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
		const original = evidence.saved.data as RpcSessionState;
		await fill($("textarea"), "/new");
		await $(SEND).click();
		const sessionId = async () => {
			const state = await browser.execute(() => window.omp.rpc.getState());
			return state.success ? (state.data as RpcSessionState).sessionId : original.sessionId;
		};
		expect(await until(sessionId, id => id !== original.sessionId)).not.toBe(original.sessionId);
		await expect(
			$$('//*[contains(text(), "The originating session was replaced or closed.")]'),
		).toBeElementsArrayOfSize(0);
		await browser.execute(async (sessionPath: string) => {
			const result = await window.omp.rpc.switchSession(sessionPath);
			if (!result.success) throw new Error(result.error);
		}, original.sessionFile ?? "");
		await pageLog.reload();
		const transcriptShows = () =>
			browser.execute(() =>
				Array.from(document.querySelectorAll("[data-transcript-kind]")).some(row =>
					row.textContent?.includes("arm audit ok"),
				),
			);
		expect(await until(transcriptShows, shown => shown)).toBe(true);
		await (await byRole("button", { name: "Session stats", exact: true })).click();
		const stats = $(DIALOG);
		await expect(stats).toBeDisplayed();
		for (const label of [
			"Overview",
			"Models",
			"Providers",
			"Tools",
			"Costs",
			"Errors",
			"Behavior",
			"Gain",
			"Projects",
			"Requests",
		]) {
			await (await byRole("button", { name: label, exact: true, within: `${DIALOG} nav` })).click();
			expect(
				await until(
					() => exactTextCount("Loading stats…", DIALOG),
					count => count === 0,
					{
						timeout: 30_000,
					},
				),
			).toBe(0);
			expect(
				await until(
					() => textOf(stats),
					text => !text.includes("Stats unavailable"),
					{ timeout: 15_000 },
				),
			).not.toContain("Stats unavailable");
			await browser.saveScreenshot(`test-results/stats-${label}.png`);
		}
		await browser.keys("Escape");
		await browser.execute(async () => {
			await window.omp.prefs.set("language", "vi");
		});
		await pageLog.reload();
		await expect(await byRole("button", { name: "Cài đặt", exact: true })).toBeDisplayed();
		await (await byRole("button", { name: "Cài đặt", exact: true })).click();
		await expect($(DIALOG)).toHaveElementProperty(TEXT, "Quyền hạn & Bảo mật", containing);
		await expect($$(`${DIALOG} .settings-nav-group-label`)).toBeElementsArrayOfSize(8);
		const innerText = async (selector: string, index: number) =>
			browser.execute(
				(all: string, at: number) => (document.querySelectorAll<HTMLElement>(all)[at]?.innerText ?? "").trim(),
				selector,
				index,
			);
		const settingsPages: Array<{ group: string; page: string; text: string }> = [];
		for (let groupIndex = 0; groupIndex < 8; groupIndex++) {
			const GROUPS = `${DIALOG} .settings-nav-group-label`;
			const groupName = await innerText(GROUPS, groupIndex);
			await $$(GROUPS)[groupIndex].click();
			const PAGES = `${DIALOG} .settings-nav-item`;
			const count = await $$(PAGES).length;
			for (let pageIndex = 0; pageIndex < count; pageIndex++) {
				const pageName = await innerText(PAGES, pageIndex);
				await $$(PAGES)[pageIndex].click();
				expect(
					await until(
						() =>
							browser.execute(
								(spinners: string) => document.querySelectorAll(spinners).length,
								`${DIALOG} .settings-content .animate-spin`,
							),
						spinners => spinners === 0,
						{ timeout: 30_000 },
					),
				).toBe(0);
				const content = $(`${DIALOG} .settings-content`);
				const text = await textOf(content);
				expect(text).not.toContain("Something went wrong");
				expect(text).not.toContain("Typo Detection (macOS)");
				expect(text).not.toContain("Word Autocomplete (macOS)");
				expect(text).not.toContain("Autocorrect (macOS)");
				settingsPages.push({
					group: groupName,
					page: pageName,
					text: await innerText(`${DIALOG} .settings-content`, 0),
				});
				await browser.saveScreenshot(`test-results/settings-${groupIndex}-${pageIndex}.png`);
			}
		}
		await fs.writeFile("test-results/settings-pages.json", JSON.stringify(settingsPages, null, 2));
		await fill($(`${DIALOG} [placeholder="Tìm kiếm cài đặt và tài nguyên được quản lý…"]`), "bash.patterns");
		await (await byRole("button", { name: /Mẫu phê duyệt Bash bash.patterns/ })).click();
		const RULES = '//*[@title="bash.patterns"]/../..';
		const rulesText = $(`${RULES}//textarea`);
		const apply = () => $(`${RULES}//button[normalize-space(.)="Áp dụng"]`).click();
		await expect(rulesText).toHaveValue("[]");
		const rule = { match: "echo audit-blocked", approval: "deny" };
		await fill(rulesText, JSON.stringify([rule]));
		await apply();
		const patterns = async () => await browser.execute(() => window.omp.rpc.getSettings(["bash.patterns"]));
		const holds = (expected: unknown) => (response: RpcResponse) =>
			response.success &&
			JSON.stringify((response.data as { values?: Record<string, unknown> }).values?.["bash.patterns"]) ===
				JSON.stringify(expected);
		expect(await until(patterns, holds([rule]))).toMatchObject({
			success: true,
			data: { values: { "bash.patterns": [rule] } },
		});
		await fill(rulesText, "[]");
		await apply();
		expect(await until(patterns, holds([]))).toMatchObject({
			success: true,
			data: { values: { "bash.patterns": [] } },
		});
		await (await byRole("button", { name: "Giao diện & Trải nghiệm", exact: true, within: DIALOG })).click();
		await expect($(DIALOG)).toHaveElementProperty(TEXT, "Chọn chủ đề GUI", containing);
		await browser.saveScreenshot("test-results/05-packaged-vi.png");
		await browser.keys("Escape");
		const backgrounds: string[] = [];
		for (const theme of ["VIF Sáng", "VIF Hải quân"]) {
			await chooseThemeVi(theme);
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
			backgrounds.push(await background());
			await browser.saveScreenshot(`test-results/packaged-theme-${theme}.png`);
		}
		expect(backgrounds[0]).not.toBe(backgrounds[1]);
		// Delay the real IPC boot snapshot while the user makes a newer choice: the
		// unkeyed get is held at a barrier and then answers with this stale snapshot,
		// while keyed gets keep reading the live store.
		const bootPrefs = await browser.execute(async () => {
			await window.omp.prefs.set("fontSize", 18);
			return window.omp.prefs.get();
		});
		await setFaultWhen(browser, "prefs:get", {}, { barrier: "boot-prefs", value: bootPrefs });
		await pageLog.reload();
		expect(
			await until(
				() => barrierWaiters(browser, "boot-prefs"),
				held => held >= 1,
			),
		).toBeGreaterThanOrEqual(1);
		await expect(await byRole("button", { name: "Chọn giao diện", exact: true })).toBeDisplayed();
		await chooseThemeVi("VIF Sáng");
		await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
		const chosenBackground = await background();
		await (await byRole("button", { name: "Cài đặt", exact: true })).click();
		await (await byRole("button", { name: "Giao diện & Trải nghiệm", exact: true, within: DIALOG })).click();
		const FONT = '#setting-gui-fontSize input[type="number"]';
		const chosenFont = await $(FONT).getValue();
		const fontVariable = () =>
			browser.execute(() => document.documentElement.style.getPropertyValue("--gui-font-size"));
		for (const value of [String(Number(chosenFont) + 1), chosenFont]) {
			await fill($(FONT), value);
			await browser.execute((field: HTMLElement) => field.focus(), await nodeOf(FONT));
			await browser.keys("Enter");
			expect(await until(fontVariable, size => size === `${value}px`)).toBe(`${value}px`);
		}
		await browser.keys("Escape");
		await releaseBarrier(browser, "boot-prefs");
		await setFaultWhen(browser, "prefs:get", {}, { value: bootPrefs });
		await browser.execute(async () => {
			await window.omp.prefs.get();
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		});
		expect(await background()).toBe(chosenBackground);
		expect(await fontVariable()).toBe(`${chosenFont}px`);
		await setFault(browser, "prefs:get", null);
		expect(await pageLog.all()).toEqual([]);
	}).timeout(180_000);
});
