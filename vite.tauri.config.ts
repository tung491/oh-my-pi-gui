/**
 * Vite config for the renderer inside the Tauri shell. Same renderer as the
 * Electron build (vite.renderer.shared.ts) with two differences: `@boot`
 * installs the Tauri bridge, and the HTML meta CSP is removed because its
 * `connect-src 'self'` would block Tauri's IPC transport; the same policy is
 * served from tauri.conf.json → app.security.csp instead.
 */
import { defineConfig, type Plugin } from "vite";
import { BOOT_TAURI, rendererConfig } from "./vite.renderer.shared";

const META_CSP = /\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*\/?>(?:\s*<\/meta>)?/gi;

function stripMetaCsp(): Plugin {
	return {
		name: "omp-strip-meta-csp",
		transformIndexHtml(html) {
			return html.replace(META_CSP, "");
		},
	};
}

const port = Number.parseInt(process.env.OMP_TAURI_DEV_PORT ?? "5183", 10);
if (!Number.isInteger(port) || port <= 0) {
	throw new Error(`OMP_TAURI_DEV_PORT must be a port number, got ${JSON.stringify(process.env.OMP_TAURI_DEV_PORT)}`);
}

const shared = rendererConfig(BOOT_TAURI);

export default defineConfig({
	...shared,
	root: "src/renderer",
	plugins: [...(shared.plugins ?? []), stripMetaCsp()],
	build: {
		...shared.build,
		outDir: "../../out/renderer-tauri",
		emptyOutDir: true,
	},
	server: { port, strictPort: true },
	// Tauri's dev CLI prints its own status; keep Vite's output to what matters.
	clearScreen: false,
});
