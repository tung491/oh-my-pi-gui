import { existsSync } from "node:fs";
import { join } from "node:path";

/** Filename of the bundled omp sidecar on this platform. */
export function bundledOmpFilename(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

/** Resolve a bundled sidecar path, accepting a Windows .exe suffix when needed. */
export function resolveOmpCandidate(...parts: string[]): string | null {
	const candidate = join(...parts);
	if (existsSync(candidate)) return candidate;
	if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) {
		const withExe = `${candidate}.exe`;
		if (existsSync(withExe)) return withExe;
	}
	return null;
}

/**
 * Sidecar filename under resources/ for a cross-target build. Each packaged
 * platform needs its own file: electron-builder.x64.yml ships omp.x64 (Intel
 * macOS), electron-builder.win.yml ships omp.exe, and scripts/stage-tauri-sidecar.ts
 * stages omp.linux-<arch> into the Tauri Linux bundle. The host build keeps writing
 * resources/omp.
 */
export function sidecarOutName(osName: string, arch: string): string {
	if (osName === "win32" || osName === "windows") return "omp.exe";
	if (osName === "linux") return `omp.linux-${arch}`;
	return arch === "x64" ? "omp.x64" : "omp";
}
