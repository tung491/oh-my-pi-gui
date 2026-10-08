/**
 * Refuses zip bombs before a ZIP-based renderer (docx, pptx, sheets) inflates
 * anything. Declared sizes are written by whoever made the file, so each entry
 * is inflated here and its real output counted, stopping one byte past what it
 * declares. Once every entry's real size equals its declared size and the
 * declared total fits the budget, the renderer's own inflate is bounded too.
 *
 * That holds only while the renderers read the same entries as this guard, so
 * every layout on which they could read others is refused:
 * - JSZip (docx-preview, the pptx renderer) reads central records for as long
 *   as their signature matches, whatever the end record's count says, and
 *   shifts every offset when the directory ends before the end record. So the
 *   directory must end exactly at the end record and hold exactly `count`
 *   records.
 * - SheetJS reads `count` records from the directory offset without checking
 *   their signatures, takes the last end-record signature in the buffer even
 *   when too few bytes follow it, and sizes its inflate from a ZIP64 extra
 *   field (0x0001) in the central or local header over the 32-bit sizes. So
 *   the end record must be the last signature, and a ZIP64 extra field must
 *   repeat the declared sizes (or leave them zero, which SheetJS ignores).
 * - Duplicate names are refused, so no reader can pick a different copy.
 */

export const ZIP_MAX_ENTRIES = 5000;
export const ZIP_MAX_UNCOMPRESSED = 64 * 1024 * 1024;

export type ZipInspection = { ok: true } | { ok: false; reason: "too-large" | "corrupt" };

export interface ZipInspectHooks {
	/** Called with each run of inflated bytes counted against an entry's limit (tests only). */
	onInflated?(bytes: number): void;
}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const END_SIGNATURE_SIZE = 4;
const CENTRAL_RECORD_SIZE = 46;
const LOCAL_RECORD_SIZE = 30;
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 1;
const FLAG_DATA_DESCRIPTOR = 1 << 3;
const ZIP64_EXTRA_ID = 0x0001;
/** Bytes SheetJS reads from a ZIP64 extra field: the uncompressed, then the compressed size. */
const ZIP64_EXTRA_SIZES = 16;
const EXTRA_HEADER_SIZE = 4;
/** Compressed bytes handed to the inflater per write, which bounds the output produced past a limit. */
const INFLATE_INPUT_SLICE = 4096;

const TOO_LARGE: ZipInspection = { ok: false, reason: "too-large" };
const CORRUPT: ZipInspection = { ok: false, reason: "corrupt" };

interface ZipEntry {
	method: number;
	compressedSize: number;
	declaredSize: number;
	localOffset: number;
}

class CorruptZipError extends Error {}
class TooLargeZipError extends Error {}

/** Little-endian reads that throw {@link CorruptZipError} instead of reading out of bounds. */
class Reader {
	#view: DataView;

	constructor(bytes: Uint8Array) {
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	get length(): number {
		return this.#view.byteLength;
	}

	u16(offset: number): number {
		this.#check(offset, 2);
		return this.#view.getUint16(offset, true);
	}

	u32(offset: number): number {
		this.#check(offset, 4);
		return this.#view.getUint32(offset, true);
	}

	/** An unsigned 64-bit value; above 2^53 it loses precision, which only matters for equality with 32-bit sizes. */
	u64(offset: number): number {
		return this.u32(offset + 4) * 2 ** 32 + this.u32(offset);
	}

	/** The bytes as a latin1 string, one character per byte. */
	latin1(offset: number, length: number): string {
		this.#check(offset, length);
		let text = "";
		for (let index = 0; index < length; index += 1) text += String.fromCharCode(this.#view.getUint8(offset + index));
		return text;
	}

	#check(offset: number, size: number): void {
		if (!Number.isInteger(offset) || offset < 0 || offset + size > this.#view.byteLength) throw new CorruptZipError();
	}
}

/**
 * The last end-record signature in the buffer, as JSZip and SheetJS find it;
 * `null` when there is none in reach of a comment or too few bytes follow it
 * for a whole record.
 */
function findEndRecord(reader: Reader): number | null {
	const last = reader.length - END_SIGNATURE_SIZE;
	const first = Math.max(0, reader.length - END_RECORD_SIZE - MAX_COMMENT_SIZE);
	for (let offset = last; offset >= first; offset -= 1) {
		if (reader.u32(offset) === END_SIGNATURE) return offset <= reader.length - END_RECORD_SIZE ? offset : null;
	}
	return null;
}

/**
 * Walks extra fields the way SheetJS does and refuses a ZIP64 field (0x0001)
 * whose sizes differ from the declared ones; a zero size is one SheetJS
 * ignores. A ZIP64 field too short to hold both sizes is corrupt.
 */
function checkZip64Extra(reader: Reader, start: number, length: number, entry: ZipEntry): void {
	const end = start + length;
	for (let offset = start; offset + EXTRA_HEADER_SIZE <= end; ) {
		const id = reader.u16(offset);
		const size = reader.u16(offset + 2);
		const data = offset + EXTRA_HEADER_SIZE;
		if (id === ZIP64_EXTRA_ID) {
			if (size < ZIP64_EXTRA_SIZES || data + ZIP64_EXTRA_SIZES > end) throw new CorruptZipError();
			const uncompressed = reader.u64(data);
			const compressed = reader.u64(data + 8);
			if (uncompressed !== 0 && uncompressed !== entry.declaredSize) throw new TooLargeZipError();
			if (compressed !== 0 && compressed !== entry.compressedSize) throw new TooLargeZipError();
		}
		offset = data + size;
	}
}

/** Reads the central directory; returns a refusal instead when its header alone decides it. */
function readEntries(reader: Reader): ZipEntry[] | ZipInspection {
	const end = findEndRecord(reader);
	if (end === null) return CORRUPT;
	const count = reader.u16(end + 10);
	const directorySize = reader.u32(end + 12);
	const directoryOffset = reader.u32(end + 16);
	if (count === ZIP64_U16 || directorySize === ZIP64_U32 || directoryOffset === ZIP64_U32) return TOO_LARGE;
	if (count > ZIP_MAX_ENTRIES) return TOO_LARGE;
	// Anything between the directory and the end record (or prepended data,
	// which looks the same) makes JSZip shift every offset.
	const directoryEnd = directoryOffset + directorySize;
	if (directoryEnd !== end) return CORRUPT;

	const entries: ZipEntry[] = [];
	const names = new Set<string>();
	let declaredTotal = 0;
	let offset = directoryOffset;
	for (let index = 0; index < count; index += 1) {
		if (offset + CENTRAL_RECORD_SIZE > directoryEnd || reader.u32(offset) !== CENTRAL_SIGNATURE) return CORRUPT;
		const flags = reader.u16(offset + 8);
		const method = reader.u16(offset + 10);
		const compressedSize = reader.u32(offset + 20);
		const declaredSize = reader.u32(offset + 24);
		const localOffset = reader.u32(offset + 42);
		if (compressedSize === ZIP64_U32 || declaredSize === ZIP64_U32 || localOffset === ZIP64_U32) return TOO_LARGE;
		declaredTotal += declaredSize;
		if (declaredTotal > ZIP_MAX_UNCOMPRESSED) return TOO_LARGE;
		if ((flags & FLAG_ENCRYPTED) !== 0) return CORRUPT;
		if (method !== METHOD_STORED && method !== METHOD_DEFLATED) return CORRUPT;
		const nameLength = reader.u16(offset + 28);
		const extraLength = reader.u16(offset + 30);
		const name = reader.latin1(offset + CENTRAL_RECORD_SIZE, nameLength);
		if (names.has(name)) return CORRUPT;
		names.add(name);
		const entry = { method, compressedSize, declaredSize, localOffset };
		checkZip64Extra(reader, offset + CENTRAL_RECORD_SIZE + nameLength, extraLength, entry);
		entries.push(entry);
		offset += CENTRAL_RECORD_SIZE + nameLength + extraLength + reader.u16(offset + 32);
	}
	// Exactly `count` records fill the directory: JSZip would read any record after them.
	if (offset !== directoryEnd) return CORRUPT;
	return entries;
}

function entryData(bytes: Uint8Array, reader: Reader, entry: ZipEntry): Uint8Array {
	const local = entry.localOffset;
	if (reader.u32(local) !== LOCAL_SIGNATURE) throw new CorruptZipError();
	// Readers such as SheetJS size their inflate from the local header, so it must
	// agree with the central directory. With a data descriptor (bit 3) the local
	// sizes may be zero, and then the central directory governs.
	const localCompressed = reader.u32(local + 18);
	const localDeclared = reader.u32(local + 22);
	const matches = localCompressed === entry.compressedSize && localDeclared === entry.declaredSize;
	const deferred =
		(reader.u16(local + 6) & FLAG_DATA_DESCRIPTOR) !== 0 && localCompressed === 0 && localDeclared === 0;
	if (!matches && !deferred) throw new CorruptZipError();
	const extraStart = local + LOCAL_RECORD_SIZE + reader.u16(local + 26);
	const extraLength = reader.u16(local + 28);
	checkZip64Extra(reader, extraStart, extraLength, entry);
	const start = extraStart + extraLength;
	const end = start + entry.compressedSize;
	if (end > bytes.length) throw new CorruptZipError();
	return bytes.subarray(start, end);
}

/**
 * Inflates `data` (raw deflate) and counts its output, stopping one byte past
 * `limit`. Returns the counted length, which is `limit + 1` when the entry
 * inflates past it. A deflate error throws {@link CorruptZipError}.
 */
async function countInflated(data: Uint8Array, limit: number, hooks: ZipInspectHooks): Promise<number> {
	const stream = new DecompressionStream("deflate-raw");
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	const feeding = (async () => {
		for (let offset = 0; offset < data.length; offset += INFLATE_INPUT_SLICE) {
			await writer.ready;
			await writer.write(data.slice(offset, offset + INFLATE_INPUT_SLICE));
		}
		await writer.close();
	})();
	// The reader reports a failed feed through its own rejection; this keeps the feed's rejection handled.
	feeding.catch(() => {});

	let counted = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.byteLength, limit + 1 - counted);
			counted += take;
			hooks.onInflated?.(take);
			if (counted > limit) {
				await reader.cancel().catch(() => {});
				await writer.abort().catch(() => {});
				return counted;
			}
		}
		await feeding;
	} catch {
		await writer.abort().catch(() => {});
		throw new CorruptZipError();
	}
	return counted;
}

/**
 * Checks a ZIP's entry count, declared sizes and real inflated sizes against
 * {@link ZIP_MAX_ENTRIES} and {@link ZIP_MAX_UNCOMPRESSED}. ZIP64 archives are
 * refused as too large; a malformed, encrypted or truncated archive, or one
 * the renderers could read differently (see the header), is corrupt.
 */
export async function inspectZip(bytes: Uint8Array, hooks: ZipInspectHooks = {}): Promise<ZipInspection> {
	const reader = new Reader(bytes);
	try {
		const entries = readEntries(reader);
		if (!Array.isArray(entries)) return entries;
		let total = 0;
		for (const entry of entries) {
			const data = entryData(bytes, reader, entry);
			if (entry.method === METHOD_STORED) {
				if (data.length !== entry.declaredSize) return CORRUPT;
				hooks.onInflated?.(data.length);
				total += data.length;
				continue;
			}
			const limit = Math.min(entry.declaredSize, ZIP_MAX_UNCOMPRESSED - total);
			const counted = await countInflated(data, limit, hooks);
			if (counted > limit) return TOO_LARGE;
			if (counted < entry.declaredSize) return CORRUPT;
			total += counted;
		}
		return { ok: true };
	} catch (error) {
		if (error instanceof CorruptZipError) return CORRUPT;
		if (error instanceof TooLargeZipError) return TOO_LARGE;
		throw error;
	}
}
