/**
 * Horizontal meter. The `solid` fill uses threshold coloring
 * (green < 0.75, yellow < 0.9, red >= 0.9) unless `color` overrides it; the
 * `brand` fill paints the brand gradient regardless of value.
 */

export type ProgressBarFill = "solid" | "brand";

export interface ProgressBarProps {
	/** Fill fraction, clamped to 0..1. */
	value: number;
	/** Optional label rendered to the left of the bar. */
	label?: string;
	/** Optional value text rendered to the right (defaults to percent). */
	valueText?: string;
	/** Override automatic threshold coloring with an explicit CSS color (solid fill only). */
	color?: string;
	/** Fill style: threshold/explicit color (default) or the brand gradient. */
	fill?: ProgressBarFill;
	/** Track height in px. */
	height?: number;
	className?: string;
}

const BRAND_GRADIENT = "linear-gradient(135deg, var(--omp-brand), var(--omp-btn-primary-bg))";

function thresholdColor(value: number): string {
	if (value >= 0.9) return "var(--omp-error)";
	if (value >= 0.75) return "var(--omp-warning)";
	return "var(--omp-success)";
}

export function ProgressBar({
	value,
	label,
	valueText,
	color,
	fill = "solid",
	height = 6,
	className,
}: ProgressBarProps) {
	const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
	const width = `${clamped * 100}%`;
	const fillStyle =
		fill === "brand"
			? { width, backgroundImage: BRAND_GRADIENT }
			: { width, backgroundColor: color ?? thresholdColor(clamped) };
	const text = valueText ?? `${Math.round(clamped * 100)}%`;

	return (
		<div className={`flex items-center gap-2 ${className ?? ""}`.trim()}>
			{label && (
				<span className="shrink-0 text-omp-xs font-medium tracking-wide text-(--omp-muted) uppercase">{label}</span>
			)}
			<div
				aria-valuemax={1}
				aria-valuemin={0}
				aria-valuenow={Number(clamped.toFixed(3))}
				className="min-w-0 flex-1 overflow-hidden rounded-full bg-(--omp-progress-bg)"
				data-fill={fill}
				role="progressbar"
				style={{ height }}
			>
				<div className="h-full rounded-full transition-[width] duration-300 ease-out" style={fillStyle} />
			</div>
			<span className="shrink-0 text-omp-xs tabular-nums text-(--omp-dim)">{text}</span>
		</div>
	);
}
