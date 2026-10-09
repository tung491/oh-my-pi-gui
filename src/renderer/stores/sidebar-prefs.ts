/**
 * Sidebar presentation prefs: pinned sessions, explicit session MRU access
 * times, and workspace display aliases (rename, read by the tab bar). Persisted as one JSON blob
 * under the "sidebar" prefs key via window.omp.prefs (the prefs store, src-tauri/src/prefs.rs);
 * hydrate once at App mount. Recency bookkeeping writes fire-and-forget; the
 * pins and aliases the user can SEE are optimistic writes that roll back when
 * the persist rejects, so a row never stays pinned across a restart.
 */
import { create } from "zustand";
import { translate } from "../lib/i18n";
import { optimisticWrite } from "../lib/optimistic";
import { toast } from "./toast";

const PREFS_KEY = "sidebar";

/** Stored blob. The workspace pins and workspace access times older builds
 *  wrote are ignored on read and dropped by the next write. */
interface SidebarPrefsBlob {
	pinnedSessions?: string[];
	groupAliases?: Record<string, string>;
	sessionLastUsed?: Record<string, number>;
}

interface SidebarPrefsStore {
	pinnedSessions: string[];
	groupAliases: Record<string, string>;
	sessionLastUsed: Record<string, number>;
	hydrated: boolean;
	hydrate: () => Promise<void>;
	toggleSessionPin: (path: string) => Promise<void>;
	setGroupAlias: (cwd: string, alias: string | null) => Promise<void>;
	touchSession: (path: string) => void;
	reset: () => void;
}

const MAX_RECENT_SESSIONS = 500;

function validRecencyMap(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, number> = {};
	for (const [key, timestamp] of Object.entries(value)) {
		if (key && typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
			result[key] = timestamp;
		}
	}
	return result;
}

function nextTimestamp(map: Record<string, number>): number {
	let latest = 0;
	for (const value of Object.values(map)) latest = Math.max(latest, value);
	return Math.max(Date.now(), latest + 1);
}

function touchedMap(
	current: Record<string, number>,
	key: string,
	timestamp: number,
	limit: number,
): Record<string, number> {
	const entries = Object.entries({ ...current, [key]: timestamp }).sort((a, b) => b[1] - a[1]);
	return Object.fromEntries(entries.slice(0, limit));
}

function prefsBlob(state: SidebarPrefsStore): SidebarPrefsBlob {
	return {
		pinnedSessions: state.pinnedSessions,
		groupAliases: state.groupAliases,
		sessionLastUsed: state.sessionLastUsed,
	};
}

/** Recency bookkeeping: a lost write costs an ordering hint, nothing the user
 *  set out to do, so it stays fire-and-forget. */
function persist(get: () => SidebarPrefsStore): void {
	void writePrefs(get);
}

async function writePrefs(get: () => SidebarPrefsStore): Promise<{ success: boolean; error?: string }> {
	try {
		await window.omp.prefs.set(PREFS_KEY, prefsBlob(get()));
		return { success: true };
	} catch (cause) {
		return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

export const useSidebarPrefs = create<SidebarPrefsStore>()((set, get) => ({
	pinnedSessions: [],
	groupAliases: {},
	sessionLastUsed: {},
	hydrated: false,

	hydrate: async () => {
		if (get().hydrated) return;
		try {
			const blob = (await window.omp.prefs.get(PREFS_KEY)) as SidebarPrefsBlob | null | undefined;
			set({
				pinnedSessions: Array.isArray(blob?.pinnedSessions) ? blob.pinnedSessions : [],
				groupAliases: blob?.groupAliases && typeof blob.groupAliases === "object" ? blob.groupAliases : {},
				sessionLastUsed: validRecencyMap(blob?.sessionLastUsed),
				hydrated: true,
			});
		} catch {
			set({ hydrated: true });
		}
	},

	toggleSessionPin: path =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => ({
				pinnedSessions: state.pinnedSessions.includes(path)
					? state.pinnedSessions.filter(item => item !== path)
					: [...state.pinnedSessions, path],
			}),
			persist: () => writePrefs(get),
			onFailure: message => toast({ variant: "error", title: translate("sidebar.pinFailed"), message }),
		}),

	setGroupAlias: (cwd, alias) =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => {
				const groupAliases = { ...state.groupAliases };
				if (alias?.trim()) groupAliases[cwd] = alias.trim();
				else delete groupAliases[cwd];
				return { groupAliases };
			},
			persist: () => writePrefs(get),
			onFailure: message => toast({ variant: "error", title: translate("sidebar.renameFailed"), message }),
		}),

	touchSession: path => {
		if (!path) return;
		const state = get();
		const timestamp = nextTimestamp(state.sessionLastUsed);
		set({ sessionLastUsed: touchedMap(state.sessionLastUsed, path, timestamp, MAX_RECENT_SESSIONS) });
		persist(get);
	},

	reset: () =>
		set({
			pinnedSessions: [],
			groupAliases: {},
			sessionLastUsed: {},
			hydrated: false,
		}),
}));
