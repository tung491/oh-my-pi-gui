/**
 * The dev-port guard asks the OS who listens on the port; macOS has no `ss`,
 * so without its own probe the guard would never see a busy port there.
 */

import { describe, expect, it } from "vitest";
import { portOwnerProbe } from "./tauri-dev";

describe("dev port owner probe", () => {
	it("uses ss on linux", () => {
		expect(portOwnerProbe("linux", 5180)).toEqual({
			command: "ss",
			args: ["-ltnp", "sport = :5180"],
			headerLines: 1,
		});
	});

	it("uses lsof on macOS", () => {
		expect(portOwnerProbe("darwin", 5180)).toEqual({
			command: "lsof",
			args: ["-nP", "-iTCP:5180", "-sTCP:LISTEN"],
			headerLines: 1,
		});
	});
});
