/**
 * Display label for the chords that actually fire an action: the compiled
 * keymap (defaults replaced by user overrides, empty overrides ignored) in the
 * platform's text form, joined with " / ". Pure, so callers memoize it on the
 * overrides and platform they already hold.
 */

import {
	compileKeymap,
	formatChord,
	KEYMAP_ACTIONS,
	type KeyboardPlatform,
	type KeymapActionId,
	type KeymapOverrides,
} from "./keymap";

export function effectiveShortcut(
	actionId: KeymapActionId,
	overrides: KeymapOverrides,
	platform: KeyboardPlatform,
): string {
	return [...compileKeymap(KEYMAP_ACTIONS, overrides, platform)]
		.filter(([, action]) => action === actionId)
		.map(([chord]) => formatChord(chord, platform))
		.join(" / ");
}
