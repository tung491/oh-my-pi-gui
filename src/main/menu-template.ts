/**
 * The application menu as a pure template: the labels, the chord rule and the
 * renderer actions each item sends. `menu.ts` binds the handlers to electron.
 */
import type { MenuItemConstructorOptions } from "electron";
import { nativeAccelerator } from "../shared/hotkeys";
import type { MenuAction } from "../shared/ipc-types";
import type { MainTextKey } from "./i18n";

export interface AppMenuHandlers {
	appName: string;
	/** Route an action to the renderer, which owns the RPC, i18n and UI stores. */
	send(action: MenuAction): void;
	newWindow(): void;
	closeWindow(): void;
	showAbout(): void;
	openDocumentation(): void;
}

export function appMenuTemplate(
	platform: NodeJS.Platform,
	t: (key: MainTextKey) => string,
	handlers: AppMenuHandlers,
): MenuItemConstructorOptions[] {
	const darwin = platform === "darwin";
	// Chord rule: a shortcut the renderer keymap owns must NOT also be a menu
	// accelerator. Electron resolves menu accelerators before the keydown reaches
	// the webContents, so the duplicate would fire while the user's remap of the
	// same action stayed dead. Menu-only chords live in shared/hotkeys.ts, which
	// the keymap reads as reserved.
	return [
		...(darwin
			? [
					{
						label: handlers.appName,
						submenu: [
							{ role: "about" as const },
							{
								label: t("menu.settings"),
								// No accelerator: ⌘, (and its ⌃, twin) belong to the renderer
								// keymap so users can remap them.
								click: () => handlers.send("open-settings"),
							},
							{ type: "separator" as const },
							{ role: "services" as const },
							{ type: "separator" as const },
							{ role: "hide" as const },
							{ role: "hideOthers" as const },
							{ role: "unhide" as const },
							{ type: "separator" as const },
							{ role: "quit" as const },
						],
					},
				]
			: []),
		{
			label: t("menu.file"),
			submenu: [
				{
					label: t("menu.newSession"),
					accelerator: nativeAccelerator("session.new"),
					click: () => handlers.send("new-session"),
				},
				{
					// No accelerator: ⌘T/⇧⌘T live in the renderer keymap so users can
					// remap them. A menu accelerator would fire first and make the
					// remappable chords dead.
					label: t("menu.newTab"),
					click: () => handlers.send("new-tab"),
				},
				{
					label: t("menu.newWindow"),
					accelerator: nativeAccelerator("window.new"),
					click: () => handlers.newWindow(),
				},
				...(darwin
					? []
					: [
							{ type: "separator" as const },
							{
								label: t("menu.settings"),
								// No accelerator: the renderer keymap owns ⌘, so users can remap it.
								click: () => handlers.send("open-settings"),
							},
						]),
			],
		},
		{
			label: t("menu.edit"),
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: t("menu.view"),
			submenu: [
				{
					label: t("menu.commandCenter"),
					click: () => handlers.send("open-command-center"),
				},
				{
					label: t("menu.jobs"),
					click: () => handlers.send("open-jobs"),
				},
				{
					label: t("menu.hotkeys"),
					click: () => handlers.send("open-hotkeys"),
				},
				{ type: "separator" },
				{
					label: t("menu.toggleSidebar"),
					// No accelerator: ⌘B/⌃B belong to the renderer keymap.
					click: () => handlers.send("toggle-sidebar"),
				},
				{
					label: t("menu.togglePanel"),
					// No accelerator: ⌘J/⌃J belong to the renderer keymap.
					click: () => handlers.send("toggle-panel"),
				},
				{ type: "separator" },
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			// The macOS habit this serves: ⌘W closes a TAB, ⇧⌘W closes the window.
			// `{ role: "close" }` in File was window-level, so the first ⌘W killed
			// the whole window — every tab and sidecar in it.
			label: t("menu.window"),
			submenu: [
				{
					label: t("menu.closeTab"),
					// No accelerator: ⌘W belongs to the renderer keymap so users can
					// remap it; a menu accelerator would fire first (precedent: ⌘T).
					click: () => handlers.send("close-tab"),
				},
				{
					label: t("menu.closeWindow"),
					accelerator: nativeAccelerator("window.close"),
					click: () => handlers.closeWindow(),
				},
				{ type: "separator" },
				{ role: "minimize" },
				...(darwin ? [{ role: "zoom" as const }, { type: "separator" as const }, { role: "front" as const }] : []),
			],
		},
		{
			label: t("menu.session"),
			submenu: [
				{
					label: t("menu.sessionInfo"),
					click: () => handlers.send("open-session-info"),
				},
				{
					label: t("menu.exportHtml"),
					accelerator: nativeAccelerator("session.exportHtml"),
					click: () => handlers.send("export-html"),
				},
			],
		},
		{
			label: t("menu.tools"),
			submenu: [
				{
					label: t("menu.agentHub"),
					click: () => handlers.send("open-agent-hub"),
				},
				{
					label: t("menu.providers"),
					click: () => handlers.send("open-providers"),
				},
				{
					label: t("menu.modelPicker"),
					click: () => handlers.send("open-model-picker"),
				},
				{
					label: t("menu.capabilities"),
					click: () => handlers.send("open-capabilities"),
				},
				{ type: "separator" },
				{
					label: t("menu.restartCore"),
					click: () => handlers.send("restart-sidecar"),
				},
			],
		},
		{
			label: t("menu.help"),
			submenu: [
				{
					label: t("menu.about"),
					click: () => handlers.showAbout(),
				},
				{
					label: t("menu.documentation"),
					click: () => handlers.openDocumentation(),
				},
			],
		},
	];
}
