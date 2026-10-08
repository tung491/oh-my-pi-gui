import type { IpcDocumentSignature } from "../../../shared/ipc-types";

export type PreviewKind = "pdf" | "docx" | "pptx" | "sheet" | "csv" | "image" | "markdown" | "text" | "unsupported";

const EXTENSIONS_BY_KIND: Readonly<Record<Exclude<PreviewKind, "text">, readonly string[]>> = {
	pdf: ["pdf"],
	docx: ["docx"],
	pptx: ["pptx"],
	sheet: ["xlsx", "xls", "ods"],
	csv: ["csv"],
	image: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif"],
	markdown: ["md", "mdx"],
	unsupported: [
		"doc",
		"ppt",
		"odt",
		"odp",
		"rtf",
		"zip",
		"tar",
		"gz",
		"tgz",
		"7z",
		"rar",
		"xz",
		"mp3",
		"wav",
		"m4a",
		"ogg",
		"flac",
		"opus",
		"mp4",
		"mov",
		"mkv",
		"webm",
	],
};

const KIND_BY_EXTENSION: ReadonlyMap<string, PreviewKind> = new Map(
	Object.entries(EXTENSIONS_BY_KIND).flatMap(([kind, extensions]) =>
		extensions.map((extension): [string, PreviewKind] => [extension, kind as PreviewKind]),
	),
);

const NO_SIGNATURES: readonly IpcDocumentSignature[] = [];
const ZIP_ONLY: readonly IpcDocumentSignature[] = ["zip"];

const SIGNATURES_BY_EXTENSION: ReadonlyMap<string, readonly IpcDocumentSignature[]> = new Map([
	["docx", ZIP_ONLY],
	["pptx", ZIP_ONLY],
	["xlsx", ZIP_ONLY],
	["ods", ZIP_ONLY],
	// Real .xls files are OLE, but Excel and web apps also save OOXML or HTML tables under that name.
	["xls", ["ole", "zip", "html"] as const],
	["pdf", ["pdf"] as const],
]);

/** The lowercased text after the last `.` of the last path segment, or "" when there is none. */
function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** How the preview shows a file, decided by its extension alone. */
export function previewKindOf(path: string): PreviewKind {
	return KIND_BY_EXTENSION.get(extensionOf(path)) ?? "text";
}

/** The `fs:read-document` signatures a file with this extension may carry; empty when it is not read as bytes. */
export function expectedSignatures(path: string): readonly IpcDocumentSignature[] {
	return SIGNATURES_BY_EXTENSION.get(extensionOf(path)) ?? NO_SIGNATURES;
}
