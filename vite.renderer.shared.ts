/**
 * The renderer's Vite configuration, shared by the Electron build
 * (electron.vite.config.ts) and the Tauri build (vite.tauri.config.ts). The
 * two differ only in which module `@boot` resolves to and in how the CSP is
 * delivered, so everything else lives here once.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin, UserConfig } from "vite";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const resolveFromRoot = (...parts: string[]): string => path.resolve(ROOT, ...parts);

/**
 * Heavy renderer vendor libs split out of the eager main chunk. Patterns match
 * node_modules path segments; each family (and its transitive deps) lands in a
 * named chunk that lazy overlays load on demand instead of up front.
 */
export const VENDOR_CHUNK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
	// React core: every chunk depends on it, so shared interop helpers land
	// here — keeping cross-chunk imports one-way (no circular chunks).
	[/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, "react"],
	// Markdown pipeline: react-markdown + the unified/remark/rehype/mdast/hast ecosystem.
	[
		/[\\/]node_modules[\\/](react-markdown|lowlight|remark-|rehype-|mdast-|hast-|hastscript|unist-|unified|micromark|vfile|devlop|trough|bail|extend|zwitch|ccount|comma-separated-tokens|space-separated-tokens|decode-named-character-reference|character-entities|property-information|html-url-attributes|trim-lines|markdown-table|longest-streak|is-plain-obj|estree-util-|estree-walker|stringify-entities|web-namespaces)/,
		"markdown",
	],
	// KaTeX (pulled in by rehype-katex; kept separate so the markdown chunk stays lean).
	[/[\\/]node_modules[\\/]katex[\\/]/, "katex"],
	// Mermaid + its rendering stack (lazy-imported).
	[
		/[\\/]node_modules[\\/](mermaid|@mermaid-js|d3[^\\/]*|dagre[^\\/]*|@dagrejs|elkjs|dompurify|khroma|cytoscape|stylis|ts-dedent|marked|lodash-es|dayjs|uuid|robust-predicates|topojson-client)[\\/]/,
		"mermaid",
	],
	// chart.js + react-chartjs-2.
	[/[\\/]node_modules[\\/](chart\.js|react-chartjs-2|@kurkle)[\\/]/, "charts"],
	// xterm terminal.
	[/[\\/]node_modules[\\/]@xterm[\\/]/, "xterm"],
	// CodeMirror editor.
	[/[\\/]node_modules[\\/](@codemirror|@lezer)[\\/]/, "codemirror"],
	// highlight.js core + common grammars, shared by rehype-highlight (static,
	// via lowlight in the markdown chunk) and CodeBlock (dynamic import of
	// highlight.js/lib/common). Kept lowlight-free so chunk imports stay one-way.
	[/[\\/]node_modules[\\/]highlight\.js[\\/]/, "highlight"],
	// dnd-kit drag and drop.
	[/[\\/]node_modules[\\/]@dnd-kit[\\/]/, "dnd-kit"],
	// pdf.js (document preview and PDF card thumbnails; lazy-imported by lib/pdfjs.ts).
	[/[\\/]node_modules[\\/]pdfjs-dist[\\/]/, "pdfjs"],
	// SheetJS (sheet preview; lazy-imported with SheetPreview).
	[/[\\/]node_modules[\\/]xlsx[\\/]/, "sheetjs"],
];

/**
 * Build-time helpers that any chunk may import. Left unassigned, Rollup folds a
 * helper into the first manual chunk that depends on it: the dynamic-import
 * preload helper landed inside the lazy mermaid chunk, so the entry statically
 * imported — and evaluated — all of mermaid at startup just to reach it. Pinning
 * them to the eager react chunk keeps every vendor chunk truly on demand.
 */
export const SHARED_HELPER_ID = /^\0(?:vite\/preload-helper|commonjsHelpers)/;

function manualChunks(id: string): string | undefined {
	if (SHARED_HELPER_ID.test(id)) return "react";
	if (!id.includes("node_modules")) return undefined;
	for (const [pattern, chunk] of VENDOR_CHUNK_RULES) {
		if (pattern.test(id)) return chunk;
	}
	return undefined;
}

/** pdf.js data folders served from the app's own origin (`pdfDocumentOptions` in lib/pdfjs.ts). */
const PDFJS_DATA_DIRS = ["cmaps", "standard_fonts"] as const;
const PDFJS_DATA_FILE = /^[\w.+-]+$/;

/**
 * Self-hosts pdf.js's CMaps and standard fonts under `pdfjs/`, beside the
 * page, so CJK and non-embedded-font PDFs render without any remote host and
 * without widening the CSP. The build emits them as assets (`out/renderer/pdfjs/…`,
 * reached as `file://` in Electron and `tauri://localhost/` in Tauri); the dev
 * server serves the same paths straight from node_modules.
 */
function pdfjsAssets(): Plugin {
	const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
	return {
		name: "omp-pdfjs-assets",
		configureServer(server) {
			server.middlewares.use("/pdfjs", (req, res, next) => {
				const [, dir, file, ...rest] = new URL(req.url ?? "/", "http://localhost").pathname.split("/");
				const known = PDFJS_DATA_DIRS.find(name => name === dir);
				if (!known || file === undefined || rest.length > 0 || !PDFJS_DATA_FILE.test(file)) {
					next();
					return;
				}
				let source: Buffer;
				try {
					source = readFileSync(path.join(root, known, file));
				} catch {
					next();
					return;
				}
				res.setHeader("Content-Type", "application/octet-stream");
				res.end(source);
			});
		},
		generateBundle() {
			for (const dir of PDFJS_DATA_DIRS) {
				for (const file of readdirSync(path.join(root, dir))) {
					this.emitFile({
						type: "asset",
						fileName: `pdfjs/${dir}/${file}`,
						source: readFileSync(path.join(root, dir, file)),
					});
				}
			}
		},
	};
}

/**
 * The renderer config block. `bootModule` is the absolute path of the file
 * `@boot` resolves to: `src/renderer/boot/boot-electron.ts` or `boot-tauri.ts`.
 */
export function rendererConfig(bootModule: string): UserConfig {
	return {
		plugins: [tailwindcss(), pdfjsAssets()],
		resolve: {
			alias: {
				"@renderer": resolveFromRoot("src", "renderer"),
				"@shared": resolveFromRoot("src", "shared"),
				"@boot": bootModule,
			},
		},
		build: {
			rollupOptions: {
				input: {
					index: resolveFromRoot("src", "renderer", "index.html"),
					"quick-entry": resolveFromRoot("src", "renderer", "quick-entry.html"),
				},
				output: { manualChunks },
			},
		},
	};
}

export const BOOT_ELECTRON = resolveFromRoot("src", "renderer", "boot", "boot-electron.ts");
export const BOOT_TAURI = resolveFromRoot("src", "renderer", "boot", "boot-tauri.ts");
