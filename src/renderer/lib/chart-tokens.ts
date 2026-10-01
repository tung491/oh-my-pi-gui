/**
 * Theme tokens behind the multi-series chart palette, ordered for hue spread.
 * Every token resolves to a plain `#rrggbb` value in every theme and both
 * stylesheets (a themes.test.ts contract), so chart consumers can append alpha
 * suffixes (`${color}26`). Kept free of chart.js so the theme tests can import
 * it without pulling in the lazy charts chunk.
 */
export const CHART_COLOR_TOKENS = [
	"--omp-accent",
	"--omp-md-code",
	"--omp-success",
	"--omp-thinking-xhigh",
	"--omp-warning",
	"--omp-syntax-string",
	"--omp-error",
	"--omp-syntax-number",
	"--omp-syntax-type",
	"--omp-muted",
] as const;
