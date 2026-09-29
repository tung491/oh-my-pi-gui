/**
 * Shared building blocks for stats routes: frame with loading/error/empty
 * states, metric cards, generic table, chart container.
 */

import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { AsyncSection } from "../common";

export function RouteFrame({
	loading,
	hasData = false,
	error,
	empty,
	onRetry,
	children,
}: {
	loading: boolean;
	hasData?: boolean;
	error: string | null;
	empty?: boolean;
	onRetry: () => void;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<AsyncSection
			empty={empty}
			emptyLabel={t("stats.emptyRange")}
			error={error}
			errorTitle={t("stats.unavailable")}
			hasData={hasData}
			loading={loading}
			loadingLabel={t("stats.loading")}
			onRetry={onRetry}
			retryLabel={t("stats.retry")}
			staleLabel={t("stats.stale")}
		>
			{children}
		</AsyncSection>
	);
}

export function MetricCard({
	label,
	value,
	sub,
	tone = "default",
	badge,
	children,
}: {
	label: string;
	value: string;
	sub?: string;
	tone?: "default" | "accent" | "success" | "warning" | "error";
	/** Status pill shown before the sub line (e.g. a health verdict). */
	badge?: ReactNode;
	/** Extra content under the value, such as a meter. */
	children?: ReactNode;
}) {
	const valueColor = {
		default: "text-(--omp-text)",
		accent: "text-(--omp-accent)",
		success: "text-(--omp-success)",
		warning: "text-(--omp-warning)",
		error: "text-(--omp-error)",
	}[tone];
	return (
		<div className="flex flex-col rounded-xl border border-(--omp-border-muted) bg-(--omp-bg-elevated) px-4 py-3.5 shadow-(--omp-shadow-sm)">
			<div className="omp-eyebrow text-(--omp-dim)">{label}</div>
			<div className={`mt-1.5 font-display text-xl font-semibold tabular-nums ${valueColor}`}>{value}</div>
			{(badge || sub) && (
				<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-omp-xs text-(--omp-muted)">
					{badge}
					{sub && <span>{sub}</span>}
				</div>
			)}
			{children && <div className="mt-2">{children}</div>}
		</div>
	);
}

export interface StatColumn<T> {
	key: string;
	label: string;
	align?: "left" | "right";
	render: (row: T) => ReactNode;
}

export function StatTable<T>({
	columns,
	rows,
	keyFor,
	onRowClick,
}: {
	columns: StatColumn<T>[];
	rows: T[];
	keyFor: (row: T) => string;
	/** Makes rows clickable (e.g. opening a detail drawer). */
	onRowClick?: (row: T) => void;
}) {
	return (
		<div className="overflow-x-auto rounded-lg border border-(--omp-border-muted)">
			<table className="w-full border-collapse text-omp-sm">
				<thead>
					<tr className="border-b border-(--omp-border-muted) bg-transparent">
						{columns.map(column => (
							<th
								className={`px-2.5 py-1.5 text-omp-xxs font-semibold tracking-widest whitespace-nowrap text-(--omp-dim) uppercase ${
									column.align === "right" ? "text-right" : "text-left"
								}`}
								key={column.key}
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map(row => (
						<tr
							className={`border-b border-(--omp-border-muted) transition-colors last:border-b-0 hover:bg-(--omp-bg-tertiary) ${onRowClick ? "cursor-pointer" : ""}`}
							key={keyFor(row)}
							onClick={onRowClick ? () => onRowClick(row) : undefined}
							tabIndex={onRowClick ? 0 : undefined}
							onKeyDown={
								onRowClick
									? event => {
											if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												onRowClick(row);
											}
										}
									: undefined
							}
						>
							{columns.map(column => (
								<td
									className={`px-2.5 py-1.5 align-top ${column.align === "right" ? "text-right tabular-nums" : ""}`}
									key={column.key}
								>
									{column.render(row)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function ChartBox({ height = 260, children }: { height?: number; children: ReactNode }) {
	return (
		<div className="rounded-lg border border-(--omp-border-muted) bg-transparent p-3" style={{ height: height + 24 }}>
			<div className="relative h-full w-full">{children}</div>
		</div>
	);
}

export function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<h3 className="mb-2 mt-5 text-omp-xs font-semibold tracking-widest text-(--omp-dim) uppercase first:mt-0">
			{children}
		</h3>
	);
}
