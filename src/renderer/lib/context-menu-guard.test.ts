import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { installContextMenuGuard } from "./context-menu-guard";

const { document, window, Event, Element } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.Element = Element;

let remove: (() => void) | undefined;

afterEach(() => {
	remove?.();
	remove = undefined;
	document.body.innerHTML = "";
});

function fireContextMenu(target: Element): boolean {
	const event = new Event("contextmenu", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "target", { value: target, configurable: true });
	target.dispatchEvent(event as unknown as Event);
	return event.defaultPrevented;
}

describe("installContextMenuGuard", () => {
	it("prevents the menu on plain content", () => {
		document.body.innerHTML = '<div id="plain">text</div>';
		remove = installContextMenuGuard(document as unknown as Document);
		const target = document.getElementById("plain") as unknown as Element;
		expect(fireContextMenu(target)).toBe(true);
	});

	it("allows the menu in a textarea", () => {
		document.body.innerHTML = '<textarea id="ta"></textarea>';
		remove = installContextMenuGuard(document as unknown as Document);
		const target = document.getElementById("ta") as unknown as Element;
		expect(fireContextMenu(target)).toBe(false);
	});

	it("allows the menu in contenteditable", () => {
		document.body.innerHTML = '<div id="ce" contenteditable="true">text</div>';
		remove = installContextMenuGuard(document as unknown as Document);
		const target = document.getElementById("ce") as unknown as Element;
		expect(fireContextMenu(target)).toBe(false);
	});

	it("remover detaches the listener", () => {
		document.body.innerHTML = '<div id="plain">text</div>';
		const detach = installContextMenuGuard(document as unknown as Document);
		detach();
		const target = document.getElementById("plain") as unknown as Element;
		expect(fireContextMenu(target)).toBe(false);
	});
});
