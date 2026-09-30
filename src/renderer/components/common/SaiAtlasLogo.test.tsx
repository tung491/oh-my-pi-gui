import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { SaiAtlasLogo } from "./SaiAtlasLogo";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	style: { height: string };
	remove: () => void;
	getAttribute: (name: string) => string | null;
	hasAttribute: (name: string) => boolean;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => ArrayLike<TestElement>;
}

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function images(): TestElement[] {
	return Array.from(container.querySelectorAll("img"));
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
});

describe("SaiAtlasLogo", () => {
	it("renders both lockup tones, named for assistive tech, at the requested height", async () => {
		await mount(<SaiAtlasLogo kind="lockup" surface="sidebar" height={28} />);

		const wrapper = container.querySelector("[data-logo-surface]");
		expect(wrapper?.getAttribute("data-logo-surface")).toBe("sidebar");
		expect(wrapper?.hasAttribute("aria-hidden")).toBe(false);
		expect(images().map(img => [img.getAttribute("data-logo-tone"), img.getAttribute("src")])).toEqual([
			["dark", "./brand/sai-atlas-lockup-on-dark.svg"],
			["light", "./brand/sai-atlas-lockup-on-light.svg"],
		]);
		for (const img of images()) {
			expect(img.getAttribute("alt")).toBe("Sai ATLAS");
			expect(img.style.height).toBe("28px");
		}
	});

	it("renders the icon tones as decoration on a page surface", async () => {
		await mount(<SaiAtlasLogo kind="icon" surface="page" height={48} data-assistant-avatar="" />);

		const wrapper = container.querySelector("[data-logo-surface]");
		expect(wrapper?.getAttribute("data-logo-surface")).toBe("page");
		expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
		expect(wrapper?.hasAttribute("data-assistant-avatar")).toBe(true);
		expect(images().map(img => [img.getAttribute("data-logo-tone"), img.getAttribute("src")])).toEqual([
			["dark", "./brand/sai-atlas-icon-on-dark.svg"],
			["light", "./brand/sai-atlas-icon-on-light.svg"],
		]);
		for (const img of images()) {
			expect(img.getAttribute("alt")).toBe("");
			expect(img.style.height).toBe("48px");
		}
	});
});
