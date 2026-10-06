import { describe, expect, it } from "vitest";
import { effectiveShortcut } from "./shortcut-hint";

describe("effectiveShortcut", () => {
	it("lists every default palette chord on macOS", () => {
		expect(effectiveShortcut("palette", {}, "mac")).toBe("⌘K / ⌃K");
	});

	it("shows a user override in canonical modifier order", () => {
		expect(effectiveShortcut("palette", { palette: ["⌘⇧K"] }, "mac")).toBe("⇧⌘K");
	});

	it("labels the single-chord navigation actions", () => {
		expect(effectiveShortcut("agents.hub", {}, "mac")).toBe("⌥A");
		expect(effectiveShortcut("model.select", {}, "mac")).toBe("⌥M");
	});

	it("spells chords as text off macOS", () => {
		const hint = effectiveShortcut("palette", {}, "linux");
		expect(hint).not.toBe("");
		expect(hint).not.toMatch(/[⌘⌥⌃⇧]/);
	});

	it("keeps the default chords for an empty override, matching what the key does", () => {
		expect(effectiveShortcut("hotkeys", { hotkeys: [] }, "mac")).toBe("⌘/ / ⌃/");
	});
});
