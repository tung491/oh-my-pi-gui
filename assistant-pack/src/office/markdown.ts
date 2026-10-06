// Markdown reading shared by the Word and slide builders: the marked lexer, inline text runs,
// and the title rule (explicit title, else the first # heading, else a fallback).
import { lexer, type Token, type Tokens } from "marked";

export interface InlineRun {
	text: string;
	bold: boolean;
	italics: boolean;
}

export interface TitledMarkdown {
	title: string;
	/** Body tokens; the first `#` heading is removed when it became the title. */
	tokens: Token[];
}

/** Bullet characters people type by hand instead of a Markdown `-`. */
const TYPED_BULLET = /^([ \t]*)[•●◦▪·][ \t]+/gm;

/** Lexes Markdown after turning typed bullet characters into Markdown list items. */
export function lexMarkdown(markdown: string): Token[] {
	return lexer(markdown.replace(/\r\n?/g, "\n").replace(TYPED_BULLET, "$1- "));
}

/** Flattens inline tokens into runs; a line break inside the text stays a "\n" in the run. */
export function inlineRuns(tokens: readonly Token[] | undefined, bold = false, italics = false): InlineRun[] {
	const runs: InlineRun[] = [];
	for (const token of tokens ?? []) {
		switch (token.type) {
			case "strong":
				runs.push(...inlineRuns((token as Tokens.Strong).tokens, true, italics));
				break;
			case "em":
				runs.push(...inlineRuns((token as Tokens.Em).tokens, bold, true));
				break;
			case "br":
				runs.push({ text: "\n", bold, italics });
				break;
			case "image":
				runs.push({ text: (token as Tokens.Image).text, bold, italics });
				break;
			case "html":
				break;
			default: {
				const nested = (token as { tokens?: Token[] }).tokens;
				if (nested && nested.length > 0) runs.push(...inlineRuns(nested, bold, italics));
				else runs.push({ text: (token as { text?: string }).text ?? token.raw, bold, italics });
			}
		}
	}
	return runs;
}

/** Splits runs at line breaks into trimmed, non-blank lines. */
export function splitLines(runs: readonly InlineRun[]): InlineRun[][] {
	const lines: InlineRun[][] = [[]];
	for (const run of runs) {
		const parts = run.text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part) lines[lines.length - 1].push({ ...run, text: part });
		});
	}
	return lines.map(line => trimLine(line)).filter(line => line.some(run => run.text.trim() !== ""));
}

function trimLine(line: InlineRun[]): InlineRun[] {
	if (line.length === 0) return line;
	const out = line.map(run => ({ ...run }));
	out[0].text = out[0].text.trimStart();
	out[out.length - 1].text = out[out.length - 1].text.trimEnd();
	return out;
}

/** The inline text of tokens on one line, with runs of whitespace collapsed. */
export function plainText(tokens: readonly Token[] | undefined): string {
	return inlineRuns(tokens)
		.map(run => run.text)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/** Explicit title wins; otherwise the first `#` heading becomes the title and leaves the body. */
export function resolveTitle(markdown: string, title: string | undefined, fallbackTitle: string): TitledMarkdown {
	const tokens = lexMarkdown(markdown);
	const explicit = title?.trim();
	if (explicit) return { title: explicit, tokens };
	const index = tokens.findIndex(token => token.type === "heading" && (token as Tokens.Heading).depth === 1);
	if (index >= 0) {
		const heading = plainText((tokens[index] as Tokens.Heading).tokens);
		if (heading) return { title: heading, tokens: tokens.filter((_, i) => i !== index) };
	}
	return { title: fallbackTitle.trim() || "Document", tokens };
}

/** "1 table", "2 tables". */
export function countOf(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
