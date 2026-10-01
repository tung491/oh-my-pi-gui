/**
 * Global foundations contract: the bundled type stack, the unchanged type
 * scale, the focus ring, the motion timings, and the layered shared classes.
 * Biome does not lint CSS, so this is the gate that keeps global.css honest.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./global.css", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const TYPE_SCALE = [
	"--text-omp-xxs: calc(var(--gui-font-size, 15px) * 10 / 15);",
	"--text-omp-xs: calc(var(--gui-font-size, 15px) * 11 / 15);",
	"--text-omp-sm: calc(var(--gui-font-size, 15px) * 12 / 15);",
	"--text-omp-md: calc(var(--gui-font-size, 15px) * 13 / 15);",
	"--text-omp-lg: calc(var(--gui-font-size, 15px) * 14 / 15);",
	"--text-omp-xl: calc(var(--gui-font-size, 15px) * 15.5 / 15);",
];

const FOCUS_GLOW = "0 0 0 4px var(--omp-accent-glow)";

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("global foundations", () => {
	it("bundles the Poppins display weights from the local package", () => {
		expect(css).toContain('@import "@fontsource/poppins/500.css";');
		expect(css).toContain('@import "@fontsource/poppins/600.css";');
		expect(css).toContain('@import "@fontsource/poppins/700.css";');
	});

	it("leads the display stack with Poppins and keeps the CJK fallbacks", () => {
		const match = css.match(/^\s*--font-display:\s*(.+)$/m);
		expect(match).not.toBeNull();
		const value = match?.[1] ?? "";
		expect(value.startsWith('"Poppins",')).toBe(true);
		expect(value).toContain('"PingFang SC"');
	});

	it("keeps the text-omp type scale exactly as it was", () => {
		const scale = css
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("--text-omp-"));
		expect(scale).toEqual(TYPE_SCALE);
	});

	it("keeps the unlayered outline ring and adds the glow only in the base layer", () => {
		expect(css).toMatch(
			/^:focus-visible \{\n\toutline: 2px solid var\(--omp-accent\);\n\toutline-offset: 1px;\n\tborder-radius: 4px;\n\}/m,
		);
		const layered = css.match(
			/@layer base \{\s*:where\(:focus-visible\) \{\s*box-shadow: 0 0 0 4px var\(--omp-accent-glow\);\s*\}\s*\}/,
		);
		expect(layered).not.toBeNull();
		expect(countOccurrences(css, FOCUS_GLOW)).toBe(1);
	});

	it("uses the VIF motion timings", () => {
		expect(css).toContain("--omp-motion-fast: 120ms;");
		expect(css).toContain("--omp-motion-med: 180ms;");
		expect(css).toContain("--omp-motion-slow: 280ms; /* motion-ok: token definition */");
		expect(css).toContain("--omp-ease: cubic-bezier(0.2, 0.8, 0.2, 1);");
	});

	it("declares the eyebrow and kbd classes in the components layer without a fixed eyebrow color", () => {
		expect(css).toMatch(/@layer components \{[\s\S]*?\.omp-eyebrow[\s\S]*?\.omp-kbd/);
		const eyebrow = css.match(/\.omp-eyebrow\s*\{([^}]*)\}/);
		expect(eyebrow).not.toBeNull();
		expect(eyebrow?.[1] ?? "").not.toMatch(/(?:^|[\s;{])color\s*:/);
	});

	it("loads no remote fonts and keeps the font CSP", () => {
		expect(css).not.toContain("fonts.googleapis");
		expect(indexHtml).not.toContain("fonts.googleapis");
		expect(indexHtml).toContain("font-src 'self' data:;");
	});
});
