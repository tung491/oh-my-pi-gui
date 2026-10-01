/**
 * Main registers the quick-entry chord with Electron, so the canonical chord
 * the shortcuts dialog shows must turn into the accelerator for the same keys,
 * with ⌘ named for the platform and never widened to CommandOrControl.
 */

import { describe, expect, it } from "vitest";
import { chordToAccelerator } from "./chord";

describe("chord to accelerator", () => {
	it("keeps ⌃ as literal Control on every platform", () => {
		for (const platform of ["darwin", "linux", "win32"] as const) {
			expect(chordToAccelerator("⇧⌃␣", platform)).toBe("Control+Shift+Space");
		}
	});

	it("names ⌘ Command on macOS and Super elsewhere, first in the modifier order", () => {
		expect(chordToAccelerator("⇧⌘O", "darwin")).toBe("Command+Shift+O");
		expect(chordToAccelerator("⇧⌘O", "linux")).toBe("Super+Shift+O");
		expect(chordToAccelerator("⌥⇧⌃⌘K", "darwin")).toBe("Command+Control+Alt+Shift+K");
	});

	it("spells named keys the way Electron expects", () => {
		expect(chordToAccelerator("⌃+", "linux")).toBe("Control+Plus");
		expect(chordToAccelerator("⌥↑", "linux")).toBe("Alt+Up");
		expect(chordToAccelerator("⌃F5", "win32")).toBe("Control+F5");
		expect(chordToAccelerator("⌃⎋", "linux")).toBe("Control+Escape");
		expect(chordToAccelerator("ctrl+shift+space", "linux")).toBe("Control+Shift+Space");
	});

	it("refuses a base key Electron cannot spell", () => {
		for (const chord of ["⇧⌃§", "⌥⌃¥", "⇧⌃é", "⌥⇧\u0001"]) {
			expect(chordToAccelerator(chord, "darwin"), chord).toBeNull();
		}
		expect(chordToAccelerator("⇧⌃;", "linux")).toBe("Control+Shift+;");
	});

	it("refuses chords the grammar refuses", () => {
		expect(chordToAccelerator("⇧A", "linux")).toBeNull();
		expect(chordToAccelerator("", "linux")).toBeNull();
		expect(chordToAccelerator("A", "darwin")).toBeNull();
	});
});
