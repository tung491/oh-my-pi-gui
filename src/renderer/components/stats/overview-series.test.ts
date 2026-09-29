import { describe, expect, it } from "vitest";
import { costPerDay, topRows } from "./overview-series";

describe("costPerDay", () => {
	it("divides the range total by the range's length in days", () => {
		expect(costPerDay(7, "7d")).toBe(1);
		expect(costPerDay(2, "24h")).toBe(2);
		expect(costPerDay(60, "30d")).toBe(2);
		expect(costPerDay(9, "90d")).toBe(0.1);
	});

	it("has no daily rate for ranges without a fixed day count", () => {
		expect(costPerDay(3, "all")).toBeNull();
		expect(costPerDay(3, "1h")).toBeNull();
	});
});

describe("topRows", () => {
	const rows = [
		{ name: "read", calls: 12 },
		{ name: "edit", calls: 40 },
		{ name: "bash", calls: 7 },
		{ name: "grep", calls: 31 },
		{ name: "task", calls: 2 },
		{ name: "find", calls: 19 },
	];

	it("sorts descending by the key and keeps the first five by default", () => {
		expect(topRows(rows, "calls").map(row => row.name)).toEqual(["edit", "grep", "find", "read", "bash"]);
	});

	it("truncates to the requested count", () => {
		expect(topRows(rows, "calls", 2).map(row => row.name)).toEqual(["edit", "grep"]);
	});

	it("leaves the input order untouched", () => {
		topRows(rows, "calls");
		expect(rows.map(row => row.name)).toEqual(["read", "edit", "bash", "grep", "task", "find"]);
	});
});
