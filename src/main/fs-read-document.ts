/**
 * Reads a document (PDF, OOXML/ODF zip, legacy OLE spreadsheet or an HTML
 * table export) for the in-app preview. The caller resolves the path; this
 * module only reads an absolute one, normalized lexically (`.` and `..`
 * segments, as `path.normalize` does) before it is opened. The file is opened once, its type, size
 * and mtime come from `fstat` on that handle, and at most one byte past the
 * cap is read, so a file that grows after `fstat` is refused rather than read
 * whole. Images are not accepted here: they go through `fs:read-image`.
 * A read that has not settled after {@link FS_DOCUMENT_READ_TIMEOUT_MS} (a hung
 * network mount) answers `timed-out`, as the Tauri core does; the read itself
 * runs on and closes its handle when it settles. Never throws.
 */
import { constants as fsConstants, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { IpcDocumentSignature, IpcFsReadDocumentResult, IpcFsReadDocumentStamp } from "../shared/ipc-types";

export const FS_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;

/** How long a read may take before it answers `timed-out` (`DOCUMENT_READ_TIMEOUT` in the Tauri core). */
export const FS_DOCUMENT_READ_TIMEOUT_MS = 30_000;

/** Bytes handed to {@link documentSignature}. */
const SIGNATURE_WINDOW = 512;

const GROWTH_CHUNK_BYTES = 64 * 1024;

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HTML_PREFIXES = ["<!doctype html", "<html", "<table"];

export interface ReadDocumentOptions {
	/** Size cap in bytes ({@link FS_DOCUMENT_MAX_BYTES} by default). */
	maxBytes?: number;
	/** When the file still has this size and whole-ms mtime, reply `unchanged` without bytes. */
	ifChanged?: IpcFsReadDocumentStamp;
	/** Test-only hook between `fstat` and the read; production callers never pass it. */
	afterOpen?: () => void | Promise<void>;
	/** Test-only hook called once the handle is closed; production callers never pass it. */
	afterClose?: () => void;
	/** Test-only override of {@link FS_DOCUMENT_READ_TIMEOUT_MS}; production callers never pass it. */
	timeoutMs?: number;
}

/** Classifies a document by its leading bytes; `null` for anything else (images included). */
export function documentSignature(header: Buffer): IpcDocumentSignature | null {
	if (startsWith(header, PDF_MAGIC)) return "pdf";
	if (startsWith(header, ZIP_MAGIC)) return "zip";
	if (startsWith(header, OLE_MAGIC)) return "ole";
	let start = startsWith(header, UTF8_BOM) ? UTF8_BOM.length : 0;
	while (start < header.length && isAsciiWhitespace(header[start])) start++;
	const lead = header
		.subarray(start, start + HTML_PREFIXES[0].length)
		.toString("latin1")
		.toLowerCase();
	return HTML_PREFIXES.some(prefix => lead.startsWith(prefix)) ? "html" : null;
}

export async function readDocumentFile(
	input: string,
	options: ReadDocumentOptions = {},
): Promise<IpcFsReadDocumentResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<IpcFsReadDocumentResult>(resolve => {
		timer = setTimeout(
			() => resolve({ ok: false, size: 0, mtimeMs: 0, error: "timed-out" }),
			options.timeoutMs ?? FS_DOCUMENT_READ_TIMEOUT_MS,
		);
	});
	try {
		// `readNormalized` never rejects, so the losing read needs no handler.
		return await Promise.race([readNormalized(path.normalize(input), options), timedOut]);
	} finally {
		clearTimeout(timer);
	}
}

async function readNormalized(abs: string, options: ReadDocumentOptions): Promise<IpcFsReadDocumentResult> {
	let handle: FileHandle | undefined;
	try {
		// Non-blocking so a named pipe cannot stall the open before `fstat`
		// rejects it; reads from a regular file ignore the flag.
		handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile()) return { ok: false, size: 0, mtimeMs: 0, resolvedPath: abs, error: "not-a-file" };
		const mtimeMs = Math.floor(stat.mtimeMs);
		const cap = options.maxBytes ?? FS_DOCUMENT_MAX_BYTES;
		const { ifChanged } = options;
		if (ifChanged && ifChanged.size === stat.size && ifChanged.mtimeMs === mtimeMs) {
			return { ok: true, unchanged: true, size: stat.size, mtimeMs, resolvedPath: abs };
		}
		if (stat.size > cap) return { ok: false, size: stat.size, mtimeMs, resolvedPath: abs, error: "too-large" };
		await options.afterOpen?.();
		const bytes = await readBounded(handle, stat.size, cap);
		if (bytes.length > cap) return { ok: false, size: bytes.length, mtimeMs, resolvedPath: abs, error: "too-large" };
		const signature = documentSignature(bytes.subarray(0, SIGNATURE_WINDOW));
		if (!signature) return { ok: false, size: stat.size, mtimeMs, resolvedPath: abs, error: "unsupported" };
		return { ok: true, data: bytes.toString("base64"), size: bytes.length, mtimeMs, resolvedPath: abs, signature };
	} catch (err) {
		return { ok: false, size: 0, mtimeMs: 0, error: err instanceof Error ? err.message : String(err) };
	} finally {
		await handle?.close().catch(() => undefined);
		options.afterClose?.();
	}
}

/**
 * Reads until end of file or `cap + 1` bytes, whichever comes first. The
 * first chunk covers the `fstat` size plus one byte, so an unchanged file is
 * read in one pass; a grown one continues in small chunks up to the bound.
 */
async function readBounded(handle: FileHandle, size: number, cap: number): Promise<Buffer> {
	const limit = cap + 1;
	const chunks: Buffer[] = [];
	let read = 0;
	while (read < limit) {
		const chunk = Buffer.allocUnsafe(Math.min(Math.max(size + 1 - read, GROWTH_CHUNK_BYTES), limit - read));
		const filled = await readFully(handle, chunk);
		chunks.push(chunk.subarray(0, filled));
		read += filled;
		if (filled < chunk.length) break;
	}
	return Buffer.concat(chunks, read);
}

/** Fills `target` from the handle's current position; returns the byte count (short only at end of file). */
async function readFully(handle: FileHandle, target: Buffer): Promise<number> {
	let filled = 0;
	while (filled < target.length) {
		const { bytesRead } = await handle.read(target, filled, target.length - filled, null);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return filled;
}

function startsWith(bytes: Buffer, magic: Buffer): boolean {
	return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}

function isAsciiWhitespace(byte: number): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c;
}
