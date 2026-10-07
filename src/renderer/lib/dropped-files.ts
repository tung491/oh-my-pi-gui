/**
 * Paths of files dropped on the page. Electron's `File` has no path, so its
 * preload exposes `webUtils.getPathForFile` as `window.omp.system.pathForFile`.
 * Tauri keeps its native drag-drop handler off (HTML5 DnD powers tab reorder
 * and pane split), and WebKitGTK then hides the dropped paths from the page:
 * the drop lists `text/uri-list` but returns it empty and has no `Files`. The
 * shell reads the paths from the GTK drop data instead and sends them as
 * `system.onNativeDropPaths`, ahead of the page's `drop` event. Those paths
 * serve only a drag that lists `Files` or `text/uri-list`, and any drop or
 * drag end in the window retires them, so an abandoned file drag never leaks
 * into a later text or tab drop.
 */
import type { OmpApi } from "../../shared/ipc-types";

/**
 * Native paths with no file-drag activity for this long belong to an abandoned
 * drag. WebKitGTK sends no `dragover` while the pointer rests, so this outlasts
 * a pause before the drop; a later URI-list drag replaces or clears them anyway.
 */
const NATIVE_PATHS_FRESH_MS = 10_000;
/** How long a drop waits for native paths that have not arrived yet. */
const NATIVE_PATHS_WAIT_MS = 300;

let nativeSource: OmpApi["system"] | null = null;
let unsubscribeNative: (() => void) | null = null;
let nativePaths: { paths: string[]; at: number } | null = null;
const nativeWaiters = new Set<() => void>();
let lifecycleTarget: EventTarget | null = null;

/**
 * Retires native paths when a drag ends anywhere in the window. A drop clears
 * them after its own handlers ran (capture runs first, and the composer takes
 * them synchronously in its `drop` handler); paths that arrive afterwards
 * belong to a newer drag and stay.
 */
function retireNativePathsOnDrop(): void {
	const atDrop = nativePaths;
	if (!atDrop) return;
	setTimeout(() => {
		if (nativePaths === atDrop) nativePaths = null;
	}, 0);
}

function retireNativePathsNow(): void {
	nativePaths = null;
}

function watchDragLifecycle(target: EventTarget): void {
	if (lifecycleTarget === target) return;
	lifecycleTarget?.removeEventListener("drop", retireNativePathsOnDrop, true);
	lifecycleTarget?.removeEventListener("dragend", retireNativePathsNow, true);
	lifecycleTarget = target;
	target.addEventListener("drop", retireNativePathsOnDrop, true);
	target.addEventListener("dragend", retireNativePathsNow, true);
}

/**
 * Subscribe to the shell's native drop paths once per `window.omp`. The shell
 * sends them before the page's first `dragenter` of a drag, so this runs when
 * the module loads, and again from every entry point in case `window.omp`
 * changed.
 */
function watchNativeDropPaths(): void {
	const system = window.omp?.system;
	if (!system || system === nativeSource) return;
	if (typeof window.addEventListener === "function") watchDragLifecycle(window);
	unsubscribeNative?.();
	nativeSource = system;
	nativePaths = null;
	unsubscribeNative =
		system.onNativeDropPaths?.(paths => {
			// An empty list is a drag without files (a link): it clears what an
			// earlier file drag left behind.
			nativePaths = paths.length > 0 ? { paths, at: Date.now() } : null;
			if (nativePaths) for (const wake of [...nativeWaiters]) wake();
		}) ?? null;
}

if (typeof window !== "undefined") watchNativeDropPaths();

/** The fresh native paths, left in place. */
function freshNativePaths(): string[] | null {
	const current = nativePaths;
	if (!current || Date.now() - current.at > NATIVE_PATHS_FRESH_MS) return null;
	return current.paths;
}

/** The fresh native paths, consumed so a later drop never reuses them. */
function takeNativePaths(): string[] | null {
	const paths = freshNativePaths();
	if (paths) nativePaths = null;
	return paths;
}

/** Whether the drag's types announce files: `Files` (Chromium) or `text/uri-list` (WebKitGTK). */
function listsFileTypes(data: DataTransfer): boolean {
	const types = Array.from(data.types ?? []);
	return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * True for drags that carry files (tab and pane drags do not). WebKitGTK lists
 * only `text/uri-list` for a file drag, never `Files`. The shell sends a drag's
 * native paths once, when it enters the window, so every file `dragenter` and
 * `dragover` keeps them fresh for as long as the drag lasts.
 */
export function isFileDrag(data: DataTransfer | null): boolean {
	watchNativeDropPaths();
	if (!data) return false;
	const fileDrag = listsFileTypes(data);
	// Only fresh paths are kept alive: stale ones belong to an abandoned drag.
	if (fileDrag && nativePaths && freshNativePaths()) nativePaths.at = Date.now();
	return fileDrag;
}

/**
 * Whether a drag in progress is known to carry files, for `dragenter` and
 * `dragover`: `Files` in its types (Chromium), or a URI-list drag with fresh
 * native paths from the shell (WebKitGTK, which sends them as the drag enters
 * the window, and an empty list for a link). Only such drags may be claimed:
 * once the page cancels `dragover`, WebKit treats the drop as the page's and
 * skips its own insertion into a text field, even when `drop` is left alone.
 */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
	if (!isFileDrag(data)) return false;
	return Array.from(data?.types ?? []).includes("Files") || freshNativePaths() !== null;
}

/** Absolute local path of one `file://` URI, or null for anything else. */
function filePathOfUri(uri: string): string | null {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return null;
	}
	if (url.protocol !== "file:") return null;
	// A remote host (file://server/share) is not a local path.
	if (url.hostname !== "" && url.hostname !== "localhost") return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(url.pathname);
	} catch {
		return null;
	}
	return decoded.startsWith("/") ? decoded : null;
}

/** Local paths in a `text/uri-list` body (RFC 2483: CRLF lines, `#` comments). */
function pathsFromUriList(list: string): string[] {
	const paths: string[] = [];
	for (const line of list.split(/\r?\n/)) {
		const uri = line.trim();
		if (uri.length === 0 || uri.startsWith("#")) continue;
		const path = filePathOfUri(uri);
		if (path) paths.push(path);
	}
	return paths;
}

function pathsFromFiles(data: DataTransfer): string[] {
	const pathForFile = window.omp?.system.pathForFile;
	if (!pathForFile) return [];
	const paths: string[] = [];
	for (const file of Array.from(data.files ?? [])) {
		let path = "";
		try {
			path = pathForFile(file);
		} catch {
			// A File the shell cannot resolve (e.g. built in the page) has no path.
		}
		if (path) paths.push(path);
	}
	return paths;
}

/**
 * Dropped file paths in drop order, without duplicates: the drop's
 * `text/uri-list` when it names local files, else the shell's `pathForFile`.
 */
export function droppedFilePaths(data: DataTransfer): string[] {
	let fromUris: string[] = [];
	try {
		fromUris = pathsFromUriList(data.getData("text/uri-list") ?? "");
	} catch {
		// Some engines refuse getData outside the drop event itself.
	}
	return dedupe(fromUris.length > 0 ? fromUris : pathsFromFiles(data));
}

/**
 * Whether a drop carries files, decided synchronously so the `drop` handler can
 * cancel the page's default insertion only then: the page's own paths, or fresh
 * native paths from the shell (peeked, not consumed) when the drop lists file
 * types. A link dropped on a text field lists `text/uri-list` too but names no
 * local file and gets no native paths, so it keeps the engine's default
 * insertion; a text or tab drop never takes native paths at all.
 */
export function hasDroppedFiles(data: DataTransfer | null): boolean {
	watchNativeDropPaths();
	if (!data) return false;
	return droppedFilePaths(data).length > 0 || (listsFileTypes(data) && freshNativePaths() !== null);
}

/**
 * {@link droppedFilePaths}, or else, for a drop that lists file types, the
 * native paths the shell sent for this drag: the most recent ones, unless the
 * page has seen no file drag for `NATIVE_PATHS_FRESH_MS`, waiting briefly for
 * them when they have not arrived yet. Native paths are used at most once.
 */
export async function resolveDroppedPaths(data: DataTransfer): Promise<string[]> {
	watchNativeDropPaths();
	const fromPage = droppedFilePaths(data);
	if (fromPage.length > 0) return fromPage;
	if (!nativeSource?.onNativeDropPaths || !listsFileTypes(data)) return [];
	const ready = takeNativePaths();
	if (ready) return dedupe(ready);
	const arrived = await new Promise<string[] | null>(resolve => {
		const finish = () => {
			clearTimeout(timer);
			nativeWaiters.delete(finish);
			resolve(takeNativePaths());
		};
		const timer = setTimeout(finish, NATIVE_PATHS_WAIT_MS);
		nativeWaiters.add(finish);
	});
	return arrived ? dedupe(arrived) : [];
}

function dedupe(paths: string[]): string[] {
	return [...new Set(paths)];
}
