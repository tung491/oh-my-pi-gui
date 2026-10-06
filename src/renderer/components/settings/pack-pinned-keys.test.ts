import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PACK_PINNED_SETTING_KEYS } from "./settings-schema-utils";

const CONFIG_PATH = fileURLToPath(new URL("../../../../assistant-pack/config.yml", import.meta.url));

/** Dotted paths of a YAML document: mappings recurse, arrays and scalars are leaves. */
function leafPaths(value: unknown, prefix = ""): string[] {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
	}
	return [prefix];
}

describe("pack-pinned settings", () => {
	it("covers every key the pack config pins", () => {
		const paths = leafPaths(parse(readFileSync(CONFIG_PATH, "utf8")));
		expect(paths.length).toBeGreaterThan(0);
		const uncovered = paths.filter(
			path => !PACK_PINNED_SETTING_KEYS.some(key => path === key || path.startsWith(`${key}.`)),
		);
		expect(uncovered).toEqual([]);
	});
});
