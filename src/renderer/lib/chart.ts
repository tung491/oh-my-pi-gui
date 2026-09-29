import { formatCost } from "./format";
/**
 * chart.js registration + theme-aware defaults. Every stats route imports
 * this module for its side effects before rendering react-chartjs-2 charts.
 */

import {
	ArcElement,
	BarElement,
	CategoryScale,
	Chart,
	Filler,
	Legend,
	LinearScale,
	LineElement,
	PointElement,
	Tooltip,
} from "chart.js";
import { CHART_COLOR_TOKENS } from "./chart-tokens";
import { getThemeSelectionVersion } from "./themes";

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Filler, Tooltip, Legend);

const css = (name: string, fallback: string): string =>
	getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Scheme-aware fallbacks, used only when the theme stylesheets failed to load. */
const FALLBACK_DARK = {
	text: "#ebedef",
	muted: "#b6bac2",
	dim: "#a2a8b1",
	grid: "#233147",
	accent: "#7db9ff",
	error: "#f87171",
	surface: "#233147",
};
const FALLBACK_LIGHT = {
	text: "#1e293b",
	muted: "#4a5a70",
	dim: "#56667d",
	grid: "#e7eef8",
	accent: "#1b5fcc",
	error: "#b91c1c",
	surface: "#e7eef8",
};

const chartFallbacks = () => {
	const attr = document.documentElement.getAttribute("data-theme");
	if (attr === "light") return FALLBACK_LIGHT;
	if (attr === "dark") return FALLBACK_DARK;
	const osLight =
		typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
	return osLight ? FALLBACK_LIGHT : FALLBACK_DARK;
};

/** Scheme-neutral palette (medium tones) for the no-stylesheet fallback path. */
const CHART_COLOR_FALLBACKS = [
	"#3b82f6",
	"#7c3aed",
	"#16a34a",
	"#db2777",
	"#f59e0b",
	"#0d9488",
	"#dc2626",
	"#d97706",
	"#4f46e5",
	"#64748b",
];

let chartColorCache: { version: number; colors: string[] } | null = null;

/**
 * Palette for multi-series charts (cycled), resolved from the active theme's
 * CHART_COLOR_TOKENS. Memoized per theme selection, so a switch (VIF Light to
 * VIF Navy, or between named themes) re-reads the tokens on the next call.
 * Exact duplicates (small palettes like nord/solarized reuse hues across
 * roles) are removed.
 */
export function chartColors(): string[] {
	const version = getThemeSelectionVersion();
	if (chartColorCache?.version === version) return chartColorCache.colors;
	const resolved = CHART_COLOR_TOKENS.map((token, index) => css(token, CHART_COLOR_FALLBACKS[index]));
	const colors = resolved.filter((color, index) => resolved.indexOf(color) === index);
	chartColorCache = { version, colors };
	return colors;
}

export function chartTheme() {
	const fb = chartFallbacks();
	return {
		text: css("--omp-text", fb.text),
		muted: css("--omp-muted", fb.muted),
		dim: css("--omp-dim", fb.dim),
		grid: css("--omp-border-muted", fb.grid),
		accent: css("--omp-accent", fb.accent),
		error: css("--omp-error", fb.error),
	};
}

/** Shared axis/legend/tooltip defaults merged into each chart's options. */
export function baseChartOptions(): {
	scales: {
		x: { grid: { color: string }; ticks: { color: string; maxRotation: number; font: { size: number } } };
		y: { grid: { color: string }; ticks: { color: string; font: { size: number } }; beginAtZero: boolean };
	};
	plugins: {
		legend: { labels: { color: string; boxWidth: number; boxHeight: number; font: { size: number } } };
		tooltip: {
			backgroundColor: string;
			titleColor: string;
			bodyColor: string;
			borderColor: string;
			borderWidth: number;
		};
	};
	maintainAspectRatio: boolean;
	responsive: boolean;
} {
	const theme = chartTheme();
	return {
		maintainAspectRatio: false,
		responsive: true,
		scales: {
			x: {
				grid: { color: `${theme.grid}55` },
				ticks: { color: theme.dim, maxRotation: 0, font: { size: 10 } },
			},
			y: {
				beginAtZero: true,
				grid: { color: `${theme.grid}55` },
				ticks: { color: theme.dim, font: { size: 10 } },
			},
		},
		plugins: {
			legend: { labels: { color: theme.muted, boxWidth: 8, boxHeight: 8, font: { size: 10 } } },
			tooltip: {
				backgroundColor: css("--omp-bg-tertiary", chartFallbacks().surface),
				titleColor: theme.text,
				bodyColor: theme.muted,
				borderColor: theme.grid,
				borderWidth: 1,
			},
		},
	};
}

/** Compact number formatting for ticks and tables (1.2k / 3.4M / $0.02). */
export function compact(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return `${Math.round(value * 10) / 10}`;
}

export function formatUsd(value: number): string {
	if (value === 0) return "$0";
	return formatCost(value, Math.abs(value) < 0.01 ? 4 : 2);
}

export function formatMs(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	if (value < 1000) return `${Math.round(value)}ms`;
	return `${(value / 1000).toFixed(1)}s`;
}

/** Bucket timestamps → short labels (HH:mm for ≤24h ranges, MMM d otherwise). */
export function bucketLabels(timestamps: number[]): string[] {
	const span = timestamps.length > 1 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
	const short = span <= 26 * 3600_000;
	return timestamps.map(ts => {
		const date = new Date(ts);
		return short
			? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
			: date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	});
}
