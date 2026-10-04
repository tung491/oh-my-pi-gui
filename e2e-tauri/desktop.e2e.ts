import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { $, $$, browser, expect } from "@wdio/globals";
import {
	awaitMainWindow,
	byRole,
	collectPageErrors,
	fill,
	type Launch,
	launch,
	nodeOf,
	pageErrorLog,
	ROOT,
	recorded,
	relaunch,
	textOf,
	until,
} from "./session";
import {
	barrierWaiters,
	callsTo,
	currentWindowId,
	emitToWindow,
	type HookWindow,
	listWindows,
	navigationProbe,
	releaseBarrier,
	setFault,
	setFaultWhen,
	setPageZoom,
} from "./test-hooks";

const DIALOG = '[role="dialog"]';
const TABS = '[role="tablist"] [role="tab"]';
const SEND = 'button[aria-label="Send (Enter)"]';
const ABORT = 'button[aria-label="Abort"]';
const SETTINGS_SEARCH = '[placeholder="Search settings and managed resources…"]';
const THEME_SEARCH = '[placeholder="Search themes…"]';
const TEXT = "textContent";
const containing = { containing: true } as const;

let app: Launch;
const pageLog = pageErrorLog(browser);
const errors = () => pageLog.all();
const reload = () => pageLog.reload();

async function command(text: string): Promise<void> {
	await fill($("textarea"), text);
	await $(SEND).click();
}

function rpc(type: string) {
	return recorded(app.record, type);
}

/** Playwright's `locator.press(key)`: focus the element, then press. */
async function press(selector: string, key: string | string[]): Promise<void> {
	await browser.execute((element: HTMLElement) => element.focus(), await nodeOf(selector));
	await browser.keys(key);
}

/** Whether the field takes input, as Playwright's `toBeEditable` checks it. */
function editable(selector: string): Promise<boolean> {
	return nodeOf(selector).then(node =>
		browser.execute(
			(field: HTMLElement) =>
				!(field as HTMLInputElement).disabled &&
				!(field as HTMLInputElement).readOnly &&
				field.getAttribute("aria-disabled") !== "true",
			node,
		),
	);
}

/** Pick a named theme through `/theme`, as a reader does. */
async function chooseTheme(label: string): Promise<void> {
	await command("/theme");
	await fill($(`${DIALOG} ${THEME_SEARCH}`), label);
	await $(`//*[@role="dialog"]//button[@aria-pressed][contains(normalize-space(.), "${label}")]`).click();
}

/** Run an assertion; when it fails, prefix its message with what was measured. */
function labelled(label: string, assertion: () => void): void {
	try {
		assertion();
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

interface ListenerAudit {
	__ompDocumentListeners?: () => number;
	/** Every registration the audit saw, so the evidence shows it was watching. */
	__ompDocumentListenerAdds?: () => number;
}

describe("desktop", () => {
	before(async () => {
		app = await launch({
			name: "desktop",
			prefs: { firstRunComplete: true },
			env: { OMP_GUI_TEST_STATS_BINARY: path.join(ROOT, "resources", "omp") },
		});
		await awaitMainWindow(browser);
		await collectPageErrors(browser);
		await browser.saveScreenshot("test-results/desktop-start.png");
	});

	after(async () => {
		if (app) await fs.copyFile(app.record, "test-results/desktop-rpc.jsonl").catch(() => {});
	});

	it("initially closed modal receives focus and Escape closes it", async () => {
		await command("/jobs");
		const modal = $(DIALOG);
		await expect(modal).toBeDisplayed();
		expect(
			await until(
				() =>
					browser.execute(
						() => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
					),
				focused => focused,
			),
		).toBe(true);
		await browser.keys("Escape");
		await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
	});

	it("opening sharing performs local preview only, upload needs a button click", async () => {
		await command("/share");
		const modal = $(DIALOG);
		const upload = await byRole("button", { name: "Upload and create link", within: DIALOG });
		await expect(upload).toBeDisplayed();
		expect(await rpc("share_session")).toHaveLength(0);
		await upload.click();
		await expect(modal).toHaveElementProperty(TEXT, "http://127.0.0.1/shared#local", containing);
		expect(await rpc("share_session")).toHaveLength(1);
		await browser.keys("Escape");
	});

	it("a running task keeps both send and stop reachable", async () => {
		await command("fixture running");
		await expect($(ABORT)).toBeDisplayed();
		const composer = $("textarea");
		await fill(composer, "queued instruction");
		await $(SEND).click();
		expect(
			await until(
				async () => (await rpc("steer")).length + (await rpc("follow_up")).length,
				count => count === 1,
			),
		).toBe(1);
		await $(ABORT).click();
		await expect(composer).toHaveValue("");
	});

	it("long approval remains complete and Enter is neutral", async () => {
		await command("fixture approval");
		const modal = $(DIALOG);
		await expect(modal.$("pre")).toHaveElementProperty(TEXT, "critical final argument", containing);
		expect(
			await until(
				() => browser.execute(() => document.activeElement?.textContent ?? null),
				focused => focused !== "Approve",
			),
		).not.toBe("Approve");
		await browser.keys("Escape");
		await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
		expect(await errors()).toEqual([]);
	});

	it("settings expose eight groups, translated search and independent display preferences", async () => {
		await (await byRole("button", { name: "Settings", exact: true })).click();
		const settings = $(DIALOG);
		await expect($$(`${DIALOG} .settings-nav-group-label`)).toBeElementsArrayOfSize(8);
		await (await byRole("button", { name: "Appearance & use", exact: true, within: DIALOG })).click();
		await expect(settings).toHaveElementProperty(TEXT, "Choose GUI theme", containing);
		await browser.saveScreenshot("test-results/01-settings.png");
		const search = $(`${DIALOG} ${SETTINGS_SEARCH}`);
		await fill(search, "Tự động nén");
		await expect(settings).toHaveElementProperty(TEXT, "Auto compaction", containing);
		await fill(search, "paste.largeMenuThreshold");
		await expect(settings).toHaveElementProperty(TEXT, "paste", containing);
		await browser.keys("Escape");
		await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
	});

	it("voice and side question require an explicit start", async () => {
		const voiceBefore = (await rpc("live_start")).length;
		await command("/live");
		await expect($(DIALOG)).toBeDisplayed();
		expect(await rpc("live_start")).toHaveLength(voiceBefore);
		await browser.saveScreenshot("test-results/02-voice.png");
		await browser.keys("Escape");
		const before = (await rpc("btw")).length;
		await command("/btw explain the current approach");
		await expect($(DIALOG)).toBeDisplayed();
		expect(await rpc("btw")).toHaveLength(before);
		await browser.keys("Escape");
	});

	it("Escape cancels a settings edit without saving its abandoned value", async () => {
		await (await byRole("button", { name: "Settings", exact: true })).click();
		await fill($(`${DIALOG} ${SETTINGS_SEARCH}`), "compaction.reserveTokens");
		await (
			await byRole("button", { name: "Reserve tokens compaction.reserveTokens", exact: true, within: DIALOG })
		).click();
		const input = $(`${DIALOG} input[type="number"]`);
		await expect(input).toHaveValue("8192");
		const before = (await rpc("set_setting")).length;
		await fill(input, "12345");
		await press(`${DIALOG} input[type="number"]`, "Escape");
		await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
		expect((await rpc("set_setting")).length).toBe(before);
		const response = await browser.execute(() => window.omp.rpc.getSettings(["compaction.reserveTokens"]));
		expect(response.data).toMatchObject({ values: { "compaction.reserveTokens": 8192 } });
	});

	it("math survives history reload and scrolls inside its column in both themes", async () => {
		await command("fixture math");
		const MARKDOWN = ".markdown-body:has(.katex-display)";
		await expect($$(`${MARKDOWN} .katex-display`)).toBeElementsArrayOfSize(4);
		await expect($(MARKDOWN)).toHaveElementProperty(TEXT, "只有统计口径相同时", containing);
		await reload();
		await expect($$(`${MARKDOWN} .katex-display`)).toBeElementsArrayOfSize(4);
		const formulasWith = (text: string) =>
			browser.execute(
				(selector: string, needle: string) =>
					Array.from(document.querySelectorAll(selector)).filter(node => node.textContent?.includes(needle))
						.length,
				`${MARKDOWN} .katex-html`,
				text,
			);
		expect(
			await until(
				() => formulasWith("显存有效带宽"),
				count => count === 1,
			),
		).toBe(1);
		await expect($$(`${MARKDOWN} :is(h1, h2, .katex-error)`)).toBeElementsArrayOfSize(0);
		const viewport = await browser.getWindowSize();
		for (const theme of ["VIF Navy", "VIF Light"]) {
			await chooseTheme(theme);
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
			await browser.setWindowSize(900, 1050);
			await $(MARKDOWN).scrollIntoView({ block: "nearest" });
			await browser.execute(() => document.fonts.ready.then(() => undefined));
			expect(await browser.execute(() => document.fonts.check("16px KaTeX_Main"))).toBe(true);
			const layout = await browser.execute(
				(element: HTMLElement) => {
					const displays = Array.from(element.querySelectorAll<HTMLElement>(".katex-display"));
					return {
						columnFits: element.scrollWidth <= element.clientWidth + 1,
						formulasFit: displays.every(node => node.getBoundingClientRect().width <= element.clientWidth + 1),
						canScroll: displays.some(node => node.scrollWidth > node.clientWidth),
						startsVisible: displays.every(node => {
							const formula = node.querySelector(".katex-html");
							return formula && formula.getBoundingClientRect().left >= node.getBoundingClientRect().left - 1;
						}),
					};
				},
				await nodeOf(MARKDOWN),
			);
			expect(layout).toEqual({ columnFits: true, formulasFit: true, canScroll: true, startsVisible: true });
			expect(
				await browser.execute((selector: string) => {
					const displays = document.querySelectorAll<HTMLElement>(selector);
					const node = displays[displays.length - 1];
					node.scrollLeft = node.scrollWidth;
					const moved = node.scrollLeft > 0;
					node.scrollLeft = 0;
					return moved;
				}, `${MARKDOWN} .katex-display`),
			).toBe(true);
			await browser.saveScreenshot(`test-results/math-${theme}.png`);
		}
		await browser.setWindowSize(viewport.width, viewport.height);
		expect(await errors()).toEqual([]);
	});

	it("all named themes apply with readable primary text and no stale scheme tokens", async () => {
		const labels = [
			"VIF Navy",
			"Slate",
			"Deep Sea",
			"Espresso",
			"Ember",
			"VIF Light",
			"Ivory",
			"Sand",
			"Rose Quartz",
			"Glacier",
			"Sage",
		];
		const colors: Record<string, string> = {};
		const contrastValues: Record<string, { body: number; send: number }> = {};
		for (const label of labels) {
			await chooseTheme(label);
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
			colors[label] = await browser.execute(() =>
				getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"),
			);
			await fill($("textarea"), "Theme contrast sample");
			const send = $(SEND);
			await expect(send).toBeEnabled();
			// Playwright's trial click: wait until the button could take the click, without clicking.
			await send.waitForClickable({ timeout: 1000 });
			await browser.execute(
				async (button: HTMLElement) => {
					await Promise.all(button.getAnimations().map(animation => animation.finished.catch(() => {})));
				},
				await nodeOf(SEND),
			);
			contrastValues[label] = await browser.execute(
				(button: HTMLElement) => {
					const luminance = (color: string) => {
						const match = color.match(/^rgb\(([\d.]+), ([\d.]+), ([\d.]+)\)$/);
						if (!match) throw new Error(`Expected an opaque computed RGB color, received ${color}`);
						const [r, g, b] = match.slice(1).map(value => {
							const channel = Number(value) / 255;
							return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
						});
						return 0.2126 * r + 0.7152 * g + 0.0722 * b;
					};
					const ratio = (element: Element) => {
						const style = getComputedStyle(element);
						const light = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
						return (light[1] + 0.05) / (light[0] + 0.05);
					};
					return { body: ratio(document.body), send: ratio(button) };
				},
				await nodeOf(SEND),
			);
			labelled(`${label} body text`, () => expect(contrastValues[label].body).toBeGreaterThanOrEqual(4.5));
			labelled(`${label} send icon`, () => expect(contrastValues[label].send).toBeGreaterThanOrEqual(4.5));
			await browser.saveScreenshot(`test-results/theme-${label.replaceAll(" ", "-")}.png`);
		}
		expect(new Set(Object.values(colors)).size).toBeGreaterThan(8);
		await fs.writeFile("test-results/theme-values.json", JSON.stringify(colors, null, 2));
		await fs.writeFile("test-results/theme-contrast.json", JSON.stringify(contrastValues, null, 2));
	}).timeout(90_000);

	it("the Sai ATLAS logo shows the tone its surface needs in every theme family", async () => {
		await command("Logo sample");
		const AVATAR = "[data-assistant-avatar]";
		await expect($$(AVATAR)).toBeElementsArrayOfSize({ gte: 1 });
		const avatars = await $$(AVATAR).length;
		await expect($$(AVATAR)[avatars - 1]).toBeDisplayed();
		// The tones of the logo images shown inside the last element the selector matches.
		const visibleTones = (selector: string) =>
			browser.execute((within: string) => {
				const matches = document.querySelectorAll(within);
				const element = matches[matches.length - 1];
				if (!element) return null;
				return Array.from(element.querySelectorAll("img"))
					.filter(img => getComputedStyle(img).display !== "none")
					.map(img => img.dataset.logoTone);
			}, selector);
		const LOCKUP = "aside .drag-region [data-logo-surface]";
		// VIF Light keeps a navy sidebar, Sand has a light one, Deep Sea is a legacy dark theme.
		for (const [theme, sidebarTone, pageTone] of [
			["VIF Navy", "dark", "dark"],
			["VIF Light", "dark", "light"],
			["Sand", "light", "light"],
			["Deep Sea", "dark", "dark"],
		] as const) {
			await chooseTheme(theme);
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
			const sidebar = await visibleTones(LOCKUP);
			const page = await visibleTones(AVATAR);
			labelled(`${theme} sidebar lockup`, () => expect(sidebar).toEqual([sidebarTone]));
			labelled(`${theme} assistant avatar`, () => expect(page).toEqual([pageTone]));
		}
	});

	it("uncertain delivery preserves the draft and blocks duplicate sending until reviewed", async () => {
		const before = (await rpc("prompt")).length;
		await command("fixture uncertain");
		const input = $("textarea");
		await expect(input).toHaveValue("fixture uncertain");
		await expect($(SEND)).toBeDisabled();
		await press("textarea", "Enter");
		expect(await rpc("prompt")).toHaveLength(before + 1);
		await (await byRole("button", { name: "I checked; allow sending", exact: true })).click();
		await expect($(SEND)).toBeEnabled();
		await fill(input, "");
	});

	it("collaboration permission events immediately gate the originating composer and restore editing", async () => {
		const input = $("textarea");
		await fill(input, "retained collaboration draft");
		await browser.execute(() => window.omp.rpc.bash("fixture:readonly"));
		expect(
			await until(
				() => editable("textarea"),
				can => !can,
			),
		).toBe(false);
		await expect($(SEND)).toBeDisabled();
		await expect(input).toHaveValue("retained collaboration draft");
		await browser.execute(() => window.omp.rpc.bash("fixture:writable"));
		expect(
			await until(
				() => editable("textarea"),
				can => can,
			),
		).toBe(true);
		await expect(input).toHaveValue("retained collaboration draft");
		await fill(input, "");
		expect(await errors()).toEqual([]);
	});

	it("security distinguishes unavailable, disabled, unscanned, running, failed and completed scans", async () => {
		const states = {
			disabled: "Security disabled",
			unscanned: "This project has not been scanned",
			unavailable: "Scan status unavailable",
			running: "Scan in progress",
			failed: "The selected scan failed",
			incomplete: "The selected scan did not complete",
			clear: "No findings in this scan",
			findings: "Untrusted path reaches file access",
		};
		for (const [state, expected] of Object.entries(states)) {
			await browser.execute((value: string) => window.omp.rpc.bash(`fixture:security:${value}`), state);
			await (await byRole("button", { name: "Settings", exact: true })).click();
			const modal = $(DIALOG);
			await (await byRole("button", { name: "Permissions & security", exact: true, within: DIALOG })).click();
			await expect(modal).toHaveElementProperty(TEXT, expected, containing);
			if (state !== "clear") expect(await textOf(modal)).not.toContain("No findings in this scan");
			await browser.saveScreenshot(`test-results/security-${state}.png`);
			await browser.keys("Escape");
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
		}
	}).timeout(90_000);

	it("repeated modal and task lifecycles release sidecars and document listeners", async () => {
		// Chromium counted the document's listeners over its devtools protocol, and
		// emulated reduced motion there; WebKit offers neither through WebDriver. So
		// the page tracks the document's listener registrations from here on: added
		// minus removed, each distinct listener counted once (the DOM ignores a
		// duplicate add and a remove of an unknown listener).
		await browser.execute(() => {
			const audit = window as unknown as ListenerAudit;
			if (audit.__ompDocumentListeners) return;
			type Entry = { type: string; listener: EventListenerOrEventListenerObject; capture: boolean };
			const live: Entry[] = [];
			const removedEarlier: Entry[] = [];
			let adds = 0;
			const captureOf = (options?: boolean | EventListenerOptions) =>
				typeof options === "boolean" ? options : Boolean(options?.capture);
			const indexIn = (
				list: Entry[],
				type: string,
				listener: EventListenerOrEventListenerObject,
				capture: boolean,
			) => list.findIndex(entry => entry.type === type && entry.listener === listener && entry.capture === capture);
			const add = document.addEventListener.bind(document);
			const remove = document.removeEventListener.bind(document);
			document.addEventListener = (
				type: string,
				listener: EventListenerOrEventListenerObject | null,
				options?: boolean | AddEventListenerOptions,
			) => {
				if (!listener) return;
				add(type, listener, options);
				const capture = captureOf(options);
				adds++;
				if (indexIn(live, type, listener, capture) >= 0) return;
				const settings = typeof options === "object" ? options : undefined;
				if (settings?.signal?.aborted) return;
				const entry = { type, listener, capture };
				live.push(entry);
				const drop = () => {
					const index = live.indexOf(entry);
					if (index >= 0) live.splice(index, 1);
				};
				if (settings?.once) add(type, drop, { once: true, capture });
				settings?.signal?.addEventListener("abort", drop, { once: true });
			};
			document.removeEventListener = (
				type: string,
				listener: EventListenerOrEventListenerObject | null,
				options?: boolean | EventListenerOptions,
			) => {
				if (!listener) return;
				remove(type, listener, options);
				const capture = captureOf(options);
				const index = indexIn(live, type, listener, capture);
				if (index >= 0) live.splice(index, 1);
				else if (indexIn(removedEarlier, type, listener, capture) < 0)
					removedEarlier.push({ type, listener, capture });
			};
			audit.__ompDocumentListeners = () => live.length - removedEarlier.length;
			audit.__ompDocumentListenerAdds = () => adds;
		});
		const listeners = () =>
			browser.execute(() => (window as unknown as ListenerAudit).__ompDocumentListeners?.() ?? Number.NaN);
		const before = await listeners();
		for (let index = 0; index < 100; index++) {
			await command("/jobs");
			await expect($(DIALOG)).toBeDisplayed();
			await browser.keys("Escape");
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
			await browser.keys(["Control", "t"]);
			await expect($$(TABS)).toBeElementsArrayOfSize(2);
			await expect($$(TABS)[1].$('[role="img"][aria-label="Ready"]')).toBeDisplayed();
			await (await byRole("button", { name: "Close tab", exact: true })).click();
			await expect($$(TABS)).toBeElementsArrayOfSize(1);
		}
		const after = await listeners();
		expect(after).toBeLessThanOrEqual(before);
		expect(await browser.execute(() => window.omp.tabs.list())).toHaveLength(1);
		await fs.writeFile(
			"test-results/lifecycle.json",
			JSON.stringify(
				{
					modalCycles: 100,
					taskCycles: 100,
					documentListenersBefore: before,
					documentListenersAfter: after,
					documentListenerRegistrationsSeen: await browser.execute(
						() => (window as unknown as ListenerAudit).__ompDocumentListenerAdds?.() ?? 0,
					),
					tabsAfter: 1,
				},
				null,
				2,
			),
		);
		expect(await errors()).toEqual([]);
	}).timeout(360_000);

	it("narrow windows and 200 percent zoom keep settings and primary actions reachable", async () => {
		for (const [width, height, zoom] of [
			[1280, 800, 1],
			[1000, 700, 1],
			[1280, 900, 2],
		]) {
			await browser.setWindowSize(width, height);
			await setPageZoom(browser, zoom);
			await (await byRole("button", { name: "Settings", exact: true })).click();
			await (await byRole("button", { name: "Appearance & use", exact: true, within: DIALOG })).click();
			const toggle = await byRole("switch", { name: "Compact conversation spacing", exact: true, within: DIALOG });
			await toggle.scrollIntoView({ block: "nearest" });
			await toggle.click();
			await browser.saveScreenshot(`test-results/layout-${width}-${zoom}.png`);
			await browser.keys("Escape");
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
			const input = $("textarea");
			await fill(input, "layout draft");
			expect(await editable("textarea")).toBe(true);
			await expect($(SEND)).toBeDisplayedInViewport();
			expect(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await fill(input, "");
		}
		await setPageZoom(browser, 1);
		await browser.setWindowSize(1400, 900);
	}).timeout(90_000);

	it("model benchmark, collaboration, tools and debug open without external mutations", async () => {
		for (const name of ["benchmark", "collab", "tools", "debug", "import"]) {
			await command(`/${name}`);
			const modal = $(DIALOG);
			await expect(modal).toBeDisplayed();
			expect(
				await until(
					() =>
						browser.execute(
							() => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
						),
					focused => focused,
				),
			).toBe(true);
			await browser.saveScreenshot(`test-results/03-${name}.png`);
			await browser.keys("Escape");
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
		}
		expect(await rpc("collab_join")).toHaveLength(0);
		expect(await errors()).toEqual([]);
	});

	it("settings search opens advanced controls and old refreshes cannot undo a saved edit", async () => {
		await (await byRole("button", { name: "Settings", exact: true })).click();
		const search = $(`${DIALOG} ${SETTINGS_SEARCH}`);
		await fill(search, "proxyUrl");
		await (await byRole("button", { name: /^HTTP proxy/, within: DIALOG })).click();
		expect(
			await until(
				() => editable("#setting-gui-proxy input"),
				can => can,
			),
		).toBe(true);
		await fill(search, "launchProfiles");
		await (await byRole("button", { name: /^Launch profile/, within: DIALOG })).click();
		const promptField = `${DIALOG} [placeholder="Leave empty to use the default system prompt"]`;
		expect(
			await until(
				() => editable(promptField),
				can => can,
			),
		).toBe(true);
		await fill(search, "compaction.reserveTokens");
		await (
			await byRole("button", { name: "Reserve tokens compaction.reserveTokens", exact: true, within: DIALOG })
		).click();
		const NUMBER = `${DIALOG} input[type="number"]`;
		const input = $(NUMBER);
		await expect(input).toHaveValue("8192");
		await browser.execute(() => window.omp.rpc.prompt("fixture hold settings"));
		const before = (await rpc("get_settings")).length;
		// Main forwards every tab-scoped event wrapped in the tab's envelope, so the
		// simulated config_update has to wear the same wire shape.
		const activeTabId = await browser.execute(() =>
			window.omp.tabs.list().then(tabs => tabs.find(tab => tab.active === true)?.tabId ?? ""),
		);
		expect(activeTabId).toBeTruthy();
		await emitToWindow(browser, await currentWindowId(browser), "config:update", { tabId: activeTabId, payload: {} });
		expect(
			await until(
				async () => (await rpc("get_settings")).length,
				count => count > before,
			),
		).toBeGreaterThan(before);
		await fill(input, "12345");
		await press(NUMBER, "Enter");
		const saved = { success: true, data: { values: { "compaction.reserveTokens": 12345 } } };
		const readSetting = async () =>
			await browser.execute(() => window.omp.rpc.getSettings(["compaction.reserveTokens"]));
		expect(
			await until(readSetting, response => {
				const values = (response.data as { values?: Record<string, unknown> } | undefined)?.values;
				return response.success === true && values?.["compaction.reserveTokens"] === 12345;
			}),
		).toMatchObject(saved);
		await browser.execute(() => window.omp.rpc.prompt("fixture release settings"));
		await browser.execute(() => window.omp.rpc.getState());
		await expect(input).toHaveValue("12345");
		await fill(input, "8192");
		await press(NUMBER, "Enter");
		await browser.keys("Escape");
	});

	it("a failing ipc handler cannot take the other handlers on its channel down with it", async () => {
		// One subscriber throwing during an emit used to abort the rest, so an
		// unrelated feature (a settings refresh, a transcript batch) silently stopped
		// receiving its own events.
		type Boom = { hits: number; stop?: () => void };
		const scratch = () => browser.execute(() => (globalThis as unknown as { __boom?: Boom }).__boom?.hits);
		await browser.execute(() => {
			const boom: Boom = { hits: 0 };
			(globalThis as unknown as { __boom: Boom }).__boom = boom;
			const throwing = window.omp.events.onConfigUpdate(() => {
				throw new Error("simulated handler failure");
			});
			const counting = window.omp.events.onConfigUpdate(() => {
				boom.hits += 1;
			});
			boom.stop = () => {
				throwing();
				counting();
			};
		});
		const activeTabId = await browser.execute(() =>
			window.omp.tabs.list().then(tabs => tabs.find(tab => tab.active === true)?.tabId ?? ""),
		);
		expect(activeTabId).toBeTruthy();
		await emitToWindow(browser, await currentWindowId(browser), "config:update", { tabId: activeTabId, payload: {} });
		expect(await until(scratch, hits => hits === 1)).toBe(1);
		await browser.execute(() => (globalThis as unknown as { __boom?: Boom }).__boom?.stop?.());
	});

	it("workspace navigation cannot replace the trusted desktop with an untrusted document", async () => {
		const documentPath = path.join(app.dir, "untrusted.html");
		await fs.writeFile(documentPath, "<!doctype html><title>Untrusted document</title><h1>Untrusted document</h1>");
		const untrustedUrl = pathToFileURL(documentPath).href;
		const trustedUrl = await browser.getUrl();
		// The shell's navigation lock is the twin of Electron's will-navigate guard: it
		// must refuse the URL. WebKit itself already refuses a file: load from the app
		// scheme, so the click below never reaches the lock; the page must survive it.
		const probe = await navigationProbe(browser, untrustedUrl);
		expect(probe.navigation).toBe(false);
		await browser.execute((url: string) => {
			const link = document.createElement("a");
			link.href = url;
			link.textContent = "Untrusted document";
			document.body.append(link);
			link.click();
			link.remove();
		}, untrustedUrl);
		expect(await browser.execute(() => document.querySelector("textarea")?.disabled)).toBe(false);
		expect(await browser.getUrl()).toBe(trustedUrl);
		await reload();
		expect(
			await until(
				() => editable("textarea"),
				can => can,
			),
		).toBe(true);
	});

	it("launch profile updates preserve concurrent fields and workspaces through the real preferences store", async () => {
		// WebKitWebDriver serializes an undefined property as null; JSON drops it as
		// Electron's structured clone did, so `cleared` reads back as undefined.
		const serialized = await browser.execute(async () => {
			const status = await window.omp.sidecar.getStatus();
			const cwd = status.cwd;
			const other = `${cwd}/other.workspace`;
			await Promise.all([
				window.omp.prefs.updateLaunchProfile(cwd, { noRules: true }),
				window.omp.prefs.updateLaunchProfile(cwd, { noLsp: true }),
				window.omp.prefs.updateLaunchProfile(other, { profile: " isolated " }),
			]);
			const saved = (await window.omp.prefs.get("launchProfiles")) as Record<string, unknown>;
			await window.omp.prefs.updateLaunchProfile(cwd, { noRules: false, noLsp: false });
			const cleared = (await window.omp.prefs.get("launchProfiles")) as Record<string, unknown>;
			return JSON.stringify({
				saved: saved[cwd],
				other: saved[other],
				cleared: cleared[cwd],
				preserved: cleared[other],
			});
		});
		const result: unknown = JSON.parse(serialized);
		expect(result).toEqual({
			saved: { noRules: true, noLsp: true },
			other: { profile: "isolated" },
			cleared: undefined,
			preserved: { profile: "isolated" },
		});
	});

	it("failed preference writes retain edits and never allow a premature restart", async () => {
		// Electron replaced the handlers in the main process; the shell scripts the
		// same refusals per channel through its fault hooks, one rule per step.
		const PROXY = "http://127.0.0.1:7899";
		const restartsBefore = await callsTo(browser, "sidecar:restart");
		await setFault(browser, "sidecar:restart", { error: "audit restart refused" });
		await setFaultWhen(
			browser,
			"prefs:set",
			{ key: "proxyUrl", value: PROXY },
			{ barrier: "proxy-save", error: "audit disk write refused" },
		);
		await setFault(browser, "prefs:update-launch-profile", {
			barrier: "launch-save",
			error: "audit launch write refused",
		});
		await (await byRole("button", { name: "Settings", exact: true })).click();
		await (await byRole("button", { name: "System & advanced", exact: true, within: DIALOG })).click();
		await $(`//*[@role="dialog"]//*[contains(@class, "settings-nav-item")][normalize-space(.)="Advanced"]`).click();
		const PROXY_INPUT = "#setting-gui-proxy input";
		const proxy = $(PROXY_INPUT);
		await fill(proxy, PROXY);
		await press(PROXY_INPUT, "Enter");
		expect(
			await until(
				() => barrierWaiters(browser, "proxy-save"),
				held => held === 1,
			),
		).toBe(1);
		await browser.execute(() => window.omp.prefs.get("proxyUrl"));
		expect(await callsTo(browser, "sidecar:restart")).toBe(restartsBefore);
		await releaseBarrier(browser, "proxy-save");
		await expect($('[role="alert"]')).toHaveElementProperty(TEXT, "audit disk write refused", containing);
		await expect(proxy).toHaveValue(PROXY);
		expect(await callsTo(browser, "sidecar:restart")).toBe(restartsBefore);
		const PROMPT = `${DIALOG} [placeholder="Leave empty to use the default system prompt"]`;
		const prompt = $(PROMPT);
		await fill(prompt, "Preserve this unsaved instruction.");
		await press(PROMPT, "Tab");
		expect(
			await until(
				() => barrierWaiters(browser, "launch-save"),
				held => held === 1,
			),
		).toBe(1);
		const restart = await byRole("button", { name: "Restart now", exact: true, within: DIALOG });
		await expect(restart).toBeDisabled();
		await releaseBarrier(browser, "launch-save");
		const alertWith = (text: string) => $(`//*[@role="alert"][contains(., "${text}")]`);
		await expect(alertWith("audit launch write refused")).toBeDisplayed();
		await expect(prompt).toHaveValue("Preserve this unsaved instruction.");
		expect(await editable(PROMPT)).toBe(true);
		await expect(restart).toBeDisabled();
		expect(await callsTo(browser, "sidecar:restart")).toBe(restartsBefore);
		await fill($(`${DIALOG} ${SETTINGS_SEARCH}`), "codeLineNumbers");
		await (await byRole("button", { name: /^Line numbers/, within: DIALOG })).click();
		const lineNumbers = $('#setting-gui-lineNumbers [role="switch"]');
		const checked = await lineNumbers.getAttribute("aria-checked");
		await setFaultWhen(
			browser,
			"prefs:set",
			{ key: "codeLineNumbers", value: checked !== "true" },
			{ error: "audit appearance write refused" },
		);
		await lineNumbers.click();
		await expect(alertWith("audit appearance write refused")).toBeDisplayed();
		await expect(lineNumbers).toHaveAttribute("aria-checked", checked ?? "false");
		await browser.keys("Escape");
		await setFaultWhen(
			browser,
			"prefs:set",
			{ key: "themeName", value: "light" },
			{ error: "audit appearance write refused" },
		);
		await (await byRole("button", { name: "Choose theme", exact: true })).click();
		await fill($(`${DIALOG} ${THEME_SEARCH}`), "VIF Light");
		await $(`//*[@role="dialog"]//button[@aria-pressed][contains(normalize-space(.), "VIF Light")]`).click();
		await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
		await expect(alertWith("audit appearance write refused")).toBeDisplayed();
		expect(await errors()).toEqual([]);
	});
});

describe("window geometry", () => {
	it("a restored window opens at its saved footprint and a restart leaves the saved state unchanged", async () => {
		// The saved outer footprint, as Electron's `getBounds()` wrote it. A
		// window corrected against a size cache that still held its position
		// came back as 2*1300-40 by 2*850-30 and saved that.
		const saved = { width: 1300, height: 850, x: 40, y: 30, isMaximized: false };
		const sameSize = (bounds: HookWindow["bounds"]) =>
			bounds?.width === saved.width && bounds?.height === saved.height;
		const geometry = await launch({
			name: "window-geometry",
			prefs: { firstRunComplete: true },
			setup: prepared =>
				fs.writeFile(path.join(prepared.desktop, "window-state.json"), JSON.stringify({ windowState: saved })),
		});
		const stateFile = path.join(geometry.desktop, "window-state.json");
		const mainBounds = async () =>
			(await listWindows(browser)).find(window => window.kind === "main")?.bounds ?? null;
		const savedState = async () => JSON.parse(await fs.readFile(stateFile, "utf8")).windowState;

		await awaitMainWindow(browser);
		expect(await until(mainBounds, sameSize)).toMatchObject({ width: saved.width, height: saved.height });
		// Moves and resizes are written after a 500 ms debounce; give any write time to land.
		await browser.pause(1_500);
		expect(await savedState()).toEqual(saved);

		await relaunch(geometry);
		await awaitMainWindow(browser);
		expect(await until(mainBounds, sameSize)).toMatchObject({ width: saved.width, height: saved.height });
		await browser.pause(1_500);
		expect(await savedState()).toEqual(saved);
	});
});
