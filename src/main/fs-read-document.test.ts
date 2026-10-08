import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FS_DOCUMENT_MAX_BYTES, readDocumentFile } from "./fs-read-document";

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const HTML = Buffer.from("﻿  <html><body><table><tr><td>a</td></tr></table></body></html>", "utf8");
const PDF = Buffer.from("%PDF-1.7\n%âã\n", "latin1");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "read-document-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function stamp(file: string): { size: number; mtimeMs: number } {
	const stat = statSync(file);
	return { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
}

function write(name: string, bytes: Buffer | string): string {
	const file = path.join(dir, name);
	writeFileSync(file, bytes);
	return file;
}

describe("readDocumentFile", () => {
	it("document read returns a docx as base64 with the zip signature", async () => {
		const file = write("a.docx", ZIP);
		expect(await readDocumentFile(file)).toEqual({
			ok: true,
			data: ZIP.toString("base64"),
			...stamp(file),
			resolvedPath: file,
			signature: "zip",
		});
	});

	it("document read returns a legacy xls with the ole signature", async () => {
		const file = write("a.xls", OLE);
		expect(await readDocumentFile(file)).toEqual({
			ok: true,
			data: OLE.toString("base64"),
			...stamp(file),
			resolvedPath: file,
			signature: "ole",
		});
	});

	it("document read returns an html spreadsheet export with the html signature", async () => {
		const file = write("a.xls", HTML);
		expect(await readDocumentFile(file)).toEqual({
			ok: true,
			data: HTML.toString("base64"),
			...stamp(file),
			resolvedPath: file,
			signature: "html",
		});
	});

	it("document read returns a pdf with the pdf signature", async () => {
		const file = write("a.pdf", PDF);
		expect(await readDocumentFile(file)).toEqual({
			ok: true,
			data: PDF.toString("base64"),
			...stamp(file),
			resolvedPath: file,
			signature: "pdf",
		});
	});

	it("document read rejects bytes with no known signature as unsupported", async () => {
		const png = write("a.png", PNG);
		expect(await readDocumentFile(png)).toEqual({
			ok: false,
			...stamp(png),
			resolvedPath: png,
			error: "unsupported",
		});
		const text = write("a.docx", "hello");
		expect(await readDocumentFile(text)).toEqual({
			ok: false,
			...stamp(text),
			resolvedPath: text,
			error: "unsupported",
		});
	});

	it("document read rejects a file over the size cap as too large", async () => {
		expect(FS_DOCUMENT_MAX_BYTES).toBe(32 * 1024 * 1024);
		const file = write("big.docx", Buffer.concat([ZIP, Buffer.alloc(2)]));
		expect(await readDocumentFile(file, { maxBytes: 4 })).toEqual({
			ok: false,
			size: 10,
			mtimeMs: stamp(file).mtimeMs,
			resolvedPath: file,
			error: "too-large",
		});
	});

	it("document read refuses a file that grows past the cap after it was opened", async () => {
		const file = write("growing.docx", ZIP.subarray(0, 4));
		const result = await readDocumentFile(file, {
			maxBytes: 8,
			afterOpen: () => appendFileSync(file, Buffer.alloc(16)),
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("too-large");
	});

	it("document read returns unchanged without data when the stamp matches", async () => {
		const file = write("a.docx", ZIP);
		const result = await readDocumentFile(file, { ifChanged: stamp(file) });
		expect(result).toEqual({ ok: true, unchanged: true, ...stamp(file), resolvedPath: file });
		expect("data" in result).toBe(false);
	});

	it("document read returns the bytes when the stamp is stale", async () => {
		const file = write("a.docx", ZIP);
		const current = stamp(file);
		const result = await readDocumentFile(file, { ifChanged: { size: current.size + 1, mtimeMs: current.mtimeMs } });
		expect(result).toEqual({
			ok: true,
			data: ZIP.toString("base64"),
			...current,
			resolvedPath: file,
			signature: "zip",
		});
	});

	it("document read rejects a directory as not a file", async () => {
		expect(await readDocumentFile(dir)).toEqual({
			ok: false,
			size: 0,
			mtimeMs: 0,
			resolvedPath: dir,
			error: "not-a-file",
		});
	});

	it("document read normalizes an absolute path with dot segments", async () => {
		const file = write("a.pdf", PDF);
		const dotted = `${dir}/./sub/../a.pdf`;
		expect(await readDocumentFile(dotted)).toEqual({
			ok: true,
			data: PDF.toString("base64"),
			...stamp(file),
			resolvedPath: file,
			signature: "pdf",
		});
	});

	it("document read reports a missing file as not ok", async () => {
		const result = await readDocumentFile(path.join(dir, "missing.docx"));
		expect(result.ok).toBe(false);
		expect(result.size).toBe(0);
		expect(typeof result.error).toBe("string");
	});
});
