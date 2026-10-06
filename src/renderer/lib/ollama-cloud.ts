/**
 * Ollama cloud models (`gpt-oss:120b-cloud`, `kimi-k2:cloud`, `x-cloud`) run on
 * Ollama's servers, so a conversation sent to one leaves the computer. Sai
 * ATLAS uses only local models: every place that pulls a model or makes one
 * the session or default model refuses these. A tag is one when its name or
 * its `:tag` part ends with `-cloud` or is `cloud`.
 */
export function isCloudTag(input: string): boolean {
	const tag = input.trim().toLowerCase();
	const colon = tag.indexOf(":", tag.lastIndexOf("/") + 1);
	const parts = colon === -1 ? [tag] : [tag.slice(0, colon), tag.slice(colon + 1)];
	return parts.some(part => part === "cloud" || part.endsWith("-cloud"));
}
