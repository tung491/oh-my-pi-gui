import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ApprovalDialog, normalizePosixPath, parseApprovalTitle, resolveWritePath } from "./ApprovalDialog";

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

async function showApproval(
	title: string,
	where: { cwd: string; homeDir: string } = { cwd: "/home/u/Documents", homeDir: "/home/u" },
): Promise<string> {
	const host = document.createElement("div") as unknown as Element;
	document.body.appendChild(host as never);
	container = host;
	root = createRoot(host);
	const mounted = root;
	await act(async () => {
		mounted.render(
			<I18nProvider>
				<ApprovalDialog
					cwd={where.cwd}
					homeDir={where.homeDir}
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

describe("resolveWritePath", () => {
	const where = { cwd: "/home/u/Documents", homeDir: "/home/u" };
	const details = (path: string, content = "x") => `Path: ${path}\nContent:\n${content}`;

	it("resolves an absolute path with dot segments", () => {
		expect(resolveWritePath(details("/home/u/Documents/Sai ATLAS/../../.config/x.desktop"), where)).toBe(
			"/home/u/.config/x.desktop",
		);
	});

	it("resolves a relative path against the session folder", () => {
		expect(resolveWritePath(details("../../.config/autostart/x.desktop"), where)).toBe(
			"/home/.config/autostart/x.desktop",
		);
		expect(resolveWritePath(details("Sai ATLAS/notes.md"), where)).toBe("/home/u/Documents/Sai ATLAS/notes.md");
	});

	it("expands the home folder the way the agent does", () => {
		expect(resolveWritePath(details("~/notes.md"), where)).toBe("/home/u/notes.md");
		expect(resolveWritePath(details("~"), where)).toBe("/home/u");
		expect(resolveWritePath(details("~notes.md"), where)).toBe("/home/u/notes.md");
		expect(resolveWritePath(details("@~/notes.md"), where)).toBe("/home/u/notes.md");
		expect(resolveWritePath(details(":~/notes.md"), where)).toBe("/home/u/notes.md");
		expect(resolveWritePath(details("@/tmp/notes.md"), where)).toBe("/tmp/notes.md");
	});

	it("refuses a path with a newline in it", () => {
		const payload = "/home/u/Documents/Sai ATLAS/notes.md\n../../../../.config/autostart/x.desktop";
		expect(resolveWritePath(details(payload), where)).toBeNull();
	});

	it("refuses a path that hides a second Content line", () => {
		const payload = "/home/u/Documents/Sai ATLAS/notes.md\nContent:\n../../../../.config/autostart/x.desktop";
		expect(resolveWritePath(details(payload), where)).toBeNull();
	});

	it("refuses a path the agent cut short", () => {
		const long = `/home/u/Documents/Sai ATLAS/${"a".repeat(1990)}`;
		expect(resolveWritePath(details(`${long.slice(0, 2000)}[…37ch elided…]`), where)).toBeNull();
	});

	it("refuses a path with a control character", () => {
		expect(resolveWritePath(details("/home/u/notes\r.md"), where)).toBeNull();
		expect(resolveWritePath(details("/home/u/notes\u0000.md"), where)).toBeNull();
		expect(resolveWritePath(details("/home/u/notes\u2028.md"), where)).toBeNull();
	});

	it("refuses a path it cannot resolve the way the agent would", () => {
		expect(resolveWritePath(details("notes.md"), { cwd: "", homeDir: "/home/u" })).toBeNull();
		expect(resolveWritePath(details("~/notes.md"), { cwd: "/home/u", homeDir: "" })).toBeNull();
		expect(resolveWritePath(details("file:///home/u/notes.md"), where)).toBeNull();
		expect(resolveWritePath(details("skill://word-report/x.md"), where)).toBeNull();
		expect(resolveWritePath(details("[notes.md#AB12]"), where)).toBeNull();
		expect(resolveWritePath(details("/home/u/notes\u00a0x.md"), where)).toBeNull();
		expect(resolveWritePath(details("C:\\notes.md"), where)).toBeNull();
		expect(resolveWritePath(details("/"), where)).toBeNull();
		expect(resolveWritePath(details(""), where)).toBeNull();
		expect(resolveWritePath("Content:\nx", where)).toBeNull();
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

	it.each([
		["a relative", "../../.config/autostart/x.desktop", "/home/.config/autostart/x.desktop"],
		["a home", "~/notes.md", "/home/u/notes.md"],
	])("names the resolved file for %s path", async (_label, path, resolved) => {
		setLanguage("en");
		expect(await showApproval(`Allow tool: write\nPath: ${path}\nContent:\nx`)).toBe(`Save a file to ${resolved}?`);
	});

	it.each([
		["a newline", "/home/u/Documents/Sai ATLAS/notes.md\n../../../../.config/autostart/x.desktop"],
		["a second Content line", "/home/u/Documents/Sai ATLAS/notes.md\nContent:\n../../.config/autostart/x.desktop"],
		["a cut-short name", `/home/u/Documents/Sai ATLAS/${"a".repeat(1972)}[…40ch elided…]`],
	])("warns about a write path with %s and opens the full request", async (_label, path) => {
		const title = `Allow tool: write\nPath: ${path}\nContent:\n[Desktop Entry]`;
		setLanguage("en");
		const sentence = await showApproval(title);
		expect(sentence).toBe(
			"Sai ATLAS wants to save a file, but its name is unusual and could hide where it really goes. Read the full request below before you approve.",
		);
		expect(sentence).not.toContain("notes.md");
		expect(document.querySelector("[data-approval-warning]")).not.toBeNull();
		const details = document.querySelector("details");
		expect(details?.hasAttribute("open")).toBe(true);
		expect(details?.querySelector("pre")?.textContent).toContain(path);
	});

	it("warns in Vietnamese too", async () => {
		setLanguage("vi");
		expect(await showApproval("Allow tool: write\nPath: /a/b.md\n../../c\nContent:\nx")).toBe(
			"Sai ATLAS muốn lưu một tệp, nhưng tên tệp bất thường và có thể che giấu nơi tệp thực sự được lưu. Hãy đọc toàn bộ yêu cầu bên dưới trước khi cho phép.",
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
