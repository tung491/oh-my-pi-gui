// Where office files go, how they are named, and what counts as inside a folder.
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type OfficeKind = "docx" | "xlsx" | "pptx";

/** The one-line result every office tool reports; the GUI's output card parses it. */
export interface OfficeResult {
	file: string;
	kind: OfficeKind;
	check: string;
}

/** A sentence written for the person, in each app language. */
export interface PlainText {
	en: string;
	vi: string;
}

/** The text in the session language (`SAI_ATLAS_LANG`): Vietnamese for `vi`, else English. */
export function inLanguage(text: PlainText, lang: string): string {
	return lang === "vi" ? text.vi : text.en;
}

/**
 * A failure whose message is a fixed plain sentence, safe to show the person. `message` is
 * the English sentence; a plain string is the same sentence in every language.
 */
export class PlainError extends Error {
	readonly #text: PlainText;

	constructor(text: string | PlainText) {
		const both = typeof text === "string" ? { en: text, vi: text } : text;
		super(both.en);
		this.#text = both;
	}

	/** The sentence in the session language (`SAI_ATLAS_LANG`): Vietnamese for `vi`, else English. */
	inLanguage(lang: string): string {
		return inLanguage(this.#text, lang);
	}
}

const STOPPED: PlainText = {
	en: "I stopped before the file was made.",
	vi: "Tôi đã dừng trước khi tạo xong tệp.",
};
const TOO_MANY_NAMESAKES: PlainText = {
	en: "There are too many files with this name in the Sai ATLAS folder.",
	vi: "Thư mục Sai ATLAS đã có quá nhiều tệp trùng tên này.",
};
const FOLDER_ELSEWHERE: PlainText = {
	en: "The Sai ATLAS folder in Documents leads to another place, so I did not save the file.",
	vi: "Thư mục Sai ATLAS trong Documents dẫn đến một nơi khác, nên tôi không lưu tệp.",
};

/** Throws the plain "stopped" sentence once the tool call was cancelled. */
export function throwIfStopped(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new PlainError(STOPPED);
}

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

/** The longest prefix of whole code points that fits in `maxBytes` UTF-8 bytes. */
function truncateToBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const points = Array.from(text);
	let bytes = 0;
	let end = 0;
	for (; end < points.length; end++) {
		const size = Buffer.byteLength(points[end]);
		if (bytes + size > maxBytes) break;
		bytes += size;
	}
	return points.slice(0, end).join("");
}

/**
 * A file name without path separators, reserved characters or control characters;
 * `fallback` when nothing is left.
 */
export function safeBaseName(name: string, fallback = DEFAULT_BASE_NAME): string {
	const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "").trim();
	const capped = truncateToBytes(cleaned, MAX_BASE_NAME_BYTES).trim();
	return capped || fallback;
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
			writeAll(fd, bytes);
		} catch (error) {
			// A half-written file would keep the name and look like a finished document.
			closeSync(fd);
			unlinkSync(path);
			throw error;
		}
		closeSync(fd);
		return path;
	}
	throw new PlainError(TOO_MANY_NAMESAKES);
}

/** Writes every byte, or throws: a short write that makes no progress counts as a failure. */
function writeAll(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
		if (written <= 0) throw new Error("the file system accepted no more bytes");
		offset += written;
	}
}

/**
 * Creates Documents > Sai ATLAS and returns it. The folder must really sit inside
 * Documents: a Sai ATLAS folder that is a link to another place is refused, so files
 * never land outside the folder the person was told about.
 */
export function ensureOutputDir(env: DocumentsEnv): string {
	const dir = documentsDir(env);
	mkdirSync(dir, { recursive: true });
	if (!isInsideDir(dir, dirname(dir))) {
		throw new PlainError(FOLDER_ELSEWHERE);
	}
	return dir;
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
