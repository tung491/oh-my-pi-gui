import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const packPath = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(packPath(relative), "utf8");

const SKILLS = ["word-report", "spreadsheet-cleanup", "slides-from-report", "sai-os-helpdesk"] as const;
const OFFICE_SKILLS: Record<string, string> = {
	"word-report": "office_report",
	"slides-from-report": "office_slides",
	"spreadsheet-cleanup": "office_clean",
};

function skill(name: string): { meta: Record<string, unknown>; body: string } {
	const text = read(`skills/${name}/SKILL.md`);
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (!match) throw new Error(`${name}: no frontmatter`);
	return { meta: parse(match[1]) as Record<string, unknown>, body: match[2] };
}

const EXPECTED_CONFIG = {
	temperature: 0.2,
	autoResume: false,
	modelPolicy: { providers: ["ollama"], localOnly: true },
	memory: { backend: "off" },
	shellPath: "/bin/sh",
	bash: {
		patterns: [{ match: "*", approval: "deny" }],
		allowCompoundCommands: false,
		direnv: "off",
	},
	fetch: { enabled: false },
	extensions: [],
	skills: {
		enablePiUser: false,
		enablePiProject: false,
		enableAgentsUser: false,
		enableAgentsProject: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enableCodexUser: false,
		customDirectories: [],
		includeSkills: [],
		ignoredSkills: [],
	},
	commands: {
		enableClaudeUser: false,
		enableClaudeProject: false,
		enableOpencodeUser: false,
		enableOpencodeProject: false,
	},
	plan: { enabled: false, defaultOnStartup: false },
	mcp: { enableProjectConfig: false },
	task: { disabledAgents: ["task", "sonic", "scout", "reviewer", "security-reviewer"] },
	tools: {
		approval: {
			write: "prompt",
			open_item: "prompt",
			os_setting: "prompt",
			office_report: "prompt",
			office_slides: "prompt",
			office_clean: "prompt",
			edit: "deny",
			ast_edit: "deny",
			eval: "deny",
			browser: "deny",
			web_search: "deny",
			github: "deny",
		},
	},
};

describe("skills", () => {
	it.each(SKILLS)("%s has a name matching its folder and a one-line description", name => {
		const { meta, body } = skill(name);
		expect(meta.name).toBe(name);
		expect(typeof meta.description).toBe("string");
		expect((meta.description as string).trim()).not.toBe("");
		expect(meta.description as string).not.toContain("\n");
		expect(body.trim()).not.toBe("");
	});

	it.each(Object.entries(OFFICE_SKILLS))("%s calls %s and never a shell", (name, toolName) => {
		const { body } = skill(name);
		const text = read(`skills/${name}/SKILL.md`);
		expect(body).toContain(toolName);
		for (const banned of ["bash", "$", "~/.cache", "~/.local/share"]) expect(text).not.toContain(banned);
		expect(text.split("\n").some(line => line.startsWith("office "))).toBe(false);
	});

	it("spreadsheet-cleanup names every accepted input", () => {
		const { body } = skill("spreadsheet-cleanup");
		for (const ext of [".xlsx", ".xls", ".ods", ".csv"]) expect(body).toContain(ext);
	});

	it("sai-os-helpdesk diagnoses first and fixes only through the approved tools", () => {
		const text = read("skills/sai-os-helpdesk/SKILL.md");
		for (const toolName of ["diagnose", "os_setting", "open_item"]) expect(text).toContain(toolName);
		expect(text.toLowerCase()).not.toContain("bash");
		expect(text.toLowerCase()).not.toContain("task");
	});

	it("sai-os-helpdesk writes each support note under a new dated name", () => {
		const text = read("skills/sai-os-helpdesk/SKILL.md");
		expect(text).toContain("support-note-YYYY-MM-DD-HHMM.md");
		expect(text).not.toContain("`support-note.md`");
	});
});

describe("system prompt", () => {
	const prompt = read("system-prompt.md");

	it("opens every skill through skill:// and names every office tool", () => {
		for (const name of SKILLS) expect(prompt).toContain(`skill://${name}`);
		for (const toolName of Object.values(OFFICE_SKILLS)) expect(prompt).toContain(toolName);
	});

	it("mentions no helpers and no shell", () => {
		expect(prompt.toLowerCase()).not.toContain("helper");
		expect(prompt.toLowerCase()).not.toContain("bash");
	});

	it("stays under 2 KiB", () => {
		expect(Buffer.byteLength(prompt)).toBeLessThan(2048);
	});

	it("ships an empty append prompt, so no workspace APPEND_SYSTEM.md is ever added", () => {
		// The shells pass this file with --append-system-prompt; omp then skips its
		// APPEND_SYSTEM.md lookup, and an empty append adds nothing.
		expect(read("append-system-prompt.md")).toBe("");
	});
});

describe("config overlay", () => {
	it("pins exactly the approval-relevant settings", () => {
		const config = parse(read("config.yml")) as Record<string, unknown>;
		expect(config).toEqual(EXPECTED_CONFIG);
		expect((config.bash as { direnv: unknown }).direnv).toBe("off");
	});

	it("keeps every session on local Ollama models with no remote memory", () => {
		const config = parse(read("config.yml")) as Record<string, unknown>;
		expect(config.modelPolicy).toEqual({ providers: ["ollama"], localOnly: true });
		expect(config.memory).toEqual({ backend: "off" });
	});
});

describe("pack layout", () => {
	it("ships no agent files and no executables", () => {
		expect(existsSync(packPath("agents"))).toBe(false);
		expect(existsSync(packPath("bin"))).toBe(false);
		for (const name of SKILLS) expect(statSync(packPath(`skills/${name}/SKILL.md`)).mode & 0o111).toBe(0);
	});
});
