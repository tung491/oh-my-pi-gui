/**
 * Which Ollama models and endpoints count as "on this computer". The rules
 * match the sidecar's `modelPolicy.localOnly`, so the GUI never measures or
 * limits a model the agent would refuse to run. Keeps step with
 * `src-tauri/src/ollama/local.rs`; change both together.
 */

/** One `/api/tags` row, as far as the local rules need it. */
export interface OllamaTagRow {
	name: string;
	model?: string;
	/** Model file size in bytes. */
	size?: number;
	/** Set by Ollama on its cloud models and on local copies of them. */
	remote_host?: string;
	remote_model?: string;
}

/** An Ollama cloud model: its name or `:tag` part is `cloud` or ends in `-cloud`. */
export function isOllamaCloudTag(tag: string): boolean {
	return tag
		.toLowerCase()
		.split(":")
		.some(part => part === "cloud" || part.endsWith("-cloud"));
}

/** A model that runs on this computer: not a cloud tag, and not a copy Ollama serves from a remote host. */
export function isLocalOllamaRow(row: OllamaTagRow): boolean {
	if (isOllamaCloudTag(row.name) || (row.model !== undefined && isOllamaCloudTag(row.model))) return false;
	return !row.remote_host && !row.remote_model;
}

/** A dotted IPv4 literal in 127.0.0.0/8, as WHATWG URL serializes every IPv4 host (`127.1` and `0x7f.1` included). */
const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Whether a base URL points at this computer: `localhost`, an IPv4 literal in
 * 127.0.0.0/8, `[::1]`, or `0.0.0.0` (which connects to this host). Any DNS
 * name other than `localhost` is remote, whatever it starts with.
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	return hostname === "localhost" || hostname === "[::1]" || hostname === "0.0.0.0" || LOOPBACK_IPV4.test(hostname);
}
