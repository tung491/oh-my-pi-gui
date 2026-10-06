/**
 * The application menu sends only the everyday actions to the renderer: the
 * developer surfaces it used to open are gone from the product, so a menu item
 * for one would open nothing.
 */
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import type { MenuAction } from "../shared/ipc-types";
import { appMenuTemplate } from "./menu-template";

const EVERYDAY_ACTIONS: MenuAction[] = [
	"close-tab",
	"export-html",
	"new-session",
	"new-tab",
	"open-agent-hub",
	"open-capabilities",
	"open-command-center",
	"open-hotkeys",
	"open-jobs",
	"open-model-picker",
	"open-providers",
	"open-session-info",
	"open-settings",
	"restart-sidecar",
	"toggle-panel",
	"toggle-sidebar",
];

const DEVELOPER_ACTIONS: readonly string[] = [
	"new-chat-tab",
	"open-branch-picker",
	"open-context-report",
	"open-debug",
	"open-extensions",
	"open-git",
	"open-import",
	"open-inventory",
	"open-model-roles",
	"open-modes",
	"open-pr-center",
	"open-project",
	"open-session-tree",
	"open-share-session",
	"open-stats",
	"open-usage",
	"open-workspace-dirs",
	"handoff",
];

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
	return items.flatMap(item => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

/** Click every item of the menu bar and collect the actions that reach the renderer. */
function menuActions(platform: NodeJS.Platform): Set<string> {
	const sent = new Set<string>();
	const template = appMenuTemplate(platform, key => key, {
		appName: "Sai ATLAS",
		send: action => sent.add(action),
		newWindow: () => {},
		closeWindow: () => {},
		showAbout: () => {},
		openDocumentation: () => {},
	});
	for (const item of flatten(template)) item.click?.(undefined as never, undefined as never, undefined as never);
	return sent;
}

describe("application menu", () => {
	it("app menu offers no developer actions and keeps the everyday actions", () => {
		for (const platform of ["linux", "darwin"] as const) {
			const actions = menuActions(platform);
			for (const removed of DEVELOPER_ACTIONS) expect(actions.has(removed), `${platform}: ${removed}`).toBe(false);
			expect([...actions].sort()).toEqual([...EVERYDAY_ACTIONS].sort());
		}
	});
});
