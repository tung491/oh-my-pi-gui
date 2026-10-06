import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentsDir, expandHome, isInsideDir, resultLine, safeBaseName, writeUnique } from "../src/office/output";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "sai-atlas-output-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("documentsDir", () => {
	it("uses the folder xdg-user-dir names on Linux", () => {
		const dir = documentsDir({ platform: "linux", home: "/home/u", runXdgUserDir: () => "/home/u/Tài liệu\n" });
		expect(dir).toBe("/home/u/Tài liệu/Sai ATLAS");
	});

	it("falls back to ~/Documents when xdg-user-dir throws", () => {
		const dir = documentsDir({
			platform: "linux",
			home: "/home/u",
			runXdgUserDir: () => {
				throw new Error("xdg-user-dir: not found");
			},
		});
		expect(dir).toBe("/home/u/Documents/Sai ATLAS");
	});

	it("falls back to ~/Documents when xdg-user-dir prints an empty line", () => {
		expect(documentsDir({ platform: "linux", home: "/home/u", runXdgUserDir: () => "\n" })).toBe(
			"/home/u/Documents/Sai ATLAS",
		);
	});

	it("falls back to ~/Documents when xdg-user-dir prints the home folder itself", () => {
		expect(documentsDir({ platform: "linux", home: "/home/u", runXdgUserDir: () => "/home/u\n" })).toBe(
			"/home/u/Documents/Sai ATLAS",
		);
		expect(documentsDir({ platform: "linux", home: "/home/u", runXdgUserDir: () => "/home/u/\n" })).toBe(
			"/home/u/Documents/Sai ATLAS",
		);
	});

	it("uses ~/Documents on macOS", () => {
		expect(documentsDir({ platform: "darwin", home: "/Users/u", runXdgUserDir: () => "/elsewhere" })).toBe(
			"/Users/u/Documents/Sai ATLAS",
		);
	});
});

describe("writeUnique", () => {
	const bytes = new Uint8Array([1, 2, 3]);

	it("never replaces an existing file", () => {
		const first = writeUnique(tmp, "Q3 report", "docx", bytes);
		const second = writeUnique(tmp, "Q3 report", "docx", bytes);
		const third = writeUnique(tmp, "Q3 report", "docx", bytes);
		expect(first).toBe(join(tmp, "Q3 report.docx"));
		expect(second).toBe(join(tmp, "Q3 report (2).docx"));
		expect(third).toBe(join(tmp, "Q3 report (3).docx"));
		expect([...readFileSync(first)]).toEqual([1, 2, 3]);
	});

	it("skips a name another writer already holds", () => {
		writeFileSync(join(tmp, "Q3 report.docx"), "theirs");
		const path = writeUnique(tmp, "Q3 report", "docx", bytes);
		expect(path).toBe(join(tmp, "Q3 report (2).docx"));
		expect(readFileSync(join(tmp, "Q3 report.docx"), "utf8")).toBe("theirs");
	});

	it("gives two concurrent calls with the same name two files", async () => {
		const paths = await Promise.all([
			Promise.resolve().then(() => writeUnique(tmp, "same", "pptx", bytes)),
			Promise.resolve().then(() => writeUnique(tmp, "same", "pptx", bytes)),
		]);
		expect(new Set(paths).size).toBe(2);
		for (const path of paths) expect(existsSync(path)).toBe(true);
	});

	it("opens with the exclusive flag instead of checking first", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/office/output.ts", import.meta.url)), "utf8");
		expect(source).toContain('openSync(path, "wx")');
		expect(source).not.toContain("existsSync");
	});
});

describe("safeBaseName", () => {
	it("strips path separators and reserved characters", () => {
		expect(safeBaseName("a/b:c*?")).toBe("abc");
		expect(safeBaseName('x\\y"<z>|')).toBe("xyz");
	});

	it("cannot climb out of the folder", () => {
		expect(safeBaseName("../../escape")).toBe("....escape");
	});

	it("returns a non-empty default when nothing is left", () => {
		expect(safeBaseName("/:*")).not.toBe("");
		expect(safeBaseName("   ")).not.toBe("");
	});

	it("keeps Vietnamese letters and caps the length below the file system limit", () => {
		expect(safeBaseName("Báo cáo quý 3")).toBe("Báo cáo quý 3");
		const long = safeBaseName("ệ".repeat(400));
		expect(Buffer.byteLength(`${long} (9999).docx`)).toBeLessThanOrEqual(255);
	});
});

describe("resultLine", () => {
	it("is one line of JSON with exactly file, kind and check", () => {
		const line = resultLine({ file: "/home/u/Documents/Sai ATLAS/a.docx", kind: "docx", check: "1 headings" });
		expect(line).not.toContain("\n");
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(["check", "file", "kind"]);
		expect(parsed.kind).toBe("docx");
	});
});

describe("isInsideDir", () => {
	it("accepts a child whose first segment only starts with two dots", () => {
		mkdirSync(join(tmp, "..notes"));
		writeFileSync(join(tmp, "..notes", "x.md"), "x");
		expect(isInsideDir(join(tmp, "..notes", "x.md"), tmp)).toBe(true);
	});

	it("rejects a path that climbs out", () => {
		expect(isInsideDir(join(tmp, "..", "x"), tmp)).toBe(false);
		expect(isInsideDir(tmpdir(), tmp)).toBe(false);
	});

	it("rejects a symlink inside that points outside", () => {
		const outside = mkdtempSync(join(tmpdir(), "sai-atlas-outside-"));
		try {
			writeFileSync(join(outside, "secret.txt"), "s");
			symlinkSync(join(outside, "secret.txt"), join(tmp, "link.txt"));
			expect(isInsideDir(join(tmp, "link.txt"), tmp)).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects the folder itself and a missing path", () => {
		expect(isInsideDir(tmp, tmp)).toBe(false);
		expect(isInsideDir(join(tmp, "missing.txt"), tmp)).toBe(false);
	});

	it("tests the first path segment, never a string prefix", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/office/output.ts", import.meta.url)), "utf8");
		expect(source).not.toContain('startsWith("..")');
	});
});

describe("expandHome", () => {
	it("expands a leading ~/", () => {
		expect(expandHome("~/x", "/home/u")).toBe("/home/u/x");
		expect(expandHome("~", "/home/u")).toBe("/home/u");
	});

	it("resolves a relative path against the working directory", () => {
		expect(expandHome("a/b.xlsx", "/home/u")).toBe(resolve("a/b.xlsx"));
		expect(expandHome("/abs/c.csv", "/home/u")).toBe("/abs/c.csv");
	});
});
