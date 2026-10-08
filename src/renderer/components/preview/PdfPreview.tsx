/**
 * PDF pages for the document preview. Lays out the first `PDF_MAX_PAGES`
 * pages as placeholders sized from each page's own aspect ratio, so the
 * layout (and the scroll position) is stable before anything is drawn, then
 * draws only the pages near the viewport. A page that leaves that range gets
 * its render cancelled and its canvas freed. Every canvas is capped at
 * `PDF_MAX_CANVAS_PIXELS`, and pages with an extreme aspect ratio are skipped
 * with a note. Canvases only: no text layer and no annotation layer.
 *
 * New bytes (a refresh) open a second document while the first stays on
 * screen; the first is destroyed once the second has replaced it.
 */

import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { openPdfDocument, type PdfDocumentHandle } from "../../lib/pdfjs";
import { PDF_MAX_PAGES, pagesNear, pdfPageScale } from "../../lib/preview/pdf-layout";
import { Spinner } from "../common";
import type { PreviewRendererProps } from "./renderers";

/** Horizontal padding of the page column (`p-3` on both sides). */
const PAGE_GUTTER_PX = 24;

interface PageSize {
	width: number;
	height: number;
}

interface LoadedPdf {
	handle: PdfDocumentHandle;
	proxy: PDFDocumentProxy;
	numPages: number;
	/** Scale-1 sizes of the pages laid out. */
	sizes: PageSize[];
}

export interface PdfPreviewProps extends PreviewRendererProps {
	/** Opens the bytes; the shared pdf.js opener by default (tests inject a fake). */
	openDocument?: (bytes: Uint8Array) => PdfDocumentHandle;
}

/** True when the page cannot be drawn at any width: no size, or an extreme aspect ratio. */
function isSkipped(size: PageSize): boolean {
	return pdfPageScale(size, 1, 1) === null;
}

async function loadPdf(handle: PdfDocumentHandle): Promise<LoadedPdf> {
	const proxy = await handle.promise;
	const count = Math.min(proxy.numPages, PDF_MAX_PAGES);
	const sizes: PageSize[] = [];
	for (let index = 1; index <= count; index += 1) {
		const viewport = (await proxy.getPage(index)).getViewport({ scale: 1 });
		sizes.push({ width: viewport.width, height: viewport.height });
	}
	return { handle, proxy, numPages: proxy.numPages, sizes };
}

export default function PdfPreview({
	content,
	onError,
	openDocument = openPdfDocument,
}: PdfPreviewProps): ReactElement {
	const t = useT();
	const bytes = "bytes" in content ? content.bytes : null;
	const [pdf, setPdf] = useState<LoadedPdf | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	// The latest callbacks, so the effects key on the bytes and the document alone.
	// Declared first, so it runs before the effects below in the same commit.
	const onErrorRef = useRef(onError);
	const openRef = useRef(openDocument);
	useEffect(() => {
		onErrorRef.current = onError;
		openRef.current = openDocument;
	});

	/**
	 * Handles whose document React has committed to the screen; the effect
	 * below owns those. Handing ownership over at `setPdf` would leak: React
	 * may drop that pending update (a higher-priority target switch), and the
	 * effect that would destroy it then never runs.
	 */
	const shownRef = useRef(new Set<PdfDocumentHandle>());

	// Open the bytes. Its cleanup destroys the handle unless it is on screen;
	// destroy() is idempotent, so overlapping with the effect below is safe.
	useEffect(() => {
		if (bytes === null) {
			onErrorRef.current(new Error("The PDF preview needs the file's bytes"));
			return;
		}
		let cancelled = false;
		let handle: PdfDocumentHandle;
		try {
			handle = openRef.current(bytes);
		} catch (error) {
			onErrorRef.current(error);
			return;
		}
		loadPdf(handle).then(
			loaded => {
				if (!cancelled) setPdf(loaded);
			},
			(error: unknown) => {
				if (!cancelled) onErrorRef.current(error);
			},
		);
		const shown = shownRef.current;
		return () => {
			cancelled = true;
			if (!shown.has(handle)) void handle.destroy();
		};
	}, [bytes]);

	// The document on screen is destroyed when it is replaced or unmounted.
	useEffect(() => {
		if (!pdf) return;
		const shown = shownRef.current;
		shown.add(pdf.handle);
		return () => {
			shown.delete(pdf.handle);
			void pdf.handle.destroy();
		};
	}, [pdf]);

	// Draw the pages near the viewport; free the ones that leave it.
	useEffect(() => {
		const container = containerRef.current;
		if (!pdf || !container) return;
		let disposed = false;
		const visible = new Set<number>();
		const drawing = new Map<number, { task: RenderTask | null }>();

		const canvasOf = (page: number) => container.querySelector<HTMLCanvasElement>(`canvas[data-page="${page}"]`);
		const free = (page: number) => {
			const canvas = canvasOf(page);
			if (!canvas) return;
			canvas.width = 0;
			canvas.height = 0;
		};

		const draw = (pageNumber: number) => {
			const entry: { task: RenderTask | null } = { task: null };
			drawing.set(pageNumber, entry);
			const size = pdf.sizes[pageNumber - 1];
			const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
			const scale = size ? pdfPageScale(size, container.clientWidth - PAGE_GUTTER_PX, dpr) : null;
			if (scale === null) return;
			const current = () => !disposed && drawing.get(pageNumber) === entry;
			(async () => {
				const page = await pdf.proxy.getPage(pageNumber);
				const canvas = canvasOf(pageNumber);
				if (!current() || !canvas) return;
				const viewport = page.getViewport({ scale });
				canvas.width = Math.max(1, Math.floor(viewport.width));
				canvas.height = Math.max(1, Math.floor(viewport.height));
				entry.task = page.render({ canvas, viewport });
				await entry.task.promise;
			})().catch((error: unknown) => {
				// A cancelled render (scrolled away, refreshed, unmounted) is not a failure.
				if (current()) onErrorRef.current(error);
			});
		};

		const update = () => {
			const wanted = pagesNear(visible, pdf.sizes.length);
			for (const [page, entry] of drawing) {
				if (wanted.has(page)) continue;
				drawing.delete(page);
				entry.task?.cancel();
				free(page);
			}
			for (const page of wanted) if (!drawing.has(page)) draw(page);
		};

		const observer = new IntersectionObserver(
			entries => {
				for (const entry of entries) {
					const page = Number((entry.target as HTMLElement).dataset.page);
					if (!Number.isInteger(page)) continue;
					if (entry.isIntersecting) visible.add(page);
					else visible.delete(page);
				}
				if (!disposed) update();
			},
			{ root: null, rootMargin: "100% 0px" },
		);
		for (const slot of container.querySelectorAll<HTMLElement>("[data-pdf-slot]")) observer.observe(slot);

		return () => {
			disposed = true;
			observer.disconnect();
			for (const [page, entry] of drawing) {
				entry.task?.cancel();
				free(page);
			}
			drawing.clear();
		};
	}, [pdf]);

	if (!pdf) {
		return (
			<div className="flex items-center gap-2 p-4">
				<Spinner size="sm" />
				<span className="text-omp-sm text-(--omp-dim)">{t("filesPanel.reading")}</span>
			</div>
		);
	}

	const hidden = pdf.numPages - pdf.sizes.length;
	return (
		<div ref={containerRef} className="flex flex-col gap-3 p-3" data-pdf-pages={pdf.sizes.length}>
			{pdf.sizes.map((size, index) => {
				const page = index + 1;
				if (isSkipped(size)) {
					return (
						<div
							key={page}
							data-pdf-slot
							data-page={page}
							className="px-2 py-4 text-center text-omp-sm text-(--omp-dim)"
						>
							{t("preview.pageSkipped", { page })}
						</div>
					);
				}
				return (
					<div
						key={page}
						data-pdf-slot
						data-page={page}
						className="w-full overflow-hidden rounded-sm shadow-sm"
						style={{ aspectRatio: `${size.width} / ${size.height}` }}
					>
						{/* Sized 0×0 until drawn: an unsized canvas holds a 300×150 bitmap. */}
						<canvas data-page={page} width={0} height={0} className="block h-full w-full" />
					</div>
				);
			})}
			{hidden > 0 && (
				<div className="px-2 py-3 text-center text-omp-sm text-(--omp-dim)">
					{t("preview.pagesNotShown", { count: hidden })}
				</div>
			)}
		</div>
	);
}
