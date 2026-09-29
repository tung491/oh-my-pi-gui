/**
 * Agent Hub status filter. Groups by the status LABEL, not the raw wire status:
 * statusMeta folds several wire statuses into one label (started and running
 * both read "running", every unknown status reads "unknown"), so one filter
 * per raw status would show duplicate labels that each hide part of the group.
 */

import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { statusMeta } from "./subagent-graph";

/** Selection meaning "no status filter". Status label keys never collide with it. */
export const HUB_FILTER_ALL = "all";

export interface HubStatusGroup {
	labelKey: string;
	count: number;
}

type StatusCarrier = Pick<SubagentSnapshot, "status">;

/** Agent counts per status label, in first-seen order. */
export function statusGroups(agents: Iterable<StatusCarrier>): HubStatusGroup[] {
	const counts = new Map<string, number>();
	for (const agent of agents) {
		const labelKey = statusMeta(agent.status).labelKey;
		counts.set(labelKey, (counts.get(labelKey) ?? 0) + 1);
	}
	return [...counts].map(([labelKey, count]) => ({ labelKey, count }));
}

/** Agents whose status label equals `selection`; every agent for `HUB_FILTER_ALL`. */
export function filterByStatus<T extends StatusCarrier>(agents: readonly T[], selection: string): T[] {
	if (selection === HUB_FILTER_ALL) return [...agents];
	return agents.filter(agent => statusMeta(agent.status).labelKey === selection);
}
