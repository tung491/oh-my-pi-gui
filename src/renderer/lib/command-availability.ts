import type { SessionKind } from "../../shared/ipc-types";
import type { AvailableCommand } from "../../shared/rpc-types";
import { isCloudTag } from "./ollama-cloud";

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
	// Signing in to an online provider would let a session send conversations
	// off the computer; the assistant uses only local models.
	"login",
	"logout",
]);

/**
 * Builtin aliases the agent resolves itself (its builtin lookup registers
 * aliases next to names), for the commands the composer refuses. They are
 * listed here so a typed alias stays refused before the advertised command
 * list arrives. Aliases of terminal-only builtins (`/status`, `/rewind`) are
 * left out: the agent cannot run those over RPC, so the name stays free for
 * other commands.
 */
const AGENT_BUILTIN_ALIASES: Readonly<Record<string, string>> = {
	plugin: "plugins",
	worktree: "wt",
	models: "model",
};

interface TypedCommand {
	/** The name as typed, lowercased. */
	typed: string;
	/** The command that name runs, after advertised and builtin aliases. */
	canonical: string;
	/** Everything after the name's separator, trimmed. */
	args: string;
}

/**
 * Reads a typed slash message the way the agent's own parser does: the name
 * is the text after `/` up to the first whitespace or `:` (`/share:x` runs
 * `share` with `x`), and an alias runs its canonical command, whether
 * advertised in `commands` or listed above.
 */
function parseTypedCommand(message: string, commands: readonly AvailableCommand[]): TypedCommand | null {
	if (!message.startsWith("/")) return null;
	const body = message.slice(1);
	const separator = body.search(/[\s:]/);
	const typed = (separator === -1 ? body : body.slice(0, separator)).toLowerCase();
	if (!typed) return null;
	const args = separator === -1 ? "" : body.slice(separator + 1).trim();
	const advertised = commands.find(command => command.aliases?.some(alias => alias.toLowerCase() === typed))?.name;
	const canonical = (advertised ?? AGENT_BUILTIN_ALIASES[typed] ?? typed).toLowerCase();
	return { typed, canonical, args };
}

/** The removed command a typed slash message would run, or null. */
export function removedCommandName(message: string, commands: readonly AvailableCommand[]): string | null {
	const command = parseTypedCommand(message, commands);
	if (!command) return null;
	if (REMOVED_COMMANDS.has(command.canonical)) return command.canonical;
	return REMOVED_COMMANDS.has(command.typed) ? command.typed : null;
}

/** The agent commands that switch the session model to the one named in their arguments. */
const MODEL_SWITCH_COMMANDS: ReadonlySet<string> = new Set(["model", "switch"]);

/**
 * Whether a typed slash message would switch the session to an Ollama cloud
 * model (`/model kimi-k2:cloud`, `/models:x-cloud`, `/switch kimi-k2:cloud:low`).
 * Cloud models send the conversation online, so the composer refuses them as
 * the model picker does. A bare `/model` or `/switch` only reports the current
 * model and passes. Online providers are refused by the agent's pinned model
 * policy, which knows every provider name.
 */
export function cloudModelCommand(message: string, commands: readonly AvailableCommand[]): boolean {
	const command = parseTypedCommand(message, commands);
	return (
		command !== null &&
		MODEL_SWITCH_COMMANDS.has(command.canonical) &&
		command.args !== "" &&
		isCloudTag(command.args)
	);
}

/** Whether `name` can run in a tab of this kind. */
export function isCommandAvailable(kind: SessionKind, name: string): boolean {
	return kind !== "chat" || !CHAT_DEAD_COMMANDS.has(name);
}
