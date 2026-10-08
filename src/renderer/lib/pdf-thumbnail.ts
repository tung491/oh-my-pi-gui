/**
 * Page-1 thumbnails for PDF attachment cards. pdf.js comes from the shared
 * loader (`./pdfjs`), which imports it on first use and opens every document
 * on a worker of its own, so nothing pays for it until a PDF card mounts (and
 * the linkedom tests never load it).
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { IpcFsReadPdfResult } from "../../shared/ipc-types";
import { openPdfDocument, type PdfDocumentHandle } from "./pdfjs";
import { decodeBase64 } from "./preview/document-bytes";

/** CSS width of the card's preview area; thumbnails render at this × devicePixelRatio. */
export const PDF_THUMBNAIL_CSS_WIDTH = 186;
/** Cached thumbnails, least recently used evicted first. */
export const PDF_THUMBNAIL_CACHE_LIMIT = 32;
/** Renders running at once; each holds its own pdf.js worker and the file's bytes. */
export const PDF_THUMBNAIL_CONCURRENCY = 2;
/** Bounds the canvas for unusually tall first pages. */
const MAX_CANVAS_HEIGHT = 4096;
const RENDER_TIMEOUT_MS = 20_000;

export interface PdfThumbnailSources {
	readPdf(path: string): Promise<IpcFsReadPdfResult>;
	/** Renders page 1 of the PDF bytes at the given pixel width; resolves to an image data URL. */
	rasterize(bytes: Uint8Array, pixelWidth: number): Promise<string>;
	pixelWidth(): number;
}

export interface PdfThumbnailLoader {
	load(path: string): Promise<string>;
	clear(): void;
}

async function readPdfBytes(sources: PdfThumbnailSources, path: string): Promise<Uint8Array> {
	const result = await sources.readPdf(path);
	if (!result.ok) throw new Error(result.error ?? "The PDF could not be read");
	if (typeof result.data !== "string" || result.data.length === 0) throw new Error("The PDF read returned no data");
	return decodeBase64(result.data);
}

/**
 * Caches one thumbnail per path (bounded LRU) and shares the in-flight render
 * between cards showing the same file. Failures are not cached, so a later
 * mount retries. At most `concurrency` renders run at once, so dropping many
 * PDFs does not start a worker per file; a queued render's timeout only starts
 * once it runs.
 */
export function createPdfThumbnailLoader(
	sources: PdfThumbnailSources,
	limit = PDF_THUMBNAIL_CACHE_LIMIT,
	concurrency = PDF_THUMBNAIL_CONCURRENCY,
): PdfThumbnailLoader {
	const cache = new Map<string, string>();
	const pending = new Map<string, Promise<string>>();
	const waiting: (() => void)[] = [];
	let running = 0;

	async function withSlot<T>(work: () => Promise<T>): Promise<T> {
		if (running >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
		else running += 1;
		try {
			return await work();
		} finally {
			// Hand the slot straight to the next waiter, or give it back.
			const next = waiting.shift();
			if (next) next();
			else running -= 1;
		}
	}

	function remember(path: string, url: string): void {
		cache.delete(path);
		cache.set(path, url);
		while (cache.size > limit) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	return {
		load(path) {
			const cached = cache.get(path);
			if (cached !== undefined) {
				remember(path, cached);
				return Promise.resolve(cached);
			}
			const inFlight = pending.get(path);
			if (inFlight) return inFlight;
			const render = withSlot(async () => {
				const bytes = await readPdfBytes(sources, path);
				return sources.rasterize(bytes, sources.pixelWidth());
			});
			const tracked = render.then(
				url => {
					pending.delete(path);
					remember(path, url);
					return url;
				},
				(error: unknown) => {
					pending.delete(path);
					throw error;
				},
			);
			pending.set(path, tracked);
			return tracked;
		},
		clear() {
			cache.clear();
			pending.clear();
		},
	};
}

/** What a render needs: the shared document opener and a canvas to draw into. */
export interface PdfRasterizerDeps {
	/** Opens the bytes on a worker private to this render; the handle ends it. */
	open(bytes: Uint8Array): PdfDocumentHandle;
	createCanvas(): HTMLCanvasElement;
	/** Upper bound on one render, from opening the document to the PNG. */
	timeoutMs?: number;
}

async function drawFirstPage(
	loading: Promise<PDFDocumentProxy>,
	pixelWidth: number,
	createCanvas: () => HTMLCanvasElement,
): Promise<string> {
	const document = await loading;
	const page = await document.getPage(1);
	const natural = page.getViewport({ scale: 1 });
	if (natural.width <= 0 || natural.height <= 0) throw new Error("The PDF's first page has no size");
	const scale = Math.min(pixelWidth / natural.width, MAX_CANVAS_HEIGHT / natural.height);
	const viewport = page.getViewport({ scale });
	const canvas = createCanvas();
	canvas.width = Math.max(1, Math.ceil(viewport.width));
	canvas.height = Math.max(1, Math.ceil(viewport.height));
	await page.render({ canvas, viewport }).promise;
	const url = canvas.toDataURL("image/png");
	// Release the bitmap now rather than when the GC gets to it.
	canvas.width = 0;
	canvas.height = 0;
	return url;
}

/**
 * Builds the page-1 rasterizer. Every render settles within `timeoutMs`: a
 * worker that never starts or never answers leaves pdf.js waiting forever, and
 * the card falls back to its icon instead. Teardown never blocks the result:
 * the handle's `destroy()` bounds pdf.js's own release and then terminates the
 * render's worker regardless.
 */
export function createPdfRasterizer(deps: PdfRasterizerDeps): PdfThumbnailSources["rasterize"] {
	const timeoutMs = deps.timeoutMs ?? RENDER_TIMEOUT_MS;
	return async (bytes, pixelWidth) => {
		const handle = deps.open(bytes);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("The PDF preview timed out")), timeoutMs);
			});
			const drawing = drawFirstPage(handle.promise, pixelWidth, deps.createCanvas);
			// Tearing the document down after a timeout rejects the draw; that outcome is already reported.
			drawing.catch(() => {});
			return await Promise.race([drawing, timeout]);
		} finally {
			clearTimeout(timer);
			void handle.destroy();
		}
	};
}

const rasterizeFirstPage = createPdfRasterizer({
	open: bytes => openPdfDocument(bytes),
	createCanvas: () => globalThis.document.createElement("canvas"),
});

const defaultLoader = createPdfThumbnailLoader({
	readPdf: path => window.omp.fs.readPdf(path),
	rasterize: rasterizeFirstPage,
	pixelWidth: () => Math.round(PDF_THUMBNAIL_CSS_WIDTH * Math.max(1, globalThis.devicePixelRatio || 1)),
});

/** A PNG data URL of page 1 of the PDF at `path`, read through the shell bridge. */
export function renderPdfThumbnail(path: string): Promise<string> {
	return defaultLoader.load(path);
}
