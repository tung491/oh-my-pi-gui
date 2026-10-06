// Test helpers: reopen an Office file and read its parts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

export async function zipEntry(bytes: Uint8Array, name: string): Promise<string> {
	const zip = await JSZip.loadAsync(bytes);
	const entry = zip.file(name);
	if (!entry) throw new Error(`missing zip entry ${name}`);
	return entry.async("string");
}

export async function zipNames(bytes: Uint8Array): Promise<string[]> {
	const zip = await JSZip.loadAsync(bytes);
	return Object.keys(zip.files);
}

export function fixture(name: string): string {
	return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

export function countMatches(text: string, pattern: RegExp): number {
	return [...text.matchAll(pattern)].length;
}
