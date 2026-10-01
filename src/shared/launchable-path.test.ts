import { describe, expect, it } from "vitest";
import { launchesWhenOpened, launchPlatformOf, opensAsProgram } from "./launchable-path";

const textFile = { isFile: true, mode: 0o100644 };
const executableFile = { isFile: true, mode: 0o100755 };
const folder = { isFile: false, mode: 0o40755 };

describe("opensAsProgram", () => {
	it.each(["deploy.sh", "tools/Deploy.SH", "scripts/run.command", "build.py", "C:\\tools\\setup.EXE", "App.jar"])(
		"treats %s as a program everywhere",
		path => {
			for (const platform of ["mac", "linux", "windows"] as const) expect(opensAsProgram(path, platform)).toBe(true);
		},
	);

	it("treats Windows shell launchers as programs only on Windows", () => {
		for (const path of [
			"notes.url",
			"run.js",
			"shortcut.lnk",
			"setup.msi",
			"sites/example.com",
			"plot.scr",
			"help.chm",
			"app.pyz",
			"mod.pyc",
		]) {
			expect(opensAsProgram(path, "windows")).toBe(true);
			expect(opensAsProgram(path, "mac")).toBe(false);
		}
	});

	it("sees through the trailing dots and spaces Windows strips from a name", () => {
		expect(opensAsProgram("C:\\repo\\evil.bat.", "windows")).toBe(true);
		expect(opensAsProgram("C:\\repo\\evil.cmd . ", "windows")).toBe(true);
	});

	it("reads the extension from the file name, not from a folder", () => {
		expect(opensAsProgram("/repo/dir.sh/readme", "linux")).toBe(false);
		expect(opensAsProgram("C:\\repo\\dir.bat\\readme", "windows")).toBe(false);
	});

	it("leaves source and text files alone", () => {
		for (const path of ["src/App.tsx", "README.md", "Makefile", ".env.example"]) {
			expect(opensAsProgram(path, "windows")).toBe(false);
		}
	});

	it("leaves a regular file named like a bundle to the folder check", () => {
		expect(opensAsProgram("ebin/demo.app", "mac")).toBe(false);
	});
});

describe("launchesWhenOpened", () => {
	it("refuses an executable regular file on macOS, where Launch Services runs it in Terminal", () => {
		expect(launchesWhenOpened("/repo/tool", executableFile, "mac")).toBe(true);
		expect(launchesWhenOpened("/repo/notes.txt", textFile, "mac")).toBe(false);
	});

	it("never reads the executable bit of a folder", () => {
		expect(launchesWhenOpened("/repo/src", folder, "mac")).toBe(false);
	});

	it("refuses a macOS application bundle, which is a folder, but not a text file named .app", () => {
		expect(launchesWhenOpened("/Applications/Calculator.app", folder, "mac")).toBe(true);
		expect(launchesWhenOpened("/repo/ebin/demo.app", textFile, "mac")).toBe(false);
		expect(launchesWhenOpened("/repo/Tool.app", folder, "linux")).toBe(false);
	});

	it("keeps the executable bit out of the decision off macOS", () => {
		expect(launchesWhenOpened("/mnt/usb/notes.txt", executableFile, "linux")).toBe(false);
		expect(launchesWhenOpened("C:\\repo\\notes.txt", executableFile, "windows")).toBe(false);
	});

	it("still refuses launchers by name on every platform", () => {
		expect(launchesWhenOpened("/repo/deploy.sh", textFile, "linux")).toBe(true);
		expect(launchesWhenOpened("C:\\repo\\link.url", textFile, "windows")).toBe(true);
	});
});

describe("launchPlatformOf", () => {
	it("maps Node platform names", () => {
		expect(launchPlatformOf("darwin")).toBe("mac");
		expect(launchPlatformOf("win32")).toBe("windows");
		expect(launchPlatformOf("linux")).toBe("linux");
		expect(launchPlatformOf("freebsd")).toBe("linux");
	});
});
