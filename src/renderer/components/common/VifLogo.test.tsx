import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { VifLogo } from "./VifLogo";

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
	textContent: string | null;
	style: { height: string };
	remove: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
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

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
});

describe("VifLogo", () => {
	it("renders the bundled logo image at the requested height", async () => {
		await mount(<VifLogo height={22} />);

		const img = container.querySelector('img[alt="VIF"]');
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("./vif-logo.png");
		expect(img?.style.height).toBe("22px");
	});

	it("shows the omp wordmark after a decorative divider", async () => {
		await mount(<VifLogo height={22} />);

		expect(container.textContent).toContain("omp");
		expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
	});
});
