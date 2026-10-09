/**
 * Guard for the renderer's startup cost: the heavy vendor chunks that only lazy
 * surfaces need must not be reachable from the entry through static imports. A
 * static edge makes the browser fetch, parse, and evaluate the whole chunk
 * before first paint — one misplaced shared helper once pulled all of mermaid
 * into every window's startup. Run after `vite build --config vite.tauri.config.ts` (`bun run build`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const RENDERER = new URL("../out/renderer-tauri/", import.meta.url).pathname;
/** Vendor chunks (vite.renderer.shared.ts VENDOR_CHUNK_RULES) that must load on demand. */
const LAZY_CHUNKS = [
	"mermaid",
	"codemirror",
	"charts",
	"highlight",
	"xterm",
	"pdfjs",
	"sheetjs",
	"docx",
	"pptx",
	"jszip",
];
const STATIC_IMPORT = /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{}\s,]+from\s*)?["'](\.\/[^"']+\.js)["']/g;

/** Every renderer page: the chat window and the quick-entry bar. */
const PAGES = ["index.html", "quick-entry.html"];
const chunkName = (file: string) => path.basename(file).replace(/-[\w-]{8}\.js$/, "");

let failed = false;
for (const page of PAGES) {
	const html = await fs.readFile(path.join(RENDERER, page), "utf8");
	const entry = html.match(/<script type="module"[^>]*src="(?:\.\/|\/)(assets\/[^"]+\.js)"/)?.[1];
	if (!entry) {
		console.error(`out/renderer-tauri/${page} has no module entry script`);
		process.exit(1);
	}

	const reached = new Map<string, string>([[entry, page]]);
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift() as string;
		const source = await fs.readFile(path.join(RENDERER, file), "utf8");
		for (const match of source.matchAll(STATIC_IMPORT)) {
			const target = path.join(path.dirname(file), match[1]);
			if (reached.has(target)) continue;
			reached.set(target, file);
			queue.push(target);
		}
	}

	const eager = [...reached.keys()].filter(file => LAZY_CHUNKS.includes(chunkName(file)));
	if (eager.length > 0) {
		for (const file of eager) console.error(`${file} is statically imported by ${reached.get(file)}`);
		console.error(
			`Lazy vendor chunks are reachable from the ${page} entry. Find the shared module Rollup folded into ` +
				"them (see SHARED_HELPER_ID in vite.renderer.shared.ts) or move the importing component behind lazy().",
		);
		failed = true;
		continue;
	}
	console.log(`${page} entry is lean: ${reached.size} eager chunks, none of ${LAZY_CHUNKS.join(", ")}`);
}
if (failed) process.exit(1);
