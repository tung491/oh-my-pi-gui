/**
 * Restoring persisted UI preferences after developer surfaces were removed:
 * a stored panel tab or hotkey override that names a deleted surface falls
 * back to a kept one (or is dropped) instead of breaking the restore.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { panelTabFromPref, useUiStore } from "./ui";

afterEach(() => {
	delete (globalThis as Record<string, unknown>).window;
	useUiStore.setState({ keymapOverrides: {}, keymapHydrated: false });
});

describe("restored preferences", () => {
	it("restores a stored diff panel tab as the files tab", () => {
		expect(panelTabFromPref("diff")).toBe("files");
		expect(panelTabFromPref("files")).toBe("files");
		expect(panelTabFromPref("logs")).toBe("logs");
		expect(panelTabFromPref("bogus")).toBeNull();
		expect(panelTabFromPref(undefined)).toBeNull();
	});

	it("ignores an override for a deleted hotkey without throwing", async () => {
		(globalThis as Record<string, unknown>).window = {
			omp: {
				prefs: {
					get: vi.fn(async () => ({ "pr.center": ["⌥⇧P"], "tab.newChat": ["⌘⇧T"], retry: ["⌥⇧R"] })),
					set: vi.fn(async () => {}),
				},
			},
		};
		await expect(useUiStore.getState().hydrateKeymap()).resolves.toBeUndefined();
		expect(useUiStore.getState().keymapOverrides).toEqual({ retry: ["⌥⇧R"] });
	});
});

describe("file preview target", () => {
	afterEach(() => {
		useUiStore.setState({ filePreview: null, panelVisible: false, panelTab: "files" });
	});

	it("pins a path preview to the tab that opened it", () => {
		useUiStore.getState().openFilePreview("docs/a.pdf", "t0");
		const state = useUiStore.getState();
		expect(state.filePreview).toEqual({ kind: "path", path: "docs/a.pdf", tabId: "t0" });
		expect(state.panelTab).toBe("files");
		expect(state.panelVisible).toBe(true);
	});

	it("opens an in-memory image as an image target with a fresh id", () => {
		useUiStore.getState().openImagePreview("data:image/png;base64,AA==", "paste.png");
		const first = useUiStore.getState().filePreview;
		expect(first).toMatchObject({ kind: "image", dataUrl: "data:image/png;base64,AA==", name: "paste.png" });
		useUiStore.getState().openImagePreview("data:image/png;base64,AA==", "paste.png");
		const second = useUiStore.getState().filePreview;
		expect(first?.kind === "image" && second?.kind === "image" && first.id !== second.id).toBe(true);
		expect(useUiStore.getState().panelVisible).toBe(true);
	});

	it("keeps the preview when session overlays close with keepFilePreview", () => {
		useUiStore.getState().openFilePreview("a.csv", "t1");
		useUiStore.getState().openSettings();
		useUiStore.getState().closeSessionOverlays({ keepFilePreview: true });
		expect(useUiStore.getState().settingsOpen).toBe(false);
		expect(useUiStore.getState().filePreview).toEqual({ kind: "path", path: "a.csv", tabId: "t1" });
		useUiStore.getState().closeSessionOverlays();
		expect(useUiStore.getState().filePreview).toBeNull();
	});
});
