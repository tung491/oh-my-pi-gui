/**
 * Quick entry accepts a prompt in one window and delivers it in another, so
 * main has to refuse what the bar must not send, place the bar where the user
 * looks, keep the macOS menu from acting on the main window, and keep every
 * accepted prompt until a chat window has it or the bar gets it back.
 */

import { describe, expect, it } from "vitest";
import type { QuickEntryPrompt } from "../shared/ipc-types";
import {
	ack,
	claim,
	closeWindow,
	consumeRestored,
	enqueue,
	isBlockedMenuChord,
	QUICK_ENTRY_MAX_CHARS,
	QUICK_ENTRY_SIZE,
	type QuickEntryQueue,
	quickEntryBounds,
	releaseLeases,
	resolveInitialTarget,
	returnPrompt,
	validateSubmit,
} from "./quick-entry-core";

describe("bar bounds", () => {
	it("centres the bar horizontally at 30% of the work area's height", () => {
		expect(quickEntryBounds({ x: 0, y: 25, width: 1920, height: 1055 }, QUICK_ENTRY_SIZE)).toEqual({
			x: 620,
			y: 25 + 317,
			width: 680,
			height: 168,
		});
	});

	it("places it on an offset display's own work area", () => {
		expect(quickEntryBounds({ x: -1440, y: -200, width: 1440, height: 900 }, QUICK_ENTRY_SIZE)).toEqual({
			x: -1440 + 380,
			y: -200 + 270,
			width: 680,
			height: 168,
		});
	});

	it("shrinks and clamps to a work area smaller than the bar", () => {
		expect(quickEntryBounds({ x: 10, y: 10, width: 500, height: 200 }, QUICK_ENTRY_SIZE)).toEqual({
			x: 10,
			y: 10 + 32,
			width: 500,
			height: 168,
		});
		expect(quickEntryBounds({ x: 0, y: 0, width: 800, height: 150 }, QUICK_ENTRY_SIZE)).toEqual({
			x: 60,
			y: 0,
			width: 680,
			height: 150,
		});
	});
});

describe("submit validation", () => {
	const offered = new Set(["/work/app", "/work/gone"]);
	const isDirectory = (path: string) => path !== "/work/gone";

	it("forwards trimmed text with a rebuilt target", () => {
		expect(validateSubmit({ text: "  hello \n", target: { kind: "chat", extra: 1 } }, offered, isDirectory)).toEqual({
			ok: true,
			text: "hello",
			target: { kind: "chat" },
		});
		expect(
			validateSubmit({ text: "x", target: { kind: "workspace", cwd: "/work/app" } }, offered, isDirectory),
		).toEqual({ ok: true, text: "x", target: { kind: "workspace", cwd: "/work/app" } });
	});

	it("refuses empty and whitespace-only text", () => {
		expect(validateSubmit({ text: "", target: { kind: "chat" } }, offered, isDirectory)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(validateSubmit({ text: " \n\t ", target: { kind: "work" } }, offered, isDirectory)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses text over the limit", () => {
		const text = "a".repeat(QUICK_ENTRY_MAX_CHARS + 1);
		expect(validateSubmit({ text, target: { kind: "chat" } }, offered, isDirectory)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(validateSubmit({ text: text.slice(1), target: { kind: "chat" } }, offered, isDirectory).ok).toBe(true);
	});

	it("refuses malformed payloads and unknown target kinds", () => {
		for (const payload of [null, "hi", { text: 1, target: { kind: "chat" } }, { text: "hi" }]) {
			expect(validateSubmit(payload, offered, isDirectory)).toEqual({ ok: false, reason: "invalid" });
		}
		expect(validateSubmit({ text: "hi", target: { kind: "shell" } }, offered, isDirectory)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(validateSubmit({ text: "hi", target: { kind: "workspace", cwd: 7 } }, offered, isDirectory)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a workspace that was not offered", () => {
		expect(validateSubmit({ text: "hi", target: { kind: "workspace", cwd: "/etc" } }, offered, () => true)).toEqual({
			ok: false,
			reason: "workspace-missing",
		});
	});

	it("refuses an offered workspace that was deleted", () => {
		expect(
			validateSubmit({ text: "hi", target: { kind: "workspace", cwd: "/work/gone" } }, offered, isDirectory),
		).toEqual({ ok: false, reason: "workspace-missing" });
	});
});

describe("initial target", () => {
	const offered = new Set(["/work/app"]);

	it("keeps a saved chat, Work, or still-offered workspace", () => {
		expect(resolveInitialTarget({ kind: "chat" }, offered)).toEqual({ kind: "chat" });
		expect(resolveInitialTarget({ kind: "work" }, offered)).toEqual({ kind: "work" });
		expect(resolveInitialTarget({ kind: "workspace", cwd: "/work/app" }, offered)).toEqual({
			kind: "workspace",
			cwd: "/work/app",
		});
	});

	it("falls back to chat for a stale workspace or garbage", () => {
		expect(resolveInitialTarget({ kind: "workspace", cwd: "/old" }, offered)).toEqual({ kind: "chat" });
		for (const saved of [undefined, null, "work", { kind: 3 }]) {
			expect(resolveInitialTarget(saved, offered)).toEqual({ kind: "chat" });
		}
	});
});

describe("macOS menu chord guard", () => {
	const chord = (key: string, type = "keyDown", code = "") => ({ type, key, code, meta: true });

	it("swallows ⌘W and ⌘N on macOS", () => {
		expect(isBlockedMenuChord("darwin", chord("w"))).toBe(true);
		expect(isBlockedMenuChord("darwin", chord("n"))).toBe(true);
		expect(isBlockedMenuChord("darwin", chord(","))).toBe(true);
	});

	it("lets editing chords and ⌘Q through", () => {
		for (const key of ["v", "c", "x", "a", "z", "Z", "q", "ArrowLeft", "Backspace"]) {
			expect(isBlockedMenuChord("darwin", chord(key))).toBe(false);
		}
	});

	it("lets editing chords through on non-Latin layouts by their physical key", () => {
		expect(isBlockedMenuChord("darwin", chord("с", "keyDown", "KeyC"))).toBe(false);
		expect(isBlockedMenuChord("darwin", chord("м", "keyDown", "KeyV"))).toBe(false);
		expect(isBlockedMenuChord("darwin", chord("ц", "keyDown", "KeyW"))).toBe(true);
	});

	it("judges a Latin layout by the character the menu matches", () => {
		// Dvorak: the C character sits on the I key; AZERTY: W sits on the Z key.
		expect(isBlockedMenuChord("darwin", chord("c", "keyDown", "KeyI"))).toBe(false);
		expect(isBlockedMenuChord("darwin", chord("W", "keyDown", "KeyZ"))).toBe(true);
		expect(isBlockedMenuChord("darwin", chord("w", "keyDown", "KeyZ"))).toBe(true);
	});

	it("ignores key-up events and keys without ⌘", () => {
		expect(isBlockedMenuChord("darwin", chord("w", "keyUp"))).toBe(false);
		expect(isBlockedMenuChord("darwin", { type: "keyDown", key: "w", code: "KeyW", meta: false })).toBe(false);
	});

	it("never blocks on Linux or Windows", () => {
		expect(isBlockedMenuChord("linux", chord("w"))).toBe(false);
		expect(isBlockedMenuChord("win32", chord("w"))).toBe(false);
	});
});

describe("prompt queue", () => {
	const prompt = (id: string): QuickEntryPrompt => ({ id, text: `text ${id}`, target: { kind: "chat" } });
	const empty: QuickEntryQueue = new Map();

	it("leases on claim without deleting, and hands each prompt out once", () => {
		const queued = enqueue(enqueue(empty, 1, prompt("a")), 1, prompt("b"));
		const first = claim(queued, 1);
		expect(first.claimed.map(p => p.id)).toEqual(["a", "b"]);
		expect(first.queue.get(1)).toEqual({ pending: [], leased: [prompt("a"), prompt("b")] });
		expect(claim(first.queue, 1).claimed).toEqual([]);
	});

	it("keeps each window's prompts apart", () => {
		const queued = enqueue(enqueue(empty, 1, prompt("a")), 2, prompt("b"));
		expect(claim(queued, 2).claimed.map(p => p.id)).toEqual(["b"]);
		expect(claim(queued, 3).claimed).toEqual([]);
	});

	it("drops a prompt on ack", () => {
		const leased = claim(enqueue(enqueue(empty, 1, prompt("a")), 1, prompt("b")), 1).queue;
		const acked = ack(leased, 1, "a");
		expect(acked.get(1)).toEqual({ pending: [], leased: [prompt("b")] });
		expect(ack(acked, 1, "b").has(1)).toBe(false);
	});

	it("returns leases to pending after a reload, ahead of newer prompts", () => {
		const leased = claim(enqueue(empty, 1, prompt("a")), 1).queue;
		const released = releaseLeases(enqueue(leased, 1, prompt("b")), 1);
		expect(released.get(1)).toEqual({ pending: [prompt("a"), prompt("b")], leased: [] });
		expect(claim(released, 1).claimed.map(p => p.id)).toEqual(["a", "b"]);
	});

	it("gives a leased prompt back with main's copy of the text", () => {
		const leased = claim(enqueue(empty, 1, prompt("a")), 1).queue;
		const result = returnPrompt(leased, 1, "a", "tab-cap");
		expect(result.returned).toEqual({ ...prompt("a"), reason: "tab-cap" });
		expect(result.queue.has(1)).toBe(false);
		expect(returnPrompt(result.queue, 1, "a", "tab-cap").returned).toBeNull();
	});

	it("moves every prompt of a closed window to the restore list, one entry each", () => {
		const leased = claim(enqueue(empty, 1, prompt("a")), 1).queue;
		const result = closeWindow(enqueue(leased, 1, prompt("b")), 1);
		expect(result.returned).toEqual([
			{ ...prompt("a"), reason: "interrupted" },
			{ ...prompt("b"), reason: "interrupted" },
		]);
		expect(result.queue.has(1)).toBe(false);
		expect(closeWindow(result.queue, 1).returned).toEqual([]);
	});

	it("consumes a restored entry exactly once", () => {
		const restored = closeWindow(enqueue(enqueue(empty, 1, prompt("a")), 1, prompt("b")), 1).returned;
		const once = consumeRestored(restored, "a");
		expect(once.map(entry => entry.id)).toEqual(["b"]);
		expect(consumeRestored(once, "a")).toEqual(once);
	});
});
