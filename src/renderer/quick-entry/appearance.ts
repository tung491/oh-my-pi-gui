/**
 * The bar follows the main window's light or dark scheme. pre-paint.js applies
 * it once at load, but the bar's page lives across summons while the user may
 * change the theme, so each show re-reads the scheme lib/themes.ts stores.
 */

const BACKGROUND = { dark: "#0a1a33", light: "#f7f9fc" } as const;

/** The stored scheme, with the OS preference standing in for "system" or none. */
export function resolveScheme(stored: string | null, prefersDark: boolean): "dark" | "light" {
	if (stored === "dark" || stored === "light") return stored;
	return prefersDark ? "dark" : "light";
}

export function applyScheme(): void {
	let stored: string | null = null;
	try {
		stored = localStorage.getItem("omp.themeScheme");
	} catch {
		// No storage: fall back to the OS preference.
	}
	const prefersDark =
		typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
	const scheme = resolveScheme(stored, prefersDark);
	const root = document.documentElement;
	root.dataset.theme = scheme;
	root.style.backgroundColor = BACKGROUND[scheme];
	root.style.colorScheme = scheme;
}
