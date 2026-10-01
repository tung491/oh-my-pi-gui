/**
 * What a launch asked for, decoded from the arguments a refused second
 * instance handed over. Pure so the rule is testable without Electron.
 */
import * as fs from "node:fs";

export type LaunchRequest =
	| { kind: "url"; url: string }
	| { kind: "quick-entry" }
	| { kind: "path"; path: string }
	| { kind: "focus" };

/** Opens the quick-entry bar instead of raising a window. */
export const QUICK_ENTRY_FLAG = "--quick-entry";

export function isExistingDirectory(path: string): boolean {
	try {
		return fs.statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * A deep link wins over everything, then the quick-entry flag; otherwise the
 * first argument naming a real directory is the workspace to open, and
 * anything left means "just raise the app". Flags are skipped so Electron's own
 * switches never look like a path.
 */
export function parseLaunchArgv(
	argv: readonly string[],
	protocol: string,
	directoryExists: (path: string) => boolean = isExistingDirectory,
): LaunchRequest {
	for (const arg of argv) {
		if (arg.startsWith(`${protocol}://`)) return { kind: "url", url: arg };
	}
	if (argv.includes(QUICK_ENTRY_FLAG)) return { kind: "quick-entry" };
	for (const arg of argv) {
		if (arg.startsWith("-")) continue;
		if (directoryExists(arg)) return { kind: "path", path: arg };
	}
	return { kind: "focus" };
}

/**
 * The user's part of an Electron argv: a packaged app is `[exe, …args]`, a
 * dev run (`electron .`) is `[electron, appDir, …args]`.
 */
export function launchArguments(argv: readonly string[], defaultApp: boolean): readonly string[] {
	return argv.slice(defaultApp ? 2 : 1);
}
