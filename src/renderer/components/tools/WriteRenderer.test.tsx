import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { activeTabCommand, SessionRuntimeProvider } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { WriteRenderer } = await import("./WriteRenderer");

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useUiStore.setState({ filePreview: null, panelVisible: false, panelTab: "files" });
});

const DIFF = "@@ -1,2 +1,2 @@\n-1|const oldValue = true;\n+1|const newValue = true;\n 2|export {};\n";

async function expand(): Promise<void> {
	const toggle = container.querySelector('button[aria-expanded="false"]') as HTMLElement | null;
	await act(async () => {
		toggle?.click();
	});
}

describe("WriteRenderer", () => {
	it("create: content preview behind the toggle, no overwrite markers", async () => {
		await mount(<WriteRenderer args={{ path: "src/new.ts", content: "const a = 1;\n" }} result={{}} />);
		expect(container.textContent).toContain("new.ts");
		expect(container.textContent).not.toContain("Overwrote");
		expect(container.textContent).not.toContain("+1");

		await expand();
		expect(container.textContent).toContain("const a = 1;");
	});

	it("overwrite with diff: stats ride the header, toggle reveals the diff", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "src/existing.ts", content: "const newValue = true;\nexport {};\n" }}
				result={{
					content: [{ type: "text", text: "Successfully wrote 42 bytes to src/existing.ts" }],
					details: { overwritten: true, diff: DIFF, firstChangedLine: 1 },
				}}
			/>,
		);
		expect(container.textContent).toContain("+1");
		expect(container.textContent).toContain("−1");

		await expand();
		expect(container.textContent).toContain("const newValue = true;");
		// The removed line of the diff renders too — proving the diff view, not
		// the content preview, is what the toggle revealed.
		expect(container.textContent).toContain("const oldValue = true;");
	});

	it("overwrite without diff: warns instead of pretending it is a create", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "src/existing.ts", content: "same\n" }}
				result={{
					content: [{ type: "text", text: "Successfully wrote 5 bytes to src/existing.ts" }],
					details: { overwritten: true },
				}}
			/>,
		);
		expect(container.textContent).toContain("Overwrote existing file");

		// Content preview still available behind the toggle.
		await expand();
		expect(container.textContent).toContain("same");
	});

	it("accepts the file_path argument alias", async () => {
		await mount(<WriteRenderer args={{ file_path: "src/alias.ts", content: "x\n" }} result={{}} />);
		expect(container.textContent).toContain("alias.ts");
	});

	describe("preview button", () => {
		const RUNTIME_TAB = "tab-write";
		const runtime = { tabId: RUNTIME_TAB, command: activeTabCommand, stores: new Map() };
		const previewButton = () =>
			container.querySelector('button[aria-label="Preview notes.md"]') as HTMLElement | null;

		async function clickPreview(): Promise<void> {
			const button = previewButton();
			if (!button) throw new Error("preview button missing");
			await act(async () => {
				button.click();
			});
		}

		it("previews the resolved path of a finished write in the card's tab", async () => {
			await mount(
				<SessionRuntimeProvider runtime={runtime}>
					<WriteRenderer
						args={{ path: "docs/notes.md", content: "# Notes\n" }}
						result={{
							content: [{ type: "text", text: "Successfully wrote 8 bytes to docs/notes.md" }],
							details: { resolvedPath: "/work/docs/notes.md" },
						}}
					/>
				</SessionRuntimeProvider>,
			);
			await clickPreview();
			const ui = useUiStore.getState();
			expect(ui.filePreview).toEqual({ kind: "path", path: "/work/docs/notes.md", tabId: RUNTIME_TAB });
			expect(ui.panelVisible).toBe(true);
			expect(ui.panelTab).toBe("files");
		});

		it("falls back to the path argument without a resolved path", async () => {
			await mount(
				<SessionRuntimeProvider runtime={runtime}>
					<WriteRenderer args={{ path: "docs/notes.md", content: "# Notes\n" }} result={{}} />
				</SessionRuntimeProvider>,
			);
			await clickPreview();
			expect(useUiStore.getState().filePreview).toEqual({ kind: "path", path: "docs/notes.md", tabId: RUNTIME_TAB });
		});

		it("is absent while the write is still running", async () => {
			await mount(<WriteRenderer args={{ path: "docs/notes.md", content: "# Notes\n" }} result={{}} isPartial />);
			expect(previewButton()).toBeNull();
		});

		it("is absent when the write failed", async () => {
			await mount(
				<WriteRenderer
					args={{ path: "docs/notes.md", content: "# Notes\n" }}
					result={{ content: [{ type: "text", text: "EACCES" }] }}
					isError
				/>,
			);
			expect(previewButton()).toBeNull();
		});
	});
});
