/**
 * Contract tests for launch profiles: the flag mapping, the launch-flag
 * allowlist (which guarantees a profile can never override sidecar-owned
 * argv like --session/--mode), prefs-JSON parsing,
 * and the effective-command-line preview shown in Settings.
 */
import { describe, expect, it } from "vitest";
import {
	allowedLaunchFlags,
	flagsToCommandLine,
	parseLaunchProfile,
	profileToFlags,
} from "../../shared/launch-profile";

/** Bare flags that change what a session loads or approves. */
const BARE_PACK_FLAGS = [
	"--no-tools",
	"--no-extensions",
	"--no-skills",
	"--auto-approve",
	"--yolo",
	"--plan-yolo",
	"--no-rules",
	"--no-context-files",
	"--chat",
];

/** Valued flags that change what a session loads or approves; the value goes with them. */
const VALUED_PACK_FLAGS = [
	"--extension",
	"--hook",
	"--tools",
	"--system-prompt",
	"--system-prompt-template",
	"--append-system-prompt",
	"--config",
	"--approval-mode",
	"--skills",
	"--plugin-dir",
	"--trusted-extension",
	"--profile",
	"--plan-yolo-into",
	"--add-dir",
];

/** Flags the GUI owns: session continuity, the rpc-ui transport, process chrome, credentials. */
const GUI_OWNED_FLAGS = [
	"--session",
	"--mode",
	"--print",
	"--print-thoughts",
	"--export",
	"--cwd",
	"--resume",
	"--fork",
	"--help",
	"--version",
	"--no-pty",
	"--no-title",
	"--no-auto-resume",
	"--api-key",
];

/** Every flag a launch profile must never pass. */
const PROTECTED_FLAGS = [...GUI_OWNED_FLAGS, ...BARE_PACK_FLAGS, ...VALUED_PACK_FLAGS];

describe("profileToFlags mapping", () => {
	it("maps every field to its CLI flag in a fixed order", () => {
		const flags = profileToFlags({
			systemPrompt: "You are terse.",
			appendSystemPrompt: "Always run tests.",
			noRules: true,
			addDirs: ["/tmp/a", "/tmp/b"],
			tools: ["read", "bash"],
			noLsp: true,
			planYolo: true,
			profile: "fast",
			sessionDir: " /tmp/sessions ",
			config: "/tmp/config.yml",
		});
		// Only the fields that cannot change what the session loads still map.
		expect(flags).toEqual(["--no-lsp", "--session-dir", "/tmp/sessions"]);
	});

	it("emits nothing for an empty profile", () => {
		expect(profileToFlags({})).toEqual([]);
	});

	it("skips blank strings, false booleans, and empty arrays", () => {
		expect(
			profileToFlags({
				systemPrompt: "   ",
				appendSystemPrompt: "",
				noRules: false,
				addDirs: [],
				tools: [],
				noLsp: false,
				planYolo: false,
				profile: "  ",
				sessionDir: "",
				config: " ",
			}),
		).toEqual([]);
	});

	it("emits no prompt flag, whatever the prompt holds", () => {
		expect(profileToFlags({ systemPrompt: "You are terse." })).toEqual([]);
		expect(profileToFlags({ appendSystemPrompt: "line one\nline two\n" })).toEqual([]);
	});

	it("emits no --tools flag for a tool list", () => {
		expect(profileToFlags({ tools: [" read ", "", "bash"] })).toEqual([]);
	});

	it("emits no --add-dir flag for extra directories", () => {
		expect(profileToFlags({ addDirs: [" /data ", ""] })).toEqual([]);
	});
});

describe("allowlist", () => {
	it("drops every code-controlled flag, value token included", () => {
		for (const flag of PROTECTED_FLAGS) {
			expect(allowedLaunchFlags([flag, "value", "--no-lsp"])).toEqual(["--no-lsp"]);
		}
	});

	it("drops the --flag=value form in one token", () => {
		expect(allowedLaunchFlags(["--mode=text", "--session=/tmp/x.jsonl", "--no-lsp"])).toEqual(["--no-lsp"]);
	});

	it("does not swallow the next flag-looking token as a value", () => {
		expect(allowedLaunchFlags(["--session", "--session-dir", "/s"])).toEqual(["--session-dir", "/s"]);
	});

	it("keeps non-denylisted flags untouched and in order", () => {
		expect(
			allowedLaunchFlags([
				"--no-lsp",
				"--no-rules",
				"--add-dir",
				"/a",
				"--session-dir",
				"/s",
				"--tools",
				"read,bash",
			]),
		).toEqual(["--no-lsp", "--session-dir", "/s"]);
	});

	it("preserves a profile value that merely looks like a denylisted flag", () => {
		// A value equal to a protected flag is DATA, not an override — it must
		// survive pair-aware stripping so the agent receives it as the value.
		expect(profileToFlags({ sessionDir: "--session" })).toEqual(["--session-dir", "--session"]);
		expect(allowedLaunchFlags(["--session-dir", "--session", "--no-lsp"])).toEqual([
			"--session-dir",
			"--session",
			"--no-lsp",
		]);
		expect(allowedLaunchFlags(["--session-dir", "--mode=text"])).toEqual(["--session-dir", "--mode=text"]);
		// A denylisted valued flag takes its value with it, even one that looks like a flag.
		expect(allowedLaunchFlags(["--config", "--mode=text"])).toEqual([]);
	});

	it("profileToFlags can never emit a denylisted flag, even from a crafted profile object", () => {
		const crafted = {
			"--session": "hijack",
			session: "hijack",
			mode: "text",
			systemPrompt: "s",
			appendSystemPrompt: "hi",
			noRules: true,
			addDirs: ["/a"],
			tools: ["bash"],
			noLsp: true,
			planYolo: true,
			profile: "p",
			sessionDir: "/s",
			config: "/c.yml",
		};
		const flags = profileToFlags(parseLaunchProfile(crafted));
		expect(flags).toEqual(["--no-lsp", "--session-dir", "/s"]);
		for (const token of flags) {
			expect(PROTECTED_FLAGS).not.toContain(token);
		}
	});

	it.each(BARE_PACK_FLAGS)("drops the bare %s flag", flag => {
		expect(allowedLaunchFlags([flag, "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(allowedLaunchFlags([`${flag}=1`, "--no-lsp"])).toEqual(["--no-lsp"]);
	});

	it.each(VALUED_PACK_FLAGS)("drops %s and its value", flag => {
		expect(allowedLaunchFlags([flag, "/value", "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(allowedLaunchFlags([`${flag}=/value`, "--no-lsp"])).toEqual(["--no-lsp"]);
	});

	it("drops -e and its value", () => {
		expect(allowedLaunchFlags(["-e", "/y", "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(allowedLaunchFlags(["-e/y", "--session-dir", "/s"])).toEqual(["--session-dir", "/s"]);
	});

	it("drops an unknown short option and its value", () => {
		expect(allowedLaunchFlags(["-x", "value", "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(allowedLaunchFlags(["stray", "--no-lsp", "-", "--"])).toEqual(["--no-lsp"]);
	});

	it.each([
		["--=x"],
		["--continue"],
		["--from-claude", "/claude/session"],
		["--from-codex", "/codex/session"],
		["--advisor"],
		["--alias", "name"],
		["--allow-home"],
		["--model", "gpt"],
	])("drops %s, which is not on the allowlist", (...tokens: string[]) => {
		expect(allowedLaunchFlags([...tokens, "--no-lsp", "--session-dir", "/s"])).toEqual([
			"--no-lsp",
			"--session-dir",
			"/s",
		]);
	});

	it("keeps only --no-lsp and --session-dir with its value", () => {
		expect(allowedLaunchFlags(["--no-lsp", "--session-dir", "/s"])).toEqual(["--no-lsp", "--session-dir", "/s"]);
		// Only the exact spellings pass: no inline values, no dangling --session-dir.
		expect(allowedLaunchFlags(["--no-lsp=1", "--session-dir=/s", "--session-dir"])).toEqual([]);
	});
});

describe("parseLaunchProfile", () => {
	it("rejects non-objects", () => {
		expect(parseLaunchProfile(null)).toEqual({});
		expect(parseLaunchProfile(undefined)).toEqual({});
		expect(parseLaunchProfile("nope")).toEqual({});
		expect(parseLaunchProfile([1, 2])).toEqual({});
	});

	it("keeps valid fields and drops unknown keys", () => {
		expect(
			parseLaunchProfile({
				systemPrompt: "s",
				appendSystemPrompt: "a",
				noRules: true,
				addDirs: ["/a", 42, " "],
				tools: ["read", null, "bash"],
				noLsp: true,
				planYolo: false,
				profile: " p ",
				sessionDir: "/s",
				config: "/c.yml",
				"--mode": "text",
				extra: "unknown",
			}),
		).toEqual({
			systemPrompt: "s",
			appendSystemPrompt: "a",
			noRules: true,
			addDirs: ["/a"],
			tools: ["read", "bash"],
			noLsp: true,
			profile: "p",
			sessionDir: "/s",
			config: "/c.yml",
		});
	});

	it("normalizes an all-empty profile to the empty object (no profile)", () => {
		expect(parseLaunchProfile({ systemPrompt: " ", addDirs: [], noRules: false })).toEqual({});
	});
});

describe("flagsToCommandLine preview", () => {
	it("renders safe tokens bare and quotes tokens with whitespace", () => {
		expect(flagsToCommandLine(["--tools", "read,bash", "--append-system-prompt", "be nice"])).toBe(
			"--tools read,bash --append-system-prompt 'be nice'",
		);
	});

	it("escapes embedded single quotes POSIX-style", () => {
		expect(flagsToCommandLine(["it's"])).toBe("'it'\\''s'");
	});

	it("quotes newlines and empty strings", () => {
		expect(flagsToCommandLine(["a\nb", ""])).toBe("'a\nb' ''");
	});

	it("renders the empty flag list as an empty string", () => {
		expect(flagsToCommandLine([])).toBe("");
	});
});
