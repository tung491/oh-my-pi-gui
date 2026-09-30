import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { userDataDirectory } from "./user-data-directory";

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { name: string };
const appData = path.join(path.sep, "profiles", "appData");

describe("userDataDirectory", () => {
	it("keeps the directory every 0.9.x release derived from package.json name", () => {
		expect(userDataDirectory(appData, "")).toBe(path.join(appData, pkg.name));
		expect(userDataDirectory(appData, "")).toBe(path.join(appData, "@oh-my-pi", "omp-gui"));
	});

	it("lets an explicit --user-data-dir win", () => {
		expect(userDataDirectory(appData, "relative/profile")).toBe(path.resolve("relative/profile"));
		expect(userDataDirectory(appData, path.join(path.sep, "tmp", "p"))).toBe(path.join(path.sep, "tmp", "p"));
	});
});
