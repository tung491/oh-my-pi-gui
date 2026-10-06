/**
 * Ollama cloud models (`gpt-oss:120b-cloud`, `kimi-k2:cloud`, `x-cloud`) run on
 * Ollama's servers, so a conversation sent to one leaves the computer. Sai
 * ATLAS uses only local models: every place that pulls a model or makes one
 * the session or default model refuses these. A tag is one when its name or
 * any `:` part after it (the tag, or a thinking-level suffix such as
 * `kimi-k2:cloud:low`) ends with `-cloud` or is `cloud`.
 */
export function isCloudTag(input: string): boolean {
	const tag = input.trim().toLowerCase();
	const name = tag.slice(tag.lastIndexOf("/") + 1);
	return name.split(":").some(part => part === "cloud" || part.endsWith("-cloud"));
}

/**
 * Whether a session model runs on this computer: served by the local Ollama
 * provider and not an Ollama cloud tag. Every other model sends the
 * conversation online.
 */
export function isLocalModel(model: { provider: string; id: string }): boolean {
	return model.provider === "ollama" && !isCloudTag(model.id);
}
