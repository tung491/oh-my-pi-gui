/**
 * The macOS update floor in the release's `latest-mac.yml`.
 *
 * The Tauri app needs macOS 13.3, the first release with Safari 16.4's WebKit
 * (`bundle.macOS.minimumSystemVersion` in `src-tauri/tauri.macos.conf.json`).
 * The updater skips an update whose `minimumSystemVersion` is above the Darwin
 * kernel release, not the macOS version, so the field must read `22.4.0`
 * (Darwin 22.4 = macOS 13.3), not `13.3`. Without it older Macs download a
 * build they cannot open.
 */

import { parse } from "yaml";

/** Darwin 22.4 is macOS 13.3, the oldest macOS the Tauri app supports. */
export const MAC_UPDATE_FLOOR = "22.4.0";

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
		return `latest-mac.yml minimumSystemVersion is ${version}, below the Darwin floor ${MAC_UPDATE_FLOOR} (macOS 13.3); it is compared with os.release(), not the macOS version`;
	}
	return null;
}
