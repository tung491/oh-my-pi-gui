/**
 * Turn the built Linux Tauri bundles into the release asset set and its update feed.
 *
 *   bun scripts/release-feeds.ts --version 1.0.0 \
 *     --linux src-tauri/target/x86_64-unknown-linux-gnu/release/bundle \
 *     [--out dist-release]
 *
 * Output (`dist-release/` by default): the AppImage and the deb renamed to the
 * asset names every installed updater looks for, and an electron-builder style
 * `latest-linux.yml` that lists both with base64 SHA-512 and size per file.
 */

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Scalar, stringify } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The asset names the updaters look for (src-tauri/src/updater, and the 0.9.x Linux updater). */
export function assetNames(version: string) {
	return {
		appImage: `Sai-ATLAS-${version}-x86_64.AppImage`,
		deb: `sai-atlas_${version}_amd64.deb`,
	};
}

export interface ReleaseInputs {
	version: string;
	/** Output directory; created when missing. */
	outDir: string;
	/** The Tauri Linux `bundle/` directory. */
	linux?: string;
	/** ISO timestamp for the feeds; defaults to now. */
	releaseDate?: string;
}

export interface FeedFile {
	url: string;
	sha512: string;
	size: number;
}

/** Base64 SHA-512 of a file, as electron-builder writes it, streamed. */
export async function sha512Base64(file: string): Promise<string> {
	const hash = createHash("sha512");
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest("base64");
}

async function feedFile(outDir: string, name: string): Promise<FeedFile> {
	const file = path.join(outDir, name);
	return { url: name, sha512: await sha512Base64(file), size: statSync(file).size };
}

/** The one file in `dir` with `extension` whose name carries `version`; anything else is an error. */
function onlyBundle(dir: string, extension: string, version: string): string {
	if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
	const matches = readdirSync(dir).filter(name => name.endsWith(extension));
	if (matches.length !== 1) {
		throw new Error(`expected exactly one ${extension} in ${dir}, found ${matches.length}: ${matches.join(", ")}`);
	}
	const name = matches[0] as string;
	// Tauri names bundles `<productName>_<version>_<arch>`; a stale bundle from another version must not ship.
	if (!name.includes(`_${version}_`) && !name.includes(`-${version}`)) {
		throw new Error(`${path.join(dir, name)} is not a ${version} bundle`);
	}
	return path.join(dir, name);
}

function writeFeed(
	outDir: string,
	fileName: string,
	version: string,
	files: FeedFile[],
	releaseDate: string,
	extra: Record<string, string> = {},
): void {
	const primary = files[0];
	if (!primary) throw new Error(`${fileName} would list no files`);
	const document = {
		version,
		files,
		...extra,
		path: primary.url,
		sha512: primary.sha512,
		// js-yaml (electron-updater) would read an unquoted ISO date as a Date.
		releaseDate: Object.assign(new Scalar(releaseDate), { type: Scalar.QUOTE_SINGLE }),
	};
	writeFileSync(path.join(outDir, fileName), stringify(document, { lineWidth: 0 }));
}

/** Build the release set; returns the names written to `outDir`. */
export async function buildRelease(inputs: ReleaseInputs): Promise<string[]> {
	const { version, outDir } = inputs;
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid version ${version}`);
	const names = assetNames(version);
	const releaseDate = inputs.releaseDate ?? new Date().toISOString();
	const written: string[] = [];
	mkdirSync(outDir, { recursive: true });
	const place = (source: string, name: string) => {
		copyFileSync(source, path.join(outDir, name));
		written.push(name);
	};

	if (inputs.linux) {
		place(onlyBundle(path.join(inputs.linux, "appimage"), ".AppImage", version), names.appImage);
		place(onlyBundle(path.join(inputs.linux, "deb"), ".deb", version), names.deb);
		writeFeed(
			outDir,
			"latest-linux.yml",
			version,
			[await feedFile(outDir, names.appImage), await feedFile(outDir, names.deb)],
			releaseDate,
		);
		written.push("latest-linux.yml");
	}

	if (written.length === 0) throw new Error("no bundles or feeds given");
	return written;
}

function parseArgs(argv: string[]): ReleaseInputs {
	const options: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined)
			throw new Error(`expected --flag value pairs, got ${flag ?? "nothing"}`);
		options[flag.slice(2)] = value;
	}
	const known = ["version", "out", "linux"];
	for (const key of Object.keys(options)) if (!known.includes(key)) throw new Error(`unknown option --${key}`);
	if (!options.version) throw new Error("--version is required");
	return {
		version: options.version,
		outDir: options.out ?? path.join(ROOT, "dist-release"),
		linux: options.linux,
	};
}

if (import.meta.main) {
	try {
		const written = await buildRelease(parseArgs(process.argv.slice(2)));
		for (const name of written) console.log(name);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
