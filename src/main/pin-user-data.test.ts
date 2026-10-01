/**
 * The profile pin only works as the first thing the main process does: an
 * electron-store opened at import time, or the single-instance lock, caches
 * the userData path on first read.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = __dirname;
const index = fs.readFileSync(path.join(MAIN, "index.ts"), "utf8");
const pin = fs.readFileSync(path.join(MAIN, "pin-user-data.ts"), "utf8");

function importSources(source: string): string[] {
	return Array.from(source.matchAll(/^import\s+(?:[^"';]*?\s+from\s+)?"([^"]+)";/gm), match => match[1]);
}

describe("userData pin", () => {
	it("is the first import of the main entry", () => {
		expect(index.match(/^import\s[^;]*;/m)?.[0]).toBe('import "./pin-user-data";');
	});

	it("takes the single-instance lock before renaming the app", () => {
		const lock = index.indexOf("requestSingleInstanceLock(");
		const rename = index.indexOf("app.setName(");
		expect(lock).toBeGreaterThan(-1);
		expect(rename).toBeGreaterThan(lock);
	});

	it("imports nothing that could read userData first", () => {
		for (const source of importSources(pin)) {
			expect(source === "electron" || source.startsWith("node:") || source === "./user-data-directory", source).toBe(
				true,
			);
		}
	});
});
