/**
 * Chords owned by the native layer: the app menu and the system-wide window
 * shortcut. The native layer resolves these before the keydown reaches the
 * renderer, so a GUI action bound onto one of them can never fire. The keymap
 * registry therefore treats them as reserved and refuses the binding, and the
 * shortcuts dialog lists them alongside the remappable rows.
 *
 * This is the only place these chords are spelled out: the Tauri menu
 * (src-tauri/src/desktop/menu.rs) uses the same accelerators, and a Rust test
 * reads them from this file.
 */
export interface NativeChord {
	readonly id: string;
	/** Renderer i18n key for the reference row. */
	readonly labelKey: string;
	/** Canonical chord as the shortcuts dialog displays it (⌥⇧⌃⌘ order). */
	readonly chord: string;
	/** Accelerator spelling for the same keys (CmdOrCtrl is Ctrl on Linux). */
	readonly accelerator: string;
}

export const NATIVE_CHORDS = [
	{
		id: "window.toggle",
		labelKey: "hotkeys.row.windowToggle",
		chord: "⇧⌘O",
		accelerator: "CommandOrControl+Shift+O",
	},
	{ id: "session.new", labelKey: "hotkeys.row.newSession", chord: "⌘N", accelerator: "CmdOrCtrl+N" },
	{ id: "session.exportHtml", labelKey: "hotkeys.row.exportHtml", chord: "⌘E", accelerator: "CmdOrCtrl+E" },
	{ id: "window.new", labelKey: "hotkeys.row.newWindow", chord: "⇧⌘N", accelerator: "CmdOrCtrl+Shift+N" },
	// ⌘W closes a TAB and lives in the renderer keymap, so the window-level
	// close has to sit one modifier away or the two chords would fight.
	{ id: "window.close", labelKey: "hotkeys.row.windowClose", chord: "⇧⌘W", accelerator: "CmdOrCtrl+Shift+W" },
] as const satisfies readonly NativeChord[];

export type NativeChordId = (typeof NATIVE_CHORDS)[number]["id"];

/** The quick-entry bar's system-wide chord: main registers it, the shortcuts dialog rebinds it. */
export const QUICK_ENTRY_CHORD_ID = "quickEntry.summon";
/** Literal Control on every platform: unlike NATIVE_CHORDS it is never a CommandOrControl twin. */
export const QUICK_ENTRY_DEFAULT_CHORD = "⇧⌃␣";
