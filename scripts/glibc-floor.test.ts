import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareVersions,
	GLIBC_FLOOR,
	glibcAboveFloor,
	glibcOffenders,
	maxGlibcVersion,
	regularFilesUnder,
} from "../src-tauri/linux/glibc-floor";

/** `objdump -T` output for a library needing the given glibc versions. */
function objdump(...versions: string[]): string {
	const rows = versions.map(
		(version, i) => `0000000000000000      DF *UND*\t0000000000000000 (GLIBC_${version}) symbol_${i}`,
	);
	return [
		"",
		"libexample.so.0:     file format elf64-x86-64",
		"",
		"DYNAMIC SYMBOL TABLE:",
		"0000000000000000  w   D  *UND*\t0000000000000000  Base        __gmon_start__",
		"0000000000000000      DO *UND*\t0000000000000000 (GLIBC_PRIVATE) _rtld_global",
		"0000000000000000      DF *UND*\t0000000000000000 (GLIBC_ABI_DT_RELR) marker",
		...rows,
		"0000000000012340 g    DF .text\t0000000000000042  Base        example_init",
		"",
	].join("\n");
}

describe("compareVersions", () => {
	it("compares numerically, part by part", () => {
		expect(compareVersions("2.9", "2.39")).toBe(-1);
		expect(compareVersions("2.39", "2.39")).toBe(0);
		expect(compareVersions("2.43", "2.39")).toBe(1);
		expect(compareVersions("2.2.5", "2.2")).toBe(1);
		expect(compareVersions("2.2", "2.2.0")).toBe(0);
	});
});

describe("maxGlibcVersion", () => {
	it("returns the newest of several version tags, ignoring non-numeric ones", () => {
		expect(maxGlibcVersion(objdump("2.2.5", "2.14", "2.34", "2.4"))).toBe("2.34");
	});

	it("returns undefined when the output names no glibc version", () => {
		expect(maxGlibcVersion(objdump())).toBeUndefined();
		expect(
			maxGlibcVersion("\nld:     file format elf64-x86-64\n\nDYNAMIC SYMBOL TABLE:\nno symbols\n"),
		).toBeUndefined();
	});
});

describe("glibcAboveFloor", () => {
	it("passes a library below the floor", () => {
		expect(glibcAboveFloor(objdump("2.2.5", "2.17", "2.34"))).toBeUndefined();
	});

	it("passes a library exactly at the floor", () => {
		expect(glibcAboveFloor(objdump("2.2.5", GLIBC_FLOOR))).toBeUndefined();
	});

	it("reports the newest version of a library above the floor", () => {
		expect(glibcAboveFloor(objdump("2.2.5", "2.42", "2.43", "2.38"))).toBe("2.43");
	});

	it("passes a library with no glibc version tags", () => {
		expect(glibcAboveFloor(objdump())).toBeUndefined();
	});

	it("honours an explicit floor", () => {
		expect(glibcAboveFloor(objdump("2.39"), "2.35")).toBe("2.39");
	});
});

describe("glibcOffenders", () => {
	let dir: string;

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("checks only ELF files and names each offender with its newest version", () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "glibc-floor-"));
		mkdirSync(path.join(dir, "usr/lib/nested"), { recursive: true });
		const elf = (name: string) => {
			const file = path.join(dir, name);
			writeFileSync(file, Buffer.from("\x7fELF\x02\x01\x01", "latin1"));
			return file;
		};
		const old = elf("usr/lib/libold.so");
		const newer = elf("usr/lib/nested/libnew.so");
		const object = elf("usr/lib/crt1.o");
		const script = path.join(dir, "AppRun.sh");
		writeFileSync(script, "#!/bin/sh\n# GLIBC_9.99\n");
		symlinkSync("libnew.so", path.join(dir, "usr/lib/nested/libnew.so.1"));

		const symbols: Record<string, string | undefined> = {
			[old]: objdump("2.2.5", "2.17"),
			[newer]: objdump("2.34", "2.43"),
			[object]: undefined,
		};
		const read: string[] = [];
		const files = regularFilesUnder(dir);
		expect(files).toEqual([script, object, old, newer]);

		const offenders = glibcOffenders(files, GLIBC_FLOOR, file => {
			read.push(file);
			return symbols[file];
		});
		expect(offenders).toEqual([{ file: newer, version: "2.43" }]);
		expect(read).toEqual([object, old, newer]);
	});
});
