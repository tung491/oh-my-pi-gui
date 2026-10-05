/**
 * The oldest glibc a Linux bundle may need: Ubuntu 24.04 LTS ships 2.39, and
 * the README promises 24.04 and later.
 *
 * linuxdeploy copies the build host's GTK, GLib and WebKit libraries into the
 * AppImage, so a bundle built on a newer distro silently needs that distro's
 * glibc and fails to start on 24.04 ("version `GLIBC_2.43' not found"). The
 * finalize scripts therefore check every ELF file a bundle ships, not only the
 * main executable, and refuse to finish a bundle that needs more.
 *
 * The check reads the symbol version tags `objdump -T` prints (binutils).
 */

import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import * as path from "node:path";

export const GLIBC_FLOOR = "2.39";

/** A file that needs a newer glibc than the floor, with the newest version it needs. */
export interface GlibcOffender {
	file: string;
	version: string;
}

/** Prints a file's dynamic symbol table; returns `undefined` for an ELF without one (e.g. an object file). */
export type DynamicSymbolReader = (file: string) => string | undefined;

const GLIBC_TAG = /\bGLIBC_(\d+(?:\.\d+){1,2})\b/g;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Numeric comparison of dotted versions ("2.9" < "2.39"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}

/** The newest `GLIBC_x.y[.z]` version in `objdump -T` output, or `undefined` when it names none. */
export function maxGlibcVersion(objdumpOutput: string): string | undefined {
	let max: string | undefined;
	for (const match of objdumpOutput.matchAll(GLIBC_TAG)) {
		const version = match[1] as string;
		if (max === undefined || compareVersions(version, max) > 0) max = version;
	}
	return max;
}

/** The newest glibc version `objdump -T` output needs when it is above `floor`, else `undefined`. */
export function glibcAboveFloor(objdumpOutput: string, floor: string = GLIBC_FLOOR): string | undefined {
	const max = maxGlibcVersion(objdumpOutput);
	return max !== undefined && compareVersions(max, floor) > 0 ? max : undefined;
}

/** Whether `file` starts with the ELF magic bytes. */
export function isElf(file: string): boolean {
	const header = Buffer.alloc(ELF_MAGIC.length);
	const fd = openSync(file, "r");
	try {
		return readSync(fd, header, 0, header.length, 0) === header.length && header.equals(ELF_MAGIC);
	} finally {
		closeSync(fd);
	}
}

/** Regular files under `root`, recursively, without following symlinks; absolute paths, sorted. */
export function regularFilesUnder(root: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(root)) {
		const entry = path.join(root, name);
		const stat = lstatSync(entry);
		if (stat.isDirectory()) files.push(...regularFilesUnder(entry));
		else if (stat.isFile()) files.push(entry);
	}
	return files.sort();
}

/** `objdump -T <file>`; an ELF without a dynamic symbol table needs no glibc version. */
export const objdumpDynamicSymbols: DynamicSymbolReader = file => {
	const result = spawnSync("objdump", ["-T", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (result.error) throw new Error(`objdump could not run (install binutils): ${result.error.message}`);
	if (result.status !== 0) {
		if (result.stderr.includes("not a dynamic object")) return undefined;
		throw new Error(`objdump -T ${file} failed with status ${result.status}\n${result.stderr}`);
	}
	return result.stdout;
};

/** The ELF files among `files` (others are skipped) that need a glibc newer than `floor`. */
export function glibcOffenders(
	files: readonly string[],
	floor: string = GLIBC_FLOOR,
	readSymbols: DynamicSymbolReader = objdumpDynamicSymbols,
): GlibcOffender[] {
	const offenders: GlibcOffender[] = [];
	for (const file of files) {
		if (!isElf(file)) continue;
		const symbols = readSymbols(file);
		const version = symbols === undefined ? undefined : glibcAboveFloor(symbols, floor);
		if (version !== undefined) offenders.push({ file, version });
	}
	return offenders;
}

/** Throw, naming each offender relative to `root`, when any ELF file under `root` needs a glibc above the floor. */
export function assertGlibcFloor(root: string, bundle: string, floor: string = GLIBC_FLOOR): void {
	const offenders = glibcOffenders(regularFilesUnder(root), floor);
	if (offenders.length === 0) return;
	const lines = offenders.map(({ file, version }) => `  ${path.relative(root, file)}: GLIBC_${version}`);
	throw new Error(
		`${bundle} needs a newer glibc than ${floor} (Ubuntu 24.04), so it would not start there. ` +
			`Build it on Ubuntu 24.04 (bash scripts/tauri-linux-build.sh). Offending files:\n${lines.join("\n")}`,
	);
}
