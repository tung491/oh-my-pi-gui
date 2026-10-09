import { describe, expect, it } from "vitest";
import { effectiveShortcut } from "./shortcut-hint";

describe("effectiveShortcut", () => {
	it("lists every default palette chord", () => {
		expect(effectiveShortcut("palette", {})).toBe("Ctrl+K / Super+K");
	});

	it("shows a user override in canonical modifier order", () => {
		expect(effectiveShortcut("palette", { palette: ["⌘⇧K"] })).toBe("Shift+Super+K");
	});

	it("labels the single-chord navigation actions", () => {
		expect(effectiveShortcut("agents.hub", {})).toBe("Alt+A");
		expect(effectiveShortcut("model.select", {})).toBe("Alt+M");
	});

	it("spells chords as text", () => {
		const hint = effectiveShortcut("palette", {});
		expect(hint).not.toBe("");
		expect(hint).not.toMatch(/[⌘⌥⌃⇧]/);
	});

	it("keeps the default chords for an empty override, matching what the key does", () => {
		expect(effectiveShortcut("hotkeys", { hotkeys: [] })).toBe("Ctrl+/ / Super+/");
	});
});
