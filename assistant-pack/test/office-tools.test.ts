import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOfficeTools, type OfficeEnv } from "../src/tools/office-tools";
import type { PackTool, ToolResult } from "../src/tools/types";
import { fixture } from "./zip-helpers";

let home: string;
let env: OfficeEnv;
let outDir: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sai-atlas-home-"));
	// An installed xdg-user-dir prints the home folder when no documents folder is configured.
	env = { home, platform: "linux", runXdgUserDir: () => `${home}\n`, lang: "en" };
	outDir = join(home, "Documents", "Sai ATLAS");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function tool(name: string, overrides: Partial<OfficeEnv> = {}): PackTool {
	const found = createOfficeTools({ ...env, ...overrides }).find(definition => definition.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

function text(result: ToolResult): string {
	return result.content.map(part => part.text).join("");
}

function okJson(result: ToolResult): { file: string; kind: string; check: string } {
	expect(result.isError).not.toBe(true);
	const parsed = JSON.parse(text(result)) as Record<string, string>;
	expect(Object.keys(parsed).sort()).toEqual(["check", "file", "kind"]);
	return parsed as { file: string; kind: string; check: string };
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? [relative(home, path), ...walk(path)] : [relative(home, path)];
	});
}

async function spreadsheet(name: string, rows: ExcelJS.CellValue[][]): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet("Data");
	for (const row of rows) sheet.addRow(row);
	const path = join(home, name);
	await workbook.xlsx.writeFile(path);
	return path;
}

describe("office_report", () => {
	it("saves the report under the first # heading in Documents > Sai ATLAS", async () => {
		const result = await tool("office_report").execute("t1", { markdown: fixture("notes-en.md") });
		const json = okJson(result);
		expect(json.kind).toBe("docx");
		expect(json.file).toBe(join(outDir, "Quarterly sales review.docx"));
		expect(statSync(json.file).size).toBeGreaterThan(0);
	});

	it("keeps a climbing file name inside the folder and writes nothing else", async () => {
		const result = await tool("office_report").execute("t1", {
			markdown: fixture("notes-en.md"),
			name: "../../escape",
		});
		expect(okJson(result).file).toBe(join(outDir, "....escape.docx"));
		expect(walk(home).sort()).toEqual(["Documents", "Documents/Sai ATLAS", "Documents/Sai ATLAS/....escape.docx"]);
	});

	it("never replaces an earlier file with the same name", async () => {
		const report = tool("office_report");
		await report.execute("t1", { markdown: fixture("notes-en.md"), name: "Minutes" });
		const second = await report.execute("t2", { markdown: fixture("notes-vi.md"), name: "Minutes" });
		expect(okJson(second).file).toBe(join(outDir, "Minutes (2).docx"));
	});

	it.each(["/home/u/notes.md", "~/notes.md", "notes.md", "./draft.txt", "../report.docx", "  scan.PDF  "])(
		"asks for the text instead of the path %s and writes no file",
		async markdown => {
			const result = await tool("office_report").execute("t1", { markdown });
			expect(result.isError).toBe(true);
			expect(text(result)).toBe("Read the file first, then pass its text as markdown.");
			expect(walk(home)).toEqual([]);
		},
	);

	it("uses the name as the title fallback, else Report", async () => {
		const named = await tool("office_report").execute("t1", { markdown: "Some notes.", name: "Ghi chú" });
		expect(okJson(named).file).toBe(join(outDir, "Ghi chú.docx"));
		const plain = await tool("office_report").execute("t2", { markdown: "Some notes." });
		expect(okJson(plain).file).toBe(join(outDir, "Report.docx"));
	});
});

describe("names and checks in the app language", () => {
	it("names untitled files in Vietnamese and keeps the name valid on every file system", async () => {
		const vi = { lang: "vi" };
		const report = okJson(await tool("office_report", vi).execute("t1", { markdown: "Ghi chú họp." }));
		expect(report.file).toBe(join(outDir, "Báo cáo.docx"));
		expect(report.check).toBe("0 đề mục, 0 bảng, 0 mục danh sách");
		const slides = okJson(
			await tool("office_slides", vi).execute("t2", { markdown: "## Mục tiêu\n\n- Tăng doanh số" }),
		);
		expect(slides.file).toBe(join(outDir, "Bài trình chiếu.pptx"));
		expect(slides.check).toBe("2 trang chiếu (1 trang tiêu đề, 1 trang gạch đầu dòng)");
		const reserved = okJson(await tool("office_report", vi).execute("t3", { markdown: "Ghi chú.", name: "???" }));
		expect(reserved.file).toBe(join(outDir, "Tài liệu.docx"));
		for (const file of [report.file, slides.file, reserved.file]) {
			expect(relative(outDir, file)).not.toMatch(/[\\/:*?"<>|]/);
			expect(file).toBe(file.normalize("NFC"));
		}
	});

	it("falls back to English names for an unknown language", async () => {
		const report = okJson(await tool("office_report", { lang: "fr" }).execute("t1", { markdown: "Notes." }));
		expect(report.file).toBe(join(outDir, "Report.docx"));
		expect(report.check).toBe("0 headings, 0 tables, 0 list items");
		const reserved = okJson(
			await tool("office_report", { lang: "" }).execute("t2", { markdown: "Notes.", name: "???" }),
		);
		expect(reserved.file).toBe(join(outDir, "Document.docx"));
	});
});

describe("error sentences in the app language", () => {
	it("tells the person in Vietnamese when the file is missing or of the wrong kind", async () => {
		const clean = tool("office_clean", { lang: "vi" });
		const missing = await clean.execute("t1", { file: join(home, "nothing.xlsx") });
		expect(missing.isError).toBe(true);
		expect(text(missing)).toBe("Tôi không tìm thấy tệp đó.");
		writeFileSync(join(home, "notes.txt"), "text");
		const wrongKind = await clean.execute("t2", { file: "~/notes.txt" });
		expect(text(wrongKind)).toBe("Tôi chỉ làm sạch được tệp .xlsx, .xls, .ods và .csv.");
	});

	it("tells the person in Vietnamese that a cancelled call made no file", async () => {
		const stopped = new AbortController();
		stopped.abort();
		const result = await tool("office_report", { lang: "vi" }).execute(
			"t1",
			{ markdown: "# A\n\nB" },
			stopped.signal,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Tôi đã dừng trước khi tạo xong tệp.");
		expect(walk(home)).toEqual([]);
	});

	it("keeps the sentence in English for English and for an unknown language", async () => {
		for (const lang of ["en", "fr"]) {
			const result = await tool("office_clean", { lang }).execute("t1", { file: join(home, "nothing.xlsx") });
			expect(text(result)).toBe("I could not find that file.");
		}
	});

	it("keeps argument checks for the model in English whatever the language", async () => {
		const vi = { lang: "vi" };
		const totals = await tool("office_clean", vi).execute("t1", { file: "~/a.xlsx", totals: "yes" });
		expect(text(totals)).toBe("Totals must be true or false.");
		const noSlides = await tool("office_slides", vi).execute("t2", { markdown: "Just one line of text" });
		expect(text(noSlides)).toBe("There are no slides yet. Start each slide with a line beginning with ##.");
	});
});

describe("office_slides", () => {
	it("saves a deck named after the given title", async () => {
		const result = await tool("office_slides").execute("t1", {
			markdown: fixture("report-shapes.md"),
			title: "Board update",
		});
		const json = okJson(result);
		expect(json.kind).toBe("pptx");
		expect(json.file).toBe(join(outDir, "Board update.pptx"));
	});

	it("reports a deck without slides as a plain error", async () => {
		const result = await tool("office_slides").execute("t1", { markdown: "Just one line of text" });
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("There are no slides yet. Start each slide with a line beginning with ##.");
	});
});

describe("office_clean", () => {
	it("writes a cleaned copy beside nothing else and leaves the input unchanged", async () => {
		const input = await spreadsheet("Sales list.xlsx", [
			["Name", "Amount"],
			[" Ann ", "1.500"],
		]);
		const before = readFileSync(input);
		const result = await tool("office_clean", { lang: "vi" }).execute("t1", { file: input });
		const json = okJson(result);
		expect(json.kind).toBe("xlsx");
		expect(json.file).toBe(join(outDir, "Sales list (đã làm sạch).xlsx"));
		expect(json.check).toMatch(/^1 trang tính, giữ 2 dòng, /);
		expect(readFileSync(input).equals(before)).toBe(true);
		const cleaned = new ExcelJS.Workbook();
		await cleaned.xlsx.readFile(json.file);
		expect(cleaned.getWorksheet("Data")?.getCell("B2").value).toBe(1500);
	});

	it("expands ~/ in the path", async () => {
		await spreadsheet("list.xlsx", [["A"], ["1"]]);
		const result = await tool("office_clean").execute("t1", { file: "~/list.xlsx", totals: true, decimal: "dot" });
		const json = okJson(result);
		expect(json.file).toBe(join(outDir, "list (cleaned).xlsx"));
		expect(json.check).toMatch(/^1 sheet, 2 rows kept, /);
	});

	it("names the copy in English for an unknown language", async () => {
		await spreadsheet("list.xlsx", [["A"], ["1"]]);
		const result = await tool("office_clean", { lang: "fr" }).execute("t1", { file: "~/list.xlsx" });
		expect(okJson(result).file).toBe(join(outDir, "list (cleaned).xlsx"));
	});

	it("reports a missing file and a fake workbook without echoing the path", async () => {
		const missing = join(home, "secret-folder", "nothing.xlsx");
		const first = await tool("office_clean").execute("t1", { file: missing });
		expect(first.isError).toBe(true);
		expect(text(first)).not.toContain("secret-folder");
		expect(text(first)).not.toContain("{");

		mkdirSync(join(home, "secret-folder"));
		const fake = join(home, "secret-folder", "fake.xlsx");
		writeFileSync(fake, "just text");
		const second = await tool("office_clean").execute("t2", { file: fake });
		expect(second.isError).toBe(true);
		expect(text(second)).not.toContain("secret-folder");
		expect(text(second)).not.toContain("{");
	});
});

describe("argument checks", () => {
	it.each([
		["office_clean", { file: "~/a.xlsx", totals: "yes" }],
		["office_clean", { file: "~/a.xlsx", decimal: "x" }],
		["office_clean", {}],
		["office_report", {}],
		["office_report", { markdown: 42 }],
		["office_slides", { markdown: "# A\n\n## B", title: 7 }],
		["office_report", null],
	])("%s rejects %j with a plain sentence", async (name, params) => {
		const result = await tool(name).execute("t1", params);
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/^[A-Z][^{}\n]*\.$/);
		expect(walk(home)).toEqual([]);
	});
});

describe("limits and safety", () => {
	it("refuses oversized markdown with a plain sentence", async () => {
		for (const name of ["office_report", "office_slides"]) {
			const markdown = `# Big\n\n${"word ".repeat(220_000)}`;
			const result = await tool(name).execute("t1", { markdown });
			expect(result.isError).toBe(true);
			expect(text(result)).toBe("The text is too long for one file. Split it into smaller parts.");
		}
		expect(walk(home)).toEqual([]);
	});

	it("stops without saving when the signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const report = await tool("office_report").execute("t1", { markdown: fixture("notes-en.md") }, controller.signal);
		expect(report.isError).toBe(true);
		expect(text(report)).toBe("I stopped before the file was made.");
		const input = await spreadsheet("data.xlsx", [["Name"], ["Ann"]]);
		const cleaned = await tool("office_clean").execute("t2", { file: input }, controller.signal);
		expect(cleaned.isError).toBe(true);
		expect(text(cleaned)).toBe("I stopped before the file was made.");
		expect(walk(home)).toEqual(["data.xlsx"]);
	});

	it("refuses an output folder that is a symlink out of Documents", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "sai-atlas-elsewhere-"));
		try {
			mkdirSync(join(home, "Documents"));
			symlinkSync(elsewhere, outDir);
			const result = await tool("office_report").execute("t1", { markdown: fixture("notes-en.md") });
			expect(result.isError).toBe(true);
			expect(text(result)).toBe(
				"The Sai ATLAS folder in Documents leads to another place, so I did not save the file.",
			);
			expect(readdirSync(elsewhere)).toEqual([]);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

describe("definitions", () => {
	it("are essential, write-tier tools with closed parameter schemas", () => {
		const tools = createOfficeTools(env);
		expect(tools.map(definition => definition.name)).toEqual(["office_report", "office_slides", "office_clean"]);
		for (const definition of tools) {
			expect(definition.loadMode).toBe("essential");
			expect(definition.approval).toBe("write");
			expect(definition.parameters.additionalProperties).toBe(false);
			expect(definition.label).not.toBe("");
		}
	});

	it("tell the model to read a file before passing its text", () => {
		for (const name of ["office_report", "office_slides"]) {
			expect(tool(name).description.toLowerCase()).toContain("read the file first");
		}
	});

	it("carry no example values", () => {
		for (const definition of createOfficeTools(env)) {
			const schemaText = JSON.stringify(definition.parameters);
			expect(schemaText).not.toMatch(/example|e\.g\.|for instance|\.xlsx"|\/home|~\//i);
			expect(definition.description).not.toMatch(/example|e\.g\.|for instance|\/home|~\//i);
		}
	});
});
