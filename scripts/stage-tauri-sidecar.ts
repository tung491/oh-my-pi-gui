/**
 * Stage the omp sidecar for a Tauri bundle build:
 *
 *   bun scripts/stage-tauri-sidecar.ts <rust target triple>
 *
 * Copies the locally built sidecar (`resources/omp*`, gitignored) to
 * `src-tauri/binaries/omp-<triple>`. The `package:tauri:*` scripts pass an
 * overlay config that names that file: `externalBin` on macOS (beside the
 * executable) and the `omp` resource on Linux
 * (`/usr/lib/Sai ATLAS/omp`, off PATH). The overlay is passed only to bundle
 * builds because tauri-build copies `externalBin` and `resources` at compile
 * time, so a plain `cargo build` or `cargo test` must not name a 300 MB file
 * that only a monorepo checkout can produce.
 */

import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Which built sidecar each bundle target ships (see `build:omp*` in package.json). */
export const SIDECAR_SOURCES: Readonly<Record<string, string>> = {
	"x86_64-unknown-linux-gnu": "resources/omp.linux-x64",
	"aarch64-apple-darwin": "resources/omp",
	"x86_64-apple-darwin": "resources/omp.x64",
};

/** `src-tauri/binaries/omp-<triple>` (Tauri's sidecar naming). */
export function stagedSidecarPath(triple: string): string {
	return path.join("src-tauri", "binaries", `omp-${triple}`);
}

export function stageSidecar(triple: string, root: string = ROOT): string {
	const source = SIDECAR_SOURCES[triple];
	if (!source) {
		throw new Error(`unknown target ${triple}; expected one of ${Object.keys(SIDECAR_SOURCES).join(", ")}`);
	}
	const sourcePath = path.join(root, source);
	let size: number;
	try {
		size = statSync(sourcePath).size;
	} catch {
		throw new Error(
			`${source} is missing. Build it in the monorepo clone (README → Build from source; plan: Sidecar binaries) and copy it here before packaging ${triple}.`,
		);
	}
	if (size === 0) throw new Error(`${source} is empty; rebuild the sidecar`);
	const destination = path.join(root, stagedSidecarPath(triple));
	mkdirSync(path.dirname(destination), { recursive: true });
	copyFileSync(sourcePath, destination);
	// copyFileSync keeps the mode on Unix, but a sidecar copied from a
	// filesystem without the bit must still run inside the bundle.
	chmodSync(destination, 0o755);
	return destination;
}

if (import.meta.main) {
	const triple = process.argv[2];
	if (!triple) {
		console.error("usage: bun scripts/stage-tauri-sidecar.ts <rust target triple>");
		process.exit(2);
	}
	try {
		const staged = stageSidecar(triple);
		console.log(`staged ${path.relative(ROOT, staged)}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
