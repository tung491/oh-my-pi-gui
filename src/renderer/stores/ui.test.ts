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
