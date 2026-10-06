import { describe, expect, it } from "vitest";
import {
	ATTACH_FILTERS,
	appendDocumentPaths,
	quotePromptPath,
	readImageAttachment,
	splitAttachments,
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
});
