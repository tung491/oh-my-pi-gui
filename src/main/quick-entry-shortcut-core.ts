/**
 * The quick-entry shortcut's rules, free of Electron: which chords may be
 * grabbed system-wide, how a saved or requested change applies in each mode,
 * and what the shortcuts dialog is told. A global grab breaks the chord in
 * every other app and survives restarts, so the policy is stricter than the
 * in-app keymap's; main applies it on every change and to the saved value at
 * startup. src/main/quick-entry-shortcut.ts drives globalShortcut with it.
 */

import { chordToAccelerator, ctrlTwin, parseChord, serializeChord } from "../shared/chord";
import { CONTEXT_FIT_PREF } from "../shared/context-fit-store";
import { NATIVE_CHORDS, QUICK_ENTRY_DEFAULT_CHORD } from "../shared/hotkeys";
import type { QuickEntryShortcutPref, QuickEntryShortcutState, QuickEntryShortcutUpdate } from "../shared/ipc-types";

export type ShortcutMode = "native" | "portal";

/** Chords the window manager or the OS itself owns, in canonical form (⌘ is Cmd or Super). */
const OS_CHORDS: ReadonlySet<string> = new Set([
	"⌥⇥", // Alt+Tab
	"⌥F4", // Alt+F4
	"⌘⇥", // Cmd+Tab
	"⌘␣", // Cmd+Space, Super+Space
	"⌘Q", // Cmd+Q
	"⌥⌃⌦", // Ctrl+Alt+Delete
	"⌘L", // Super+L
]);

const DEFAULT_PREF: QuickEntryShortcutPref = { chord: QUICK_ENTRY_DEFAULT_CHORD, enabled: true };

/** The app chord this one would collide with: a NATIVE_CHORDS id (CommandOrControl, so Ctrl off macOS). */
export function reservedGlobalChord(chord: string, platform: NodeJS.Platform): string | null {
	const parsed = parseChord(chord);
	if (!parsed) return null;
	const canonical = serializeChord(parsed);
	for (const entry of NATIVE_CHORDS) {
		if ((platform === "darwin" ? entry.chord : ctrlTwin(entry.chord)) === canonical) return entry.id;
	}
	return null;
}

/**
 * The one global-chord policy. "invalid": unparsable, or a key Electron cannot
 * register; "system": Ctrl and/or Cmd alone (editing chords like ⌃V and ⌘C, OS
 * chords like ⌃⌘Q) or a window-manager chord; "reserved": one of the app's own
 * native chords.
 */
export function validateGlobalChord(
	chord: string,
	platform: NodeJS.Platform,
): null | "invalid" | "system" | "reserved" {
	const parsed = parseChord(chord);
	if (!parsed || !chordToAccelerator(chord, platform)) return "invalid";
	if (!parsed.alt && !parsed.shift) return "system";
	if (OS_CHORDS.has(serializeChord(parsed))) return "system";
	if (reservedGlobalChord(chord, platform)) return "reserved";
	return null;
}

/**
 * The saved shortcut, or the default chord when the saved one is missing,
 * malformed or no longer allowed. A boolean `enabled` survives, so a user's
 * "off" is kept even when the chord falls back.
 */
export function sanitizeShortcutPref(raw: unknown, platform: NodeJS.Platform): QuickEntryShortcutPref {
	const record = typeof raw === "object" && raw !== null ? (raw as { chord?: unknown; enabled?: unknown }) : {};
	const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
	const chord = typeof record.chord === "string" ? record.chord : "";
	const parsed = parseChord(chord);
	if (!parsed || validateGlobalChord(chord, platform) !== null) return { ...DEFAULT_PREF, enabled };
	return { chord: serializeChord(parsed), enabled };
}

/** `ollamaContextFit` holds measured limits: only the context-fit scheduler and its validated channels write it. */
const MAIN_OWNED_PREF_KEYS = new Set(["quickEntryShortcut", "quickEntryTarget", CONTEXT_FIT_PREF]);

/**
 * Keys only main writes, through validated channels; the generic PREFS_SET
 * refuses them. electron-store reads "a.b" as a path, so the first segment counts.
 */
export function isMainOwnedPrefKey(key: string): boolean {
	return MAIN_OWNED_PREF_KEYS.has(key.split(".")[0]);
}

export type ShortcutPlan =
	| { kind: "reject"; reason: "invalid" | "system" | "reserved" }
	/** Portal: the desktop owns the binding; the change applies after a restart. */
	| { kind: "persist"; next: QuickEntryShortcutPref }
	/** Native: the accelerators to unregister and register (null when off). */
	| { kind: "rebind"; next: QuickEntryShortcutPref; from: string | null; to: string | null };

function nextPref(
	current: QuickEntryShortcutPref,
	update: unknown,
	platform: NodeJS.Platform,
): QuickEntryShortcutPref | ShortcutPlan {
	if (typeof update !== "object" || update === null) return { kind: "reject", reason: "invalid" };
	const change = update as { chord?: unknown; enabled?: unknown; reset?: unknown };
	if (change.reset === true) return { ...DEFAULT_PREF };
	if (typeof change.enabled === "boolean") return { ...current, enabled: change.enabled };
	if (typeof change.chord !== "string") return { kind: "reject", reason: "invalid" };
	const reason = validateGlobalChord(change.chord, platform);
	const parsed = parseChord(change.chord);
	if (reason || !parsed) return { kind: "reject", reason: reason ?? "invalid" };
	// Picking a new chord means the user wants it to work.
	return { chord: serializeChord(parsed), enabled: true };
}

export function planShortcutUpdate(
	current: QuickEntryShortcutPref,
	update: QuickEntryShortcutUpdate,
	mode: ShortcutMode,
	platform: NodeJS.Platform,
): ShortcutPlan {
	const next = nextPref(current, update, platform);
	if ("kind" in next) return next;
	if (mode === "portal") return { kind: "persist", next };
	const accelerator = (pref: QuickEntryShortcutPref) =>
		pref.enabled ? chordToAccelerator(pref.chord, platform) : null;
	return { kind: "rebind", next, from: accelerator(current), to: accelerator(next) };
}

/** A saved chord was replaced by the default, as opposed to kept or only re-spelled. */
export function savedChordReplaced(raw: unknown, pref: QuickEntryShortcutPref): boolean {
	if (raw === undefined) return false;
	const chord = typeof raw === "object" && raw !== null ? (raw as { chord?: unknown }).chord : undefined;
	const parsed = typeof chord === "string" ? parseChord(chord) : null;
	return !parsed || serializeChord(parsed) !== pref.chord;
}

export function shortcutState(input: {
	pref: QuickEntryShortcutPref;
	/** What this session registered at startup or on the last native rebind (null: nothing). */
	bound: QuickEntryShortcutPref | null;
	mode: ShortcutMode;
	/** The last register() result; null when none was attempted. */
	registered: boolean | null;
	desktopEntryMissing: boolean;
	xwaylandOnly: boolean;
}): QuickEntryShortcutState {
	const { pref, bound, mode, registered } = input;
	const portal = mode === "portal";
	const status: QuickEntryShortcutState["status"] =
		!pref.enabled || registered === null ? "off" : !registered ? "refused" : portal ? "requested" : "registered";
	return {
		chord: pref.chord,
		enabled: pref.enabled,
		mode,
		status,
		// Turning it off and back on applies live (activations are muted), so only
		// a chord this session never asked the desktop for needs a restart.
		restartRequired: portal && pref.enabled && bound?.chord !== pref.chord,
		desktopEntryMissing: portal && input.desktopEntryMissing,
		xwaylandOnly: !portal && input.xwaylandOnly,
	};
}
