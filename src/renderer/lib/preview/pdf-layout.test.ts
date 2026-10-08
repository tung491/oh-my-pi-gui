import { describe, expect, it } from "vitest";
import { PDF_MAX_CANVAS_PIXELS, pagesNear, pdfPageScale } from "./pdf-layout";

describe("pdfPageScale", () => {
	it("fills the CSS width at the device pixel ratio", () => {
		expect(pdfPageScale({ width: 595, height: 842 }, 816, 2)).toBeCloseTo((816 * 2) / 595, 10);
	});

	it("scales a huge page down to the canvas pixel cap", () => {
		const size = { width: 14_400, height: 14_400 };
		const pixelsAt = (scale: number | null) => size.width * size.height * (scale ?? Number.NaN) ** 2;
		expect(pixelsAt(pdfPageScale(size, 816, 2))).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
		// 4000 CSS px at dpr 2 asks for 8000 × 8000, far past the cap.
		const capped = pixelsAt(pdfPageScale(size, 4000, 2));
		expect(capped).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
		expect(capped).toBeGreaterThan(PDF_MAX_CANVAS_PIXELS * 0.99);
	});

	it("honours a custom pixel cap", () => {
		const scale = pdfPageScale({ width: 100, height: 100 }, 1000, 1, 10_000);
		expect(scale).toBeCloseTo(1, 10);
	});

	it("skips a page whose aspect ratio is over 20, either way round", () => {
		expect(pdfPageScale({ width: 1, height: 14_400 }, 816, 2)).toBeNull();
		expect(pdfPageScale({ width: 14_400, height: 1 }, 816, 2)).toBeNull();
		expect(pdfPageScale({ width: 1, height: 20 }, 816, 2)).not.toBeNull();
	});

	it("skips a page without a size", () => {
		expect(pdfPageScale({ width: 0, height: 100 }, 816, 2)).toBeNull();
		expect(pdfPageScale({ width: 100, height: 100 }, 0, 2)).toBeNull();
	});
});

describe("pagesNear", () => {
	it("adds each visible page's neighbours", () => {
		expect(pagesNear(new Set([5]), 50)).toEqual(new Set([4, 5, 6]));
		expect(pagesNear(new Set([5, 9]), 50)).toEqual(new Set([4, 5, 6, 8, 9, 10]));
	});

	it("stays within the document", () => {
		expect(pagesNear(new Set([1]), 1)).toEqual(new Set([1]));
		expect(pagesNear(new Set([1]), 3)).toEqual(new Set([1, 2]));
		expect(pagesNear(new Set([3]), 3)).toEqual(new Set([2, 3]));
		expect(pagesNear(new Set(), 3)).toEqual(new Set());
	});
});
