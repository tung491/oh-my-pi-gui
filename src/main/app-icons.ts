/**
 * Tray and window icon choices per platform, kept free of Electron so they are
 * testable. macOS status items are template images (the system recolors
 * them); Ubuntu's AppIndicator shows pixels as drawn on a top bar that is dark
 * in both themes, so Linux gets a white mark.
 */
import { join } from "node:path";

export interface TrayBitmap {
	/** 32-bit pixels, size×size, for nativeImage.createFromBuffer. */
	readonly pixels: Buffer;
	readonly size: number;
	readonly scaleFactor: number;
	readonly template: boolean;
}

export function trayIconBitmap(platform: NodeJS.Platform): TrayBitmap {
	// Render at 2× so the small π stays crisp on HiDPI displays. The run status
	// is text (tooltip + menu header), never painted into the mark.
	const logicalSize = 18;
	const scaleFactor = 2;
	const size = logicalSize * scaleFactor;
	const channel = platform === "linux" ? 255 : 0;
	const pixels = Buffer.alloc(size * size * 4, 0);
	const fillRoundedRect = (left: number, top: number, right: number, bottom: number, radius: number) => {
		for (let y = top; y < bottom; y++) {
			for (let x = left; x < right; x++) {
				const nearestX = Math.max(left + radius, Math.min(x + 0.5, right - radius));
				const nearestY = Math.max(top + radius, Math.min(y + 0.5, bottom - radius));
				const dx = x + 0.5 - nearestX;
				const dy = y + 0.5 - nearestY;
				if (dx * dx + dy * dy > radius * radius) continue;
				const index = (y * size + x) * 4;
				pixels[index] = channel;
				pixels[index + 1] = channel;
				pixels[index + 2] = channel;
				pixels[index + 3] = 255;
			}
		}
	};
	// A compact filled π: one cap, two stems and a short inward foot.
	fillRoundedRect(4, 6, 32, 12, 3);
	fillRoundedRect(9, 9, 15, 31, 3);
	fillRoundedRect(21, 9, 28, 27, 3);
	fillRoundedRect(16, 23, 28, 30, 3);
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
