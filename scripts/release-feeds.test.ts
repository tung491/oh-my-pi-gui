import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assetNames, buildRelease, darwinReleaseFor, parseArgs, tauriMacMinimumSystemVersion } from "./release-feeds";

const VERSION = "1.2.3";

interface Feed {
	version: string;
	files: Array<{ url: string; sha512: string; size: number }>;
	path: string;
	sha512: string;
	releaseDate: string;
	minimumSystemVersion?: string;
}

let dir: string;

function write(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

/** A Tauri bundle tree with the bundler's own names and distinct contents per file. */
function bundles(): { linux: string; macArm64: string } {
	const linux = path.join(dir, "linux/bundle");
	write(path.join(linux, `appimage/Sai ATLAS_${VERSION}_amd64.AppImage`), "appimage bytes");
	write(path.join(linux, `deb/Sai ATLAS_${VERSION}_amd64.deb`), "deb bytes");
	const macArm64 = path.join(dir, "arm64/bundle");
	write(path.join(macArm64, `dmg/Sai ATLAS_${VERSION}_aarch64.dmg`), "arm64 dmg bytes");
	write(path.join(macArm64, `macos/Sai ATLAS_${VERSION}_aarch64.zip`), "arm64 zip bytes");
	return { linux, macArm64 };
}

function feed(out: string, name: string): Feed {
	return parse(readFileSync(path.join(out, name), "utf8")) as Feed;
}

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "release-feeds-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("release feeds", () => {
	it("renames to the invariant asset names", async () => {
		const out = path.join(dir, "out");
		const written = await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		const names = assetNames(VERSION);
		expect(written.sort()).toEqual(
			[
				"Sai-ATLAS-1.2.3-x86_64.AppImage",
				"sai-atlas_1.2.3_amd64.deb",
				"Sai-ATLAS-1.2.3-arm64.dmg",
				"Sai-ATLAS-1.2.3-arm64.zip",
				"omp-1.2.3-arm64.dmg",
				"latest-linux.yml",
				"latest-mac.yml",
			].sort(),
		);
		expect(readFileSync(path.join(out, names.deb), "utf8")).toBe("deb bytes");
		expect(readFileSync(path.join(out, names.macArm64Zip), "utf8")).toBe("arm64 zip bytes");
		expect(feed(out, "latest-linux.yml").files.map(file => file.url)).toEqual([names.appImage, names.deb]);
		expect(feed(out, "latest-linux.yml").version).toBe(VERSION);
	});

	it("writes sha512 that matches the file", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		for (const name of ["latest-linux.yml", "latest-mac.yml"]) {
			const document = feed(out, name);
			for (const file of document.files) {
				const bytes = readFileSync(path.join(out, file.url));
				expect(file.sha512, file.url).toBe(createHash("sha512").update(bytes).digest("base64"));
				expect(file.size, file.url).toBe(bytes.length);
			}
			expect(document.sha512).toBe(document.files[0]?.sha512);
			expect(document.path).toBe(document.files[0]?.url);
		}
		// Quoted so js-yaml keeps it a string.
		expect(readFileSync(path.join(out, "latest-linux.yml"), "utf8")).toMatch(/^releaseDate: '.+'$/m);
	});

	it("lists only the arm64 assets in latest-mac.yml", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		const urls = feed(out, "latest-mac.yml").files.map(file => file.url);
		expect(urls).toEqual(["Sai-ATLAS-1.2.3-arm64.zip", "Sai-ATLAS-1.2.3-arm64.dmg", "omp-1.2.3-arm64.dmg"]);
	});

	it("writes minimumSystemVersion", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		// Darwin 22.4 is macOS 13.3, the Tauri floor in tauri.macos.conf.json.
		expect(tauriMacMinimumSystemVersion()).toBe("13.3");
		expect(darwinReleaseFor("13.3")).toBe("22.4.0");
		expect(feed(out, "latest-mac.yml").minimumSystemVersion).toBe("22.4.0");
		expect(feed(out, "latest-linux.yml").minimumSystemVersion).toBeUndefined();
	});

	it("bridge copies are byte-identical", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		const names = assetNames(VERSION);
		expect(readFileSync(path.join(out, names.bridgeArm64Dmg))).toEqual(
			readFileSync(path.join(out, names.macArm64Dmg)),
		);
		const files = feed(out, "latest-mac.yml").files;
		const sha = (url: string) => files.find(file => file.url === url)?.sha512;
		expect(sha(names.bridgeArm64Dmg)).toBe(sha(names.macArm64Dmg));
	});

	it("rejects an Intel macOS bundle", () => {
		expect(() => parseArgs(["--version", VERSION, "--mac-x64", "x"])).toThrow(/unknown option --mac-x64/);
	});
});
