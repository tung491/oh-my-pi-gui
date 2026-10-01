/**
 * The portal path is decided before any window exists: the feature switch has
 * to keep a user's own --enable-features, and the session detection has to
 * honour every way of forcing XWayland, or the UI would describe the wrong
 * shortcut model.
 */

import { describe, expect, it } from "vitest";
import {
	desktopEntryCandidates,
	mergeEnableFeatures,
	PORTAL_SHORTCUT_FEATURES,
	usesShortcutPortal,
} from "./wayland-portal";

const NO_OZONE = { platform: "", hint: "" };
const WAYLAND = { XDG_SESSION_TYPE: "wayland" };

describe("enable-features merge", () => {
	it("adds the portal features to an empty value", () => {
		expect(mergeEnableFeatures("", PORTAL_SHORTCUT_FEATURES)).toBe(
			"GlobalShortcutsPortal,GlobalShortcutsPortalPreferredTrigger",
		);
	});

	it("keeps the user's features first and never duplicates one", () => {
		expect(mergeEnableFeatures("Foo,GlobalShortcutsPortal", PORTAL_SHORTCUT_FEATURES)).toBe(
			"Foo,GlobalShortcutsPortal,GlobalShortcutsPortalPreferredTrigger",
		);
	});
});

describe("shortcut portal detection", () => {
	it("uses the portal in a Linux Wayland session", () => {
		expect(usesShortcutPortal("linux", WAYLAND, NO_OZONE)).toBe(true);
	});

	it("does not use it in an X11 session", () => {
		expect(usesShortcutPortal("linux", { XDG_SESSION_TYPE: "x11" }, NO_OZONE)).toBe(false);
	});

	it("honours --ozone-platform=x11 in a Wayland session", () => {
		expect(usesShortcutPortal("linux", WAYLAND, { platform: "x11", hint: "" })).toBe(false);
	});

	it("honours --ozone-platform-hint=x11 in a Wayland session", () => {
		expect(usesShortcutPortal("linux", WAYLAND, { platform: "", hint: "x11" })).toBe(false);
	});

	it("lets an explicit platform win over the hint", () => {
		expect(usesShortcutPortal("linux", WAYLAND, { platform: "wayland", hint: "x11" })).toBe(true);
	});

	it("treats an auto hint as the session's choice", () => {
		expect(usesShortcutPortal("linux", WAYLAND, { platform: "", hint: "auto" })).toBe(true);
		expect(usesShortcutPortal("linux", {}, { platform: "", hint: "auto" })).toBe(false);
	});

	it("never uses it off Linux", () => {
		expect(usesShortcutPortal("darwin", WAYLAND, NO_OZONE)).toBe(false);
		expect(usesShortcutPortal("win32", WAYLAND, { platform: "wayland", hint: "" })).toBe(false);
	});
});

describe("desktop entry candidates", () => {
	it("falls back to the XDG defaults", () => {
		expect(desktopEntryCandidates("app.desktop", {}, "/home/me")).toEqual([
			"/home/me/.local/share/applications/app.desktop",
			"/usr/local/share/applications/app.desktop",
			"/usr/share/applications/app.desktop",
		]);
	});

	it("searches the data home first, then each data dir", () => {
		expect(
			desktopEntryCandidates(
				"app.desktop",
				{ XDG_DATA_HOME: "/data/home", XDG_DATA_DIRS: "/opt/share::/usr/share" },
				"/home/me",
			),
		).toEqual([
			"/data/home/applications/app.desktop",
			"/opt/share/applications/app.desktop",
			"/usr/share/applications/app.desktop",
		]);
	});

	it("treats empty variables as unset", () => {
		expect(desktopEntryCandidates("app.desktop", { XDG_DATA_HOME: "", XDG_DATA_DIRS: "" }, "/home/me")).toEqual(
			desktopEntryCandidates("app.desktop", {}, "/home/me"),
		);
	});
});
