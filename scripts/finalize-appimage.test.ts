import { describe, expect, it } from "vitest";
import { patchWebKitLibrary } from "../src-tauri/linux/finalize-appimage";

const HELPERS = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1";

/** NUL-separated C strings, as they sit in the library's .rodata. */
function library(...strings: string[]): Buffer {
	return Buffer.from(`\x7fELF\0${strings.join("\0")}\0`, "latin1");
}

/** What the bundler's GTK plugin does to the library: `sed -i "s|/usr|././|g"`. */
function relocate(bytes: Buffer): Buffer {
	return Buffer.from(bytes.toString("latin1").replaceAll("/usr", "././"), "latin1");
}

const pristine = library(
	"/usr/bin/bwrap",
	"/usr/bin/xdg-dbus-proxy",
	"/usr/share",
	HELPERS,
	"/usr/lib/x86_64-linux-gnu",
	`${HELPERS}/injected-bundle/`,
);

describe("patchWebKitLibrary", () => {
	it("reverts the bundler's relocation and points only the helper directory into the AppImage", () => {
		const relocated = relocate(pristine);
		const patched = patchWebKitLibrary(relocated).toString("latin1");
		expect(patched).toBe(
			library(
				"/usr/bin/bwrap",
				"/usr/bin/xdg-dbus-proxy",
				"/usr/share",
				"././/lib/x86_64-linux-gnu/webkit2gtk-4.1",
				"/usr/lib/x86_64-linux-gnu",
				"././/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/",
			).toString("latin1"),
		);
		expect(patched.split("././")).toHaveLength(3);
	});

	it("keeps the library's length and leaves its input untouched", () => {
		const relocated = relocate(pristine);
		const before = Buffer.from(relocated);
		expect(patchWebKitLibrary(relocated)).toHaveLength(relocated.length);
		expect(relocated.equals(before)).toBe(true);
	});

	it("is idempotent on an already patched library", () => {
		const once = patchWebKitLibrary(relocate(pristine));
		expect(patchWebKitLibrary(once).equals(once)).toBe(true);
	});

	it("throws when the helper directory does not appear exactly twice", () => {
		expect(() => patchWebKitLibrary(relocate(library("/usr/bin/bwrap", HELPERS)))).toThrow(/expected 2 uses/);
		expect(() => patchWebKitLibrary(relocate(library(HELPERS, HELPERS, HELPERS)))).toThrow(/found 3/);
	});

	it("throws when a relocated string survives the revert", () => {
		// "./." directly before a relocated "/usr" leaves "././usr" behind.
		expect(() => patchWebKitLibrary(library(`./.${relocate(Buffer.from(HELPERS)).toString()}`, HELPERS))).toThrow(
			/survived/,
		);
	});

	it("throws when the library was never relocated", () => {
		expect(() => patchWebKitLibrary(pristine)).toThrow(/no relocated/);
	});
});
