/**
 * Link handling for documents rendered in the preview (docx, pptx). A
 * document's links must never navigate the webview: every click or auxclick
 * on a link is prevented, and only web and mail links are handed to the
 * system opener. HTML anchors and SVG anchors (`href` or `xlink:href`) alike.
 */

const XLINK_NS = "http://www.w3.org/1999/xlink";
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ROUTED_EVENTS = ["click", "auxclick"] as const;
const ELEMENT_NODE = 1;

/** Returns `href` when it is an absolute http, https or mailto URL, otherwise null. */
export function safeExternalHref(href: string): string | null {
	if (href.trim() === "") return null;
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		// Relative and malformed URLs throw.
		return null;
	}
	return EXTERNAL_PROTOCOLS.has(url.protocol) ? href : null;
}

function isElement(value: unknown): value is Element {
	return typeof value === "object" && value !== null && (value as Node).nodeType === ELEMENT_NODE;
}

/** The event's propagation path, or a parent walk from its target when the path is unavailable. */
function eventPath(event: Event): EventTarget[] {
	if (typeof event.composedPath === "function") {
		// Some ambient Event typings declare `[EventTarget?]`; drop the holes.
		const path = event.composedPath().filter((target): target is EventTarget => target != null);
		if (path.length > 0) return path;
	}
	const walked: EventTarget[] = [];
	let node = event.target as Node | null;
	while (node) {
		walked.push(node);
		node = node.parentNode;
	}
	return walked;
}

/** The link of the innermost anchor on the path, or null when the event is not on a link. */
function linkOf(event: Event): string | null {
	for (const target of eventPath(event)) {
		if (!isElement(target) || target.localName !== "a") continue;
		// The qualified-name lookup covers DOMs that ignore attribute namespaces.
		const link =
			target.getAttribute("href") ?? target.getAttributeNS(XLINK_NS, "href") ?? target.getAttribute("xlink:href");
		if (link !== null) return link;
	}
	return null;
}

/** The element under `root` whose id is `id`, or null. */
function elementById(root: ShadowRoot | HTMLElement, id: string): Element | null {
	if ("getElementById" in root && typeof root.getElementById === "function") return root.getElementById(id);
	// An element root has no getElementById; compare ids directly rather than build a selector.
	for (const element of root.querySelectorAll("[id]")) {
		if (element.id === id) return element;
	}
	return null;
}

/** Scrolls an in-document anchor's target (`#id`, percent-encoded or not) into view; unknown or malformed ids do nothing. */
function scrollToFragment(root: ShadowRoot | HTMLElement, fragment: string): void {
	let id: string;
	try {
		id = decodeURIComponent(fragment);
	} catch {
		// Malformed percent-encoding: fall back to the raw text.
		id = fragment;
	}
	if (id === "") return;
	const target = elementById(root, id) ?? (id === fragment ? null : elementById(root, fragment));
	if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
}

/**
 * Captures clicks and auxclicks on links under `root`: prevents and stops
 * every one. An in-document anchor (`#id`, such as a docx table of contents
 * or bookmark link) scrolls its target into view inside `root`; otherwise
 * `open` is called only for a safe external link. Returns a disposer that
 * removes the listeners.
 */
export function routeDocumentLinkClicks(root: ShadowRoot | HTMLElement, open: (href: string) => void): () => void {
	const handler = (event: Event): void => {
		const link = linkOf(event);
		if (link === null) return;
		event.preventDefault();
		event.stopPropagation();
		if (link.startsWith("#")) {
			scrollToFragment(root, link.slice(1));
			return;
		}
		const safe = safeExternalHref(link);
		if (safe) open(safe);
	};
	for (const type of ROUTED_EVENTS) root.addEventListener(type, handler, true);
	return () => {
		for (const type of ROUTED_EVENTS) root.removeEventListener(type, handler, true);
	};
}
