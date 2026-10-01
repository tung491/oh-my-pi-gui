/**
 * Arguments for `app.relaunch`. Linux builds run on XWayland: the packaged
 * launcher passes `--ozone-platform=x11`, which only works as a real
 * command-line switch, so every relaunch has to pass it on too. Pure so the
 * rule is testable without Electron.
 */

/** The display backend a Linux launch gets when it did not choose one. */
export const LINUX_DISPLAY_SWITCH = "--ozone-platform=x11";

const OZONE_PLATFORM_PREFIX = "--ozone-platform=";

/**
 * `args` plus the current process's `--ozone-platform` choice on Linux, or
 * XWayland when it made none. An `args` that already picks a backend, and
 * every other platform, comes back unchanged.
 */
export function relaunchArgs(
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	argv: readonly string[] = process.argv,
): string[] {
	if (platform !== "linux" || args.some(arg => arg.startsWith(OZONE_PLATFORM_PREFIX))) return [...args];
	const current = argv.findLast(arg => arg.startsWith(OZONE_PLATFORM_PREFIX));
	return [...args, current ?? LINUX_DISPLAY_SWITCH];
}
