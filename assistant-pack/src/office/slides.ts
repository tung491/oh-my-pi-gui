// Markdown string -> slide deck (.pptx). The layout follows the shape of each section:
// dark title and divider slides, card grids, big-number callouts, native charts and
// tables, and bullet slides that split onto "(cont.)" slides instead of shrinking text.
import type { Token, Tokens } from "marked";
import PptxGenJS from "pptxgenjs";
import { BODY_FONT, TITLE_FONT } from "./fonts";
import { countOf, type InlineRun, inlineRuns, plainText, resolveTitle, splitLines } from "./markdown";
import { PlainError } from "./output";

export interface SlidesInput {
	markdown: string;
	/** Explicit deck title; when absent the first `#` heading, else `fallbackTitle`. */
	title?: string;
	fallbackTitle: string;
}

export interface BuiltDeck {
	bytes: Uint8Array;
	check: string;
	title: string;
}

interface Item {
	runs: InlineRun[];
	level: number;
}

interface Section {
	kind: "title" | "divider" | "content";
	title: string;
	items: Item[];
	tables: Tokens.Table[];
	notes: string[];
}

type SlideKind = "title slide" | "section divider" | "card grid" | "big number" | "chart" | "table" | "bullet slide";

interface DeckState {
	pptx: PptxGenJS;
	kinds: SlideKind[];
	splits: { title: string; slides: number }[];
}

// pptxgenjs takes colours as hex without "#" (a "#" corrupts the colour) and positions in inches;
// LAYOUT_WIDE is the 16:9 size PowerPoint uses by default (13.333 x 7.5 in).
const LAYOUT = "LAYOUT_WIDE";
const SLIDE_W = 13.333;
const DARK = "1F2A44";
const DARK_TEXT = "C9D3E6";
const TEXT = "333333";
const ACCENT = "2E75B6";
const CARD_FILL = "EEF2F8";
const HEADER_FILL = "DCE6F1";
const MUTED = "7F7F7F";
const SERIES_COLORS = ["2E75B6", "F4B183", "70AD47", "FFC000", "7F6084", "5B9BD5"];
const MARGIN_X = 0.7;
const BODY_W = SLIDE_W - 2 * MARGIN_X;
const BODY_Y = 1.5;
const BODY_H = 5.3;
/** Smallest text anywhere in the deck; nothing is ever shrunk below it. */
const MIN_FONT = 14;
const BULLET_FONT = 20;
const BULLETS_PER_SLIDE = 6;
const BULLET_CHARS_PER_SLIDE = 600;
const TABLE_ROWS_PER_SLIDE = 8;
const CARD_BODY_MAX_CHARS = 220;
const BIG_NUMBER_MAX_CHARS = 12;
const NOTES_PREFIX = /^\s*(notes|ghi chú)\s*:\s*/i;
const NO_SLIDES = "There are no slides yet. Start each slide with a line beginning with ##.";

function itemText(item: Item): string {
	return item.runs
		.map(run => run.text)
		.join("")
		.trim();
}

function linesToItems(runs: readonly InlineRun[], level: number): Item[] {
	return splitLines(runs).map(line => ({ runs: line, level }));
}

function listItems(list: Tokens.List, level: number): Item[] {
	const items: Item[] = [];
	for (const entry of list.items) {
		for (const token of entry.tokens) {
			if (token.type === "list") items.push(...listItems(token as Tokens.List, level + 1));
			else if (token.type !== "space") {
				items.push(...linesToItems(inlineRuns((token as { tokens?: Token[] }).tokens ?? [token]), level));
			}
		}
	}
	return items;
}

function parseSections(title: string, tokens: readonly Token[]): Section[] {
	const sections: Section[] = [{ kind: "title", title, items: [], tables: [], notes: [] }];
	const current = () => sections[sections.length - 1];
	for (const token of tokens) {
		switch (token.type) {
			case "heading": {
				const heading = token as Tokens.Heading;
				const text = plainText(heading.tokens);
				if (heading.depth <= 2) {
					sections.push({
						kind: heading.depth === 1 ? "divider" : "content",
						title: text,
						items: [],
						tables: [],
						notes: [],
					});
				} else if (text) {
					current().items.push({ runs: [{ text, bold: true, italics: false }], level: 0 });
				}
				break;
			}
			case "paragraph":
				current().items.push(...linesToItems(inlineRuns((token as Tokens.Paragraph).tokens), 0));
				break;
			case "list":
				current().items.push(...listItems(token as Tokens.List, 0));
				break;
			case "table":
				current().tables.push(token as Tokens.Table);
				break;
			case "blockquote": {
				const text = (token as Tokens.Blockquote).tokens
					.map(inner => plainText((inner as { tokens?: Token[] }).tokens ?? [inner]))
					.join(" ")
					.trim();
				if (NOTES_PREFIX.test(text)) current().notes.push(text.replace(NOTES_PREFIX, ""));
				else if (text) current().items.push({ runs: [{ text, bold: false, italics: true }], level: 0 });
				break;
			}
			case "code":
				current().items.push(
					...linesToItems([{ text: (token as Tokens.Code).text, bold: false, italics: false }], 0),
				);
				break;
			default:
				break;
		}
	}
	return sections;
}

function addTitle(slide: PptxGenJS.Slide, title: string): void {
	slide.addText(title, {
		x: MARGIN_X,
		y: 0.35,
		w: BODY_W,
		h: 0.95,
		fontFace: TITLE_FONT,
		fontSize: 30,
		bold: true,
		color: DARK,
		valign: "middle",
		margin: 0,
	});
}

function contentSlide(state: DeckState, title: string, kind: SlideKind): PptxGenJS.Slide {
	const slide = state.pptx.addSlide();
	slide.background = { color: "FFFFFF" };
	addTitle(slide, title);
	slide.slideNumber = { x: SLIDE_W - 1.2, y: 6.95, w: 0.8, h: 0.4, fontSize: MIN_FONT, color: MUTED, align: "right" };
	state.kinds.push(kind);
	return slide;
}

function darkSlide(state: DeckState, title: string, subtitle: string | undefined, kind: SlideKind): PptxGenJS.Slide {
	const slide = state.pptx.addSlide();
	slide.background = { color: DARK };
	const big = kind === "title slide";
	slide.addText(title, {
		x: 0.9,
		y: big ? 2.3 : 2.7,
		w: SLIDE_W - 1.8,
		h: 1.6,
		fontFace: TITLE_FONT,
		fontSize: big ? 40 : 34,
		bold: true,
		color: "FFFFFF",
		valign: "bottom",
		margin: 0,
	});
	if (subtitle) {
		slide.addText(subtitle, {
			x: 0.9,
			y: big ? 4.1 : 4.5,
			w: SLIDE_W - 1.8,
			h: 1.2,
			fontFace: BODY_FONT,
			fontSize: 20,
			color: DARK_TEXT,
			valign: "top",
			margin: 0,
		});
	}
	state.kinds.push(kind);
	return slide;
}

function bulletRuns(items: readonly Item[]): PptxGenJS.TextProps[] {
	return items.flatMap(item =>
		item.runs.map((run, index) => ({
			text: run.text,
			options: {
				bold: run.bold,
				italic: run.italics,
				bullet: item.level > 0 ? { indent: 18 } : true,
				indentLevel: Math.min(item.level, 3),
				breakLine: index === item.runs.length - 1,
			},
		})),
	);
}

/** Groups items into slides of at most BULLETS_PER_SLIDE items and BULLET_CHARS_PER_SLIDE characters. */
function bulletPages(items: readonly Item[]): Item[][] {
	const pages: Item[][] = [];
	let page: Item[] = [];
	let chars = 0;
	for (const item of items) {
		const length = itemText(item).length;
		if (page.length > 0 && (page.length >= BULLETS_PER_SLIDE || chars + length > BULLET_CHARS_PER_SLIDE)) {
			pages.push(page);
			page = [];
			chars = 0;
		}
		page.push(item);
		chars += length;
	}
	if (page.length > 0) pages.push(page);
	return pages;
}

function cont(title: string, index: number): string {
	return index === 0 ? title : `${title} (cont.)`;
}

function bulletSlides(state: DeckState, title: string, items: readonly Item[], first = 0): PptxGenJS.Slide[] {
	const pages = bulletPages(items);
	if (pages.length > 1) state.splits.push({ title, slides: pages.length + first });
	return pages.map((page, index) => {
		const slide = contentSlide(state, cont(title, index + first), "bullet slide");
		slide.addText(bulletRuns(page), {
			x: MARGIN_X,
			y: BODY_Y,
			w: BODY_W,
			h: BODY_H,
			fontFace: BODY_FONT,
			fontSize: BULLET_FONT,
			color: TEXT,
			valign: "top",
			paraSpaceAfter: 8,
		});
		return slide;
	});
}

function startsBold(item: Item): boolean {
	return item.runs.length > 0 && item.runs[0].bold && item.runs[0].text.trim() !== "";
}

function isBigNumber(item: Item | undefined): boolean {
	if (!item || !startsBold(item)) return false;
	const lead = item.runs[0].text.trim();
	return /\d/.test(lead) && lead.length <= BIG_NUMBER_MAX_CHARS;
}

function isCardGrid(items: readonly Item[]): boolean {
	return (
		items.length >= 2 &&
		items.length <= 4 &&
		items.every(item => item.level === 0 && startsBold(item)) &&
		items.every(item => itemText(item).length - item.runs[0].text.length <= CARD_BODY_MAX_CHARS)
	);
}

function restText(item: Item): string {
	return item.runs
		.slice(1)
		.map(run => run.text)
		.join("")
		.replace(/^\s*[:–—-]?\s*/, "")
		.trim();
}

function cardSlide(state: DeckState, title: string, items: readonly Item[]): PptxGenJS.Slide {
	const slide = contentSlide(state, title, "card grid");
	const gap = 0.3;
	const width = (BODY_W - gap * (items.length - 1)) / items.length;
	items.forEach((item, index) => {
		const body = restText(item);
		slide.addText(
			[
				{ text: item.runs[0].text.trim(), options: { bold: true, fontSize: 22, color: DARK, breakLine: !!body } },
				...(body ? [{ text: body, options: { fontSize: 16, color: TEXT } }] : []),
			],
			{
				x: MARGIN_X + index * (width + gap),
				y: 1.8,
				w: width,
				h: 4.2,
				fontFace: BODY_FONT,
				fill: { color: CARD_FILL },
				valign: "top",
				margin: 12,
				paraSpaceAfter: 10,
			},
		);
	});
	return slide;
}

function bigNumberSlide(state: DeckState, title: string, item: Item): PptxGenJS.Slide {
	const slide = contentSlide(state, title, "big number");
	slide.addText(item.runs[0].text.trim(), {
		x: MARGIN_X,
		y: 1.8,
		w: BODY_W,
		h: 2.3,
		fontFace: TITLE_FONT,
		fontSize: 96,
		bold: true,
		color: ACCENT,
		align: "center",
		valign: "middle",
	});
	const caption = restText(item);
	if (caption) {
		slide.addText(caption, {
			x: MARGIN_X,
			y: 4.3,
			w: BODY_W,
			h: 1.4,
			fontFace: BODY_FONT,
			fontSize: 24,
			color: TEXT,
			align: "center",
			valign: "top",
		});
	}
	return slide;
}

/** Reads a table cell as a number: "1,200" and "1.200" are thousands, "1,5" and "1.5" are decimals. */
function cellNumber(text: string): number | undefined {
	const cleaned = text.replace(/[\s%]/g, "");
	if (!/^-?[\d.,]+$/.test(cleaned) || !/\d/.test(cleaned)) return undefined;
	const grouped = /^-?\d{1,3}([.,])\d{3}(\1\d{3})*$/.test(cleaned);
	const number = Number(grouped ? cleaned.replace(/[.,]/g, "") : cleaned.replace(",", "."));
	return Number.isFinite(number) ? number : undefined;
}

function tableCells(table: Tokens.Table): { header: string[]; rows: string[][] } {
	return {
		header: table.header.map(cell => plainText(cell.tokens)),
		rows: table.rows.map(row => table.header.map((_, c) => plainText(row[c]?.tokens))),
	};
}

function isChartTable(header: readonly string[], rows: readonly string[][]): boolean {
	return (
		header.length >= 2 &&
		rows.length >= 1 &&
		rows.every(row => row.slice(1).every(cell => cellNumber(cell) !== undefined))
	);
}

function chartSlide(state: DeckState, title: string, header: string[], rows: string[][]): PptxGenJS.Slide {
	const slide = contentSlide(state, title, "chart");
	const labels = rows.map(row => row[0]);
	const series = header.slice(1).map((name, index) => ({
		name: name || `${index + 1}`,
		labels,
		values: rows.map(row => cellNumber(row[index + 1]) ?? 0),
	}));
	slide.addChart(state.pptx.ChartType.bar, series, {
		x: MARGIN_X,
		y: BODY_Y,
		w: BODY_W,
		h: BODY_H,
		barDir: "col",
		barGrouping: "clustered",
		chartColors: SERIES_COLORS.slice(0, Math.max(series.length, 1)),
		showValue: true,
		dataLabelFontSize: MIN_FONT,
		dataLabelFontFace: BODY_FONT,
		dataLabelColor: TEXT,
		catAxisLabelFontSize: MIN_FONT,
		catAxisLabelFontFace: BODY_FONT,
		valAxisLabelFontSize: MIN_FONT,
		valAxisLabelFontFace: BODY_FONT,
		showLegend: series.length > 1,
		legendPos: "b",
		legendFontSize: MIN_FONT,
		legendFontFace: BODY_FONT,
		showTitle: false,
	});
	return slide;
}

function tableSlides(state: DeckState, title: string, header: string[], rows: string[][]): PptxGenJS.Slide[] {
	const pages: string[][][] = [];
	for (let i = 0; i < rows.length; i += TABLE_ROWS_PER_SLIDE) pages.push(rows.slice(i, i + TABLE_ROWS_PER_SLIDE));
	if (pages.length === 0) pages.push([]);
	if (pages.length > 1) state.splits.push({ title, slides: pages.length });
	const columnWidth = BODY_W / Math.max(header.length, 1);
	return pages.map((page, index) => {
		const slide = contentSlide(state, cont(title, index), "table");
		const headerRow = header.map(text => ({
			text,
			options: { bold: true, color: DARK, fill: { color: HEADER_FILL } },
		}));
		const bodyRows = page.map(row => row.map(text => ({ text, options: { color: TEXT } })));
		slide.addTable([headerRow, ...bodyRows], {
			x: MARGIN_X,
			y: BODY_Y,
			w: BODY_W,
			colW: header.map(() => columnWidth),
			fontFace: BODY_FONT,
			fontSize: 16,
			border: { type: "solid", pt: 1, color: "BFBFBF" },
			valign: "middle",
		});
		return slide;
	});
}

function tableOrChartSlides(state: DeckState, title: string, table: Tokens.Table): PptxGenJS.Slide[] {
	const { header, rows } = tableCells(table);
	return isChartTable(header, rows)
		? [chartSlide(state, title, header, rows)]
		: tableSlides(state, title, header, rows);
}

function renderSection(state: DeckState, section: Section): void {
	const slides: PptxGenJS.Slide[] = [];
	if (section.kind !== "content") {
		const [subtitle, ...rest] = section.items;
		const kind = section.kind === "title" ? "title slide" : "section divider";
		slides.push(darkSlide(state, section.title, subtitle ? itemText(subtitle) : undefined, kind));
		if (rest.length > 0) slides.push(...bulletSlides(state, section.title, rest, 1));
		for (const table of section.tables) slides.push(...tableOrChartSlides(state, section.title, table));
	} else if (section.tables.length > 0) {
		if (section.items.length > 0) slides.push(...bulletSlides(state, section.title, section.items));
		for (const table of section.tables) slides.push(...tableOrChartSlides(state, section.title, table));
	} else if (isBigNumber(section.items[0])) {
		slides.push(bigNumberSlide(state, section.title, section.items[0]));
		if (section.items.length > 1) slides.push(...bulletSlides(state, section.title, section.items.slice(1), 1));
	} else if (isCardGrid(section.items)) {
		slides.push(cardSlide(state, section.title, section.items));
	} else if (section.items.length > 0) {
		slides.push(...bulletSlides(state, section.title, section.items));
	} else {
		slides.push(contentSlide(state, section.title, "bullet slide"));
	}
	if (section.notes.length > 0) slides[0]?.addNotes(section.notes.join("\n"));
}

function describe(state: DeckState): string {
	const order: SlideKind[] = [
		"title slide",
		"section divider",
		"card grid",
		"big number",
		"chart",
		"table",
		"bullet slide",
	];
	const counts = order
		.map(kind => ({ kind, count: state.kinds.filter(k => k === kind).length }))
		.filter(entry => entry.count > 0)
		.map(entry => countOf(entry.count, entry.kind));
	const parts = [`${countOf(state.kinds.length, "slide")} (${counts.join(", ")})`];
	for (const split of state.splits) parts.push(`split onto ${split.slides} slides: ${split.title}`);
	return parts.join("; ");
}

export async function buildSlides(input: SlidesInput): Promise<BuiltDeck> {
	const { title, tokens } = resolveTitle(input.markdown, input.title, input.fallbackTitle);
	const sections = parseSections(title, tokens);
	// A deck needs at least one # or ## section after the title slide.
	if (sections.length === 1) throw new PlainError(NO_SLIDES);

	// One pptxgenjs instance per file; the layout is set before any slide is added.
	const pptx = new PptxGenJS();
	pptx.layout = LAYOUT;
	pptx.title = title;
	pptx.author = "Sai ATLAS";
	const state: DeckState = { pptx, kinds: [], splits: [] };
	for (const section of sections) renderSection(state, section);

	const output = await pptx.write({ outputType: "nodebuffer" });
	if (!(output instanceof Uint8Array)) throw new PlainError("I could not create the slides.");
	return { bytes: new Uint8Array(output), check: describe(state), title };
}
