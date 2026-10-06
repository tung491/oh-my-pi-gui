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

/** C0/C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Whether a path can be named on a prompt line: a line break would split the
 * one-path-per-line draft, and no control character survives a model copying
 * the path back exactly.
 */
export function isPromptSafePath(path: string): boolean {
	return !CONTROL_CHARACTER.test(path);
}

/**
 * Quotes a file path for a prompt line. Single quotes, as the pack skills were
 * measured with, unless the name holds one (`Bob's notes.docx`); then double
 * quotes, escaping any double quote or backslash inside.
 */
export function quotePromptPath(path: string): string {
	if (!path.includes("'")) return `'${path}'`;
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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
