/**
 * RepositoryChanges refresh contract (linkedom, same pattern as
 * QueuePanel.test.tsx): the header refresh re-reads the checkout WITHOUT
 * wiping the file list. A reload is not an initial load — if the second read
 * fails, the rows that loaded successfully stay on screen under the error,
 * instead of the panel collapsing to "Loading" and then nothing.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcGitChanges, RpcGitDiff } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { RepositoryChanges } from "./RepositoryChanges";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");

interface TestElement {
	disabled: boolean;
	textContent: string | null;
	children: ArrayLike<TestElement>;
	remove: () => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
	querySelectorAll: (selector: string) => ArrayLike<TestElement>;
}

function changes(...paths: string[]): RpcGitChanges {
	return {
		isRepo: true,
		root: "/work",
		base: "main",
		files: paths.map(path => ({ path, status: "M" })),
		truncated: false,
	};
}

let getGitChanges: Mock<() => Promise<unknown>>;

function installMockOmp(next: () => Promise<unknown>): void {
	getGitChanges = vi.fn(next);
	(window as unknown as { omp: { rpc: { getGitChanges: Mock } } }).omp = {
		rpc: { getGitChanges },
	};
}

let getGitDiff: Mock<(path: string) => Promise<unknown>>;
let openPath: Mock<(path: string) => Promise<{ ok: boolean; error?: string }>>;

/**
 * Bridge for the open-in-editor flow: one changes snapshot, one diff answer
 * per path (`null` leaves the preview loading forever), and the host platform.
 */
function installWorkspaceOmp(
	data: RpcGitChanges,
	previews: Record<string, RpcGitDiff | null>,
	platform?: string,
): void {
	getGitChanges = vi.fn(async () => ({ type: "response", command: "get_git_changes", success: true, data }));
	getGitDiff = vi.fn((path: string) => {
		const preview = previews[path];
		if (!preview) return new Promise<never>(() => {});
		return Promise.resolve({ type: "response", command: "get_git_diff", success: true, data: preview });
	});
	openPath = vi.fn(async () => ({ ok: true }));
	(window as unknown as { omp: unknown }).omp = {
		rpc: { getGitChanges, getGitDiff },
		system: { openPath },
		...(platform ? { platform } : {}),
	};
}

function repo(files: RpcGitChanges["files"], root = "/repo", truncated = false): RpcGitChanges {
	return { isRepo: true, root, base: "main", files, truncated };
}

function textPreview(path: string, kind: RpcGitDiff["kind"] = "text"): RpcGitDiff {
	return { path, kind, diff: kind === "text" ? "@@ -1,1 +1,2 @@\n a\n+b" : "", truncated: false };
}

let root: ReturnType<typeof createRoot>;
let container: TestElement;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RepositoryChanges />
			</I18nProvider>,
		);
	});
	await flush();
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

/**
 * Accessible name as a browser computes it for this markup: the row is a flex
 * container, so its children are block-level and their texts join with a space.
 */
function accessibleName(element: TestElement): string {
	const label = element.getAttribute("aria-label");
	if (label) return label;
	return Array.from(element.children)
		.filter(child => child.getAttribute("aria-hidden") !== "true")
		.map(child => (child.textContent ?? "").trim())
		.filter(Boolean)
		.join(" ");
}

function fileRow(path: string): TestElement {
	const match = queryAll("button").find(button => (button.textContent ?? "").includes(path));
	if (!match) throw new Error(`file row ${path} not found`);
	return match;
}

function footer(): TestElement {
	const match = queryAll("footer")[0];
	if (!match) throw new Error("footer not found");
	return match;
}

function openButton(): TestElement {
	const match = Array.from(footer().querySelectorAll("button")).find(
		button => (button.textContent ?? "").trim() === "Open in editor",
	);
	if (!match) throw new Error("Open in editor button not found");
	return match;
}

async function select(path: string): Promise<void> {
	await click(fileRow(path));
	await flush();
}

const SCRIPT_TITLE = "Script files can run when opened, so open this one from your editor.";

function refreshButton(): TestElement {
	const match = queryAll("button").find(button => button.getAttribute("title") === "Refresh");
	if (!match) throw new Error("refresh button not found");
	return match;
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
});

describe("RepositoryChanges", () => {
	it("keeps the loaded file list on screen when a refresh fails", async () => {
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts"),
		}));
		await mount();
		expect(bodyText()).toContain("src/a.ts");
		expect(getGitChanges).toHaveBeenCalledTimes(1);

		getGitChanges.mockResolvedValueOnce({
			type: "response",
			command: "get_git_changes",
			success: false,
			error: "git status failed",
		});
		await click(refreshButton());
		await flush();

		// The user was looking at real changes; a failed re-read may not turn the
		// panel into an empty "clean tree".
		expect(bodyText()).toContain("src/a.ts");
		expect(bodyText()).not.toContain("No net changes in this checkout.");
		expect(bodyText()).toContain("git status failed");
	});

	it("replaces the rows when the retried refresh succeeds", async () => {
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts"),
		}));
		await mount();
		getGitChanges
			.mockResolvedValueOnce({
				type: "response",
				command: "get_git_changes",
				success: false,
				error: "git status failed",
			})
			.mockResolvedValueOnce({
				type: "response",
				command: "get_git_changes",
				success: true,
				data: changes("src/b.ts"),
			});
		await click(refreshButton());
		await flush();
		expect(bodyText()).toContain("git status failed");

		await click(refreshButton());
		await flush();

		expect(bodyText()).toContain("src/b.ts");
		expect(bodyText()).not.toContain("src/a.ts");
		expect(bodyText()).not.toContain("git status failed");
	});

	it("keeps each changed-file row named by its status and path only", async () => {
		installWorkspaceOmp(repo([{ path: "src/components/Preferences.tsx", status: "M" }]), {});
		await mount();

		const row = fileRow("src/components/Preferences.tsx");
		expect(accessibleName(row)).toBe("M src/components/Preferences.tsx");
		// No per-row counts or other text: the name is the whole row.
		expect(row.textContent).toBe("Msrc/components/Preferences.tsx");
	});

	it.each(["/repo", "/repo/"])("opens the previewed text file by its absolute path under %s", async repoRoot => {
		installWorkspaceOmp(repo([{ path: "src/a.ts", status: "M" }], repoRoot), { "src/a.ts": textPreview("src/a.ts") });
		await mount();
		await select("src/a.ts");

		expect(openButton().disabled).toBe(false);
		await click(openButton());
		await flush();

		expect(openPath).toHaveBeenCalledTimes(1);
		expect(openPath).toHaveBeenCalledWith("/repo/src/a.ts");
		expect(openPath.mock.calls[0]?.[0].startsWith("/repo/")).toBe(true);
	});

	it.each(["symlink", "binary"] as const)("keeps Open in editor disabled for a %s preview", async kind => {
		installWorkspaceOmp(repo([{ path: "src/a.ts", status: "M" }]), { "src/a.ts": textPreview("src/a.ts", kind) });
		await mount();
		await select("src/a.ts");

		expect(getGitDiff).toHaveBeenCalledWith("src/a.ts");
		expect(openButton().disabled).toBe(true);
		expect(openButton().getAttribute("title")).toBeNull();
		await click(openButton());
		await flush();
		expect(openPath).not.toHaveBeenCalled();
	});

	it("keeps Open in editor disabled until the selected file's preview has loaded", async () => {
		installWorkspaceOmp(repo([{ path: "src/a.ts", status: "M" }]), { "src/a.ts": null });
		await mount();
		expect(openButton().disabled).toBe(true);

		await select("src/a.ts");
		expect(getGitDiff).toHaveBeenCalledWith("src/a.ts");
		expect(openButton().disabled).toBe(true);
		await click(openButton());
		await flush();
		expect(openPath).not.toHaveBeenCalled();
	});

	it("keeps Open in editor disabled for a deleted file", async () => {
		installWorkspaceOmp(repo([{ path: "src/gone.ts", status: " D" }]), { "src/gone.ts": textPreview("src/gone.ts") });
		await mount();
		await select("src/gone.ts");

		expect(openButton().disabled).toBe(true);
		expect(openButton().getAttribute("title")).toBeNull();
		await click(openButton());
		await flush();
		expect(openPath).not.toHaveBeenCalled();
	});

	it.each(["scripts/run.command", "deploy.sh", "tools/Deploy.SH"])(
		"refuses to open the script %s and says why",
		async path => {
			installWorkspaceOmp(repo([{ path, status: "M" }]), { [path]: textPreview(path) });
			await mount();
			await select(path);

			expect(openButton().disabled).toBe(true);
			expect(openButton().getAttribute("title")).toBe(SCRIPT_TITLE);
			await click(openButton());
			await flush();
			expect(openPath).not.toHaveBeenCalled();
		},
	);

	it("reads the script extension from the file name, not from a folder", async () => {
		installWorkspaceOmp(repo([{ path: "dir.sh/readme", status: "M" }]), {
			"dir.sh/readme": textPreview("dir.sh/readme"),
		});
		await mount();
		await select("dir.sh/readme");

		expect(openButton().disabled).toBe(false);
		await click(openButton());
		await flush();
		expect(openPath).toHaveBeenCalledWith("/repo/dir.sh/readme");
	});

	it("opens a JavaScript file on mac, where it is not run by the default handler", async () => {
		installWorkspaceOmp(repo([{ path: "src/a.js", status: "M" }]), { "src/a.js": textPreview("src/a.js") });
		await mount();
		await select("src/a.js");

		expect(openButton().disabled).toBe(false);
		await click(openButton());
		await flush();
		expect(openPath).toHaveBeenCalledWith("/repo/src/a.js");
	});

	it("refuses to open a JavaScript file on Windows, where Windows Script Host runs it", async () => {
		installWorkspaceOmp(repo([{ path: "src/a.js", status: "M" }]), { "src/a.js": textPreview("src/a.js") }, "win32");
		await mount();
		await select("src/a.js");

		expect(openButton().disabled).toBe(true);
		expect(openButton().getAttribute("title")).toBe(SCRIPT_TITLE);
		await click(openButton());
		await flush();
		expect(openPath).not.toHaveBeenCalled();
	});

	it.each([
		["docs/Deploy.terminal", "darwin"],
		["links/home.webloc", "darwin"],
		["links/tool.fileloc", "linux"],
		["links/news.INETLOC", "linux"],
		["apps/launch.jnlp", "win32"],
		["scripts/build.py", "darwin"],
		["scripts/build.py", "win32"],
	])("refuses to open the launcher %s on %s", async (path, platform) => {
		installWorkspaceOmp(repo([{ path, status: "M" }]), { [path]: textPreview(path) }, platform);
		await mount();
		await select(path);

		expect(openButton().disabled).toBe(true);
		expect(openButton().getAttribute("title")).toBe(SCRIPT_TITLE);
		await click(openButton());
		await flush();
		expect(openPath).not.toHaveBeenCalled();
	});

	it.each([
		"links/site.url",
		"admin/console.msc",
		"remote/host.rdp",
		"apps/tool.appref-ms",
		"shell/Explorer.SCF",
		"search/repo.searchConnector-ms",
		"config/keys.reg",
		"drivers/setup.inf",
		"com/widget.sct",
	])("refuses to open %s on Windows, where the shell launches it", async path => {
		installWorkspaceOmp(repo([{ path, status: "M" }]), { [path]: textPreview(path) }, "win32");
		await mount();
		await select(path);

		expect(openButton().disabled).toBe(true);
		expect(openButton().getAttribute("title")).toBe(SCRIPT_TITLE);
		await click(openButton());
		await flush();
		expect(openPath).not.toHaveBeenCalled();
	});

	it("opens a .reg file on mac, where no shell handler imports it", async () => {
		installWorkspaceOmp(repo([{ path: "config/keys.reg", status: "M" }]), {
			"config/keys.reg": textPreview("config/keys.reg"),
		});
		await mount();
		await select("config/keys.reg");

		expect(openButton().disabled).toBe(false);
		await click(openButton());
		await flush();
		expect(openPath).toHaveBeenCalledWith("/repo/config/keys.reg");
	});

	it("counts the changed files in the footer, marking a truncated list", async () => {
		installWorkspaceOmp(repo([{ path: "src/a.ts", status: "M" }]), {});
		await mount();
		expect(footer().textContent).toContain("1 files changed");

		await act(async () => {
			root.unmount();
		});
		container.remove();
		installWorkspaceOmp(repo([{ path: "src/a.ts", status: "M" }], "/repo", true), {});
		await mount();
		expect(footer().textContent).toContain("1+ files changed");
	});
});
