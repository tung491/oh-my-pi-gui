/**
 * The open shadow root a docx or pptx preview renders into. The host keeps
 * the document's styles out of the app (and the app's out of the document);
 * every link click inside goes through `routeDocumentLinkClicks`.
 *
 * The render owns what it draws and returns a disposer for it. The hook runs
 * that disposer exactly once: at cleanup when the render finished first, or
 * as soon as the render resolves when the preview was torn down before it
 * did. `data-rendered="true"` marks the host only while a finished render is
 * on screen, so a test cannot pass before the library has drawn.
 */

import { type RefObject, useEffect, useRef } from "react";
import { routeDocumentLinkClicks } from "../../lib/preview/safe-links";

/** Opens a vetted document link through the system; a failure is logged, never thrown. */
export function openDocumentLink(href: string): void {
	window.omp.system.openExternal(href).catch((error: unknown) => {
		console.warn("[preview] could not open a document link", error);
	});
}

export type ShadowRender = (mount: HTMLDivElement, root: ShadowRoot, signal: AbortSignal) => Promise<() => void>;

export function useShadowMount(render: ShadowRender, deps: unknown[]): RefObject<HTMLDivElement | null> {
	const hostRef = useRef<HTMLDivElement | null>(null);
	// The latest render, so the effect re-runs on `deps` alone. Declared first,
	// so it runs before the effect below in the same commit.
	const renderRef = useRef(render);
	useEffect(() => {
		renderRef.current = render;
	});

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
		root.replaceChildren();
		const mount = document.createElement("div");
		root.appendChild(mount);
		const unroute = routeDocumentLinkClicks(root, openDocumentLink);

		const controller = new AbortController();
		let cleanedUp = false;
		let dispose: (() => void) | null = null;
		renderRef.current(mount, root, controller.signal).then(
			disposer => {
				if (cleanedUp) {
					disposer();
					return;
				}
				dispose = disposer;
				host.setAttribute("data-rendered", "true");
			},
			// Each renderer catches its own failures and reports them through
			// onError; a rejection reaching here just leaves the host unmarked.
			() => {},
		);

		return () => {
			cleanedUp = true;
			controller.abort();
			const disposer = dispose;
			dispose = null;
			disposer?.();
			unroute();
			host.removeAttribute("data-rendered");
			root.replaceChildren();
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: the caller's deps decide when to re-render, like useEffect's own
	}, deps);

	return hostRef;
}
