#!/usr/bin/env bun
/**
 * Every Playwright spec in `e2e/` must have a WebdriverIO twin in `e2e-tauri/`
 * with the same file name, the same set of test titles, and for each title at
 * least as many assertions. Specs that exist only for the Tauri shell are
 * listed in TAURI_ONLY; anything else without a Playwright original fails.
 *
 * Usage: `bun e2e-tauri/check-twins.ts` — exits 1 and prints every difference.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ORIGINALS = path.join(ROOT, "e2e");
const TWINS = path.join(ROOT, "e2e-tauri");
const SPEC_SUFFIX = ".e2e.ts";

/** Twins with no Playwright original, by design. */
const TAURI_ONLY: ReadonlySet<string> = new Set(["csp.e2e.ts"]);

/**
 * Tests that exist only in a twin, by design: the installed-package smoke ends
 * with the hard-kill case, which only the Tauri shell's sidecar supervisor has,
 * and the desktop spec checks the restored window size, which the Tauri shell
 * corrects for its window decoration itself (Electron's `setBounds` did not need to).
 */
const TAURI_ONLY_TESTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["packaged-smoke.e2e.ts", new Set(["a hard kill leaves no sidecar or tool child"])],
	[
		"desktop.e2e.ts",
		new Set(["a restored window opens at its saved footprint and a restart leaves the saved state unchanged"]),
	],
]);

/** A test definition at the start of a line: Playwright's `test(` or mocha's `it(`. */
const TEST_START = /^[ \t]*(?:test|it)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gm;
/** An assertion: `expect(` or Playwright's polling form `expect.poll(`. */
const ASSERTION = /\bexpect(?:\.poll)?\(/g;

interface TestCase {
	title: string;
	assertions: number;
}

/**
 * Titles with the assertion count of each test's region: from its `test(`/`it(`
 * to the next one. Shared helpers above the first test belong to no test, so a
 * port must keep assertions inside tests to count.
 */
export function readCases(source: string): TestCase[] {
	const starts = [...source.matchAll(TEST_START)].map(match => ({
		title: match[2].replace(/\\(.)/g, "$1"),
		index: match.index,
	}));
	return starts.map((start, position) => {
		const end = position + 1 < starts.length ? starts[position + 1].index : source.length;
		const region = source.slice(start.index, end);
		return { title: start.title, assertions: [...region.matchAll(ASSERTION)].length };
	});
}

function specFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(SPEC_SUFFIX))
		.sort();
}

export function compare(originals: Map<string, string>, twins: Map<string, string>): string[] {
	const problems: string[] = [];
	for (const [file, source] of originals) {
		const twin = twins.get(file);
		if (twin === undefined) {
			problems.push(`${file}: no twin in e2e-tauri/`);
			continue;
		}
		const wanted = readCases(source);
		const found = new Map(readCases(twin).map(testCase => [testCase.title, testCase]));
		const wantedTitles = new Set(wanted.map(testCase => testCase.title));
		for (const testCase of wanted) {
			const match = found.get(testCase.title);
			if (!match) {
				problems.push(`${file}: missing twin for "${testCase.title}"`);
			} else if (match.assertions < testCase.assertions) {
				problems.push(
					`${file}: "${testCase.title}" has ${match.assertions} assertion(s) in the twin, ${testCase.assertions} in the original`,
				);
			}
		}
		const twinOnly = TAURI_ONLY_TESTS.get(file) ?? new Set<string>();
		for (const title of found.keys()) {
			if (!wantedTitles.has(title) && !twinOnly.has(title))
				problems.push(`${file}: twin-only test "${title}" has no Playwright original`);
		}
		for (const title of twinOnly) {
			if (!found.has(title)) problems.push(`${file}: Tauri-only test "${title}" is missing from the twin`);
		}
	}
	for (const file of twins.keys()) {
		if (!originals.has(file) && !TAURI_ONLY.has(file)) {
			problems.push(`${file}: no Playwright original and not listed as Tauri-only`);
		}
	}
	for (const file of TAURI_ONLY) {
		if (!twins.has(file)) problems.push(`${file}: listed as Tauri-only but missing from e2e-tauri/`);
	}
	return problems;
}

function readAll(dir: string): Map<string, string> {
	return new Map(specFiles(dir).map(file => [file, fs.readFileSync(path.join(dir, file), "utf8")]));
}

function main(): void {
	const originals = readAll(ORIGINALS);
	const twins = readAll(TWINS);
	const problems = compare(originals, twins);
	const total = [...originals.values()].reduce((sum, source) => sum + readCases(source).length, 0);
	if (problems.length === 0) {
		console.log(`check-twins: ${originals.size} spec file(s), ${total} test(s), every twin matches`);
		return;
	}
	console.error(
		`check-twins: ${problems.length} difference(s) across ${originals.size} spec file(s), ${total} test(s)`,
	);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
