import { describe, expect, it } from "vitest";
import { dmgNameFor, finalizePlan } from "../src-tauri/macos/finalize-app";

describe("finalize-app", () => {
	it("signs the sidecar before the app, each with its own entitlements", () => {
		const plan = finalizePlan("/b/macos/Sai ATLAS.app", "/repo");
		expect(plan.slice(0, 3)).toEqual([
			[
				"codesign",
				"--force",
				"--sign",
				"-",
				"--options",
				"runtime",
				"--entitlements",
				"/repo/src-tauri/macos/omp.entitlements",
				"/b/macos/Sai ATLAS.app/Contents/MacOS/omp",
			],
			[
				"codesign",
				"--force",
				"--sign",
				"-",
				"--options",
				"runtime",
				"--entitlements",
				"/repo/src-tauri/macos/app.entitlements",
				"/b/macos/Sai ATLAS.app",
			],
			["codesign", "--verify", "--strict", "--deep", "/b/macos/Sai ATLAS.app"],
		]);
		// A deep signing pass would re-sign the sidecar with the app's entitlements.
		for (const argv of plan) expect(argv.includes("--deep") && argv.includes("--sign"), argv.join(" ")).toBe(false);
	});

	it("names the DMG the way the Tauri bundler does", () => {
		expect(dmgNameFor("0.9.18")).toBe("Sai ATLAS_0.9.18_aarch64.dmg");
	});
});
