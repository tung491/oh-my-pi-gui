/**
 * Where `system:open-path` points before the OS sees it: `~/` expands, an
 * absolute path passes through, and a relative one resolves inside a
 * workspace: the given tab's when the caller names one, else the calling
 * window's. A named tab that has no workspace fails rather than borrowing
 * another tab's, so a pinned preview never opens a same-named file elsewhere.
 * The Tauri twin is `resolve_open_path` in `src-tauri/src/services/system.rs`.
 */
import path from "node:path";

export interface OpenPathEnv {
	homedir: string;
	/** The workspace of `tabId`, or of the calling window when it is undefined; null when there is none. */
	cwdFor(tabId: string | undefined): string | null;
}

export type OpenPathResolution = { ok: true; path: string } | { ok: false; error: string };

/** Resolve `rel` against `root`, refusing escapes outside the workspace. */
export function resolveWithin(root: string, rel: string): string | null {
	const resolved = path.resolve(root, rel);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
	return resolved;
}

/** The tab id from the renderer's optional `{ tabId }`; anything but a non-empty string means none. */
export function openPathTabId(options: unknown): string | undefined {
	if (typeof options !== "object" || options === null) return undefined;
	const { tabId } = options as { tabId?: unknown };
	return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
}

export function resolveOpenPath(target: unknown, tabId: string | undefined, env: OpenPathEnv): OpenPathResolution {
	if (typeof target !== "string" || !target.trim()) return { ok: false, error: "Empty path" };
	const expanded = target.startsWith("~/") ? path.join(env.homedir, target.slice(2)) : target;
	if (path.isAbsolute(expanded)) return { ok: true, path: expanded };
	const root = env.cwdFor(tabId);
	if (!root) return { ok: false, error: "No workspace" };
	const within = resolveWithin(root, expanded);
	if (!within) return { ok: false, error: "Path escapes the workspace" };
	return { ok: true, path: within };
}
