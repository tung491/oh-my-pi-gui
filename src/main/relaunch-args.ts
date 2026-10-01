/**
 * Arguments for `app.relaunch`. Linux builds run on XWayland: the desktop
 * entries pass `--ozone-platform=x11`, which only works as a real
 * command-line switch, so every relaunch has to pass it on too, and a launch
 * that came up without it restarts once with it. Pure so the rules are
 * testable without Electron.
 */
import { basename } from "node:path";
import { linuxPackageKind } from "./updater-state";

/** The display backend a Linux launch gets when it did not choose one. */
export const LINUX_DISPLAY_SWITCH = "--ozone-platform=x11";

/** Set on the launch a display restart starts, so it can never restart again. */
export const DISPLAY_RESTART_ENV = "SAI_ATLAS_DISPLAY_RESTARTED";

const OZONE_PLATFORM_PREFIX = "--ozone-platform=";

/** The AppImage runtime's flag for hosts without FUSE. */
const APPIMAGE_EXTRACT_AND_RUN = "--appimage-extract-and-run";

/**
 * Arguments that keep a relaunch through the AppImage file in the mode this
 * launch runs in. The runtime consumes `--appimage-extract-and-run` and only
 * reads it as the first argument, so an extracted launch has to put it back
 * first. An extracted launch is recognised by its APPDIR, which the runtime
 * names `appimage_extracted_<hash>`.
 */
export function appImageRuntimeArgs(env: { readonly [name: string]: string | undefined }): string[] {
	const appDir = env.APPDIR?.replace(/\/+$/, "");
	return appDir && basename(appDir).startsWith("appimage_extracted_") ? [APPIMAGE_EXTRACT_AND_RUN] : [];
}

export interface DisplayRestartLaunch {
	platform: NodeJS.Platform;
	packaged: boolean;
	argv: readonly string[];
	execPath: string;
	env: { readonly [name: string]: string | undefined };
}

/**
 * How to restart a packaged Linux launch that came up without a display
 * backend. Only the desktop entries pass the switch; a terminal `sai-atlas`
 * and an AppImage opened directly do not. An AppImage restarts through its
 * file, because the mount its binary runs from goes away when it exits. The
 * switch goes first: Chromium stops reading switches at a `--`. Null when the
 * launch chose a backend, is itself a display restart, is a dev run, or is not
 * on Linux.
 */
export function displayRestart(launch: DisplayRestartLaunch): { execPath: string; args: string[] } | null {
	if (launch.platform !== "linux" || !launch.packaged || launch.env[DISPLAY_RESTART_ENV]) return null;
	if (launch.argv.some(arg => arg.startsWith(OZONE_PLATFORM_PREFIX))) return null;
	const appImage = linuxPackageKind(launch.env, launch.execPath, undefined) === "appimage" && launch.env.APPIMAGE;
	if (appImage) {
		return {
			execPath: appImage,
			args: [...appImageRuntimeArgs(launch.env), LINUX_DISPLAY_SWITCH, ...launch.argv.slice(1)],
		};
	}
	return { execPath: launch.execPath, args: [LINUX_DISPLAY_SWITCH, ...launch.argv.slice(1)] };
}

/**
 * `args` after the current process's `--ozone-platform` choice on Linux, or
 * XWayland when it made none; first, because Chromium stops reading switches
 * at a `--`. An `args` that already picks a backend, and every other
 * platform, comes back unchanged.
 */
export function relaunchArgs(
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	argv: readonly string[] = process.argv,
): string[] {
	if (platform !== "linux" || args.some(arg => arg.startsWith(OZONE_PLATFORM_PREFIX))) return [...args];
	const current = argv.findLast(arg => arg.startsWith(OZONE_PLATFORM_PREFIX));
	return [current ?? LINUX_DISPLAY_SWITCH, ...args];
}
