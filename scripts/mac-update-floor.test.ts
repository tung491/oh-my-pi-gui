/**
 * The update metadata must carry the Darwin version of the macOS floor, or
 * macOS 12 installs download a build Electron 44 cannot run.
 */

import { describe, expect, it } from "vitest";
import { macUpdateFloorError } from "./mac-update-floor";

const FILES = `files:
  - url: Sai-ATLAS-1.0.0-arm64.dmg
    sha512: abc
    size: 1
`;

function metadata(floorLine: string): string {
	return `version: 1.0.0\n${FILES}${floorLine}path: Sai-ATLAS-1.0.0-arm64.dmg\nreleaseDate: '2026-10-01T00:00:00.000Z'\n`;
}

describe("macOS update floor", () => {
	it("rejects metadata without the field", () => {
		expect(macUpdateFloorError(metadata(""))).toMatch(/no top-level minimumSystemVersion/);
	});

	it("rejects the macOS version number, which the updater compares with the Darwin version", () => {
		expect(macUpdateFloorError(metadata("minimumSystemVersion: 13.0\n"))).toMatch(/below the Darwin floor/);
	});

	it("rejects a Darwin version older than macOS 13", () => {
		expect(macUpdateFloorError(metadata("minimumSystemVersion: 21.6.0\n"))).toMatch(/below the Darwin floor/);
	});

	it("accepts the floor and anything above it", () => {
		expect(macUpdateFloorError(metadata("minimumSystemVersion: 22.0.0\n"))).toBeNull();
		expect(macUpdateFloorError(metadata("minimumSystemVersion: 23.1.0\n"))).toBeNull();
	});

	it("ignores a minimumSystemVersion nested under files", () => {
		const nested = `version: 1.0.0\nfiles:\n  - url: a.dmg\n    minimumSystemVersion: 22.0.0\n`;
		expect(macUpdateFloorError(nested)).toMatch(/no top-level minimumSystemVersion/);
	});
});
