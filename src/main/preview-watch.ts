/**
 * Watches the files the document preview shows, so a preview refreshes by
 * itself after the file changes from any source (a tool, a shell, another
 * editor). Each watch observes the file's parent folder, not recursively, and
 * keeps only events naming the file, so an atomic save (write a temp file,
 * rename it over the target) and a delete + recreate are seen even though the
 * file's inode changes. Events are debounced: one `emit` once no relevant event
 * came for {@link PREVIEW_WATCH_DEBOUNCE_MS}. A window holds at most
 * {@link PREVIEW_WATCHES_PER_WINDOW} watches; a new one beyond that closes the
 * window's oldest. Paths resolve as `fs:read-document` resolves them.
 * The Tauri twin is `src-tauri/src/services/preview_watch.rs`.
 */
import { randomUUID } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import type { IpcFsWatchPreviewError, IpcFsWatchPreviewResult } from "../shared/ipc-types";
import { type OpenPathEnv, openPathTabId, resolveWithin } from "./open-path-resolve";

export const PREVIEW_WATCH_DEBOUNCE_MS = 1500;
export const PREVIEW_WATCHES_PER_WINDOW = 8;

export interface DirWatch {
	close(): void;
}

/**
 * Starts a non-recursive watch of `dir`. `onChange` gets the changed entry's
 * name, or null when the platform does not say; `onError` reports a watch
 * that died. Throws when the folder cannot be watched.
 */
export type DirWatchFactory = (
	dir: string,
	onChange: (filename: string | null) => void,
	onError: (error: unknown) => void,
) => DirWatch;

export const nodeDirWatch: DirWatchFactory = (dir, onChange, onError) => {
	// Not persistent: a preview watch must never keep the app from quitting.
	const watcher = fsWatch(dir, { persistent: false }, (_eventType, filename) => onChange(filename ?? null));
	watcher.on("error", onError);
	return watcher;
};

export type DocumentPathResolution =
	| { ok: true; path: string }
	| { ok: false; error: Exclude<IpcFsWatchPreviewError, "unavailable"> };

/**
 * `fs:read-document`'s path rule: absolute and `~/` paths as given
 * (normalized), relative ones confined to the tab's workspace (or the
 * window's when no tab is named); a named tab without a workspace refuses.
 */
export function resolveDocumentPath(raw: unknown, tabId: string | undefined, env: OpenPathEnv): DocumentPathResolution {
	if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "invalid-path" };
	const expanded = raw.startsWith("~/") ? path.join(env.homedir, raw.slice(2)) : raw;
	if (path.isAbsolute(expanded)) return { ok: true, path: path.normalize(expanded) };
	const cwd = env.cwdFor(tabId);
	if (!cwd) return { ok: false, error: "no-workspace" };
	const within = resolveWithin(cwd, expanded);
	if (!within) return { ok: false, error: "outside-workspace" };
	return { ok: true, path: within };
}

export interface PreviewWatchOptions {
	/** Delivers a settled change to the window that created the watch. */
	emit(ownerId: number, watchId: string): void;
	watchDir?: DirWatchFactory;
	debounceMs?: number;
	maxPerOwner?: number;
	newId?: () => string;
}

interface Entry {
	ownerId: number;
	basename: string;
	watcher: DirWatch;
	timer: ReturnType<typeof setTimeout> | null;
}

export class PreviewWatchRegistry {
	/** Insertion-ordered, so a window's first entry is its oldest. */
	#entries = new Map<string, Entry>();
	#emit: PreviewWatchOptions["emit"];
	#watchDir: DirWatchFactory;
	#debounceMs: number;
	#maxPerOwner: number;
	#newId: () => string;

	constructor(options: PreviewWatchOptions) {
		this.#emit = options.emit;
		this.#watchDir = options.watchDir ?? nodeDirWatch;
		this.#debounceMs = options.debounceMs ?? PREVIEW_WATCH_DEBOUNCE_MS;
		this.#maxPerOwner = options.maxPerOwner ?? PREVIEW_WATCHES_PER_WINDOW;
		this.#newId = options.newId ?? randomUUID;
	}

	/** `payload` is the renderer's `{ path, tabId? }`, validated here. Never throws. */
	watch(ownerId: number, payload: unknown, env: OpenPathEnv): IpcFsWatchPreviewResult {
		const fields = typeof payload === "object" && payload !== null ? (payload as { path?: unknown }) : {};
		const resolved = resolveDocumentPath(fields.path, openPathTabId(payload), env);
		if (!resolved.ok) return { ok: false, error: resolved.error };

		const watchId = this.#newId();
		const entry: Entry = { ownerId, basename: path.basename(resolved.path), watcher: { close() {} }, timer: null };
		try {
			entry.watcher = this.#watchDir(
				path.dirname(resolved.path),
				filename => this.#onChange(watchId, entry, filename),
				() => this.#close(watchId),
			);
		} catch {
			return { ok: false, error: "unavailable" };
		}
		this.#entries.set(watchId, entry);
		this.#trim(ownerId);
		return { ok: true, watchId };
	}

	/** Closes `watchId` when `ownerId` created it; anything else is a no-op. */
	unwatch(ownerId: number, watchId: unknown): void {
		if (typeof watchId !== "string") return;
		if (this.#entries.get(watchId)?.ownerId === ownerId) this.#close(watchId);
	}

	/** Closes every watch of a window (closed, reloaded or crashed). */
	closeOwner(ownerId: number): void {
		for (const [watchId, entry] of [...this.#entries]) {
			if (entry.ownerId === ownerId) this.#close(watchId);
		}
	}

	closeAll(): void {
		for (const watchId of [...this.#entries.keys()]) this.#close(watchId);
	}

	#onChange(watchId: string, entry: Entry, filename: string | null): void {
		if (this.#entries.get(watchId) !== entry) return;
		// No name means the platform did not say which entry changed: assume this one.
		if (filename !== null && filename !== entry.basename) return;
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.timer = null;
			if (this.#entries.get(watchId) !== entry) return;
			try {
				this.#emit(entry.ownerId, watchId);
			} catch {
				// A window torn down mid-send; its own close handler drops the watch.
			}
		}, this.#debounceMs);
	}

	#trim(ownerId: number): void {
		const owned = [...this.#entries].filter(([, entry]) => entry.ownerId === ownerId);
		for (const [watchId] of owned.slice(0, Math.max(0, owned.length - this.#maxPerOwner))) this.#close(watchId);
	}

	#close(watchId: string): void {
		const entry = this.#entries.get(watchId);
		if (!entry) return;
		this.#entries.delete(watchId);
		if (entry.timer) clearTimeout(entry.timer);
		try {
			entry.watcher.close();
		} catch {
			// Already closed by the platform.
		}
	}
}
