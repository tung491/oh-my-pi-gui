/**
 * Model picker filters run only on data the renderer already holds: the search
 * query over the catalog fields, the login providers' auth state, and the
 * catalog's own `reasoning` flag. A filter with no backing data is never offered.
 */

import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../shared/rpc-types";
import { availableFilters, filterModels } from "./model-filters";

const SONNET: ModelInfo = {
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	description: "Coding",
	reasoning: true,
};
const HAIKU: ModelInfo = { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false };
const GEMINI: ModelInfo = {
	provider: "google",
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	description: "Fast exploration",
	reasoning: false,
};
/** A catalog entry that does not report `reasoning` at all. */
const LOCAL: ModelInfo = { provider: "ollama", id: "qwen3:8b" };
const MODELS = [SONNET, HAIKU, GEMINI, LOCAL];

const everyone = () => true;

describe("filterModels", () => {
	it("keeps every model, in order, for an empty or blank query with the all filter", () => {
		expect(filterModels(MODELS, { query: "", filter: "all", isConnected: everyone })).toEqual(MODELS);
		expect(filterModels(MODELS, { query: "   ", filter: "all", isConnected: everyone })).toEqual(MODELS);
	});

	it("matches the query case-insensitively against id, provider, name, and description", () => {
		const search = (query: string) =>
			filterModels(MODELS, { query, filter: "all", isConnected: everyone }).map(model => model.id);
		expect(search("QWEN3")).toEqual(["qwen3:8b"]);
		expect(search("Google")).toEqual(["gemini-3-flash"]);
		expect(search("haiku 4.5")).toEqual(["claude-haiku-4-5"]);
		expect(search("exploration")).toEqual(["gemini-3-flash"]);
		expect(search("  sonnet  ")).toEqual(["claude-sonnet-4-5"]);
		expect(search("no-such-model")).toEqual([]);
	});

	it("keeps only models whose provider is connected under the connected filter", () => {
		const connected = new Set(["anthropic"]);
		const result = filterModels(MODELS, {
			query: "",
			filter: "connected",
			isConnected: provider => connected.has(provider),
		});
		expect(result).toEqual([SONNET, HAIKU]);
	});

	it("keeps only models that report reasoning === true under the reasoning filter", () => {
		expect(filterModels(MODELS, { query: "", filter: "reasoning", isConnected: everyone })).toEqual([SONNET]);
	});

	it("applies the query and the filter together", () => {
		const result = filterModels(MODELS, {
			query: "claude",
			filter: "connected",
			isConnected: provider => provider === "anthropic",
		});
		expect(result).toEqual([SONNET, HAIKU]);
		expect(
			filterModels(MODELS, { query: "haiku", filter: "reasoning", isConnected: everyone }).map(model => model.id),
		).toEqual([]);
	});
});

describe("availableFilters", () => {
	it("offers reasoning when at least one model reasons", () => {
		expect(availableFilters(MODELS)).toEqual(["all", "connected", "reasoning"]);
	});

	it("omits reasoning when no model reports it, and never offers a fast filter", () => {
		const filters = availableFilters([HAIKU, GEMINI, LOCAL]);
		expect(filters).toEqual(["all", "connected"]);
		expect(filters).not.toContain("fast");
		expect(availableFilters(MODELS)).not.toContain("fast");
		expect(availableFilters([])).toEqual(["all", "connected"]);
	});
});
