/**
 * Overview: headline metric cards, the requests/errors time series (as a chart
 * or a table), the per-agent-type breakdown, and the top models and tools.
 */

import type { ChartOptions, TooltipItem } from "chart.js";
import { ChartLine, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { baseChartOptions, bucketLabels, chartTheme, compact, formatMs, formatUsd } from "../../lib/chart";
import "../../lib/chart";
import { useStats } from "../../hooks/use-stats";
import { useT } from "../../lib/i18n";
import { Badge, IconButton, ProgressBar } from "../common";
import { costPerDay, topRows } from "./overview-series";
import type { StatsRange } from "./StatsDashboard";
import { ChartBox, MetricCard, RouteFrame, SectionTitle, type StatColumn, StatTable } from "./shared";

interface TimePoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

interface AgentTypeRow {
	agentType: string;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
}

interface OverviewData {
	overall: {
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		errorRate: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheWriteTokens: number;
		cacheRate: number;
		totalCost: number;
		avgDuration: number | null;
		avgTtft: number | null;
		avgTokensPerSecond: number | null;
	};
	byAgentType: AgentTypeRow[];
	timeSeries: TimePoint[];
}

/** The slice of /api/stats/model-dashboard the top-models list reads. */
interface ModelUsageRow {
	model: string;
	provider: string;
	totalRequests: number;
}

/** The slice of /api/stats/tools the top-tools list reads. */
interface ToolUsageRow {
	tool: string;
	calls: number;
}

/** Same threshold as the error-rate value's color. */
const ERROR_RATE_LIMIT = 0.05;

interface SeriesRow extends TimePoint {
	label: string;
}

/** A missing or malformed list field (e.g. an empty stats reply) reads as no rows. */
function listOf<T>(value: T[] | undefined): T[] {
	return Array.isArray(value) ? value : [];
}

export function OverviewRoute({ range, refreshKey }: { range: StatsRange; refreshKey: number }) {
	const t = useT();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, refetch } = useStats<OverviewData>("/api/stats/overview", params);
	const models = useStats<{ byModel?: ModelUsageRow[] }>("/api/stats/model-dashboard", params);
	const tools = useStats<{ byTool?: ToolUsageRow[] }>("/api/stats/tools", params);
	const refetchModels = models.refetch;
	const refetchTools = tools.refetch;
	const [showTable, setShowTable] = useState(false);

	// Sync bumps refreshKey: every resource on this route must reload, not just the headline.
	useEffect(() => {
		if (refreshKey > 0) {
			refetch();
			refetchModels();
			refetchTools();
		}
	}, [refreshKey, refetch, refetchModels, refetchTools]);

	const stats = data;
	const overall = stats?.overall;
	const series = useMemo(() => stats?.timeSeries ?? [], [stats]);
	const theme = chartTheme();

	const labels = useMemo(() => bucketLabels(series.map(point => point.timestamp)), [series]);
	const seriesRows: SeriesRow[] = useMemo(
		() => series.map((point, index) => ({ ...point, label: labels[index] ?? "" })),
		[series, labels],
	);

	// Built per render, like the theme above, so axis and tooltip colors follow a theme switch.
	const baseOptions = baseChartOptions();
	const chartOptions: ChartOptions<"line"> = {
		...baseOptions,
		plugins: {
			...baseOptions.plugins,
			tooltip: {
				...baseOptions.plugins.tooltip,
				callbacks: {
					afterBody: (items: TooltipItem<"line">[]) => {
						const point = series[items[0]?.dataIndex ?? -1];
						if (!point) return [];
						return [
							`${t("stats.col.tokens")}: ${compact(point.tokens)}`,
							`${t("stats.col.cost")}: ${formatUsd(point.cost)}`,
						];
					},
				},
			},
		},
	};

	const agentColumns: StatColumn<AgentTypeRow>[] = useMemo(
		() => [
			{
				key: "type",
				label: t("stats.overview.col.agentType"),
				render: row => <span className="font-medium text-(--omp-text)">{row.agentType}</span>,
			},
			{ key: "requests", label: t("stats.col.requests"), align: "right", render: row => compact(row.totalRequests) },
			{
				key: "tokens",
				label: t("stats.col.tokens"),
				align: "right",
				render: row =>
					compact(
						row.totalInputTokens + row.totalOutputTokens + row.totalCacheReadTokens + row.totalCacheWriteTokens,
					),
			},
			{ key: "cost", label: t("stats.col.cost"), align: "right", render: row => formatUsd(row.totalCost) },
		],
		[t],
	);

	const seriesColumns: StatColumn<SeriesRow>[] = useMemo(
		() => [
			{ key: "time", label: t("stats.col.time"), render: row => row.label },
			{ key: "requests", label: t("stats.col.requests"), align: "right", render: row => compact(row.requests) },
			{ key: "errors", label: t("stats.col.errors"), align: "right", render: row => compact(row.errors) },
			{ key: "tokens", label: t("stats.col.tokens"), align: "right", render: row => compact(row.tokens) },
			{ key: "cost", label: t("stats.col.cost"), align: "right", render: row => formatUsd(row.cost) },
		],
		[t],
	);

	const modelRows = useMemo(() => listOf(models.data?.byModel), [models.data]);
	const modelTotal = useMemo(() => modelRows.reduce((sum, row) => sum + row.totalRequests, 0), [modelRows]);
	const topModels = useMemo(() => topRows(modelRows, "totalRequests"), [modelRows]);
	const modelColumns: StatColumn<ModelUsageRow>[] = useMemo(
		() => [
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span className="block max-w-56 truncate font-mono font-medium text-(--omp-text)" title={row.provider}>
						{row.model}
					</span>
				),
			},
			{ key: "requests", label: t("stats.col.requests"), align: "right", render: row => compact(row.totalRequests) },
			{
				key: "share",
				label: t("stats.overview.share"),
				render: row => <ProgressBar className="min-w-28" fill="brand" value={row.totalRequests / modelTotal} />,
			},
		],
		[t, modelTotal],
	);

	const toolRows = useMemo(() => listOf(tools.data?.byTool), [tools.data]);
	const toolTotal = useMemo(() => toolRows.reduce((sum, row) => sum + row.calls, 0), [toolRows]);
	const topTools = useMemo(() => topRows(toolRows, "calls"), [toolRows]);
	const toolColumns: StatColumn<ToolUsageRow>[] = useMemo(
		() => [
			{
				key: "tool",
				label: t("stats.tools.col.tool"),
				render: row => <span className="font-mono font-medium text-(--omp-text)">{row.tool}</span>,
			},
			{ key: "calls", label: t("stats.tools.col.calls"), align: "right", render: row => compact(row.calls) },
			{
				key: "share",
				label: t("stats.overview.share"),
				render: row => <ProgressBar className="min-w-28" fill="brand" value={row.calls / toolTotal} />,
			},
		],
		[t, toolTotal],
	);

	const dailyCost = overall ? costPerDay(overall.totalCost, range) : null;
	const errorRateElevated = overall ? overall.errorRate > ERROR_RATE_LIMIT : false;

	return (
		<RouteFrame
			hasData={data !== null}
			empty={!overall || overall.totalRequests === 0}
			error={error}
			loading={isLoading}
			onRetry={refetch}
		>
			{overall && (
				<>
					<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
						<MetricCard
							label={t("stats.col.requests")}
							sub={t("stats.overview.failedSub", { count: overall.failedRequests })}
							tone="accent"
							value={compact(overall.totalRequests)}
						/>
						<MetricCard
							label={t("stats.col.tokens")}
							sub={t("stats.overview.outputSub", { count: compact(overall.totalOutputTokens) })}
							value={compact(
								overall.totalInputTokens +
									overall.totalOutputTokens +
									overall.totalCacheReadTokens +
									overall.totalCacheWriteTokens,
							)}
						/>
						<MetricCard
							label={t("stats.col.cost")}
							sub={
								dailyCost !== null ? t("stats.overview.costPerDay", { cost: formatUsd(dailyCost) }) : undefined
							}
							value={formatUsd(overall.totalCost)}
						/>
						<MetricCard
							badge={
								<Badge variant={errorRateElevated ? "error" : "success"}>
									{errorRateElevated
										? t("stats.overview.elevated", { limit: ERROR_RATE_LIMIT * 100 })
										: t("stats.overview.healthy")}
								</Badge>
							}
							label={t("stats.overview.errorRate")}
							tone={errorRateElevated ? "error" : "success"}
							value={`${(overall.errorRate * 100).toFixed(1)}%`}
						/>
						<MetricCard label={t("stats.overview.cacheHit")} value={`${(overall.cacheRate * 100).toFixed(0)}%`}>
							<ProgressBar fill="brand" value={overall.cacheRate} />
						</MetricCard>
						<MetricCard
							label={t("stats.overview.speed")}
							sub={t("stats.overview.ttftSub", { time: formatMs(overall.avgTtft) })}
							value={
								overall.avgTokensPerSecond !== null ? `${Math.round(overall.avgTokensPerSecond)} tok/s` : "—"
							}
						/>
					</div>

					<div className="mt-5 flex items-center justify-between gap-2">
						<SectionTitle>{t("stats.overview.activity")}</SectionTitle>
						<IconButton
							className="mb-2"
							icon={showTable ? <ChartLine size={15} /> : <Table2 size={15} />}
							label={showTable ? t("stats.overview.showChart") : t("stats.overview.showTable")}
							onClick={() => setShowTable(value => !value)}
							size="sm"
						/>
					</div>
					{showTable ? (
						<StatTable columns={seriesColumns} keyFor={row => String(row.timestamp)} rows={seriesRows} />
					) : (
						<ChartBox height={240}>
							<Line
								data={{
									labels,
									datasets: [
										{
											label: t("stats.col.requests"),
											data: series.map(point => point.requests),
											borderColor: theme.accent,
											backgroundColor: `${theme.accent}1a`,
											fill: true,
											tension: 0.3,
											pointRadius: 0,
											borderWidth: 1.5,
										},
										{
											label: t("stats.col.errors"),
											data: series.map(point => point.errors),
											borderColor: theme.error,
											backgroundColor: "transparent",
											tension: 0.3,
											pointRadius: 0,
											borderWidth: 1.5,
										},
									],
								}}
								options={chartOptions}
							/>
						</ChartBox>
					)}

					<SectionTitle>{t("stats.overview.byAgentType")}</SectionTitle>
					<StatTable columns={agentColumns} keyFor={row => row.agentType} rows={stats?.byAgentType ?? []} />

					<div className="grid gap-x-4 xl:grid-cols-2">
						<div>
							<SectionTitle>{t("stats.overview.topModels")}</SectionTitle>
							<RouteFrame
								empty={topModels.length === 0}
								error={models.error}
								hasData={models.data !== null}
								loading={models.isLoading}
								onRetry={refetchModels}
							>
								<StatTable
									columns={modelColumns}
									keyFor={row => `${row.provider}/${row.model}`}
									rows={topModels}
								/>
							</RouteFrame>
						</div>
						<div>
							<SectionTitle>{t("stats.overview.topTools")}</SectionTitle>
							<RouteFrame
								empty={topTools.length === 0}
								error={tools.error}
								hasData={tools.data !== null}
								loading={tools.isLoading}
								onRetry={refetchTools}
							>
								<StatTable columns={toolColumns} keyFor={row => row.tool} rows={topTools} />
							</RouteFrame>
						</div>
					</div>
				</>
			)}
		</RouteFrame>
	);
}
