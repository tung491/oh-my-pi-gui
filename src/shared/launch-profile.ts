/**
 * Launch profiles: per-workspace agent CLI customisation configured in the
 * GUI (Settings → Launch Profile), persisted in GUI prefs under
 * `launchProfiles.<cwd>`, and appended to the sidecar spawn argv by
 * src-tauri/src/omp/manager.rs. This module is pure mapping/preview — no I/O —
 * for the renderer's settings form and effective-command preview; manager.rs
 * mirrors the mapping for the spawn.
 *
 * Flag mappings mirror packages/coding-agent/src/cli/flag-tables.ts.
 */

export interface LaunchProfile {
	/** --system-prompt <text>: full system prompt override. */
	systemPrompt?: string;
	/** --append-system-prompt <text>: appended to the default system prompt. */
	appendSystemPrompt?: string;
	/** --no-rules: skip rules files. */
	noRules?: boolean;
	/** --add-dir <path> (repeated): extra directories the agent may touch. */
	addDirs?: string[];
	/** --tools <csv>: tool whitelist (comma-separated, agent normalizes names). */
	tools?: string[];
	/** --no-lsp: disable LSP tooling. */
	noLsp?: boolean;
	/** --plan-yolo: auto-approve plan-mode execution. */
	planYolo?: boolean;
	/** --profile <name>: agent profile to boot from. */
	profile?: string;
	/** --session-dir <path>: where session files live. */
	sessionDir?: string;
	/** --config <path>: config file path. */
	config?: string;
}

/** Profile flags that pass to omp as a bare switch. */
const ALLOWED_BARE_FLAGS: ReadonlySet<string> = new Set(["--no-lsp"]);
/** Profile flags that pass with the next token as their value. */
const ALLOWED_VALUED_FLAGS: ReadonlySet<string> = new Set(["--session-dir"]);

/**
 * Keep only the launch flags a profile may pass: `--no-lsp`, and
 * `--session-dir` with its value as the next token. Neither changes what an
 * assistant session loads, resumes or approves; every other token is dropped,
 * whatever its spelling (`--flag=value`, short options, a bare `--` or `--=x`,
 * which omp reads as end-of-options, and stray positionals). The value of
 * `--session-dir` is data and passes verbatim, even when it looks like a flag;
 * a `--session-dir` with no value after it is dropped.
 */
export function allowedLaunchFlags(flags: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const token = flags[i];
		if (ALLOWED_BARE_FLAGS.has(token)) {
			out.push(token);
		} else if (ALLOWED_VALUED_FLAGS.has(token) && i + 1 < flags.length) {
			out.push(token, flags[i + 1]);
			i++;
		}
	}
	return out;
}

/** Map a launch profile to agent CLI flags. Output order is fixed so the
 * effective command line preview is stable. Only the fields that cannot change
 * what an assistant session loads or approves still map (`--no-lsp`,
 * `--session-dir`); the others stay in the type so stored prefs still parse.
 * The allowlist is also enforced at the sidecar spawn site over the combined
 * user flags (sidecar.ts #spawn). Profile values are data, so a value that
 * looks like a protected flag survives intact. */
export function profileToFlags(profile: LaunchProfile): string[] {
	const flags: string[] = [];
	if (profile.noLsp === true) flags.push("--no-lsp");
	if (typeof profile.sessionDir === "string" && profile.sessionDir.trim() !== "") {
		flags.push("--session-dir", profile.sessionDir.trim());
	}
	return flags;
}

/**
 * Sanitize untrusted prefs JSON into a launch profile. Unknown keys — e.g. a
 * hand-edited prefs file smuggling `"--session"` — are dropped before they
 * can reach the mapping, and empty/blank values are normalized away so a
 * cleaned profile with no keys means "no profile".
 */
export function parseLaunchProfile(raw: unknown): LaunchProfile {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const profile: LaunchProfile = {};
	if (typeof record.systemPrompt === "string" && record.systemPrompt.trim() !== "") {
		profile.systemPrompt = record.systemPrompt;
	}
	if (typeof record.appendSystemPrompt === "string" && record.appendSystemPrompt.trim() !== "") {
		profile.appendSystemPrompt = record.appendSystemPrompt;
	}
	if (record.noRules === true) profile.noRules = true;
	if (Array.isArray(record.addDirs)) {
		const dirs = record.addDirs
			.filter((dir): dir is string => typeof dir === "string")
			.map(dir => dir.trim())
			.filter(dir => dir !== "");
		if (dirs.length > 0) profile.addDirs = dirs;
	}
	if (Array.isArray(record.tools)) {
		const tools = record.tools
			.filter((tool): tool is string => typeof tool === "string")
			.map(tool => tool.trim())
			.filter(tool => tool !== "");
		if (tools.length > 0) profile.tools = tools;
	}
	if (record.noLsp === true) profile.noLsp = true;
	if (record.planYolo === true) profile.planYolo = true;
	if (typeof record.profile === "string" && record.profile.trim() !== "") {
		profile.profile = record.profile.trim();
	}
	if (typeof record.sessionDir === "string" && record.sessionDir.trim() !== "") {
		profile.sessionDir = record.sessionDir.trim();
	}
	if (typeof record.config === "string" && record.config.trim() !== "") {
		profile.config = record.config.trim();
	}
	return profile;
}

/** Shell-safe charset: args outside it are single-quoted in the preview. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quoteShellArg(arg: string): string {
	if (arg.length > 0 && SHELL_SAFE.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Render a flag list as a shell command line suffix (read-only preview). */
export function flagsToCommandLine(flags: readonly string[]): string {
	return flags.map(quoteShellArg).join(" ");
}
