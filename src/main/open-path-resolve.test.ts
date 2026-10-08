import { describe, expect, it } from "vitest";
import { type OpenPathEnv, openPathTabId, resolveOpenPath } from "./open-path-resolve";

/** Window `/win` with tabs `t1` → `/ws/one` and `t2` → `/ws/two`; records which tab was asked for. */
function env(): OpenPathEnv & { asked: (string | undefined)[] } {
	const tabs = new Map([
		["t1", "/ws/one"],
		["t2", "/ws/two"],
	]);
	const asked: (string | undefined)[] = [];
	return {
		homedir: "/home/me",
		asked,
		cwdFor(tabId) {
			asked.push(tabId);
			return tabId === undefined ? "/win" : (tabs.get(tabId) ?? null);
		},
	};
}

describe("resolveOpenPath", () => {
	it("open path resolves a relative path against the given tab", () => {
		const e = env();
		expect(resolveOpenPath("docs/a.pdf", "t2", e)).toEqual({ ok: true, path: "/ws/two/docs/a.pdf" });
		expect(e.asked).toEqual(["t2"]);
	});

	it("open path refuses an unknown tab", () => {
		expect(resolveOpenPath("docs/a.pdf", "gone", env())).toEqual({ ok: false, error: "No workspace" });
	});

	it("open path resolves against the window workspace without a tab", () => {
		const e = env();
		expect(resolveOpenPath("notes.md", undefined, e)).toEqual({ ok: true, path: "/win/notes.md" });
		expect(e.asked).toEqual([undefined]);
	});

	it("open path keeps absolute and home paths without asking for a workspace", () => {
		const e = env();
		expect(resolveOpenPath("/abs/a.txt", "gone", e)).toEqual({ ok: true, path: "/abs/a.txt" });
		expect(resolveOpenPath("~/a.txt", "gone", e)).toEqual({ ok: true, path: "/home/me/a.txt" });
		expect(e.asked).toEqual([]);
	});

	it("open path refuses a path that escapes the tab workspace", () => {
		expect(resolveOpenPath("../one/a.txt", "t2", env())).toEqual({ ok: false, error: "Path escapes the workspace" });
	});

	it("open path refuses an empty path", () => {
		expect(resolveOpenPath("  ", "t1", env())).toEqual({ ok: false, error: "Empty path" });
		expect(resolveOpenPath(42, undefined, env())).toEqual({ ok: false, error: "Empty path" });
	});

	it("open path reads the tab id only from a non-empty string", () => {
		expect(openPathTabId({ tabId: "t1" })).toBe("t1");
		expect(openPathTabId({ tabId: "" })).toBeUndefined();
		expect(openPathTabId({ tabId: 7 })).toBeUndefined();
		expect(openPathTabId(undefined)).toBeUndefined();
		expect(openPathTabId("t1")).toBeUndefined();
	});
});
