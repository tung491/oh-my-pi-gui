/**
 * Write the document-preview fixtures the unit and e2e tests read:
 *
 *   bun scripts/gen-preview-fixtures.ts
 *
 * Every office file comes from the repo's own writers (the assistant pack's
 * report and slides builders, exceljs), so the fixtures look like what the
 * preview meets in practice. The PDFs are hand-assembled: a one-page file, a
 * CJK file whose font is not embedded (rendering it makes pdf.js fetch the
 * packed `UniJIS-UCS2-H` CMap from the self-hosted `pdfjs/cmaps/`) and a
 * 60-page file for the page cap. `injected-font.docx` carries a font name
 * that tries to escape docx-preview's generated CSS through `:host`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildReport } from "../assistant-pack/src/office/report";
import { buildSlides } from "../assistant-pack/src/office/slides";

const OUT = path.resolve(import.meta.dirname, "../e2e/fixtures/document-preview");
const NOTES = path.resolve(import.meta.dirname, "../assistant-pack/test/fixtures/notes-en.md");
/** Fixed workbook timestamps, so a re-run only changes what the writers themselves vary. */
const FIXED_DATE = new Date("2026-01-01T00:00:00Z");
const INJECT =
	"x;}:host{position:fixed!important;inset:0!important;z-index:2147483647!important;background:red!important}.y{a:b";
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Assemble a PDF from object bodies; object `n` is `objects[n - 1]` and object
 * 1 must be the catalog. The xref offsets are byte offsets, so every length is
 * measured with `Buffer.byteLength`.
 */
function buildPdf(objects: string[]): Buffer {
	let body = "%PDF-1.7\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xrefOffset = Buffer.byteLength(body, "latin1");
	const entries = offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

function stream(content: string): string {
	return `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
}

const PAGE_TEXT = stream("BT /F1 24 Tf 40 100 Td (Preview fixture) Tj ET");
const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

function onePagePdf(): Buffer {
	return buildPdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		PAGE_TEXT,
		HELVETICA,
	]);
}

function cjkPdf(): Buffer {
	return buildPdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		stream("BT /F1 24 Tf 40 100 Td <3042> Tj ET"),
		"<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>",
		"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R /DW 1000 >>",
		"<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 /FontBBox [-437 -340 1147 1317] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 742 /StemV 80 >>",
	]);
}

function sixtyPagesPdf(): Buffer {
	const PAGE_COUNT = 60;
	const FIRST_PAGE = 5;
	const pages = Array.from(
		{ length: PAGE_COUNT },
		() =>
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>",
	);
	const kids = pages.map((_, index) => `${FIRST_PAGE + index} 0 R`).join(" ");
	return buildPdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${kids}] /Count ${PAGE_COUNT} >>`,
		PAGE_TEXT,
		HELVETICA,
		...pages,
	]);
}

async function tableXlsx(): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "Sai ATLAS";
	workbook.created = FIXED_DATE;
	workbook.modified = FIXED_DATE;
	const sales = workbook.addWorksheet("Sales");
	sales.addRow(["Region", "Revenue"]);
	sales.addRow(["North", 120]);
	sales.addRow(["South", 95]);
	sales.addRow(["East", 143]);
	// No `result`: exceljs then writes `<f>` without a cached `<v>`, the case
	// SheetJS drops unless the preview asks for formulas and stubs.
	sales.getCell("B5").value = { formula: "SUM(B2:B4)" };
	workbook.addWorksheet("Notes").getCell("A1").value = "Prepared by Sai ATLAS";
	const hidden = workbook.addWorksheet("Hidden");
	hidden.state = "hidden";
	hidden.getCell("A1").value = "secret";
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Put `INJECT` into the first `w:ascii` font name of `styles.xml`, or add one after the first `<w:rPr>`. */
async function injectedFontDocx(report: Uint8Array): Promise<Buffer> {
	const zip = await JSZip.loadAsync(report);
	const entry = zip.file("word/styles.xml");
	if (!entry) throw new Error("report.docx has no word/styles.xml");
	const styles = await entry.async("string");
	const withAscii = styles.replace(/(<w:rFonts\b[^>]*\bw:ascii=")[^"]*(")/, `$1${INJECT}$2`);
	const injected =
		withAscii !== styles
			? withAscii
			: styles.replace(/<w:rPr>/, `<w:rPr><w:rFonts w:ascii="${INJECT}" w:hAnsi="${INJECT}"/>`);
	if (!injected.includes(INJECT)) throw new Error("styles.xml has no <w:rFonts> or <w:rPr> to inject into");
	zip.file("word/styles.xml", injected);
	const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
	const written = await (await JSZip.loadAsync(bytes)).file("word/styles.xml")?.async("string");
	if (!written?.includes(INJECT)) throw new Error("the written styles.xml does not contain the injected font name");
	return bytes;
}

async function main(): Promise<void> {
	mkdirSync(OUT, { recursive: true });
	const markdown = readFileSync(NOTES, "utf8");
	const report = (await buildReport({ markdown, fallbackTitle: "Report", lang: "en" })).bytes;
	const deck = (await buildSlides({ markdown, fallbackTitle: "Report", lang: "en" })).bytes;

	const files: Record<string, Uint8Array | string> = {
		"report.docx": report,
		"deck.pptx": deck,
		"table.xlsx": await tableXlsx(),
		"table.csv": "Region,Revenue\nNorth,120\nSouth,95\n",
		"one-page.pdf": onePagePdf(),
		"cjk.pdf": cjkPdf(),
		"sixty-pages.pdf": sixtyPagesPdf(),
		"pixel.png": Buffer.from(PIXEL_PNG, "base64"),
		"not-a-docx.docx": "just text, not a document\n",
		"injected-font.docx": await injectedFontDocx(report),
		"notes.md": "# Fixture notes\n\nPlain markdown.\n",
	};
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(OUT, name), content);
		console.log(`wrote ${path.relative(process.cwd(), path.join(OUT, name))}`);
	}
}

await main();
