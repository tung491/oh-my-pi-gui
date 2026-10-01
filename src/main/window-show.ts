/**
 * First show of a new window. `ready-to-show` can be dropped (Electron on
 * Wayland with NVIDIA drivers), which would leave the app running with no
 * window, so a timer shows it anyway. Structural so it is testable without
 * Electron.
 */

/** How long a new window may wait for its first paint before it is shown anyway. */
export const WINDOW_SHOW_FALLBACK_MS = 3_000;

export interface ShowableWindow {
	once(event: "ready-to-show" | "closed", listener: () => void): unknown;
	isDestroyed(): boolean;
	show(): void;
}

/**
 * Show `win` on `ready-to-show`, or `fallbackMs` after this call if that never
 * comes. Shows at most once, and never once the window has closed.
 */
export function showWhenReady(win: ShowableWindow, fallbackMs: number = WINDOW_SHOW_FALLBACK_MS): void {
	let settled = false;
	const settle = (show: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (show && !win.isDestroyed()) win.show();
	};
	const timer = setTimeout(() => settle(true), fallbackMs);
	win.once("ready-to-show", () => settle(true));
	win.once("closed", () => settle(false));
}
