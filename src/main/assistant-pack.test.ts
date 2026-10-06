import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASSISTANT_PACK_FILES,
	assistantPackEnv,
	assistantPackFlags,
	missingAssistantPackFile,
	missingAssistantPackMessage,
	resolveAssistantPackDir,
} from "./assistant-pack";

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

const temps: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "sai-atlas-pack-test-"));
	temps.push(dir);
	return dir;
}

function writePack(packDir: string, files: readonly string[]): void {
	for (const file of files) {
		const path = join(packDir, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "x");
	}
}

function writeFile(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "x");
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("assistant pack", () => {
	it("builds the linux pack flags in order", () => {
		expect(assistantPackFlags("/opt/pack", "linux")).toEqual([
			"--no-extensions",
			"--extension",
			"/opt/pack",
			"--tools",
			"read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean",
			"--system-prompt",
			join("/opt/pack", "system-prompt.md"),
			"--append-system-prompt",
			join("/opt/pack", "append-system-prompt.md"),
			"--config",
			join("/opt/pack", "config.yml"),
			"--approval-mode",
			"always-ask",
		]);
	});

	it("builds the macos pack flags without the os tools", () => {
		const expected = [
			"--no-extensions",
			"--extension",
			"/opt/pack",
			"--tools",
			"read,glob,write,ask,office_report,office_slides,office_clean",
			"--system-prompt",
			join("/opt/pack", "system-prompt.md"),
			"--append-system-prompt",
			join("/opt/pack", "append-system-prompt.md"),
			"--config",
			join("/opt/pack", "config.yml"),
			"--approval-mode",
			"always-ask",
		];
		expect(assistantPackFlags("/opt/pack", "darwin")).toEqual(expected);
		// Every platform other than Linux gets the list without the OS tools.
		expect(assistantPackFlags("/opt/pack", "win32")).toEqual(expected);
	});

	it("resolves the pack beside the sidecar binary", () => {
		const root = tempRoot();
		const binary = join(root, "bundle", "omp");
		writeFile(binary);
		writePack(join(root, "bundle", "assistant-pack"), PACK_FILES);
		// A pack under a search root never wins over the one beside the binary.
		writePack(join(root, "repo", "resources", "assistant-pack"), PACK_FILES);
		expect(resolveAssistantPackDir(binary, [join(root, "repo")])).toBe(join(root, "bundle", "assistant-pack"));

		// The binary is not resolved through a symlink: a worktree links its sidecar
		// into the main checkout but keeps its own pack.
		const linked = join(root, "worktree", "resources", "omp.linux-x64");
		mkdirSync(dirname(linked), { recursive: true });
		symlinkSync(binary, linked);
		writePack(join(root, "worktree", "resources", "assistant-pack"), PACK_FILES);
		expect(resolveAssistantPackDir(linked)).toBe(join(root, "worktree", "resources", "assistant-pack"));
	});

	it("resolves the pack under resources for a fixture sidecar outside the tree", () => {
		const root = tempRoot();
		const fixture = join(root, "e2e", "sidecar-fixture.ts");
		writeFile(fixture);
		writePack(join(root, "resources", "assistant-pack"), PACK_FILES);
		const appPath = join(root, "out", "main");
		mkdirSync(appPath, { recursive: true });

		// The search walks up from each root, as the bundled-binary lookup does.
		expect(resolveAssistantPackDir(fixture, [appPath])).toBe(join(root, "resources", "assistant-pack"));
		// Without search roots, or when no root holds a pack, the beside-binary
		// path comes back so the missing-file message can name it.
		expect(resolveAssistantPackDir(fixture)).toBe(join(root, "e2e", "assistant-pack"));
		const empty = tempRoot();
		expect(resolveAssistantPackDir(fixture, [empty])).toBe(join(root, "e2e", "assistant-pack"));
	});

	it("builds the pack env with the session language", () => {
		expect(assistantPackEnv({ language: "vi" })).toEqual({ SAI_ATLAS_LANG: "vi" });
		expect(assistantPackEnv({ language: "en" })).toEqual({ SAI_ATLAS_LANG: "en" });
	});

	it("refuses to spawn when a pack file is missing", () => {
		expect([...ASSISTANT_PACK_FILES]).toEqual(PACK_FILES);
		const complete = join(tempRoot(), "assistant-pack");
		writePack(complete, ASSISTANT_PACK_FILES);
		expect(missingAssistantPackFile(complete)).toBeNull();

		for (const left of ASSISTANT_PACK_FILES) {
			const pack = join(tempRoot(), "assistant-pack");
			writePack(
				pack,
				ASSISTANT_PACK_FILES.filter(file => file !== left),
			);
			expect(missingAssistantPackFile(pack)).toBe(left);

			const packaged = missingAssistantPackMessage(left, true);
			expect(packaged).toContain(left);
			expect(packaged).toContain("Reinstall Sai ATLAS");
			const dev = missingAssistantPackMessage(left, false);
			expect(dev).toContain(left);
			expect(dev).toContain("bun run build:pack");
		}
	});

	it("ships the tool list the pack check expects", () => {
		const script = readFileSync(
			fileURLToPath(new URL("../../scripts/check-assistant-pack.ts", import.meta.url)),
			"utf8",
		);
		expect(script).toMatch(
			/import\s*\{[^}]*\bassistantPackFlags\b[^}]*\}\s*from\s*"\.\.\/src\/main\/assistant-pack"/,
		);
		expect(script).not.toContain("office_report");
	});
});
