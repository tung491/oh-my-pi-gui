import type { SessionKind } from "../../shared/ipc-types";

/**
 * The one availability rule for slash commands, shared by every surface that
 * advertises them (composer completion, ⌘K palette). A command that cannot do
 * anything in the current tab must not be offered — or must be visibly off.
 */

/**
 * Commands dead on chat tabs: the tool-spawning commands (task/tan). Session
 * and transport commands (/compact, /clear, /model, /export…) still work
 * tool-free and stay available.
 */
export const CHAT_DEAD_COMMANDS: ReadonlySet<string> = new Set(["task", "tan"]);

/**
 * Commands the assistant does not offer. omp advertises its own version of
 * several of them (`/share` uploads the session, `/mcp` edits servers), so the
 * palette and the slash completion skip these names when they list advertised
 * commands, and the composer refuses them when typed, instead of handing them
 * to the agent.
 */
export const REMOVED_COMMANDS: ReadonlySet<string> = new Set([
	"new-chat-tab",
	"import",
	"handoff",
	"share",
	"branch",
	"tree",
	"model-roles",
	"model-compare",
	"benchmark",
	"context",
	"tools",
	"computer",
	"browser",
	"force",
	"usage",
	"skills",
	"hooks",
	"commands",
	"mcp",
	"mcp panel",
	"mcp list",
	"marketplace",
	"marketplace panel",
	"marketplace list",
	"marketplace installed",
	"plugins",
	"plugins panel",
	"reload-plugins",
	"memory",
	"memory panel",
	"security",
	"templates",
	"ssh",
	"plan",
	"vibe",
	"goal",
	"loop",
	"modes",
	"move",
	"add-dir",
	"remove-dir",
	"dirs",
	"git",
	"stats",
	"extensions",
	"prs",
	"collab",
	"join",
	"leave",
	"debug",
	"live",
	"plan-review",
	"guided-goal",
]);

/** Whether `name` can run in a tab of this kind. */
export function isCommandAvailable(kind: SessionKind, name: string): boolean {
	return kind !== "chat" || !CHAT_DEAD_COMMANDS.has(name);
}
