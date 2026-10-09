import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assetNames, buildRelease, darwinReleaseFor, tauriMacMinimumSystemVersion } from "./release-feeds";

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
function bundles(): { linux: string; macArm64: string; macX64: string } {
	const linux = path.join(dir, "linux/bundle");
	write(path.join(linux, `appimage/Sai ATLAS_${VERSION}_amd64.AppImage`), "appimage bytes");
	write(path.join(linux, `deb/Sai ATLAS_${VERSION}_amd64.deb`), "deb bytes");
	const macArm64 = path.join(dir, "arm64/bundle");
	write(path.join(macArm64, `dmg/Sai ATLAS_${VERSION}_aarch64.dmg`), "arm64 dmg bytes");
	write(path.join(macArm64, `macos/Sai ATLAS_${VERSION}_aarch64.zip`), "arm64 zip bytes");
	const macX64 = path.join(dir, "x64/bundle");
	write(path.join(macX64, `dmg/Sai ATLAS_${VERSION}_x64.dmg`), "x64 dmg bytes");
	write(path.join(macX64, `macos/Sai ATLAS_${VERSION}_x64.zip`), "x64 zip bytes");
	return { linux, macArm64, macX64 };
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
				"Sai-ATLAS-1.2.3.dmg",
				"Sai-ATLAS-1.2.3-arm64.zip",
				"Sai-ATLAS-1.2.3.zip",
				"omp-1.2.3-arm64.dmg",
				"omp-1.2.3.dmg",
				"latest-linux.yml",
				"latest-mac.yml",
				"SHA512SUMS",
			].sort(),
		);
		expect(readFileSync(path.join(out, names.deb), "utf8")).toBe("deb bytes");
		expect(readFileSync(path.join(out, names.macX64Zip), "utf8")).toBe("x64 zip bytes");
		expect(feed(out, "latest-linux.yml").files.map(file => file.url)).toEqual([names.appImage, names.deb]);
		expect(feed(out, "latest-linux.yml").version).toBe(VERSION);
	});

	it("writes SHA512SUMS for the Linux assets and the feed", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		const text = readFileSync(path.join(out, "SHA512SUMS"), "utf8");
		expect(text.endsWith("\n")).toBe(true);
		const lines = text.slice(0, -1).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines.map(line => line.split("  ")[1])).toEqual([
			"Sai-ATLAS-1.2.3-x86_64.AppImage",
			"latest-linux.yml",
			"sai-atlas_1.2.3_amd64.deb",
		]);
		for (const line of lines) {
			const [hex, name] = line.split("  ") as [string, string];
			expect(hex, name).toBe(
				createHash("sha512")
					.update(readFileSync(path.join(out, name)))
					.digest("hex"),
			);
		}
	});

	it("writes no SHA512SUMS without Linux bundles", async () => {
		const out = path.join(dir, "out");
		const { macArm64, macX64 } = bundles();
		await buildRelease({ version: VERSION, outDir: out, macArm64, macX64 });
		expect(existsSync(path.join(out, "SHA512SUMS"))).toBe(false);
	});

	it("starts latest-linux.yml with the version line", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		expect(readFileSync(path.join(out, "latest-linux.yml"), "utf8").split("\n")[0]).toBe("version: 1.2.3");
	});

	it("refuses to run while SAI_ATLAS_UPDATE_BASE is set", async () => {
		const out = path.join(dir, "out");
		process.env.SAI_ATLAS_UPDATE_BASE = "http://127.0.0.1:9/releases";
		try {
			await expect(buildRelease({ version: VERSION, outDir: out, ...bundles() })).rejects.toThrow(
				"SAI_ATLAS_UPDATE_BASE",
			);
		} finally {
			delete process.env.SAI_ATLAS_UPDATE_BASE;
		}
	});

	it("refuses to run while SAI_ATLAS_UPDATE_KEYS is set", async () => {
		const out = path.join(dir, "out");
		process.env.SAI_ATLAS_UPDATE_KEYS = "{}";
		try {
			await expect(buildRelease({ version: VERSION, outDir: out, ...bundles() })).rejects.toThrow(
				"SAI_ATLAS_UPDATE_KEYS",
			);
		} finally {
			delete process.env.SAI_ATLAS_UPDATE_KEYS;
		}
	});

	it("refuses a non-empty output directory", async () => {
		const out = path.join(dir, "out");
		write(path.join(out, "stale.txt"), "stale");
		await expect(buildRelease({ version: VERSION, outDir: out, ...bundles() })).rejects.toThrow(/not empty/);
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

	it("lists every DMG in latest-mac.yml", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		const urls = feed(out, "latest-mac.yml").files.map(file => file.url);
		expect(urls).toEqual([
			"Sai-ATLAS-1.2.3-arm64.zip",
			"Sai-ATLAS-1.2.3-arm64.dmg",
			"Sai-ATLAS-1.2.3.zip",
			"Sai-ATLAS-1.2.3.dmg",
			"omp-1.2.3-arm64.dmg",
			"omp-1.2.3.dmg",
		]);
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
		expect(readFileSync(path.join(out, names.bridgeX64Dmg))).toEqual(readFileSync(path.join(out, names.macX64Dmg)));
		const files = feed(out, "latest-mac.yml").files;
		const sha = (url: string) => files.find(file => file.url === url)?.sha512;
		expect(sha(names.bridgeArm64Dmg)).toBe(sha(names.macArm64Dmg));
		expect(sha(names.bridgeX64Dmg)).toBe(sha(names.macX64Dmg));
	});

	it("merges the Electron macOS feed unchanged while that build still ships", async () => {
		const out = path.join(dir, "out");
		const electron = path.join(dir, "electron");
		const macFeed = `version: ${VERSION}\nfiles:\n  - url: Sai-ATLAS-${VERSION}-arm64.dmg\n    sha512: abc\n    size: 3\nminimumSystemVersion: 22.0.0\npath: Sai-ATLAS-${VERSION}-arm64.dmg\nsha512: abc\nreleaseDate: '2026-10-01T00:00:00.000Z'\n`;
		write(path.join(electron, "latest-mac.yml"), macFeed);
		write(path.join(electron, `Sai-ATLAS-${VERSION}-arm64.dmg`), "dmg");
		const { linux } = bundles();
		await buildRelease({
			version: VERSION,
			outDir: out,
			linux,
			electronMacFeed: path.join(electron, "latest-mac.yml"),
		});
		expect(readFileSync(path.join(out, "latest-mac.yml"), "utf8")).toBe(macFeed);
		expect(readFileSync(path.join(out, `Sai-ATLAS-${VERSION}-arm64.dmg`), "utf8")).toBe("dmg");
		// An Electron feed below the macOS floor is refused, not published.
		write(path.join(electron, "latest-mac.yml"), macFeed.replace("minimumSystemVersion: 22.0.0\n", ""));
		await expect(
			buildRelease({
				version: VERSION,
				outDir: path.join(dir, "out2"),
				electronMacFeed: path.join(electron, "latest-mac.yml"),
			}),
		).rejects.toThrow(/minimumSystemVersion/);
	});
});
