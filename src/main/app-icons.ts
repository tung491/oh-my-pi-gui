/**
 * Tray and window icon choices per platform, kept free of Electron so they are
 * testable. macOS status items are template images (the system recolors
 * them); Ubuntu's AppIndicator shows pixels as drawn on a top bar that is dark
 * in both themes, so Linux gets a white mark. The mark's shape is the Sai ATLAS
 * silhouette, rendered into ../shared/tray-mark by scripts/gen-icons.ts.
 */
import { join } from "node:path";
import { TRAY_MARK_ALPHA, TRAY_MARK_SIZE } from "../shared/tray-mark";

export interface TrayBitmap {
	/** 32-bit pixels, size×size, for nativeImage.createFromBuffer. */
	readonly pixels: Buffer;
	readonly size: number;
	readonly scaleFactor: number;
	readonly template: boolean;
}

const TRAY_MARK = Buffer.from(TRAY_MARK_ALPHA, "base64");

export function trayIconBitmap(platform: NodeJS.Platform): TrayBitmap {
	// The mark is 18pt drawn at 2× so it stays crisp on HiDPI displays. The run
	// status is text (tooltip + menu header), never painted into the mark.
	const scaleFactor = 2;
	const size = TRAY_MARK_SIZE;
	const channel = platform === "linux" ? 255 : 0;
	const pixels = Buffer.alloc(size * size * 4, 0);
	for (let index = 0; index < size * size; index++) {
		const alpha = TRAY_MARK[index];
		if (alpha === 0) continue;
		pixels[index * 4] = channel;
		pixels[index * 4 + 1] = channel;
		pixels[index * 4 + 2] = channel;
		pixels[index * 4 + 3] = alpha;
	}
	return { pixels, size, scaleFactor, template: platform !== "linux" };
}

/** X11 window/taskbar icon for Linux; macOS and Windows take it from the bundle. */
export function linuxWindowIconPath(
	platform: NodeJS.Platform,
	packaged: boolean,
	resourcesPath: string,
	appPath: string,
): string | undefined {
	if (platform !== "linux") return undefined;
	return packaged ? join(resourcesPath, "icon.png") : join(appPath, "resources", "icon.png");
}
