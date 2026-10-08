/**
 * The file preview beside the chat, on WebKitGTK with the embedded assets and
 * the real CSP: every format renders for real (a host is marked rendered only
 * after its library drew), the drawer docks next to the chat, a tool's write
 * refreshes the preview while an outside edit waits for Reload, a document's
 * own styles stay inside its shadow root, and pdf.js loads its character maps
 * and fonts from the app.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { awaitBridge, collectPageErrors, exactTextCount, lastExactText, launch, pageErrors, until } from "./session";

const FIXTURES = path.resolve(import.meta.dirname, "../e2e/fixtures/document-preview");
const INSPECTOR = "aside.omp-inspector";
const SIDEBAR = "aside.omp-session-sidebar";
const BACK = 'button[aria-label="Back to files"]';
const TOAST_CLOSE = 'body > [aria-live="polite"] button[aria-label="Close"]';
const RENDER_TIMEOUT = 15_000;

interface CspSink {
	__csp?: string[];
}

/** A fresh app on a workspace holding every fixture, at 1440×900, with page errors collected. */
async function start() {
	const run = await launch({
		name: "document-preview",
		setup: async l => {
			for (const f of await fsp.readdir(FIXTURES)) {
				await fsp.copyFile(path.join(FIXTURES, f), path.join(l.project, f));
			}
		},
	});
	await awaitBridge(browser);
	await collectPageErrors(browser);
	await browser.setWindowSize(1440, 900);
	return run;
}

/** Records the directive of every CSP violation from now on. */
async function watchCsp(): Promise<void> {
	await browser.execute(() => {
		const sink = window as unknown as CspSink;
		sink.__csp = [];
		document.addEventListener("securitypolicyviolation", event => sink.__csp?.push(event.effectiveDirective));
	});
}

function cspViolations(): Promise<string[]> {
	return browser.execute(() => (window as unknown as CspSink).__csp ?? ["no CSP listener"]);
}

function previewState(): Promise<string | null> {
	return browser.execute(
		() => document.querySelector("[data-preview-state]")?.getAttribute("data-preview-state") ?? null,
	);
}

/**
 * Close every toast. The fixture sidecar's model is not a local one, so the
 * app warns about it at start; the warning sits over the drawer's header.
 */
async function dismissToasts(): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.execute((selector: string) => {
				const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
				for (const button of buttons) button.click();
				return document.querySelector('body > [aria-live="polite"]') === null;
			}, TOAST_CLOSE),
		{ timeout: 5_000, interval: 100, timeoutMsg: "the toasts did not close" },
	);
}

/** Back to the file list, when a preview is open. */
async function closePreview(): Promise<void> {
	await dismissToasts();
	const back = await $(BACK);
	if (await back.isExisting()) await back.click();
	await browser.waitUntil(async () => !(await $(BACK).isExisting()), { timeoutMsg: "the preview did not close" });
}

/** Open `name` from the workspace tree and wait for its read to finish. */
async function openFromTree(name: string): Promise<void> {
	if (!(await $(INSPECTOR).isDisplayed())) await $('button[title="Open workspace"]').click();
	await closePreview();
	await browser.waitUntil(async () => (await lastExactText(name, INSPECTOR)) !== null, {
		timeoutMsg: `${name} never appeared in the workspace tree`,
	});
	const item = await lastExactText(name, INSPECTOR);
	if (!item) throw new Error(`${name} is not in the workspace tree`);
	await dismissToasts();
	await item.click();
	await browser.waitUntil(async () => !["loading", null].includes(await previewState()), {
		timeout: RENDER_TIMEOUT,
		timeoutMsg: `${name} never left the loading state`,
	});
}

function shadowCount(host: string, selector: string): Promise<number> {
	return browser.execute(
		(h: string, sel: string) =>
			document.querySelector(`[data-preview-host="${h}"]`)?.shadowRoot?.querySelectorAll(sel).length ?? 0,
		host,
		selector,
	);
}

/** The host is marked rendered, and only counts once the preview itself is in its rich state. */
function rendered(host: string): Promise<boolean> {
	return browser.execute(
		(h: string) =>
			document.querySelector("[data-preview-state]")?.getAttribute("data-preview-state") === "rich" &&
			document.querySelector(`[data-preview-host="${h}"]`)?.getAttribute("data-rendered") === "true",
		host,
	);
}

/** Whether a `td` in the preview has exactly `text`. */
function cellShown(text: string): Promise<boolean> {
	return browser.execute(
		(wanted: string) =>
			Array.from(document.querySelectorAll("[data-preview-kind] td")).some(
				cell => cell.textContent?.trim() === wanted,
			),
		text,
	);
}

function sheetTabs(): Promise<string[]> {
	return browser.execute(() =>
		Array.from(document.querySelectorAll('[data-preview-kind] [role="tab"]')).map(
			tab => tab.textContent?.trim() ?? "",
		),
	);
}

function drawnCanvases(): Promise<number> {
	return browser.execute(
		() =>
			Array.from(document.querySelectorAll<HTMLCanvasElement>("[data-preview-kind] canvas")).filter(
				canvas => canvas.width > 0,
			).length,
	);
}

/** The body's children, the toast stack (a portal that comes and goes with toasts) aside. */
function bodyChildren(): Promise<number> {
	return browser.execute(
		() => Array.from(document.body.children).filter(child => !child.matches('[aria-live="polite"]')).length,
	);
}

describe("document preview", () => {
	it("previews office files, PDFs, sheets and images beside the chat", async () => {
		await start();
		await watchCsp();
		const bodyBefore = await bodyChildren();

		await openFromTree("report.docx");
		expect(
			await until(
				() => rendered("docx"),
				ok => ok,
				{ timeout: RENDER_TIMEOUT },
			),
		).toBe(true);
		expect(await shadowCount("docx", "section.docx")).toBeGreaterThanOrEqual(1);
		await closePreview();
		expect(await bodyChildren()).toBe(bodyBefore);

		await openFromTree("deck.pptx");
		expect(
			await until(
				() => rendered("pptx"),
				ok => ok,
				{ timeout: RENDER_TIMEOUT },
			),
		).toBe(true);
		expect(await shadowCount("pptx", "*")).toBeGreaterThan(1);
		await browser.pause(1000);
		expect(await previewState()).toBe("rich");
		await closePreview();
		expect(await bodyChildren()).toBe(bodyBefore);

		await openFromTree("table.xlsx");
		expect(
			await until(
				() => cellShown("Region"),
				ok => ok,
			),
		).toBe(true);
		expect(await cellShown("=SUM(B2:B4)")).toBe(true);
		const tabs = await sheetTabs();
		expect(tabs).toContain("Sales");
		expect(tabs).toContain("Notes");
		expect(tabs).not.toContain("Hidden");

		await openFromTree("table.csv");
		expect(
			await until(
				() => cellShown("North"),
				ok => ok,
			),
		).toBe(true);

		await openFromTree("one-page.pdf");
		expect(await until(drawnCanvases, n => n >= 1, { timeout: RENDER_TIMEOUT })).toBeGreaterThanOrEqual(1);

		await openFromTree("sixty-pages.pdf");
		expect(
			await until(
				() => exactTextCount("Pages not shown here: 10. Open the file to see them.", "[data-preview-kind]"),
				n => n >= 1,
				{ timeout: RENDER_TIMEOUT },
			),
		).toBeGreaterThanOrEqual(1);
		expect(await until(drawnCanvases, n => n >= 1, { timeout: RENDER_TIMEOUT })).toBeGreaterThanOrEqual(1);
		expect(await drawnCanvases()).toBeLessThan(10);

		await openFromTree("pixel.png");
		expect(
			await until(
				() =>
					browser.execute(
						() => document.querySelector<HTMLImageElement>('[data-preview-kind="image"] img')?.naturalWidth ?? 0,
					),
				width => width === 1,
			),
		).toBe(1);

		const layout = await browser.execute(() => {
			const aside = document.querySelector("aside.omp-inspector");
			const main = document.querySelector("main");
			const textarea = document.querySelector("textarea");
			if (!aside || !main || !textarea) return null;
			return {
				docked: getComputedStyle(aside).position !== "absolute",
				wide: aside.getBoundingClientRect().width >= 0.4 * innerWidth - 1,
				chatRoom: main.getBoundingClientRect().width >= 400,
				composerEnabled: textarea.disabled === false,
			};
		});
		expect(layout).toEqual({ docked: true, wide: true, chatRoom: true, composerEnabled: true });

		expect(await cspViolations()).toEqual([]);
		expect(await pageErrors(browser)).toEqual([]);
	}).timeout(180_000);

	it("keeps the preview docked in a narrow window and gives the sidebar back on close", async () => {
		await start();
		expect(await $(SIDEBAR).isExisting()).toBe(true);
		await openFromTree("table.csv");
		expect(
			await until(
				() => cellShown("North"),
				ok => ok,
			),
		).toBe(true);
		await browser.setWindowSize(900, 700);
		expect(
			await until(
				() => browser.execute(() => innerWidth),
				width => width <= 1000,
			),
		).toBeLessThanOrEqual(1000);

		const docked = await browser.execute(() => {
			const inspector = document.querySelector("aside.omp-inspector");
			if (!inspector) return null;
			return {
				position: getComputedStyle(inspector).position !== "absolute",
				halfWidth: Math.abs(inspector.getBoundingClientRect().width - Math.round(innerWidth * 0.5)) <= 1,
				composerEnabled: document.querySelector("textarea")?.disabled === false,
			};
		});
		expect(docked).toEqual({ position: true, halfWidth: true, composerEnabled: true });
		expect(await cellShown("North")).toBe(true);
		expect(
			await until(
				() => $(SIDEBAR).isExisting(),
				exists => !exists,
			),
		).toBe(false);

		await $(BACK).click();
		expect(
			await until(
				() => $(SIDEBAR).isExisting(),
				exists => exists,
			),
		).toBe(true);
		expect(await pageErrors(browser)).toEqual([]);
	}).timeout(120_000);

	it("shows a way out for a file that is not what its name says", async () => {
		await start();
		await watchCsp();
		await openFromTree("not-a-docx.docx");
		expect(await previewState()).toBe("error");
		expect(
			await exactTextCount(
				"This file could not be shown here. Use Open externally to see it.",
				"[data-preview-kind]",
			),
		).toBe(1);
		expect(
			await browser.execute(() =>
				Array.from(document.querySelectorAll("aside.omp-inspector button")).some(
					button => button.textContent?.trim() === "Open externally",
				),
			),
		).toBe(true);
		expect(await cspViolations()).toEqual([]);
		expect(await pageErrors(browser)).toEqual([]);
	}).timeout(120_000);

	it("refreshes the preview after a tool writes the file, after any rewrite on disk, and on Reload", async () => {
		const run = await start();
		await watchCsp();
		await openFromTree("table.csv");
		expect(
			await until(
				() => cellShown("North"),
				ok => ok,
			),
		).toBe(true);

		await browser.execute(() => window.omp.rpc.bash("fixture:write-table-csv"));
		expect(
			await until(
				() => exactTextCount("West", "[data-preview-kind]"),
				n => n >= 1,
				{ timeout: 6_000 },
			),
		).toBeGreaterThanOrEqual(1);

		// No tool event: the core's preview watch sees the rewrite and the preview follows.
		await fsp.writeFile(path.join(run.project, "table.csv"), "Region,Revenue\nEast,5\n");
		expect(
			await until(
				() => exactTextCount("East", "[data-preview-kind]"),
				n => n >= 1,
				{ timeout: 6_000 },
			),
		).toBeGreaterThanOrEqual(1);

		await fsp.writeFile(path.join(run.project, "table.csv"), "Region,Revenue\nSouth,6\n");
		await dismissToasts();
		await $('button[aria-label="Reload"]').click();
		expect(
			await until(
				() => exactTextCount("South", "[data-preview-kind]"),
				n => n >= 1,
				{ timeout: 6_000 },
			),
		).toBeGreaterThanOrEqual(1);
		expect(await cspViolations()).toEqual([]);
		expect(await pageErrors(browser)).toEqual([]);
	}).timeout(120_000);

	it("keeps a document's injected styles inside the preview", async () => {
		await start();
		await watchCsp();
		await openFromTree("injected-font.docx");
		expect(
			await until(
				() => rendered("docx"),
				ok => ok,
				{ timeout: RENDER_TIMEOUT },
			),
		).toBe(true);
		expect(
			await browser.execute(() =>
				Array.from(
					document.querySelector('[data-preview-host="docx"]')?.shadowRoot?.querySelectorAll("style") ?? [],
				).some(style => style.textContent?.includes(":host{position:fixed")),
			),
		).toBe(true);
		const contained = await browser.execute(() => {
			const host = document.querySelector("[data-preview-host]")?.getBoundingClientRect();
			const frame = document.querySelector("[data-preview-frame]")?.getBoundingClientRect();
			if (!host || !frame) return null;
			return {
				inside:
					host.left >= frame.left - 1 &&
					host.top >= frame.top - 1 &&
					host.right <= frame.right + 1 &&
					host.bottom <= frame.bottom + 1,
				cornerFree: !document.elementFromPoint(5, 5)?.closest("[data-preview-host]"),
			};
		});
		expect(contained).toEqual({ inside: true, cornerFree: true });
		expect(await cspViolations()).toEqual([]);
		expect(await pageErrors(browser)).toEqual([]);
	}).timeout(120_000);

	it("loads pdf.js character maps and fonts from the app", async () => {
		await start();
		await watchCsp();
		await openFromTree("cjk.pdf");
		expect(await until(drawnCanvases, n => n >= 1, { timeout: RENDER_TIMEOUT })).toBeGreaterThanOrEqual(1);
		// The loader pdf.js uses for URLs that are not http(s): XMLHttpRequest.
		const sizes = await browser.execute(() => {
			const get = (u: string) =>
				new Promise<number>(resolve => {
					const request = new XMLHttpRequest();
					request.open("GET", new URL(u, document.baseURI).href);
					request.responseType = "arraybuffer";
					request.onloadend = () =>
						resolve(
							request.status === 200 || request.status === 0
								? ((request.response as ArrayBuffer | null)?.byteLength ?? 0)
								: 0,
						);
					request.send();
				});
			return Promise.all([get("pdfjs/cmaps/UniJIS-UCS2-H.bcmap"), get("pdfjs/standard_fonts/FoxitSerif.pfb")]);
		});
		expect(sizes[0]).toBeGreaterThan(0);
		expect(sizes[1]).toBeGreaterThan(0);
		expect(await cspViolations()).toEqual([]);
		expect(await pageErrors(browser)).toEqual([]);
	}).timeout(120_000);
});
