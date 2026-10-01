/**
 * Pure derivations for the Overview route. Kept free of chart.js so they can be
 * unit-tested without a canvas and never pull the charts chunk into a caller.
 */

import type { StatsRange } from "./StatsDashboard";

/** Length of each range in days; ranges without a fixed day count have no daily rate. */
const RANGE_DAYS: Record<StatsRange, number | null> = {
	"1h": null,
	"24h": 1,
	"7d": 7,
	"30d": 30,
	"90d": 90,
	all: null,
};

/** Average spend per day over the selected range, or null when the range has no fixed length. */
export function costPerDay(totalCost: number, range: StatsRange): number | null {
	const days = RANGE_DAYS[range];
	if (days === null || !Number.isFinite(totalCost)) return null;
	return totalCost / days;
}

/** The `n` rows with the largest `key`, largest first, without reordering the input. */
export function topRows<K extends string, T extends Record<K, number>>(rows: readonly T[], key: K, n = 5): T[] {
	const score = (row: T): number => (Number.isFinite(row[key]) ? row[key] : 0);
	return [...rows].sort((a, b) => score(b) - score(a)).slice(0, Math.max(0, n));
}
