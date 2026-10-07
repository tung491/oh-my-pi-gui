import { describe, expect, it } from "vitest";
import {
	ATTACH_FILTERS,
	addDocuments,
	appendDocumentPaths,
	isPromptSafePath,
	quotePromptPath,
	readImageAttachment,
	splitAttachments,
	toComposerDocument,
} from "./attach-document";

describe("attach any document", () => {
	it("offers documents, spreadsheets, slides, PDFs and images in one filter", () => {
		expect(ATTACH_FILTERS).toEqual([
			{
				name: "Documents",
				extensions: ["md", "txt", "docx", "xlsx", "xls", "ods", "csv", "pptx", "pdf", "png", "jpg", "jpeg", "webp"],
			},
		]);
	});

	it("splits images from documents by extension, case-insensitively", () => {
		expect(splitAttachments(["/a/x.png", "/a/y.docx"])).toEqual({ images: ["/a/x.png"], documents: ["/a/y.docx"] });
		expect(splitAttachments(["/a/b.JPG", "/a/c.jpeg", "/a/d.webp", "/a/e.pdf", "/a/png"])).toEqual({
			images: ["/a/b.JPG", "/a/c.jpeg", "/a/d.webp"],
			documents: ["/a/e.pdf", "/a/png"],
		});
	});

	it("reads an image into the composer's attachment shape", async () => {
		const calls: string[] = [];
		const image = await readImageAttachment("/a/x.png", async path => {
			calls.push(path);
			return { ok: true, dataUrl: "data:image/png;base64,QUJD", mime: "image/png", size: 3 };
		});
		expect(calls).toEqual(["/a/x.png"]);
		expect(image).toEqual({
			content: { type: "image", data: "QUJD", mimeType: "image/png" },
			preview: "data:image/png;base64,QUJD",
			name: "x.png",
			path: "/a/x.png",
		});
	});

	it("rejects an image the shell could not read", async () => {
		await expect(
			readImageAttachment("/a/x.png", async () => ({
				ok: false,
				dataUrl: null,
				mime: null,
				size: 0,
				error: "too large",
			})),
		).rejects.toThrow("too large");
	});

	it("appends each document path on its own line, quoted", () => {
		expect(appendDocumentPaths("hi", ["/a/y.docx"])).toBe("hi\n'/a/y.docx'");
		expect(appendDocumentPaths("", ["/a/y.docx", "/a/z.pdf"])).toBe("'/a/y.docx'\n'/a/z.pdf'");
		expect(appendDocumentPaths("hi", [])).toBe("hi");
		expect(quotePromptPath("/a/b c.md")).toBe("'/a/b c.md'");
	});

	it("quotes a path so its own quote marks cannot end the quoting", () => {
		expect(quotePromptPath("/home/u/Bob's notes.docx")).toBe(`"/home/u/Bob's notes.docx"`);
		expect(quotePromptPath('/home/u/the "final" plan.md')).toBe(`'/home/u/the "final" plan.md'`);
		expect(quotePromptPath(`/home/u/Bob's "final" \\ plan.md`)).toBe(`"/home/u/Bob's \\"final\\" \\\\ plan.md"`);
	});

	it("refuses a path with a line break or another control character", () => {
		expect(isPromptSafePath("/home/u/Bob's notes.docx")).toBe(true);
		expect(isPromptSafePath("/home/u/notes\nx.docx")).toBe(false);
		expect(isPromptSafePath("/home/u/notes\rx.docx")).toBe(false);
		expect(isPromptSafePath("/home/u/notes\u0007x.docx")).toBe(false);
		expect(isPromptSafePath("/home/u/notes\u2028x.docx")).toBe(false);
	});

	it("names a document by the last segment of its path", () => {
		expect(toComposerDocument("/home/u/Q3 report.final.docx")).toEqual({
			path: "/home/u/Q3 report.final.docx",
			name: "Q3 report.final.docx",
		});
		expect(toComposerDocument("/home/u/Bob's notes")).toEqual({ path: "/home/u/Bob's notes", name: "Bob's notes" });
	});

	it("adds documents after the attached ones, once per path", () => {
		const current = [toComposerDocument("/a/y.docx")];
		expect(addDocuments(current, ["/a/z.pdf", "/a/y.docx", "/a/z.pdf", "/a/w.csv"])).toEqual([
			{ path: "/a/y.docx", name: "y.docx" },
			{ path: "/a/z.pdf", name: "z.pdf" },
			{ path: "/a/w.csv", name: "w.csv" },
		]);
		expect(current).toEqual([{ path: "/a/y.docx", name: "y.docx" }]);
	});

	it("leaves out a path that cannot be named on a prompt line", () => {
		expect(addDocuments([], ["/a/ok.pdf", "/a/bad\nname.pdf", "/a/bell\u0007.txt"])).toEqual([
			{ path: "/a/ok.pdf", name: "ok.pdf" },
		]);
	});
});
