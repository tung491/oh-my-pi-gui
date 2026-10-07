import {
	AudioLines,
	File,
	FileArchive,
	FileCode,
	FileSpreadsheet,
	FileText,
	FileVideo,
	ImageIcon,
	type LucideIcon,
	Presentation,
} from "lucide-react";

export type FileKind =
	| "image"
	| "pdf"
	| "word"
	| "sheet"
	| "slides"
	| "audio"
	| "video"
	| "archive"
	| "text"
	| "code"
	| "file";

const EXTENSION_KINDS: ReadonlyArray<readonly [FileKind, readonly string[]]> = [
	["image", ["png", "jpg", "jpeg", "webp", "gif"]],
	["pdf", ["pdf"]],
	["word", ["doc", "docx", "odt", "rtf"]],
	["sheet", ["xls", "xlsx", "ods", "csv"]],
	["slides", ["ppt", "pptx", "odp"]],
	["audio", ["mp3", "wav", "m4a", "ogg", "flac", "opus"]],
	["video", ["mp4", "mov", "mkv", "webm"]],
	["archive", ["zip", "tar", "gz", "tgz", "7z", "rar", "xz"]],
	["text", ["md", "txt", "log"]],
	[
		"code",
		[
			"ts",
			"tsx",
			"js",
			"jsx",
			"mjs",
			"cjs",
			"py",
			"rs",
			"go",
			"java",
			"kt",
			"c",
			"h",
			"cpp",
			"hpp",
			"cs",
			"rb",
			"php",
			"swift",
			"sh",
			"bash",
			"zsh",
			"sql",
			"json",
			"yaml",
			"yml",
			"toml",
			"xml",
			"html",
			"css",
			"scss",
		],
	],
];

const KIND_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map(
	EXTENSION_KINDS.flatMap(([kind, extensions]) => extensions.map(extension => [extension, kind] as const)),
);

/** Classifies a file by its name's extension (case-insensitive); unknown or missing extensions are `file`. */
export function fileKindOf(name: string): FileKind {
	const base = name.split(/[\\/]/).pop() ?? name;
	const dot = base.lastIndexOf(".");
	// A leading dot is a hidden file's name, not an extension.
	if (dot <= 0 || dot === base.length - 1) return "file";
	return KIND_BY_EXTENSION.get(base.slice(dot + 1).toLowerCase()) ?? "file";
}

export interface FileKindStyle {
	icon: LucideIcon;
	/** CSS colour built from theme tokens, so both themes keep their contrast. */
	color: string;
	/** Drawn as an outline badge rather than a filled one. */
	outlined: boolean;
}

const FILE_KIND_STYLES: Readonly<Record<FileKind, FileKindStyle>> = {
	image: { icon: ImageIcon, color: "var(--omp-accent)", outlined: false },
	pdf: { icon: FileText, color: "var(--omp-error)", outlined: false },
	word: { icon: FileText, color: "var(--omp-brand)", outlined: false },
	sheet: { icon: FileSpreadsheet, color: "var(--omp-success)", outlined: false },
	slides: { icon: Presentation, color: "var(--omp-syntax-number)", outlined: false },
	// The themes carry no purple token; mixing the accent blue with the error red gives one in both themes.
	audio: { icon: AudioLines, color: "color-mix(in oklab, var(--omp-accent) 55%, var(--omp-error))", outlined: false },
	video: { icon: FileVideo, color: "var(--omp-info)", outlined: false },
	archive: { icon: FileArchive, color: "var(--omp-text-secondary)", outlined: true },
	text: { icon: FileText, color: "var(--omp-dim)", outlined: true },
	code: { icon: FileCode, color: "var(--omp-syntax-function)", outlined: false },
	file: { icon: File, color: "var(--omp-dim)", outlined: true },
};

export function fileKindStyle(kind: FileKind): FileKindStyle {
	return FILE_KIND_STYLES[kind];
}
