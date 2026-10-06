// Where office files go, how they are named, and what counts as inside a folder.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type OfficeKind = "docx" | "xlsx" | "pptx";

/** The one-line result every office tool reports; the GUI's output card parses it. */
export interface OfficeResult {
	file: string;
	kind: OfficeKind;
	check: string;
}

/** A failure whose message is a fixed plain sentence, safe to show the person. */
export class PlainError extends Error {}

export interface DocumentsEnv {
	platform: NodeJS.Platform;
	home: string;
	/** Prints the XDG documents folder (`xdg-user-dir DOCUMENTS`); may throw. */
	runXdgUserDir: () => string;
}

const OUTPUT_FOLDER = "Sai ATLAS";
const DEFAULT_BASE_NAME = "Document";
/** ext4 and most Linux file systems cap a name at 255 bytes; leave room for " (9999).xlsx". */
const MAX_BASE_NAME_BYTES = 200;
const MAX_SUFFIX = 9999;

export function defaultRunXdgUserDir(): string {
	return execFileSync("xdg-user-dir", ["DOCUMENTS"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5_000,
	});
}

/**
 * Documents > Sai ATLAS. On Linux the documents folder comes from `xdg-user-dir`,
 * which prints the home folder itself when no documents folder is configured;
 * that, an empty answer or a failure falls back to `~/Documents`.
 */
export function documentsDir(env: DocumentsEnv): string {
	const fallback = join(env.home, "Documents", OUTPUT_FOLDER);
	if (env.platform !== "linux") return fallback;
	let printed: string;
	try {
		printed = env.runXdgUserDir().trim();
	} catch {
		return fallback;
	}
	if (!printed || !isAbsolute(printed) || resolve(printed) === resolve(env.home)) return fallback;
	return join(printed, OUTPUT_FOLDER);
}

function truncateToBytes(text: string, maxBytes: number): string {
	let out = text;
	while (Buffer.byteLength(out) > maxBytes) out = Array.from(out).slice(0, -1).join("");
	return out;
}

/** A file name without path separators, reserved characters or control characters. */
export function safeBaseName(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
	const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "").trim();
	const capped = truncateToBytes(cleaned, MAX_BASE_NAME_BYTES).trim();
	return capped || DEFAULT_BASE_NAME;
}

/**
 * Writes bytes under `<base>.<ext>`, or `<base> (n).<ext>` when that name is taken.
 * The exclusive open makes the name check and the create one step, so two writers
 * never share a file and nothing is ever replaced.
 */
export function writeUnique(dir: string, base: string, ext: OfficeKind, bytes: Uint8Array): string {
	for (let n = 1; n <= MAX_SUFFIX; n++) {
		const path = join(dir, n === 1 ? `${base}.${ext}` : `${base} (${n}).${ext}`);
		let fd: number;
		try {
			fd = openSync(path, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		try {
			writeSync(fd, bytes);
		} finally {
			closeSync(fd);
		}
		return path;
	}
	throw new PlainError("There are too many files with this name in the Sai ATLAS folder.");
}

export function resultLine(result: OfficeResult): string {
	return JSON.stringify({ file: result.file, kind: result.kind, check: result.check });
}

/**
 * True when `child` resolves (symlinks followed) to a path strictly inside `parent`.
 * The first segment of the relative path is compared with ".." exactly, so a
 * folder named "..notes" counts as inside.
 */
export function isInsideDir(child: string, parent: string): boolean {
	let rel: string;
	try {
		rel = relative(realpathSync(parent), realpathSync(child));
	} catch {
		return false;
	}
	if (rel === "" || isAbsolute(rel)) return false;
	return rel.split(sep)[0] !== "..";
}

/** Expands a leading `~` to `home`; any other relative path resolves against the working directory. */
export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return resolve(path);
}
