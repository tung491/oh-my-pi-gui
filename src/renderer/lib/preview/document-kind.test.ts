import { describe, expect, it } from "vitest";
import { expectedSignatures, type PreviewKind, previewKindOf } from "./document-kind";

describe("previewKindOf", () => {
	it.each<[string, PreviewKind]>([
		["report.docx", "docx"],
		["deck.pptx", "pptx"],
		["book.xlsx", "sheet"],
		["legacy.xls", "sheet"],
		["calc.ods", "sheet"],
		["table.csv", "csv"],
		["paper.pdf", "pdf"],
		["a.png", "image"],
		["a.jpg", "image"],
		["a.jpeg", "image"],
		["a.webp", "image"],
		["a.gif", "image"],
		["a.svg", "image"],
		["a.bmp", "image"],
		["a.avif", "image"],
		["README.md", "markdown"],
		["page.mdx", "markdown"],
		["src/index.ts", "text"],
		["Makefile", "text"],
		["old.doc", "unsupported"],
		["old.ppt", "unsupported"],
		["text.odt", "unsupported"],
		["show.odp", "unsupported"],
		["notes.rtf", "unsupported"],
		["bundle.zip", "unsupported"],
		["bundle.tar", "unsupported"],
		["bundle.gz", "unsupported"],
		["bundle.tgz", "unsupported"],
		["bundle.7z", "unsupported"],
		["bundle.rar", "unsupported"],
		["bundle.xz", "unsupported"],
		["song.mp3", "unsupported"],
		["song.wav", "unsupported"],
		["song.m4a", "unsupported"],
		["song.ogg", "unsupported"],
		["song.flac", "unsupported"],
		["song.opus", "unsupported"],
		["clip.mp4", "unsupported"],
		["clip.mov", "unsupported"],
		["clip.mkv", "unsupported"],
		["clip.webm", "unsupported"],
	])("maps %s to %s", (path, kind) => {
		expect(previewKindOf(path)).toBe(kind);
	});

	it.each<[string, PreviewKind]>([
		["REPORT.DOCX", "docx"],
		["Deck.PpTx", "pptx"],
		["/abs/Photo.JPG", "image"],
		["Notes.MD", "markdown"],
		["CLIP.MP4", "unsupported"],
	])("is case-insensitive: %s is %s", (path, kind) => {
		expect(previewKindOf(path)).toBe(kind);
	});

	it.each<[string, PreviewKind]>([
		["docs.v2/README", "text"],
		[".bashrc", "text"],
		["dir.pdf/notes", "text"],
		["archive.tar.gz", "unsupported"],
		["trailing.", "text"],
	])("takes the extension after the last slash: %s is %s", (path, kind) => {
		expect(previewKindOf(path)).toBe(kind);
	});
});

describe("expectedSignatures", () => {
	it.each<[string, readonly string[]]>([
		["a.docx", ["zip"]],
		["a.pptx", ["zip"]],
		["a.xlsx", ["zip"]],
		["a.ods", ["zip"]],
		["a.xls", ["ole", "zip", "html"]],
		["A.XLS", ["ole", "zip", "html"]],
		["a.pdf", ["pdf"]],
		["a.png", []],
		["a.md", []],
		["a.csv", []],
		["a.ts", []],
		["a.zip", []],
	])("expects %s to carry %j", (path, signatures) => {
		expect(expectedSignatures(path)).toEqual(signatures);
	});
});
