/**
 * Locale parity guard. The GUI ships en/vi locales as flat key→string maps;
 * drift between them silently renders raw keys in the UI. Asserts:
 *
 * 1. en and vi expose exactly the same key set (both directions).
 * 2. No empty values in either locale.
 * 3. vi {placeholders} are a subset of en's (Vietnamese legitimately drops
 *    plural markers like {plural}, but must never invent new params).
 * 4. For the namespaces internationalized in the language-switcher wave,
 *    vi must genuinely translate — no value may be identical to its English
 *    source unless allowlisted as a proper noun / acronym / symbol.
 * 5. The GUI is "Sai ATLAS" in both locales; "omp" names only agent features.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../shared/product";
import { en } from "./en";
import { vi } from "./vi";

/** Namespaces completed or extended in the i18n-switcher wave. */
const TRANSLATED_NAMESPACES = [
	"titlebar.",
	"sidebar.",
	"input.",
	"fork.",
	"sessionTree.",
	"themePicker.",
	"lang.",
	"common.",
	"modelCompare.",
	"modesPanel.",
	// Broader component wave: dialogs, stats, chat, tools, panels, layout.
	"approval.",
	"extDialog.",
	"sessionPicker.",
	"rename.",
	"sessionInfo.",
	"modelPicker.",
	"palette.",
	"stats.",
	"chat.",
	"tools.",
	"todoPanel.",
	"logPanel.",
	"filesPanel.",
	"subagent.",
	"subagentPanel.",
	"agentHub.",
	"dag.",
	"diffPanel.",
	"sidecar.",
	"panel.",
	"providers.",
	"modelValue.",
	"tree.",
	// Parity-closeout waves (B1/A1/B2) and C1/B3 slices.
	"hotkeys.",
	"editor.",
	"readGroup.",
	"settings.launch.",
	"codeblock.",
	"quickEntry.",
];

/** Proper nouns, acronyms, and symbols legitimately identical across locales. */
const ALLOW_IDENTICAL: Record<string, true> = {
	"chat.exec.python": true, // Python — language name
	"chat.exec.shell": true, // Shell — universal term in dev UIs
	"themePicker.theme.nord.label": true, // Nord — theme name
	"themePicker.theme.solarized.label": true, // Solarized — theme name
	"themePicker.theme.latte.label": true, // Latte — theme name
};

const LOCALES = [
	["en", en],
	["vi", vi],
] as const;

const LATIN_LETTER = /[a-zA-Z]/;

/** Drops `{placeholder}` tokens so only prose is checked — they are code, not English words. */
function proseOf(value: string): string {
	return value.replace(/\{\w+\}/g, "");
}

function placeholdersOf(value: string): Set<string> {
	return new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
}

describe("locale parity", () => {
	it("exposes the same keys in en and vi", () => {
		const enKeys = Object.keys(en);
		const viKeys = Object.keys(vi);
		expect(enKeys.filter(key => !(key in vi))).toEqual([]);
		expect(viKeys.filter(key => !(key in en))).toEqual([]);
	});

	it("has no empty values in either locale", () => {
		for (const [key, value] of Object.entries(en)) {
			expect(value.trim(), `en["${key}"] is empty`).not.toBe("");
		}
		for (const [key, value] of Object.entries(vi)) {
			expect(value.trim(), `vi["${key}"] is empty`).not.toBe("");
		}
	});

	it("keeps vi placeholders a subset of en placeholders", () => {
		for (const key of Object.keys(en)) {
			const enParams = placeholdersOf(en[key]);
			const viParams = placeholdersOf(vi[key] ?? "");
			const invented = [...viParams].filter(param => !enParams.has(param));
			expect(invented, `vi["${key}"] invents placeholders`).toEqual([]);
		}
	});

	it("translates the switcher-wave namespaces into real Vietnamese", () => {
		for (const key of Object.keys(en)) {
			if (!TRANSLATED_NAMESPACES.some(ns => key.startsWith(ns))) continue;
			if (ALLOW_IDENTICAL[key]) continue;
			if (!LATIN_LETTER.test(proseOf(en[key]))) continue;
			expect(vi[key], `vi["${key}"] duplicates the English source`).not.toBe(en[key]);
		}
	});
});

describe("product name", () => {
	it("names the GUI Sai ATLAS and keeps omp for agent features", () => {
		for (const [locale, entries] of LOCALES) {
			for (const [key, value] of Object.entries(entries)) {
				const prose = value.replaceAll("~/.omp", "").replaceAll("omp://", "");
				expect(/\bomp\b/.test(prose), `${locale}["${key}"] names the product omp: ${value}`).toBe(false);
			}
		}
	});

	it("never shortens the product name to ATLAS", () => {
		for (const [locale, entries] of LOCALES) {
			for (const [key, value] of Object.entries(entries)) {
				expect(/(?<!Sai )\bATLAS\b/.test(value), `${locale}["${key}"]: ${value}`).toBe(false);
			}
		}
	});

	it("binds the brand key and the window shell to PRODUCT_NAME", () => {
		expect(en["brand.name"]).toBe(PRODUCT_NAME);
		expect(vi["brand.name"]).toBe(PRODUCT_NAME);
		const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
		expect(html).toContain(`<title>${PRODUCT_NAME}</title>`);
		expect(html).toContain('<link rel="icon" type="image/svg+xml" href="./brand/sai-atlas-icon-on-light.svg" />');
	});
});
