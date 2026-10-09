import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASSISTANT_PACK_FILES,
	ASSISTANT_PACK_REMOVED_ENV,
	assistantPackEnv,
	assistantPackFlags,
	isChatStampedSession,
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
			"--no-rules",
			"--no-context-files",
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
			"--no-rules",
			"--no-context-files",
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

	it("resolves the pack from the search roots when the sidecar runs from source", () => {
		const root = tempRoot();
		writePack(join(root, "resources", "assistant-pack"), PACK_FILES);
		const appPath = join(root, "out", "main");
		mkdirSync(appPath, { recursive: true });
		// The main process's cwd holds a pack-shaped folder, as the repo root holds the pack source.
		const cwd = tempRoot();
		writePack(join(cwd, "assistant-pack"), PACK_FILES);
		const previous = process.cwd();
		process.chdir(cwd);
		try {
			// A source sidecar has no binary path: nothing sits beside it, so the search roots decide.
			expect(resolveAssistantPackDir("", [appPath])).toBe(join(root, "resources", "assistant-pack"));
			// The result is always absolute: omp would resolve a relative flag path against the session cwd.
			const unfound = resolveAssistantPackDir("", ["nowhere"]);
			expect(isAbsolute(unfound)).toBe(true);
			expect(unfound).toBe(resolve(cwd, "nowhere", "resources", "assistant-pack"));
			expect(resolveAssistantPackDir(join("bin", "omp"))).toBe(resolve(cwd, "bin", "assistant-pack"));
		} finally {
			process.chdir(previous);
		}
	});

	it("builds the pack env with the session language", () => {
		expect(assistantPackEnv({ language: "vi" })).toEqual({ SAI_ATLAS_LANG: "vi" });
		expect(assistantPackEnv({ language: "en" })).toEqual({ SAI_ATLAS_LANG: "en" });
	});

	it("strips every online provider credential from the pack env", () => {
		// The startup files and profile selectors stay removed, and so does every
		// credential omp would use to reach an online model or search provider:
		// a pack session only ever talks to the local Ollama server.
		for (const key of [
			"BASH_ENV",
			"ENV",
			"OMP_PROFILE",
			"PI_PROFILE",
			"PI_SMOL_MODEL",
			"PI_SLOW_MODEL",
			"PI_PLAN_MODEL",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"OPENAI_API_KEY",
			"GEMINI_API_KEY",
			"GOOGLE_API_KEY",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"OLLAMA_API_KEY",
			"OLLAMA_CLOUD_API_KEY",
			"OPENROUTER_API_KEY",
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_BEARER_TOKEN_BEDROCK",
			"HF_TOKEN",
			"PERPLEXITY_COOKIES",
			"OMP_AUTH_BROKER_URL",
			"OMP_AUTH_BROKER_TOKEN",
		]) {
			expect(ASSISTANT_PACK_REMOVED_ENV).toContain(key);
		}
		expect(new Set(ASSISTANT_PACK_REMOVED_ENV).size).toBe(ASSISTANT_PACK_REMOVED_ENV.length);
		// The local Ollama address and the pack's own language survive.
		expect(ASSISTANT_PACK_REMOVED_ENV).not.toContain("OLLAMA_HOST");
		expect(ASSISTANT_PACK_REMOVED_ENV).not.toContain("SAI_ATLAS_LANG");
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

	it("reads the chat stamp from the session header", () => {
		const dir = tempRoot();
		const session = (name: string, text: string): string => {
			const path = join(dir, name);
			writeFileSync(path, text);
			return path;
		};
		// Line 1 is the title slot, line 2 the header.
		const titleSlot = `${JSON.stringify({ title: "Notes" }).padEnd(255)}\n`;
		const chat = session(
			"chat.jsonl",
			`${titleSlot}${JSON.stringify({ type: "session", id: "c", kind: "chat" })}\n{}\n`,
		);
		const agent = session("agent.jsonl", `${titleSlot}${JSON.stringify({ type: "session", id: "a" })}\n{}\n`);
		expect(isChatStampedSession(chat)).toBe(true);
		expect(isChatStampedSession(agent)).toBe(false);
		// A file that cannot be read or parsed is not refused, as the session index degrades.
		expect(isChatStampedSession(join(dir, "missing.jsonl"))).toBe(false);
		expect(isChatStampedSession(session("empty.jsonl", ""))).toBe(false);
		expect(isChatStampedSession(session("one-line.jsonl", '{"kind":"chat"}'))).toBe(false);
		expect(isChatStampedSession(session("broken.jsonl", `${titleSlot}{"kind":"chat"\n`))).toBe(false);
		expect(isChatStampedSession(dir)).toBe(false);
	});

	it("ships the tool list the pack check expects", () => {
		const script = readFileSync(fileURLToPath(new URL("./check-assistant-pack.ts", import.meta.url)), "utf8");
		expect(script).toMatch(/import\s*\{[^}]*\bassistantPackFlags\b[^}]*\}\s*from\s*"\.\/assistant-pack"/);
		expect(script).not.toContain("office_report");
	});
});
