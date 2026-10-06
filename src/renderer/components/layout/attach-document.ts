/**
 * The composer's attach button: one native dialog for any document. Images
 * become composer image attachments; every other file is named in the prompt
 * by its quoted path, which the pack skills read with their own tools.
 */

import type { IpcFsReadImageResult } from "../../../shared/ipc-types";
import type { ComposerImage } from "../../stores/composer";

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);

export const ATTACH_FILTERS: { name: string; extensions: string[] }[] = [
	{
		name: "Documents",
		extensions: ["md", "txt", "docx", "xlsx", "xls", "ods", "csv", "pptx", "pdf", ...IMAGE_EXTENSIONS],
	},
];

/** Wraps a file path in single quotes for a prompt line, as the pack skills expect. */
export function quotePromptPath(path: string): string {
	return `'${path}'`;
}

function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
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
	};
}

/** Appends each path to the draft on its own line. */
export function appendDocumentPaths(text: string, documents: readonly string[]): string {
	if (documents.length === 0) return text;
	const lines = documents.map(quotePromptPath).join("\n");
	return text ? `${text}\n${lines}` : lines;
}
