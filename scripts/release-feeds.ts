/**
 * Turn built Tauri bundles into the release asset set and its update feeds.
 *
 *   bun scripts/release-feeds.ts --version 1.0.0 \
 *     [--linux src-tauri/target/x86_64-unknown-linux-gnu/release/bundle] \
 *     [--mac-arm64 src-tauri/target/aarch64-apple-darwin/release/bundle] \
 *     [--out dist-release]
 *
 * Output (`dist-release/` by default): the bundles renamed to the asset names
 * every installed updater looks for, the `omp-` bridge copy of the DMG (0.9.x
 * Macs look only for that name until 1.0.0), and electron-builder style feeds
 * with base64 SHA-512 and size per file: `latest-linux.yml` (AppImage and deb)
 * and `latest-mac.yml` (the arm64 ZIP, DMG and bridge copy, with
 * `minimumSystemVersion`). macOS ships the Tauri app for Apple silicon only.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Scalar, stringify } from "yaml";
import { macUpdateFloorError } from "./mac-update-floor";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The updater (`src-tauri/src/updater/feed.rs`) compares a feed's
 * `minimumSystemVersion` with the Darwin kernel release, not the macOS version. Only
 * floors this release line has used are listed; add the Darwin release of a
 * new floor here when `tauri.macos.conf.json` changes.
 */
const DARWIN_RELEASE_OF_MACOS: Readonly<Record<string, string>> = {
	"13.3": "22.4.0",
};

/** The Darwin version that a macOS `minimumSystemVersion` corresponds to. */
export function darwinReleaseFor(macosVersion: string): string {
	const darwin = DARWIN_RELEASE_OF_MACOS[macosVersion];
	if (!darwin)
		throw new Error(`no Darwin release recorded for macOS ${macosVersion}; add it to DARWIN_RELEASE_OF_MACOS`);
	return darwin;
}

/** `bundle.macOS.minimumSystemVersion` from `src-tauri/tauri.macos.conf.json`. */
export function tauriMacMinimumSystemVersion(root: string = ROOT): string {
	const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.macos.conf.json"), "utf8")) as {
		bundle?: { macOS?: { minimumSystemVersion?: unknown } };
	};
	const value = config.bundle?.macOS?.minimumSystemVersion;
	if (typeof value !== "string") throw new Error("tauri.macos.conf.json has no bundle.macOS.minimumSystemVersion");
	return value;
}

/** The asset names installed updaters look for (src/main/updater-state.ts, src-tauri/src/updater). */
export function assetNames(version: string) {
	return {
		appImage: `Sai-ATLAS-${version}-x86_64.AppImage`,
		deb: `sai-atlas_${version}_amd64.deb`,
		macArm64Dmg: `Sai-ATLAS-${version}-arm64.dmg`,
		macArm64Zip: `Sai-ATLAS-${version}-arm64.zip`,
		bridgeArm64Dmg: `omp-${version}-arm64.dmg`,
	};
}

export interface ReleaseInputs {
	version: string;
	/** Output directory; created when missing. */
	outDir: string;
	/** Tauri `bundle/` directories per target; macOS ships arm64 only. */
	linux?: string;
	macArm64?: string;
	/** Darwin version for `latest-mac.yml`; defaults to the Tauri macOS floor's. */
	macMinimumSystemVersion?: string;
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

/** `<bundle>/macos/*.zip` if the build produced one, else a zip of `<bundle>/macos/*.app` made with ditto. */
function macZip(bundleDir: string, version: string, destination: string): void {
	const macos = path.join(bundleDir, "macos");
	const zips = existsSync(macos) ? readdirSync(macos).filter(name => name.endsWith(".zip")) : [];
	if (zips.length > 0) {
		copyFileSync(onlyBundle(macos, ".zip", version), destination);
		return;
	}
	const apps = existsSync(macos) ? readdirSync(macos).filter(name => name.endsWith(".app")) : [];
	if (apps.length !== 1) throw new Error(`expected exactly one .app or .zip in ${macos}`);
	if (process.platform !== "darwin") throw new Error("zipping a .app keeps its signature only with ditto on macOS");
	// ditto keeps symlinks, modes and extended attributes, which the code seal depends on.
	const result = spawnSync(
		"/usr/bin/ditto",
		["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(macos, apps[0] as string), destination],
		{
			stdio: "inherit",
		},
	);
	if (result.status !== 0) throw new Error(`ditto failed for ${apps[0]}`);
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

	if (inputs.macArm64) {
		place(onlyBundle(path.join(inputs.macArm64, "dmg"), ".dmg", version), names.macArm64Dmg);
		macZip(inputs.macArm64, version, path.join(outDir, names.macArm64Zip));
		written.push(names.macArm64Zip);
		// Byte-identical bridge copy for 0.9.x Macs, which look only for omp- names.
		place(path.join(outDir, names.macArm64Dmg), names.bridgeArm64Dmg);
		const files: FeedFile[] = [];
		for (const name of [names.macArm64Zip, names.macArm64Dmg, names.bridgeArm64Dmg]) {
			files.push(await feedFile(outDir, name));
		}
		const minimumSystemVersion = inputs.macMinimumSystemVersion ?? darwinReleaseFor(tauriMacMinimumSystemVersion());
		writeFeed(outDir, "latest-mac.yml", version, files, releaseDate, { minimumSystemVersion });
		written.push("latest-mac.yml");
	}

	// Every macOS feed this script publishes must keep Macs below the floor off builds they cannot open.
	const macFeed = path.join(outDir, "latest-mac.yml");
	if (written.includes("latest-mac.yml")) {
		const floorError = macUpdateFloorError(readFileSync(macFeed, "utf8"));
		if (floorError) throw new Error(floorError);
	}
	if (written.length === 0) throw new Error("no bundles or feeds given");
	return written;
}

export function parseArgs(argv: string[]): ReleaseInputs {
	const options: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined)
			throw new Error(`expected --flag value pairs, got ${flag ?? "nothing"}`);
		options[flag.slice(2)] = value;
	}
	const known = ["version", "out", "linux", "mac-arm64"];
	for (const key of Object.keys(options)) if (!known.includes(key)) throw new Error(`unknown option --${key}`);
	if (!options.version) throw new Error("--version is required");
	return {
		version: options.version,
		outDir: options.out ?? path.join(ROOT, "dist-release"),
		linux: options.linux,
		macArm64: options["mac-arm64"],
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
