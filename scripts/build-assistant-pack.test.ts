import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strayScripts } from "./build-assistant-pack";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "build-assistant-pack.ts");

/** The files the shells check before every spawn; the build must write exactly these. */
const PACK_FILES = [
	"package.json",
	"tools.js",
	"system-prompt.md",
	"append-system-prompt.md",
	"config.yml",
	"skills/word-report/SKILL.md",
	"skills/spreadsheet-cleanup/SKILL.md",
	"skills/slides-from-report/SKILL.md",
	"skills/sai-os-helpdesk/SKILL.md",
];

let work: string;
let out: string;

function build(...args: string[]) {
	return spawnSync("bun", [SCRIPT, "--out", out, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
}

function files(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [relative(out, path)];
	});
}

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "sai-atlas-build-"));
	out = join(work, "assistant-pack");
	const result = build();
	if (result.status !== 0) throw new Error(`build failed: ${result.stdout}\n${result.stderr}`);
}, 120_000);

afterAll(() => {
	rmSync(work, { recursive: true, force: true });
});

describe("build-assistant-pack", () => {
	it("writes exactly the pack files", () => {
		expect(files(out).sort()).toEqual([...PACK_FILES].sort());
	});

	it("writes the extension manifest", () => {
		expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8"))).toEqual({
			name: "sai-atlas-assistant-pack",
			private: true,
			omp: { extensions: ["./tools.js"] },
		});
	});

	it("bundles every dependency and imports nothing from omp", () => {
		const bundle = readFileSync(join(out, "tools.js"), "utf8");
		expect(bundle).not.toContain('require("@oh-my-pi');
		expect(bundle).not.toMatch(/from\s*["']@oh-my-pi/);
		expect(bundle).not.toMatch(/from\s*["'](docx|exceljs|pptxgenjs|marked)["']/);
	});

	it("copies the text files unchanged", () => {
		for (const name of PACK_FILES.filter(file => file.endsWith(".md") || file.endsWith(".yml"))) {
			expect(readFileSync(join(out, name), "utf8")).toBe(readFileSync(join(ROOT, "assistant-pack", name), "utf8"));
		}
	});

	it("leaves the previous pack untouched when the bundle fails", () => {
		const before = readFileSync(join(out, "tools.js"));
		const broken = join(work, "broken.ts");
		writeFileSync(broken, "export default function (: {\n");
		const result = build("--entry", broken);
		expect(result.status).toBe(1);
		expect(readFileSync(join(out, "tools.js")).equals(before)).toBe(true);
		expect(files(out).sort()).toEqual([...PACK_FILES].sort());
		expect(readdirSync(work).filter(name => name.includes(".tmp-"))).toEqual([]);
	});

	it("finds any .js file other than tools.js", () => {
		const dir = mkdtempSync(join(work, "stray-"));
		writeFileSync(join(dir, "tools.js"), "");
		expect(strayScripts(dir)).toEqual([]);
		mkdirSync(join(dir, "skills"));
		writeFileSync(join(dir, "skills", "helper.js"), "");
		writeFileSync(join(dir, "chunk-1.js"), "");
		expect(strayScripts(dir).sort()).toEqual(["chunk-1.js", join("skills", "helper.js")]);
	});
});
