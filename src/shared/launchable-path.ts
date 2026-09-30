/** The platform whose default-open behavior decides what counts as a program. */
export type LaunchPlatform = "mac" | "linux" | "windows";

/**
 * Extensions the OS default handler runs or launches instead of opening for
 * editing, on every platform: scripts, macOS Terminal/URL/location launchers,
 * Java Web Start, Python (the py.exe launcher on Windows, Python Launcher on
 * macOS), and binary programs and installers (Wine runs `.exe` on Linux).
 */
const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
	".app",
	".appimage",
	".bat",
	".cmd",
	".com",
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
	".scr",
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
 * Host, HTML applications, windowed Python, shortcuts and Internet shortcuts,
 * installers and Control Panel items, MMC snap-ins, Remote Desktop, ClickOnce,
 * Explorer command/library/search-connector files, registry imports, setup
 * information, and scriptlets.
 */
const WINDOWS_PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
	".appref-ms",
	".application",
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
	".pyw",
	".rdp",
	".reg",
	".scf",
	".sct",
	".searchconnector-ms",
	".url",
	".website",
	".wsc",
]);

/** Whether opening this path with the OS default handler would run it; reads the last path segment only, never a folder above it. */
export function opensAsProgram(path: string, platform: LaunchPlatform): boolean {
	let name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
	// Windows drops trailing dots and spaces, so "run.bat. " opens as "run.bat".
	if (platform === "windows") name = name.replace(/[. ]+$/, "");
	const dot = name.lastIndexOf(".");
	if (dot < 0) return false;
	const extension = name.slice(dot);
	return PROGRAM_EXTENSIONS.has(extension) || (platform === "windows" && WINDOWS_PROGRAM_EXTENSIONS.has(extension));
}

/**
 * Whether handing this existing path to the OS default handler would launch it
 * rather than show it: a launcher by name, or, on macOS, an executable regular
 * file (Launch Services runs one without an extension in Terminal). Elsewhere
 * the executable bit is left out: the default handler picks by type, and
 * FAT/NTFS mounts mark every file executable.
 */
export function launchesWhenOpened(
	path: string,
	file: { isFile: boolean; mode: number },
	platform: LaunchPlatform,
): boolean {
	if (opensAsProgram(path, platform)) return true;
	return platform === "mac" && file.isFile && (file.mode & 0o111) !== 0;
}
