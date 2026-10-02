/**
 * `@boot` for the Tauri build: installs `window.omp` (chat windows) or
 * `window.ompQuickEntry` (the bar) before any other renderer module runs.
 * `webview.rs` sets `window.__OMP_BOOTSTRAP__` from an initialization script.
 */
import { createOmpApi } from "../../shared/bridge/create-omp-api";
import { createQuickEntryApi } from "../../shared/bridge/create-quick-entry-api";
import { createTauriPort } from "./tauri-port";

const bootstrap = window.__OMP_BOOTSTRAP__;
if (!bootstrap) {
	throw new Error(
		"Tauri page loaded without window.__OMP_BOOTSTRAP__; the initialization script from webview.rs did not run",
	);
}

if (bootstrap.windowKind === "quick-entry") {
	window.ompQuickEntry = createQuickEntryApi(createTauriPort("omp_quick_entry_invoke"), bootstrap.platform);
} else {
	window.omp = createOmpApi(createTauriPort("omp_invoke"), bootstrap.platform);
}
