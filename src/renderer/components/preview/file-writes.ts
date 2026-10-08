/**
 * A small in-renderer bus that tells an open preview a tool call finished
 * writing a file, so it can re-check that file instead of polling it.
 */
import { resultDetails, resultText } from "../../lib/format";
import { parseOfficeResult } from "../tools/OfficeFileRenderer";
import { isOfficeTool, OFFICE_TOOL_KINDS } from "../tools/office-tools";

export interface FileWrite {
	tabId: string;
	path: string;
}

const listeners = new Set<(write: FileWrite) => void>();

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The file a finished, successful tool call wrote: the `write` tool's resolved
 * path (else its `path` argument), or the file an office tool reports. Null
 * for any other tool or a result that names no file.
 */
export function writtenPathOf(toolName: string, args: unknown, result: unknown): string | null {
	if (toolName === "write") {
		const resolved = nonEmptyString(resultDetails(result)?.resolvedPath);
		if (resolved) return resolved;
		if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
		return nonEmptyString((args as Record<string, unknown>).path);
	}
	if (isOfficeTool(toolName)) {
		return parseOfficeResult(resultText(result), OFFICE_TOOL_KINDS[toolName])?.file ?? null;
	}
	return null;
}

function isAbsolute(path: string): boolean {
	return path.startsWith("/");
}

/**
 * Lexical normalization for comparing paths: drops empty and `.` segments
 * (`//`, `./`, a trailing `/.` or `/`) and folds `..` into its parent where
 * one exists. Never touches the file system.
 */
function normalizePath(path: string): string {
	const absolute = isAbsolute(path);
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
			segments.pop();
			continue;
		}
		if (segment === ".." && absolute) continue;
		segments.push(segment);
	}
	const joined = segments.join("/");
	return absolute ? `/${joined}` : joined;
}

/**
 * Whether a finished write touched the previewed file. Absolute paths compare
 * directly, and against the path the preview's last read resolved to. A
 * relative path only means something in the tab it came from, so it matches
 * only a write from the preview's own tab: equal to the other relative path,
 * or as the tail of the other, absolute, path when no resolved path is known.
 */
export function writeMatchesPreview(
	write: FileWrite,
	target: { path: string; tabId: string | null },
	resolvedPath: string | null,
): boolean {
	const written = normalizePath(write.path);
	const previewed = normalizePath(target.path);
	const resolved = resolvedPath ? normalizePath(resolvedPath) : null;
	if (written === previewed && isAbsolute(written)) return true;
	if (resolved !== null && written === resolved) return true;
	const sameTab = write.tabId === target.tabId;
	if (!sameTab) return false;
	if (!isAbsolute(written)) {
		return written === previewed || (isAbsolute(previewed) && previewed.endsWith(`/${written}`));
	}
	if (isAbsolute(previewed)) return false;
	return resolved === null && written.endsWith(`/${previewed}`);
}

/** Tells every subscriber that `path` was written by a tool call in `tabId`. */
export function notifyFileWritten(tabId: string, path: string): void {
	const write: FileWrite = { tabId, path };
	for (const listener of [...listeners]) {
		try {
			listener(write);
		} catch (error) {
			console.error("A file write listener failed", error);
		}
	}
}

/** Subscribes to finished writes; returns the unsubscribe function. */
export function subscribeFileWrites(listener: (write: FileWrite) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
