/**
 * Reads a user-attached PDF for a local page-1 thumbnail. The path is not
 * workspace-confined: like a markdown image, the bytes only reach a local
 * render, so there is no exfil channel. The file must still start with the
 * PDF signature and fit under the size cap. Never throws.
 */
import { constants as fsConstants, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcFsReadPdfResult } from "../shared/ipc-types";

export const FS_PDF_MAX_BYTES = 32 * 1024 * 1024;

const PDF_SIGNATURE = "%PDF-";

const GROWTH_CHUNK_BYTES = 64 * 1024;

export interface ReadPdfOptions {
	/** Directory `~/` expands against (the user's home by default). */
	homeDir?: string;
	/** Size cap in bytes ({@link FS_PDF_MAX_BYTES} by default). */
	maxBytes?: number;
}

export async function readPdfFile(rawPath: unknown, options: ReadPdfOptions = {}): Promise<IpcFsReadPdfResult> {
	const fail = (error: string, size = 0): IpcFsReadPdfResult => ({ ok: false, size, error });
	if (typeof rawPath !== "string" || rawPath.length === 0) return fail("Invalid path");
	const expanded = rawPath.startsWith("~/") ? path.join(options.homeDir ?? os.homedir(), rawPath.slice(2)) : rawPath;
	if (!path.isAbsolute(expanded)) return fail("Path must be absolute");
	const abs = path.normalize(expanded);
	const maxBytes = options.maxBytes ?? FS_PDF_MAX_BYTES;
	let handle: FileHandle | undefined;
	try {
		// One handle for every check and the read: the type and size come from
		// `fstat` on it, so the path cannot be swapped between check and read.
		// Non-blocking so a named pipe cannot stall the open before `fstat`
		// rejects it; reads from a regular file ignore the flag.
		handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile()) return fail("Not a file");
		if (stat.size > maxBytes) return fail("PDF too large", stat.size);
		return await readPdfBytes(handle, stat.size, maxBytes);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Reads the signature first and stops on a non-PDF, then reads at most one
 * byte past the cap, so a file that grew after `fstat` is refused rather than
 * read whole. `size` is the `fstat` size, reported on a non-PDF.
 */
export async function readPdfBytes(handle: FileHandle, size: number, maxBytes: number): Promise<IpcFsReadPdfResult> {
	const signature = Buffer.alloc(PDF_SIGNATURE.length);
	const head = await readFully(handle, signature);
	if (head < signature.length || signature.toString("latin1") !== PDF_SIGNATURE) {
		return { ok: false, size, error: "Not a PDF" };
	}
	const chunks: Buffer[] = [signature];
	let read = signature.length;
	const cap = maxBytes + 1;
	while (read < cap) {
		// The first chunk covers the rest of the `fstat` size plus one byte, so an
		// unchanged file is read in one pass; a grown one continues in small chunks.
		const chunk = Buffer.allocUnsafe(Math.min(Math.max(size + 1 - read, GROWTH_CHUNK_BYTES), cap - read));
		const filled = await readFully(handle, chunk);
		chunks.push(chunk.subarray(0, filled));
		read += filled;
		if (filled < chunk.length) break;
	}
	if (read > maxBytes) return { ok: false, size: read, error: "PDF too large" };
	return { ok: true, data: Buffer.concat(chunks, read).toString("base64"), size: read };
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
