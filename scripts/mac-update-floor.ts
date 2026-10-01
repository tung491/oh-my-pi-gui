/**
 * The macOS update floor in the release's combined `latest-mac.yml`.
 *
 * Electron 44 runs only on macOS 13+, but electron-builder writes
 * `mac.minimumSystemVersion` into Info.plist alone, never into the update
 * metadata. electron-updater skips an update whose `minimumSystemVersion` is
 * above `os.release()` — on macOS the Darwin kernel version — so the field
 * must read `22.0.0` (Darwin 22 = macOS 13), not `13.0`. Without it every
 * macOS 12 install downloads a build it cannot open.
 */

import { parse } from "yaml";

/** Darwin 22 is macOS 13, the oldest macOS Electron 44 supports. */
export const MAC_UPDATE_FLOOR = "22.0.0";

function versionParts(version: string): number[] | null {
	if (!/^\d+(\.\d+)*$/.test(version)) return null;
	return version.split(".").map(Number);
}

function compareVersions(left: number[], right: number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** Null when the top-level `minimumSystemVersion` is at or above the floor, else why not. */
export function macUpdateFloorError(yaml: string): string | null {
	let metadata: unknown;
	try {
		metadata = parse(yaml);
	} catch (error) {
		return `latest-mac.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`;
	}
	const raw =
		metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).minimumSystemVersion : undefined;
	if (raw === undefined || raw === null) {
		return `latest-mac.yml has no top-level minimumSystemVersion; add "minimumSystemVersion: ${MAC_UPDATE_FLOOR}"`;
	}
	const version = String(raw);
	const parts = versionParts(version);
	const floor = versionParts(MAC_UPDATE_FLOOR) ?? [];
	if (!parts || compareVersions(parts, floor) < 0) {
		return `latest-mac.yml minimumSystemVersion is ${version}, below the Darwin floor ${MAC_UPDATE_FLOOR} (macOS 13); it is compared with os.release(), not the macOS version`;
	}
	return null;
}
