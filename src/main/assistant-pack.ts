/**
 * The assistant pack every sidecar session loads: where it lives, the files it
 * must hold, and the spawn flags and env that load it.
 *
 * Imports only `node:path` and `node:fs`: the Bun pack check script
 * (`scripts/check-assistant-pack.ts`) loads this module as well as the main process.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Every file `scripts/build-assistant-pack.ts` writes, checked before each spawn. */
export const ASSISTANT_PACK_FILES: readonly string[] = [
	"package.json",
	"tools.js",
	"system-prompt.md",
	"config.yml",
	"skills/word-report/SKILL.md",
	"skills/spreadsheet-cleanup/SKILL.md",
	"skills/slides-from-report/SKILL.md",
	"skills/sai-os-helpdesk/SKILL.md",
];

export type AssistantPackLanguage = "en" | "vi";

const PACK_DIR_NAME = "assistant-pack";
/** Ancestor levels searched above each search root, as the bundled-binary lookup does. */
const SEARCH_DEPTH = 8;

/** The pack's typed tools plus the file tools; no shell, no helper sessions. */
const COMMON_TOOLS = ["read", "glob", "write", "ask"];
/** SAI OS helpdesk tools, shipped on Linux only. */
const LINUX_OS_TOOLS = ["diagnose", "system_status", "open_item", "os_setting"];
const OFFICE_TOOLS = ["office_report", "office_slides", "office_clean"];

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The pack directory for a sidecar binary: `assistant-pack/` beside it when
 * that exists (the binary is never resolved through a symlink, so a worktree
 * whose sidecar links into another checkout keeps its own pack). Otherwise the
 * first `resources/assistant-pack` found walking up from each search root,
 * which covers the e2e fixture sidecar and the source sidecar in a dev tree.
 * When nothing is found, the beside-binary path, so the missing-file message
 * names where the pack belongs.
 */
export function resolveAssistantPackDir(binaryPath: string, searchFrom: readonly string[] = []): string {
	const beside = join(dirname(binaryPath), PACK_DIR_NAME);
	if (isDirectory(beside)) return beside;
	for (const start of searchFrom) {
		let dir = start;
		for (let level = 0; level < SEARCH_DEPTH; level++) {
			const candidate = join(dir, "resources", PACK_DIR_NAME);
			if (isDirectory(candidate)) return candidate;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return beside;
}

/** The spawn flags that load the pack; Linux adds the SAI OS tools, every other platform gets the office set only. */
export function assistantPackFlags(packDir: string, platform: string): string[] {
	const tools =
		platform === "linux" ? [...COMMON_TOOLS, ...LINUX_OS_TOOLS, ...OFFICE_TOOLS] : [...COMMON_TOOLS, ...OFFICE_TOOLS];
	return [
		"--no-extensions",
		"--extension",
		packDir,
		"--tools",
		tools.join(","),
		"--system-prompt",
		join(packDir, "system-prompt.md"),
		"--config",
		join(packDir, "config.yml"),
		"--approval-mode",
		"always-ask",
	];
}

/** The env keys the pack's tools read, set last at spawn. */
export function assistantPackEnv(options: { language: AssistantPackLanguage }): Record<string, string> {
	return { SAI_ATLAS_LANG: options.language };
}

/** The first listed pack file that is missing, or `null` when the pack is complete. */
export function missingAssistantPackFile(packDir: string): string | null {
	for (const file of ASSISTANT_PACK_FILES) {
		if (!existsSync(join(packDir, file))) return file;
	}
	return null;
}

/**
 * The "pack incomplete" message, worded for the build that hit it: a dev tree
 * can rebuild the pack, a packaged app has to be reinstalled.
 */
export function missingAssistantPackMessage(file: string, packaged: boolean): string {
	if (!packaged) {
		return `The assistant pack is missing ${file}. Build it with \`bun run build:pack\`, then relaunch.`;
	}
	return `The assistant pack is missing ${file} in this installation. Reinstall Sai ATLAS, then relaunch.`;
}
