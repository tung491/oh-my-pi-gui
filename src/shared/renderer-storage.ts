/**
 * The renderer's localStorage keys that are mirrored into the profile's
 * prefs store, so a shell with a different webview origin (and so an empty
 * localStorage) can restore them. A future native shell bootstrap seeds
 * localStorage from these prefs paths, so this list must stay in sync with
 * `src-tauri/src/prefs.rs`.
 */

export const RENDERER_STORAGE_KEYS = [
	"omp.lang",
	"omp.themeScheme",
	"omp.update.dismissed",
	"omp.dock.focusHeight",
	"omp.palette.recent",
] as const;

export type RendererStorageKey = (typeof RENDERER_STORAGE_KEYS)[number];

/**
 * The prefs key a renderer storage key mirrors to. The prefs store
 * (src-tauri/src/prefs.rs) nests dotted keys, so `omp.lang` lands at `{ rendererStorage: { omp: { lang } } }`.
 */
export function rendererStoragePrefKey(key: RendererStorageKey): string {
	return `rendererStorage.${key}`;
}
