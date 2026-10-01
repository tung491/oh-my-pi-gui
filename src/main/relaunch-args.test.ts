import { describe, expect, it } from "vitest";
import { DISPLAY_RESTART_ENV, displayRestart, LINUX_DISPLAY_SWITCH, relaunchArgs } from "./relaunch-args";

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

describe("displayRestart", () => {
	const deb = {
		platform: "linux" as const,
		packaged: true,
		argv: ["/opt/Sai ATLAS/sai-atlas", "/workspace/app"],
		execPath: "/opt/Sai ATLAS/sai-atlas",
		env: {},
	};

	it("restarts a terminal launch once with XWayland, keeping its arguments", () => {
		expect(displayRestart(deb)).toEqual({
			execPath: "/opt/Sai ATLAS/sai-atlas",
			args: ["/workspace/app", LINUX_DISPLAY_SWITCH],
		});
	});

	it("restarts an AppImage opened directly through the AppImage file", () => {
		const appImage = {
			...deb,
			argv: ["/tmp/.mount_SaiATL1/sai-atlas"],
			execPath: "/tmp/.mount_SaiATL1/sai-atlas",
			env: { APPIMAGE: "/home/me/Applications/Sai-ATLAS.AppImage", APPDIR: "/tmp/.mount_SaiATL1" },
		};
		expect(displayRestart(appImage)).toEqual({
			execPath: "/home/me/Applications/Sai-ATLAS.AppImage",
			args: [LINUX_DISPLAY_SWITCH],
		});
	});

	it("does not trust an inherited APPIMAGE outside its mount", () => {
		const env = { APPIMAGE: "/home/me/Applications/Sai-ATLAS.AppImage", APPDIR: "/tmp/.mount_SaiATL1" };
		expect(displayRestart({ ...deb, env })?.execPath).toBe("/opt/Sai ATLAS/sai-atlas");
	});

	it("leaves a launch that chose a backend alone, including native Wayland", () => {
		expect(displayRestart({ ...deb, argv: [...deb.argv, "--ozone-platform=x11"] })).toBeNull();
		expect(displayRestart({ ...deb, argv: [...deb.argv, "--ozone-platform=wayland"] })).toBeNull();
	});

	it("never restarts a launch that is itself a display restart", () => {
		expect(displayRestart({ ...deb, env: { [DISPLAY_RESTART_ENV]: "1" } })).toBeNull();
	});

	it("leaves dev runs and other platforms alone", () => {
		expect(displayRestart({ ...deb, packaged: false })).toBeNull();
		expect(displayRestart({ ...deb, platform: "darwin" })).toBeNull();
		expect(displayRestart({ ...deb, platform: "win32" })).toBeNull();
	});
});
