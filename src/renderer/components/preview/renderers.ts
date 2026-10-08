/**
 * Renderer registry for the document preview. `DocumentPreview` reads,
 * validates and bounds the bytes; a renderer only draws them. Each entry is a
 * lazy component so its library loads on first use; csv uses the `sheet`
 * entry. A kind without an entry shows the "not available" state.
 */

import { type ComponentType, lazy } from "react";

/** Bytes for binary formats; text (with the read's truncation flag) for csv. */
export type PreviewContent = { bytes: Uint8Array } | { text: string; truncated: boolean };

export interface PreviewRendererProps {
	content: PreviewContent;
	kind: "pdf" | "docx" | "pptx" | "sheet" | "csv";
	path: string;
	/** Reports a failure the renderer caught itself; the shell shows "could not be shown". */
	onError(error: unknown): void;
}

export type PreviewRenderers = Partial<Record<"pdf" | "docx" | "pptx" | "sheet", ComponentType<PreviewRendererProps>>>;

export const DEFAULT_PREVIEW_RENDERERS: PreviewRenderers = {
	pdf: lazy(() => import("./PdfPreview")),
	sheet: lazy(() => import("./SheetPreview")),
};
