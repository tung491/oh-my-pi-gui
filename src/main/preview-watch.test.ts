import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { OpenPathEnv } from "./open-path-resolve";
import { type DirWatchFactory, PREVIEW_WATCH_DEBOUNCE_MS, PreviewWatchRegistry } from "./preview-watch";

interface FakeDirWatch {
	dir: string;
	change: (filename: string | null) => void;
	closed: boolean;
}

/** A watch factory that records each folder watch and lets the test fire its events. */
function fakeWatches() {
	const watches: FakeDirWatch[] = [];
	const factory: DirWatchFactory = (dir, onChange) => {
		const watch: FakeDirWatch = { dir, change: onChange, closed: false };
		watches.push(watch);
		return {
			close: () => {
				watch.closed = true;
			},
		};
	};
	return { watches, factory };
}

const env: OpenPathEnv = {
	homedir: "/home/u",
	cwdFor: tabId => (tabId === undefined || tabId === "t1" ? "/w" : null),
};

function registry(factory: DirWatchFactory, debounceMs = PREVIEW_WATCH_DEBOUNCE_MS) {
	const emitted: Array<[number, string]> = [];
	let next = 0;
	const watches = new PreviewWatchRegistry({
		emit: (ownerId, watchId) => emitted.push([ownerId, watchId]),
		watchDir: factory,
		debounceMs,
		newId: () => `w${++next}`,
	});
	return { watches, emitted };
}

afterEach(() => {
	vi.useRealTimers();
});

test("preview watch fires once after changes settle", () => {
	vi.useFakeTimers();
	const { watches: dirs, factory } = fakeWatches();
	const { watches, emitted } = registry(factory);
	const result = watches.watch(1, { path: "docs/table.csv", tabId: "t1" }, env);
	expect(result).toEqual({ ok: true, watchId: "w1" });
	expect(dirs.map(watch => watch.dir)).toEqual(["/w/docs"]);

	dirs[0]?.change("table.csv");
	vi.advanceTimersByTime(1000);
	dirs[0]?.change("table.csv");
	vi.advanceTimersByTime(1000);
	dirs[0]?.change("table.csv");
	vi.advanceTimersByTime(PREVIEW_WATCH_DEBOUNCE_MS - 1);
	expect(emitted).toEqual([]);
	vi.advanceTimersByTime(1);
	expect(emitted).toEqual([[1, "w1"]]);
	vi.advanceTimersByTime(10_000);
	expect(emitted).toEqual([[1, "w1"]]);

	// A later change fires again, once.
	dirs[0]?.change(null);
	vi.advanceTimersByTime(PREVIEW_WATCH_DEBOUNCE_MS);
	expect(emitted).toEqual([
		[1, "w1"],
		[1, "w1"],
	]);
});

test("preview watch ignores other files in the folder", () => {
	vi.useFakeTimers();
	const { watches: dirs, factory } = fakeWatches();
	const { watches, emitted } = registry(factory);
	watches.watch(1, { path: "/data/table.csv" }, env);

	dirs[0]?.change("other.csv");
	dirs[0]?.change("table.csv.bak");
	dirs[0]?.change("table");
	vi.advanceTimersByTime(10_000);
	expect(emitted).toEqual([]);
});

test("preview watch survives an atomic rename save", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-watch-"));
	const file = path.join(directory, "table.csv");
	await fs.writeFile(file, "a,b\n");
	const emitted: string[] = [];
	const watches = new PreviewWatchRegistry({ emit: (_owner, watchId) => emitted.push(watchId), debounceMs: 50 });
	try {
		const result = watches.watch(1, { path: file }, env);
		expect(result.ok).toBe(true);

		const save = async (body: string) => {
			const temp = path.join(directory, ".table.csv.swp");
			await fs.writeFile(temp, body);
			await fs.rename(temp, file);
		};
		await save("a,b\n1,2\n");
		await expect.poll(() => emitted.length, { timeout: 5_000 }).toBe(1);

		// The replaced file is a new inode; the folder watch still sees the next save and a delete + recreate.
		await save("a,b\n1,2\n3,4\n");
		await expect.poll(() => emitted.length, { timeout: 5_000 }).toBe(2);
		await fs.rm(file);
		await fs.writeFile(file, "fresh\n");
		await expect.poll(() => emitted.length, { timeout: 5_000 }).toBe(3);
		expect(new Set(emitted)).toEqual(new Set([result.watchId]));
	} finally {
		watches.closeAll();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("preview watch refuses a relative path outside the workspace", () => {
	const { watches: dirs, factory } = fakeWatches();
	const { watches } = registry(factory);
	expect(watches.watch(1, { path: "../elsewhere/table.csv", tabId: "t1" }, env)).toEqual({
		ok: false,
		error: "outside-workspace",
	});
	expect(watches.watch(1, { path: "" }, env)).toEqual({ ok: false, error: "invalid-path" });
	expect(watches.watch(1, null, env)).toEqual({ ok: false, error: "invalid-path" });
	expect(dirs).toEqual([]);

	// A folder that cannot be watched answers `unavailable`.
	const failing = new PreviewWatchRegistry({
		emit: () => undefined,
		watchDir: () => {
			throw new Error("ENOENT");
		},
	});
	expect(failing.watch(1, { path: "/missing/table.csv" }, env)).toEqual({ ok: false, error: "unavailable" });
});

test("preview watch refuses an unknown tab", () => {
	const { watches: dirs, factory } = fakeWatches();
	const { watches } = registry(factory);
	expect(watches.watch(1, { path: "table.csv", tabId: "nope" }, env)).toEqual({ ok: false, error: "no-workspace" });
	expect(dirs).toEqual([]);
	// `~/` and absolute paths need no workspace, as with fs:read-document.
	expect(watches.watch(1, { path: "~/table.csv", tabId: "nope" }, env).ok).toBe(true);
	expect(dirs.map(watch => watch.dir)).toEqual(["/home/u"]);
});

test("preview watch closes the oldest beyond eight per window", () => {
	vi.useFakeTimers();
	const { watches: dirs, factory } = fakeWatches();
	const { watches, emitted } = registry(factory);
	const other = watches.watch(2, { path: "/other/x.csv" }, env);
	const ids: string[] = [];
	for (let index = 0; index < 9; index += 1) {
		const result = watches.watch(1, { path: `/data/f${index}.csv` }, env);
		if (result.watchId) ids.push(result.watchId);
	}
	expect(ids).toHaveLength(9);
	expect(dirs.filter(watch => watch.closed).map(watch => watch.dir)).toEqual(["/data"]);
	expect(dirs[1]?.closed).toBe(true);
	expect(dirs[0]?.closed).toBe(false);

	dirs[1]?.change("f0.csv");
	dirs[2]?.change("f1.csv");
	dirs[0]?.change("x.csv");
	vi.advanceTimersByTime(PREVIEW_WATCH_DEBOUNCE_MS);
	expect(emitted).toEqual([
		[1, ids[1]],
		[2, other.watchId],
	]);

	watches.closeOwner(1);
	expect(dirs.slice(1).every(watch => watch.closed)).toBe(true);
	expect(dirs[0]?.closed).toBe(false);
});

test("preview unwatch stops further events", () => {
	vi.useFakeTimers();
	const { watches: dirs, factory } = fakeWatches();
	const { watches, emitted } = registry(factory);
	const { watchId } = watches.watch(1, { path: "/data/table.csv" }, env);
	if (!watchId) throw new Error("watch failed");

	dirs[0]?.change("table.csv");
	// Another window cannot close this watch.
	watches.unwatch(2, watchId);
	expect(dirs[0]?.closed).toBe(false);
	watches.unwatch(1, watchId);
	expect(dirs[0]?.closed).toBe(true);
	dirs[0]?.change("table.csv");
	vi.advanceTimersByTime(10_000);
	expect(emitted).toEqual([]);
	// Unknown ids are a no-op.
	watches.unwatch(1, watchId);
	watches.unwatch(1, "never");
});
