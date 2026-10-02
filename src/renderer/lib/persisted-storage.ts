/**
 * Write-through localStorage for the keys in RENDERER_STORAGE_KEYS: every
 * write also lands in the profile's prefs store, which outlives the webview
 * origin. Values are mirrored as the exact strings localStorage holds. The
 * prefs mirror is fire-and-forget — a failed write loses only the mirror,
 * never the setting — and is skipped where the preload bridge is absent
 * (the quick-entry page has no `window.omp`).
 */
import { RENDERER_STORAGE_KEYS, type RendererStorageKey, rendererStoragePrefKey } from "../../shared/renderer-storage";

function mirrorToPrefs(key: RendererStorageKey, value: string): void {
	try {
		const prefs = globalThis.window?.omp?.prefs;
		if (!prefs) return;
		void prefs.set(rendererStoragePrefKey(key), value).catch(() => {});
	} catch {
		/* bridge unavailable — the mirror is best-effort */
	}
}

/** Write `value` to localStorage and mirror it into prefs. Never throws. */
export function writePersisted(key: RendererStorageKey, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage unavailable — the prefs mirror still records the value */
	}
	mirrorToPrefs(key, value);
}

/** Mirror every present key's current localStorage value into prefs. Never throws. */
export function mirrorAllToPrefs(): void {
	for (const key of RENDERER_STORAGE_KEYS) {
		let value: string | null;
		try {
			value = localStorage.getItem(key);
		} catch {
			return;
		}
		if (value !== null) mirrorToPrefs(key, value);
	}
}
