/**
 * Bounds for the PDF preview: how many pages it lays out, how large one
 * page's canvas may get, and which pages are drawn around the visible ones.
 */

/** Pages laid out; the rest are counted in a "not shown" note. */
export const PDF_MAX_PAGES = 50;
/** Pixels one page canvas may hold (4096 × 4096). */
export const PDF_MAX_CANVAS_PIXELS = 16_777_216;
/** Pages longer than this many times their width (or the reverse) are skipped. */
export const PDF_MAX_ASPECT = 20;

/**
 * The render scale for a page of `size` (PDF points at scale 1) shown at
 * `cssWidth` on a `dpr` screen, lowered so the canvas stays within
 * `maxPixels`. Null when the page has no size or an extreme aspect ratio.
 */
export function pdfPageScale(
	size: { width: number; height: number },
	cssWidth: number,
	dpr: number,
	maxPixels: number = PDF_MAX_CANVAS_PIXELS,
): number | null {
	const { width, height } = size;
	if (!(width > 0 && height > 0 && cssWidth > 0 && dpr > 0)) return null;
	if (Math.max(width / height, height / width) > PDF_MAX_ASPECT) return null;
	const scale = (cssWidth * dpr) / width;
	const area = width * height;
	return area * scale * scale > maxPixels ? Math.sqrt(maxPixels / area) : scale;
}

/** The visible pages plus each one's neighbours, within `1..total`. */
export function pagesNear(visible: ReadonlySet<number>, total: number): Set<number> {
	const near = new Set<number>();
	for (const page of visible) {
		for (const candidate of [page - 1, page, page + 1]) {
			if (candidate >= 1 && candidate <= total) near.add(candidate);
		}
	}
	return near;
}
