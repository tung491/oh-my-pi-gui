/**
 * Reads back the document paths a send appended to a prompt. The composer
 * names each attached document on its own line after the typed text, quoted by
 * `quotePromptPath`; the transcript shows those as cards and the text alone.
 */

/** C0/C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Whether a path can be named on a prompt line: a line break would split the
 * one-path-per-line draft, and no control character survives a model copying
 * the path back exactly.
 */
export function isPromptSafePath(path: string): boolean {
	return !CONTROL_CHARACTER.test(path);
}

/**
 * Quotes a file path for a prompt line. Single quotes, as the pack skills were
 * measured with, unless the name holds one (`Bob's notes.docx`); then double
 * quotes, escaping any double quote or backslash inside.
 */
export function quotePromptPath(path: string): string {
	if (!path.includes("'")) return `'${path}'`;
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Undoes the double-quoted form: only `\\` and `\"` escapes, no bare quote inside. */
function decodeDoubleQuoted(inner: string): string | null {
	let decoded = "";
	for (let index = 0; index < inner.length; index++) {
		const char = inner[index];
		if (char === '"') return null;
		if (char !== "\\") {
			decoded += char;
			continue;
		}
		const next = inner[index + 1];
		if (next !== "\\" && next !== '"') return null;
		decoded += next;
		index += 1;
	}
	return decoded;
}

/**
 * The absolute path a line names, when the line is exactly what
 * `quotePromptPath` writes for it; otherwise null.
 */
function parseQuotedPathLine(line: string): string | null {
	if (line.length < 3) return null;
	const quote = line[0];
	if ((quote !== "'" && quote !== '"') || line[line.length - 1] !== quote) return null;
	const inner = line.slice(1, -1);
	const path = quote === "'" ? (inner.includes("'") ? null : inner) : decodeDoubleQuoted(inner);
	if (path === null || !path.startsWith("/") || !isPromptSafePath(path)) return null;
	return quotePromptPath(path) === line ? path : null;
}

/**
 * Splits a sent prompt into the typed body and the trailing run of quoted
 * document paths. Lines are taken from the end while each one is a single
 * quoted absolute path; the first other line ends the run. The inverse of
 * `appendDocumentPaths` for any body whose last line is not itself such a path.
 */
export function splitPromptAttachments(text: string): { body: string; paths: string[] } {
	const lines = text.split("\n");
	const paths: string[] = [];
	let end = lines.length;
	while (end > 0) {
		const path = parseQuotedPathLine(lines[end - 1] ?? "");
		if (path === null) break;
		paths.unshift(path);
		end -= 1;
	}
	if (paths.length === 0) return { body: text, paths };
	return { body: lines.slice(0, end).join("\n"), paths };
}
