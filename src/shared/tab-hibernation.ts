/**
 * Tab hibernation preference: whether an idle background tab may have its
 * sidecar stopped (and respawned with its session when the tab is viewed
 * again), and after how many idle minutes. Persisted in GUI prefs under
 * `tabHibernation`. The renderer writes it through the generic PREFS_SET, which
 * stores any value, so main parses every read here before it reaches the pool.
 */

export interface TabHibernationPref {
	enabled: boolean;
	/** Minutes without a sidecar frame before a background tab hibernates. */
	idleMinutes: number;
}

export const TAB_HIBERNATION_PREF_KEY = "tabHibernation";
export const TAB_HIBERNATION_MIN_MINUTES = 5;
export const TAB_HIBERNATION_MAX_MINUTES = 240;
export const DEFAULT_TAB_HIBERNATION: Readonly<TabHibernationPref> = { enabled: false, idleMinutes: 30 };

/**
 * Each field falls back to its default on its own, so a dotted write of one
 * field (`tabHibernation.enabled`) before the other exists still parses. Minutes
 * are clamped, never zero: a renderer cannot ask for a sweep on every tick.
 */
export function parseTabHibernationPref(raw: unknown): TabHibernationPref {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_TAB_HIBERNATION };
	const { enabled, idleMinutes } = raw as Record<string, unknown>;
	return {
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_TAB_HIBERNATION.enabled,
		idleMinutes:
			typeof idleMinutes === "number" && Number.isFinite(idleMinutes)
				? Math.min(TAB_HIBERNATION_MAX_MINUTES, Math.max(TAB_HIBERNATION_MIN_MINUTES, Math.round(idleMinutes)))
				: DEFAULT_TAB_HIBERNATION.idleMinutes,
	};
}

/** Whether a PREFS_SET key writes the hibernation preference (whole or one dotted field). */
export function isTabHibernationPrefKey(key: string): boolean {
	return key === TAB_HIBERNATION_PREF_KEY || key.startsWith(`${TAB_HIBERNATION_PREF_KEY}.`);
}
