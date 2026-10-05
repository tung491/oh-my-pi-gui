import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertMediaFramework,
	BUNDLED_GSTREAMER_PLUGINS,
	GSTREAMER_PLUGIN_DIR,
	GSTREAMER_SCANNER,
	PULSE_CLIENT,
	patchWebKitLibrary,
} from "../src-tauri/linux/finalize-appimage";

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

describe("assertMediaFramework", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function file(appDir: string, relative: string): void {
		mkdirSync(path.dirname(path.join(appDir, relative)), { recursive: true });
		writeFileSync(path.join(appDir, relative), "\x7fELF");
	}

	/** An AppDir as the bundler's gstreamer plugin leaves it. */
	function appDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "finalize-appimage-"));
		dirs.push(dir);
		for (const plugin of BUNDLED_GSTREAMER_PLUGINS) file(dir, `${GSTREAMER_PLUGIN_DIR}/${plugin}`);
		file(dir, PULSE_CLIENT);
		file(dir, "usr/lib/libpulsecommon-16.1.so");
		file(dir, GSTREAMER_SCANNER);
		file(dir, "usr/lib/libgstreamer-1.0.so.0");
		file(dir, "usr/lib/libcap.so.2");
		return dir;
	}

	it("accepts exactly the allowlisted plugins with the libpulse client and the scanner", () => {
		expect(BUNDLED_GSTREAMER_PLUGINS).toHaveLength(11);
		expect(() => assertMediaFramework(appDir())).not.toThrow();
	});

	it("refuses an AppImage built without the media framework", () => {
		const dir = appDir();
		rmSync(path.join(dir, GSTREAMER_PLUGIN_DIR), { recursive: true });
		expect(() => assertMediaFramework(dir)).toThrow(/bundleMediaFramework/);
	});

	it("names a missing plugin and an unexpected one", () => {
		const dir = appDir();
		rmSync(path.join(dir, GSTREAMER_PLUGIN_DIR, "libgstpulseaudio.so"));
		file(dir, `${GSTREAMER_PLUGIN_DIR}/libgstvpx.so`);
		expect(() => assertMediaFramework(dir)).toThrow(/missing: libgstpulseaudio\.so; unexpected: libgstvpx\.so/);
	});

	it("refuses a plugin that is a symlink rather than a copy", () => {
		const dir = appDir();
		const plugin = path.join(dir, GSTREAMER_PLUGIN_DIR, "libgstapp.so");
		rmSync(plugin);
		symlinkSync("/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstapp.so", plugin);
		expect(() => assertMediaFramework(dir)).toThrow(/libgstapp\.so is not a regular file/);
	});

	it("requires the libpulse client and the plugin scanner", () => {
		for (const required of [PULSE_CLIENT, GSTREAMER_SCANNER]) {
			const dir = appDir();
			rmSync(path.join(dir, required));
			expect(() => assertMediaFramework(dir)).toThrow(`${required} is missing`);
		}
	});

	it("refuses glibc's own libraries and libpipewire anywhere in the AppDir", () => {
		for (const library of [
			"usr/lib/libmvec.so.1",
			"usr/lib/x86_64-linux-gnu/libc.so.6",
			"usr/lib/libpipewire-0.3.so.0",
		]) {
			const dir = appDir();
			file(dir, library);
			expect(() => assertMediaFramework(dir)).toThrow(library);
		}
	});
});
