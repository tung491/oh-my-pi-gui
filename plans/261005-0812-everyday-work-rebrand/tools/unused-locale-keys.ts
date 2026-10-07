/**
 * Lists renderer locale keys that no source file references.
 *
 * Run from a checkout root: `bun <this file>`. Writes `unused-locale-keys.json`
 * next to this file with `unused`, `review`, `dynamicPrefixes` and
 * `reviewDecisions`, all sorted.
 *
 * - A key is used when a string literal (or a template literal without `${`)
 *   anywhere under `src/` (locales excluded, tests included) equals it.
 * - Every template literal with `${` contributes a dynamic pattern: its static
 *   head when that head contains a `.`, or, when the head is empty, its static
 *   tail as a suffix pattern. An unused key matching a pattern is `review`.
 * - Review keys are decided by rules: `cmd.` keys survive only when a
 *   `sub("…")`/`subAction("…")` item of the command registry builds them; the
 *   other patterns carry a per-pattern rule below, each pointing at the source
 *   line that bounds the values the `${…}` part can take.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type * as TS from "typescript";

const cwd = process.cwd();
const ts: typeof TS = createRequire(join(cwd, "package.json"))("typescript");
const srcDir = join(cwd, "src");
const localesDir = join(srcDir, "renderer", "locales");
const registryPath = join(srcDir, "renderer", "lib", "command-registry.ts");
const outPath = join(import.meta.dir, "unused-locale-keys.json");

interface ReviewDecision {
	key: string;
	decision: "delete" | "keep";
	why: string;
}

interface DynamicPattern {
	kind: "prefix" | "suffix";
	text: string;
	/** `file:line` of every template literal yielding this pattern. */
	sites: string[];
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (path === localesDir) continue;
			out.push(...sourceFiles(path));
		} else if (/\.tsx?$/.test(entry.name)) {
			out.push(path);
		}
	}
	return out.sort();
}

function loadKeys(): string[] {
	const text = readFileSync(join(localesDir, "en.ts"), "utf8");
	const file = ts.createSourceFile("en.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const keys: string[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) keys.push(node.name.text);
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (keys.length === 0) throw new Error("no keys parsed from en.ts");
	return keys;
}

const literals = new Set<string>();
const patterns = new Map<string, DynamicPattern>();

function addPattern(kind: DynamicPattern["kind"], text: string, site: string): void {
	const id = `${kind}:${text}`;
	const existing = patterns.get(id);
	if (existing) existing.sites.push(site);
	else patterns.set(id, { kind, text, sites: [site] });
}

function scan(path: string): void {
	const text = readFileSync(path, "utf8");
	const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
	const rel = relative(cwd, path);
	const visit = (node: TS.Node): void => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			literals.add(node.text);
		} else if (ts.isTemplateExpression(node)) {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
			const head = node.head.text;
			const tail = node.templateSpans[node.templateSpans.length - 1].literal.text;
			if (head.includes(".")) addPattern("prefix", head, `${rel}:${line}`);
			else if (head === "" && tail !== "") addPattern("suffix", tail, `${rel}:${line}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
}

const keyOf = (name: string): string =>
	name.replace(/-(\w)/g, (_hyphen, ch: string) => ch.toUpperCase()).replace(/ /g, ".");

/** `cmd.<keyOf(name)>` → `file:line` for every `sub("…")`/`subAction("…")` in the registry. */
function submenuKeys(): Map<string, string> {
	const lines = readFileSync(registryPath, "utf8").split("\n");
	const out = new Map<string, string>();
	lines.forEach((line, index) => {
		for (const match of line.matchAll(/\b(?:sub|subAction)\(\s*"([^"]+)"/g)) {
			out.set(`cmd.${keyOf(match[1])}`, `${relative(cwd, registryPath)}:${index + 1}`);
		}
	});
	if (out.size === 0) throw new Error("no sub()/subAction() items found in the command registry");
	return out;
}

const patternId = (pattern: DynamicPattern): string =>
	pattern.kind === "prefix" ? pattern.text : `*${pattern.text}`;

/**
 * Patterns whose template builds a number with a unit or a CSS value, never a
 * locale key: a key they match is produced by no current value.
 */
const NOT_KEY_PATTERNS: Record<string, string> = {
	"*s": "src/renderer/components/panels/subagent-graph.ts:81,83 and src/renderer/lib/chart.ts:164 format a number of seconds",
	"*m": "src/renderer/components/panels/subagent-graph.ts:84 formats a number of minutes",
	"*k": "src/renderer/lib/format.ts:152, src/renderer/lib/chart.ts:152 and src/main/tray-labels.ts:79 format a count in thousands",
	"*ch": "src/renderer/lib/diff.tsx:524,529,547,554 build a CSS width from a number",
};

const THINKING_SELECTORS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_WHY =
	"src/renderer/components/layout/ThinkingControl.tsx:36 offers off, auto and THINKING_LEVEL_VALUES (src/shared/rpc-types.ts:1428)";
const THEME_NAMES = ["dark", "titanium", "nord", "latte", "gruvbox", "light", "paper", "solarized", "dawn", "frost", "matcha"];

/** Key prefixes whose `${…}` part ranges over a closed value set in the source. */
const VALUE_SETS: Record<string, { values: string[]; why: string }> = {
	"agentHub.defs.prewalk.": {
		values: ["default", "on", "off"],
		why: "src/renderer/components/panels/AgentHubWindow.tsx:94 PrewalkState",
	},
	"agentHub.source.": {
		values: ["project", "user", "bundled"],
		why: "src/renderer/components/panels/AgentHubWindow.tsx:116 KNOWN_SOURCES",
	},
	"category.": {
		values: ["session", "model", "context", "tools", "providers", "extensions", "modes", "view", "workspace", "other"],
		why: "src/renderer/lib/command-registry.ts:68 CommandCategory",
	},
	"chat.compaction.reason.": {
		values: ["overflow", "idle", "incomplete"],
		why: "src/renderer/stores/session.ts:45 compactionInfo.reason (threshold reads no key, ChatStream.tsx:953)",
	},
	"input.thinking.level.": { values: THINKING_SELECTORS, why: THINKING_WHY },
	"input.thinking.name.": { values: THINKING_SELECTORS, why: THINKING_WHY },
	"jobs.status.": {
		values: ["running", "completed", "failed", "cancelled"],
		why: "src/shared/rpc-types.ts:367 RpcAsyncJobItem.status",
	},
	"jobs.type.": { values: ["bash", "task", "eval"], why: "src/shared/rpc-types.ts:366 RpcAsyncJobItem.type" },
	"settings.display.": {
		values: [
			"hideThinkingBlock",
			"proseOnlyThinking",
			"showTokenUsage",
			"collapseCompacted",
			"titleState",
			"goalStatusInFooter",
			"showProgress",
			"emojiAutocomplete",
		],
		why: "src/renderer/lib/display-preferences.ts:6 GUI_DISPLAY_BOOL_FIELDS",
	},
	"settings.nav.": {
		values: ["experience", "models", "tasks", "tools", "extensions", "memory", "system"],
		why: "src/renderer/components/settings/settings-window-model.ts:46 SettingsNavGroup.id",
	},
	"settings.source.": {
		values: ["global", "project", "overlay", "runtime"],
		why: "src/shared/rpc-types.ts:1634 SettingProvenance.layers",
	},
	"settings.tabs.": {
		values: [
			"capabilities",
			"updates",
			"advanced",
			"gui",
			"appearance",
			"interaction",
			"model",
			"providers",
			"context",
			"tasks",
			"files",
			"shell",
			"tools",
			"memory",
		],
		why: "src/renderer/components/settings/settings-window-model.ts:33-36 GUI tab ids and :72 owners (the agent's SETTING_TABS); an unknown tab falls back to its schema label (SettingsWindow.tsx:785)",
	},
	"themePicker.theme.": {
		values: THEME_NAMES.flatMap(name => [`${name}.label`, `${name}.description`]),
		why: "src/renderer/lib/themes.ts:1659 THEMES",
	},
	"tools.coordination.status.": {
		values: ["running", "completed", "failed", "cancelled"],
		why: "src/renderer/components/tools/CoordinationRenderer.tsx:19 JobStatus",
	},
	"tools.memory.operation.": {
		values: ["retain", "recall", "reflect", "memory"],
		why: "src/renderer/components/tools/MemoryRenderer.tsx:41,54 operation",
	},
	"welcome.tier.": { values: ["minimal", "recommended", "maximum"], why: "src/shared/ollama-types.ts:47 ModelTier" },
	"welcome.card.fit.": { values: ["vram", "ram", "offload"], why: "src/shared/ollama-types.ts:52 ModelFit" },
	"welcome.card.speed.": { values: ["fast", "moderate", "slow"], why: "src/shared/ollama-types.ts:53 ModelSpeed" },
};

/** Decides one review key against one locale-key pattern, or undefined when no rule covers the pattern. */
function decideOne(key: string, pattern: DynamicPattern, submenu: Map<string, string>): ReviewDecision | undefined {
	if (pattern.kind === "prefix" && pattern.text === "cmd.") {
		const site = submenu.get(key);
		return site
			? { key, decision: "keep", why: site }
			: { key, decision: "delete", why: "no submenu item builds this key" };
	}
	const set = pattern.kind === "prefix" ? VALUE_SETS[pattern.text] : undefined;
	if (!set) return undefined;
	return set.values.includes(key.slice(pattern.text.length))
		? { key, decision: "keep", why: set.why }
		: { key, decision: "delete", why: `no value of ${set.why} builds this key` };
}

function decide(key: string, matched: DynamicPattern[], submenu: Map<string, string>): ReviewDecision | undefined {
	const keyPatterns = matched.filter(pattern => !(patternId(pattern) in NOT_KEY_PATTERNS));
	if (keyPatterns.length === 0) {
		const why = matched.map(pattern => NOT_KEY_PATTERNS[patternId(pattern)]).join("; ");
		return { key, decision: "delete", why: `not a locale key pattern: ${why}` };
	}
	const decisions = keyPatterns.map(pattern => decideOne(key, pattern, submenu));
	if (decisions.some(entry => entry === undefined)) return undefined;
	const settled = decisions as ReviewDecision[];
	return settled.find(entry => entry.decision === "keep") ?? settled[0];
}

function main(): void {
	const keys = loadKeys();
	for (const path of sourceFiles(srcDir)) scan(path);
	const submenu = submenuKeys();
	const all = [...patterns.values()];

	const unused: string[] = [];
	const review: string[] = [];
	const reviewDecisions: ReviewDecision[] = [];
	const undecided: string[] = [];
	for (const key of keys) {
		if (literals.has(key)) continue;
		const matched = all.filter(pattern =>
			pattern.kind === "prefix" ? key.startsWith(pattern.text) : key.endsWith(pattern.text),
		);
		if (matched.length === 0) {
			unused.push(key);
			continue;
		}
		review.push(key);
		const decision = decide(key, matched, submenu);
		if (decision) reviewDecisions.push(decision);
		else undecided.push(`${key} ← ${matched.map(pattern => pattern.sites.join(", ")).join("; ")}`);
	}

	const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
	const result = {
		unused: unused.sort(),
		review: review.sort(),
		dynamicPrefixes: all.map(pattern => (pattern.kind === "prefix" ? pattern.text : `*${pattern.text}`)).sort(),
		dynamicSites: Object.fromEntries(
			all
				.map(pattern => [pattern.kind === "prefix" ? pattern.text : `*${pattern.text}`, pattern.sites] as const)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		),
		reviewDecisions: reviewDecisions.sort(byKey),
		...(undecided.length > 0 ? { undecided: undecided.sort() } : {}),
	};
	writeFileSync(outPath, `${JSON.stringify(result, null, "\t")}\n`);
	const deletes = reviewDecisions.filter(entry => entry.decision === "delete").length;
	console.log(
		`keys ${keys.length}; unused ${unused.length}; review ${review.length} (delete ${deletes}, keep ${reviewDecisions.length - deletes}); patterns ${all.length} → ${relative(cwd, outPath)}`,
	);
	if (undecided.length > 0) {
		// A review key no rule decides fails the run, so a new pattern is never skipped silently.
		console.error(`${undecided.length} review keys have no decision rule:\n${undecided.sort().join("\n")}`);
		process.exitCode = 1;
	}
}

main();
