import { describe, expect, it } from "vitest";
import { linuxWindowIconPath, type TrayBitmap, trayIconBitmap } from "./app-icons";

function pixel(bitmap: TrayBitmap, x: number, y: number): number[] {
	const index = (y * bitmap.size + x) * 4;
	return [...bitmap.pixels.subarray(index, index + 4)];
}

function opaquePixels(bitmap: TrayBitmap): number {
	let count = 0;
	for (let index = 3; index < bitmap.pixels.length; index += 4) if (bitmap.pixels[index] === 255) count++;
	return count;
}

describe("trayIconBitmap", () => {
	it("keeps the macOS menu-bar mark a black template image", () => {
		const bitmap = trayIconBitmap("darwin");
		expect(bitmap).toMatchObject({ size: 36, scaleFactor: 2, template: true });
		expect(pixel(bitmap, 16, 8)).toEqual([0, 0, 0, 255]);
		expect(pixel(bitmap, 18, 20)).toEqual([0, 0, 0, 0]);
		expect(opaquePixels(bitmap)).toBe(434);
	});

	it("paints the same mark white for the dark Ubuntu top bar", () => {
		const bitmap = trayIconBitmap("linux");
		expect(bitmap).toMatchObject({ size: 36, scaleFactor: 2, template: false });
		for (const [x, y] of [
			[16, 8],
			[12, 20],
			[24, 15],
			[20, 26],
		]) {
			expect(pixel(bitmap, x, y)).toEqual([255, 255, 255, 255]);
		}
		for (const [x, y] of [
			[18, 20],
			[0, 0],
			[35, 35],
		])
			expect(pixel(bitmap, x, y)).toEqual([0, 0, 0, 0]);
		expect(opaquePixels(bitmap)).toBe(434);
	});

	it("leaves the Windows tray bitmap exactly as macOS draws it", () => {
		expect(trayIconBitmap("win32")).toEqual(trayIconBitmap("darwin"));
	});
});

describe("linuxWindowIconPath", () => {
	it("points packaged Linux windows at the bundled icon", () => {
		expect(linuxWindowIconPath("linux", true, "/opt/omp/resources", "/opt/omp/resources/app.asar")).toBe(
			"/opt/omp/resources/icon.png",
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
