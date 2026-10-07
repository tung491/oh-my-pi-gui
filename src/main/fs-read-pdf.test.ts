import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPdfBytes, readPdfFile } from "./fs-read-pdf";

const PDF = Buffer.from("%PDF-1.7\n%âã\n1 0 obj\n<<>>\nendobj\n", "latin1");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "read-pdf-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readPdfFile", () => {
	it("returns a PDF as base64 with its size", async () => {
		const file = path.join(dir, "report.pdf");
		writeFileSync(file, PDF);
		const result = await readPdfFile(file);
		expect(result).toEqual({ ok: true, data: PDF.toString("base64"), size: PDF.length });
	});

	it("expands a home-relative path", async () => {
		mkdirSync(path.join(dir, "Documents"));
		writeFileSync(path.join(dir, "Documents", "a b.pdf"), PDF);
		const result = await readPdfFile("~/Documents/a b.pdf", { homeDir: dir });
		expect(result.ok).toBe(true);
		expect(result.size).toBe(PDF.length);
	});

	it("rejects a relative path", async () => {
		writeFileSync(path.join(dir, "report.pdf"), PDF);
		const result = await readPdfFile("report.pdf");
		expect(result).toEqual({ ok: false, size: 0, error: "Path must be absolute" });
	});

	it("rejects a missing or empty path", async () => {
		expect(await readPdfFile("")).toEqual({ ok: false, size: 0, error: "Invalid path" });
		expect(await readPdfFile(undefined)).toEqual({ ok: false, size: 0, error: "Invalid path" });
	});

	it("rejects a file that does not start with the PDF signature", async () => {
		const file = path.join(dir, "fake.pdf");
		writeFileSync(file, "PK\u0003\u0004 not a pdf");
		const result = await readPdfFile(file);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Not a PDF");
		expect(result.data).toBeUndefined();
	});

	it("rejects a PDF over the size cap", async () => {
		const file = path.join(dir, "big.pdf");
		writeFileSync(file, PDF);
		const result = await readPdfFile(file, { maxBytes: PDF.length - 1 });
		expect(result).toEqual({ ok: false, size: PDF.length, error: "PDF too large" });
	});

	it("rejects a directory and a missing file", async () => {
		expect(await readPdfFile(dir)).toEqual({ ok: false, size: 0, error: "Not a file" });
		const missing = await readPdfFile(path.join(dir, "missing.pdf"));
		expect(missing.ok).toBe(false);
		expect(missing.error).toBeTruthy();
	});

	it("stops reading once a file grows past the size cap", async () => {
		const file = path.join(dir, "growing.pdf");
		writeFileSync(file, PDF);
		const handle = await open(file, "r");
		try {
			// The file grows after its size was checked.
			appendFileSync(file, "appended after the size check");
			const result = await readPdfBytes(handle, PDF.length, PDF.length);
			expect(result).toEqual({ ok: false, size: PDF.length + 1, error: "PDF too large" });
		} finally {
			await handle.close();
		}
	});

	it("reads a file that grew but still fits under the cap", async () => {
		const file = path.join(dir, "growing.pdf");
		writeFileSync(file, PDF);
		const handle = await open(file, "r");
		try {
			appendFileSync(file, "more");
			const result = await readPdfBytes(handle, PDF.length, PDF.length + 100);
			const whole = Buffer.concat([PDF, Buffer.from("more")]);
			expect(result).toEqual({ ok: true, data: whole.toString("base64"), size: whole.length });
		} finally {
			await handle.close();
		}
	});

	it("rejects a named pipe without blocking", async () => {
		const fifo = path.join(dir, "pipe.pdf");
		execFileSync("mkfifo", [fifo]);
		expect(await readPdfFile(fifo)).toEqual({ ok: false, size: 0, error: "Not a file" });
	});
});
