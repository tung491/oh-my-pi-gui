import { describe, expect, it } from "vitest";
import { DEFAULT_TAB_HIBERNATION, isTabHibernationPrefKey, parseTabHibernationPref } from "./tab-hibernation";

describe("parseTabHibernationPref", () => {
	it("is off at 30 minutes when nothing is stored", () => {
		expect(parseTabHibernationPref(undefined)).toEqual({ enabled: false, idleMinutes: 30 });
		expect(DEFAULT_TAB_HIBERNATION).toEqual({ enabled: false, idleMinutes: 30 });
	});

	it("keeps a well-formed value", () => {
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: 45 })).toEqual({ enabled: true, idleMinutes: 45 });
	});

	it("never yields a zero-minute or unbounded sweep", () => {
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: 0 }).idleMinutes).toBe(5);
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: -10 }).idleMinutes).toBe(5);
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: 10_000 }).idleMinutes).toBe(240);
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: 7.6 }).idleMinutes).toBe(8);
	});

	it("falls back field by field on malformed values", () => {
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: Number.NaN })).toEqual({
			enabled: true,
			idleMinutes: 30,
		});
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: Number.POSITIVE_INFINITY }).idleMinutes).toBe(30);
		expect(parseTabHibernationPref({ enabled: true, idleMinutes: "30" }).idleMinutes).toBe(30);
		expect(parseTabHibernationPref({ enabled: "false", idleMinutes: 10 })).toEqual({
			enabled: false,
			idleMinutes: 10,
		});
		expect(parseTabHibernationPref({ enabled: 1 }).enabled).toBe(false);
		expect(parseTabHibernationPref("on")).toEqual({ enabled: false, idleMinutes: 30 });
		expect(parseTabHibernationPref([true, 10])).toEqual({ enabled: false, idleMinutes: 30 });
		expect(parseTabHibernationPref(null)).toEqual({ enabled: false, idleMinutes: 30 });
	});

	it("parses what a dotted write of one field leaves in the store", () => {
		// electron-store turns `tabHibernation.enabled` into a nested object
		// that may not carry the other field yet.
		expect(parseTabHibernationPref({ enabled: true })).toEqual({ enabled: true, idleMinutes: 30 });
		expect(parseTabHibernationPref({ idleMinutes: 15 })).toEqual({ enabled: false, idleMinutes: 15 });
	});
});

describe("isTabHibernationPrefKey", () => {
	it("matches the key and its dotted fields only", () => {
		expect(isTabHibernationPrefKey("tabHibernation")).toBe(true);
		expect(isTabHibernationPrefKey("tabHibernation.enabled")).toBe(true);
		expect(isTabHibernationPrefKey("tabHibernation.idleMinutes")).toBe(true);
		expect(isTabHibernationPrefKey("tabHibernationExtra")).toBe(false);
		expect(isTabHibernationPrefKey("language")).toBe(false);
	});
});
