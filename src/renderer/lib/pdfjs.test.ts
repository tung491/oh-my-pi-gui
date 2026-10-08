import { afterEach, describe, expect, it, vi } from "vitest";
import { createPdfOpener, PDF_OPEN_TIMEOUT_MS, type PdfJsApi, pdfDocumentOptions } from "./pdfjs";

describe("pdfDocumentOptions", () => {
	it("self-hosts cmaps and fonts beside the page and keeps wasm and XFA off", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(pdfDocumentOptions(bytes, "file:///app/out/renderer/index.html")).toEqual({
			data: bytes,
			useWasm: false,
			enableXfa: false,
			cMapUrl: "file:///app/out/renderer/pdfjs/cmaps/",
			cMapPacked: true,
			standardFontDataUrl: "file:///app/out/renderer/pdfjs/standard_fonts/",
		});
	});

	it("resolves against the Tauri origin", () => {
		const options = pdfDocumentOptions(new Uint8Array(), "tauri://localhost/");
		expect(options.cMapUrl).toBe("tauri://localhost/pdfjs/cmaps/");
		expect(options.standardFontDataUrl).toBe("tauri://localhost/pdfjs/standard_fonts/");
	});
});

interface FakePort {
	terminate: ReturnType<typeof vi.fn>;
}

interface FakeTask {
	params: { data: Uint8Array; worker: FakeWorker; cMapUrl: string };
	promise: Promise<unknown>;
	resolve(value: unknown): void;
	destroy: ReturnType<typeof vi.fn>;
}

class FakeWorker {
	static created: FakeWorker[] = [];
	readonly port: FakePort;
	destroy = vi.fn();
	constructor({ port }: { port: FakePort }) {
		this.port = port;
		FakeWorker.created.push(this);
	}
	/** pdf.js returns the port's cached worker; every port here is fresh. */
	static create(params: { port: FakePort }): FakeWorker {
		return FakeWorker.created.find(worker => worker.port === params.port) ?? new FakeWorker(params);
	}
}

function fakePdfJs() {
	const tasks: FakeTask[] = [];
	const ports: FakePort[] = [];
	FakeWorker.created = [];
	const api = {
		PDFWorker: FakeWorker,
		getDocument(params: FakeTask["params"]) {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const task: FakeTask = { params, promise, resolve, destroy: vi.fn(async () => {}) };
			tasks.push(task);
			return task;
		},
	};
	const opener = createPdfOpener({
		// The fake implements only the members the opener touches.
		load: async () => api as unknown as PdfJsApi,
		createPort: () => {
			const port: FakePort = { terminate: vi.fn() };
			ports.push(port);
			return port as unknown as Worker;
		},
		baseUri: () => "file:///app/out/renderer/index.html",
	});
	return { opener, tasks, ports, workers: () => FakeWorker.created };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
	vi.useRealTimers();
});

describe("createPdfOpener", () => {
	it("rejects a load that never resolves after the timeout and tears it all down once", async () => {
		vi.useFakeTimers();
		const { opener, tasks, ports, workers } = fakePdfJs();
		const handle = opener.open(new Uint8Array([1]));
		const outcome = handle.promise.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		await flush();
		expect(tasks).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(PDF_OPEN_TIMEOUT_MS);

		expect(await outcome).toMatch(/too long/);
		await handle.destroy();
		expect(tasks[0]?.destroy).toHaveBeenCalledTimes(1);
		expect(workers()[0]?.destroy).toHaveBeenCalledTimes(1);
		expect(ports[0]?.terminate).toHaveBeenCalledTimes(1);
	});

	it("gives each document its own port and worker, so destroying one leaves the other alone", async () => {
		vi.useFakeTimers();
		const { opener, tasks, ports, workers } = fakePdfJs();
		const first = opener.open(new Uint8Array([1]));
		const second = opener.open(new Uint8Array([2]));
		first.promise.catch(() => {});
		await flush();

		expect(ports).toHaveLength(2);
		expect(workers()).toHaveLength(2);
		expect(workers()[0]?.port).toBe(ports[0]);
		expect(workers()[1]?.port).toBe(ports[1]);
		expect(tasks[0]?.params.worker).toBe(workers()[0]);
		expect(tasks[1]?.params.worker).toBe(workers()[1]);

		await first.destroy();
		expect(tasks[0]?.destroy).toHaveBeenCalledTimes(1);
		expect(tasks[1]?.destroy).not.toHaveBeenCalled();
		expect(workers()[1]?.destroy).not.toHaveBeenCalled();
		expect(ports[1]?.terminate).not.toHaveBeenCalled();

		const doc = { numPages: 1 };
		tasks[1]?.resolve(doc);
		await expect(second.promise).resolves.toBe(doc);
		await second.destroy();
	});

	it("cancels a load destroyed before pdf.js arrives and creates nothing", async () => {
		vi.useFakeTimers();
		const { opener, tasks, ports, workers } = fakePdfJs();
		const handle = opener.open(new Uint8Array([1]));
		const outcome = handle.promise.then(
			() => "resolved",
			() => "rejected",
		);

		await handle.destroy();
		await flush();

		expect(await outcome).toBe("rejected");
		expect(tasks).toHaveLength(0);
		expect(ports).toHaveLength(0);
		expect(workers()).toHaveLength(0);
	});

	it("destroys a task still loading once, however often destroy is called, and rejects", async () => {
		vi.useFakeTimers();
		const { opener, tasks, ports, workers } = fakePdfJs();
		const handle = opener.open(new Uint8Array([1]));
		const outcome = handle.promise.then(
			() => "resolved",
			() => "rejected",
		);
		await flush();

		await Promise.all([handle.destroy(), handle.destroy()]);
		await handle.destroy();

		expect(await outcome).toBe("rejected");
		expect(tasks[0]?.destroy).toHaveBeenCalledTimes(1);
		expect(workers()[0]?.destroy).toHaveBeenCalledTimes(1);
		expect(ports[0]?.terminate).toHaveBeenCalledTimes(1);
	});

	it("ends the worker even when pdf.js's destroy never settles", async () => {
		vi.useFakeTimers();
		const { opener, tasks, ports } = fakePdfJs();
		const handle = opener.open(new Uint8Array([1]));
		handle.promise.catch(() => {});
		await flush();
		tasks[0]?.destroy.mockImplementation(() => new Promise(() => {}));

		const destroyed = handle.destroy();
		await vi.advanceTimersByTimeAsync(5_000);
		await destroyed;

		expect(ports[0]?.terminate).toHaveBeenCalledTimes(1);
	});

	it("hands pdf.js a copy, so the caller's bytes survive the transfer", async () => {
		vi.useFakeTimers();
		const { opener, tasks } = fakePdfJs();
		const bytes = new Uint8Array([37, 80, 68, 70]);
		const handle = opener.open(bytes);
		handle.promise.catch(() => {});
		await flush();

		const sent = tasks[0]?.params.data;
		expect(sent).not.toBe(bytes);
		expect(sent?.buffer).not.toBe(bytes.buffer);
		structuredClone(sent?.buffer, { transfer: sent ? [sent.buffer as ArrayBuffer] : [] });
		expect(bytes.length).toBe(4);
		expect(tasks[0]?.params.cMapUrl).toBe("file:///app/out/renderer/pdfjs/cmaps/");
		await handle.destroy();
	});
});
