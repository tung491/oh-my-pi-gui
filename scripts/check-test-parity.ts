/**
 * Port-by-test gate: every `it("…")` / `test("…")` in the TypeScript test files a
 * module replaces must have a Rust twin with the normalized name, inside a
 * `#[cfg(test)]` module of the mapped Rust file, and that twin must assert
 * something. Mapping lives in `src-tauri/contracts/<module>.parity.json`.
 *
 *   bun scripts/check-test-parity.ts <module>
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ParityEntry {
	ts: string;
	rust: string;
}

/** Lowercase, non-alphanumerics → `_`, collapsed and trimmed. */
export function normalizeTestName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** `_2`, `_3`… for repeated names, in order of appearance. */
export function dedupeNames(names: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return names.map(name => {
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return count === 1 ? name : `${name}_${count}`;
	});
}

/** Index just past the bracket that closes the one at `open`, honoring strings and template literals. */
function closingIndex(source: string, open: number): number {
	const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
	const stack: string[] = [pairs[source[open] ?? ""] ?? ")"];
	let i = open + 1;
	while (i < source.length && stack.length > 0) {
		const ch = source[i] as string;
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(source, i);
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (ch in pairs) stack.push(pairs[ch] as string);
		else if (ch === stack[stack.length - 1]) stack.pop();
		i += 1;
	}
	return i;
}

/** Index just past the string literal starting at `start` (handles escapes and `${}` in templates). */
function skipString(source: string, start: number): number {
	const quote = source[start];
	let i = start + 1;
	while (i < source.length) {
		const ch = source[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (quote === "`" && ch === "$" && source[i + 1] === "{") {
			i = closingIndex(source, i + 1);
			continue;
		}
		if (ch === quote) return i + 1;
		i += 1;
	}
	return i;
}

/** The literal content of the string starting at `start`, or null when it is not a string. */
function stringAt(source: string, start: number): { text: string; end: number } | null {
	const quote = source[start];
	if (quote !== '"' && quote !== "'" && quote !== "`") return null;
	const end = skipString(source, start);
	return { text: source.slice(start + 1, end - 1), end };
}

function skipWhitespace(source: string, index: number): number {
	let i = index;
	while (i < source.length && /\s/.test(source[i] as string)) i += 1;
	return i;
}

/** The source with `//` and `/* *\/` comments blanked out; strings and template literals are kept. */
export function stripComments(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const ch = source[i] as string;
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = skipString(source, i);
			out += source.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/**
 * Raw test titles in source order. `it.each(table)("title")` and
 * `` it.each`table`("title") `` titles get the suffix ` cases` so a parametrized
 * test maps to one Rust function.
 */
export function collectRawTestNames(rawSource: string): string[] {
	const source = stripComments(rawSource);
	const names: string[] = [];
	const pattern = /(?<![\w$.])(?:it|test)(?:\.(?:only|skip|concurrent|sequential))*(\.each)?\s*(?=[(`])/g;
	for (const match of source.matchAll(pattern)) {
		let i = match.index + match[0].length;
		i = skipWhitespace(source, i);
		if (match[1]) {
			// Skip the table: a call `(…)` or a tagged template.
			if (source[i] === "(") i = closingIndex(source, i);
			else if (source[i] === "`") i = skipString(source, i);
			else continue;
			i = skipWhitespace(source, i);
		}
		if (source[i] !== "(") continue;
		const literal = stringAt(source, skipWhitespace(source, i + 1));
		if (!literal) continue;
		names.push(match[1] ? `${literal.text} cases` : literal.text);
	}
	return names;
}

/** Normalized, deduplicated test names of one TypeScript test file. */
export function collectTestNames(source: string): string[] {
	return dedupeNames(collectRawTestNames(source).map(normalizeTestName));
}

/** `fn name(…) { body }` pairs found inside `#[cfg(…test…)] mod … { … }` blocks. */
export function rustTestFunctions(source: string): Map<string, string> {
	const functions = new Map<string, string>();
	const cfgPattern = /#\[cfg\([^\]]*\btest\b[^\]]*\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
	for (const match of source.matchAll(cfgPattern)) {
		const open = match.index + match[0].length - 1;
		const close = closingIndex(source, open);
		const body = source.slice(open + 1, close - 1);
		const fnPattern = /\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
		for (const fn of body.matchAll(fnPattern)) {
			const brace = body.indexOf("{", fn.index + fn[0].length);
			if (brace === -1) continue;
			const end = closingIndex(body, brace);
			functions.set(fn[1] as string, body.slice(brace, end));
		}
	}
	return functions;
}

export interface ParityMiss {
	ts: string;
	rust: string;
	name: string;
	reason: "missing" | "no-assert";
}

/** Compare one mapping; `read` lets tests feed sources directly. */
export function checkParity(entries: readonly ParityEntry[], read: (file: string) => string): ParityMiss[] {
	const misses: ParityMiss[] = [];
	for (const entry of entries) {
		const names = collectTestNames(read(entry.ts));
		const functions = rustTestFunctions(read(entry.rust));
		for (const name of names) {
			const body = functions.get(name);
			if (body === undefined) misses.push({ ...entry, name, reason: "missing" });
			else if (!/\b(?:debug_)?assert(?:_eq|_ne|_matches)?!/.test(body))
				misses.push({ ...entry, name, reason: "no-assert" });
		}
	}
	return misses;
}

function main(): void {
	const module = process.argv[2];
	if (!module) {
		console.error("usage: bun scripts/check-test-parity.ts <module>");
		process.exit(2);
	}
	const parityFile = path.join(ROOT, "src-tauri", "contracts", `${module}.parity.json`);
	let entries: ParityEntry[];
	try {
		entries = JSON.parse(readFileSync(parityFile, "utf8")) as ParityEntry[];
	} catch (error) {
		console.error(`cannot read ${parityFile}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
	const misses = checkParity(entries, file => {
		try {
			return readFileSync(path.join(ROOT, file), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				console.error(`${file} does not exist yet; every test mapped to it counts as missing`);
				return "";
			}
			throw error;
		}
	});
	for (const miss of misses) {
		const detail = miss.reason === "missing" ? "has no Rust test" : "has a Rust test without an assert";
		console.error(`${miss.ts}: "${miss.name}" ${detail} in ${miss.rust}`);
	}
	const total = entries.reduce(
		(sum, entry) => sum + collectTestNames(readFileSync(path.join(ROOT, entry.ts), "utf8")).length,
		0,
	);
	if (misses.length > 0) {
		console.error(`check-test-parity ${module}: ${misses.length} of ${total} tests missing`);
		process.exit(1);
	}
	console.log(`check-test-parity ${module}: ${total} tests mirrored across ${entries.length} files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
