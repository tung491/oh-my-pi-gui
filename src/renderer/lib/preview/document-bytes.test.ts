import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcFsReadDocumentResult } from "../../../shared/ipc-types";
import { decodeBase64, readDocumentBytes } from "./document-bytes";

function stubReadDocument(reply: IpcFsReadDocumentResult | Error) {
	const readDocument = vi.fn(async () => {
		if (reply instanceof Error) throw reply;
		return reply;
	});
	vi.stubGlobal("window", { omp: { fs: { readDocument } } });
	return readDocument;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("decodeBase64", () => {
	it("decodes to the original bytes", () => {
		expect(Array.from(decodeBase64(Buffer.from([0, 1, 254, 255]).toString("base64")))).toEqual([0, 1, 254, 255]);
	});
});

describe("readDocumentBytes", () => {
	it("passes the tab and stamp and returns the decoded bytes", async () => {
		const readDocument = stubReadDocument({
			ok: true,
			size: 3,
			mtimeMs: 7,
			resolvedPath: "/w/a.docx",
			data: Buffer.from("PK!").toString("base64"),
			signature: "zip",
		});
		const result = await readDocumentBytes("a.docx", "t1", { size: 1, mtimeMs: 2 });
		expect(readDocument).toHaveBeenCalledWith("a.docx", { tabId: "t1", ifChanged: { size: 1, mtimeMs: 2 } });
		expect(result).toEqual({
			ok: true,
			unchanged: false,
			bytes: new Uint8Array([0x50, 0x4b, 0x21]),
			signature: "zip",
			size: 3,
			mtimeMs: 7,
			resolvedPath: "/w/a.docx",
		});
	});

	it("omits a null tab and a missing stamp", async () => {
		const readDocument = stubReadDocument({ ok: true, size: 0, mtimeMs: 0, data: "", signature: "pdf" });
		await readDocumentBytes("/a.pdf", null);
		expect(readDocument).toHaveBeenCalledWith("/a.pdf", {});
	});

	it("reports an unchanged file without bytes", async () => {
		stubReadDocument({ ok: true, size: 3, mtimeMs: 7, resolvedPath: "/w/a.pdf", unchanged: true });
		expect(await readDocumentBytes("a.pdf", "t1", { size: 3, mtimeMs: 7 })).toEqual({
			ok: true,
			unchanged: true,
			size: 3,
			mtimeMs: 7,
			resolvedPath: "/w/a.pdf",
		});
	});

	it("returns the error code of a failed read", async () => {
		stubReadDocument({ ok: false, size: 0, mtimeMs: 0, error: "too-large" });
		expect(await readDocumentBytes("a.pdf", null)).toEqual({ ok: false, error: "too-large" });
	});

	it("turns a rejected call or a reply without data into a failure", async () => {
		stubReadDocument(new Error("bridge gone"));
		expect(await readDocumentBytes("a.pdf", null)).toEqual({ ok: false, error: "bridge gone" });
		stubReadDocument({ ok: true, size: 1, mtimeMs: 1 });
		expect(await readDocumentBytes("a.pdf", null)).toEqual({ ok: false, error: "failed" });
		stubReadDocument({ ok: true, size: 1, mtimeMs: 1, data: "@@not base64@@" });
		expect(await readDocumentBytes("a.pdf", null)).toEqual({ ok: false, error: "failed" });
	});
});
