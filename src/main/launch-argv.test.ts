/**
 * Launch-argument decoding for a refused second instance (`omp <dir>`,
 * `open -n omp --args …`) and Windows/Linux protocol handoff. Contract: a deep
 * link always wins, then --quick-entry, the first real directory is the
 * workspace to open, flags never masquerade as one, and anything else only
 * raises the running app.
 */

import { describe, expect, it } from "vitest";
import { launchArguments, parseLaunchArgv } from "./launch-argv";

const directories = new Set(["/workspace/app", "/Applications/omp.app"]);
const exists = (path: string): boolean => directories.has(path);

describe("parseLaunchArgv", () => {
	it("prefers the deep link over a directory in the same argv", () => {
		expect(parseLaunchArgv(["/Applications/omp.app", "omp://session/abc", "/workspace/app"], "omp", exists)).toEqual({
			kind: "url",
			url: "omp://session/abc",
		});
	});

	it("opens the first argument naming a real directory", () => {
		expect(parseLaunchArgv(["electron-bin", "/workspace/app", "/nope"], "omp", exists)).toEqual({
			kind: "path",
			path: "/workspace/app",
		});
	});

	it("skips Electron's own switches instead of treating them as paths", () => {
		expect(parseLaunchArgv(["--class=App", "--no-sandbox", "/workspace/app"], "omp", exists)).toEqual({
			kind: "path",
			path: "/workspace/app",
		});
		expect(parseLaunchArgv(["--flag", "./relative", "/missing"], "omp", exists)).toEqual({ kind: "focus" });
	});

	it("only asks for focus when nothing names a link or a workspace", () => {
		expect(parseLaunchArgv(["/tmp/not-a-directory"], "omp", () => false)).toEqual({ kind: "focus" });
	});

	it("opens quick entry for the --quick-entry flag", () => {
		expect(parseLaunchArgv(["--quick-entry"], "omp", exists)).toEqual({ kind: "quick-entry" });
	});

	it("prefers quick entry over a directory in the same argv", () => {
		expect(parseLaunchArgv(["/workspace/app", "--quick-entry"], "omp", exists)).toEqual({ kind: "quick-entry" });
	});

	it("still prefers a deep link over quick entry", () => {
		expect(parseLaunchArgv(["--quick-entry", "omp://new"], "omp", exists)).toEqual({ kind: "url", url: "omp://new" });
	});
});

describe("launchArguments", () => {
	it("drops only the executable in a packaged launch", () => {
		expect(launchArguments(["/opt/omp/omp-gui", "omp://new"], false)).toEqual(["omp://new"]);
	});

	it("drops the executable and the app directory in a dev launch", () => {
		expect(launchArguments(["/electron", ".", "/workspace/app"], true)).toEqual(["/workspace/app"]);
	});

	it("finds a cold-start workspace or link behind Chromium switches", () => {
		expect(
			parseLaunchArgv(launchArguments(["/opt/omp/omp-gui", "--no-sandbox", "/workspace/app"], false), "omp", exists),
		).toEqual({ kind: "path", path: "/workspace/app" });
		expect(parseLaunchArgv(launchArguments(["/opt/omp/omp-gui", "omp://session/abc"], false), "omp", exists)).toEqual(
			{
				kind: "url",
				url: "omp://session/abc",
			},
		);
	});
});
