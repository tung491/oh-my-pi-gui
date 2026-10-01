import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * Main-process packages bundled into out/main/index.js so packaged apps need no node_modules.
 * Anything the main entry imports that is NOT listed here stays a bare `import` in the
 * bundle, and the installed app only resolves it if electron-builder happened to collect
 * that package — in this nested checkout bun hoists most deps to the monorepo root, so the
 * traversal misses them and the app dies at launch with ERR_MODULE_NOT_FOUND.
 */
const MAIN_BUNDLED_DEPS = ["chokidar", "electron-store", "electron-updater", "yaml", "zod"];

/**
 * Heavy renderer vendor libs split out of the eager main chunk. Patterns match
 * node_modules path segments; each family (and its transitive deps) lands in a
 * named chunk that lazy overlays load on demand instead of up front.
 */
const VENDOR_CHUNK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
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
];

/**
 * Build-time helpers that any chunk may import. Left unassigned, Rollup folds a
 * helper into the first manual chunk that depends on it: the dynamic-import
 * preload helper landed inside the lazy mermaid chunk, so the entry statically
 * imported — and evaluated — all of mermaid at startup just to reach it. Pinning
 * them to the eager react chunk keeps every vendor chunk truly on demand.
 */
const SHARED_HELPER_ID = /^\0(?:vite\/preload-helper|commonjsHelpers)/;

function manualChunks(id: string): string | undefined {
	if (SHARED_HELPER_ID.test(id)) return "react";
	if (!id.includes("node_modules")) return undefined;
	for (const [pattern, chunk] of VENDOR_CHUNK_RULES) {
		if (pattern.test(id)) return chunk;
	}
	return undefined;
}

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin({ exclude: MAIN_BUNDLED_DEPS })],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/main/index.ts") },
				external: ["electron"],
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/preload/index.ts") },
				external: ["electron"],
				output: { format: "cjs" },
			},
		},
	},
	renderer: {
		plugins: [tailwindcss()],
		resolve: {
			alias: {
				"@renderer": resolve(__dirname, "src/renderer"),
				"@shared": resolve(__dirname, "src/shared"),
			},
		},
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/renderer/index.html"),
					"quick-entry": resolve(__dirname, "src/renderer/quick-entry.html"),
				},
				output: { manualChunks },
			},
		},
	},
});
