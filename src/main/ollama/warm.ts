/**
 * Loads a model into memory ahead of the first chat turn: `POST /api/generate`
 * with no prompt makes Ollama load it and keep it resident for `keep_alive`.
 */
import { isValidModelTag } from "./pull";

export const WARM_KEEP_ALIVE = "10m";
/** Loading a large model from disk can take a while; past this the warm-up is abandoned. */
const WARM_TIMEOUT_MS = 120_000;

/** Fire and forget: resolves when the load finishes or fails, never rejects, logs failures. */
export async function warmModel(baseUrl: string, tag: string, timeoutMs = WARM_TIMEOUT_MS): Promise<boolean> {
	if (!isValidModelTag(tag)) {
		console.warn(`[ollama] warm-up skipped: invalid model name ${JSON.stringify(tag)}`);
		return false;
	}
	try {
		const response = await fetch(`${baseUrl}/api/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: tag, keep_alive: WARM_KEEP_ALIVE, stream: false }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		if (!response.ok) {
			console.warn(`[ollama] warm-up of ${tag} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
			return false;
		}
		return true;
	} catch (error) {
		console.warn(`[ollama] warm-up of ${tag} failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
