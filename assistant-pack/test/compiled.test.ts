// Drives the built pack through the compiled sidecar: its tools.js running inside the sidecar's
// own Bun runtime, and the whole pack loaded by omp through the spawn flags. CI has no sidecar
// and sets SKIP_COMPILED=1; anywhere else a missing sidecar fails the suite loudly.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OMP_BIN = join(ROOT, "resources", "omp.linux-x64");
const PACK = join(ROOT, "resources", "assistant-pack");
const CALL_TOOL = join(ROOT, "assistant-pack", "test", "fixtures", "call-tool.mjs");
const CHECK = join(ROOT, "scripts", "check-assistant-pack.ts");
const TIMEOUT_MS = 180_000;

const TOOLS = [
	"read",
	"glob",
	"write",
	"ask",
	"diagnose",
	"system_status",
	"open_item",
	"os_setting",
	"office_report",
	"office_slides",
	"office_clean",
];
const SKILLS = ["sai-os-helpdesk", "slides-from-report", "spreadsheet-cleanup", "word-report"];

let home: string;

function callTool(
	name: string,
	params: unknown,
	lang = "en",
): { status: number | null; result: Record<string, unknown> } {
	const run = spawnSync(OMP_BIN, [CALL_TOOL, PACK, name, JSON.stringify(params)], {
		env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", HOME: home, SAI_ATLAS_LANG: lang },
		encoding: "utf8",
		timeout: TIMEOUT_MS,
	});
	if (run.status !== 0) throw new Error(`call-tool exited ${run.status}: ${run.stdout}\n${run.stderr}`);
	const lines = run.stdout.trim().split("\n");
	return { status: run.status, result: JSON.parse(lines[lines.length - 1]) as Record<string, unknown> };
}

function savedFiles(): string[] {
	const dir = join(home, "Documents", "Sai ATLAS");
	return existsSync(dir) ? readdirSync(dir) : [];
}

describe.skipIf(process.env.SKIP_COMPILED === "1")("the pack in the compiled sidecar", () => {
	beforeAll(() => {
		if (!existsSync(OMP_BIN)) throw new Error(`sidecar binary missing: ${OMP_BIN}`);
		if (!existsSync(join(PACK, "tools.js")))
			throw new Error(`assistant pack missing: ${PACK} (run bun run build:pack)`);
	});

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "sai-atlas-compiled-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it(
		"office_report writes a Word file through tools.js",
		() => {
			const markdown = readFileSync(join(ROOT, "assistant-pack", "test", "fixtures", "notes-en.md"), "utf8");
			const { result } = callTool("office_report", { markdown });
			expect(result.isError).not.toBe(true);
			expect(savedFiles().filter(name => name.endsWith(".docx"))).toHaveLength(1);
		},
		TIMEOUT_MS,
	);

	it(
		"office_clean writes a cleaned copy through tools.js",
		async () => {
			const workbook = new ExcelJS.Workbook();
			workbook.addWorksheet("Data").addRows([
				["Name", "Amount"],
				[" Ann ", "1,500"],
			]);
			const input = join(home, "messy.xlsx");
			await workbook.xlsx.writeFile(input);
			const { result } = callTool("office_clean", { file: input });
			expect(result.isError).not.toBe(true);
			expect(savedFiles()).toContain("messy (cleaned).xlsx");
		},
		TIMEOUT_MS,
	);

	it(
		"office_clean names the copy and writes the check in Vietnamese when SAI_ATLAS_LANG is vi",
		async () => {
			const workbook = new ExcelJS.Workbook();
			workbook.addWorksheet("Data").addRows([
				["Tên", "Số tiền"],
				[" An ", "1.500"],
			]);
			const input = join(home, "doanh-so.xlsx");
			await workbook.xlsx.writeFile(input);
			const { result } = callTool("office_clean", { file: input }, "vi");
			expect(result.isError).not.toBe(true);
			expect(savedFiles()).toContain("doanh-so (đã làm sạch).xlsx");
			expect(JSON.stringify(result)).toContain("1 trang tính, giữ 2 dòng");
		},
		TIMEOUT_MS,
	);

	it(
		"loads the pack into the sidecar",
		() => {
			const stdout = execFileSync("bun", [CHECK, OMP_BIN, PACK], {
				cwd: ROOT,
				env: { ...process.env, HOME: home },
				encoding: "utf8",
				timeout: TIMEOUT_MS,
			});
			for (const tool of TOOLS) expect(stdout).toMatch(new RegExp(`^tool\\s+${tool}$`, "m"));
			for (const skill of SKILLS) expect(stdout).toMatch(new RegExp(`^skill\\s+${skill}$`, "m"));
			expect(stdout).toMatch(/^setting\s+bash\.direnv = "off"\s+\[.*overlay.*\]$/m);
			expect(stdout).toMatch(/^append\s+workspace APPEND_SYSTEM\.md ignored$/m);
			expect(stdout).toMatch(/^context\s+workspace instruction files ignored$/m);
			for (const path of [
				"autoResume",
				"plan.enabled",
				"plan.defaultOnStartup",
				"commands.enableClaudeUser",
				"commands.enableClaudeProject",
				"commands.enableOpencodeUser",
				"commands.enableOpencodeProject",
			]) {
				expect(stdout).toMatch(
					new RegExp(`^setting\\s+${path.replaceAll(".", "\\.")} = false\\s+\\[.*overlay.*\\]$`, "m"),
				);
			}
			for (const path of ["skills.customDirectories", "skills.includeSkills", "skills.ignoredSkills"]) {
				expect(stdout).toMatch(
					new RegExp(`^setting\\s+${path.replaceAll(".", "\\.")} = \\[\\]\\s+\\[.*overlay.*\\]$`, "m"),
				);
			}
			expect(stdout).toContain("PACK LOAD CHECK: PASS");
		},
		TIMEOUT_MS,
	);

	it(
		"ignores the caller's own omp config location",
		() => {
			const agentDir = join(home, "caller-agent");
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "config.yml"), "skills:\n  ignoredSkills: [word-report]\n");
			const run = spawnSync("bun", [CHECK, OMP_BIN, PACK], {
				cwd: ROOT,
				env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
				encoding: "utf8",
				timeout: TIMEOUT_MS,
			});
			expect(`${run.stdout}${run.stderr}`).toContain("PACK LOAD CHECK: PASS");
			expect(run.status).toBe(0);
		},
		TIMEOUT_MS,
	);

	it(
		"refuses a wrong tool list",
		() => {
			const run = spawnSync("bun", [CHECK, OMP_BIN, PACK, "--tools", "read,glob,write,ask,find"], {
				cwd: ROOT,
				env: { ...process.env, HOME: home },
				encoding: "utf8",
				timeout: TIMEOUT_MS,
			});
			expect(run.status).toBe(1);
			expect(`${run.stdout}${run.stderr}`).toContain("find");
		},
		TIMEOUT_MS,
	);
});
