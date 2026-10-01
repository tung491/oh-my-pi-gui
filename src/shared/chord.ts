/**
 * The chord grammar shared by the renderer keymap and main's global shortcut.
 *
 * Modifiers ⌃⌥⇧⌘ + a base key, serialized with modifiers in the fixed order
 * ⌥ ⇧ ⌃ ⌘ and the base key canonicalized (letters uppercase, arrows/named
 * keys as glyphs: ↑↓←→ ↵ ⇥ ␣ ⎋ ⌫ ⌦). Parsing additionally accepts textual
 * aliases — ctrl/control, alt/option, shift, cmd/command/meta/super — joined
 * by "+" or "-" ("ctrl+shift+p", "Control-Shift-P"). Every chord needs a real
 * modifier (⌃/⌥/⌘): an unmodified key would eat typing app-wide and a
 * shift-only chord would hijack capital letters.
 */

export interface Chord {
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	meta: boolean;
	/** Canonical base key: uppercase letter, digit, literal punctuation, glyph (↑↓←→↵⇥␣⎋⌫⌦), or F-key. */
	key: string;
}

const MOD_SYMBOLS: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
	"⌃": "ctrl",
	"⌥": "alt",
	"⇧": "shift",
	"⌘": "meta",
};

const TEXT_MOD_ALIASES: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	option: "alt",
	shift: "shift",
	cmd: "meta",
	command: "meta",
	meta: "meta",
	super: "meta",
};

/** Textual aliases for multi-char base keys (single-char glyphs pass through as-is). */
const NAMED_KEY_ALIASES: Record<string, string> = {
	up: "↑",
	arrowup: "↑",
	down: "↓",
	arrowdown: "↓",
	left: "←",
	arrowleft: "←",
	right: "→",
	arrowright: "→",
	enter: "↵",
	return: "↵",
	tab: "⇥",
	space: "␣",
	spacebar: "␣",
	esc: "⎋",
	escape: "⎋",
	backspace: "⌫",
	delete: "⌦",
	del: "⌦",
};

function normalizeBaseKey(raw: string): string | null {
	if (!raw) return null;
	if (raw.length === 1) {
		// Letters canonicalize uppercase; digits/punctuation/glyphs stay literal.
		return /^[a-z]$/i.test(raw) ? raw.toUpperCase() : raw;
	}
	const alias = NAMED_KEY_ALIASES[raw.toLowerCase()];
	if (alias) return alias;
	const fkey = /^f(\d{1,2})$/i.exec(raw);
	if (fkey) {
		const n = Number(fkey[1]);
		if (n >= 1 && n <= 12) return `F${n}`;
	}
	return null;
}

/**
 * Parse a chord string (canonical unicode form or textual alias form) into a
 * Chord. Returns null for anything without a base key or without at least one
 * of ⌃/⌥/⌘ — unmodified and shift-only "chords" are unbindable by design.
 */
export function parseChord(input: string): Chord | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const flags = { ctrl: false, alt: false, shift: false, meta: false };
	let base = "";
	if (/[⌃⌥⇧⌘]/u.test(trimmed)) {
		// Canonical form: modifier glyphs may appear in any order; the rest is the base key.
		for (const ch of trimmed) {
			const mod = MOD_SYMBOLS[ch];
			if (mod) flags[mod] = true;
			else base += ch;
		}
	} else {
		// Textual form: consume leading "modifier<sep>" tokens; whatever remains is
		// the base key, so "ctrl+-" binds "-" and "ctrl++" binds "+".
		let rest = trimmed;
		for (;;) {
			const match = /^([a-z]+)\s*[+-]\s*/i.exec(rest);
			const mod = match?.[1] ? TEXT_MOD_ALIASES[match[1].toLowerCase()] : undefined;
			if (!match || !mod) break;
			flags[mod] = true;
			rest = rest.slice(match[0].length);
		}
		base = rest;
	}
	const key = normalizeBaseKey(base.trim());
	if (!key) return null;
	if (!flags.ctrl && !flags.alt && !flags.meta) return null;
	return { ...flags, key };
}

/** Canonical chord string: modifiers in ⌥⇧⌃⌘ order + the canonical base key. */
export function serializeChord(chord: Chord): string {
	return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.ctrl ? "⌃" : ""}${chord.meta ? "⌘" : ""}${chord.key}`;
}

/** ⌘ → ⌃, re-serialized so the modifier order stays canonical; chords without ⌘ pass through. */
export function ctrlTwin(chord: string): string {
	const parsed = parseChord(chord);
	if (!parsed?.meta) return chord;
	return serializeChord({ ...parsed, meta: false, ctrl: true });
}

const ACCELERATOR_KEYS: Record<string, string> = {
	"␣": "Space",
	"↵": "Enter",
	"⇥": "Tab",
	"⎋": "Escape",
	"⌫": "Backspace",
	"⌦": "Delete",
	"↑": "Up",
	"↓": "Down",
	"←": "Left",
	"→": "Right",
	"+": "Plus",
};

/**
 * Electron's accelerator parser knows the named keys above, printable ASCII and
 * F-keys. Any other base key (§, é, ¥ from an ISO or national layout) makes
 * globalShortcut.register throw instead of returning false.
 */
function acceleratorKey(key: string): string | null {
	const named = ACCELERATOR_KEYS[key];
	if (named) return named;
	return /^[\x21-\x7e]$/.test(key) || /^F\d{1,2}$/.test(key) ? key : null;
}

/**
 * Electron accelerator for a chord: "⇧⌃␣" → "Control+Shift+Space". ⌘ is
 * Command on macOS and Super elsewhere; it is never widened to
 * CommandOrControl. Null when the chord does not parse.
 */
export function chordToAccelerator(chord: string, platform: NodeJS.Platform): string | null {
	const parsed = parseChord(chord);
	if (!parsed) return null;
	const parts: string[] = [];
	if (parsed.meta) parts.push(platform === "darwin" ? "Command" : "Super");
	if (parsed.ctrl) parts.push("Control");
	if (parsed.alt) parts.push("Alt");
	if (parsed.shift) parts.push("Shift");
	const key = acceleratorKey(parsed.key);
	if (!key) return null;
	parts.push(key);
	return parts.join("+");
}
