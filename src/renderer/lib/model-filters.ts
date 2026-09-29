/**
 * Model picker filtering over data the renderer already holds: the search
 * query matches the catalog's id, provider, name, and description; "connected"
 * asks the caller whether the provider is signed in; "reasoning" reads the
 * catalog's own flag. Pure, so the picker memoizes it on its inputs.
 */

import type { ModelInfo } from "../../shared/rpc-types";

export type ModelFilter = "all" | "connected" | "reasoning";

export interface ModelFilterOptions {
	query: string;
	filter: ModelFilter;
	/** Whether the provider is authenticated (the picker's login-provider state). */
	isConnected: (provider: string) => boolean;
}

function matchesQuery(model: ModelInfo, query: string): boolean {
	if (query.length === 0) return true;
	return (
		model.id.toLowerCase().includes(query) ||
		model.provider.toLowerCase().includes(query) ||
		model.name?.toLowerCase().includes(query) === true ||
		model.description?.toLowerCase().includes(query) === true
	);
}

function matchesFilter(model: ModelInfo, filter: ModelFilter, isConnected: (provider: string) => boolean): boolean {
	switch (filter) {
		case "all":
			return true;
		case "connected":
			return isConnected(model.provider);
		case "reasoning":
			return model.reasoning === true;
	}
}

/** The models that match both the query and the filter, in catalog order. */
export function filterModels(
	models: readonly ModelInfo[],
	{ query, filter, isConnected }: ModelFilterOptions,
): ModelInfo[] {
	const q = query.trim().toLowerCase();
	return models.filter(model => matchesQuery(model, q) && matchesFilter(model, filter, isConnected));
}

/** The filters worth offering: "reasoning" only when at least one model reports it. */
export function availableFilters(models: readonly ModelInfo[]): ModelFilter[] {
	return models.some(model => model.reasoning === true) ? ["all", "connected", "reasoning"] : ["all", "connected"];
}
