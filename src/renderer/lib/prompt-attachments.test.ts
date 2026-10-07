import { describe, expect, it } from "vitest";
import { appendDocumentPaths } from "../components/layout/attach-document";
import { splitPromptAttachments } from "./prompt-attachments";

const PATHS = [
	"/home/u/Q3 report.docx",
	"/home/u/Bob's notes.docx",
	'/home/u/the "final" plan.md',
	`/home/u/Bob's "final" \\ plan.md`,
	"/home/u/back\\slash.txt",
	"/home/u/Báo cáo quý 3 — 東京 📄.pdf",
	"/home/u/it's 'quoted'.csv",
];

describe("splitPromptAttachments", () => {
	it("reads back the typed text and every appended path", () => {
		for (const text of ["", "summarize these", "line one\nline two", "ends with a blank line\n", "  padded  "]) {
			expect(splitPromptAttachments(appendDocumentPaths(text, PATHS))).toEqual({ body: text, paths: PATHS });
		}
	});

	it("reads back each path on its own", () => {
		for (const path of PATHS) {
			expect(splitPromptAttachments(appendDocumentPaths("hi", [path]))).toEqual({ body: "hi", paths: [path] });
		}
	});

	it("leaves a prompt with no appended paths unchanged", () => {
		expect(splitPromptAttachments("just text")).toEqual({ body: "just text", paths: [] });
		expect(splitPromptAttachments("")).toEqual({ body: "", paths: [] });
		expect(splitPromptAttachments("a\n\n")).toEqual({ body: "a\n\n", paths: [] });
	});

	it("takes only the trailing run of path lines", () => {
		expect(splitPromptAttachments("'/a/x.pdf'\nread this\n'/a/y.pdf'")).toEqual({
			body: "'/a/x.pdf'\nread this",
			paths: ["/a/y.pdf"],
		});
	});

	it("ignores lines that are not exactly the quoted form of an absolute path", () => {
		for (const line of [
			"'relative/x.pdf'",
			"'/a/x.pdf",
			"/a/x.pdf",
			"'/a/x.pdf' ",
			" '/a/x.pdf'",
			"''",
			`"/a/plain.pdf"`,
			`"/a/it's \\x.pdf"`,
			`"/a/it's "bare".pdf"`,
			`"/a/it's\\"`,
			"'/a/it's.pdf'",
			"'/a/tab\there.pdf'",
		]) {
			expect(splitPromptAttachments(`body\n${line}`)).toEqual({ body: `body\n${line}`, paths: [] });
		}
	});
});
