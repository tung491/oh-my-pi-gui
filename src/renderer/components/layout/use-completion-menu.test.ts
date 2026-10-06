/**
 * applyCompletion contract: the shared completion-apply helper used by the
 * composer's model-delegation (`^selector`) menu among others. It must replace
 * ONLY the provider's [rangeStart, rangeEnd) prefix, never consume text after
 * the live caret, place the caret right after the inserted value, and refuse to
 * apply a stale menu once the caret has moved away from rangeEnd.
 */
import { describe, expect, it } from "vitest";
import type { AvailableCommand } from "../../../shared/rpc-types";
import { applyCompletion, type CompletionItem, type CompletionMenu, slashCommandItems } from "./use-completion-menu";

function menu(rangeStart: number, rangeEnd: number): CompletionMenu {
	return { source: "model", rangeStart, rangeEnd, items: [], index: 0 };
}

const item: CompletionItem = { value: "^anthropic/claude ", label: "^anthropic/claude" };

describe("applyCompletion", () => {
	it("replaces the ^prefix with the selector and lands the caret after it", () => {
		const result = applyCompletion("review ^cl", 10, menu(7, 10), item);
		expect(result).toEqual({ text: "review ^anthropic/claude ", caret: 7 + item.value.length });
	});

	it("preserves text after the caret instead of consuming it", () => {
		const result = applyCompletion("^cl please", 3, menu(0, 3), { value: "^x ", label: "^x" });
		expect(result).toEqual({ text: "^x  please", caret: 3 });
	});

	it("refuses to apply a stale menu once the caret moved off rangeEnd", () => {
		expect(applyCompletion("review ^cl", 9, menu(7, 10), item)).toBeNull();
	});
});

describe("slashCommandItems", () => {
	const commands: AvailableCommand[] = [
		{ name: "login", description: "Sign in", source: "builtin" },
		{ name: "logout", description: "Sign out", source: "builtin" },
		{ name: "compact", description: "Compact", source: "builtin" },
	];

	it("never suggests the account sign-in commands", () => {
		expect(slashCommandItems(commands, "agent", "").map(item => item.label)).toEqual(["/compact"]);
		expect(slashCommandItems(commands, "agent", "log")).toEqual([]);
	});

	it("never suggests a command the assistant removed, even when the agent advertises it", () => {
		const advertised: AvailableCommand[] = [
			{ name: "share", description: "Share", source: "builtin" },
			{ name: "mcp", description: "MCP", source: "builtin" },
			{ name: "compact", description: "Compact", source: "builtin" },
		];
		expect(slashCommandItems(advertised, "agent", "").map(item => item.label)).toEqual(["/compact"]);
		expect(slashCommandItems(advertised, "agent", "sha")).toEqual([]);
	});
});
