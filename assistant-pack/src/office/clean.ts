// Spreadsheet path -> a tidy copy (.xlsx). The input file is only ever read.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { countOf } from "./markdown";
import { PlainError, type PlainText, throwIfStopped } from "./output";

export type Decimal = "comma" | "dot";

/** Runs a program from an argv array (never a shell string); rejects on failure, timeout or abort. */
export type RunFile = (
	file: string,
	args: readonly string[],
	options: { timeout: number; signal?: AbortSignal },
) => Promise<unknown>;

export interface CleanOptions {
	/** Clean only this sheet; every sheet when absent. */
	sheet?: string;
	/** Add a totals row under each sheet. */
	totals?: boolean;
	/** Decimal mark of numbers stored as text; follows `lang` when absent. */
	decimal?: Decimal;
	/** Session language (`SAI_ATLAS_LANG`): `vi` reads decimal commas and writes the sheet names and check in Vietnamese. */
	lang: string;
	/** Runs LibreOffice for .xls and .ods input. */
	convert?: RunFile;
	/** Cancels the clean-up; checked before each sheet and every few hundred rows. */
	signal?: AbortSignal;
}

export interface CleanedWorkbook {
	bytes: Uint8Array;
	check: string;
}

const FORMULA_WITHOUT_RESULT: PlainText = {
	en: "This file has formulas without saved results. Open it in your spreadsheet app, save it, then try again.",
	vi: "Tệp này có công thức chưa lưu kết quả. Hãy mở tệp trong ứng dụng bảng tính, lưu lại rồi thử lại.",
};
const SAVE_AS_XLSX: PlainText = {
	en: "Save this file as .xlsx in your spreadsheet app, then try again.",
	vi: "Hãy lưu tệp này dưới dạng .xlsx trong ứng dụng bảng tính rồi thử lại.",
};
const CONVERT_TIMEOUT_MS = 60_000;
const TOO_LARGE: PlainText = {
	en: "This file is too large for me to clean. The limit is 20 MB.",
	vi: "Tệp này quá lớn nên tôi không làm sạch được. Giới hạn là 20 MB.",
};
const TOO_MANY_CELLS: PlainText = {
	en: "This spreadsheet has too many cells for me to clean.",
	vi: "Bảng tính này có quá nhiều ô nên tôi không làm sạch được.",
};
const NOT_FOUND: PlainText = { en: "I could not find that file.", vi: "Tôi không tìm thấy tệp đó." };
const WRONG_KIND: PlainText = {
	en: "I can only clean .xlsx, .xls, .ods and .csv files.",
	vi: "Tôi chỉ làm sạch được tệp .xlsx, .xls, .ods và .csv.",
};
const UNREADABLE: PlainText = { en: "I could not read this spreadsheet.", vi: "Tôi không đọc được bảng tính này." };
const NO_SUCH_SHEET: PlainText = {
	en: "This file has no sheet with that name.",
	vi: "Tệp này không có trang tính nào mang tên đó.",
};
const NO_SHEETS: PlainText = { en: "This file has no sheets.", vi: "Tệp này không có trang tính nào." };
/**
 * The clean-up runs inside the agent process, so a workbook is refused before it is loaded
 * when its file is over this size (a zip bomb or a huge export would starve the session).
 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** Rows × columns over every cleaned sheet; a stray cell at XFD1048576 would mean 17 billion. */
const MAX_CELLS = 2_000_000;
/** Rows read between two checks of the stop signal (each check lets the event loop run). */
const ROWS_PER_TURN = 500;
/** Excel keeps 15 significant digits; longer digit strings are identifiers, not amounts. */
const MAX_NUMBER_DIGITS = 15;
const ID_HEADERS = new Set(
	["SĐT", "CCCD", "CMND", "MST", "Mã", "Số tài khoản", "Phone", "ID"].map(header => header.toLocaleLowerCase("vi")),
);
const PERCENT_FORMAT = "0.0%";
const YEAR_FORMAT = "0";
const INTEGER_FORMAT = "#,##0";
const DECIMAL_FORMAT = "#,##0.00";
const TEXT_FORMAT = "@";

const LABELS = {
	en: {
		changes: "Changes",
		total: "Total",
		header: ["Sheet", "Action", "Count", "Details"],
		trimmed: "Cells with extra spaces trimmed",
		emptyRows: "Empty rows removed",
		duplicateRows: "Duplicate rows removed",
		numbers: "Numbers stored as text converted",
		percents: "Percentages converted",
		formulas: "Formulas replaced by their values",
		merges: "Merged cells unmerged",
		textColumns: "Columns kept as text",
		totals: "Totals row added",
	},
	vi: {
		changes: "Thay đổi",
		total: "Tổng cộng",
		header: ["Trang tính", "Thao tác", "Số lượng", "Chi tiết"],
		trimmed: "Ô đã bỏ khoảng trắng thừa",
		emptyRows: "Dòng trống đã xóa",
		duplicateRows: "Dòng trùng lặp đã xóa",
		numbers: "Số lưu dạng chữ đã chuyển thành số",
		percents: "Phần trăm đã chuyển thành số",
		formulas: "Công thức đã thay bằng giá trị",
		merges: "Ô gộp đã tách",
		textColumns: "Cột giữ dạng chữ",
		totals: "Đã thêm dòng tổng",
	},
} as const;

type Labels = (typeof LABELS)[keyof typeof LABELS];
type Value = string | number | boolean | Date | null;

interface Cell {
	value: Value;
	numFmt?: string;
}

/** A cell of the written sheet: a cleaned value, or a totals formula with its result. */
interface OutCell {
	value: Value | ExcelJS.CellFormulaValue;
	numFmt?: string;
}

interface SheetReport {
	name: string;
	trimmed: number;
	emptyRows: number;
	duplicateRows: number;
	numbers: number;
	percents: number;
	formulas: number;
	merges: number;
	textColumns: string[];
	totals: boolean;
}

/**
 * Runs `file` in a process group of its own and, on timeout or abort, kills the whole
 * group. LibreOffice's launcher (`oosplash`) starts `soffice.bin` as a child; killing
 * only the launcher can leave a stuck `soffice.bin` behind and the call never settles.
 */
export function runInGroup(
	file: string,
	args: readonly string[],
	options: { timeout: number; signal?: AbortSignal },
	kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(file, [...args], { detached: true, stdio: "ignore" });
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const killGroup = (reason: string) => {
			if (child.pid !== undefined) {
				try {
					kill(-child.pid, "SIGKILL");
				} catch {
					// The group is already gone.
				}
			}
			finish(new Error(reason));
		};
		const onAbort = () => killGroup("aborted");
		const timer = setTimeout(() => killGroup(`timed out after ${options.timeout} ms`), options.timeout);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", finish);
		child.once("exit", (code, signal) => {
			finish(code === 0 ? undefined : new Error(`${file} exited with ${signal ?? `code ${code}`}`));
		});
	});
}

const defaultRun: RunFile = (file, args, options) => runInGroup(file, args, options);

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Converts an .xls or .ods file to .xlsx inside `tmpDir` with LibreOffice, using a
 * private profile so a running LibreOffice does not block the conversion.
 */
export async function convertLegacy(
	path: string,
	options: { run: RunFile; tmpDir: string; signal?: AbortSignal },
): Promise<string> {
	const args = [
		"--headless",
		`-env:UserInstallation=${pathToFileURL(join(options.tmpDir, "lo-profile")).href}`,
		"--convert-to",
		"xlsx",
		"--outdir",
		options.tmpDir,
		path,
	];
	for (const command of ["soffice", "libreoffice"]) {
		try {
			await options.run(command, args, { timeout: CONVERT_TIMEOUT_MS, signal: options.signal });
		} catch (error) {
			throwIfStopped(options.signal);
			if (isEnoent(error)) continue;
			throw new PlainError(SAVE_AS_XLSX);
		}
		const converted = join(options.tmpDir, `${basename(path, extname(path))}.xlsx`);
		if (!existsSync(converted)) throw new PlainError(SAVE_AS_XLSX);
		return converted;
	}
	throw new PlainError(SAVE_AS_XLSX);
}

/** Lets a pending cancel arrive, then stops when it did. */
async function checkpoint(signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return;
	await nextTurn();
	throwIfStopped(signal);
}

function assertSmallEnough(path: string): void {
	if (statSync(path).size > MAX_INPUT_BYTES) throw new PlainError(TOO_LARGE);
}

function sniffDelimiter(text: string): string {
	const firstLine = text.split("\n", 1)[0];
	const count = (char: string) => firstLine.split(char).length - 1;
	return count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ",";
}

async function readCsv(path: string): Promise<ExcelJS.Workbook> {
	const text = readFileSync(path, "utf8").replace(/^﻿/, "");
	const workbook = new ExcelJS.Workbook();
	// Keep every value as text: the default mapper would drop leading zeros and guess dates.
	await workbook.csv.read(Readable.from([text]), {
		map: (value: unknown) => value,
		parserOptions: { delimiter: sniffDelimiter(text) },
	});
	return workbook;
}

async function readWorkbook(inPath: string, run: RunFile, signal: AbortSignal | undefined): Promise<ExcelJS.Workbook> {
	if (!existsSync(inPath) || !statSync(inPath).isFile()) throw new PlainError(NOT_FOUND);
	const ext = extname(inPath).toLowerCase();
	if (![".xlsx", ".xls", ".ods", ".csv"].includes(ext)) {
		throw new PlainError(WRONG_KIND);
	}
	assertSmallEnough(inPath);
	if (ext === ".xls" || ext === ".ods") {
		const tmpDir = mkdtempSync(join(tmpdir(), "sai-atlas-convert-"));
		try {
			return await readXlsx(await convertLegacy(inPath, { run, tmpDir, signal }));
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}
	if (ext === ".csv") {
		try {
			return await readCsv(inPath);
		} catch {
			throw new PlainError(UNREADABLE);
		}
	}
	return readXlsx(inPath);
}

async function readXlsx(path: string): Promise<ExcelJS.Workbook> {
	// A converted .xls or .ods can be larger than its source.
	assertSmallEnough(path);
	const workbook = new ExcelJS.Workbook();
	try {
		await workbook.xlsx.readFile(path);
	} catch {
		throw new PlainError(UNREADABLE);
	}
	return workbook;
}

/** A cell's value with formulas replaced by their saved result; throws when a formula has none. */
function plainValue(cell: ExcelJS.Cell, report: SheetReport): Value {
	switch (cell.type) {
		case ExcelJS.ValueType.Null:
		case ExcelJS.ValueType.Merge:
			return null;
		case ExcelJS.ValueType.Formula: {
			const result = (cell.value as { result?: unknown }).result;
			if (result === undefined) throw new PlainError(FORMULA_WITHOUT_RESULT);
			report.formulas++;
			return resultValue(result);
		}
		case ExcelJS.ValueType.RichText:
			return (cell.value as ExcelJS.CellRichTextValue).richText.map(part => part.text).join("");
		case ExcelJS.ValueType.Hyperlink: {
			const link = cell.value as ExcelJS.CellHyperlinkValue;
			return typeof link.text === "string" ? link.text : link.hyperlink;
		}
		case ExcelJS.ValueType.Error:
			return (cell.value as ExcelJS.CellErrorValue).error;
		default:
			return resultValue(cell.value);
	}
}

function resultValue(value: unknown): Value {
	if (value === null || value === undefined) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Date) return value;
	if (typeof value === "object" && "error" in value) return String((value as { error: unknown }).error);
	return String(value);
}

/** Parses number text written with the given decimal mark; undefined when it is not a plain number. */
function parseNumber(text: string, decimal: Decimal): number | undefined {
	const grouped = decimal === "comma" ? /^-?\d{1,3}(\.\d{3})+(,\d+)?$/ : /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
	const plain = decimal === "comma" ? /^-?\d+(,\d+)?$/ : /^-?\d+(\.\d+)?$/;
	if (!grouped.test(text) && !plain.test(text)) return undefined;
	const normalized = decimal === "comma" ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
	const number = Number(normalized);
	return Number.isFinite(number) ? number : undefined;
}

function parsePercent(text: string, decimal: Decimal): number | undefined {
	const match = /^(.+?)\s?%$/.exec(text);
	if (!match) return undefined;
	const number = parseNumber(match[1], decimal);
	return number === undefined ? undefined : number / 100;
}

function digitCount(text: string): number {
	return text.replace(/\D/g, "").length;
}

function isIdentifierColumn(header: Value, data: readonly Value[]): boolean {
	if (typeof header === "string" && ID_HEADERS.has(header.toLocaleLowerCase("vi"))) return true;
	return data.some(
		value =>
			typeof value === "string" &&
			/^[\d\s.+-]+$/.test(value) &&
			(/^0\d/.test(value) || digitCount(value) > MAX_NUMBER_DIGITS),
	);
}

function isYearColumn(cells: readonly Cell[]): boolean {
	const present = cells.filter(cell => cell.value !== null);
	return (
		present.length > 0 &&
		present.every(
			cell =>
				typeof cell.value === "number" && Number.isInteger(cell.value) && cell.value >= 1900 && cell.value <= 2100,
		)
	);
}

function columnName(header: Value, index: number): string {
	return typeof header === "string" && header ? header : `${index + 1}`;
}

/** Reads one sheet into trimmed rows without empty or duplicate rows. */
async function readRows(
	sheet: ExcelJS.Worksheet,
	report: SheetReport,
	signal: AbortSignal | undefined,
): Promise<Cell[][]> {
	const rows: Cell[][] = [];
	const seen = new Set<string>();
	for (let r = 1; r <= sheet.rowCount; r++) {
		if (r % ROWS_PER_TURN === 0) await checkpoint(signal);
		const row: Cell[] = [];
		for (let c = 1; c <= sheet.columnCount; c++) {
			const source = sheet.getCell(r, c);
			if (source.isMerged && source.master.address === source.address) report.merges++;
			let value = plainValue(source, report);
			if (typeof value === "string") {
				const trimmed = value.replace(/\s+/g, " ").trim();
				if (trimmed !== value) report.trimmed++;
				value = trimmed === "" ? null : trimmed;
			}
			const numFmt = typeof source.numFmt === "string" && source.numFmt !== "General" ? source.numFmt : undefined;
			row.push(numFmt ? { value, numFmt } : { value });
		}
		if (row.every(cell => cell.value === null)) {
			report.emptyRows++;
			continue;
		}
		const key = JSON.stringify(row.map(cell => (cell.value instanceof Date ? cell.value.toISOString() : cell.value)));
		if (seen.has(key)) {
			report.duplicateRows++;
			continue;
		}
		seen.add(key);
		rows.push(row);
	}
	return rows;
}

/** Types every data column: identifiers stay text, number text becomes numbers. */
function typeColumns(rows: Cell[][], decimal: Decimal, report: SheetReport): void {
	const [header, ...data] = rows;
	if (!header) return;
	for (let c = 0; c < header.length; c++) {
		const cells = data.map(row => row[c]);
		if (
			isIdentifierColumn(
				header[c].value,
				cells.map(cell => cell.value),
			)
		) {
			report.textColumns.push(columnName(header[c].value, c));
			for (const cell of cells) {
				if (cell.value === null) continue;
				cell.value = cell.value instanceof Date ? cell.value.toISOString() : String(cell.value);
				cell.numFmt = TEXT_FORMAT;
			}
			continue;
		}
		for (const cell of cells) {
			if (typeof cell.value !== "string") continue;
			const percent = parsePercent(cell.value, decimal);
			if (percent !== undefined) {
				cell.value = percent;
				cell.numFmt = PERCENT_FORMAT;
				report.percents++;
				continue;
			}
			const number = parseNumber(cell.value, decimal);
			if (number !== undefined) {
				cell.value = number;
				cell.numFmt = undefined;
				report.numbers++;
			}
		}
		const numbers = cells.filter(cell => typeof cell.value === "number" && cell.numFmt !== PERCENT_FORMAT);
		if (isYearColumn(cells)) {
			for (const cell of numbers) cell.numFmt = YEAR_FORMAT;
		} else if (numbers.length > 0) {
			const format = numbers.every(cell => Number.isInteger(cell.value)) ? INTEGER_FORMAT : DECIMAL_FORMAT;
			for (const cell of numbers) cell.numFmt ??= format;
		}
	}
}

function columnLetter(index: number): string {
	let n = index + 1;
	let letters = "";
	while (n > 0) {
		const rem = (n - 1) % 26;
		letters = String.fromCharCode(65 + rem) + letters;
		n = Math.floor((n - 1) / 26);
	}
	return letters;
}

/** SUM formulas (with their result) under every column of plain amounts. */
function totalsRow(rows: Cell[][], labels: Labels): OutCell[] | undefined {
	const [header, ...data] = rows;
	if (!header || data.length === 0) return undefined;
	const lastRow = rows.length;
	const totals: OutCell[] = header.map((_, c): OutCell => {
		const cells = data.map(row => row[c]);
		const summable =
			cells.some(cell => typeof cell.value === "number") &&
			cells.every(
				cell =>
					cell.value === null ||
					(typeof cell.value === "number" && cell.numFmt !== PERCENT_FORMAT && cell.numFmt !== YEAR_FORMAT),
			);
		if (!summable) return { value: null };
		const letter = columnLetter(c);
		const result = cells.reduce((sum, cell) => sum + (typeof cell.value === "number" ? cell.value : 0), 0);
		const numFmt = cells.find(cell => typeof cell.value === "number")?.numFmt;
		return { value: { formula: `SUM(${letter}2:${letter}${lastRow})`, result }, numFmt };
	});
	if (totals.every(cell => cell.value === null)) return undefined;
	if (totals[0].value === null) totals[0] = { value: labels.total };
	return totals;
}

function writeSheet(target: ExcelJS.Worksheet, rows: readonly OutCell[][]): void {
	rows.forEach((row, r) => {
		row.forEach((cell, c) => {
			if (cell.value === null) return;
			const out = target.getCell(r + 1, c + 1);
			out.value = cell.value;
			if (cell.numFmt) out.numFmt = cell.numFmt;
		});
	});
	target.getRow(1).font = { bold: true };
	target.views = [{ state: "frozen", ySplit: 1 }];
	const columns = rows[0]?.length ?? 0;
	for (let c = 0; c < columns; c++) {
		const width = Math.max(...rows.map(row => displayLength(row[c]?.value ?? null)), 4);
		target.getColumn(c + 1).width = Math.min(width + 2, 60);
	}
}

function displayLength(value: OutCell["value"]): number {
	if (value === null) return 0;
	if (typeof value === "object" && !(value instanceof Date)) return 10;
	return String(value instanceof Date ? "0000-00-00" : value).length;
}

function uniqueSheetName(workbook: ExcelJS.Workbook, name: string): string {
	const taken = new Set(workbook.worksheets.map(ws => ws.name.toLocaleLowerCase()));
	if (!taken.has(name.toLocaleLowerCase())) return name;
	for (let n = 2; ; n++) {
		const candidate = `${name} (${n})`;
		if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

function writeChanges(workbook: ExcelJS.Workbook, reports: readonly SheetReport[], labels: Labels): void {
	const sheet = workbook.addWorksheet(uniqueSheetName(workbook, labels.changes));
	sheet.addRow([...labels.header]);
	for (const report of reports) {
		const rows: [string, number, string?][] = [
			[labels.trimmed, report.trimmed],
			[labels.emptyRows, report.emptyRows],
			[labels.duplicateRows, report.duplicateRows],
			[labels.numbers, report.numbers],
			[labels.percents, report.percents],
			[labels.formulas, report.formulas],
			[labels.merges, report.merges],
			[labels.textColumns, report.textColumns.length, report.textColumns.join(", ")],
		];
		if (report.totals) rows.push([labels.totals, 1]);
		for (const [action, count, details] of rows) sheet.addRow([report.name, action, count, details || null]);
	}
	sheet.getRow(1).font = { bold: true };
	sheet.views = [{ state: "frozen", ySplit: 1 }];
	sheet.getColumn(1).width = 20;
	sheet.getColumn(2).width = 40;
	sheet.getColumn(3).width = 10;
	sheet.getColumn(4).width = 40;
}

interface Totals {
	sheets: number;
	rowsKept: number;
	emptyRows: number;
	duplicateRows: number;
	trimmed: number;
	numbers: number;
	formulas: number;
	merges: number;
	textColumns: string[];
	totals: boolean;
}

/** The check line, in the session language; Vietnamese has no plural. */
const SUMMARY: Record<"en" | "vi", (totals: Totals) => string[]> = {
	en: t => [
		countOf(t.sheets, "sheet"),
		`${countOf(t.rowsKept, "row")} kept`,
		`${countOf(t.emptyRows, "empty row")} removed`,
		`${countOf(t.duplicateRows, "duplicate row")} removed`,
		`${countOf(t.trimmed, "cell")} trimmed`,
		`${countOf(t.numbers, "number")} converted`,
		...(t.formulas > 0 ? [`${countOf(t.formulas, "formula")} replaced by values`] : []),
		...(t.merges > 0 ? [`${countOf(t.merges, "merged range")} unmerged`] : []),
		...(t.textColumns.length > 0 ? [`kept as text: ${t.textColumns.join(", ")}`] : []),
		...(t.totals ? ["totals row added"] : []),
	],
	vi: t => [
		`${t.sheets} trang tính`,
		`giữ ${t.rowsKept} dòng`,
		`xóa ${t.emptyRows} dòng trống`,
		`xóa ${t.duplicateRows} dòng trùng lặp`,
		`bỏ khoảng trắng thừa ở ${t.trimmed} ô`,
		`chuyển ${t.numbers} giá trị thành số`,
		...(t.formulas > 0 ? [`thay ${t.formulas} công thức bằng giá trị`] : []),
		...(t.merges > 0 ? [`tách ${t.merges} vùng ô gộp`] : []),
		...(t.textColumns.length > 0 ? [`giữ dạng chữ: ${t.textColumns.join(", ")}`] : []),
		...(t.totals ? ["đã thêm dòng tổng"] : []),
	],
};

function summary(reports: readonly SheetReport[], rowsKept: number, lang: string): string {
	const sum = (key: "trimmed" | "emptyRows" | "duplicateRows" | "numbers" | "percents" | "formulas" | "merges") =>
		reports.reduce((total, report) => total + report[key], 0);
	const totals: Totals = {
		sheets: reports.length,
		rowsKept,
		emptyRows: sum("emptyRows"),
		duplicateRows: sum("duplicateRows"),
		trimmed: sum("trimmed"),
		numbers: sum("numbers") + sum("percents"),
		formulas: sum("formulas"),
		merges: sum("merges"),
		textColumns: reports.flatMap(report => report.textColumns),
		totals: reports.some(report => report.totals),
	};
	return SUMMARY[lang === "vi" ? "vi" : "en"](totals).join(", ");
}

/** Builds a tidy copy of the spreadsheet at `inPath`; the input file is never written. */
export async function cleanWorkbook(inPath: string, options: CleanOptions): Promise<CleanedWorkbook> {
	const labels = options.lang === "vi" ? LABELS.vi : LABELS.en;
	const decimal = options.decimal ?? (options.lang === "vi" ? "comma" : "dot");
	throwIfStopped(options.signal);
	const source = await readWorkbook(inPath, options.convert ?? defaultRun, options.signal);
	const sheets = options.sheet ? source.worksheets.filter(ws => ws.name === options.sheet) : source.worksheets;
	if (sheets.length === 0) {
		throw new PlainError(options.sheet ? NO_SUCH_SHEET : NO_SHEETS);
	}

	const cells = sheets.reduce((total, sheet) => total + sheet.rowCount * sheet.columnCount, 0);
	if (cells > MAX_CELLS) throw new PlainError(TOO_MANY_CELLS);

	const out = new ExcelJS.Workbook();
	out.creator = "Sai ATLAS";
	const reports: SheetReport[] = [];
	let rowsKept = 0;
	for (const sheet of sheets) {
		await checkpoint(options.signal);
		const report: SheetReport = {
			name: sheet.name,
			trimmed: 0,
			emptyRows: 0,
			duplicateRows: 0,
			numbers: 0,
			percents: 0,
			formulas: 0,
			merges: 0,
			textColumns: [],
			totals: false,
		};
		const rows = await readRows(sheet, report, options.signal);
		typeColumns(rows, decimal, report);
		rowsKept += rows.length;
		const totals = options.totals ? totalsRow(rows, labels) : undefined;
		if (totals) report.totals = true;
		writeSheet(out.addWorksheet(uniqueSheetName(out, sheet.name)), totals ? [...rows, totals] : rows);
		reports.push(report);
	}
	await checkpoint(options.signal);
	writeChanges(out, reports, labels);
	if (options.totals) out.calcProperties.fullCalcOnLoad = true;
	const bytes = new Uint8Array(await out.xlsx.writeBuffer());
	return { bytes, check: summary(reports, rowsKept, options.lang) };
}
