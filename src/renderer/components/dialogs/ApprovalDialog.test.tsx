import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ApprovalDialog, normalizePosixPath, parseApprovalTitle } from "./ApprovalDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const realLocalStorage = globals.localStorage;
let root: Root | null = null;
let container: Element | null = null;

/** Seeds the language the i18n provider starts in. */
function setLanguage(lang: "en" | "vi"): void {
	globals.localStorage = {
		getItem: (key: string) => (key === "omp.lang" ? lang : null),
		setItem: () => {},
		removeItem: () => {},
	};
}

async function showApproval(title: string): Promise<string> {
	const host = document.createElement("div") as unknown as Element;
	document.body.appendChild(host as never);
	container = host;
	root = createRoot(host);
	const mounted = root;
	await act(async () => {
		mounted.render(
			<I18nProvider>
				<ApprovalDialog
					onRespond={() => {}}
					request={{
						type: "extension_ui_request",
						id: "a",
						method: "select",
						title,
						options: ["Approve", "Deny"],
					}}
				/>
			</I18nProvider>,
		);
	});
	const sentence = document.querySelector("[data-approval-sentence]");
	if (!sentence) throw new Error("approval sentence missing");
	return sentence.textContent ?? "";
}

afterEach(async () => {
	const mounted = root;
	if (mounted) await act(async () => mounted.unmount());
	container?.remove();
	container = null;
	root = null;
	document.body.innerHTML = "";
	globals.localStorage = realLocalStorage;
});

const WRITE_TITLE = "Allow tool: write\nPath: /home/u/Documents/Sai ATLAS/notes.md\nContent:\n# Notes\nline two";

describe("parseApprovalTitle", () => {
	it("reads the tool, the path and the details of a write", () => {
		expect(parseApprovalTitle(WRITE_TITLE)).toEqual({
			toolName: "write",
			reason: undefined,
			path: "/home/u/Documents/Sai ATLAS/notes.md",
			details: "Path: /home/u/Documents/Sai ATLAS/notes.md\nContent:\n# Notes\nline two",
		});
	});

	it("reads the reason line", () => {
		expect(parseApprovalTitle("Allow tool: open_item\nReason: Open your Downloads folder\nkind: folder")).toEqual({
			toolName: "open_item",
			reason: "Open your Downloads folder",
			path: undefined,
			details: "Reason: Open your Downloads folder\nkind: folder",
		});
	});

	it("reads a bare title", () => {
		expect(parseApprovalTitle("Allow tool: office_report")).toEqual({
			toolName: "office_report",
			reason: undefined,
			path: undefined,
			details: "",
		});
	});

	it("resolves dot segments in a POSIX path", () => {
		expect(normalizePosixPath("/home/u/Documents/Sai ATLAS/../../.config/autostart/x.desktop")).toBe(
			"/home/u/.config/autostart/x.desktop",
		);
		expect(normalizePosixPath("/a/./b//c/")).toBe("/a/b/c");
		expect(normalizePosixPath("/../a")).toBe("/a");
		expect(normalizePosixPath("a/../../b")).toBe("../b");
	});
});

describe("ApprovalDialog sentence", () => {
	const cases: [string, string, string, string][] = [
		[
			"the reason the tool gives",
			"Allow tool: os_setting\nReason: Turn on night light\npanel: display",
			"Turn on night light",
			"Turn on night light",
		],
		[
			"a file save, with the resolved path",
			"Allow tool: write\nPath: /home/u/Documents/Sai ATLAS/../../.config/autostart/x.desktop\nContent:\n[Desktop Entry]",
			"Save a file to /home/u/.config/autostart/x.desktop?",
			"Lưu tệp vào /home/u/.config/autostart/x.desktop?",
		],
		[
			"a Word report",
			"Allow tool: office_report",
			"Sai ATLAS wants to make a Word report. Allow it?",
			"Sai ATLAS muốn tạo báo cáo Word. Cho phép không?",
		],
		[
			"a slide deck",
			"Allow tool: office_slides",
			"Sai ATLAS wants to make a slide deck. Allow it?",
			"Sai ATLAS muốn tạo bộ slide. Cho phép không?",
		],
		[
			"a cleaned spreadsheet",
			"Allow tool: office_clean",
			"Sai ATLAS wants to make a cleaned copy of a spreadsheet. Allow it?",
			"Sai ATLAS muốn tạo bản sao đã dọn dẹp của bảng tính. Cho phép không?",
		],
		[
			"any other tool, by name",
			"Allow tool: diagnose\ncheck: disk",
			"Sai ATLAS wants to diagnose. Allow it?",
			"Sai ATLAS muốn diagnose. Cho phép không?",
		],
	];

	it.each(cases)("states %s in English", async (_label, title, english) => {
		setLanguage("en");
		expect(await showApproval(title)).toBe(english);
	});

	it.each(cases)("states %s in Vietnamese", async (_label, title, _english, vietnamese) => {
		setLanguage("vi");
		expect(await showApproval(title)).toBe(vietnamese);
	});

	it("shows a path with replacement patterns verbatim", async () => {
		setLanguage("en");
		expect(await showApproval("Allow tool: write\nPath: /home/u/$&$'.md\nContent:\nx")).toBe(
			"Save a file to /home/u/$&$'.md?",
		);
	});

	it("keeps the raw request in a collapsed details block", async () => {
		setLanguage("en");
		await showApproval(WRITE_TITLE);
		const details = document.querySelector("details");
		expect(details?.hasAttribute("open")).toBe(false);
		expect(details?.querySelector("pre")?.textContent).toBe(
			"Path: /home/u/Documents/Sai ATLAS/notes.md\nContent:\n# Notes\nline two",
		);
	});
});
