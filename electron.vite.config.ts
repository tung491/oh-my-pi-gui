import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { BOOT_ELECTRON, rendererConfig } from "./vite.renderer.shared";

/**
 * Main-process packages bundled into out/main/index.js so packaged apps need no node_modules.
 * Anything the main entry imports that is NOT listed here stays a bare `import` in the
 * bundle, and the installed app only resolves it if electron-builder happened to collect
 * that package — in this nested checkout bun hoists most deps to the monorepo root, so the
 * traversal misses them and the app dies at launch with ERR_MODULE_NOT_FOUND.
 */
const MAIN_BUNDLED_DEPS = ["chokidar", "electron-store", "electron-updater", "yaml", "zod"];

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
	renderer: rendererConfig(BOOT_ELECTRON),
});
