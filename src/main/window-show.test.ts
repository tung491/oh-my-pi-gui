import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ShowableWindow, showWhenReady, WINDOW_SHOW_FALLBACK_MS } from "./window-show";

class FakeWindow extends EventEmitter implements ShowableWindow {
	shows = 0;
	destroyed = false;

	isDestroyed(): boolean {
		return this.destroyed;
	}

	show(): void {
		if (this.destroyed) throw new Error("Object has been destroyed");
		this.shows++;
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("showWhenReady", () => {
	it("shows on ready-to-show and never again from the fallback", () => {
		const win = new FakeWindow();
		showWhenReady(win);
		win.emit("ready-to-show");
		expect(win.shows).toBe(1);
		vi.advanceTimersByTime(WINDOW_SHOW_FALLBACK_MS * 2);
		expect(win.shows).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows after three seconds when ready-to-show never fires", () => {
		const win = new FakeWindow();
		showWhenReady(win);
		vi.advanceTimersByTime(WINDOW_SHOW_FALLBACK_MS - 1);
		expect(win.shows).toBe(0);
		vi.advanceTimersByTime(1);
		expect(win.shows).toBe(1);
	});

	it("does not show twice when ready-to-show arrives after the fallback", () => {
		const win = new FakeWindow();
		showWhenReady(win);
		vi.advanceTimersByTime(WINDOW_SHOW_FALLBACK_MS);
		win.emit("ready-to-show");
		expect(win.shows).toBe(1);
	});

	it("cancels the fallback when the window closes first", () => {
		const win = new FakeWindow();
		showWhenReady(win);
		win.destroyed = true;
		win.emit("closed");
		expect(vi.getTimerCount()).toBe(0);
		expect(() => vi.advanceTimersByTime(WINDOW_SHOW_FALLBACK_MS)).not.toThrow();
		expect(win.shows).toBe(0);
	});

	it("skips a window destroyed without a closed event", () => {
		const win = new FakeWindow();
		showWhenReady(win);
		win.destroyed = true;
		expect(() => vi.advanceTimersByTime(WINDOW_SHOW_FALLBACK_MS)).not.toThrow();
		expect(win.shows).toBe(0);
	});
});
