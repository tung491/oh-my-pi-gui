import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledOmpFilename, sidecarOutName } from "./bundled-omp-path";

describe("bundledOmpFilename", () => {
	it("uses the host sidecar filename", () => {
		expect(bundledOmpFilename()).toBe(process.platform === "win32" ? "omp.exe" : "omp");
	});
});

describe("sidecarOutName", () => {
	it("gives every packaged platform its own sidecar file", () => {
		expect(sidecarOutName("darwin", "arm64")).toBe("omp");
		expect(sidecarOutName("darwin", "x64")).toBe("omp.x64");
		expect(sidecarOutName("win32", "x64")).toBe("omp.exe");
		expect(sidecarOutName("windows", "x64")).toBe("omp.exe");
		expect(sidecarOutName("linux", "x64")).toBe("omp.linux-x64");
	});

	it("builds the Linux sidecar through its own script", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts["build:omp:linux"]).toBe("bun scripts/build-bundled-omp.ts --target bun-linux-x64-baseline");
	});
});
