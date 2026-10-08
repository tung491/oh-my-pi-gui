import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyFileWritten, subscribeFileWrites, writeMatchesPreview, writtenPathOf } from "./file-writes";

function officeResult(file: string, kind: string): unknown {
	return { content: [{ type: "text", text: JSON.stringify({ check: "ok", file, kind }) }] };
}

describe("writtenPathOf", () => {
	it("prefers the write tool's resolved path", () => {
		const result = { content: [{ type: "text", text: "ok" }], details: { resolvedPath: "/w/table.csv" } };
		expect(writtenPathOf("write", { path: "table.csv" }, result)).toBe("/w/table.csv");
	});

	it("falls back to the write tool's argument path", () => {
		expect(writtenPathOf("write", { path: "table.csv" }, { content: [{ type: "text", text: "ok" }] })).toBe(
			"table.csv",
		);
		expect(writtenPathOf("write", { path: "table.csv" }, { details: { resolvedPath: 42 } })).toBe("table.csv");
	});

	it("returns null for a write without a usable path", () => {
		expect(writtenPathOf("write", {}, { content: [] })).toBeNull();
		expect(writtenPathOf("write", null, null)).toBeNull();
		expect(writtenPathOf("write", { path: "" }, null)).toBeNull();
	});

	it.each([
		["office_report", "/home/u/Documents/Sai ATLAS/report.docx", "docx"],
		["office_slides", "/home/u/Documents/Sai ATLAS/deck.pptx", "pptx"],
		["office_clean", "/home/u/Documents/Sai ATLAS/table.xlsx", "xlsx"],
	])("returns the file %s reports", (tool, file, kind) => {
		expect(writtenPathOf(tool, {}, officeResult(file, kind))).toBe(file);
	});

	it("returns null for an office error or a file of the wrong kind", () => {
		expect(
			writtenPathOf("office_report", {}, { content: [{ type: "text", text: "Error: no template" }] }),
		).toBeNull();
		expect(
			writtenPathOf("office_report", {}, officeResult("/home/u/Documents/Sai ATLAS/deck.pptx", "pptx")),
		).toBeNull();
	});

	it("returns null for other tools", () => {
		expect(writtenPathOf("read", { path: "a.csv" }, { details: { resolvedPath: "/w/a.csv" } })).toBeNull();
		expect(writtenPathOf("edit", { path: "a.csv" }, null)).toBeNull();
	});
});

describe("writeMatchesPreview", () => {
	it("matches equal absolute paths from any tab", () => {
		expect(writeMatchesPreview({ tabId: "t2", path: "/w/a.csv" }, { path: "/w/a.csv", tabId: "t1" }, null)).toBe(
			true,
		);
		expect(writeMatchesPreview({ tabId: "t1", path: "/w/b.csv" }, { path: "/w/a.csv", tabId: "t1" }, null)).toBe(
			false,
		);
	});

	it("matches the path the preview resolved", () => {
		expect(
			writeMatchesPreview(
				{ tabId: "t2", path: "/w/docs/a.csv" },
				{ path: "docs/a.csv", tabId: "t1" },
				"/w/docs/a.csv",
			),
		).toBe(true);
	});

	it("matches a relative preview against an absolute write ending in it from the same tab only", () => {
		const target = { path: "docs/a.csv", tabId: "t1" };
		expect(writeMatchesPreview({ tabId: "t1", path: "/w/docs/a.csv" }, target, null)).toBe(true);
		expect(writeMatchesPreview({ tabId: "t2", path: "/w/docs/a.csv" }, target, null)).toBe(false);
		expect(writeMatchesPreview({ tabId: "t1", path: "/w/mydocs/a.csv" }, target, null)).toBe(false);
	});

	it("trusts the resolved path over a suffix match", () => {
		expect(
			writeMatchesPreview({ tabId: "t1", path: "/elsewhere/a.csv" }, { path: "a.csv", tabId: "t1" }, "/w/a.csv"),
		).toBe(false);
	});

	it("matches a relative write against a relative preview from the same tab only", () => {
		expect(writeMatchesPreview({ tabId: "t1", path: "./a.csv" }, { path: "a.csv", tabId: "t1" }, null)).toBe(true);
		expect(writeMatchesPreview({ tabId: "t1", path: "a.csv" }, { path: "./a.csv", tabId: "t1" }, null)).toBe(true);
		expect(writeMatchesPreview({ tabId: "t2", path: "a.csv" }, { path: "a.csv", tabId: "t1" }, null)).toBe(false);
	});

	it("matches a relative write when the preview is relative and its resolved path absolute", () => {
		expect(
			writeMatchesPreview(
				{ tabId: "t1", path: "docs/a.csv" },
				{ path: "./docs/a.csv", tabId: "t1" },
				"/w/docs/a.csv",
			),
		).toBe(true);
		expect(
			writeMatchesPreview({ tabId: "t2", path: "docs/a.csv" }, { path: "docs/a.csv", tabId: "t1" }, "/w/docs/a.csv"),
		).toBe(false);
	});

	it("matches a relative write against an absolute preview from the same tab", () => {
		expect(
			writeMatchesPreview({ tabId: "t1", path: "docs/a.csv" }, { path: "/w/docs/a.csv", tabId: "t1" }, null),
		).toBe(true);
		expect(
			writeMatchesPreview({ tabId: "t2", path: "docs/a.csv" }, { path: "/w/docs/a.csv", tabId: "t1" }, null),
		).toBe(false);
	});

	it.each([
		["/w//docs/a.csv", "/w/docs/a.csv"],
		["/w/./docs/a.csv", "/w/docs/a.csv"],
		["/w/docs/./a.csv", "/w/docs/a.csv"],
		["/w/docs/x/../a.csv", "/w/docs/a.csv"],
		["/w/docs/a.csv/.", "/w/docs/a.csv"],
		["/w/docs/a.csv/", "/w/docs/a.csv"],
	])("normalizes %s to %s", (written, previewed) => {
		expect(writeMatchesPreview({ tabId: "t2", path: written }, { path: previewed, tabId: "t1" }, null)).toBe(true);
		expect(writeMatchesPreview({ tabId: "t2", path: previewed }, { path: "a.csv", tabId: "t1" }, written)).toBe(true);
	});

	it("normalizes a relative preview path before the suffix match", () => {
		expect(
			writeMatchesPreview({ tabId: "t1", path: "/w/docs/a.csv" }, { path: ".//docs/./a.csv", tabId: "t1" }, null),
		).toBe(true);
	});

	it("does not match a null-tab preview from a relative write", () => {
		expect(writeMatchesPreview({ tabId: "t1", path: "a.csv" }, { path: "a.csv", tabId: null }, null)).toBe(false);
	});
});

describe("file write notifications", () => {
	const unsubscribes: Array<() => void> = [];

	afterEach(() => {
		for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
		vi.restoreAllMocks();
	});

	it("delivers each write to every subscriber until it unsubscribes", () => {
		const first = vi.fn();
		const second = vi.fn();
		const stopFirst = subscribeFileWrites(first);
		unsubscribes.push(subscribeFileWrites(second));
		notifyFileWritten("t1", "/w/a.csv");
		stopFirst();
		notifyFileWritten("t1", "/w/b.csv");
		expect(first.mock.calls).toEqual([[{ tabId: "t1", path: "/w/a.csv" }]]);
		expect(second.mock.calls).toEqual([[{ tabId: "t1", path: "/w/a.csv" }], [{ tabId: "t1", path: "/w/b.csv" }]]);
	});

	it("keeps notifying when a subscriber throws", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const after = vi.fn();
		unsubscribes.push(
			subscribeFileWrites(() => {
				throw new Error("boom");
			}),
		);
		unsubscribes.push(subscribeFileWrites(after));
		notifyFileWritten("t1", "/w/a.csv");
		expect(after).toHaveBeenCalledOnce();
	});
});
