import { describe, expect, it } from "vitest";
import { type FileKind, fileKindOf, fileKindStyle } from "./file-kind";

describe("fileKindOf", () => {
	const cases: ReadonlyArray<readonly [string, FileKind]> = [
		["report.pdf", "pdf"],
		["Letter.DOCX", "word"],
		["budget.xlsx", "sheet"],
		["data.csv", "sheet"],
		["deck.pptx", "slides"],
		["voice memo.m4a", "audio"],
		["song.flac", "audio"],
		["clip.mov", "video"],
		["backup.tar.gz", "archive"],
		["bundle.7z", "archive"],
		["notes.md", "text"],
		["server.log", "text"],
		["main.rs", "code"],
		["config.yaml", "code"],
		["photo.JPEG", "image"],
		["scan.webp", "image"],
		["model.blend", "file"],
	];

	it.each(cases)("classifies %s as %s", (name, kind) => {
		expect(fileKindOf(name)).toBe(kind);
	});

	it("treats names without an extension, hidden files and trailing dots as generic files", () => {
		expect(fileKindOf("Makefile")).toBe("file");
		expect(fileKindOf(".bashrc")).toBe("file");
		expect(fileKindOf("draft.")).toBe("file");
		expect(fileKindOf("")).toBe("file");
	});

	it("looks only at the last path segment", () => {
		expect(fileKindOf("/home/me/archive.d/readme")).toBe("file");
		expect(fileKindOf("C:\\Users\\me\\minutes.docx")).toBe("word");
	});
});

describe("fileKindStyle", () => {
	it("colours every kind from theme tokens", () => {
		const kinds: FileKind[] = [
			"image",
			"pdf",
			"word",
			"sheet",
			"slides",
			"audio",
			"video",
			"archive",
			"text",
			"code",
			"file",
		];
		for (const kind of kinds) {
			expect(fileKindStyle(kind).color).toContain("var(--omp-");
		}
	});

	it("draws archives as an outlined badge", () => {
		expect(fileKindStyle("archive").outlined).toBe(true);
		expect(fileKindStyle("pdf").outlined).toBe(false);
	});
});
