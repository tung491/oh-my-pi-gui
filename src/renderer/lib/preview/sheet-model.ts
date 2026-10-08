/**
 * Table model for the sheet preview: xlsx, xls (BIFF, or the HTML tables some
 * apps save as .xls), ods and csv all become capped rows of display strings.
 *
 * SheetJS parses on the main thread, so it is told to stop one row past the
 * cap (`sheetRows`); it then shortens `!ref` and keeps the real range in
 * `!fullref`, which is what the "showing the first N rows" note reports.
 * Formula cells without a saved value (exceljs and many generators write
 * `<f>` with no `<v>`) are dropped by a default read, so the read keeps
 * formulas and stubs and shows such a cell as its `=formula`.
 *
 * This module is imported only by the lazily loaded `SheetPreview`, so
 * SheetJS stays in its own on-demand chunk.
 */

import { type CellObject, type ParsingOptions, read, utils, type WorkSheet } from "xlsx";

export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_COLS = 50;

export interface SheetView {
	name: string;
	/** Display text, at most `SHEET_MAX_ROWS` × `SHEET_MAX_COLS`, trailing empty cells trimmed per row. */
	rows: string[][];
	/** `"row:col"` indexes into `rows` of formula cells that have no saved value. */
	formulaCells: ReadonlySet<string>;
	/** The sheet's full size, before the caps. */
	totalRows: number;
	totalCols: number;
}

export const SHEET_READ_OPTIONS = {
	dense: true,
	cellDates: true,
	cellNF: true,
	cellFormula: true,
	// SheetJS defaults this on and builds an escaped `.h` per cell the table never reads.
	cellHTML: false,
	sheetStubs: true,
	sheetRows: SHEET_MAX_ROWS + 1,
} as const satisfies ParsingOptions;

/** The sheet's full range: `!fullref` when `sheetRows` cut the sheet short, else `!ref`. */
function fullRange(sheet: WorkSheet): string | undefined {
	const fullref: unknown = sheet["!fullref"];
	return typeof fullref === "string" ? fullref : sheet["!ref"];
}

function cellAt(sheet: WorkSheet, row: number, col: number): CellObject | undefined {
	const data: CellObject[][] | undefined = sheet["!data"];
	return data?.[row]?.[col];
}

function sheetView(name: string, sheet: WorkSheet): SheetView {
	const ref = fullRange(sheet);
	if (!ref) return { name, rows: [], formulaCells: new Set(), totalRows: 0, totalCols: 0 };

	const { s, e } = utils.decode_range(ref);
	const totalRows = e.r - s.r + 1;
	const totalCols = e.c - s.c + 1;
	const shownRows = Math.min(totalRows, SHEET_MAX_ROWS);
	const shownCols = Math.min(totalCols, SHEET_MAX_COLS);
	const formulaCells = new Set<string>();
	const rows: string[][] = [];

	for (let r = 0; r < shownRows; r++) {
		const row: string[] = [];
		for (let c = 0; c < shownCols; c++) {
			const cell = cellAt(sheet, s.r + r, s.c + c);
			if (cell?.f !== undefined && (cell.t === "z" || cell.v === undefined)) {
				row.push(`=${cell.f}`);
				formulaCells.add(`${r}:${c}`);
			} else {
				row.push(cell?.w ?? (cell?.v === undefined ? "" : String(cell.v)));
			}
		}
		let length = row.length;
		while (length > 0 && row[length - 1] === "") length--;
		row.length = length;
		rows.push(row);
	}
	return { name, rows, formulaCells, totalRows, totalCols };
}

/**
 * Parse a workbook (bytes) or CSV text (from `fs:read`) into one view per
 * visible sheet. Throws what SheetJS throws for a corrupt file; the caller
 * reports it.
 */
export function workbookToSheets(input: Uint8Array | string): SheetView[] {
	const book =
		typeof input === "string"
			? read(input, { ...SHEET_READ_OPTIONS, type: "string" })
			: read(input, { ...SHEET_READ_OPTIONS, type: "array" });
	const visibility = book.Workbook?.Sheets;
	return book.SheetNames.flatMap((name, index) =>
		visibility?.[index]?.Hidden ? [] : [sheetView(name, book.Sheets[name])],
	);
}
