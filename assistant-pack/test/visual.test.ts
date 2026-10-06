// Opens every office file the pack makes in LibreOffice (headless) and runs one real .ods
// conversion. Needs LibreOffice, so it runs only with CI_VISUAL=1 (the assistant-pack CI job).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanWorkbook } from "../src/office/clean";
import { buildReport } from "../src/office/report";
import { buildSlides } from "../src/office/slides";
import { fixture } from "./zip-helpers";

const TIMEOUT_MS = 180_000;
/** CSV filter: comma, double quotes, UTF-8, from line 1, raw values rather than the formatted text. */
const CSV_FILTER = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false";

let work: string;

function soffice(target: string, file: string): string {
	execFileSync(
		"soffice",
		[
			"--headless",
			`-env:UserInstallation=${pathToFileURL(join(work, "lo-profile")).href}`,
			"--convert-to",
			target,
			"--outdir",
			work,
			file,
		],
		{ stdio: "pipe", timeout: TIMEOUT_MS },
	);
	const extension = target.split(":")[0];
	return join(work, `${basename(file, extname(file))}.${extension}`);
}

function expectPdf(file: string): void {
	const pdf = soffice("pdf", file);
	expect(existsSync(pdf)).toBe(true);
	expect(statSync(pdf).size).toBeGreaterThan(0);
	expect(readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-");
}

describe.skipIf(process.env.CI_VISUAL !== "1")("office files in LibreOffice", () => {
	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), "sai-atlas-visual-"));
	});

	afterAll(() => {
		rmSync(work, { recursive: true, force: true });
	});

	it.each(["notes-en.md", "notes-vi.md"])(
		"converts the Word report of %s to PDF",
		async name => {
			const report = await buildReport({ markdown: fixture(name), fallbackTitle: "Report" });
			const file = join(work, `${basename(name, ".md")}.docx`);
			writeFileSync(file, report.bytes);
			expectPdf(file);
		},
		TIMEOUT_MS,
	);

	it(
		"converts the slide deck to PDF",
		async () => {
			const deck = await buildSlides({ markdown: fixture("report-shapes.md"), fallbackTitle: "Slides" });
			const file = join(work, "report-shapes.pptx");
			writeFileSync(file, deck.bytes);
			expectPdf(file);
		},
		TIMEOUT_MS,
	);

	it(
		"recalculates the totals row to the cached results",
		async () => {
			const input = new ExcelJS.Workbook();
			input.addWorksheet("Data").addRows([
				["Item", "Qty", "Price"],
				["Pens", 3, "1,250.5"],
				["Paper", 12, "2,500"],
				["Ink", 7, "980"],
			]);
			const inPath = join(work, "orders.xlsx");
			await input.xlsx.writeFile(inPath);
			const cleaned = await cleanWorkbook(inPath, { lang: "en", totals: true });
			const file = join(work, "orders-cleaned.xlsx");
			writeFileSync(file, cleaned.bytes);
			expectPdf(file);

			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(file);
			const sheet = workbook.getWorksheet("Data") as ExcelJS.Worksheet;
			const totals = sheet.getRow(sheet.rowCount);
			const cached = [2, 3].map(column => (totals.getCell(column).value as { result: number }).result);

			const csv = readFileSync(soffice(CSV_FILTER, file), "utf8").trim().split("\n");
			const lastRow = (csv[csv.length - 1] ?? "").split(",").map(cell => cell.replace(/"/g, ""));
			expect(lastRow[0]).toBe("Total");
			expect([Number(lastRow[1]), Number(lastRow[2])]).toEqual(cached);
		},
		TIMEOUT_MS,
	);

	it(
		"cleans a real .ods file through LibreOffice and leaves it untouched",
		async () => {
			const source = new ExcelJS.Workbook();
			source.addWorksheet("Danh sách").addRows([
				["Tên", "Số tiền"],
				[" An ", "1.500"],
			]);
			const xlsx = join(work, "danh-sach.xlsx");
			await source.xlsx.writeFile(xlsx);
			const ods = soffice("ods", xlsx);
			const before = readFileSync(ods);
			const cleaned = await cleanWorkbook(ods, { lang: "vi" });
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.load(Buffer.from(cleaned.bytes) as unknown as ArrayBuffer);
			const sheet = workbook.getWorksheet("Danh sách") as ExcelJS.Worksheet;
			expect(sheet.getCell("A2").value).toBe("An");
			expect(sheet.getCell("B2").value).toBe(1500);
			expect(readFileSync(ods).equals(before)).toBe(true);
		},
		TIMEOUT_MS,
	);
});
