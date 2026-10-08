import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	codesignDetails,
	descendantsOf,
	entitlementKeysFromXml,
	infoPlistProblems,
	parsePs,
	plistKeys,
	sameKeys,
} from "./tauri-mac-smoke";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("tauri-mac-smoke helpers", () => {
	it("parses ps output into pid, ppid and command", () => {
		const out =
			"  PID  PPID COMMAND\n  10     1 /a/sai-atlas --user-data-dir=/p\n  11    10 /a/sai-atlas --omp-supervise /a/omp --mode rpc-ui\n";
		expect(parsePs(out)).toEqual([
			{ pid: 10, ppid: 1, command: "/a/sai-atlas --user-data-dir=/p" },
			{ pid: 11, ppid: 10, command: "/a/sai-atlas --omp-supervise /a/omp --mode rpc-ui" },
		]);
	});

	it("keeps spaces inside the command of a header-less row", () => {
		expect(parsePs("  7  3 /b/Sai ATLAS.app/Contents/MacOS/omp --mode rpc-ui\n")).toEqual([
			{ pid: 7, ppid: 3, command: "/b/Sai ATLAS.app/Contents/MacOS/omp --mode rpc-ui" },
		]);
	});

	it("collects every descendant of a pid", () => {
		const rows = [
			{ pid: 10, ppid: 1, command: "a" },
			{ pid: 11, ppid: 10, command: "b" },
			{ pid: 12, ppid: 11, command: "c" },
			{ pid: 13, ppid: 1, command: "d" },
		];
		expect(descendantsOf(rows, 10)).toEqual([11, 12]);
	});

	it("reads the keys of an entitlements plist", () => {
		const text = readFileSync(join(repoRoot, "src-tauri/macos/app.entitlements"), "utf8");
		expect(plistKeys(text)).toEqual(["com.apple.security.device.audio-input"]);
	});

	it("reads the keys codesign prints", () => {
		const xml =
			'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PLIST 1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>';
		expect(entitlementKeysFromXml(xml)).toEqual([
			"com.apple.security.cs.allow-jit",
			"com.apple.security.cs.allow-unsigned-executable-memory",
		]);
	});

	it("ignores keys inside comments", () => {
		expect(plistKeys("<!-- <key>gone</key> --><dict><key>kept</key><true/></dict>")).toEqual(["kept"]);
	});

	it("compares key sets regardless of order and reports the difference", () => {
		expect(sameKeys(["b", "a"], ["a", "b"])).toBeUndefined();
		expect(sameKeys(["a", "c"], ["a", "b"])).toBe("missing [b], extra [c]");
	});

	it("reads the identifier and flags codesign -dv prints", () => {
		const text =
			"Executable=/b/Sai ATLAS.app/Contents/MacOS/sai-atlas\nIdentifier=vn.io.vif.saiatlas\nFormat=app bundle with Mach-O thin (arm64)\nCodeDirectory v=20500 size=53043 flags=0x10002(adhoc,runtime) hashes=1647+7 location=embedded\n";
		expect(codesignDetails(text)).toEqual({ identifier: "vn.io.vif.saiatlas", flags: ["adhoc", "runtime"] });
		expect(codesignDetails("nothing here")).toEqual({ identifier: undefined, flags: [] });
	});

	it("accepts an Info.plist with the omp scheme, the 13.3 floor and a microphone string", () => {
		const info = {
			CFBundleURLTypes: [{ CFBundleURLName: "vn.io.vif.saiatlas omp", CFBundleURLSchemes: ["omp"] }],
			LSMinimumSystemVersion: "13.3",
			NSMicrophoneUsageDescription: "Sai ATLAS uses the microphone for voice dictation in the composer.",
		};
		expect(infoPlistProblems(info)).toEqual([]);
	});

	it("names every Info.plist problem", () => {
		expect(
			infoPlistProblems({
				CFBundleURLTypes: [{ CFBundleURLSchemes: ["https"] }],
				LSMinimumSystemVersion: "10.13",
				NSMicrophoneUsageDescription: "",
			}),
		).toEqual([
			"CFBundleURLTypes has no omp scheme",
			"LSMinimumSystemVersion is 10.13, expected 13.3",
			"NSMicrophoneUsageDescription is missing",
		]);
		expect(infoPlistProblems({})).toHaveLength(3);
	});
});
