/**
 * Native-Wayland global shortcuts. Electron 44 binds `globalShortcut` through
 * the org.freedesktop.portal.GlobalShortcuts portal on native Wayland, but
 * only with these Chromium features on, and the portal needs an installed
 * `<app_id>.desktop` entry. Pure and electron-free so the decisions are
 * unit-tested; src/main/index.ts applies them.
 */

import { posix } from "node:path";

/** The features Chromium needs to talk to the portal (Electron 44 defaults neither trigger on). */
export const PORTAL_SHORTCUT_FEATURES = ["GlobalShortcutsPortal", "GlobalShortcutsPortalPreferredTrigger"] as const;

/**
 * Chromium keeps a single `--enable-features` value, so additions are merged
 * into the existing one: comma-separated, de-duplicated, existing order kept.
 */
export function mergeEnableFeatures(existing: string, add: readonly string[]): string {
	const features: string[] = [];
	for (const feature of [...existing.split(","), ...add]) {
		const name = feature.trim();
		if (name && !features.includes(name)) features.push(name);
	}
	return features.join(",");
}

/**
 * True when this Linux session talks to the GlobalShortcuts portal, which is
 * the native-Wayland ozone backend. An explicit `--ozone-platform` wins, then a
 * non-`auto` `--ozone-platform-hint`; otherwise Electron 38+ picks Wayland in a
 * Wayland session.
 */
export function usesShortcutPortal(
	platform: NodeJS.Platform,
	env: Readonly<Record<string, string | undefined>>,
	ozone: { platform: string; hint: string },
): boolean {
	if (platform !== "linux") return false;
	const explicit = ozone.platform.trim().toLowerCase();
	const hint = ozone.hint.trim().toLowerCase();
	const chosen = explicit || (hint === "auto" ? "" : hint);
	if (chosen) return chosen === "wayland";
	return env.XDG_SESSION_TYPE === "wayland";
}

/**
 * Where the desktop looks for `fileName`: `$XDG_DATA_HOME/applications`, then
 * each `$XDG_DATA_DIRS` entry's `applications`, with the XDG defaults for
 * unset or empty variables.
 */
export function desktopEntryCandidates(
	fileName: string,
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string[] {
	const dataHome = env.XDG_DATA_HOME?.trim() || posix.join(home, ".local", "share");
	const dataDirs = (env.XDG_DATA_DIRS?.trim() || "/usr/local/share:/usr/share").split(":").filter(Boolean);
	return [dataHome, ...dataDirs].map(dir => posix.join(dir, "applications", fileName));
}
