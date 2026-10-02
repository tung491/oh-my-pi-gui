/**
 * Write-through storage contract: each renderer storage key is written to
 * localStorage and mirrored, as the same string, to the nested prefs path
 * `rendererStorage.<key>` that a native shell reads back to seed a fresh
 * webview origin. The mirror is best-effort: no bridge or a failed prefs
 * write never throws and never loses the localStorage value.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { mirrorAllToPrefs, writePersisted } from "./persisted-storage";

interface PrefsMock {
	get: Mock<(key: string) => Promise<unknown>>;
	set: Mock<(key: string, value: unknown) => Promise<void>>;
}

const globals = globalThis as Record<string, unknown>;
let storage: Record<string, string>;

function installPrefs(set: (key: string, value: unknown) => Promise<void> = async () => {}): PrefsMock {
	const prefs: PrefsMock = {
		get: vi.fn(async (_key: string) => undefined),
		set: vi.fn(set),
	};
	// Node test env has no preload bridge; install the mock OmpApi on a global window.
	globals.window = { omp: { prefs } };
	return prefs;
}

beforeEach(() => {
	storage = {};
	globals.localStorage = {
		getItem: (key: string) => storage[key] ?? null,
		setItem: (key: string, value: string) => {
			storage[key] = value;
		},
		removeItem: (key: string) => {
			delete storage[key];
		},
	};
});

afterEach(() => {
	delete globals.localStorage;
	delete globals.window;
});

describe("persisted storage", () => {
	it("writes localStorage and mirrors to the nested prefs path", () => {
		const prefs = installPrefs();
		writePersisted("omp.lang", "vi");
		expect(prefs.set).toHaveBeenCalledWith("rendererStorage.omp.lang", "vi");
		expect(localStorage.getItem("omp.lang")).toBe("vi");
	});

	it("skips the mirror when window.omp is missing", () => {
		globals.window = {};
		expect(() => writePersisted("omp.dock.focusHeight", "320")).not.toThrow();
		expect(localStorage.getItem("omp.dock.focusHeight")).toBe("320");
	});

	it("mirrorAllToPrefs copies only present keys", () => {
		storage["omp.themeScheme"] = "dark";
		storage["omp.palette.recent"] = JSON.stringify(["model"]);
		const prefs = installPrefs();
		mirrorAllToPrefs();
		expect(prefs.set).toHaveBeenCalledTimes(2);
		expect(prefs.set).toHaveBeenCalledWith("rendererStorage.omp.themeScheme", "dark");
		expect(prefs.set).toHaveBeenCalledWith("rendererStorage.omp.palette.recent", '["model"]');
	});

	it("swallows a rejected prefs write", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const prefs = installPrefs(async () => {
				throw new Error("prefs store unavailable");
			});
			expect(() => writePersisted("omp.update.dismissed", '{"version":"1.2.3"}')).not.toThrow();
			expect(prefs.set).toHaveBeenCalledOnce();
			// Let the rejection settle and any unhandled-rejection event fire.
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(unhandled).not.toHaveBeenCalled();
			expect(localStorage.getItem("omp.update.dismissed")).toBe('{"version":"1.2.3"}');
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
});
