/**
 * System tray with a quick-access menu: live config info (model / thinking
 * / fast / approval, read-only), token consumption, workspace jumping, a new
 * session, quick-config toggles and a language toggle. The renderer pushes a
 * TrayState snapshot on every relevant change; main installs a new native menu
 * only when a visible label actually changes, and never while one is open.
 * Actions route back to the renderer via MENU_ACTION (it owns the RPC + i18n +
 * UI stores).
 */

import { app, Menu, nativeImage, Tray } from "electron";
import { IPC_EVENTS, type MenuAction, type MenuActionPayload, type TrayState } from "../shared/ipc-types";
import { PRODUCT_NAME } from "../shared/product";
import { trayIconBitmap } from "./app-icons";
import { menuSignature, trayMenuTemplate, trayTooltip } from "./tray-labels";
import type { SpawnWindow, WindowManager } from "./window";

let tray: Tray | null = null;
let windowManagerRef: WindowManager | null = null;
let spawnWindowRef: SpawnWindow | null = null;
let trayState: TrayState | null = null;
/** Label set the currently installed native menu renders, and whether it is open. */
let installedSignature: string | null = null;
let menuIsOpen = false;
let tooltip = PRODUCT_NAME;

function buildIcon(): Electron.NativeImage {
	const bitmap = trayIconBitmap(process.platform);
	const image = nativeImage.createFromBuffer(bitmap.pixels, {
		width: bitmap.size,
		height: bitmap.size,
		scaleFactor: bitmap.scaleFactor,
	});
	if (bitmap.template) image.setTemplateImage(true);
	return image;
}

function send(windowManager: WindowManager, action: MenuAction, payload?: MenuActionPayload): void {
	const win = windowManager.getTargetWindow();
	if (win) {
		win.show();
		win.focus();
		win.webContents.send(IPC_EVENTS.MENU_ACTION, { action, ...payload });
		return;
	}
	// All windows closed (macOS keep-running): create one and deliver the
	// action once the renderer is up instead of dropping it.
	const created = spawnWindowRef?.();
	if (!created) return;
	created.once("ready-to-show", () => {
		if (!created.isDestroyed()) {
			created.webContents.send(IPC_EVENTS.MENU_ACTION, { action, ...payload });
		}
	});
}

function buildContextMenu(windowManager: WindowManager, state: TrayState | null): Electron.Menu {
	return Menu.buildFromTemplate(
		trayMenuTemplate(state, {
			send: (action, payload) => send(windowManager, action, payload),
			// Show / Hide targets the focused window, not the first-created one,
			// so the toggle acts on the window the user is looking at.
			showHide: () => {
				const win = windowManager.getTargetWindow();
				if (win?.isVisible()) win.hide();
				else if (win) win.show();
				else spawnWindowRef?.();
			},
			quit: () => app.quit(),
		}),
	);
}

/**
 * Install a menu built from the current snapshot. The instance remembers whether
 * the user has it open: a push that lands mid-open is recorded but not installed
 * (replacing the menu underneath dismisses it), and flushes when it closes.
 */
function installMenu(): void {
	if (!tray || !windowManagerRef) return;
	const state = trayState;
	installedSignature = state ? menuSignature(state) : null;
	const menu = buildContextMenu(windowManagerRef, state);
	menu.on("menu-will-show", () => {
		menuIsOpen = true;
	});
	menu.on("menu-will-close", () => {
		menuIsOpen = false;
		if (trayState && menuSignature(trayState) !== installedSignature) installMenu();
	});
	tray.setContextMenu(menu);
}

export function createTray(windowManager: WindowManager, spawnWindow: SpawnWindow): Tray {
	windowManagerRef = windowManager;
	spawnWindowRef = spawnWindow;
	tray = new Tray(buildIcon());
	tray.setToolTip(trayTooltip(null));
	installMenu();

	tray.on("click", () => {
		const win = windowManager.getTargetWindow();
		if (win) {
			win.show();
			win.focus();
		} else {
			spawnWindowRef?.();
		}
	});

	return tray;
}

/**
 * Renderer pushed a fresh snapshot. Hover text tracks the status; the native
 * menu is rebuilt only when a label a user can read actually changed, so the
 * per-append session refresh stops swapping menus.
 */
export function setTrayState(state: TrayState): void {
	trayState = state;
	const nextTooltip = trayTooltip(state);
	if (nextTooltip !== tooltip && tray) {
		tooltip = nextTooltip;
		tray.setToolTip(nextTooltip);
	}
	if (menuIsOpen || menuSignature(state) === installedSignature) return;
	installMenu();
}

export function destroyTray(): void {
	tray?.destroy();
	tray = null;
	windowManagerRef = null;
	trayState = null;
	installedSignature = null;
	menuIsOpen = false;
	tooltip = PRODUCT_NAME;
}
