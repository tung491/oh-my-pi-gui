/**
 * Chart palette contract: series colors are resolved from the active theme's
 * tokens and re-resolved after a theme switch instead of freezing at module
 * load. DOM via linkedom — applyThemeByName writes tokens inline on <html>,
 * and linkedom computes no stylesheet, so computed style reads the inline map.
 */

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chartColors } from "./chart";
import { applyThemeByName, THEMES } from "./themes";

const { document } = parseHTML("<html><head></head><body></body></html>");
(globalThis as unknown as Record<string, unknown>).document = document;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("chartColors", () => {
	it("re-reads series colors after a theme switch", () => {
		vi.stubGlobal("window", { omp: { prefs: { set: () => Promise.resolve() } } });
		vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);

		applyThemeByName("light");
		const light = chartColors();
		applyThemeByName("dark");
		const dark = chartColors();

		expect(light[0]).toBe(THEMES.light.tokens["--omp-accent"]);
		expect(dark[0]).toBe(THEMES.dark.tokens["--omp-accent"]);
		expect(dark).not.toEqual(light);
	});
});
