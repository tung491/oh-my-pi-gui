/**
 * Link routing for rendered documents: only http, https and mailto links open,
 * through the system; every link click is prevented so nothing navigates the
 * webview. linkedom harness, as in ThinkingBlock.test.tsx.
 */

import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { routeDocumentLinkClicks, safeExternalHref } from "./safe-links";

const { document, Event } = parseHTML("<html><body></body></html>");

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

function setup(): { root: HTMLElement; open: ReturnType<typeof vi.fn>; dispose: () => void } {
	const root = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(root as never);
	const open = vi.fn();
	const dispose = routeDocumentLinkClicks(root, open);
	return { root, open, dispose };
}

function fire(target: unknown, type = "click"): Event {
	const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as globalThis.Event;
	(target as EventTarget).dispatchEvent(event);
	return event;
}

function anchor(root: HTMLElement, href: string): HTMLElement {
	const link = document.createElement("a") as unknown as HTMLElement;
	link.setAttribute("href", href);
	root.appendChild(link);
	return link;
}

describe("safeExternalHref", () => {
	it.each(["https://example.com/a", "http://x.y", "mailto:a@b.c"])("keeps %s", href => {
		expect(safeExternalHref(href)).toBe(href);
	});

	it.each([
		"javascript:alert(1)",
		"file:///etc/passwd",
		"data:text/html,x",
		"vbscript:x",
		"#frag",
		"relative/path",
		"",
		"   ",
	])("refuses %j", href => {
		expect(safeExternalHref(href)).toBeNull();
	});
});

describe("routeDocumentLinkClicks", () => {
	it("prevents an https click and opens it once", () => {
		const { root, open, dispose } = setup();
		const event = fire(anchor(root, "https://example.com/a"));
		expect(event.defaultPrevented).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith("https://example.com/a");
		dispose();
	});

	it("prevents a javascript: click without opening it", () => {
		const { root, open, dispose } = setup();
		const event = fire(anchor(root, "javascript:alert(1)"));
		expect(event.defaultPrevented).toBe(true);
		expect(open).not.toHaveBeenCalled();
		dispose();
	});

	it("prevents a click on a span nested in a file: anchor without opening it", () => {
		const { root, open, dispose } = setup();
		const link = anchor(root, "file:///etc/passwd");
		const span = document.createElement("span");
		link.appendChild(span as never);
		const event = fire(span);
		expect(event.defaultPrevented).toBe(true);
		expect(open).not.toHaveBeenCalled();
		dispose();
	});

	it("routes an SVG anchor whose link is in xlink:href", () => {
		const { root, open, dispose } = setup();
		const svg = document.createElementNS(SVG_NS, "svg");
		const link = document.createElementNS(SVG_NS, "a");
		link.setAttributeNS(XLINK_NS, "xlink:href", "https://example.com/svg");
		const shape = document.createElementNS(SVG_NS, "rect");
		link.appendChild(shape);
		svg.appendChild(link);
		root.appendChild(svg as never);
		const event = fire(shape);
		expect(event.defaultPrevented).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith("https://example.com/svg");
		dispose();
	});

	it("prevents an SVG anchor with a javascript: href without opening it", () => {
		const { root, open, dispose } = setup();
		const svg = document.createElementNS(SVG_NS, "svg");
		const link = document.createElementNS(SVG_NS, "a");
		link.setAttribute("href", "javascript:alert(1)");
		svg.appendChild(link);
		root.appendChild(svg as never);
		const event = fire(link);
		expect(event.defaultPrevented).toBe(true);
		expect(open).not.toHaveBeenCalled();
		dispose();
	});

	it("routes and prevents an auxclick on an https anchor", () => {
		const { root, open, dispose } = setup();
		const event = fire(anchor(root, "https://example.com/aux"), "auxclick");
		expect(event.defaultPrevented).toBe(true);
		expect(open).toHaveBeenCalledWith("https://example.com/aux");
		dispose();
	});

	it("scrolls an in-document anchor's target into view without opening anything", () => {
		const { root, open, dispose } = setup();
		const target = document.createElement("span") as unknown as HTMLElement;
		target.id = "Heading 2";
		const scrollIntoView = vi.fn();
		Object.assign(target, { scrollIntoView });
		root.appendChild(target);
		const event = fire(anchor(root, "#Heading%202"));
		expect(event.defaultPrevented).toBe(true);
		expect(scrollIntoView).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();
		dispose();
	});

	it.each(["#missing", "#%E0", "#"])("does nothing for the in-document anchor %s", href => {
		const { root, open, dispose } = setup();
		const other = document.createElement("span") as unknown as HTMLElement;
		other.id = "present";
		const scrollIntoView = vi.fn();
		Object.assign(other, { scrollIntoView });
		root.appendChild(other);
		let event: Event | null = null;
		expect(() => {
			event = fire(anchor(root, href));
		}).not.toThrow();
		expect((event as Event | null)?.defaultPrevented).toBe(true);
		expect(scrollIntoView).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		dispose();
	});

	it("ignores a click outside any link", () => {
		const { root, open, dispose } = setup();
		const span = document.createElement("span");
		root.appendChild(span as never);
		const event = fire(span);
		expect(event.defaultPrevented).toBe(false);
		expect(open).not.toHaveBeenCalled();
		dispose();
	});

	it("removes its listeners when disposed", () => {
		const { root, open, dispose } = setup();
		const link = anchor(root, "https://example.com/a");
		dispose();
		const event = fire(link);
		expect(event.defaultPrevented).toBe(false);
		expect(open).not.toHaveBeenCalled();
		const aux = fire(link, "auxclick");
		expect(aux.defaultPrevented).toBe(false);
	});
});
