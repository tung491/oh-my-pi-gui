/**
 * The one pdf.js setup shared by the attachment-card thumbnails and the
 * document preview. pdf.js is imported on first use only, so nothing pays for
 * it until a PDF is shown (and the linkedom tests never load it). It runs in
 * its bundled module worker, served from the app's own origin, which the
 * renderer CSP (`worker-src 'self' blob:`) allows. The pdf.js 6 line no longer
 * compiles PDF functions with `eval`, so `script-src 'self'` holds as is, and
 * `useWasm: false` keeps it from needing `'wasm-unsafe-eval'`.
 *
 * Every open document gets a worker of its own. pdf.js caches one `PDFWorker`
 * per port, so documents sharing the library-wide default port would share a
 * worker, and one document's `destroy()` would tear it down under the others.
 * A private worker also makes a hung load recoverable: terminating it cannot
 * touch any other document. The default port is therefore never set here.
 */
import type * as PdfJsModule from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfJs = typeof PdfJsModule;
/** The parts of pdf.js the opener uses. */
export type PdfJsApi = Pick<PdfJs, "getDocument" | "PDFWorker">;

/** Upper bound on opening one document, from loading pdf.js to the parsed document. */
export const PDF_OPEN_TIMEOUT_MS = 20_000;
/** How long `destroy()` lets pdf.js release a document before its worker is terminated regardless. */
const DESTROY_GRACE_MS = 1_000;

export interface PdfDocumentHandle {
	promise: Promise<PDFDocumentProxy>;
	/** Idempotent and never rejects; works before the load resolves, which then rejects. */
	destroy(): Promise<void>;
}

let pdfJs: Promise<PdfJs> | undefined;

/** Imports pdf.js once; a failed chunk load is not cached, so the next caller retries. */
export function loadPdfJs(): Promise<PdfJs> {
	pdfJs ??= import("pdfjs-dist").catch((error: unknown) => {
		pdfJs = undefined;
		throw error;
	});
	return pdfJs;
}

/** `getDocument` options: cmaps and standard fonts come from the app's own `pdfjs/` folder. */
export function pdfDocumentOptions(
	bytes: Uint8Array,
	baseUri: string,
): {
	data: Uint8Array;
	useWasm: false;
	enableXfa: false;
	cMapUrl: string;
	cMapPacked: true;
	standardFontDataUrl: string;
} {
	return {
		data: bytes,
		useWasm: false,
		enableXfa: false,
		cMapUrl: new URL("pdfjs/cmaps/", baseUri).href,
		cMapPacked: true,
		standardFontDataUrl: new URL("pdfjs/standard_fonts/", baseUri).href,
	};
}

export interface PdfOpenerDeps {
	load(): Promise<PdfJsApi>;
	/** A fresh worker port for one document; terminated when the document is destroyed. */
	createPort(): Worker;
	/** The URL `pdfjs/` resolves against; the page's base URI by default. */
	baseUri?: () => string;
	destroyGraceMs?: number;
}

/** Resolves after `ms`, unless `cancel` is called first. */
function graceTimer(ms: number): { done: Promise<void>; cancel(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const done = new Promise<void>(resolve => {
		timer = setTimeout(resolve, ms);
	});
	return { done, cancel: () => clearTimeout(timer) };
}

export function createPdfOpener(deps: PdfOpenerDeps): {
	open(bytes: Uint8Array, options?: { timeoutMs?: number }): PdfDocumentHandle;
} {
	const baseUri = deps.baseUri ?? (() => globalThis.document.baseURI);
	const graceMs = deps.destroyGraceMs ?? DESTROY_GRACE_MS;

	return {
		open(bytes, { timeoutMs = PDF_OPEN_TIMEOUT_MS } = {}) {
			// pdf.js transfers the buffer to its worker, which would empty the caller's array.
			const data = bytes.slice();
			let destroyed = false;
			let destroying: Promise<void> | undefined;
			let port: Worker | undefined;
			let worker: PdfJsModule.PDFWorker | undefined;
			let task: PdfJsModule.PDFDocumentLoadingTask | undefined;
			const abort = Promise.withResolvers<never>();

			const loading = (async (): Promise<PDFDocumentProxy> => {
				const pdfjs = await deps.load();
				if (destroyed) throw new Error("The PDF was closed before it opened");
				port = deps.createPort();
				// A fresh port has no cached PDFWorker, so `create` builds one private to the
				// document (the constructor's typings do not admit a port).
				worker = pdfjs.PDFWorker.create({ port });
				task = pdfjs.getDocument({ ...pdfDocumentOptions(data, baseUri()), worker });
				return task.promise;
			})();

			const timer = setTimeout(() => {
				abort.reject(new Error("The PDF took too long to open"));
				void destroy();
			}, timeoutMs);

			function destroy(): Promise<void> {
				destroying ??= (async () => {
					destroyed = true;
					clearTimeout(timer);
					abort.reject(new Error("The PDF was closed"));
					if (task) {
						// destroy() waits on the worker's reply, which a hung worker never sends.
						const grace = graceTimer(graceMs);
						await Promise.race([task.destroy().catch(() => {}), grace.done]);
						grace.cancel();
					}
					// Never rejects: callers fire it from cleanups without awaiting.
					try {
						worker?.destroy();
					} catch {
						// The worker is unusable either way; the port still gets terminated.
					}
					try {
						port?.terminate();
					} catch {
						// A port that cannot be terminated is already gone.
					}
				})();
				return destroying;
			}

			const promise = Promise.race([loading, abort.promise]).finally(() => clearTimeout(timer));
			return { promise, destroy };
		},
	};
}

const defaultOpener = createPdfOpener({
	load: loadPdfJs,
	createPort: () => new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" }),
});

/** Opens a PDF on a worker of its own; destroy the handle when done. */
export function openPdfDocument(bytes: Uint8Array, options?: { timeoutMs?: number }): PdfDocumentHandle {
	return defaultOpener.open(bytes, options);
}
