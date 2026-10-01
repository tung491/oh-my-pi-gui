import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { filterByStatus, statusGroups } from "./hub-filter";

function agent(id: string, status: string): SubagentSnapshot {
	return { id, index: 1, agent: "scout", status, lastUpdate: 0 };
}

describe("hub status filter", () => {
	const roster = [agent("a1", "running"), agent("a2", "parked"), agent("a3", "running"), agent("a4", "failed")];

	it("keeps every agent for the all selection", () => {
		expect(filterByStatus(roster, "all")).toEqual(roster);
	});

	it("keeps only the agents whose status label matches the selection", () => {
		expect(filterByStatus(roster, "subagent.status.parked").map(entry => entry.id)).toEqual(["a2"]);
	});

	it("counts agents per status label in first-seen order", () => {
		expect(statusGroups(roster)).toEqual([
			{ labelKey: "subagent.status.started", count: 2 },
			{ labelKey: "subagent.status.parked", count: 1 },
			{ labelKey: "subagent.status.failed", count: 1 },
		]);
	});

	it("folds wire statuses that share a label into one group", () => {
		const folded = [agent("a1", "started"), agent("a2", "running"), agent("a3", "running")];
		expect(statusGroups(folded)).toEqual([{ labelKey: "subagent.status.started", count: 3 }]);
		expect(filterByStatus(folded, "subagent.status.started")).toEqual(folded);
	});

	it("groups different unknown statuses under the one unknown label", () => {
		const unknown = [agent("a1", "thinking-hard"), agent("a2", "rebasing")];
		expect(statusGroups(unknown)).toEqual([{ labelKey: "subagent.status.unknown", count: 2 }]);
	});
});
