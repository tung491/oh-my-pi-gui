/**
 * The recent-workspace list shared by the tray menu and the quick-entry bar:
 * one entry per session cwd, most recently active first.
 */

/**
 * Unique cwds ordered by their newest session. `current` is always listed;
 * without a session of its own it sorts as the oldest.
 */
export function recentWorkspaceCwds(
	sessions: readonly { cwd: string; modified: string }[],
	current: string | null,
	limit: number,
): string[] {
	const byCwd = new Map<string, number>();
	for (const session of sessions) {
		const modified = Date.parse(session.modified) || 0;
		if (modified > (byCwd.get(session.cwd) ?? -1)) byCwd.set(session.cwd, modified);
	}
	if (current && !byCwd.has(current)) byCwd.set(current, 0);
	return [...byCwd.keys()].sort((a, b) => (byCwd.get(b) ?? 0) - (byCwd.get(a) ?? 0)).slice(0, limit);
}
