/**
 * Maps the active GUI theme tokens onto mermaid's "base" theme so diagrams
 * follow the named theme rather than a generic light/dark preset. Every token
 * below resolves to a plain hex value in every theme (a themes.test.ts
 * contract): mermaid derives its shades from these with color math and
 * cannot resolve var() references. Type-only mermaid import keeps the
 * mermaid package in its lazy chunk.
 */

import type { MermaidConfig } from "mermaid";
import type { ResolvedTheme } from "./theme";

export const MERMAID_THEME_TOKENS = [
	"--omp-bg-elevated",
	"--omp-bg-secondary",
	"--omp-bg-tertiary",
	"--omp-bg-primary",
	"--omp-text",
	"--omp-accent",
	"--omp-muted",
] as const;

export type MermaidThemeToken = (typeof MERMAID_THEME_TOKENS)[number];

/** Reads one resolved token value (for example from getComputedStyle). */
export type MermaidTokenReader = (token: MermaidThemeToken) => string;

export interface MermaidThemeVariables {
	darkMode: boolean;
	background: string;
	primaryColor: string;
	primaryTextColor: string;
	primaryBorderColor: string;
	lineColor: string;
	secondaryColor: string;
	tertiaryColor: string;
	textColor: string;
	fontFamily: string;
}

export interface MermaidThemeConfig extends MermaidConfig {
	theme: "base";
	themeVariables: MermaidThemeVariables;
}

export function mermaidThemeConfig(read: MermaidTokenReader, scheme: ResolvedTheme): MermaidThemeConfig {
	return {
		theme: "base",
		themeVariables: {
			darkMode: scheme === "dark",
			background: read("--omp-bg-elevated"),
			primaryColor: read("--omp-bg-secondary"),
			primaryTextColor: read("--omp-text"),
			primaryBorderColor: read("--omp-accent"),
			lineColor: read("--omp-muted"),
			secondaryColor: read("--omp-bg-tertiary"),
			tertiaryColor: read("--omp-bg-primary"),
			textColor: read("--omp-text"),
			fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif",
		},
	};
}

/** Stable identity of a theme config: changes whenever any mapped token does. */
export function mermaidThemeKey(config: MermaidThemeConfig): string {
	return JSON.stringify(config.themeVariables);
}
