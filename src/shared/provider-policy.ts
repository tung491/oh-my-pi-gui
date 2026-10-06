/**
 * Which model providers the GUI offers. Every surface that lists providers or
 * models filters through here, so re-enabling a provider is a one-line change.
 */

export const ALLOWED_PROVIDER_IDS = ["ollama"] as const;

export type AllowedProviderId = (typeof ALLOWED_PROVIDER_IDS)[number];

const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_PROVIDER_IDS);

export function isAllowedProvider(id: string): id is AllowedProviderId {
	return ALLOWED.has(id);
}

/** Keeps only models served by an allowed provider, preserving order. */
export function filterAllowedModels<T extends { provider: string }>(models: readonly T[]): T[] {
	return models.filter(model => isAllowedProvider(model.provider));
}

/**
 * Sidecar commands that sign in to or out of a remote provider. Ollama runs
 * locally and needs no account, so neither the palette nor the composer's
 * slash autocomplete offers them; typed by hand the composer refuses them as
 * removed commands.
 */
export const HIDDEN_ACCOUNT_COMMANDS: ReadonlySet<string> = new Set(["login", "logout"]);
