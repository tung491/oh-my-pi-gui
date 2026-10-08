import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { inspectZip, ZIP_MAX_ENTRIES, ZIP_MAX_UNCOMPRESSED } from "./zip-guard";

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

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

interface StoredEntry {
	name: string;
	data: Uint8Array;
	centralExtra?: Uint8Array;
	localExtra?: Uint8Array;
}

/** A stored-only zip written byte by byte, for layouts JSZip will not produce. */
function storedZip(entries: StoredEntry[]): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const localExtra = entry.localExtra ?? new Uint8Array(0);
		const centralExtra = entry.centralExtra ?? new Uint8Array(0);
		const local = new Uint8Array(30 + name.length + localExtra.length + entry.data.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, LOCAL_SIGNATURE, true);
		localView.setUint32(18, entry.data.length, true);
		localView.setUint32(22, entry.data.length, true);
		localView.setUint16(26, name.length, true);
		localView.setUint16(28, localExtra.length, true);
		local.set(name, 30);
		local.set(localExtra, 30 + name.length);
		local.set(entry.data, 30 + name.length + localExtra.length);
		const central = new Uint8Array(46 + name.length + centralExtra.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, CENTRAL_SIGNATURE, true);
		centralView.setUint32(20, entry.data.length, true);
		centralView.setUint32(24, entry.data.length, true);
		centralView.setUint16(28, name.length, true);
		centralView.setUint16(30, centralExtra.length, true);
		centralView.setUint32(42, offset, true);
		central.set(name, 46);
		central.set(centralExtra, 46 + name.length);
		locals.push(local);
		centrals.push(central);
		offset += local.length;
	}
	const directory = concat(...centrals);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, END_SIGNATURE, true);
	endView.setUint16(8, entries.length, true);
	endView.setUint16(10, entries.length, true);
	endView.setUint32(12, directory.length, true);
	endView.setUint32(16, offset, true);
	return concat(...locals, directory, end);
}

/** A ZIP64 extended information extra field (0x0001) carrying the given sizes. */
function zip64Extra(uncompressed: number, compressed: number): Uint8Array {
	const field = new Uint8Array(20);
	const view = new DataView(field.buffer);
	view.setUint16(0, 0x0001, true);
	view.setUint16(2, 16, true);
	view.setBigUint64(4, BigInt(uncompressed), true);
	view.setBigUint64(12, BigInt(compressed), true);
	return field;
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

	it("refuses central directory records past the end record's count", async () => {
		// JSZip reads central records while the signature matches and ignores
		// the count, so a count of 1 would hide the second, large entry.
		const bytes = await zipOf({ "a.txt": "small", "word/document.xml": "x".repeat(4096) });
		const [end] = offsetsOf(bytes, END_SIGNATURE);
		patchU16(bytes, end + 8, 1);
		patchU16(bytes, end + 10, 1);
		const parsed = await JSZip.loadAsync(bytes);
		expect(await parsed.file("word/document.xml")?.async("string")).toHaveLength(4096);
		expect(await inspectZip(bytes)).toEqual({ ok: false, reason: "corrupt" });
	});

	it("refuses a central directory that ends before the end record", async () => {
		// JSZip shifts every offset by such a gap, so it would read other records than the guard.
		const bytes = await zipOf({ a: "1" });
		const [end] = offsetsOf(bytes, END_SIGNATURE);
		const gapped = concat(bytes.subarray(0, end), new Uint8Array(16), bytes.subarray(end));
		expect(await inspectZip(gapped)).toEqual({ ok: false, reason: "corrupt" });
	});

	it("refuses duplicate entry names", async () => {
		const data = new TextEncoder().encode("1");
		const bytes = storedZip([
			{ name: "word/document.xml", data },
			{ name: "word/document.xml", data },
		]);
		expect(await inspectZip(bytes)).toEqual({ ok: false, reason: "corrupt" });
		expect(
			await inspectZip(
				storedZip([
					{ name: "a", data },
					{ name: "b", data },
				]),
			),
		).toEqual({ ok: true });
	});

	it("refuses an end record signature after the one it reads", async () => {
		// SheetJS takes the last signature even when too little follows it for a full record.
		const bytes = await zipOf({ a: "1" });
		const decoy = new Uint8Array(20);
		new DataView(decoy.buffer).setUint32(0, END_SIGNATURE, true);
		expect(await inspectZip(concat(bytes, decoy))).toEqual({ ok: false, reason: "corrupt" });
	});

	it("refuses zip64 extra fields that disagree with the declared sizes", async () => {
		// SheetJS sizes its inflate buffer from a ZIP64 extra field whatever the 32-bit fields say.
		const data = new TextEncoder().encode("1");
		const huge = ZIP_MAX_UNCOMPRESSED * 16;
		expect(await inspectZip(storedZip([{ name: "a", data, centralExtra: zip64Extra(huge, 1) }]))).toEqual({
			ok: false,
			reason: "too-large",
		});
		expect(await inspectZip(storedZip([{ name: "a", data, localExtra: zip64Extra(huge, 1) }]))).toEqual({
			ok: false,
			reason: "too-large",
		});
		const truncated = zip64Extra(1, 1).subarray(0, 12);
		expect(await inspectZip(storedZip([{ name: "a", data, centralExtra: truncated }]))).toEqual({
			ok: false,
			reason: "corrupt",
		});
		expect(
			await inspectZip(
				storedZip([{ name: "a", data, centralExtra: zip64Extra(1, 1), localExtra: zip64Extra(1, 1) }]),
			),
		).toEqual({ ok: true });
	});
});
