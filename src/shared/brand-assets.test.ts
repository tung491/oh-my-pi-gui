/**
 * Brand artwork comes from a shared design artifact and will be replaced as the
 * design evolves. The app shows it through `<img>`, but the site also serves it
 * as a standalone document, so every file must stay free of active content and
 * of references that leave the file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.join(__dirname, "..", "..");

const FORBIDDEN = [
	/<script\b/i,
	/<foreignObject\b/i,
	/<style\b/i,
	/<!DOCTYPE\b/i,
	/<!ENTITY\b/i,
	/<set\b/i,
	/<animate/i,
	/<iframe\b/i,
	/<embed\b/i,
	/<object\b/i,
	/javascript:/i,
	/@import\b/i,
	/\son[a-z]+\s*=/i,
];

function activeContentIn(svg: string): string[] {
	const problems = FORBIDDEN.filter(pattern => pattern.test(svg)).map(pattern => `matches ${pattern}`);
	for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
		if (!match[2].startsWith("#")) problems.push(`external href ${match[2]}`);
	}
	for (const match of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
		if (!match[2].startsWith("#")) problems.push(`external url(${match[2]})`);
	}
	return problems;
}

function svgFilesIn(directory: string, suffix = ".svg"): string[] {
	const absolute = path.join(PACKAGE_ROOT, directory);
	if (!fs.existsSync(absolute)) return [];
	return fs
		.readdirSync(absolute)
		.filter(name => name.endsWith(suffix))
		.map(name => path.join(directory, name));
}

const BRAND_SVGS = [
	...svgFilesIn("src/renderer/public/brand"),
	...svgFilesIn("resources", "-source.svg"),
	...svgFilesIn("site/assets"),
];

describe("brand artwork safety check", () => {
	it.each([
		["a script", "<svg><script>alert(1)</script></svg>"],
		["a foreign object", "<svg><foreignObject><div/></foreignObject></svg>"],
		["a style block", "<svg><style>@import url(x.css)</style></svg>"],
		["an entity declaration", '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'],
		["an animated link", '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>'],
		["an event handler", '<svg onload="alert(1)"/>'],
		["an external image", '<svg><image href="https://x"/></svg>'],
		["an external xlink", '<svg><use xlink:href="other.svg#a"/></svg>'],
		["an external paint server", '<svg><rect fill="url(https://x/p.svg#g)"/></svg>'],
	])("rejects %s", (_label, svg) => {
		expect(activeContentIn(svg)).not.toEqual([]);
	});

	it("accepts fragment references", () => {
		expect(activeContentIn('<svg><use href="#a"/><rect fill="url(#g)"/></svg>')).toEqual([]);
	});
});

describe("brand artwork", () => {
	it("finds the brand files", () => {
		expect(BRAND_SVGS.length).toBeGreaterThan(0);
	});

	it.each(BRAND_SVGS)("%s has no active content or external references", file => {
		expect(activeContentIn(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8"))).toEqual([]);
	});
});
