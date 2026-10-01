import { describe, expect, it } from "vitest";
import { LINUX_DISPLAY_SWITCH, relaunchArgs } from "./relaunch-args";

describe("relaunchArgs", () => {
	it("adds XWayland to a Linux relaunch that would otherwise lose it", () => {
		expect(relaunchArgs([], "linux", ["/opt/Sai ATLAS/sai-atlas"])).toEqual([LINUX_DISPLAY_SWITCH]);
		expect(relaunchArgs(["/workspace/app"], "linux", ["/opt/Sai ATLAS/sai-atlas"])).toEqual([
			"/workspace/app",
			"--ozone-platform=x11",
		]);
	});

	it("keeps the backend the running process was started with", () => {
		const argv = ["/opt/Sai ATLAS/sai-atlas", "--ozone-platform=wayland", "%U"];
		expect(relaunchArgs([], "linux", argv)).toEqual(["--ozone-platform=wayland"]);
	});

	it("does not add a second switch when the arguments already carry one", () => {
		const argv = ["/opt/Sai ATLAS/sai-atlas", "--ozone-platform=x11"];
		expect(relaunchArgs(argv.slice(1), "linux", argv)).toEqual(["--ozone-platform=x11"]);
	});

	it("ignores the platform hint and other look-alike switches", () => {
		expect(relaunchArgs(["--ozone-platform-hint=auto"], "linux", ["exe"])).toEqual([
			"--ozone-platform-hint=auto",
			LINUX_DISPLAY_SWITCH,
		]);
	});

	it("leaves macOS and Windows relaunches alone", () => {
		expect(relaunchArgs([], "darwin", ["exe"])).toEqual([]);
		expect(relaunchArgs(["C:\\work"], "win32", ["exe", "--ozone-platform=x11"])).toEqual(["C:\\work"]);
	});

	it("returns a copy the caller may change", () => {
		const args = ["--ozone-platform=x11"];
		const result = relaunchArgs(args, "linux", ["exe"]);
		result.push("extra");
		expect(args).toEqual(["--ozone-platform=x11"]);
	});
});
