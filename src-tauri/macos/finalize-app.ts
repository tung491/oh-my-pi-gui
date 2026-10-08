/**
 * Finish the macOS .app tauri-bundler wrote, for the one fact its config
 * cannot express: the sidecar's own entitlements.
 *
 * - The bundler signs every `externalBin` with the app's entitlements, so
 *   `Contents/MacOS/omp` would get the microphone and none of what the Bun
 *   runtime needs (JIT, writable-executable memory and, ad-hoc signed,
 *   loading its own native addon). The sidecar is re-signed with
 *   `omp.entitlements`, then the app with `app.entitlements`, which seals the
 *   re-signed sidecar. Neither signing pass uses `--deep`: that would sign
 *   the sidecar again with the app's entitlements.
 * - The DMG is built here, from the re-signed app, because a bundler-built DMG
 *   would hold the app as the bundler signed it. It carries an `/Applications`
 *   link and the bundler's file name, so the release scripts find it unchanged.
 *
 *   bun src-tauri/macos/finalize-app.ts <release/bundle directory>
 *
 * Signing is ad hoc with the hardened runtime and no notarization, as the
 * Electron build was.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../../src/shared/product";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function signArgv(entitlements: string, target: string): string[] {
	return ["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, target];
}

/** The codesign runs, in order: the sidecar, then the app that seals it, then a strict check of the whole bundle. */
export function finalizePlan(appPath: string, root: string): string[][] {
	const entitlements = path.join(root, "src-tauri", "macos");
	return [
		signArgv(path.join(entitlements, "omp.entitlements"), path.join(appPath, "Contents", "MacOS", "omp")),
		signArgv(path.join(entitlements, "app.entitlements"), appPath),
		["codesign", "--verify", "--strict", "--deep", appPath],
	];
}

/** The file name tauri-bundler gives an arm64 DMG. */
export function dmgNameFor(version: string): string {
	return `${PRODUCT_NAME}_${version}_aarch64.dmg`;
}

function run(argv: string[]): void {
	const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited with ${result.exitCode}`);
}

function findApp(bundleDir: string): string {
	const macosDir = path.join(bundleDir, "macos");
	let apps: string[];
	try {
		apps = readdirSync(macosDir).filter(name => name.endsWith(".app"));
	} catch {
		throw new Error(`no ${macosDir}; run the Tauri bundler first`);
	}
	if (apps.length !== 1) throw new Error(`expected exactly one .app in ${macosDir}, found ${apps.length}`);
	return path.join(macosDir, apps[0] as string);
}

function readVersion(): string {
	const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: unknown };
	if (typeof version !== "string" || version.length === 0) throw new Error("package.json has no version");
	return version;
}

function makeDmg(app: string, bundleDir: string, version: string): string {
	const dmgDir = path.join(bundleDir, "dmg");
	mkdirSync(dmgDir, { recursive: true });
	for (const name of readdirSync(dmgDir)) if (name.endsWith(".dmg")) rmSync(path.join(dmgDir, name));
	const dmg = path.join(dmgDir, dmgNameFor(version));
	const stage = mkdtempSync(path.join(os.tmpdir(), "sai-atlas-dmg-"));
	try {
		run(["ditto", app, path.join(stage, `${PRODUCT_NAME}.app`)]);
		symlinkSync("/Applications", path.join(stage, "Applications"));
		run([
			"hdiutil",
			"create",
			"-volname",
			PRODUCT_NAME,
			"-srcfolder",
			stage,
			"-fs",
			"HFS+",
			"-format",
			"UDZO",
			"-ov",
			dmg,
		]);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	return dmg;
}

if (import.meta.main) {
	const bundleDir = process.argv[2];
	if (!bundleDir) {
		console.error("usage: bun src-tauri/macos/finalize-app.ts <release/bundle directory>");
		process.exit(2);
	}
	try {
		const app = findApp(bundleDir);
		const version = readVersion();
		for (const argv of finalizePlan(app, ROOT)) run(argv);
		console.log(`finalized ${app}`);
		console.log(`dmg ${makeDmg(app, bundleDir, version)}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
