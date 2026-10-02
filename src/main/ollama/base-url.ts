/**
 * The Ollama endpoint, resolved exactly as the agent resolves its implicit
 * Ollama provider (`packages/coding-agent/src/config/model-discovery.ts`,
 * `getImplicitOllamaBaseUrl` + `normalizeOllamaBaseUrl`), so the GUI probes
 * and pulls against the same daemon the agent will talk to.
 */
import { resolveLoginShellEnv } from "../shell-env";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_HOST_DEFAULT_PORT = "11434";

/** `OLLAMA_HOST` accepts `host`, `host:port`, `:port`, `//host` or a full URL; anything else is ignored. */
export function normalizeOllamaHostEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const candidate = trimmed.includes("://")
		? trimmed
		: trimmed.startsWith("//")
			? `http:${trimmed}`
			: trimmed.startsWith(":")
				? `http://127.0.0.1${trimmed}`
				: `http://${trimmed}`;
	try {
		const parsed = new URL(candidate);
		if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
			return undefined;
		}
		if (!parsed.port && parsed.protocol === "http:") {
			parsed.port = OLLAMA_HOST_DEFAULT_PORT;
		}
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return undefined;
	}
}

/** Reduce a base URL to `protocol//host`, the root the native `/api/*` routes hang off. */
function endpointOf(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return DEFAULT_OLLAMA_BASE_URL;
	}
}

/** `OLLAMA_BASE_URL` → normalised `OLLAMA_HOST` → `http://127.0.0.1:11434`, reduced to its endpoint. */
export function ollamaBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
	const baseUrl = env.OLLAMA_BASE_URL?.trim();
	return endpointOf(baseUrl || normalizeOllamaHostEnv(env.OLLAMA_HOST) || DEFAULT_OLLAMA_BASE_URL);
}

let cached: Promise<string> | undefined;

/**
 * The endpoint for this app run. The sidecar sees the login-shell env with the
 * launch env winning (`shellSpawnEnv`), so the same precedence applies here.
 * Cached: the shell probe can take seconds, and status probes have a 1.5 s budget.
 */
export function resolveOllamaBaseUrl(): Promise<string> {
	cached ??= resolveLoginShellEnv().then(
		shell => ollamaBaseUrl({ ...shell.env, ...process.env }),
		() => ollamaBaseUrl(process.env),
	);
	return cached;
}

/** Test seam: forget the cached endpoint. */
export function resetOllamaBaseUrlCache(): void {
	cached = undefined;
}
