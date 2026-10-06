/**
 * setPanelTab: the workspace drawer carries files + logs in chat and agent
 * tabs alike (todo/plan/agents/queue moved to the center dock), and selecting
 * a tab force-opens the drawer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { useTabsStore } from "./tabs";
import { useUiStore } from "./ui";

function seedActiveTab(kind: "agent" | "chat"): void {
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work", status: "ready", kind, unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

afterEach(() => {
	useTabsStore.getState().reset();
	useUiStore.setState({ panelTab: "files", panelVisible: false });
});

describe("setPanelTab", () => {
	it.each(["chat", "agent"] as const)("opens the files and logs tabs in a %s tab", kind => {
		seedActiveTab(kind);
		useUiStore.setState({ panelTab: "files", panelVisible: false });

		useUiStore.getState().setPanelTab("logs");
		expect(useUiStore.getState().panelTab).toBe("logs");
		expect(useUiStore.getState().panelVisible).toBe(true);

		useUiStore.getState().setPanelTab("files");
		expect(useUiStore.getState().panelTab).toBe("files");
	});
});
