/**
 * removedCommandName mirrors how the agent itself reads a typed slash command:
 * the name ends at the first whitespace or `:`, and an alias runs its
 * canonical command. A removed command must stay blocked in every spelling the
 * agent would still execute, while skill invocations (`/skill:<name>`) and
 * kept commands pass through.
 */
import { describe, expect, it } from "vitest";
import type { AvailableCommand } from "../../shared/rpc-types";
import { cloudModelCommand, REMOVED_COMMANDS, removedCommandName } from "./command-availability";

const builtin = (name: string, aliases?: string[]): AvailableCommand => ({
	name,
	description: name,
	source: "builtin",
	textModeExecutable: true,
	...(aliases ? { aliases } : {}),
});

describe("removedCommandName", () => {
	it.each([
		["/share", "share"],
		["/share now", "share"],
		["/share:x", "share"],
		["/collab:start", "collab"],
		["/mcp panel", "mcp"],
		["/SHARE", "share"],
		["/force:read", "force"],
	])("cuts %s at whitespace or a colon and returns %s", (message, expected) => {
		expect(removedCommandName(message, [])).toBe(expected);
	});

	it("blocks the plugin and worktree commands, aliases included, before commands are advertised", () => {
		expect(removedCommandName("/plugin list", [])).toBe("plugins");
		expect(removedCommandName("/plugins enable x@y", [])).toBe("plugins");
		expect(removedCommandName("/wt", [])).toBe("wt");
		expect(removedCommandName("/worktree feature", [])).toBe("wt");
		expect(REMOVED_COMMANDS.has("plugin")).toBe(true);
		expect(REMOVED_COMMANDS.has("wt")).toBe(true);
		expect(REMOVED_COMMANDS.has("worktree")).toBe(true);
	});

	it("resolves advertised aliases to their removed canonical command", () => {
		const commands = [builtin("share", ["publish"]), builtin("compact", ["squash"])];
		expect(removedCommandName("/publish now", commands)).toBe("share");
		expect(removedCommandName("/publish:x", commands)).toBe("share");
		expect(removedCommandName("/squash", commands)).toBeNull();
	});

	it("lets kept commands, skill invocations and plain text through", () => {
		expect(removedCommandName("/compact", [])).toBeNull();
		expect(removedCommandName("/skill:word-report make it", [])).toBeNull();
		expect(removedCommandName("/new", [])).toBeNull();
		expect(removedCommandName("share this file", [])).toBeNull();
		expect(removedCommandName("/", [])).toBeNull();
		expect(removedCommandName("", [])).toBeNull();
	});
});

describe("cloudModelCommand", () => {
	it.each([
		"/model kimi-k2:cloud",
		"/model x-cloud",
		"/model:kimi-k2:cloud",
		"/MODEL  ollama/gpt-oss:120b-cloud ",
		"/models kimi-k2:cloud",
	])("refuses a cloud model chosen by %s", message => {
		expect(cloudModelCommand(message, [])).toBe(true);
	});

	it("follows an alias the agent advertises for the model command", () => {
		expect(cloudModelCommand("/m kimi-k2:cloud", [builtin("model", ["m"])])).toBe(true);
		expect(cloudModelCommand("/m kimi-k2:cloud", [])).toBe(false);
	});

	it.each(["/model", "/model ", "/model llama3:8b", "/model qwen3:cloudy", "/compact kimi-k2:cloud", "model x-cloud"])(
		"lets %s through",
		message => {
			expect(cloudModelCommand(message, [])).toBe(false);
		},
	);
});
