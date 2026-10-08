/**
 * Word document preview: docx-preview renders the bytes into an open shadow
 * root (`useShadowMount`) inside the containment frame, with the hardened
 * `DOCX_RENDER_OPTIONS`. The page is zoomed down to fit the drawer and
 * re-fitted when the drawer resizes. New bytes re-render in place.
 */

import { type ReactElement, useEffect, useRef } from "react";
import { DOCX_RENDER_OPTIONS, PREVIEW_FRAME_CLASS } from "./office-render-options";
import type { PreviewRendererProps } from "./renderers";
import { useShadowMount } from "./shadow-mount";

/** Horizontal padding of the host (`p-3` on both sides). */
const PAGE_GUTTER_PX = 24;

const noop = (): void => {};

export default function DocxPreview({ content, onError }: PreviewRendererProps): ReactElement {
	const bytes = "bytes" in content ? content.bytes : null;
	// The latest `onError` without re-rendering when the parent passes a new function.
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onErrorRef.current = onError;
	});

	const hostRef = useShadowMount(
		async (mount, root, signal) => {
			try {
				if (bytes === null) throw new Error("The Word preview needs the file's bytes");
				const { renderAsync } = await import("docx-preview");
				if (signal.aborted) return noop;
				await renderAsync(bytes, mount, mount, DOCX_RENDER_OPTIONS);
				const host = root.host as HTMLElement;
				const fitPage = (): void => {
					const page = mount.querySelector<HTMLElement>("section.docx");
					if (page && page.offsetWidth > 0) {
						mount.style.zoom = String(Math.min(1, (host.clientWidth - PAGE_GUTTER_PX) / page.offsetWidth));
					}
				};
				fitPage();
				const observer = new ResizeObserver(fitPage);
				observer.observe(host);
				return () => observer.disconnect();
			} catch (error) {
				if (!signal.aborted) onErrorRef.current(error);
				// Rejecting leaves the host without data-rendered; useShadowMount handles it.
				throw error;
			}
		},
		[bytes],
	);

	return (
		<div className={PREVIEW_FRAME_CLASS} data-preview-frame>
			<div ref={hostRef} className="h-full w-full overflow-auto bg-(--omp-code-bg) p-3" data-preview-host="docx" />
		</div>
	);
}
