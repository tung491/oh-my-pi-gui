/** The platform whose default-open behavior decides what counts as a program. */
export type LaunchPlatform = "mac" | "linux" | "windows";

/** Maps a Node `process.platform` name; anything not macOS or Windows opens files the Linux way. */
export function launchPlatformOf(nodePlatform: string): LaunchPlatform {
	if (nodePlatform === "darwin") return "mac";
	return nodePlatform === "win32" ? "windows" : "linux";
}

/**
 * Extensions the OS default handler runs or launches instead of opening for
 * editing, on every platform: scripts, macOS Terminal/URL/location launchers,
 * Java Web Start, Python (the py.exe launcher on Windows, Python Launcher on
 * macOS), and binary programs and installers (Wine runs `.exe` on Linux).
 * macOS application bundles are folders, so `launchesWhenOpened` checks `.app`.
 */
const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
	".appimage",
	".bat",
	".cmd",
	".command",
	".desktop",
	".exe",
	".fileloc",
	".inetloc",
	".jar",
	".jnlp",
	".mpkg",
	".pkg",
	".ps1",
	".py",
	".sh",
	".terminal",
	".tool",
	".vbe",
	".vbs",
	".webloc",
	".wsf",
	".wsh",
]);

/**
 * Extra extensions the Windows shell runs or launches on open: Windows Script
 * Host, HTML applications and compiled help, DOS programs and screen savers,
 * windowed, zipped, and compiled Python, shortcuts and Internet shortcuts,
 * installers and Control Panel items, MMC snap-ins, Remote Desktop, ClickOnce,
 * Explorer command/library/search-connector files, registry imports, setup
 * information, and scriptlets.
 */
const WINDOWS_PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
	".appref-ms",
	".application",
	".chm",
	".com",
	".cpl",
	".hta",
	".inf",
	".js",
	".jse",
	".library-ms",
	".lnk",
	".msc",
	".msi",
	".msp",
	".pif",
	".pyc",
	".pyo",
	".pyw",
	".pyz",
	".pyzw",
	".rdp",
	".reg",
	".scf",
	".scr",
	".sct",
	".searchconnector-ms",
	".url",
	".website",
	".wsc",
]);

/** The lowercased extension of the last path segment, never of a folder above it. */
function extensionOf(path: string, platform: LaunchPlatform): string {
	let name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
	// Windows drops trailing dots and spaces, so "run.bat. " opens as "run.bat".
	if (platform === "windows") name = name.replace(/[. ]+$/, "");
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot);
}

/** Whether opening this path with the OS default handler would run it, judged by its name. */
export function opensAsProgram(path: string, platform: LaunchPlatform): boolean {
	const extension = extensionOf(path, platform);
	return PROGRAM_EXTENSIONS.has(extension) || (platform === "windows" && WINDOWS_PROGRAM_EXTENSIONS.has(extension));
}

/**
 * Whether handing this existing path to the OS default handler would launch it
 * rather than show it: a launcher by name, or, on macOS, an application bundle
 * (a folder named `.app`) or an executable regular file (Launch Services runs
 * one without an extension in Terminal). Elsewhere the executable bit is left
 * out: the default handler picks by type, and FAT/NTFS mounts mark every file
 * executable. Pass a canonical path: a trailing separator or dot segment hides
 * the last name.
 */
export function launchesWhenOpened(
	path: string,
	file: { isFile: boolean; mode: number },
	platform: LaunchPlatform,
): boolean {
	if (opensAsProgram(path, platform)) return true;
	if (platform !== "mac") return false;
	if (!file.isFile) return extensionOf(path, platform) === ".app";
	return (file.mode & 0o111) !== 0;
}
