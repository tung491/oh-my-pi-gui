import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpApi } from "../../shared/ipc-types";
import { dragCarriesFiles, droppedFilePaths, hasDroppedFiles, isFileDrag, resolveDroppedPaths } from "./dropped-files";

interface FakeDrop {
	types?: string[];
	uriList?: string;
	files?: File[];
	getDataThrows?: boolean;
}

/** The parts of a DataTransfer the module reads. */
function dataTransfer({ types = ["Files"], uriList = "", files = [], getDataThrows = false }: FakeDrop): DataTransfer {
	const fake = {
		types,
		files,
		getData(format: string): string {
			if (getDataThrows) throw new Error("getData outside the drop event");
			return format === "text/uri-list" ? uriList : "";
		},
	};
	// The fake implements only the members droppedFilePaths/isFileDrag touch.
	return fake as unknown as DataTransfer;
}

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;

function setBareShell(): void {
	globals.window = { omp: { system: {} } };
}

/** A Tauri-like `window.omp` whose native drop paths the test pushes; the window takes events. */
function nativeShell(): {
	push: (paths: string[]) => void;
	subscriptions: () => number;
	dispatch: (type: "drop" | "dragend") => void;
} {
	let listener: ((paths: string[]) => void) | null = null;
	let subscriptions = 0;
	const system: Partial<OmpApi["system"]> = {
		onNativeDropPaths: callback => {
			subscriptions += 1;
			listener = callback;
			return () => {
				listener = null;
			};
		},
	};
	const target = new EventTarget();
	globals.window = Object.assign(target, { omp: { system } });
	return {
		push: paths => listener?.(paths),
		subscriptions: () => subscriptions,
		dispatch: type => target.dispatchEvent(new Event(type)),
	};
}

/** A WebKitGTK file drop as the page sees it: uri-list listed but empty, no files. */
const webkitDrop = () => dataTransfer({ types: ["text/uri-list", "text/html"] });

afterEach(() => {
	vi.useRealTimers();
	globals.window = originalWindow;
});

describe("isFileDrag", () => {
	it("is true only for drags that carry files", () => {
		setBareShell();
		expect(isFileDrag(dataTransfer({ types: ["text/uri-list", "Files"] }))).toBe(true);
		expect(isFileDrag(dataTransfer({ types: ["text/uri-list", "text/html"] }))).toBe(true);
		expect(isFileDrag(dataTransfer({ types: ["application/x-omp-tab"] }))).toBe(false);
		expect(isFileDrag(dataTransfer({ types: ["text/plain"] }))).toBe(false);
		expect(isFileDrag(null)).toBe(false);
	});
});

describe("droppedFilePaths", () => {
	it("decodes file URIs with spaces and Unicode names", () => {
		setBareShell();
		const uriList = [
			"file:///home/u/My%20Report.pdf",
			"file:///home/u/T%C3%A0i%20li%E1%BB%87u/b%C3%A1o%20c%C3%A1o.docx",
		].join("\r\n");
		expect(droppedFilePaths(dataTransfer({ uriList }))).toEqual([
			"/home/u/My Report.pdf",
			"/home/u/Tài liệu/báo cáo.docx",
		]);
	});

	it("skips comment lines, blank lines and non-file URIs", () => {
		setBareShell();
		const uriList = [
			"# dragged from the file manager",
			"",
			"https://example.com/a.pdf",
			"file:///tmp/a.pdf",
			"file://server/share/b.pdf",
			"file://localhost/tmp/c.png",
			"not a uri",
		].join("\n");
		expect(droppedFilePaths(dataTransfer({ uriList }))).toEqual(["/tmp/a.pdf", "/tmp/c.png"]);
	});

	it("removes duplicates and keeps drop order", () => {
		setBareShell();
		const uriList = "file:///b.txt\nfile:///a.txt\nfile:///b.txt\nfile:///a.txt";
		expect(droppedFilePaths(dataTransfer({ uriList }))).toEqual(["/b.txt", "/a.txt"]);
	});

	it("survives getData throwing", () => {
		setBareShell();
		expect(droppedFilePaths(dataTransfer({ files: [new File(["x"], "a.pdf")], getDataThrows: true }))).toEqual([]);
	});

	it("returns nothing without a URI list", () => {
		setBareShell();
		expect(droppedFilePaths(dataTransfer({ files: [new File(["x"], "a.pdf")] }))).toEqual([]);
	});
});

describe("resolveDroppedPaths", () => {
	it("returns the page's own paths without touching native ones", async () => {
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/native.pdf"]);
		expect(await resolveDroppedPaths(dataTransfer({ uriList: "file:///page.pdf" }))).toEqual(["/page.pdf"]);
		// The native paths are still there for a drop that needs them.
		expect(await resolveDroppedPaths(webkitDrop())).toEqual(["/native.pdf"]);
	});

	it("uses native paths that arrived before the drop, once", async () => {
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/home/u/a b.pdf", "/home/u/c.txt", "/home/u/a b.pdf"]);
		expect(await resolveDroppedPaths(webkitDrop())).toEqual(["/home/u/a b.pdf", "/home/u/c.txt"]);
		vi.useFakeTimers();
		const second = resolveDroppedPaths(webkitDrop());
		await vi.advanceTimersByTimeAsync(300);
		expect(await second).toEqual([]);
	});

	it("waits briefly for native paths that arrive after the drop", async () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		const pending = resolveDroppedPaths(webkitDrop());
		await vi.advanceTimersByTimeAsync(100);
		shell.push(["/late.png"]);
		expect(await pending).toEqual(["/late.png"]);
	});

	it("gives up after the wait and ignores paths from an earlier drag", async () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/stale.pdf"]);
		await vi.advanceTimersByTimeAsync(10_500);
		const pending = resolveDroppedPaths(webkitDrop());
		await vi.advanceTimersByTimeAsync(300);
		expect(await pending).toEqual([]);
		shell.push(["/too-late.pdf"]);
		expect(await resolveDroppedPaths(webkitDrop())).toEqual(["/too-late.pdf"]);
	});

	it("keeps native paths fresh while the file drag goes on", async () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/held.pdf"]);
		for (let i = 0; i < 5; i += 1) {
			await vi.advanceTimersByTimeAsync(4_000);
			isFileDrag(webkitDrop());
		}
		expect(await resolveDroppedPaths(webkitDrop())).toEqual(["/held.pdf"]);
	});

	it("subscribes once per window and lets an empty native push clear earlier paths", async () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		isFileDrag(webkitDrop());
		shell.push(["/abandoned.pdf"]);
		shell.push([]);
		const pending = resolveDroppedPaths(webkitDrop());
		await vi.advanceTimersByTimeAsync(300);
		expect(await pending).toEqual([]);
		expect(shell.subscriptions()).toBe(1);
	});

	it("resolves at once to nothing without a native source", async () => {
		setBareShell();
		expect(await resolveDroppedPaths(webkitDrop())).toEqual([]);
	});
});

describe("hasDroppedFiles", () => {
	it("is true for a drop whose URI list names a local file", () => {
		setBareShell();
		expect(hasDroppedFiles(dataTransfer({ types: ["text/uri-list"], uriList: "file:///home/u/a.pdf" }))).toBe(true);
	});

	it("is false for a link, plain text or nothing", () => {
		setBareShell();
		expect(hasDroppedFiles(dataTransfer({ types: ["text/uri-list"], uriList: "https://example.com/" }))).toBe(false);
		expect(hasDroppedFiles(dataTransfer({ types: ["text/plain"] }))).toBe(false);
		expect(hasDroppedFiles(null)).toBe(false);
	});

	it("sees fresh native paths without consuming them", async () => {
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		expect(hasDroppedFiles(webkitDrop())).toBe(false);
		shell.push(["/home/u/a.mp3"]);
		expect(hasDroppedFiles(webkitDrop())).toBe(true);
		expect(hasDroppedFiles(webkitDrop())).toBe(true);
		expect(await resolveDroppedPaths(webkitDrop())).toEqual(["/home/u/a.mp3"]);
		expect(hasDroppedFiles(webkitDrop())).toBe(false);
	});

	it("ignores native paths a link drag cleared or that went stale", () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/home/u/a.pdf"]);
		shell.push([]);
		expect(hasDroppedFiles(webkitDrop())).toBe(false);
		shell.push(["/home/u/b.pdf"]);
		vi.advanceTimersByTime(10_500);
		expect(hasDroppedFiles(webkitDrop())).toBe(false);
	});
});

describe("dragCarriesFiles", () => {
	it("is true for a Chromium drag listing Files", () => {
		setBareShell();
		expect(dragCarriesFiles(dataTransfer({ types: ["Files"] }))).toBe(true);
		expect(dragCarriesFiles(dataTransfer({ types: ["text/uri-list", "Files"] }))).toBe(true);
	});

	it("is false for a link, text, a tab or nothing", () => {
		setBareShell();
		expect(dragCarriesFiles(dataTransfer({ types: ["text/uri-list", "text/plain"] }))).toBe(false);
		expect(dragCarriesFiles(dataTransfer({ types: ["text/plain"] }))).toBe(false);
		expect(dragCarriesFiles(dataTransfer({ types: ["application/x-omp-tab"] }))).toBe(false);
		expect(dragCarriesFiles(null)).toBe(false);
	});

	it("claims a WebKitGTK URI-list drag only while the shell's native paths are fresh", () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		expect(dragCarriesFiles(webkitDrop())).toBe(false);
		shell.push(["/home/u/a.pdf"]);
		expect(dragCarriesFiles(webkitDrop())).toBe(true);
		// A link drag entering the window clears them.
		shell.push([]);
		expect(dragCarriesFiles(webkitDrop())).toBe(false);
		shell.push(["/home/u/b.pdf"]);
		vi.advanceTimersByTime(10_500);
		expect(dragCarriesFiles(webkitDrop())).toBe(false);
	});
});

describe("native paths outside a file drag", () => {
	const textDrop = () => dataTransfer({ types: ["text/plain", "text/html"] });
	const tabDrop = () => dataTransfer({ types: ["application/x-omp-tab"] });

	it("never serve a text or tab drop, and stay for the file drop they belong to", async () => {
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/home/u/abandoned.pdf"]);

		expect(hasDroppedFiles(textDrop())).toBe(false);
		expect(hasDroppedFiles(tabDrop())).toBe(false);
		expect(await resolveDroppedPaths(textDrop())).toEqual([]);
		expect(await resolveDroppedPaths(tabDrop())).toEqual([]);
		expect(await resolveDroppedPaths(webkitDrop())).toEqual(["/home/u/abandoned.pdf"]);
	});

	it("are retired by a drop anywhere in the window once its handlers ran", async () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/home/u/a.pdf"]);

		shell.dispatch("drop");
		// The drop's own handlers still see them.
		expect(hasDroppedFiles(webkitDrop())).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(hasDroppedFiles(webkitDrop())).toBe(false);
	});

	it("keep paths that arrive after a drop for the drop waiting on them", async () => {
		vi.useFakeTimers();
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		const pending = resolveDroppedPaths(webkitDrop());
		shell.dispatch("drop");
		shell.push(["/home/u/late.pdf"]);
		await vi.advanceTimersByTimeAsync(0);
		expect(await pending).toEqual(["/home/u/late.pdf"]);
	});

	it("are retired at once when a drag ends", () => {
		const shell = nativeShell();
		isFileDrag(webkitDrop());
		shell.push(["/home/u/a.pdf"]);

		shell.dispatch("dragend");
		expect(hasDroppedFiles(webkitDrop())).toBe(false);
	});
});
