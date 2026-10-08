import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { activeTabCommand, SessionRuntimeProvider } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { GenericRenderer } from "./GenericRenderer";
import { getToolRenderer } from "./index";
import type { ToolRendererProps } from "./ToolCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const windowGlobals = window as unknown as Record<string, unknown>;
const REPORT = "/home/u/Documents/Sai ATLAS/Quarterly report.docx";
const RUNTIME_TAB = "tab-office";

let container: Element | null = null;
let root: Root | null = null;
let opened: string[] = [];

function officeResult(payload: unknown): unknown {
	const text = typeof payload === "string" ? payload : JSON.stringify(payload);
	return { content: [{ type: "text", text }] };
}

function reportResult(overrides: Record<string, unknown> = {}): unknown {
	return officeResult({ file: REPORT, kind: "docx", check: "12 paragraphs, 2 tables", ...overrides });
}

async function mount(element: ReactElement): Promise<Element> {
	opened = [];
	windowGlobals.omp = {
		system: {
			openPath: async (path: string) => {
				opened.push(path);
				return { ok: true, resolvedPath: path };
			},
		},
	};
	const host = document.createElement("div") as unknown as Element;
	document.body.appendChild(host as never);
	container = host;
	root = createRoot(host);
	const mounted = root;
	await act(async () => {
		mounted.render(<I18nProvider>{element}</I18nProvider>);
	});
	return host;
}

function staticMarkup(element: ReactElement): string {
	return renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
}

afterEach(async () => {
	const mounted = root;
	if (mounted) await act(async () => mounted.unmount());
	container?.remove();
	container = null;
	root = null;
	delete windowGlobals.omp;
	useUiStore.setState({ filePreview: null, panelVisible: false, panelTab: "files" });
});

describe("office output card", () => {
	it("shows the finished file by name with its check", async () => {
		const Renderer = getToolRenderer("office_report");
		const host = await mount(<Renderer args={{ markdown: "# Report" }} result={reportResult()} />);
		expect(host.querySelector("[data-office-file]")).not.toBeNull();
		expect(host.textContent).toContain("Quarterly report.docx");
		expect(host.textContent).toContain("12 paragraphs, 2 tables");
	});

	it("opens the file, and its folder, through the shell", async () => {
		const Renderer = getToolRenderer("office_report");
		const host = await mount(<Renderer args={{}} result={reportResult()} />);
		const buttons = Array.from(host.querySelectorAll("button"));
		const open = buttons.find(button => button.textContent === "Open");
		const reveal = buttons.find(button => button.textContent === "Show in folder");
		if (!open || !reveal) throw new Error("card buttons missing");
		await act(async () => {
			open.dispatchEvent(new Event("click", { bubbles: true }));
		});
		await act(async () => {
			reveal.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(opened).toEqual([REPORT, "/home/u/Documents/Sai ATLAS"]);
	});

	it("previews the file beside the chat, pinned to the card's tab, without opening it externally", async () => {
		useUiStore.setState({ filePreview: null, panelVisible: false, panelTab: "logs" });
		const Renderer = getToolRenderer("office_report");
		const host = await mount(
			<SessionRuntimeProvider runtime={{ tabId: RUNTIME_TAB, command: activeTabCommand, stores: new Map() }}>
				<Renderer args={{}} result={reportResult()} />
			</SessionRuntimeProvider>,
		);
		const preview = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Preview");
		if (!preview) throw new Error("preview button missing");
		await act(async () => {
			preview.dispatchEvent(new Event("click", { bubbles: true }));
		});
		const ui = useUiStore.getState();
		expect(ui.filePreview).toEqual({ kind: "path", path: REPORT, tabId: RUNTIME_TAB });
		expect(ui.panelVisible).toBe(true);
		expect(ui.panelTab).toBe("files");
		expect(opened).toEqual([]);
	});

	it.each([
		["a failed job", { isError: true }],
		["a partial result", { isPartial: true }],
	])("offers no preview for %s", (_label, overrides) => {
		const Renderer = getToolRenderer("office_report");
		const markup = staticMarkup(<Renderer args={{}} result={reportResult()} {...overrides} />);
		expect(markup).not.toContain(">Preview<");
	});

	const fallbacks: [string, string, Partial<ToolRendererProps>][] = [
		["malformed JSON", "office_report", { result: officeResult("{not json") }],
		["a failed job", "office_report", { result: reportResult(), isError: true }],
		["a partial result", "office_report", { result: reportResult(), isPartial: true }],
		[
			"a file outside the Sai ATLAS folder",
			"office_report",
			{ result: reportResult({ file: "/home/u/.config/autostart/a.docx" }) },
		],
		["a kind that does not match the extension", "office_report", { result: reportResult({ kind: "xlsx" }) }],
		["a docx result on the slides tool", "office_slides", { result: reportResult() }],
		["an extra JSON key", "office_report", { result: reportResult({ extra: "x" }) }],
		[
			"a path that climbs out of the folder",
			"office_report",
			{ result: reportResult({ file: "/home/u/Documents/Sai ATLAS/../Sai ATLAS/a.docx" }) },
		],
		["a relative path", "office_report", { result: reportResult({ file: "Sai ATLAS/a.docx" }) }],
		["a non-string check", "office_report", { result: reportResult({ check: 3 }) }],
	];

	it.each(fallbacks)("falls back to the generic view for %s", (_label, tool, overrides) => {
		const props: ToolRendererProps = { args: { markdown: "# Report" }, result: undefined, ...overrides };
		const Renderer = getToolRenderer(tool);
		const markup = staticMarkup(<Renderer {...props} />);
		expect(markup).not.toContain("data-office-file");
		expect(markup).toBe(staticMarkup(<GenericRenderer {...props} />));
	});

	it.each(["office_report", "office_slides", "office_clean"])("registers a dedicated renderer for %s", name => {
		expect(getToolRenderer(name)).not.toBe(GenericRenderer);
	});

	it("shows a slide deck and a cleaned spreadsheet on their own tools", async () => {
		const Slides = getToolRenderer("office_slides");
		const deck = "/home/u/Documents/Sai ATLAS/Deck.pptx";
		const slides = staticMarkup(
			<Slides args={{}} result={officeResult({ file: deck, kind: "pptx", check: "5 slides" })} />,
		);
		expect(slides).toContain("data-office-file");
		expect(slides).toContain("Deck.pptx");
		const Clean = getToolRenderer("office_clean");
		const sheet = "/home/u/Documents/Sai ATLAS/Sales (cleaned).xlsx";
		const clean = staticMarkup(
			<Clean args={{}} result={officeResult({ file: sheet, kind: "xlsx", check: "40 rows" })} />,
		);
		expect(clean).toContain("data-office-file");
		expect(clean).toContain("Sales (cleaned).xlsx");
	});
});
