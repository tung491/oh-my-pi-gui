/**
 * The file preview beside the chat, on Chromium with the renderer loaded from
 * `file://`: every format renders for real (a host is marked rendered only
 * after its library drew), the drawer docks next to the chat, a tool's write
 * refreshes the preview while an outside edit waits for Reload, a document's
 * own styles stay inside its shadow root, and pdf.js loads its character maps
 * and fonts from the app.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { writeDesktopPrefs } from "./desktop-prefs";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/document-preview");
const INSPECTOR = "aside.omp-inspector";
const SIDEBAR = "aside.omp-session-sidebar";
const BACK = 'button[aria-label="Back to files"]';
const TOAST_CLOSE = 'body > [aria-live="polite"] button[aria-label="Close"]';
const RENDER_TIMEOUT = 15_000;

interface Session {
	app: ElectronApplication;
	page: Page;
	/** The workspace the window opened, holding a copy of every fixture. */
	project: string;
	/** Uncaught page errors since launch. */
	errors: string[];
}

interface CspSink {
	__csp?: string[];
}

/** Launch on a fresh profile whose workspace holds every fixture, at 1440×900; always closes the app. */
async function withApp(body: (session: Session) => Promise<void>): Promise<void> {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-document-preview-"));
	const desktop = path.join(profile, "desktop"),
		agent = path.join(profile, "agent"),
		project = path.join(profile, "project");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
	for (const file of await fs.readdir(FIXTURES)) {
		await fs.copyFile(path.join(FIXTURES, file), path.join(project, file));
	}
	await writeDesktopPrefs(desktop, { language: "en" });
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: path.resolve("e2e/sidecar-fixture.ts"),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.waitForFunction(() => window.omp?.rpc != null, undefined, { timeout: 30_000 });
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
		await body({ app, page, project, errors });
	} finally {
		// Test teardown bypasses the production quit confirmation.
		await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

/** Records the directive of every CSP violation from now on. */
async function watchCsp(page: Page): Promise<void> {
	await page.evaluate(() => {
		const sink = window as unknown as CspSink;
		sink.__csp = [];
		document.addEventListener("securitypolicyviolation", event => sink.__csp?.push(event.effectiveDirective));
	});
}

function cspViolations(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as unknown as CspSink).__csp ?? ["no CSP listener"]);
}

function previewState(page: Page): Promise<string | null> {
	return page.evaluate(
		() => document.querySelector("[data-preview-state]")?.getAttribute("data-preview-state") ?? null,
	);
}

/**
 * Close every toast. The fixture sidecar's model is not a local one, so the
 * app warns about it at start; the warning sits over the drawer's header.
 */
async function dismissToasts(page: Page): Promise<void> {
	await page.waitForFunction(
		selector => {
			const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
			for (const button of buttons) button.click();
			return document.querySelector('body > [aria-live="polite"]') === null;
		},
		TOAST_CLOSE,
		{ timeout: 5_000, polling: 100 },
	);
}

/** Back to the file list, when a preview is open. */
async function closePreview(page: Page): Promise<void> {
	await dismissToasts(page);
	const back = page.locator(BACK);
	if ((await back.count()) > 0) await back.click();
	await back.waitFor({ state: "detached" });
}

/** Open `name` from the workspace tree and wait for its read to finish. */
async function openFromTree(page: Page, name: string): Promise<void> {
	if (!(await page.locator(INSPECTOR).isVisible())) await page.locator('button[title="Open workspace"]').click();
	await closePreview(page);
	const item = page.locator(`${INSPECTOR} [role="treeitem"]`).getByText(name, { exact: true }).last();
	await item.waitFor();
	await dismissToasts(page);
	await item.click();
	await page.waitForFunction(
		() => {
			const state = document.querySelector("[data-preview-state]")?.getAttribute("data-preview-state");
			return state !== undefined && state !== null && state !== "loading";
		},
		undefined,
		{ timeout: RENDER_TIMEOUT },
	);
}

function shadowCount(page: Page, host: string, selector: string): Promise<number> {
	return page.evaluate(
		([h, sel]) => document.querySelector(`[data-preview-host="${h}"]`)?.shadowRoot?.querySelectorAll(sel).length ?? 0,
		[host, selector] as const,
	);
}

/** The host is marked rendered, and only counts once the preview itself is in its rich state. */
function rendered(page: Page, host: string): Promise<boolean> {
	return page.evaluate(
		h =>
			document.querySelector("[data-preview-state]")?.getAttribute("data-preview-state") === "rich" &&
			document.querySelector(`[data-preview-host="${h}"]`)?.getAttribute("data-rendered") === "true",
		host,
	);
}

/** Whether a `td` in the preview has exactly `text`. */
function cellShown(page: Page, text: string): Promise<boolean> {
	return page.evaluate(
		wanted =>
			Array.from(document.querySelectorAll("[data-preview-kind] td")).some(
				cell => cell.textContent?.trim() === wanted,
			),
		text,
	);
}

function sheetTabs(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll('[data-preview-kind] [role="tab"]')).map(
			tab => tab.textContent?.trim() ?? "",
		),
	);
}

function drawnCanvases(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			Array.from(document.querySelectorAll<HTMLCanvasElement>("[data-preview-kind] canvas")).filter(
				canvas => canvas.width > 0,
			).length,
	);
}

/** Playwright's `getByText(text, { exact: true })` count inside the preview. */
function previewTextCount(page: Page, text: string): Promise<number> {
	return page.locator("[data-preview-kind]").getByText(text, { exact: true }).count();
}

/** The body's children, the toast stack (a portal that comes and goes with toasts) aside. */
function bodyChildren(page: Page): Promise<number> {
	return page.evaluate(
		() => Array.from(document.body.children).filter(child => !child.matches('[aria-live="polite"]')).length,
	);
}

test.describe("document preview", () => {
	test("previews office files, PDFs, sheets and images beside the chat", async () => {
		test.setTimeout(180_000);
		await withApp(async ({ page, errors }) => {
			await watchCsp(page);
			const bodyBefore = await bodyChildren(page);

			await openFromTree(page, "report.docx");
			await expect.poll(() => rendered(page, "docx"), { timeout: RENDER_TIMEOUT }).toBe(true);
			expect(await shadowCount(page, "docx", "section.docx")).toBeGreaterThanOrEqual(1);
			await closePreview(page);
			expect(await bodyChildren(page)).toBe(bodyBefore);

			await openFromTree(page, "deck.pptx");
			await expect.poll(() => rendered(page, "pptx"), { timeout: RENDER_TIMEOUT }).toBe(true);
			expect(await shadowCount(page, "pptx", "*")).toBeGreaterThan(1);
			await page.waitForTimeout(1000);
			expect(await previewState(page)).toBe("rich");
			await closePreview(page);
			expect(await bodyChildren(page)).toBe(bodyBefore);

			await openFromTree(page, "table.xlsx");
			await expect.poll(() => cellShown(page, "Region")).toBe(true);
			expect(await cellShown(page, "=SUM(B2:B4)")).toBe(true);
			const tabs = await sheetTabs(page);
			expect(tabs).toContain("Sales");
			expect(tabs).toContain("Notes");
			expect(tabs).not.toContain("Hidden");

			await openFromTree(page, "table.csv");
			await expect.poll(() => cellShown(page, "North")).toBe(true);

			await openFromTree(page, "one-page.pdf");
			await expect.poll(() => drawnCanvases(page), { timeout: RENDER_TIMEOUT }).toBeGreaterThanOrEqual(1);

			await openFromTree(page, "sixty-pages.pdf");
			const notShown = () => previewTextCount(page, "Pages not shown here: 10. Open the file to see them.");
			await expect.poll(notShown, { timeout: RENDER_TIMEOUT }).toBeGreaterThanOrEqual(1);
			await expect.poll(() => drawnCanvases(page), { timeout: RENDER_TIMEOUT }).toBeGreaterThanOrEqual(1);
			expect(await drawnCanvases(page)).toBeLessThan(10);

			await openFromTree(page, "pixel.png");
			const imageWidth = () =>
				page.evaluate(
					() => document.querySelector<HTMLImageElement>('[data-preview-kind="image"] img')?.naturalWidth ?? 0,
				);
			await expect.poll(imageWidth).toBe(1);

			const layout = await page.evaluate(() => {
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

			expect(await cspViolations(page)).toEqual([]);
			expect(errors).toEqual([]);
		});
	});

	test("keeps the preview docked in a narrow window and gives the sidebar back on close", async () => {
		test.setTimeout(120_000);
		await withApp(async ({ app, page, errors }) => {
			expect(await page.locator(SIDEBAR).count()).toBe(1);
			await openFromTree(page, "table.csv");
			await expect.poll(() => cellShown(page, "North")).toBe(true);
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
			await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(1000);

			const docked = await page.evaluate(() => {
				const inspector = document.querySelector("aside.omp-inspector");
				if (!inspector) return null;
				return {
					position: getComputedStyle(inspector).position !== "absolute",
					halfWidth: Math.abs(inspector.getBoundingClientRect().width - Math.round(innerWidth * 0.5)) <= 1,
					composerEnabled: document.querySelector("textarea")?.disabled === false,
				};
			});
			expect(docked).toEqual({ position: true, halfWidth: true, composerEnabled: true });
			expect(await cellShown(page, "North")).toBe(true);
			await expect.poll(() => page.locator(SIDEBAR).count()).toBe(0);

			await dismissToasts(page);
			await page.locator(BACK).click();
			await expect.poll(() => page.locator(SIDEBAR).count()).toBe(1);
			expect(errors).toEqual([]);
		});
	});

	test("shows a way out for a file that is not what its name says", async () => {
		await withApp(async ({ page, errors }) => {
			await watchCsp(page);
			await openFromTree(page, "not-a-docx.docx");
			expect(await previewState(page)).toBe("error");
			expect(await previewTextCount(page, "This file could not be shown here. Use Open externally to see it.")).toBe(
				1,
			);
			expect(
				await page.evaluate(() =>
					Array.from(document.querySelectorAll("aside.omp-inspector button")).some(
						button => button.textContent?.trim() === "Open externally",
					),
				),
			).toBe(true);
			expect(await cspViolations(page)).toEqual([]);
			expect(errors).toEqual([]);
		});
	});

	test("refreshes the preview after a tool writes the file, and on Reload", async () => {
		await withApp(async ({ page, project, errors }) => {
			await watchCsp(page);
			await openFromTree(page, "table.csv");
			await expect.poll(() => cellShown(page, "North")).toBe(true);

			await page.evaluate(() => window.omp.rpc.bash("fixture:write-table-csv"));
			await expect.poll(() => previewTextCount(page, "West"), { timeout: 6_000 }).toBeGreaterThanOrEqual(1);

			await fs.writeFile(path.join(project, "table.csv"), "Region,Revenue\nEast,5\n");
			await page.waitForTimeout(3000);
			expect(await previewTextCount(page, "East")).toBe(0);

			await dismissToasts(page);
			await page.locator('button[aria-label="Reload"]').click();
			await expect.poll(() => previewTextCount(page, "East"), { timeout: 6_000 }).toBeGreaterThanOrEqual(1);
			expect(await cspViolations(page)).toEqual([]);
			expect(errors).toEqual([]);
		});
	});

	test("keeps a document's injected styles inside the preview", async () => {
		await withApp(async ({ page, errors }) => {
			await watchCsp(page);
			await openFromTree(page, "injected-font.docx");
			await expect.poll(() => rendered(page, "docx"), { timeout: RENDER_TIMEOUT }).toBe(true);
			expect(
				await page.evaluate(() =>
					Array.from(
						document.querySelector('[data-preview-host="docx"]')?.shadowRoot?.querySelectorAll("style") ?? [],
					).some(style => style.textContent?.includes(":host{position:fixed")),
				),
			).toBe(true);
			const contained = await page.evaluate(() => {
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
			expect(await cspViolations(page)).toEqual([]);
			expect(errors).toEqual([]);
		});
	});

	test("loads pdf.js character maps and fonts from the app", async () => {
		await withApp(async ({ page, errors }) => {
			await watchCsp(page);
			await openFromTree(page, "cjk.pdf");
			await expect.poll(() => drawnCanvases(page), { timeout: RENDER_TIMEOUT }).toBeGreaterThanOrEqual(1);
			// The loader pdf.js uses for URLs that are not http(s): XMLHttpRequest.
			const sizes = await page.evaluate(() => {
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
			expect(await cspViolations(page)).toEqual([]);
			expect(errors).toEqual([]);
		});
	});
});
