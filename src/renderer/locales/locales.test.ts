/**
 * Locale parity guard. The GUI ships en/zh locales as flat key→string maps;
 * drift between them silently renders raw keys in the UI. Asserts:
 *
 * 1. en and zh expose exactly the same key set (both directions).
 * 2. No empty values in either locale.
 * 3. zh {placeholders} are a subset of en's (Chinese legitimately drops
 *    plural markers like {plural}, but must never invent new params).
 * 4. For the namespaces internationalized in the language-switcher wave,
 *    zh must genuinely translate — no value may be identical to its English
 *    source unless allowlisted as a proper noun / acronym / symbol.
 * 5. The GUI is "Sai ATLAS" in both locales; "omp" names only agent features.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../shared/product";
import { en } from "./en";
import { zh } from "./zh";

/** Namespaces completed or extended in the i18n-switcher wave. */
const TRANSLATED_NAMESPACES = [
	"titlebar.",
	"sidebar.",
	"input.",
	"fork.",
	"handoff.",
	"sessionTree.",
	"themePicker.",
	"planApproval.",
	"lang.",
	"common.",
	"modelCompare.",
	"invPanel.",
	"extPanel.",
	"modesPanel.",
	// Broader component wave: dialogs, stats, chat, tools, panels, layout.
	"approval.",
	"extDialog.",
	"sessionPicker.",
	"branchPicker.",
	"rename.",
	"sessionInfo.",
	"modelPicker.",
	"palette.",
	"stats.",
	"statsPop.",
	"chat.",
	"tools.",
	"todoPanel.",
	"logPanel.",
	"filesPanel.",
	"planPanel.",
	"subagent.",
	"subagentPanel.",
	"agentHub.",
	"dag.",
	"diffPanel.",
	"sidecar.",
	"panel.",
	"usage.",
	"providers.",
	"modelValue.",
	"tree.",
	// Parity-closeout waves (B1/A1/B2) and C1/B3 slices.
	"hotkeys.",
	"import.",
	"editor.",
	"readGroup.",
	"mcp.",
	"marketplace.",
	"pluginDetail.",
	"settings.launch.",
	"codeblock.",
	"quickEntry.",
];

/** Proper nouns, acronyms, and symbols legitimately identical across locales. */
const ALLOW_IDENTICAL: Record<string, true> = {
	"providers.badge.oauth": true, // OAuth — brand name
	"modelCompare.noRole": true, // "—" — punctuation, no letters
	"extPanel.tabs.mcp": true, // MCP — protocol acronym
	"modesPanel.tabs.vibe": true, // Vibe — feature name
	"stats.col.ttft": true, // TTFT — latency acronym
	"stats.col.tps": true, // Tok/s — unit symbol
	"stats.overview.ttftSub": true, // TTFT {time} — acronym + placeholder
	"stats.requests.detail.api": true, // API — protocol acronym
	"chat.exec.python": true, // Python — language name
	"chat.exec.shell": true, // Shell — universal term in zh dev UIs
	"themePicker.theme.nord.label": true, // Nord — theme name
	"themePicker.theme.solarized.label": true, // Solarized — theme name
	"themePicker.theme.latte.label": true, // Latte — theme name
	"quickEntry.target.agent": true, // Agent — zh keeps the term, as in tabs.new.agent
};

/** Copy about the bundled coding agent, which keeps the omp name. */
const AGENT_SCOPE_OMP: Record<string, true> = {
	"benchmark.description": true, // the bundled omp benchmark
	"collab.joinDesc": true, // collab links are an agent feature
	"collab.joinPlaceholder": true,
};

const LOCALES = [
	["en", en],
	["zh", zh],
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
	it("exposes the same keys in en and zh", () => {
		const enKeys = Object.keys(en);
		const zhKeys = Object.keys(zh);
		expect(enKeys.filter(key => !(key in zh))).toEqual([]);
		expect(zhKeys.filter(key => !(key in en))).toEqual([]);
	});

	it("has no empty values in either locale", () => {
		for (const [key, value] of Object.entries(en)) {
			expect(value.trim(), `en["${key}"] is empty`).not.toBe("");
		}
		for (const [key, value] of Object.entries(zh)) {
			expect(value.trim(), `zh["${key}"] is empty`).not.toBe("");
		}
	});

	it("keeps zh placeholders a subset of en placeholders", () => {
		for (const key of Object.keys(en)) {
			const enParams = placeholdersOf(en[key]);
			const zhParams = placeholdersOf(zh[key] ?? "");
			const invented = [...zhParams].filter(param => !enParams.has(param));
			expect(invented, `zh["${key}"] invents placeholders`).toEqual([]);
		}
	});

	it("translates the switcher-wave namespaces into real Chinese", () => {
		for (const key of Object.keys(en)) {
			if (!TRANSLATED_NAMESPACES.some(ns => key.startsWith(ns))) continue;
			if (ALLOW_IDENTICAL[key]) continue;
			if (!LATIN_LETTER.test(proseOf(en[key]))) continue;
			expect(zh[key], `zh["${key}"] duplicates the English source`).not.toBe(en[key]);
		}
	});
});

describe("product name", () => {
	it("names the GUI Sai ATLAS and keeps omp for agent features", () => {
		for (const [locale, entries] of LOCALES) {
			for (const [key, value] of Object.entries(entries)) {
				if (AGENT_SCOPE_OMP[key]) continue;
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
		expect(zh["brand.name"]).toBe(PRODUCT_NAME);
		const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
		expect(html).toContain(`<title>${PRODUCT_NAME}</title>`);
		expect(html).toContain('<link rel="icon" type="image/svg+xml" href="./brand/sai-atlas-icon-on-light.svg" />');
	});
});
