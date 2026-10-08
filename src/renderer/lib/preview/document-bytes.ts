import type { IpcDocumentSignature, IpcFsReadDocumentStamp } from "../../../shared/ipc-types";

export type DocumentBytesResult =
	| { ok: true; unchanged: true; size: number; mtimeMs: number; resolvedPath: string | null }
	| {
			ok: true;
			unchanged: false;
			bytes: Uint8Array;
			signature: IpcDocumentSignature | null;
			size: number;
			mtimeMs: number;
			resolvedPath: string | null;
	  }
	| { ok: false; error: string };

/** Decodes a base64 string into bytes. Throws on malformed input, as `atob` does. */
export function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/**
 * Reads a document's bytes through `fs:read-document`, resolved against the
 * given tab. With `ifChanged`, an unchanged file comes back without bytes.
 * Never rejects: a failed call or malformed reply becomes `{ ok: false }`.
 */
export async function readDocumentBytes(
	path: string,
	tabId: string | null,
	ifChanged?: IpcFsReadDocumentStamp,
): Promise<DocumentBytesResult> {
	let result: Awaited<ReturnType<typeof window.omp.fs.readDocument>>;
	try {
		result = await window.omp.fs.readDocument(path, {
			...(tabId ? { tabId } : {}),
			...(ifChanged ? { ifChanged } : {}),
		});
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const resolvedPath = typeof result.resolvedPath === "string" ? result.resolvedPath : null;
	if (!result.ok) return { ok: false, error: result.error ?? "failed" };
	if (result.unchanged === true) {
		return { ok: true, unchanged: true, size: result.size, mtimeMs: result.mtimeMs, resolvedPath };
	}
	if (typeof result.data !== "string") return { ok: false, error: "failed" };
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(result.data);
	} catch {
		return { ok: false, error: "failed" };
	}
	return {
		ok: true,
		unchanged: false,
		bytes,
		signature: result.signature ?? null,
		size: result.size,
		mtimeMs: result.mtimeMs,
		resolvedPath,
	};
}
