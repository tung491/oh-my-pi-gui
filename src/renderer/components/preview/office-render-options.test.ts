/**
 * The hardened docx and pptx render options, the pptx navigation hook and the
 * containment frame class. The last block guards the pinned pptx renderer: it
 * imports the real library and reads its bundle, so a version bump that moves
 * the navigation hook fails here instead of silently opening links.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	DOCX_RENDER_OPTIONS,
	installPptxNavigation,
	type PptxNavigationTarget,
	PREVIEW_FRAME_CLASS,
	pptxViewerOptions,
} from "./office-render-options";

const PPTX_PACKAGE_DIR = new URL("../../../../node_modules/@aiden0z/pptx-renderer/", import.meta.url);

describe("DOCX_RENDER_OPTIONS", () => {
	it("keeps alt chunks off, images inline and the wrapper on", () => {
		expect(DOCX_RENDER_OPTIONS.renderAltChunks).toBe(false);
		expect(DOCX_RENDER_OPTIONS.useBase64URL).toBe(true);
		expect(DOCX_RENDER_OPTIONS.inWrapper).toBe(true);
		expect(DOCX_RENDER_OPTIONS.className).toBe("docx");
	});
});

describe("pptxViewerOptions", () => {
	it("passes the zip limits through and turns pdf.js off", () => {
		const limits = { maxEntries: 10 };
		const options = pptxViewerOptions(limits);
		expect(options.zipLimits).toBe(limits);
		expect(options.pdfjs).toBe(false);
		expect(options.lazySlides).toBe(true);
		expect(options.lazyMedia).toBe(true);
		expect(options).not.toHaveProperty("onNavigate");
	});
});

describe("installPptxNavigation", () => {
	function install(): {
		viewer: PptxNavigationTarget;
		open: ReturnType<typeof vi.fn>;
		goToSlide: ReturnType<typeof vi.fn>;
	} {
		const goToSlide = vi.fn();
		const viewer: PptxNavigationTarget = { goToSlide };
		const open = vi.fn();
		installPptxNavigation(viewer, open);
		return { viewer, open, goToSlide };
	}

	it.each(["https://a.b", "mailto:a@b.c"])("opens %s once", url => {
		const { viewer, open, goToSlide } = install();
		viewer.handleNavigate?.({ url });
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith(url);
		expect(goToSlide).not.toHaveBeenCalled();
	});

	it.each([{ url: "javascript:x" }, { url: "file:///x" }, {}])("opens nothing for %j", target => {
		const { viewer, open, goToSlide } = install();
		viewer.handleNavigate?.(target);
		expect(open).not.toHaveBeenCalled();
		expect(goToSlide).not.toHaveBeenCalled();
	});

	it("moves to a linked slide without opening anything", () => {
		const { viewer, open, goToSlide } = install();
		viewer.handleNavigate?.({ slideIndex: 2 });
		expect(goToSlide).toHaveBeenCalledWith(2);
		expect(open).not.toHaveBeenCalled();
	});
});

describe("PREVIEW_FRAME_CLASS", () => {
	it("clips, isolates and contains whatever the document styles", () => {
		const classes = PREVIEW_FRAME_CLASS.split(/\s+/);
		for (const name of ["relative", "overflow-clip", "isolate", "[contain:strict]", "[transform:translateZ(0)]"]) {
			expect(classes).toContain(name);
		}
	});
});

describe("pinned @aiden0z/pptx-renderer navigation contract", () => {
	it("is version 1.3.0", () => {
		const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", PPTX_PACKAGE_DIR)), "utf8")) as {
			version: string;
		};
		expect(manifest.version).toBe("1.3.0");
	});

	it("routes every slide hyperlink through the instance's handleNavigate", async () => {
		const lib = await import("@aiden0z/pptx-renderer");
		const prototype = lib.PptxViewer.prototype as unknown as Record<string, unknown>;
		expect(typeof prototype.handleNavigate).toBe("function");

		// The ES bundle Vite resolves for the "import" condition.
		const bundle = readFileSync(fileURLToPath(new URL("dist/aiden0z-pptx-renderer.es.js", PPTX_PACKAGE_DIR)), "utf8");
		expect(bundle.split("this.handleNavigate(").length - 1).toBeGreaterThanOrEqual(1);
		// The only window.open is the one inside handleNavigate, which the preview replaces.
		expect(bundle.split("window.open(").length - 1).toBe(1);
		expect(bundle).toMatch(/handleNavigate\(\w+\)\s*\{[^}]*window\.open\(/);
	});
});
