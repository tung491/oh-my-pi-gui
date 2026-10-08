import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { inspectZip, ZIP_MAX_ENTRIES } from "./zip-guard";

const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_SIGNATURE = 0x06054b50;

async function zipOf(files: Record<string, string | Uint8Array>, compression: "DEFLATE" | "STORE" = "DEFLATE") {
	const zip = new JSZip();
	for (const [name, content] of Object.entries(files)) zip.file(name, content);
	return zip.generateAsync({ type: "uint8array", compression });
}

function offsetsOf(bytes: Uint8Array, signature: number): number[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const offsets: number[] = [];
	for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
		if (view.getUint32(offset, true) === signature) offsets.push(offset);
	}
	return offsets;
}

function patchU32(bytes: Uint8Array, offset: number, value: number): void {
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function patchU16(bytes: Uint8Array, offset: number, value: number): void {
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

describe("inspectZip", () => {
	it("accepts a real zip and counts every inflated byte", async () => {
		const bytes = await zipOf({ "word/document.xml": "<w:document>hello</w:document>".repeat(50), "a.txt": "b" });
		let inflated = 0;
		expect(await inspectZip(bytes, { onInflated: count => (inflated += count) })).toEqual({ ok: true });
		expect(inflated).toBe(30 * 50 + 1);
	});

	it("accepts stored entries", async () => {
		expect(await inspectZip(await zipOf({ "a.txt": "stored" }, "STORE"))).toEqual({ ok: true });
	});

	it("refuses more entries than the limit", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index <= ZIP_MAX_ENTRIES; index += 1) files[`f${index}`] = "";
		expect(await inspectZip(await zipOf(files))).toEqual({ ok: false, reason: "too-large" });
	});

	it("refuses more than the declared budget", async () => {
		const bytes = await zipOf({ a: "1", b: "2", c: "3" });
		const central = offsetsOf(bytes, CENTRAL_SIGNATURE);
		expect(central).toHaveLength(3);
		for (const offset of central) patchU32(bytes, offset + 24, 0x7fffffff);
		expect(await inspectZip(bytes)).toEqual({ ok: false, reason: "too-large" });
	});

	it("refuses an entry that inflates past its declared size after counting at most one byte past it", async () => {
		const bytes = await zipOf({ "bomb.bin": new Uint8Array(1024 * 1024) });
		const [central] = offsetsOf(bytes, CENTRAL_SIGNATURE);
		const [local] = offsetsOf(bytes, LOCAL_SIGNATURE);
		patchU32(bytes, central + 24, 1024);
		patchU32(bytes, local + 22, 1024);
		let inflated = 0;
		expect(await inspectZip(bytes, { onInflated: count => (inflated += count) })).toEqual({
			ok: false,
			reason: "too-large",
		});
		expect(inflated).toBeGreaterThan(1024);
		expect(inflated).toBeLessThanOrEqual(1025);
	});

	it("refuses ZIP64 markers", async () => {
		const bytes = await zipOf({ a: "1" });
		const [end] = offsetsOf(bytes, END_SIGNATURE);
		patchU16(bytes, end + 10, 0xffff);
		expect(await inspectZip(bytes)).toEqual({ ok: false, reason: "too-large" });
	});

	it("refuses a truncated buffer as corrupt", async () => {
		const bytes = await zipOf({ a: "1" });
		expect(await inspectZip(bytes.subarray(0, 30))).toEqual({ ok: false, reason: "corrupt" });
	});

	it("refuses an entry that inflates to less than it declares as corrupt", async () => {
		const bytes = await zipOf({ a: "hello world" });
		const [central] = offsetsOf(bytes, CENTRAL_SIGNATURE);
		patchU32(bytes, central + 24, 100);
		expect(await inspectZip(bytes)).toEqual({ ok: false, reason: "corrupt" });
	});

	it("refuses broken deflate data as corrupt", async () => {
		const bytes = await zipOf({ a: "hello world ".repeat(20) });
		const [local] = offsetsOf(bytes, LOCAL_SIGNATURE);
		const dataStart = local + 30 + new DataView(bytes.buffer).getUint16(local + 26, true);
		bytes.fill(0xff, dataStart, dataStart + 4);
		expect(await inspectZip(bytes)).toEqual({ ok: false, reason: "corrupt" });
	});

	it("refuses encrypted entries and unknown methods as corrupt", async () => {
		const encrypted = await zipOf({ a: "1" });
		patchU16(encrypted, offsetsOf(encrypted, CENTRAL_SIGNATURE)[0] + 8, 1);
		expect(await inspectZip(encrypted)).toEqual({ ok: false, reason: "corrupt" });
		const unknownMethod = await zipOf({ a: "1" });
		patchU16(unknownMethod, offsetsOf(unknownMethod, CENTRAL_SIGNATURE)[0] + 10, 12);
		expect(await inspectZip(unknownMethod)).toEqual({ ok: false, reason: "corrupt" });
	});

	it("refuses local header sizes that disagree with the central directory as corrupt", async () => {
		const descriptor = await zipOf({ a: "0123456789" }, "STORE");
		const [descriptorLocal] = offsetsOf(descriptor, LOCAL_SIGNATURE);
		patchU16(descriptor, descriptorLocal + 6, 1 << 3);
		patchU32(descriptor, descriptorLocal + 22, 0xfffffff0);
		expect(await inspectZip(descriptor)).toEqual({ ok: false, reason: "corrupt" });

		const plain = await zipOf({ a: "hello world ".repeat(20) });
		const [plainLocal] = offsetsOf(plain, LOCAL_SIGNATURE);
		patchU32(plain, plainLocal + 22, 0xfffffff0);
		expect(await inspectZip(plain)).toEqual({ ok: false, reason: "corrupt" });
	});

	it("lets the central directory govern when a data descriptor zeroes the local sizes", async () => {
		const bytes = await zipOf({ a: "0123456789" }, "STORE");
		const [local] = offsetsOf(bytes, LOCAL_SIGNATURE);
		patchU16(bytes, local + 6, 1 << 3);
		patchU32(bytes, local + 18, 0);
		patchU32(bytes, local + 22, 0);
		expect(await inspectZip(bytes)).toEqual({ ok: true });
	});

	it("refuses a central directory that points outside the buffer as corrupt", async () => {
		const bytes = await zipOf({ a: "1" });
		patchU32(bytes, offsetsOf(bytes, CENTRAL_SIGNATURE)[0] + 42, bytes.length + 10);
		expect(await inspectZip(bytes)).toEqual({ ok: false, reason: "corrupt" });
	});
});
