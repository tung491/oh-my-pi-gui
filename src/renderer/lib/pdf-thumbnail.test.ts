import { afterEach, describe, expect, it } from "vitest";
import type { IpcFsReadPdfResult } from "../../shared/ipc-types";
import {
	createPdfRasterizer,
	createPdfThumbnailLoader,
	PDF_THUMBNAIL_CACHE_LIMIT,
	type PdfRasterizerDeps,
	type PdfThumbnailSources,
	renderPdfThumbnail,
} from "./pdf-thumbnail";
import { createPdfOpener, type PdfJsApi } from "./pdfjs";

const PDF_BYTES = "%PDF-1.7";
const PDF_BASE64 = btoa(PDF_BYTES);

interface Recorder {
	sources: PdfThumbnailSources;
	reads: string[];
	rasterized: Array<{ text: string; width: number }>;
}

function recorder(read: (path: string) => Promise<IpcFsReadPdfResult> = async () => okRead()): Recorder {
	const reads: string[] = [];
	const rasterized: Array<{ text: string; width: number }> = [];
	return {
		reads,
		rasterized,
		sources: {
			readPdf: path => {
				reads.push(path);
				return read(path);
			},
			rasterize: async (bytes, width) => {
				const text = new TextDecoder().decode(bytes);
				rasterized.push({ text, width });
				return `data:image/png;base64,${rasterized.length}`;
			},
			pixelWidth: () => 372,
		},
	};
}

function okRead(): IpcFsReadPdfResult {
	return { ok: true, data: PDF_BASE64, size: PDF_BYTES.length };
}

const globals = globalThis as Record<string, unknown>;
const hadWindow = "window" in globals;
const originalWindow = globals.window;

afterEach(() => {
	if (hadWindow) globals.window = originalWindow;
	else delete globals.window;
});

describe("createPdfThumbnailLoader", () => {
	it("decodes the bridge's base64 bytes and renders at the requested pixel width", async () => {
		const { sources, rasterized } = recorder();
		const loader = createPdfThumbnailLoader(sources);

		await expect(loader.load("/docs/a.pdf")).resolves.toBe("data:image/png;base64,1");
		expect(rasterized).toEqual([{ text: PDF_BYTES, width: 372 }]);
	});

	it("serves a repeat request from the cache", async () => {
		const { sources, reads } = recorder();
		const loader = createPdfThumbnailLoader(sources);

		const first = await loader.load("/docs/a.pdf");
		const second = await loader.load("/docs/a.pdf");

		expect(second).toBe(first);
		expect(reads).toEqual(["/docs/a.pdf"]);
	});

	it("shares one in-flight render between concurrent requests for a path", async () => {
		let release: (result: IpcFsReadPdfResult) => void = () => {};
		const { sources, reads, rasterized } = recorder(
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);
		const loader = createPdfThumbnailLoader(sources);

		const first = loader.load("/docs/a.pdf");
		const second = loader.load("/docs/a.pdf");
		release(okRead());

		expect(await first).toBe(await second);
		expect(reads).toHaveLength(1);
		expect(rasterized).toHaveLength(1);
	});

	it("evicts the least recently used thumbnail past the limit", async () => {
		const { sources, reads } = recorder();
		const loader = createPdfThumbnailLoader(sources, 2);

		await loader.load("/a.pdf");
		await loader.load("/b.pdf");
		await loader.load("/a.pdf"); // a is now the most recent
		await loader.load("/c.pdf"); // evicts b
		await loader.load("/a.pdf");
		await loader.load("/b.pdf");

		expect(reads).toEqual(["/a.pdf", "/b.pdf", "/c.pdf", "/b.pdf"]);
	});

	it("runs at most the configured number of renders at once and frees a slot on failure", async () => {
		let active = 0;
		let peak = 0;
		let calls = 0;
		const releases: Array<() => void> = [];
		const loader = createPdfThumbnailLoader(
			{
				readPdf: async () => okRead(),
				rasterize: async () => {
					calls += 1;
					const call = calls;
					active += 1;
					peak = Math.max(peak, active);
					await new Promise<void>(resolve => releases.push(resolve));
					active -= 1;
					if (call === 1) throw new Error("render failed");
					return `data:image/png;base64,${call}`;
				},
				pixelWidth: () => 372,
			},
			PDF_THUMBNAIL_CACHE_LIMIT,
			2,
		);
		const flush = () => new Promise(resolve => setTimeout(resolve, 0));

		const loads = ["/a.pdf", "/b.pdf", "/c.pdf", "/d.pdf"].map(path => loader.load(path).catch(() => "failed"));
		await flush();
		expect(active).toBe(2);
		while (releases.length > 0) {
			releases.shift()?.();
			await flush();
		}

		expect(await Promise.all(loads)).toEqual([
			"failed",
			"data:image/png;base64,2",
			"data:image/png;base64,3",
			"data:image/png;base64,4",
		]);
		expect(peak).toBe(2);
	});

	it("rejects with the bridge's error and retries on the next request", async () => {
		let attempt = 0;
		const { sources, rasterized } = recorder(async () => {
			attempt += 1;
			return attempt === 1 ? { ok: false, size: 0, error: "Not a PDF file" } : okRead();
		});
		const loader = createPdfThumbnailLoader(sources);

		await expect(loader.load("/docs/a.pdf")).rejects.toThrow("Not a PDF file");
		await expect(loader.load("/docs/a.pdf")).resolves.toBe("data:image/png;base64,1");
		expect(rasterized).toHaveLength(1);
	});

	it("rejects a successful read that carries no bytes", async () => {
		const { sources, rasterized } = recorder(async () => ({ ok: true, size: 0 }));
		const loader = createPdfThumbnailLoader(sources);

		await expect(loader.load("/docs/empty.pdf")).rejects.toThrow("no data");
		expect(rasterized).toHaveLength(0);
	});

	it("does not cache a failed render", async () => {
		const reads: string[] = [];
		let fail = true;
		const loader = createPdfThumbnailLoader({
			readPdf: async path => {
				reads.push(path);
				return okRead();
			},
			rasterize: async () => {
				if (fail) throw new Error("bad page");
				return "data:image/png;base64,ok";
			},
			pixelWidth: () => 186,
		});

		await expect(loader.load("/docs/a.pdf")).rejects.toThrow("bad page");
		fail = false;
		await expect(loader.load("/docs/a.pdf")).resolves.toBe("data:image/png;base64,ok");
		expect(reads).toHaveLength(2);
	});
});

describe("renderPdfThumbnail", () => {
	it("reads through window.omp.fs.readPdf and surfaces its refusal", async () => {
		const requested: string[] = [];
		globals.window = {
			omp: {
				fs: {
					readPdf: async (path: string): Promise<IpcFsReadPdfResult> => {
						requested.push(path);
						return { ok: false, size: 0, error: "File is larger than 32 MB" };
					},
				},
			},
		};

		await expect(renderPdfThumbnail("/docs/huge.pdf")).rejects.toThrow("larger than 32 MB");
		expect(requested).toEqual(["/docs/huge.pdf"]);
	});
});

/**
 * A stand-in for pdf.js that keeps the behaviour the rasterizer depends on:
 * one PDFWorker per port, refusing a second on the same port, and a render
 * failing once its worker is gone. Documents open through the shared opener.
 */
interface FakePdfOptions {
	/** Resolves when the named document's page has been drawn; immediate by default. */
	draw?: (text: string) => Promise<void>;
	/** Whether the worker answers the document request at all. */
	answers?: (text: string) => boolean;
	/** The task's destroy(); immediate by default. */
	destroy?: () => Promise<void>;
}

interface FakePort {
	terminated: boolean;
	terminate(): void;
}

interface FakeCanvas {
	width: number;
	height: number;
	drawn: string;
	toDataURL(type: string): string;
}

function fakePdfJs(options: FakePdfOptions = {}) {
	const usedPorts = new Set<FakePort>();
	const ports: FakePort[] = [];
	class PDFWorker {
		destroyed = false;
		constructor({ port }: { port: FakePort }) {
			if (usedPorts.has(port)) throw new Error("Cannot use more than one PDFWorker per port.");
			usedPorts.add(port);
		}
		destroy() {
			this.destroyed = true;
		}
		static create(params: { port: FakePort }): PDFWorker {
			return new PDFWorker(params);
		}
	}
	function getDocument({ data, worker }: { data: Uint8Array; worker: PDFWorker }) {
		const text = new TextDecoder().decode(data);
		const page = {
			getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
			render: ({ canvas }: { canvas: FakeCanvas }) => ({
				promise: (options.draw?.(text) ?? Promise.resolve()).then(() => {
					if (worker.destroyed) throw new Error("Worker was destroyed");
					canvas.drawn = text;
				}),
			}),
		};
		const answered = options.answers?.(text) ?? true;
		return {
			promise: answered ? Promise.resolve({ getPage: async () => page }) : new Promise(() => {}),
			destroy: options.destroy ?? (async () => {}),
		};
	}
	const opener = createPdfOpener({
		// The fakes implement only the members the opener and rasterizer touch.
		load: async () => ({ getDocument, PDFWorker }) as unknown as PdfJsApi,
		createPort: () => {
			const port: FakePort = {
				terminated: false,
				terminate() {
					port.terminated = true;
				},
			};
			ports.push(port);
			return port as unknown as Worker;
		},
		baseUri: () => "file:///app/out/renderer/index.html",
		destroyGraceMs: 10,
	});
	const deps: PdfRasterizerDeps = {
		open: bytes => opener.open(bytes),
		createCanvas: () => {
			const canvas: FakeCanvas = {
				width: 0,
				height: 0,
				drawn: "",
				toDataURL: () => `data:image/png;base64,${canvas.drawn}`,
			};
			return canvas as unknown as HTMLCanvasElement;
		},
		timeoutMs: 50,
	};
	return { deps, ports };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("createPdfRasterizer", () => {
	it("renders two PDFs at once, each on a worker of its own that it ends", async () => {
		const drawn = new Map<string, () => void>();
		const { deps, ports } = fakePdfJs({
			draw: text => {
				const { promise, resolve } = Promise.withResolvers<void>();
				drawn.set(text, resolve);
				return promise;
			},
		});
		const rasterize = createPdfRasterizer(deps);

		const first = rasterize(bytesOf("first"), 186);
		const second = rasterize(bytesOf("second"), 186);
		await sleep(0);
		// The first finishes and tears down while the second is still drawing.
		drawn.get("first")?.();
		await expect(first).resolves.toBe("data:image/png;base64,first");
		// Past the first render's teardown: had they shared a worker, it would be gone now.
		await sleep(20);
		expect(ports[0]?.terminated).toBe(true);
		drawn.get("second")?.();

		await expect(second).resolves.toBe("data:image/png;base64,second");
		expect(ports).toHaveLength(2);
		await sleep(20);
		expect(ports[1]?.terminated).toBe(true);
	});

	it("settles a render whose worker never answers, ends that worker, and lets a retry succeed", async () => {
		let answer = false;
		const { deps, ports } = fakePdfJs({
			answers: () => answer,
			// pdf.js's destroy() waits for the unanswered request, so it never settles either.
			destroy: () => new Promise(() => {}),
		});
		const loader = createPdfThumbnailLoader({
			readPdf: async () => okRead(),
			rasterize: createPdfRasterizer(deps),
			pixelWidth: () => 186,
		});

		await expect(loader.load("/docs/a.pdf")).rejects.toThrow("timed out");
		await sleep(20);
		expect(ports[0]?.terminated).toBe(true);

		answer = true;
		await expect(loader.load("/docs/a.pdf")).resolves.toBe(`data:image/png;base64,${PDF_BYTES}`);
		expect(ports).toHaveLength(2);
	});

	it("returns the thumbnail without waiting for a destroy that never settles", async () => {
		const { deps, ports } = fakePdfJs({ destroy: () => new Promise(() => {}) });
		const rasterize = createPdfRasterizer(deps);

		await expect(rasterize(bytesOf("page"), 186)).resolves.toBe("data:image/png;base64,page");
		expect(ports[0]?.terminated).toBe(false);
		await sleep(20);
		expect(ports[0]?.terminated).toBe(true);
	});
});
