import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assetNames, buildRelease } from "./release-feeds";

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
function bundles(): { linux: string } {
	const linux = path.join(dir, "linux/bundle");
	write(path.join(linux, `appimage/Sai ATLAS_${VERSION}_amd64.AppImage`), "appimage bytes");
	write(path.join(linux, `deb/Sai ATLAS_${VERSION}_amd64.deb`), "deb bytes");
	return { linux };
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
			["Sai-ATLAS-1.2.3-x86_64.AppImage", "sai-atlas_1.2.3_amd64.deb", "latest-linux.yml"].sort(),
		);
		expect(readFileSync(path.join(out, names.deb), "utf8")).toBe("deb bytes");
		expect(feed(out, "latest-linux.yml").files.map(file => file.url)).toEqual([names.appImage, names.deb]);
		expect(feed(out, "latest-linux.yml").version).toBe(VERSION);
	});

	it("writes sha512 that matches the file", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		for (const name of ["latest-linux.yml"]) {
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

	it("writes no minimumSystemVersion into latest-linux.yml", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		expect(feed(out, "latest-linux.yml").minimumSystemVersion).toBeUndefined();
	});
});
