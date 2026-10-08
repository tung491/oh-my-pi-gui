/**
 * Slide deck preview: `@aiden0z/pptx-renderer` draws every slide into an
 * open shadow root (`useShadowMount`) inside the containment frame, as a
 * windowed list. The viewer runs with `pptxViewerOptions` (the library's
 * recommended ZIP limits, no pdf.js), and its navigation hook is replaced
 * before the deck opens so shape hyperlinks reach only the allowlisted
 * opener. New bytes re-render in place; the viewer is destroyed with its render.
 */

import type { PptxViewer } from "@aiden0z/pptx-renderer";
import { type ReactElement, useEffect, useRef } from "react";
import {
	installPptxNavigation,
	type PptxNavigationTarget,
	PREVIEW_FRAME_CLASS,
	pptxViewerOptions,
} from "./office-render-options";
import type { PreviewRendererProps } from "./renderers";
import { openDocumentLink, useShadowMount } from "./shadow-mount";

const noop = (): void => {};

export default function PptxPreview({ content, onError }: PreviewRendererProps): ReactElement {
	const bytes = "bytes" in content ? content.bytes : null;
	// The latest `onError` without re-rendering when the parent passes a new function.
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onErrorRef.current = onError;
	});

	const hostRef = useShadowMount(
		async (mount, _root, signal) => {
			let viewer: PptxViewer | null = null;
			try {
				if (bytes === null) throw new Error("The slide preview needs the file's bytes");
				const lib = await import("@aiden0z/pptx-renderer");
				if (signal.aborted) return noop;
				viewer = new lib.PptxViewer(mount, pptxViewerOptions(lib.RECOMMENDED_ZIP_LIMITS));
				// Contract: the pinned 1.3.0 routes every slide hyperlink through the
				// instance's `handleNavigate` (declared `private` in core/Viewer.d.ts,
				// a plain prototype method at runtime). office-render-options.test.ts
				// fails if a version bump changes that.
				installPptxNavigation(viewer as unknown as PptxNavigationTarget, openDocumentLink);
				// open() copies the bytes and throws an AbortError once `signal` aborts.
				await viewer.open(bytes, { renderMode: "list", listOptions: { windowed: true }, signal });
				const shown = viewer;
				return () => shown.destroy();
			} catch (error) {
				viewer?.destroy();
				if (!signal.aborted) onErrorRef.current(error);
				// Rejecting leaves the host without data-rendered; useShadowMount handles it.
				throw error;
			}
		},
		[bytes],
	);

	return (
		<div className={PREVIEW_FRAME_CLASS} data-preview-frame>
			<div ref={hostRef} className="h-full w-full overflow-auto bg-(--omp-code-bg) p-3" data-preview-host="pptx" />
		</div>
	);
}
