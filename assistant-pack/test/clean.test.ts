import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CleanOptions, cleanWorkbook, convertLegacy, type RunFile, runInGroup } from "../src/office/clean";
import { zipEntry } from "./zip-helpers";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "sai-atlas-clean-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

type Row = ExcelJS.CellValue[];

async function writeXlsx(name: string, rows: Row[], edit?: (sheet: ExcelJS.Worksheet) => void): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet("Data");
	for (const row of rows) sheet.addRow(row);
	edit?.(sheet);
	const path = join(tmp, name);
	await workbook.xlsx.writeFile(path);
	return path;
}

async function clean(path: string, options: Partial<CleanOptions> = {}) {
	const result = await cleanWorkbook(path, { lang: "en", ...options });
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(Buffer.from(result.bytes) as unknown as ArrayBuffer);
	return { result, workbook };
}

function values(sheet: ExcelJS.Worksheet): Row[] {
	const rows: Row[] = [];
	for (let r = 1; r <= sheet.rowCount; r++) {
		const row: Row = [];
		for (let c = 1; c <= sheet.columnCount; c++) row.push(sheet.getCell(r, c).value ?? null);
		rows.push(row);
	}
	return rows;
}

function column(sheet: ExcelJS.Worksheet, index: number): ExcelJS.Cell[] {
	const cells: ExcelJS.Cell[] = [];
	for (let r = 2; r <= sheet.rowCount; r++) cells.push(sheet.getCell(r, index));
	return cells;
}

const FORMULA_SENTENCE =
	"This file has formulas without saved results. Open it in your spreadsheet app, save it, then try again.";
const SAVE_AS_SENTENCE = "Save this file as .xlsx in your spreadsheet app, then try again.";
const TOO_LARGE_SENTENCE = "This file is too large for me to clean. The limit is 20 MB.";
const TOO_MANY_CELLS_SENTENCE = "This spreadsheet has too many cells for me to clean.";
const STOPPED_SENTENCE = "I stopped before the file was made.";

describe("cleanWorkbook", () => {
	it("trims whitespace and drops empty and exact duplicate rows", async () => {
		const path = await writeXlsx("people.xlsx", [
			["Name", "City"],
			["  Alice   Nguyen ", " Hanoi"],
			[null, "   "],
			["Bob", "Hue"],
			["Bob", "Hue"],
			["Chi", "Hue"],
		]);
		const { workbook, result } = await clean(path);
		expect(values(workbook.getWorksheet("Data") as ExcelJS.Worksheet)).toEqual([
			["Name", "City"],
			["Alice Nguyen", "Hanoi"],
			["Bob", "Hue"],
			["Chi", "Hue"],
		]);
		expect(result.check).toContain("1 empty row removed");
		expect(result.check).toContain("1 duplicate row removed");
	});

	it("keeps identifier columns as text and lists them", async () => {
		const path = await writeXlsx("ids.xlsx", [
			["SĐT", "Code", "Account", "id", "Amount"],
			["0905123456", "0123", "1234567890123456", "77", "1,500"],
			["0912000111", "42", "98", "78", "2,000"],
		]);
		const { workbook, result } = await clean(path);
		const sheet = workbook.getWorksheet("Data") as ExcelJS.Worksheet;
		expect(values(sheet)[1]).toEqual(["0905123456", "0123", "1234567890123456", "77", 1500]);
		expect(values(sheet)[2]).toEqual(["0912000111", "42", "98", "78", 2000]);
		expect(result.check).toContain("kept as text: SĐT, Code, Account, id");
	});

	it("matches identifier headers case-insensitively but accent-sensitively", async () => {
		const path = await writeXlsx("headers.xlsx", [
			["sđt", "SDT"],
			["123", "456"],
		]);
		const { workbook } = await clean(path);
		expect(values(workbook.getWorksheet("Data") as ExcelJS.Worksheet)[1]).toEqual(["123", 456]);
	});

	it("reads numbers with the chosen decimal mark, following the language when none is given", async () => {
		const path = await writeXlsx("numbers.xlsx", [["Amount"], ["1.500"], ["1,5"], ["1,500"]]);
		const comma = await clean(path, { decimal: "comma" });
		expect(values(comma.workbook.getWorksheet("Data") as ExcelJS.Worksheet).slice(1, 3)).toEqual([[1500], [1.5]]);
		const dot = await clean(path, { decimal: "dot" });
		expect(values(dot.workbook.getWorksheet("Data") as ExcelJS.Worksheet)[3]).toEqual([1500]);
		const vi = await clean(path, { lang: "vi" });
		expect(values(vi.workbook.getWorksheet("Data") as ExcelJS.Worksheet)[1]).toEqual([1500]);
		const en = await clean(path, { lang: "en" });
		expect(values(en.workbook.getWorksheet("Data") as ExcelJS.Worksheet)[3]).toEqual([1500]);
	});

	it("turns percentages into fractions and leaves year columns without thousands separators", async () => {
		const path = await writeXlsx("growth.xlsx", [
			["Year", "Growth", "Revenue"],
			["2024", "15%", "12,500"],
			[2025, "7.5%", "13,000"],
		]);
		const { workbook } = await clean(path, { decimal: "dot" });
		const sheet = workbook.getWorksheet("Data") as ExcelJS.Worksheet;
		expect(values(sheet)[1]).toEqual([2024, 0.15, 12500]);
		for (const cell of column(sheet, 2)) expect(cell.numFmt).toBe("0.0%");
		for (const cell of column(sheet, 1)) expect(cell.numFmt ?? "").not.toContain(",");
		for (const cell of column(sheet, 3)) expect(cell.numFmt).toContain(",");
	});

	it("replaces formulas with their saved results and refuses formulas without one", async () => {
		const withResults = await writeXlsx(
			"formulas.xlsx",
			[
				["A", "B", "Sum"],
				[1, 2, null],
			],
			sheet => {
				sheet.getCell("C2").value = { formula: "A2+B2", result: 3 };
			},
		);
		const { workbook } = await clean(withResults);
		const cell = (workbook.getWorksheet("Data") as ExcelJS.Worksheet).getCell("C2");
		expect(cell.value).toBe(3);
		expect(cell.type).toBe(ExcelJS.ValueType.Number);

		const withoutResult = await writeXlsx(
			"unsaved.xlsx",
			[
				["A", "B"],
				[1, null],
			],
			sheet => {
				sheet.getCell("B2").value = { formula: "A2*2" } as ExcelJS.CellFormulaValue;
			},
		);
		await expect(cleanWorkbook(withoutResult, { lang: "en" })).rejects.toThrow(FORMULA_SENTENCE);
	});

	it("unmerges merged ranges and keeps the value in the top-left cell", async () => {
		const path = await writeXlsx(
			"merged.xlsx",
			[
				["Region", "Q1", "Q2"],
				["North", 1, 2],
				["South", 3, 4],
			],
			sheet => {
				sheet.getCell("A4").value = "Note across columns";
				sheet.mergeCells("A4:C4");
			},
		);
		const { workbook, result } = await clean(path);
		const sheet = workbook.getWorksheet("Data") as ExcelJS.Worksheet;
		expect(sheet.model.merges).toEqual([]);
		expect(values(sheet)[3]).toEqual(["Note across columns", null, null]);
		expect(result.check).toContain("1 merged range unmerged");
	});

	it("adds a totals row with SUM formulas, their results and full calculation on load", async () => {
		const path = await writeXlsx("totals.xlsx", [
			["Item", "Qty", "Price"],
			["Pens", 3, "1,000"],
			["Paper", 2, "2,500"],
		]);
		const { workbook, result } = await clean(path, { totals: true, decimal: "dot" });
		const sheet = workbook.getWorksheet("Data") as ExcelJS.Worksheet;
		const last = sheet.getRow(sheet.rowCount);
		expect(last.getCell(1).value).toBe("Total");
		expect(last.getCell(2).value).toEqual({ formula: "SUM(B2:B3)", result: 5 });
		expect(last.getCell(3).value).toEqual({ formula: "SUM(C2:C3)", result: 3500 });
		// ExcelJS's reader drops calcPr, so read the written workbook part itself.
		expect(await zipEntry(result.bytes, "xl/workbook.xml")).toMatch(/<calcPr [^>]*fullCalcOnLoad="1"/);
	});

	it("lists every action with counts on a Changes sheet in the session language", async () => {
		const path = await writeXlsx("changes.xlsx", [
			["Name", "Amount"],
			[" Ann ", "1.500"],
			[null, null],
		]);
		const en = await clean(path, { decimal: "comma" });
		const changes = en.workbook.getWorksheet("Changes") as ExcelJS.Worksheet;
		const rows = values(changes);
		expect(rows[0]).toEqual(["Sheet", "Action", "Count", "Details"]);
		const byAction = new Map(rows.slice(1).map(row => [row[1], row[2]]));
		expect(byAction.get("Cells with extra spaces trimmed")).toBe(1);
		expect(byAction.get("Empty rows removed")).toBe(1);
		expect(byAction.get("Numbers stored as text converted")).toBe(1);
		expect(byAction.get("Duplicate rows removed")).toBe(0);

		const vi = await clean(path, { lang: "vi" });
		expect(vi.workbook.getWorksheet("Thay đổi")).toBeDefined();
		expect(vi.workbook.getWorksheet("Changes")).toBeUndefined();
	});

	it("writes the check in English, with plural endings only above one", async () => {
		const path = await writeXlsx(
			"summary.xlsx",
			[
				["Name", "SĐT", "Amount"],
				[" Ann ", "0905123456", "1,500"],
				[null, null, null],
				["Bob", "0912000111", "2,000"],
				["Bob", "0912000111", "2,000"],
			],
			sheet => {
				sheet.getCell("A6").value = "Note";
				sheet.mergeCells("A6:C6");
			},
		);
		const { result } = await clean(path, { totals: true });
		expect(result.check).toBe(
			"1 sheet, 4 rows kept, 1 empty row removed, 1 duplicate row removed, 1 cell trimmed, " +
				"2 numbers converted, 1 merged range unmerged, kept as text: SĐT, totals row added",
		);
	});

	it("writes the check in Vietnamese without plural endings when the language is vi", async () => {
		const path = await writeXlsx(
			"summary.xlsx",
			[
				["Tên", "SĐT", "Số tiền"],
				[" An ", "0905123456", "1.500"],
				[null, null, null],
				["Bình", "0912000111", "2.000"],
				["Bình", "0912000111", "2.000"],
			],
			sheet => {
				sheet.getCell("A6").value = "Ghi chú";
				sheet.mergeCells("A6:C6");
			},
		);
		const { result } = await clean(path, { lang: "vi", totals: true });
		expect(result.check).toBe(
			"1 trang tính, giữ 4 dòng, xóa 1 dòng trống, xóa 1 dòng trùng lặp, bỏ khoảng trắng thừa ở 1 ô, " +
				"chuyển 2 giá trị thành số, tách 1 vùng ô gộp, giữ dạng chữ: SĐT, đã thêm dòng tổng",
		);
	});

	it("writes the check in English for an unknown language", async () => {
		const path = await writeXlsx("summary.xlsx", [["A"], ["1"]]);
		const { result } = await clean(path, { lang: "fr", decimal: "dot" });
		expect(result.check).toMatch(/^1 sheet, 2 rows kept, /);
	});

	it("never changes the input file", async () => {
		const path = await writeXlsx("keep.xlsx", [
			["Name", "Amount"],
			[" Ann ", "1.500"],
		]);
		const before = readFileSync(path);
		await clean(path, { totals: true });
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("accepts .csv input and keeps leading zeros", async () => {
		const path = join(tmp, "contacts.csv");
		writeFileSync(path, "﻿Name;Phone;Amount\nAnn;0905123456;1.500\nBinh;0912000111;2.000\n");
		const { workbook, result } = await clean(path, { lang: "vi" });
		const sheet = workbook.worksheets.find(ws => ws.name !== "Thay đổi" && ws.name !== "Changes");
		expect(values(sheet as ExcelJS.Worksheet)).toEqual([
			["Name", "Phone", "Amount"],
			["Ann", "0905123456", 1500],
			["Binh", "0912000111", 2000],
		]);
		expect(result.check).toContain("giữ dạng chữ: Phone");
	});

	it("refuses an unknown file type, a missing file and an unreadable workbook with plain sentences", async () => {
		const text = join(tmp, "notes.txt");
		writeFileSync(text, "hello");
		await expect(cleanWorkbook(text, { lang: "en" })).rejects.toThrow(
			"I can only clean .xlsx, .xls, .ods and .csv files.",
		);
		await expect(cleanWorkbook(join(tmp, "missing.xlsx"), { lang: "en" })).rejects.toThrow(
			"I could not find that file.",
		);
		const fake = join(tmp, "fake.xlsx");
		writeFileSync(fake, "not a workbook");
		await expect(cleanWorkbook(fake, { lang: "en" })).rejects.toThrow("I could not read this spreadsheet.");
	});

	it("cleans only the named sheet and refuses an unknown sheet name", async () => {
		const path = await writeXlsx("two.xlsx", [["A"], ["1"]], sheet => {
			sheet.workbook.addWorksheet("Other").addRow(["B"]);
		});
		const { workbook } = await clean(path, { sheet: "Other" });
		expect(workbook.worksheets.map(ws => ws.name)).toEqual(["Other", "Changes"]);
		await expect(cleanWorkbook(path, { lang: "en", sheet: "Nope" })).rejects.toThrow(
			"This file has no sheet with that name.",
		);
	});
});

describe("cleanWorkbook limits", () => {
	it.each(["big.xlsx", "big.csv"])("refuses a workbook over the byte cap (%s)", async name => {
		const path = join(tmp, name);
		writeFileSync(path, "");
		truncateSync(path, 20 * 1024 * 1024 + 1);
		await expect(cleanWorkbook(path, { lang: "en" })).rejects.toThrow(TOO_LARGE_SENTENCE);
	});

	it("refuses a sheet with too many cells", async () => {
		const path = await writeXlsx("sparse.xlsx", [["Name"]], sheet => {
			sheet.getCell("XFD1048576").value = 1;
		});
		await expect(cleanWorkbook(path, { lang: "en" })).rejects.toThrow(TOO_MANY_CELLS_SENTENCE);
	});

	it("stops between sheets when the signal is aborted", async () => {
		const workbook = new ExcelJS.Workbook();
		workbook.addWorksheet("One").addRows([["A"], ["1"]]);
		workbook.addWorksheet("Two").addRows([["B"], ["2"]]);
		const path = join(tmp, "two.xlsx");
		await workbook.xlsx.writeFile(path);

		const before = new AbortController();
		before.abort();
		await expect(cleanWorkbook(path, { lang: "en", signal: before.signal })).rejects.toThrow(STOPPED_SENTENCE);

		const during = new AbortController();
		const run = cleanWorkbook(path, { lang: "en", signal: during.signal });
		during.abort();
		await expect(run).rejects.toThrow(STOPPED_SENTENCE);
	});
});

describe("legacy formats", () => {
	interface Call {
		file: string;
		args: readonly string[];
		timeout: number;
	}

	function enoent(file: string): Error {
		return Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
	}

	it("converts with soffice in a private profile, then falls back to libreoffice", async () => {
		const input = join(tmp, "Báo cáo.ods");
		writeFileSync(input, "ods bytes");
		const calls: Call[] = [];
		const outDir = mkdtempSync(join(tmp, "out-"));
		const run: RunFile = async (file, args, options) => {
			calls.push({ file, args, timeout: options.timeout });
			if (file === "soffice") throw enoent(file);
			writeFileSync(join(outDir, "Báo cáo.xlsx"), "converted");
		};
		const converted = await convertLegacy(input, { run, tmpDir: outDir });
		expect(converted).toBe(join(outDir, "Báo cáo.xlsx"));
		const expectedArgs = [
			"--headless",
			`-env:UserInstallation=${pathToFileURL(join(outDir, "lo-profile")).href}`,
			"--convert-to",
			"xlsx",
			"--outdir",
			outDir,
			input,
		];
		expect(calls).toEqual([
			{ file: "soffice", args: expectedArgs, timeout: 60_000 },
			{ file: "libreoffice", args: expectedArgs, timeout: 60_000 },
		]);
		expect(expectedArgs[1]).toBe(`-env:UserInstallation=file://${outDir}/lo-profile`);
	});

	it("says to save as .xlsx when neither command exists or the conversion fails", async () => {
		const input = join(tmp, "old.xls");
		writeFileSync(input, "xls bytes");
		const missing: RunFile = async file => {
			throw enoent(file);
		};
		await expect(convertLegacy(input, { run: missing, tmpDir: tmp })).rejects.toThrow(SAVE_AS_SENTENCE);
		const failing: RunFile = async () => {
			throw Object.assign(new Error("exit 1"), { code: 1 });
		};
		await expect(convertLegacy(input, { run: failing, tmpDir: tmp })).rejects.toThrow(SAVE_AS_SENTENCE);
		const silent: RunFile = async () => undefined;
		await expect(convertLegacy(input, { run: silent, tmpDir: tmp })).rejects.toThrow(SAVE_AS_SENTENCE);
	});

	it("cleans the converted copy of an .ods file and leaves the input untouched", async () => {
		const input = join(tmp, "Danh sách.ods");
		writeFileSync(input, "original ods bytes");
		const source = new ExcelJS.Workbook();
		source.addWorksheet("Trang 1").addRows([
			["Tên", "Số tiền"],
			[" An ", "1.500"],
		]);
		const convertedBytes = Buffer.from(await source.xlsx.writeBuffer());
		const convert: RunFile = async (_file, args) => {
			const outDir = args[args.indexOf("--outdir") + 1];
			writeFileSync(join(outDir, `${basename(input, ".ods")}.xlsx`), convertedBytes);
		};
		const { workbook } = await clean(input, { lang: "vi", convert });
		expect(values(workbook.getWorksheet("Trang 1") as ExcelJS.Worksheet)).toEqual([
			["Tên", "Số tiền"],
			["An", 1500],
		]);
		expect(readFileSync(input, "utf8")).toBe("original ods bytes");
	});

	it("refuses a legacy file when no converter is available", async () => {
		const input = join(tmp, "old.xls");
		writeFileSync(input, "xls bytes");
		const convert: RunFile = async file => {
			throw enoent(file);
		};
		await expect(cleanWorkbook(input, { lang: "en", convert })).rejects.toThrow(SAVE_AS_SENTENCE);
	});
});

describe("running the converter", () => {
	/** A launcher that starts a long-running child and waits for it, as LibreOffice's oosplash does. */
	function launcher(pidFile: string): [string, string[]] {
		return ["sh", ["-c", `sleep 30 & echo $! > '${pidFile}'; wait`]];
	}

	/** True once `pid` has exited (a zombie counts as exited). */
	function gone(pid: number): boolean {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		// The process can be reaped at any moment, so a missing entry counts as gone too.
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			return true;
		}
		return stat.split(") ")[1]?.startsWith("Z") === true;
	}

	async function waitGone(pid: number): Promise<boolean> {
		for (let attempt = 0; attempt < 60 && !gone(pid); attempt++) await new Promise(r => setTimeout(r, 50));
		return gone(pid);
	}

	async function childPid(pidFile: string): Promise<number> {
		for (let attempt = 0; attempt < 60 && !existsSync(pidFile); attempt++) await new Promise(r => setTimeout(r, 50));
		return Number(readFileSync(pidFile, "utf8").trim());
	}

	function recordingKill() {
		const calls: [number, NodeJS.Signals][] = [];
		const kill = (pid: number, signal: NodeJS.Signals) => {
			calls.push([pid, signal]);
			process.kill(pid, signal);
		};
		return { calls, kill };
	}

	it("kills the whole process group on timeout, the launcher's child included", async () => {
		const pidFile = join(tmp, "child.pid");
		const [file, args] = launcher(pidFile);
		const { calls, kill } = recordingKill();
		const run = runInGroup(file, args, { timeout: 500 }, kill);
		const grandchild = await childPid(pidFile);
		await expect(run).rejects.toThrow("timed out after 500 ms");
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBeLessThan(0);
		expect(calls[0][1]).toBe("SIGKILL");
		expect(await waitGone(grandchild)).toBe(true);
	});

	it("kills the whole process group when the clean-up is stopped", async () => {
		const pidFile = join(tmp, "child.pid");
		const [file, args] = launcher(pidFile);
		const { calls, kill } = recordingKill();
		const stop = new AbortController();
		const run = runInGroup(file, args, { timeout: 30_000, signal: stop.signal }, kill);
		const grandchild = await childPid(pidFile);
		stop.abort();
		await expect(run).rejects.toThrow("aborted");
		expect(calls).toEqual([[calls[0][0], "SIGKILL"]]);
		expect(calls[0][0]).toBeLessThan(0);
		expect(await waitGone(grandchild)).toBe(true);
	});

	it("resolves on success, rejects on a failed exit and keeps ENOENT for a missing program", async () => {
		const { calls, kill } = recordingKill();
		await expect(runInGroup("true", [], { timeout: 5_000 }, kill)).resolves.toBeUndefined();
		await expect(runInGroup("false", [], { timeout: 5_000 }, kill)).rejects.toThrow("code 1");
		await expect(runInGroup("sai-atlas-no-such-program", [], { timeout: 5_000 }, kill)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(calls).toEqual([]);
	});

	it("passes the stop signal to the converter and reports a stop, not a format problem", async () => {
		const input = join(tmp, "old.xls");
		writeFileSync(input, "xls bytes");
		const stop = new AbortController();
		const seen: (AbortSignal | undefined)[] = [];
		const run: RunFile = async (_file, _args, options) => {
			seen.push(options.signal);
			stop.abort();
			throw new Error("aborted");
		};
		await expect(convertLegacy(input, { run, tmpDir: tmp, signal: stop.signal })).rejects.toThrow(STOPPED_SENTENCE);
		expect(seen).toEqual([stop.signal]);
	});
});
