/**
 * Behavior: how often user messages show frustration, overall and per model
 * version, from the agent's `/api/stats/frustration` tallies. A message counts
 * once, classified by its cached judge verdict when one exists, else by the
 * pattern signals the agent stored when it indexed the message.
 */

import { useEffect, useMemo } from "react";
import { useStats } from "../../hooks/use-stats";
import { compact } from "../../lib/chart";
import { formatPercent } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { StatsRange } from "./StatsDashboard";
import { MetricCard, RouteFrame, SectionTitle, type StatColumn, StatTable } from "./shared";

/** Frustration tallies over a set of user messages (the agent's `FrustrationCounts`). */
interface FrustrationCounts {
	/** User messages with non-empty prose. */
	messages: number;
	/** Messages with a cached judge verdict; the rest are classified by pattern. */
	judged: number;
	/** Annoyed at anything. */
	annoyed: number;
	/** Annoyed and aimed at the assistant; a subset of `annoyed`. */
	atAssistant: number;
	/** Aimed at the assistant and hostile; a subset of `atAssistant`. */
	angry: number;
}

/** One model version: provider and spelling variants merge under one catalog identity. */
interface FrustrationModelRow extends FrustrationCounts {
	key: string;
	/** Display label, e.g. `opus 4.5`; the raw model id when unclassified. */
	label: string;
	/** Raw model ids merged into this row. */
	models: string[];
}

interface FrustrationData {
	overall: FrustrationCounts;
	byModel: FrustrationModelRow[];
}

/** `part` as a share of `whole`, or the empty-value dash when there is nothing to divide. */
export function shareOf(part: number, whole: number): string {
	return whole > 0 ? formatPercent((part / whole) * 100) : formatPercent(null);
}

const SIGNALS = [
	{ key: "annoyed", labelKey: "stats.behavior.annoyed" },
	{ key: "atAssistant", labelKey: "stats.behavior.atAssistant" },
	{ key: "angry", labelKey: "stats.behavior.angry" },
] as const;

export function BehaviorRoute({ range, refreshKey }: { range: StatsRange; refreshKey: number }) {
	const t = useT();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, refetch } = useStats<FrustrationData>("/api/stats/frustration", params);

	useEffect(() => {
		if (refreshKey > 0) refetch();
	}, [refreshKey, refetch]);

	const overall = data?.overall;

	const columns: StatColumn<FrustrationModelRow>[] = useMemo(
		() => [
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span>
						<span className="block font-medium text-(--omp-text)">{row.label}</span>
						<span className="block text-omp-xs text-(--omp-dim)">{row.models.join(", ")}</span>
					</span>
				),
			},
			{ key: "messages", label: t("stats.col.messages"), align: "right", render: row => compact(row.messages) },
			...SIGNALS.map(
				(signal): StatColumn<FrustrationModelRow> => ({
					key: signal.key,
					label: t(signal.labelKey),
					align: "right",
					render: row =>
						row[signal.key] > 0 ? (
							<span className="text-(--omp-warning)">{row[signal.key]}</span>
						) : (
							<span className="text-(--omp-dim)">0</span>
						),
				}),
			),
		],
		[t],
	);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={!overall || overall.messages === 0}
			error={error}
			loading={isLoading}
			onRetry={refetch}
		>
			{overall && (
				<>
					<div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
						<MetricCard label={t("stats.col.messages")} tone="accent" value={compact(overall.messages)} />
						<MetricCard
							label={t("stats.behavior.judged")}
							sub={t("stats.behavior.judgedSub", {
								judged: compact(overall.judged),
								pattern: compact(overall.messages - overall.judged),
							})}
							value={shareOf(overall.judged, overall.messages)}
						/>
						{SIGNALS.map(signal => (
							<MetricCard
								key={signal.key}
								label={t(signal.labelKey)}
								sub={t("stats.behavior.countSub", { count: compact(overall[signal.key]) })}
								tone={overall[signal.key] > 0 ? "warning" : "default"}
								value={shareOf(overall[signal.key], overall.messages)}
							/>
						))}
					</div>
					<SectionTitle>{t("stats.behavior.byModel")}</SectionTitle>
					<StatTable columns={columns} keyFor={row => row.key} rows={data?.byModel ?? []} />
				</>
			)}
		</RouteFrame>
	);
}
