/**
 * Mermaid theme mapping contract: diagrams use mermaid's "base" theme with
 * variables read from the active GUI tokens, and the cache key changes
 * whenever any mapped token changes (so same-scheme theme switches re-render).
 */

import { describe, expect, it } from "vitest";
import { type MermaidThemeToken, mermaidThemeConfig, mermaidThemeKey } from "./mermaid-theme";

const PALETTE: Record<MermaidThemeToken, string> = {
	"--omp-bg-elevated": "#101010",
	"--omp-bg-secondary": "#202020",
	"--omp-bg-tertiary": "#303030",
	"--omp-bg-primary": "#404040",
	"--omp-text": "#505050",
	"--omp-accent": "#606060",
	"--omp-muted": "#707070",
};

const read = (token: MermaidThemeToken) => PALETTE[token];

describe("mermaidThemeConfig", () => {
	it("maps GUI tokens onto mermaid's base theme variables", () => {
		const config = mermaidThemeConfig(read, "light");
		expect(config.theme).toBe("base");
		expect(config.themeVariables.primaryTextColor).toBe(read("--omp-text"));
		expect(config.themeVariables.primaryBorderColor).toBe(read("--omp-accent"));
		expect(config.themeVariables.lineColor).toBe(read("--omp-muted"));
		expect(config.themeVariables.background).toBe(read("--omp-bg-elevated"));
		expect(config.themeVariables.darkMode).toBe(false);
		expect(mermaidThemeConfig(read, "dark").themeVariables.darkMode).toBe(true);
	});

	it("changes the theme key when a single token changes", () => {
		const other = (token: MermaidThemeToken) => (token === "--omp-accent" ? "#616161" : read(token));
		expect(mermaidThemeKey(mermaidThemeConfig(other, "light"))).not.toBe(
			mermaidThemeKey(mermaidThemeConfig(read, "light")),
		);
	});
});
