import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { ChatStream } from "./ChatStream";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
globals.cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);
const box = (size: number) => ({ get: () => size, configurable: true });
Object.defineProperties(HTMLElement.prototype, {
	clientHeight: box(800),
	clientWidth: box(1000),
	offsetHeight: box(800),
	offsetWidth: box(1000),
	scrollHeight: box(800),
	scrollWidth: box(1000),
	scrollTop: { get: () => 0, set: () => {}, configurable: true },
});

const windowGlobals = window as unknown as Record<string, unknown>;
let container: Element | null = null;
let root: Root | null = null;

async function mountEmpty(platform: string): Promise<Element> {
	windowGlobals.omp = { platform };
	useSessionStore.setState({ status: "ready" });
	const host = document.createElement("div") as unknown as Element;
	document.body.appendChild(host as never);
	container = host;
	root = createRoot(host);
	const mounted = root;
	await act(async () => {
		mounted.render(
			<I18nProvider>
				<ChatStream />
			</I18nProvider>,
		);
	});
	return host;
}

afterEach(async () => {
	const mounted = root;
	if (mounted) await act(async () => mounted.unmount());
	container?.remove();
	container = null;
	root = null;
	delete windowGlobals.omp;
	useMessagesStore.getState().reset();
	useSessionStore.getState().reset();
});

describe("empty-state starter cards", () => {
	it("shows four cards on Linux, the helpdesk included", async () => {
		const host = await mountEmpty("linux");
		const cards = host.querySelectorAll(".omp-starter-card");
		expect(cards).toHaveLength(4);
		expect(host.textContent).toContain(en["chat.starter.helpdesk.title"]);
	});

	it("shows three cards on macOS, without the helpdesk", async () => {
		const host = await mountEmpty("darwin");
		expect(host.querySelectorAll(".omp-starter-card")).toHaveLength(3);
		expect(host.textContent).not.toContain(en["chat.starter.helpdesk.title"]);
	});

	it("asks what it can help with today", async () => {
		const host = await mountEmpty("linux");
		expect(en["chat.empty.everyday.title"]).toBe("What can I help you with today?");
		expect(host.querySelector("h1")?.textContent).toBe(en["chat.empty.everyday.title"]);
	});
});
