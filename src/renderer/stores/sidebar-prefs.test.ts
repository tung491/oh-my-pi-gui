/**
 * sidebar-prefs store contract: session pins, session MRU access times,
 * workspace aliases, persistence payloads, and hydrate-from-blob. A rejected
 * prefs write must undo the optimistic toggle (the sidebar would otherwise show
 * a pin that disappears on the next launch).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../lib/i18n";
import { useSidebarPrefs } from "./sidebar-prefs";
import { useToastStore } from "./toast";

const get = vi.fn(async (_key: string) => null as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set } } };

afterEach(() => {
	get.mockClear();
	set.mockClear();
	useSidebarPrefs.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("sidebar-prefs store", () => {
	it("toggles session pins, persisting each change", () => {
		useSidebarPrefs.getState().toggleSessionPin("/s/one.jsonl");
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ pinnedSessions: ["/s/one.jsonl"] }));
		useSidebarPrefs.getState().toggleSessionPin("/s/two.jsonl");
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/one.jsonl", "/s/two.jsonl"]);
		useSidebarPrefs.getState().toggleSessionPin("/s/one.jsonl");
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/two.jsonl"]);
	});

	it("sets and clears workspace aliases, dropping empty values", () => {
		useSidebarPrefs.getState().setGroupAlias("/work/a", "  Frontend  ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ groupAliases: { "/work/a": "Frontend" } }));

		useSidebarPrefs.getState().setGroupAlias("/work/a", null);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});

		useSidebarPrefs.getState().setGroupAlias("/work/a", "   ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});
	});

	it("touches sessions with a monotonic persisted MRU clock", () => {
		useSidebarPrefs.setState({ sessionLastUsed: { "/sessions/old.jsonl": 30 } });

		useSidebarPrefs.getState().touchSession("/sessions/new.jsonl");
		const sessionTimestamp = useSidebarPrefs.getState().sessionLastUsed["/sessions/new.jsonl"];
		expect(sessionTimestamp).toBeGreaterThan(30);
		expect(set).toHaveBeenLastCalledWith(
			"sidebar",
			expect.objectContaining({
				sessionLastUsed: expect.objectContaining({ "/sessions/new.jsonl": sessionTimestamp }),
			}),
		);

		useSidebarPrefs.getState().touchSession("/sessions/old.jsonl");
		expect(useSidebarPrefs.getState().sessionLastUsed["/sessions/old.jsonl"]).toBeGreaterThan(sessionTimestamp ?? 0);
	});

	it("hydrates from the persisted blob once and tolerates missing prefs", async () => {
		get.mockResolvedValueOnce({
			pinnedSessions: ["/s/p.jsonl"],
			groupAliases: { "/work/a": "Alias" },
			sessionLastUsed: { "/s/p.jsonl": 200, bad: -1 },
		});
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/p.jsonl"]);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Alias" });
		expect(useSidebarPrefs.getState().sessionLastUsed).toEqual({ "/s/p.jsonl": 200 });

		// Second hydrate is a no-op (already hydrated).
		const calls = get.mock.calls.length;
		await useSidebarPrefs.getState().hydrate();
		expect(get.mock.calls.length).toBe(calls);

		// Unreadable prefs degrade to empty defaults, never a throw.
		useSidebarPrefs.getState().reset();
		get.mockRejectedValueOnce(new Error("io"));
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual([]);
	});

	it("ignores the retired pinnedGroups and workspaceLastUsed fields of a stored blob", async () => {
		get.mockResolvedValueOnce({
			pinnedGroups: ["/work/pinned"],
			pinnedSessions: ["/s/p.jsonl"],
			groupAliases: { "/work/a": "Alias" },
			workspaceLastUsed: { "/work/a": 100 },
			sessionLastUsed: { "/s/p.jsonl": 200 },
		});
		await useSidebarPrefs.getState().hydrate();
		const state = useSidebarPrefs.getState() as unknown as Record<string, unknown>;
		expect(state.hydrated).toBe(true);
		expect(state.pinnedSessions).toEqual(["/s/p.jsonl"]);
		expect(state.groupAliases).toEqual({ "/work/a": "Alias" });
		for (const retired of ["pinnedGroups", "workspaceLastUsed", "toggleGroupPin", "touchWorkspace"]) {
			expect(retired in state).toBe(false);
		}

		useSidebarPrefs.getState().touchSession("/s/p.jsonl");
		const written = set.mock.calls.at(-1)?.[1] as Record<string, unknown>;
		expect(Object.keys(written).sort()).toEqual(["groupAliases", "pinnedSessions", "sessionLastUsed"]);
	});

	it("rolls back a session pin when the prefs write is rejected", async () => {
		useSidebarPrefs.setState({ pinnedSessions: ["/s/kept.jsonl"] });
		set.mockRejectedValueOnce(new Error("disk full"));

		await useSidebarPrefs.getState().toggleSessionPin("/s/a.jsonl");

		expect(set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({ pinnedSessions: ["/s/kept.jsonl", "/s/a.jsonl"] }),
		);
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/kept.jsonl"]);
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({ variant: "error", title: translate("sidebar.pinFailed"), message: "disk full" }),
		);
	});

	it("keeps an earlier pin and reports a rename that the store refused to save", async () => {
		useSidebarPrefs.setState({ pinnedSessions: ["/s/kept.jsonl"], groupAliases: { "/work/a": "Frontend" } });
		set.mockRejectedValueOnce(new Error("EPERM"));

		await useSidebarPrefs.getState().setGroupAlias("/work/a", "Platform");

		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/kept.jsonl"]);
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({ variant: "error", title: translate("sidebar.renameFailed"), message: "EPERM" }),
		);
	});
});
