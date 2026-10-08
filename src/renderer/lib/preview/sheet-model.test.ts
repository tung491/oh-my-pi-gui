import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { type BookType, read, utils, write } from "xlsx";
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, SHEET_READ_OPTIONS, workbookToSheets } from "./sheet-model";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../e2e/fixtures/document-preview");
const tableXlsx = (): Uint8Array => new Uint8Array(readFileSync(path.join(FIXTURES, "table.xlsx")));

function workbookBytes(rows: unknown[][], bookType: BookType): Uint8Array {
	const book = utils.book_new();
	utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Data");
	if (bookType === "html") return new TextEncoder().encode(write(book, { bookType, type: "string" }) as string);
	return new Uint8Array(write(book, { bookType, type: "array" }) as ArrayBuffer);
}

describe("workbookToSheets", () => {
	it("reads table.xlsx without its hidden sheet and keeps a formula that has no saved value", () => {
		const sheets = workbookToSheets(tableXlsx());

		expect(sheets.map(sheet => sheet.name)).toEqual(["Sales", "Notes"]);
		const [sales] = sheets;
		expect(sales.rows[0]).toEqual(["Region", "Revenue"]);
		expect(sales.rows[1]).toEqual(["North", "120"]);
		expect(sales.rows[4][1]).toBe("=SUM(B2:B4)");
		expect(sales.formulaCells.has("4:1")).toBe(true);
		expect(sales.formulaCells.size).toBe(1);
		expect(sales.totalRows).toBe(5);
		expect(sales.totalCols).toBe(2);
		expect(sheets[1].rows).toEqual([["Prepared by Sai ATLAS"]]);
	});

	it("guard: SheetJS's default read of table.xlsx has no row 5, which is why the read options are needed", () => {
		const book = read(tableXlsx(), { type: "array" });
		const sales = book.Sheets.Sales;

		// The declared dimension still reaches row 5; only its formula cell is dropped.
		expect(sales.A5).toBeUndefined();
		expect(sales.B5).toBeUndefined();
		expect(sales.B4).toMatchObject({ v: 143 });
	});

	it("reads CSV text as rows of strings", () => {
		const [sheet] = workbookToSheets("Region,Revenue\nNorth,120\n");

		expect(sheet.rows).toEqual([
			["Region", "Revenue"],
			["North", "120"],
		]);
		expect(sheet.formulaCells.size).toBe(0);
	});

	it("caps a 600 x 60 sheet at 500 rows and 50 columns while reporting its full size", () => {
		const rows = Array.from({ length: 600 }, (_, r) => Array.from({ length: 60 }, (_, c) => `${r}:${c}`));
		const [sheet] = workbookToSheets(workbookBytes(rows, "xlsx"));

		expect(sheet.rows).toHaveLength(SHEET_MAX_ROWS);
		expect(sheet.rows.every(row => row.length === SHEET_MAX_COLS)).toBe(true);
		expect(sheet.rows[499][49]).toBe("499:49");
		expect(sheet.totalRows).toBe(600);
		expect(sheet.totalCols).toBe(60);
	});

	it("asks SheetJS to stop one row past the cap and to keep formulas and stubs", () => {
		expect(SHEET_READ_OPTIONS).toMatchObject({
			dense: true,
			cellFormula: true,
			cellHTML: false,
			sheetStubs: true,
			sheetRows: SHEET_MAX_ROWS + 1,
		});
	});

	it.each([["biff8" as const], ["html" as const], ["ods" as const]])(
		"reads the same first row from a %s workbook",
		bookType => {
			const [sheet] = workbookToSheets(
				workbookBytes(
					[
						["Region", "Revenue"],
						["North", 120],
					],
					bookType,
				),
			);

			expect(sheet.rows[0]).toEqual(["Region", "Revenue"]);
			expect(sheet.rows[1]).toEqual(["North", "120"]);
		},
	);

	it("returns an empty view for a sheet with no cells", () => {
		const book = utils.book_new();
		utils.book_append_sheet(book, utils.aoa_to_sheet([]), "Empty");
		const [sheet] = workbookToSheets(new Uint8Array(write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer));

		expect(sheet).toMatchObject({ name: "Empty", rows: [], totalRows: 0, totalCols: 0 });
	});
});
