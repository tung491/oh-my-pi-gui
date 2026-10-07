import { describe, expect, it } from "vitest";
import { buildReport } from "../src/office/report";
import { countMatches, fixture, zipEntry } from "./zip-helpers";

/** A4 width minus two 1-inch margins, in twentieths of a point (DXA). */
const A4_CONTENT_WIDTH_DXA = 11906 - 2 * 1440;

interface Expected {
	title: string;
	/** Body headings by level after the title heading left the body. */
	headings: { 1: number; 2: number; 3: number };
	tables: number;
	listItems: number;
}

const FIXTURES: Record<string, Expected> = {
	"notes-en.md": {
		title: "Quarterly sales review",
		headings: { 1: 0, 2: 3, 3: 1 },
		tables: 1,
		listItems: 9,
	},
	"notes-vi.md": {
		title: "Biên bản họp phòng kinh doanh",
		headings: { 1: 0, 2: 3, 3: 0 },
		tables: 1,
		listItems: 6,
	},
};

async function build(name: string, title?: string, lang = "en") {
	const report = await buildReport({ markdown: fixture(name), title, fallbackTitle: "Report", lang });
	const document = await zipEntry(report.bytes, "word/document.xml");
	const styles = await zipEntry(report.bytes, "word/styles.xml");
	return { report, document, styles };
}

function texts(document: string): string[] {
	return [...document.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]);
}

describe.each(Object.entries(FIXTURES))("buildReport(%s)", (name, expected) => {
	it("maps every #, ## and ### heading to a built-in Word heading", async () => {
		const { document } = await build(name);
		for (const level of [1, 2, 3] as const) {
			expect(countMatches(document, new RegExp(`<w:pStyle w:val="Heading${level}"/>`, "g"))).toBe(
				expected.headings[level],
			);
		}
		expect(countMatches(document, /<w:pStyle w:val="Title"\/>/g)).toBe(1);
	});

	it("renders tables as real Word tables that fill the A4 content width", async () => {
		const { document } = await build(name);
		expect(countMatches(document, /<w:tbl>/g)).toBe(expected.tables);
		expect(texts(document).some(text => text.includes("|"))).toBe(false);
		for (const grid of document.matchAll(/<w:tblGrid>(.*?)<\/w:tblGrid>/g)) {
			const widths = [...grid[1].matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(match => Number(match[1]));
			expect(widths.reduce((sum, width) => sum + width, 0)).toBe(A4_CONTENT_WIDTH_DXA);
		}
	});

	it("gives list items real numbering and no typed bullet characters", async () => {
		const { document } = await build(name);
		expect(countMatches(document, /<w:numPr>/g)).toBe(expected.listItems);
		for (const text of texts(document)) {
			expect(text.startsWith("•")).toBe(false);
			expect(text.startsWith("- ")).toBe(false);
		}
	});

	it("uses an A4 page", async () => {
		const { document } = await build(name);
		expect(document).toMatch(/<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/);
	});

	it("turns --- into a paragraph bottom border", async () => {
		const { document } = await build(name);
		expect(document).toMatch(/<w:pBdr><w:bottom [^>]*\/><\/w:pBdr>/);
	});

	it("names Arial and Times New Roman in the styles", async () => {
		const { styles } = await build(name);
		expect(styles).toContain('w:ascii="Arial"');
		expect(styles).toContain('w:ascii="Times New Roman"');
	});

	it("reports what it built", async () => {
		const { report } = await build(name);
		const headingCount = expected.headings[1] + expected.headings[2] + expected.headings[3];
		expect(report.check).toBe(
			`${headingCount} headings, ${expected.tables} table${expected.tables === 1 ? "" : "s"}, ${expected.listItems} list items`,
		);
		expect(report.title).toBe(expected.title);
	});
});

describe("buildReport details", () => {
	it("writes its check in Vietnamese without plural endings when the language is vi", async () => {
		const { report } = await build("notes-vi.md", undefined, "vi");
		expect(report.check).toBe("3 đề mục, 1 bảng, 6 mục danh sách");
	});

	it("writes its check in English for an unknown language", async () => {
		const { report } = await build("notes-vi.md", undefined, "fr");
		expect(report.check).toBe("3 headings, 1 table, 6 list items");
	});

	it("keeps Vietnamese text intact", async () => {
		const { document } = await build("notes-vi.md");
		expect(document).toContain("Đà Nẵng");
		expect(document).toContain("Biên bản họp phòng kinh doanh");
	});

	it("splits a paragraph's soft line breaks into separate paragraphs", async () => {
		const { document } = await build("notes-en.md");
		const paragraphs = [...document.matchAll(/<w:p>(.*?)<\/w:p>/g)].map(match => texts(match[1]).join(""));
		expect(paragraphs).toContain("The sales team met on Monday to review the third quarter.");
		expect(paragraphs).toContain("Revenue grew in every region except the north.");
	});

	it("keeps the body's # heading when a title is given", async () => {
		const { document, report } = await build("notes-en.md", "Board summary");
		expect(report.title).toBe("Board summary");
		expect(countMatches(document, /<w:pStyle w:val="Heading1"\/>/g)).toBe(1);
	});

	it("shades the header row of a table", async () => {
		const { document } = await build("notes-en.md");
		expect(document).toMatch(/<w:tblHeader\/>/);
		expect(document).toMatch(/<w:shd [^>]*w:val="clear"/);
	});
});
