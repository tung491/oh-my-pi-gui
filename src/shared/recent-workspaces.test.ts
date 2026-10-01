/**
 * The tray and the quick-entry bar list the same workspaces in the same order,
 * so this one rule decides which cwds appear and where.
 */

import { describe, expect, it } from "vitest";
import { recentWorkspaceCwds } from "./recent-workspaces";

const session = (cwd: string, modified: string) => ({ cwd, modified });

describe("recent workspaces", () => {
	it("lists each cwd once, ordered by its newest session", () => {
		const sessions = [
			session("/a", "2026-09-01T00:00:00Z"),
			session("/b", "2026-09-03T00:00:00Z"),
			session("/a", "2026-09-04T00:00:00Z"),
			session("/c", "2026-09-02T00:00:00Z"),
		];
		expect(recentWorkspaceCwds(sessions, null, 9)).toEqual(["/a", "/b", "/c"]);
	});

	it("keeps the current workspace even without a session, as the oldest", () => {
		expect(recentWorkspaceCwds([session("/a", "2026-09-01T00:00:00Z")], "/new", 9)).toEqual(["/a", "/new"]);
	});

	it("stops at the limit", () => {
		const sessions = Array.from({ length: 12 }, (_, i) =>
			session(`/w${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
		);
		expect(recentWorkspaceCwds(sessions, null, 9)).toHaveLength(9);
		expect(recentWorkspaceCwds(sessions, null, 9)[0]).toBe("/w11");
	});

	it("sorts an unparseable date as the oldest", () => {
		expect(
			recentWorkspaceCwds([session("/bad", "not a date"), session("/ok", "2026-09-01T00:00:00Z")], null, 9),
		).toEqual(["/ok", "/bad"]);
	});
});
