import { describe, expect, it } from "vitest";
import { GenericRenderer } from "./GenericRenderer";
import { getToolRenderer } from "./index";

/**
 * Tools an everyday-work session never loads. Old transcripts that still carry
 * these calls render through the key/value view instead of a dedicated card.
 */
const REMOVED_TOOL_NAMES = [
	"ast_edit",
	"ast_grep",
	"lsp",
	"github",
	"gh",
	"debug",
	"hub",
	"eval",
	"vibe_spawn",
	"vibe_send",
	"vibe_wait",
	"vibe_kill",
	"vibe_list",
] as const;

/** Tools that keep a dedicated card: the session's own tools and the ones old transcripts carry most. */
const KEPT_TOOL_NAMES = ["read", "glob", "write", "ask", "bash", "find", "task", "wait"] as const;

describe("tool renderer inventory", () => {
	it.each(REMOVED_TOOL_NAMES)("renders %s through the generic view", name => {
		expect(getToolRenderer(name)).toBe(GenericRenderer);
	});

	it.each(KEPT_TOOL_NAMES)("keeps a dedicated renderer for %s", name => {
		expect(getToolRenderer(name)).not.toBe(GenericRenderer);
	});
});
