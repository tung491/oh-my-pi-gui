import { promises as fsp } from "node:fs";
import { type LaunchPlatform, launchesWhenOpened } from "../shared/launchable-path";

/** The filesystem calls the decision needs; injected so tests can model symlinks and short names. */
export interface OpenPathFs {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<{ isFile(): boolean; mode: number }>;
}

/** How to hand a path to the OS: open it, or only reveal it because its default handler would run it. */
export interface OpenPathTarget {
	action: "open" | "reveal";
	/** The canonical path, which is what gets opened or revealed. */
	path: string;
}

/**
 * Decides how to hand an existing absolute path to the OS default handler, or
 * returns null when it does not exist. Both the requested name and the
 * canonical one are judged: a symlink or a Windows short name can hide the
 * launcher's real extension, and a trailing separator or dot segment hides the
 * last name of the requested path.
 */
export async function openPathTarget(
	requested: string,
	platform: LaunchPlatform,
	fs: OpenPathFs = fsp,
): Promise<OpenPathTarget | null> {
	const canonical = await fs.realpath(requested).catch(() => null);
	if (canonical === null) return null;
	const stats = await fs.stat(canonical).catch(() => null);
	if (!stats) return null;
	const file = { isFile: stats.isFile(), mode: stats.mode };
	const launches = launchesWhenOpened(requested, file, platform) || launchesWhenOpened(canonical, file, platform);
	return { action: launches ? "reveal" : "open", path: canonical };
}
