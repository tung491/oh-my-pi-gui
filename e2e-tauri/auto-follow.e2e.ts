import { $, browser, expect } from "@wdio/globals";
import { awaitBridge, collectPageErrors, launch, nodeOf, pageErrors, until, wheel } from "./session";

/** Distance from the bottom that still counts as "riding the live edge". Row
 * re-measurement during streaming overshoots a few pixels, so this is deliberately
 * looser than the app's own slack while still ruling out a stranded view. */
const LIVE_EDGE_PX = 200;

const SCROLL = ".omp-transcript-scroll";

/** Run an assertion; when it fails, append the measurement trace to its message. */
function withTrace(trace: string, assertion: () => void): void {
	try {
		assertion();
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${trace}`);
	}
}

describe("auto-follow", () => {
	it("a bottom-pinned transcript rides the stream, and 'jump to latest' re-engages it", async () => {
		// Enough history that an abort leaves something to scroll up through, which is
		// the state a reader is actually in when they send the next message.
		await launch({ name: "auto-follow", history: 300 });
		await awaitBridge(browser);
		await collectPageErrors(browser);

		const input = $("textarea");
		await expect(input).toBeDisplayed({ wait: 60_000 });

		const gap = async () =>
			browser.execute(node => node.scrollHeight - node.scrollTop - node.clientHeight, await nodeOf(SCROLL));
		const height = async () => browser.execute(node => node.scrollHeight, await nodeOf(SCROLL));
		const jump = $('button[aria-label="Jump to latest"]');
		const abortButton = $('button[aria-label="Abort"]');
		// The control is always mounted and fades out while pinned, so a visibility
		// check cannot tell "offered" from "hidden"; interactivity can.
		const jumpOffered = async () =>
			browser.execute(
				element => getComputedStyle(element).pointerEvents !== "none",
				await nodeOf('button[aria-label="Jump to latest"]'),
			);
		const send = async (text: string) => {
			await input.setValue(text);
			await $('button[aria-label="Send (Enter)"]').click();
			await expect(abortButton).toBeDisplayed();
		};
		const abort = async () => {
			await abortButton.click();
			await expect(abortButton).not.toBeExisting();
		};
		const scrollUp = async () => {
			await wheel(SCROLL, -1500);
			expect(await until(jumpOffered, offered => offered)).toBe(true);
			expect(await gap()).toBeGreaterThan(LIVE_EDGE_PX);
		};
		// The fixture streams a chunk every 16ms, so a handful of samples proves
		// sustained following rather than one lucky frame.
		const ridesTheStream = async (ticks: number) => {
			const trace: string[] = [];
			let growth = 0;
			let previousHeight = 0;
			// A reclaim converges on the tail over a few frames, so the first sample
			// would otherwise measure the edge moving away faster than the chase closes.
			expect(await until(gap, distance => distance < LIVE_EDGE_PX, { timeout: 3_000, interval: 50 })).toBeLessThan(
				LIVE_EDGE_PX,
			);
			for (let tick = 0; tick < ticks; tick++) {
				const measured = await height();
				if (previousHeight && measured > previousHeight) growth++;
				previousHeight = measured;
				const distance = await gap();
				trace.push(`${distance}@${measured}`);
				withTrace(`gap@height trace ${trace.join(" → ")}`, () => expect(distance).toBeLessThan(LIVE_EDGE_PX));
				await browser.pause(120);
			}
			// Without real growth the loop would only prove an idle view stands still.
			withTrace(`gap@height trace ${trace.join(" → ")}`, () => expect(growth).toBeGreaterThan(ticks / 3));
		};
		// A reader who scrolled up owns the viewport: the distance from the bottom may
		// only grow while content arrives, never shrink back toward the live edge.
		const holdsPosition = async (ticks: number) => {
			const gaps: number[] = [];
			for (let tick = 0; tick < ticks; tick++) {
				gaps.push(await gap());
				await browser.pause(80);
			}
			for (let tick = 1; tick < gaps.length; tick++) {
				withTrace(`gap trace ${gaps.join(" → ")}`, () =>
					expect(gaps[tick]).toBeGreaterThanOrEqual(gaps[tick - 1] - 4),
				);
			}
			withTrace(`gap trace ${gaps.join(" → ")}`, () => expect(gaps[gaps.length - 1]).toBeGreaterThan(LIVE_EDGE_PX));
		};

		await send("fixture stream");

		// Send reclaims the live edge, and every later chunk has to keep it.
		expect(await until(gap, distance => distance < LIVE_EDGE_PX)).toBeLessThan(LIVE_EDGE_PX);
		await ridesTheStream(12);
		expect(await jumpOffered()).toBe(false);

		await scrollUp();
		const heldHeight = await height();
		await holdsPosition(8);
		expect(await height()).toBeGreaterThan(heldHeight);

		// Re-engaged means it keeps following, not that it jumped once.
		await jump.click();
		expect(await until(gap, distance => distance < LIVE_EDGE_PX)).toBeLessThan(LIVE_EDGE_PX);
		expect(await jumpOffered()).toBe(false);
		await ridesTheStream(6);

		// Scrolling back down to the tail re-engages on its own: intent is a gesture
		// toward the tail, so the reader never has to reach for the control.
		await scrollUp();
		for (let step = 0; step < 60 && (await jumpOffered()); step++) await wheel(SCROLL, 1_500);
		expect(await jumpOffered()).toBe(false);
		await ridesTheStream(6);
		await abort();

		// A fresh send reclaims the live edge even from a view the reader had scrolled
		// up: the reply must not render off-screen below the fold.
		await scrollUp();
		await send("fixture stream");
		expect(await until(gap, distance => distance < LIVE_EDGE_PX)).toBeLessThan(LIVE_EDGE_PX);
		expect(await jumpOffered()).toBe(false);
		await ridesTheStream(6);
		await abort();

		await browser.saveScreenshot("test-results/auto-follow.png");
		expect(await pageErrors(browser)).toEqual([]);
	}).timeout(150_000);
});
