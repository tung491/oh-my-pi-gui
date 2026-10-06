import type { SessionKind } from "../../shared/ipc-types";
import type { AvailableCommand } from "../../shared/rpc-types";

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
	"plugin",
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
	// The agent's `/wt` (alias `/worktree`) moves the session into a new git
	// worktree; every git surface is gone from the assistant.
	"wt",
	"worktree",
]);

/**
 * Aliases the agent resolves to a removed command that it can run over RPC
 * (its builtin lookup registers aliases next to names). They are listed here
 * so a typed alias stays blocked before the advertised command list arrives.
 * Aliases of terminal-only builtins (`/status`, `/rewind`) are left out: the
 * agent cannot run those over RPC, so the name stays free for other commands.
 */
const AGENT_ALIASES_OF_REMOVED: Readonly<Record<string, string>> = {
	plugin: "plugins",
	worktree: "wt",
};

/**
 * The removed command a typed slash message would run, or null. Mirrors the
 * agent's own parser: the name is the text after `/` up to the first
 * whitespace or `:` (`/share:x` runs `share`), and an alias runs its
 * canonical command, whether listed above or advertised in `commands`.
 */
export function removedCommandName(message: string, commands: readonly AvailableCommand[]): string | null {
	if (!message.startsWith("/")) return null;
	const typed = message.slice(1).split(/[\s:]/, 1)[0]?.toLowerCase() ?? "";
	if (!typed) return null;
	const advertised = commands.find(command => command.aliases?.some(alias => alias.toLowerCase() === typed))?.name;
	const canonical = (advertised ?? AGENT_ALIASES_OF_REMOVED[typed] ?? typed).toLowerCase();
	if (REMOVED_COMMANDS.has(canonical)) return canonical;
	return REMOVED_COMMANDS.has(typed) ? typed : null;
}

/** Whether `name` can run in a tab of this kind. */
export function isCommandAvailable(kind: SessionKind, name: string): boolean {
	return kind !== "chat" || !CHAT_DEAD_COMMANDS.has(name);
}
