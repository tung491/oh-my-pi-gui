/**
 * Renderer registry for the document preview. `DocumentPreview` reads,
 * validates and bounds the bytes; a renderer only draws them. Each entry is a
 * lazy component (retried after a failed chunk load) so its library loads on first use; csv uses the `sheet`
 * entry. A kind without an entry shows the "not available" state.
 */

import { Component, type ComponentType, createElement, type LazyExoticComponent, lazy, type ReactNode } from "react";

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

interface RethrowAfterCommitProps {
	children?: ReactNode;
	/** Runs in the commit phase, once the failure is caught and committed. */
	onCaught(): void;
}

/**
 * Passes a render error on to the enclosing boundary, but only after it has
 * committed here, so `onCaught` runs outside any render pass React may retry.
 */
class RethrowAfterCommit extends Component<
	RethrowAfterCommitProps,
	{ caught: { error: unknown } | null; rethrow: boolean }
> {
	state = { caught: null as { error: unknown } | null, rethrow: false };

	static getDerivedStateFromError(error: unknown) {
		return { caught: { error } };
	}

	componentDidCatch(): void {
		this.props.onCaught();
		this.setState({ rethrow: true });
	}

	render(): ReactNode {
		if (this.state.caught) {
			if (this.state.rethrow) throw this.state.caught.error;
			return null;
		}
		return this.props.children;
	}
}

/**
 * `React.lazy` that can recover: `lazy` caches a rejected `import()` for good,
 * so an error boundary's Retry would rethrow the same failure. Once a failed
 * load has reached the boundary, the next mount builds a fresh lazy component
 * and imports again; a successful load stays cached and loads once.
 *
 * The swap waits for the commit: swapping as soon as the import rejects would
 * make React's re-render suspend on a new import instead of showing the error,
 * so an unreachable chunk would be fetched over and over.
 */
export function lazyWithRetry<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
	let failed = false;
	const create = (): LazyExoticComponent<ComponentType<P>> =>
		lazy(() =>
			load().catch((error: unknown) => {
				failed = true;
				throw error;
			}),
		);
	let current = create();
	const recover = () => {
		if (!failed) return;
		failed = false;
		current = create();
	};
	function LazyWithRetry(props: P) {
		return createElement(RethrowAfterCommit, { onCaught: recover }, createElement(current, props));
	}
	return LazyWithRetry;
}

export const DEFAULT_PREVIEW_RENDERERS: PreviewRenderers = {
	docx: lazyWithRetry(() => import("./DocxPreview")),
	pdf: lazyWithRetry(() => import("./PdfPreview")),
	pptx: lazyWithRetry(() => import("./PptxPreview")),
	sheet: lazyWithRetry(() => import("./SheetPreview")),
};
