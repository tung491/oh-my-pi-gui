/**
 * Contract tests for the GUI keybinding remap layer (B3 — plan/15 §3.5,
 * plan/17 §6.3): chord parse/serialize round-trips and alias acceptance,
 * replace-not-union compilation, both conflict classes (user-user error,
 * default-shadow warning), and override sanitization that ignores unknown
 * actions on hydration. B5 adds the single-chord-table invariants: every action
 * has exactly one reference group, every chord the app owns (registry default,
 * composer key, or native menu accelerator) has one claimant, and the reserved
 * chords actually block or warn in the recorder. GUI-local only — nothing here
 * touches the TUI's keybindings.yml.
 */

import { describe, expect, it } from "vitest";
import { NATIVE_CHORDS, QUICK_ENTRY_CHORD_ID, QUICK_ENTRY_DEFAULT_CHORD } from "../../shared/hotkeys";
import {
	chordFromEvent,
	chordOwner,
	compileKeymap,
	ctrlTwin,
	detectConflicts,
	displayShortcut,
	formatChord,
	KEYMAP_ACTIONS,
	keymapActionsForGroup,
	parseChord,
	platformDefaults,
	quickEntryConflicts,
	reservedChordsFor,
	reservedChordsForGroup,
	sanitizeOverrides,
	serializeChord,
} from "./keymap";

/** Canonical form of an input chord; throws when the chord does not parse. */
function canonical(input: string): string {
	const parsed = parseChord(input);
	if (!parsed) throw new Error(`"${input}" does not parse`);
	return serializeChord(parsed);
}

/** Menu accelerator spelling → the canonical chord the dialog promises.
 *  "CmdOrCtrl" is one chord: the dialog shows the ⌘ form for both platforms. */
function acceleratorToChord(accelerator: string): string {
	const parts = accelerator.split("+");
	const key = (parts.pop() ?? "").toUpperCase();
	const flags = { ctrl: false, alt: false, shift: false, meta: false };
	for (const part of parts) {
		const token = part.toLowerCase();
		if (token === "ctrl" || token === "control") flags.ctrl = true;
		else if (token === "alt" || token === "option") flags.alt = true;
		else if (token === "shift") flags.shift = true;
		else if (token === "cmd" || token === "command" || token === "cmdorctrl" || token === "commandorcontrol")
			flags.meta = true;
	}
	return serializeChord({ ...flags, key });
}

const NO_MODS = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe("parseChord/serializeChord", () => {
	it("round-trips every default chord in the action table", () => {
		for (const action of KEYMAP_ACTIONS) {
			for (const chord of action.defaults) {
				expect(canonical(chord), `${action.id} default "${chord}"`).toBe(chord);
			}
		}
	});

	it("accepts textual modifier aliases and normalizes order + case", () => {
		expect(canonical("ctrl+shift+p")).toBe("⇧⌃P");
		expect(canonical("Control-Shift-P")).toBe("⇧⌃P");
		expect(canonical("shift+ctrl+P")).toBe("⇧⌃P");
		expect(canonical("alt+r")).toBe("⌥R");
		expect(canonical("option+r")).toBe("⌥R");
		expect(canonical("alt+shift+p")).toBe("⌥⇧P");
		expect(canonical("cmd+k")).toBe("⌘K");
		expect(canonical("command+k")).toBe("⌘K");
		expect(canonical("meta+k")).toBe("⌘K");
		expect(canonical("super+k")).toBe("⌘K");
		expect(canonical("ctrl+alt+shift+meta+o")).toBe("⌥⇧⌃⌘O");
	});

	it("parses arrow, punctuation, and bare-plus/minus base keys", () => {
		expect(canonical("alt+up")).toBe("⌥↑");
		expect(canonical("ctrl+arrowup")).toBe("⌃↑");
		expect(canonical("cmd+,")).toBe("⌘,");
		expect(canonical("cmd+/")).toBe("⌘/");
		expect(canonical("ctrl+-")).toBe("⌃-");
		expect(canonical("ctrl++")).toBe("⌃+");
	});

	it("rejects chords without a real modifier or a base key", () => {
		expect(parseChord("p")).toBeNull();
		expect(parseChord("P")).toBeNull();
		expect(parseChord("shift+p")).toBeNull();
		expect(parseChord("⇧P")).toBeNull();
		expect(parseChord("")).toBeNull();
		expect(parseChord("ctrl+")).toBeNull();
		expect(parseChord("ctrl+shift")).toBeNull();
	});

	it("is stable through a second parse/serialize round-trip", () => {
		expect(canonical(canonical("Control-Shift-P"))).toBe("⇧⌃P");
		expect(canonical(canonical("alt+up"))).toBe("⌥↑");
	});
});

describe("chordFromEvent", () => {
	it("serializes keydown events to canonical chords", () => {
		expect(chordFromEvent({ key: "p", code: "KeyP", ...NO_MODS, ctrlKey: true })).toBe("⌃P");
		expect(chordFromEvent({ key: "P", code: "KeyP", ...NO_MODS, ctrlKey: true, shiftKey: true })).toBe("⇧⌃P");
		expect(chordFromEvent({ key: "ArrowUp", code: "ArrowUp", ...NO_MODS, altKey: true })).toBe("⌥↑");
		expect(chordFromEvent({ key: ",", code: "Comma", ...NO_MODS, metaKey: true })).toBe("⌘,");
		expect(chordFromEvent({ key: "/", code: "Slash", ...NO_MODS, metaKey: true })).toBe("⌘/");
	});

	it("prefers the physical code over ⌥-composed event.key characters", () => {
		// Some layouts report ⌥R as key "®" — the pre-B3 hardcoded chains were code-based
		// for exactly this reason.
		expect(chordFromEvent({ key: "®", code: "KeyR", ...NO_MODS, altKey: true })).toBe("⌥R");
		expect(chordFromEvent({ key: "∏", code: "KeyP", ...NO_MODS, altKey: true, shiftKey: true })).toBe("⌥⇧P");
	});

	it("never forms chords from bare, shift-only, or pure-modifier keys", () => {
		expect(chordFromEvent({ key: "p", code: "KeyP", ...NO_MODS })).toBeNull();
		expect(chordFromEvent({ key: "P", code: "KeyP", ...NO_MODS, shiftKey: true })).toBeNull();
		expect(chordFromEvent({ key: "Control", code: "ControlLeft", ...NO_MODS, ctrlKey: true })).toBeNull();
	});
});

describe("compileKeymap", () => {
	it("maps every default chord to its action when there are no overrides", () => {
		const map = compileKeymap(KEYMAP_ACTIONS, {});
		expect(map.get("⌃O")).toBe("tools.expand");
		expect(map.get("⇧⌃P")).toBe("model.cycleBackward");
		expect(map.get("⌥↑")).toBe("dequeue");
		expect(map.get("⌘K")).toBe("palette");
		expect(map.get("⌃K")).toBe("palette");
	});

	it("replaces an action's defaults with its override — never a union", () => {
		const map = compileKeymap(KEYMAP_ACTIONS, { "tools.expand": ["ctrl+shift+o"] });
		expect(map.get("⇧⌃O")).toBe("tools.expand");
		// The old default chord is dead…
		expect(map.has("⌃O")).toBe(false);
		// …while untouched actions keep their defaults.
		expect(map.get("⌃T")).toBe("tab.new");
		expect(map.get("⌃W")).toBe("tab.close");
	});

	it("lets an explicit user chord win a shadowed default slot", () => {
		const map = compileKeymap(KEYMAP_ACTIONS, { retry: ["ctrl+o"] });
		expect(map.get("⌃O")).toBe("retry");
	});
});

describe("detectConflicts", () => {
	it("flags one chord claimed by two user bindings as an error", () => {
		const conflicts = detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃⇧R"], dequeue: ["ctrl+shift+r"] });
		expect(conflicts).toEqual([{ kind: "error", chord: "⇧⌃R", actionIds: ["retry", "dequeue"] }]);
	});

	it("warns when a user chord shadows another action's live default", () => {
		const conflicts = detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃O"] });
		expect(conflicts).toEqual([{ kind: "warning", chord: "⌃O", actionIds: ["retry", "tools.expand"] }]);
	});

	it("drops the shadow warning once the shadowed action is itself remapped", () => {
		// ⇧⌃O is window.toggle on Linux, so the remap lands on a chord nobody holds.
		const conflicts = detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃O"], "tools.expand": ["ctrl+alt+o"] });
		expect(conflicts).toEqual([]);
	});

	it("ignores a user chord equal to its own action's default or listed twice", () => {
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["⌥R"] })).toEqual([]);
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃⇧R", "ctrl+shift+r"] })).toEqual([]);
	});

	it("blocks a binding on a chord the native layer already registers", () => {
		// The native layer resolves the menu/global accelerator before the renderer
		// sees the keydown, so such a binding could never fire.
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃N"] })).toEqual([
			{ kind: "error", chord: "⌃N", actionIds: ["retry", "session.new"] },
		]);
	});

	it("warns for a composer chord instead: it still fires anywhere else", () => {
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃R"] })).toEqual([
			{ kind: "warning", chord: "⌃R", actionIds: ["retry", "composer.history"] },
		]);
	});

	it("blocks a binding on the live quick-entry chord, spelled as given on every platform", () => {
		const quickEntry = {
			id: QUICK_ENTRY_CHORD_ID,
			labelKey: "hotkeys.row.quickEntry",
			chord: QUICK_ENTRY_DEFAULT_CHORD,
			hotkeyGroup: "native" as const,
		};
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["ctrl+shift+space"] }, [quickEntry])).toEqual([
			{ kind: "error", chord: "⇧⌃␣", actionIds: ["retry", QUICK_ENTRY_CHORD_ID] },
		]);
		expect(chordOwner(QUICK_ENTRY_CHORD_ID)).toEqual({ labelKey: "hotkeys.row.quickEntry", holds: "native" });
	});
});

describe("quickEntryConflicts", () => {
	it("refuses a native chord in this platform's spelling", () => {
		expect(quickEntryConflicts("⇧⌃O", {})).toEqual({ kind: "error", ownerId: "window.toggle" });
	});

	it("warns when it takes a composer chord or a live keymap chord", () => {
		expect(quickEntryConflicts("⌃R", {})).toEqual({ kind: "warning", ownerId: "composer.history" });
		expect(quickEntryConflicts("⌥⇧K", { retry: ["alt+shift+k"] })).toEqual({
			kind: "warning",
			ownerId: "retry",
		});
	});

	it("has nothing to say about a free chord or one that does not parse", () => {
		expect(quickEntryConflicts(QUICK_ENTRY_DEFAULT_CHORD, {})).toBeNull();
		expect(quickEntryConflicts("nope", {})).toBeNull();
	});
});

describe("hotkey reference table", () => {
	it("files every remappable action in exactly one group", () => {
		// A second group would render the action twice (two rows, one binding); a
		// dropped one could never be remapped at all — the dialog is the only
		// entry point. The required `hotkeyGroup` field makes "none" a type error,
		// and HotkeysDialog's render test covers "no section for this group".
		const seen = new Set<string>();
		for (const group of new Set(KEYMAP_ACTIONS.map(action => action.hotkeyGroup))) {
			for (const action of keymapActionsForGroup(group)) {
				expect(seen.has(action.id), `${action.id} claimed by two groups`).toBe(false);
				seen.add(action.id);
			}
		}
		expect([...seen].sort()).toEqual(KEYMAP_ACTIONS.map(action => action.id).sort());
	});

	it("gives every chord the app owns exactly one claimant", () => {
		// Two owners of one chord is a dead binding: the compiled map lets the
		// later action win, and a default landing on the composer's ⌃R or a menu
		// accelerator never reaches the renderer at all.
		const claims = [
			...KEYMAP_ACTIONS.flatMap(action => platformDefaults(action)),
			...reservedChordsFor().map(entry => entry.chord),
		];
		for (const chord of claims) expect(canonical(chord), `"${chord}"`).toBe(chord);
		expect(new Set(claims).size).toBe(claims.length);
	});

	it("lists each native menu chord once, in both owners' tables", () => {
		const native = reservedChordsForGroup("native").map(entry => entry.id);
		expect(native.sort()).toEqual(NATIVE_CHORDS.map(entry => entry.id).sort());
	});

	it("spells every menu accelerator with the keys the dialog displays", () => {
		// The menu registers the accelerator; the dialog promises the chord. Edit
		// only one of the two and the documented shortcut does nothing.
		for (const entry of NATIVE_CHORDS) {
			expect(acceleratorToChord(entry.accelerator), entry.id).toBe(entry.chord);
		}
	});
});

describe("everyday-work hotkeys", () => {
	it("drops the developer hotkeys and keeps the core ones", () => {
		const ids = KEYMAP_ACTIONS.map(action => action.id as string);
		for (const removed of ["plan.toggle", "pr.center", "tab.newChat", "tab.newWorktree"]) {
			expect(ids, removed).not.toContain(removed);
		}
		for (const kept of ["agents.hub", "palette", "settings", "tab.new"]) {
			expect(ids, kept).toContain(kept);
		}
	});
});

describe("sanitizeOverrides", () => {
	it("drops unknown actions, non-arrays, unparsable and duplicate chords", () => {
		const raw = {
			"bogus.action": ["ctrl+q"],
			retry: ["alt+shift+r", "⌥⇧R", "not a chord", 42],
			"tools.expand": "ctrl+o",
			dequeue: [],
		};
		expect(sanitizeOverrides(KEYMAP_ACTIONS, raw)).toEqual({ retry: ["⌥⇧R"] });
	});

	it("returns an empty table for non-object payloads", () => {
		expect(sanitizeOverrides(KEYMAP_ACTIONS, null)).toEqual({});
		expect(sanitizeOverrides(KEYMAP_ACTIONS, ["ctrl+o"])).toEqual({});
		expect(sanitizeOverrides(KEYMAP_ACTIONS, "ctrl+o")).toEqual({});
	});
});

describe("Linux keyboard", () => {
	it("gives every ⌘-only default a Ctrl twin", () => {
		const linux = (id: string) => platformDefaults(KEYMAP_ACTIONS.find(action => action.id === id)!);
		expect(linux("tab.new")).toEqual(["⌃T", "⌘T"]);
		expect(linux("tab.close")).toEqual(["⌃W", "⌘W"]);
		expect(linux("palette")).toEqual(["⌃K", "⌘K"]);
		expect(linux("model.cycleForward")).toEqual(["⌃P"]);
		// ⌃T is tab.new's Ctrl twin; the thinking toggle stays in the palette and remappable.
		expect(linux("thinking.toggle")).toEqual([]);
		expect(ctrlTwin("⇧⌘T")).toBe("⇧⌃T");
		expect(ctrlTwin("⌥R")).toBe("⌥R");
	});

	it("reserves the Ctrl form of every native accelerator", () => {
		expect(
			reservedChordsFor()
				.filter(entry => entry.hotkeyGroup === "native")
				.map(entry => entry.chord),
		).toEqual(NATIVE_CHORDS.map(entry => acceleratorToChord(entry.accelerator).replace("⌘", "⌃")));
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃N"] })).toEqual([
			{ kind: "error", chord: "⌃N", actionIds: ["retry", "session.new"] },
		]);
	});

	it("dispatches the Ctrl twins", () => {
		const linux = compileKeymap(KEYMAP_ACTIONS, {});
		expect(linux.get("⌃T")).toBe("tab.new");
		expect(linux.get("⌃W")).toBe("tab.close");
		expect(linux.get("⌘T")).toBe("tab.new");
	});

	it("spells chords as text", () => {
		expect(formatChord("⇧⌃T")).toBe("Ctrl+Shift+T");
		expect(formatChord("⌥⇧P")).toBe("Alt+Shift+P");
		expect(formatChord("⌃K / ⌘K")).toBe("Ctrl+K / Super+K");
		expect(formatChord("⌃↵")).toBe("Ctrl+Enter");
		expect(formatChord("⇧Enter")).toBe("Shift+Enter");
		expect(formatChord("↑ / ↓")).toBe("↑ / ↓");
		expect(formatChord("Esc")).toBe("Esc");
		expect(displayShortcut("⌘N")).toBe("Ctrl+N");
		expect(displayShortcut("⇧⌘T")).toBe("Ctrl+Shift+T");
		expect(displayShortcut("⌘↵")).toBe("Ctrl+Enter");
		expect(displayShortcut("⌥R")).toBe("Alt+R");
	});
});
