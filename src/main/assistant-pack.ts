/**
 * The assistant pack every sidecar session loads: where it lives, the files it
 * must hold, and the spawn flags and env that load it.
 *
 * Imports only `node:path` and `node:fs`: the Bun pack check script
 * (`scripts/check-assistant-pack.ts`) loads this module as well as the main process.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Every file `scripts/build-assistant-pack.ts` writes, checked before each spawn. */
export const ASSISTANT_PACK_FILES: readonly string[] = [
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
 * A source sidecar (`OMP_SIDECAR=source`) has an empty binary path and nothing
 * beside it. When nothing is found, the beside-binary path (or, for a source
 * sidecar, the first search root's `resources/assistant-pack`), so the
 * missing-file message names where the pack belongs. The result is always
 * absolute: omp resolves a relative flag path against the session cwd.
 */
export function resolveAssistantPackDir(binaryPath: string, searchFrom: readonly string[] = []): string {
	const beside = binaryPath ? resolve(dirname(binaryPath), PACK_DIR_NAME) : null;
	if (beside && isDirectory(beside)) return beside;
	for (const root of searchFrom) {
		let dir = resolve(root);
		for (let level = 0; level < SEARCH_DEPTH; level++) {
			const candidate = join(dir, "resources", PACK_DIR_NAME);
			if (isDirectory(candidate)) return candidate;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return beside ?? resolve(searchFrom[0] ?? "", "resources", PACK_DIR_NAME);
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
		// An explicit append prompt (empty) stops omp from appending a workspace's
		// or the user's APPEND_SYSTEM.md to the pack's system prompt.
		"--append-system-prompt",
		join(packDir, "append-system-prompt.md"),
		"--config",
		join(packDir, "config.yml"),
		"--approval-mode",
		"always-ask",
	];
}

/**
 * Env keys removed from every pack session: shell startup files a shell would
 * source inside the pack tools' system programs, and the omp profile selectors,
 * which redirect omp's agent dir (user config, APPEND_SYSTEM.md, models).
 */
export const ASSISTANT_PACK_REMOVED_ENV: readonly string[] = ["BASH_ENV", "ENV", "OMP_PROFILE", "PI_PROFILE"];

/** The env keys the pack's tools read, set last at spawn. */
export function assistantPackEnv(options: { language: AssistantPackLanguage }): Record<string, string> {
	return { SAI_ATLAS_LANG: options.language };
}

/** Bytes read from the head of a session file to find the header line, as the session index does. */
const SESSION_HEAD_BYTES = 32 * 1024;
/** Bytes read for the header line itself, as the session index does. */
const SESSION_HEADER_BYTES = 4096;

/**
 * Whether a session file is stamped `chat` (header `kind`, the second line;
 * the first is the title slot). omp resumes such a file restricted to its
 * stamped tools, without the pack's, so no pack session may start on it. A
 * file that cannot be read or parsed counts as not chat, as the session index
 * degrades.
 */
export function isChatStampedSession(sessionPath: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(sessionPath, "r");
		const head = Buffer.alloc(SESSION_HEAD_BYTES);
		const headLength = readSync(fd, head, 0, head.length, 0);
		const newline = head.subarray(0, headLength).indexOf(0x0a);
		if (newline === -1) return false;
		const header = Buffer.alloc(SESSION_HEADER_BYTES);
		const headerLength = readSync(fd, header, 0, header.length, newline + 1);
		const line = header.subarray(0, headerLength).toString("utf8").split("\n")[0];
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null && (parsed as { kind?: unknown }).kind === "chat";
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
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
