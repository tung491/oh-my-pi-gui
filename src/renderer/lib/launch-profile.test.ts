/**
 * Contract tests for launch profiles (plan B3): the flag mapping, the
 * code-controlled-flag denylist (which guarantees a profile can never
 * override sidecar-owned argv like --session/--mode), prefs-JSON parsing,
 * and the effective-command-line preview shown in Settings.
 */
import { describe, expect, it } from "vitest";
import {
	DENYLISTED_FLAGS,
	flagsToCommandLine,
	parseLaunchProfile,
	profileToFlags,
	stripDenylistedFlags,
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

describe("denylist", () => {
	it("drops every code-controlled flag, value token included", () => {
		for (const flag of [...BARE_PACK_FLAGS, ...VALUED_PACK_FLAGS]) expect(DENYLISTED_FLAGS).toContain(flag);
		for (const flag of DENYLISTED_FLAGS) {
			expect(stripDenylistedFlags([flag, "value", "--no-lsp"])).toEqual(["--no-lsp"]);
		}
	});

	it("drops the --flag=value form in one token", () => {
		expect(stripDenylistedFlags(["--mode=text", "--session=/tmp/x.jsonl", "--no-lsp"])).toEqual(["--no-lsp"]);
	});

	it("does not swallow the next flag-looking token as a value", () => {
		expect(stripDenylistedFlags(["--session", "--session-dir", "/s"])).toEqual(["--session-dir", "/s"]);
	});

	it("keeps non-denylisted flags untouched and in order", () => {
		expect(
			stripDenylistedFlags([
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
		expect(stripDenylistedFlags(["--session-dir", "--session", "--no-lsp"])).toEqual([
			"--session-dir",
			"--session",
			"--no-lsp",
		]);
		expect(stripDenylistedFlags(["--session-dir", "--mode=text"])).toEqual(["--session-dir", "--mode=text"]);
		// A denylisted valued flag takes its value with it, even one that looks like a flag.
		expect(stripDenylistedFlags(["--config", "--mode=text"])).toEqual([]);
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
			expect(DENYLISTED_FLAGS).not.toContain(token);
		}
	});

	it.each(BARE_PACK_FLAGS)("drops the bare %s flag", flag => {
		expect(stripDenylistedFlags([flag, "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(stripDenylistedFlags([`${flag}=1`, "--no-lsp"])).toEqual(["--no-lsp"]);
	});

	it.each(VALUED_PACK_FLAGS)("drops %s and its value", flag => {
		expect(stripDenylistedFlags([flag, "/value", "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(stripDenylistedFlags([`${flag}=/value`, "--no-lsp"])).toEqual(["--no-lsp"]);
	});

	it("drops -e and its value", () => {
		expect(stripDenylistedFlags(["-e", "/y", "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(stripDenylistedFlags(["-e/y", "--session-dir", "/s"])).toEqual(["--session-dir", "/s"]);
	});

	it("drops an unknown short option and its value", () => {
		expect(stripDenylistedFlags(["-x", "value", "--no-lsp"])).toEqual(["--no-lsp"]);
		expect(stripDenylistedFlags(["stray", "--no-lsp", "-", "--"])).toEqual(["--no-lsp"]);
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
