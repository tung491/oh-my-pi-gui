/**
 * Display label for the chords that actually fire an action: the compiled
 * keymap (defaults replaced by user overrides, empty overrides ignored) in
 * its text form, joined with " / ". Pure, so callers memoize it on the
 * overrides they already hold.
 */

import { compileKeymap, formatChord, KEYMAP_ACTIONS, type KeymapActionId, type KeymapOverrides } from "./keymap";

export function effectiveShortcut(actionId: KeymapActionId, overrides: KeymapOverrides): string {
	return [...compileKeymap(KEYMAP_ACTIONS, overrides)]
		.filter(([, action]) => action === actionId)
		.map(([chord]) => formatChord(chord))
		.join(" / ");
}
