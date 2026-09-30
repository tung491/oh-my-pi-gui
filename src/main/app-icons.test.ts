import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { linuxWindowIconPath, type TrayBitmap, trayIconBitmap } from "./app-icons";
import { TRAY_MARK_SOURCE_SHA256 } from "./tray-mark";

function pixel(bitmap: TrayBitmap, x: number, y: number): number[] {
	const index = (y * bitmap.size + x) * 4;
	return [...bitmap.pixels.subarray(index, index + 4)];
}

function alphaAt(bitmap: TrayBitmap, index: number): number {
	return bitmap.pixels[index * 4 + 3];
}

/** Every drawn pixel carries the platform's ink; the rest stay fully transparent. */
function expectInk(bitmap: TrayBitmap, channel: number): void {
	for (let index = 0; index < bitmap.size * bitmap.size; index++) {
		const [r, g, b, a] = bitmap.pixels.subarray(index * 4, index * 4 + 4);
		if (a > 0) expect([r, g, b], `pixel ${index}`).toEqual([channel, channel, channel]);
		else expect([r, g, b], `pixel ${index}`).toEqual([0, 0, 0]);
	}
}

function opaqueShare(bitmap: TrayBitmap): number {
	let opaque = 0;
	for (let index = 0; index < bitmap.size * bitmap.size; index++) if (alphaAt(bitmap, index) > 0) opaque++;
	return opaque / (bitmap.size * bitmap.size);
}

function expectClearCorners(bitmap: TrayBitmap): void {
	const last = bitmap.size - 1;
	for (const [x, y] of [
		[0, 0],
		[last, 0],
		[0, last],
		[last, last],
	])
		expect(pixel(bitmap, x, y)).toEqual([0, 0, 0, 0]);
}

describe("trayIconBitmap", () => {
	it("keeps the macOS menu-bar mark a black template image", () => {
		const bitmap = trayIconBitmap("darwin");
		expect(bitmap).toMatchObject({ size: 36, scaleFactor: 2, template: true });
		expect(bitmap.pixels.length).toBe(36 * 36 * 4);
		expectInk(bitmap, 0);
		expectClearCorners(bitmap);
		expect(opaqueShare(bitmap)).toBeGreaterThan(0.15);
		expect(opaqueShare(bitmap)).toBeLessThan(0.6);
	});

	it("paints the same mark white for the dark Ubuntu top bar", () => {
		const bitmap = trayIconBitmap("linux");
		expect(bitmap).toMatchObject({ size: 36, scaleFactor: 2, template: false });
		expectInk(bitmap, 255);
		expectClearCorners(bitmap);
		const darwin = trayIconBitmap("darwin");
		for (let index = 0; index < bitmap.size * bitmap.size; index++) {
			expect(alphaAt(bitmap, index)).toBe(alphaAt(darwin, index));
		}
	});

	it("leaves the Windows tray bitmap exactly as macOS draws it", () => {
		expect(trayIconBitmap("win32")).toEqual(trayIconBitmap("darwin"));
	});

	it("was rendered from the current tray artwork", () => {
		// Editing resources/tray-source.svg without `bun run gen:icons` fails here.
		const source = readFileSync(path.join(__dirname, "..", "..", "resources", "tray-source.svg"));
		expect(createHash("sha256").update(source).digest("hex")).toBe(TRAY_MARK_SOURCE_SHA256);
	});
});

describe("linuxWindowIconPath", () => {
	it("points packaged Linux windows at the bundled icon", () => {
		expect(linuxWindowIconPath("linux", true, "/opt/Sai ATLAS/resources", "/opt/Sai ATLAS/resources/app.asar")).toBe(
			"/opt/Sai ATLAS/resources/icon.png",
		);
	});

	it("uses the checkout icon in a dev run", () => {
		expect(linuxWindowIconPath("linux", false, "/electron/resources", "/src/gui")).toBe(
			"/src/gui/resources/icon.png",
		);
	});

	it("leaves macOS and Windows to their bundle icons", () => {
		expect(linuxWindowIconPath("darwin", true, "/r", "/a")).toBeUndefined();
		expect(linuxWindowIconPath("win32", true, "/r", "/a")).toBeUndefined();
	});
});
