/**
 * A global chord fires in every app, so main refuses editing and OS chords and
 * the app's own native chords, falls back to the default for a bad saved value,
 * and tells the shortcuts dialog the truth about each mode: native rebinds
 * apply live, a Wayland portal binding belongs to the desktop until restart.
 */

import { describe, expect, it } from "vitest";
import {
	isMainOwnedPrefKey,
	planShortcutUpdate,
	reservedGlobalChord,
	sanitizeShortcutPref,
	savedChordReplaced,
	shortcutState,
	validateGlobalChord,
} from "./quick-entry-shortcut-core";

const DEFAULT = { chord: "⇧⌃␣", enabled: true };

describe("global chord policy", () => {
	it("refuses Ctrl or Cmd alone and the window manager's chords", () => {
		for (const chord of ["⌃V", "⌘C", "⌘Q", "⌥F4", "⌘␣", "⌃⌘Q", "⌥⇥", "⌥⌃⌦"]) {
			expect(validateGlobalChord(chord, "darwin"), chord).toBe("system");
		}
		expect(validateGlobalChord("⌃A", "linux")).toBe("system");
	});

	it("accepts chords with Alt or Shift beyond Ctrl/Cmd", () => {
		for (const chord of ["⌥␣", "⇧⌃␣", "⌥⇧K", "⇧⌘K"]) {
			expect(validateGlobalChord(chord, "darwin"), chord).toBeNull();
		}
	});

	it("refuses what does not parse", () => {
		expect(validateGlobalChord("⇧A", "linux")).toBe("invalid");
		expect(validateGlobalChord("hello", "linux")).toBe("invalid");
	});

	it("refuses the app's own native chords in their platform spelling", () => {
		expect(reservedGlobalChord("⇧⌘O", "darwin")).toBe("window.toggle");
		expect(reservedGlobalChord("⇧⌃O", "linux")).toBe("window.toggle");
		expect(reservedGlobalChord("⇧⌘O", "linux")).toBeNull();
		expect(validateGlobalChord("⇧⌃O", "win32")).toBe("reserved");
		expect(validateGlobalChord("⇧⌃W", "linux")).toBe("reserved");
	});
});

describe("saved shortcut", () => {
	it("keeps a valid saved chord in canonical form", () => {
		expect(sanitizeShortcutPref({ chord: "alt+shift+k", enabled: false }, "linux")).toEqual({
			chord: "⌥⇧K",
			enabled: false,
		});
	});

	it("falls back to the default for garbage or a missing value", () => {
		for (const raw of [undefined, null, "⇧⌃␣", { chord: 3 }, { chord: "nope", enabled: true }]) {
			expect(sanitizeShortcutPref(raw, "linux")).toEqual(DEFAULT);
		}
	});

	it("treats a missing enabled flag as on", () => {
		expect(sanitizeShortcutPref({ chord: "⌥␣" }, "darwin")).toEqual({ chord: "⌥␣", enabled: true });
	});

	it("replaces a saved editing chord with the default, keeping the user's off switch", () => {
		expect(sanitizeShortcutPref({ chord: "⌃V", enabled: true }, "linux")).toEqual(DEFAULT);
		expect(sanitizeShortcutPref({ chord: "⌃V", enabled: false }, "linux")).toEqual({ ...DEFAULT, enabled: false });
	});

	it("reports a replaced chord, not a re-spelled one or a first run", () => {
		const keep = (raw: unknown) => savedChordReplaced(raw, sanitizeShortcutPref(raw, "linux"));
		expect(keep({ chord: "⌃V", enabled: true })).toBe(true);
		expect(keep("⇧⌃␣")).toBe(true);
		expect(keep({ chord: "alt+shift+k", enabled: true })).toBe(false);
		expect(keep({ chord: "⇧⌃␣", enabled: "yes" })).toBe(false);
		expect(keep(undefined)).toBe(false);
	});
});

describe("main-owned preference keys", () => {
	it("covers the quick-entry keys only", () => {
		expect(isMainOwnedPrefKey("quickEntryShortcut")).toBe(true);
		expect(isMainOwnedPrefKey("quickEntryTarget")).toBe(true);
		expect(isMainOwnedPrefKey("language")).toBe(false);
		expect(isMainOwnedPrefKey("quickEntryShortcutX")).toBe(false);
	});

	it("covers a dotted path into a main-owned key", () => {
		expect(isMainOwnedPrefKey("quickEntryShortcut.chord")).toBe(true);
		expect(isMainOwnedPrefKey("quickEntryTarget.cwd")).toBe(true);
	});
});

describe("shortcut update plan", () => {
	it("rebinds live in native mode", () => {
		expect(planShortcutUpdate(DEFAULT, { chord: "⌥⇧K" }, "native", "linux")).toEqual({
			kind: "rebind",
			next: { chord: "⌥⇧K", enabled: true },
			from: "Control+Shift+Space",
			to: "Alt+Shift+K",
		});
	});

	it("only persists in portal mode", () => {
		expect(planShortcutUpdate(DEFAULT, { chord: "⌥⇧K" }, "portal", "linux")).toEqual({
			kind: "persist",
			next: { chord: "⌥⇧K", enabled: true },
		});
	});

	it("unregisters on disable, registers on enable, and resets to the default", () => {
		const off = { ...DEFAULT, enabled: false };
		expect(planShortcutUpdate(DEFAULT, { enabled: false }, "native", "darwin")).toEqual({
			kind: "rebind",
			next: off,
			from: "Control+Shift+Space",
			to: null,
		});
		expect(planShortcutUpdate(off, { enabled: true }, "native", "darwin")).toEqual({
			kind: "rebind",
			next: DEFAULT,
			from: null,
			to: "Control+Shift+Space",
		});
		expect(planShortcutUpdate({ chord: "⌥⇧K", enabled: false }, { reset: true }, "native", "darwin")).toEqual({
			kind: "rebind",
			next: DEFAULT,
			from: null,
			to: "Control+Shift+Space",
		});
	});

	it("rejects with the policy's reason before touching anything", () => {
		expect(planShortcutUpdate(DEFAULT, { chord: "⌘C" }, "native", "darwin")).toEqual({
			kind: "reject",
			reason: "system",
		});
		expect(planShortcutUpdate(DEFAULT, { chord: "⇧⌘O" }, "portal", "darwin")).toEqual({
			kind: "reject",
			reason: "reserved",
		});
		expect(planShortcutUpdate(DEFAULT, { chord: "⇧A" }, "native", "linux")).toEqual({
			kind: "reject",
			reason: "invalid",
		});
	});
});

describe("shortcut state", () => {
	const base = {
		pref: DEFAULT,
		bound: DEFAULT,
		mode: "native" as const,
		registered: true,
		desktopEntryMissing: true,
		xwaylandOnly: false,
	};

	it("reports native registration, refusal and off", () => {
		expect(shortcutState(base).status).toBe("registered");
		expect(shortcutState({ ...base, registered: false }).status).toBe("refused");
		expect(shortcutState({ ...base, pref: { ...DEFAULT, enabled: false } }).status).toBe("off");
	});

	it("never claims a portal binding succeeded", () => {
		expect(shortcutState({ ...base, mode: "portal" }).status).toBe("requested");
	});

	it("asks for a restart only for a portal chord this session never requested", () => {
		const moved = { chord: "⌥⇧K", enabled: true };
		expect(shortcutState({ ...base, mode: "portal", pref: moved }).restartRequired).toBe(true);
		expect(shortcutState({ ...base, mode: "native", pref: moved }).restartRequired).toBe(false);
		expect(shortcutState({ ...base, mode: "portal", pref: { ...DEFAULT, enabled: false } }).restartRequired).toBe(
			false,
		);
	});

	it("passes the portal and XWayland caveats through only in their own mode", () => {
		expect(shortcutState({ ...base, mode: "portal" }).desktopEntryMissing).toBe(true);
		expect(shortcutState(base).desktopEntryMissing).toBe(false);
		expect(shortcutState({ ...base, xwaylandOnly: true }).xwaylandOnly).toBe(true);
		expect(shortcutState({ ...base, mode: "portal", xwaylandOnly: true }).xwaylandOnly).toBe(false);
	});
});
