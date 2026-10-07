/**
 * Page-1 thumbnails for PDF attachment cards. pdf.js is imported on first use
 * only, so nothing pays for it until a PDF card mounts (and the linkedom tests
 * never load it). It runs in its bundled module worker, served from the app's
 * own origin, which the renderer CSP (`worker-src 'self' blob:`) allows. The
 * pdf.js 6 line no longer compiles PDF functions with `eval`, so the old
 * `isEvalSupported: false` switch is gone and `script-src 'self'` holds as is.
 */
import type * as PdfJsModule from "pdfjs-dist";
import type { IpcFsReadPdfResult } from "../../shared/ipc-types";

/** CSS width of the card's preview area; thumbnails render at this × devicePixelRatio. */
export const PDF_THUMBNAIL_CSS_WIDTH = 186;
/** Cached thumbnails, least recently used evicted first. */
export const PDF_THUMBNAIL_CACHE_LIMIT = 32;
/** Renders running at once; each holds its own pdf.js worker and the file's bytes. */
export const PDF_THUMBNAIL_CONCURRENCY = 2;
/** Bounds the canvas for unusually tall first pages. */
const MAX_CANVAS_HEIGHT = 4096;
const RENDER_TIMEOUT_MS = 20_000;
const DESTROY_GRACE_MS = 1_000;

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

function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
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

/**
 * The parts of pdf.js a render uses. Each render runs on a worker of its own:
 * pdf.js caches one `PDFWorker` per port, so renders sharing the global port
 * share a worker, and one render's `destroy()` tears it down under the others.
 * A private worker also makes a hung render recoverable, since terminating it
 * cannot touch any other render.
 */
export interface PdfRasterizerDeps {
	loadPdfJs(): Promise<Pick<PdfJs, "getDocument" | "PDFWorker">>;
	/** A fresh worker port for one render; terminated when the render ends. */
	createWorkerPort(): Worker;
	createCanvas(): HTMLCanvasElement;
	/** Upper bound on one render, from opening the document to the PNG. */
	timeoutMs?: number;
	/** How long a finished render lets pdf.js release the document before its worker is terminated. */
	destroyGraceMs?: number;
}

type PdfJs = typeof PdfJsModule;

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function drawFirstPage(
	task: PdfJsModule.PDFDocumentLoadingTask,
	pixelWidth: number,
	createCanvas: () => HTMLCanvasElement,
): Promise<string> {
	const document = await task.promise;
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
 * `destroy()` waits on the worker's reply, so it gets `destroyGraceMs` before
 * the render's own worker is terminated regardless.
 */
export function createPdfRasterizer(deps: PdfRasterizerDeps): PdfThumbnailSources["rasterize"] {
	const timeoutMs = deps.timeoutMs ?? RENDER_TIMEOUT_MS;
	const destroyGraceMs = deps.destroyGraceMs ?? DESTROY_GRACE_MS;
	return async (bytes, pixelWidth) => {
		const pdfjs = await deps.loadPdfJs();
		const port = deps.createWorkerPort();
		let worker: PdfJsModule.PDFWorker | undefined;
		let task: PdfJsModule.PDFDocumentLoadingTask | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// A fresh port has no cached PDFWorker, so this one is private to the render.
			worker = pdfjs.PDFWorker.create({ port });
			task = pdfjs.getDocument({ data: bytes, worker, useWasm: false, enableXfa: false });
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("The PDF preview timed out")), timeoutMs);
			});
			const drawing = drawFirstPage(task, pixelWidth, deps.createCanvas);
			// Tearing the task down after a timeout rejects the draw; that outcome is already reported.
			drawing.catch(() => {});
			return await Promise.race([drawing, timeout]);
		} finally {
			clearTimeout(timer);
			void release(task, worker, port, destroyGraceMs);
		}
	};
}

/** Lets pdf.js release the document for a bounded time, then ends the render's worker. */
async function release(
	task: PdfJsModule.PDFDocumentLoadingTask | undefined,
	worker: PdfJsModule.PDFWorker | undefined,
	port: Worker,
	graceMs: number,
): Promise<void> {
	if (task) {
		const destroyed = task.destroy().catch(() => {});
		await Promise.race([destroyed, delay(graceMs)]);
	}
	try {
		worker?.destroy();
	} finally {
		port.terminate();
	}
}

let pdfJs: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
	pdfJs ??= import("pdfjs-dist").catch((error: unknown) => {
		// Let the next card retry instead of caching a failed chunk load.
		pdfJs = undefined;
		throw error;
	});
	return pdfJs;
}

const rasterizeFirstPage = createPdfRasterizer({
	loadPdfJs,
	createWorkerPort: () =>
		new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" }),
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
