// Markdown string -> Word document (.docx): A4, built-in heading styles, real numbering,
// real tables sized in DXA, and `---` as a paragraph border.
import {
	AlignmentType,
	BorderStyle,
	Document,
	HeadingLevel,
	LevelFormat,
	Packer,
	Paragraph,
	ShadingType,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
import type { Token, Tokens } from "marked";
import { BODY_FONT, TITLE_FONT } from "./fonts";
import { countOf, type InlineRun, inlineRuns, resolveTitle, splitLines } from "./markdown";

export interface ReportInput {
	markdown: string;
	/** Explicit title; when absent the first `#` heading, else `fallbackTitle`. */
	title?: string;
	fallbackTitle: string;
}

export interface BuiltDocument {
	bytes: Uint8Array;
	check: string;
	title: string;
}

/** A4 in twentieths of a point (DXA), with 1-inch margins. */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const HEADER_FILL = "DCE6F1";
const RULE_COLOR = "A6A6A6";
const BULLETS = "sai-bullets";
const NUMBERS = "sai-numbers";
const LIST_LEVELS = 3;
/** Characters a model sometimes types at the start of an item that is already a list item. */
const TYPED_ITEM_MARK = /^[•●◦▪·–-]\s+/;

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const;

type Block = Paragraph | Table;

interface Counts {
	headings: number;
	tables: number;
	listItems: number;
	/** Each ordered list restarts at 1 through its own numbering instance. */
	orderedLists: number;
}

function toRuns(runs: readonly InlineRun[]): TextRun[] {
	return runs.map(run => new TextRun({ text: run.text, bold: run.bold, italics: run.italics }));
}

function stripTypedMark(runs: InlineRun[]): InlineRun[] {
	if (runs.length === 0) return runs;
	const [first, ...rest] = runs;
	return [{ ...first, text: first.text.replace(TYPED_ITEM_MARK, "") }, ...rest];
}

function textParagraphs(runs: readonly InlineRun[], indentLevel: number): Paragraph[] {
	return splitLines(runs).map(
		line =>
			new Paragraph({
				children: toRuns(line),
				...(indentLevel > 0 ? { indent: { left: 720 * indentLevel } } : {}),
			}),
	);
}

function columnWidths(columns: number): number[] {
	const base = Math.floor(CONTENT_WIDTH / columns);
	const widths = Array.from({ length: columns }, () => base);
	widths[columns - 1] += CONTENT_WIDTH - base * columns;
	return widths;
}

function tableBlock(table: Tokens.Table): Table {
	const widths = columnWidths(Math.max(table.header.length, 1));
	const row = (cells: readonly Tokens.TableCell[], header: boolean) =>
		new TableRow({
			tableHeader: header,
			children: widths.map(
				(width, index) =>
					new TableCell({
						width: { size: width, type: WidthType.DXA },
						...(header ? { shading: { type: ShadingType.CLEAR, fill: HEADER_FILL, color: "auto" } } : {}),
						children: [
							new Paragraph({ children: toRuns(inlineRuns(cells[index]?.tokens, header).map(flattenBreak)) }),
						],
					}),
			),
		});
	return new Table({
		width: { size: CONTENT_WIDTH, type: WidthType.DXA },
		columnWidths: widths,
		rows: [row(table.header, true), ...table.rows.map(cells => row(cells, false))],
	});
}

function flattenBreak(run: InlineRun): InlineRun {
	return { ...run, text: run.text.replace(/\n/g, " ") };
}

function listBlocks(list: Tokens.List, level: number, counts: Counts): Paragraph[] {
	const blocks: Paragraph[] = [];
	const clamped = Math.min(level, LIST_LEVELS - 1);
	const numbering = list.ordered
		? { reference: NUMBERS, level: clamped, instance: ++counts.orderedLists }
		: { reference: BULLETS, level: clamped };
	for (const item of list.items) {
		counts.listItems++;
		let numbered = false;
		for (const token of item.tokens) {
			if (token.type === "list") {
				blocks.push(...listBlocks(token as Tokens.List, level + 1, counts));
				continue;
			}
			if (token.type === "space") continue;
			const runs = inlineRuns((token as { tokens?: Token[] }).tokens ?? [token]);
			const lines = splitLines(numbered ? runs : stripTypedMark(runs));
			for (const line of lines) {
				if (!numbered) {
					blocks.push(new Paragraph({ numbering, children: toRuns(line) }));
					numbered = true;
				} else {
					blocks.push(new Paragraph({ indent: { left: 720 * (clamped + 1) }, children: toRuns(line) }));
				}
			}
		}
		if (!numbered) blocks.push(new Paragraph({ numbering, children: [] }));
	}
	return blocks;
}

function bodyBlocks(tokens: readonly Token[], counts: Counts, indentLevel = 0): Block[] {
	const blocks: Block[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "heading": {
				const heading = token as Tokens.Heading;
				const level = HEADINGS[Math.min(heading.depth, HEADINGS.length) - 1];
				const text = inlineRuns(heading.tokens).map(flattenBreak);
				blocks.push(new Paragraph({ heading: level, children: toRuns(text) }));
				counts.headings++;
				break;
			}
			case "paragraph":
				blocks.push(...textParagraphs(inlineRuns((token as Tokens.Paragraph).tokens), indentLevel));
				break;
			case "list":
				blocks.push(...listBlocks(token as Tokens.List, 0, counts));
				break;
			case "table":
				blocks.push(tableBlock(token as Tokens.Table));
				counts.tables++;
				break;
			case "hr":
				blocks.push(
					new Paragraph({
						border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_COLOR, space: 1 } },
						children: [],
					}),
				);
				break;
			case "blockquote":
				blocks.push(...bodyBlocks((token as Tokens.Blockquote).tokens, counts, indentLevel + 1));
				break;
			case "code":
				blocks.push(
					...textParagraphs([{ text: (token as Tokens.Code).text, bold: false, italics: false }], indentLevel),
				);
				break;
			case "html":
				blocks.push(
					...textParagraphs(
						[{ text: (token as Tokens.HTML).text.replace(/<[^>]*>/g, ""), bold: false, italics: false }],
						indentLevel,
					),
				);
				break;
			case "space":
			case "def":
				break;
			default: {
				const nested = (token as { tokens?: Token[] }).tokens;
				const runs = nested ? inlineRuns(nested) : [{ text: token.raw, bold: false, italics: false }];
				blocks.push(...textParagraphs(runs, indentLevel));
			}
		}
	}
	return blocks;
}

function numberingLevels(format: "bullet" | "decimal") {
	const bullets = ["•", "◦", "▪"];
	return Array.from({ length: LIST_LEVELS }, (_, level) => ({
		level,
		format: format === "bullet" ? LevelFormat.BULLET : LevelFormat.DECIMAL,
		text: format === "bullet" ? bullets[level] : `%${level + 1}.`,
		alignment: AlignmentType.LEFT,
		style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
	}));
}

export async function buildReport(input: ReportInput): Promise<BuiltDocument> {
	const { title, tokens } = resolveTitle(input.markdown, input.title, input.fallbackTitle);
	const counts: Counts = { headings: 0, tables: 0, listItems: 0, orderedLists: 0 };
	const children: Block[] = [
		new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
		...bodyBlocks(tokens, counts),
	];
	const doc = new Document({
		title,
		creator: "Sai ATLAS",
		styles: {
			default: {
				document: { run: { font: BODY_FONT, size: 22 }, paragraph: { spacing: { after: 120 } } },
				title: { run: { font: TITLE_FONT, size: 44, bold: true }, paragraph: { spacing: { after: 240 } } },
				heading1: {
					run: { font: TITLE_FONT, size: 32, bold: true },
					paragraph: { spacing: { before: 360, after: 120 } },
				},
				heading2: {
					run: { font: TITLE_FONT, size: 28, bold: true },
					paragraph: { spacing: { before: 240, after: 120 } },
				},
				heading3: {
					run: { font: TITLE_FONT, size: 24, bold: true },
					paragraph: { spacing: { before: 200, after: 80 } },
				},
			},
		},
		numbering: {
			config: [
				{ reference: BULLETS, levels: numberingLevels("bullet") },
				{ reference: NUMBERS, levels: numberingLevels("decimal") },
			],
		},
		sections: [
			{
				properties: {
					page: {
						size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
						margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
					},
				},
				children,
			},
		],
	});
	const bytes = new Uint8Array(await Packer.toBuffer(doc));
	const check = [
		countOf(counts.headings, "heading"),
		countOf(counts.tables, "table"),
		countOf(counts.listItems, "list item"),
	].join(", ");
	return { bytes, check, title };
}
