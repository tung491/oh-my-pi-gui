/**
 * The composer's attach button: one native dialog for any document. Images
 * become composer image attachments; every other file is held as a composer
 * document and named in the prompt by its quoted path at send time, which the
 * pack skills read with their own tools.
 */

import type { IpcFsReadImageResult } from "../../../shared/ipc-types";
import { isPromptSafePath, quotePromptPath } from "../../lib/prompt-attachments";
import type { ComposerDocument, ComposerImage } from "../../stores/composer";

export { isPromptSafePath, quotePromptPath };

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);

export const ATTACH_FILTERS: { name: string; extensions: string[] }[] = [
	{
		name: "Documents",
		extensions: ["md", "txt", "docx", "xlsx", "xls", "ods", "csv", "pptx", "pdf", ...IMAGE_EXTENSIONS],
	},
];

/** The last segment of a path, the name a card shows. */
function fileNameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
	const name = fileNameOf(path);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function splitAttachments(paths: readonly string[]): { images: string[]; documents: string[] } {
	const images: string[] = [];
	const documents: string[] = [];
	for (const path of paths) {
		(IMAGE_EXTENSIONS.has(extensionOf(path)) ? images : documents).push(path);
	}
	return { images, documents };
}

/** Reads an image by path into the shape `fileToImage` produces for a picked File. */
export async function readImageAttachment(
	path: string,
	readImage: (path: string) => Promise<IpcFsReadImageResult>,
): Promise<ComposerImage> {
	const result = await readImage(path);
	if (!result.ok || !result.dataUrl) throw new Error(result.error ?? `Could not read ${path}`);
	const dataUrl = result.dataUrl;
	const mimeType = result.mime ?? /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/png";
	return {
		content: { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType },
		preview: dataUrl,
		name: fileNameOf(path),
		path,
	};
}

export function toComposerDocument(path: string): ComposerDocument {
	return { path, name: fileNameOf(path) };
}

/**
 * Adds documents after the ones already attached. A path already attached, or
 * repeated in `paths`, keeps its first entry; a path that is not prompt-safe
 * (`isPromptSafePath`) is left out, so callers warn about it while the user is
 * still composing rather than at send time.
 */
export function addDocuments(current: readonly ComposerDocument[], paths: readonly string[]): ComposerDocument[] {
	const attached = new Set(current.map(document => document.path));
	const next = [...current];
	for (const path of paths) {
		if (!isPromptSafePath(path) || attached.has(path)) continue;
		attached.add(path);
		next.push(toComposerDocument(path));
	}
	return next;
}

/** Appends each path to the draft on its own line. */
export function appendDocumentPaths(text: string, documents: readonly string[]): string {
	if (documents.length === 0) return text;
	const lines = documents.map(quotePromptPath).join("\n");
	return text ? `${text}\n${lines}` : lines;
}
