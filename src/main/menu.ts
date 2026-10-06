/**
 * Native application menu for the omp GUI.
 */
import { app, Menu, shell } from "electron";
import { IPC_EVENTS, type MenuAction } from "../shared/ipc-types";
import { getMainLanguage, mainT } from "./i18n";
import { appMenuTemplate } from "./menu-template";
import type { SpawnWindow, WindowManager } from "./window";

function sendMenuAction(windowManager: WindowManager, spawnWindow: SpawnWindow, action: MenuAction): void {
	const win = windowManager.getTargetWindow();
	if (win) {
		win.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
		return;
	}
	// No windows open (macOS keep-running): spawn one and deliver once its
	// renderer is up, instead of dropping the action silently.
	const created = spawnWindow();
	created?.once("ready-to-show", () => {
		if (!created.isDestroyed()) created.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
	});
}

export function createMenu(windowManager: WindowManager, spawnWindow: SpawnWindow): void {
	const language = getMainLanguage();
	const template = appMenuTemplate(process.platform, key => mainT(key, language), {
		appName: app.name,
		send: action => sendMenuAction(windowManager, spawnWindow, action),
		newWindow: () => {
			// Open a parallel window in the target window's project (its
			// sidecar keeps running untouched in the current window). With no
			// project to inherit, spawn without a cwd: that is the request for
			// the GUI-owned workspace, whereas the process cwd is "/" for an
			// app launched from Finder.
			const win = windowManager.getTargetWindow();
			spawnWindow(win ? windowManager.recordFor(win)?.cwd : undefined);
		},
		closeWindow: () => windowManager.getTargetWindow()?.close(),
		showAbout: () => app.showAboutPanel(),
		openDocumentation: () => void shell.openExternal("https://github.com/tung491/oh-my-pi-gui"),
	});
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
