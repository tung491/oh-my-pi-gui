/**
 * The hardened options the docx and pptx previews render with, the pptx
 * navigation hook, and the frame that keeps a document's styles inside the
 * drawer. Type-only imports: nothing here loads a library, so the renderers
 * stay in their lazy chunks and these settings stay unit-testable.
 */

import type { ViewerOptions, ZipParseLimits } from "@aiden0z/pptx-renderer";
import { safeExternalHref } from "../../lib/preview/safe-links";

/**
 * docx-preview options. Alt chunks (embedded HTML/RTF) are never rendered,
 * and images become `data:` URLs so no `blob:` origin is needed.
 */
export const DOCX_RENDER_OPTIONS = {
	className: "docx",
	inWrapper: true,
	breakPages: true,
	renderAltChunks: false,
	useBase64URL: true,
	experimental: false,
} as const;

/**
 * pptx viewer options: the caller's ZIP limits (the library's
 * `RECOMMENDED_ZIP_LIMITS`), slides and media parsed on demand, and no pdf.js
 * fallback for EMF-embedded PDFs. Hyperlinks are not an option in 1.3.0; see
 * `installPptxNavigation`.
 */
export function pptxViewerOptions(zipLimits: ZipParseLimits): ViewerOptions {
	return { zipLimits, lazySlides: true, lazyMedia: true, pdfjs: false };
}

/** A navigation request from a slide: a linked slide, or a shape hyperlink's URL. */
export interface PptxNavigation {
	slideIndex?: number;
	url?: string;
}

/**
 * The part of `PptxViewer` that slide hyperlinks reach. In the pinned 1.3.0,
 * every slide renderer is given `s => this.handleNavigate(s)`, and the
 * prototype's `handleNavigate` calls `window.open` itself (`private` exists
 * only in Viewer.d.ts). Replacing it on the instance routes every shape
 * hyperlink through the preview's opener; office-render-options.test.ts
 * fails if a version bump moves that hook.
 */
export interface PptxNavigationTarget {
	goToSlide(index: number): Promise<void> | void;
	handleNavigate?(target: PptxNavigation): void;
}

/**
 * Replaces the viewer's navigation hook before it opens a deck: slide links
 * move within the deck, and URLs open through `open` only when they are
 * http, https or mailto. Nothing calls `window.open`.
 */
export function installPptxNavigation(viewer: PptxNavigationTarget, open: (href: string) => void): void {
	viewer.handleNavigate = target => {
		if (target.slideIndex !== undefined) {
			// The viewer reports a slide that fails to draw through its own slideerror event.
			Promise.resolve(viewer.goToSlide(target.slideIndex)).catch((error: unknown) => {
				console.warn("[preview] pptx slide link failed", error);
			});
			return;
		}
		const safe = target.url === undefined ? null : safeExternalHref(target.url);
		if (safe) open(safe);
	};
}

/**
 * The frame around a shadow host. The transform makes it the containing block
 * for a `position: fixed` host, and the clip and containment keep anything a
 * document's `:host` rules do inside the frame.
 */
export const PREVIEW_FRAME_CLASS =
	"relative h-full w-full overflow-clip isolate [contain:strict] [transform:translateZ(0)]";
