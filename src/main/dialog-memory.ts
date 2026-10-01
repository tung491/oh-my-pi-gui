/**
 * Where a file dialog starts. Electron 43+ dialogs open in Downloads and the
 * OS no longer remembers the last folder, so the main process keeps the last
 * folder each window used and starts the next dialog there.
 */

import { dirname, isAbsolute, join } from "node:path";

/**
 * The `defaultPath` to hand a dialog: an absolute request wins; a bare file
 * name (or no request) lands in the window's last folder; with no last folder
 * the request passes through, and `undefined` means the OS default.
 */
export function dialogStartPath(lastDir: string | undefined, requested: string | undefined): string | undefined {
	if (requested !== undefined && isAbsolute(requested)) return requested;
	if (lastDir === undefined) return requested;
	return requested === undefined ? lastDir : join(lastDir, requested);
}

/** The folder to remember after a dialog picked `selectedPath` (a file). */
export function dialogDirOf(selectedPath: string): string {
	return dirname(selectedPath);
}
