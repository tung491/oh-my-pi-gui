/**
 * The bundled Ollama model catalog and the pure sizing that turns it into the
 * onboarding cards. Works offline: nothing here touches the network.
 *
 * Sizing follows sai-welcome (`core/modelfit/suggest.go`, `Suggest`): every
 * model is classed against this machine's memory, then three tiers are picked
 * and collapsed onto distinct models.
 */

import {
	type MachineFacts,
	MODEL_TIERS,
	type ModelChoice,
	type ModelFit,
	type ModelScreen,
	type ModelSpeed,
	type ModelTier,
} from "./ollama-types";

export interface OllamaCatalogEntry {
	tag: string;
	label: string;
	/** Parameter count in billions. */
	params: number;
	/** Download size as the Ollama library reports it. */
	sizeBytes: number;
	/** Context length the footprint estimate assumes. */
	contextTokens: number;
}

/**
 * Context every estimate assumes: 8192 tokens, the length sai-welcome
 * calibrates at (`modelfit.CtxAssumed`). It is a sizing assumption, not a cap
 * on what the agent may request.
 */
const CATALOG_CONTEXT_TOKENS = 8192;

/**
 * Tool-calling models, smallest first. Sizes are the default (q4_K_M / MXFP4)
 * downloads from https://ollama.com/library/qwen3/tags and
 * https://ollama.com/library/gpt-oss/tags, read 2026-10-02 (decimal GB, as the
 * library prints them). They only size the cards, so a stale value never
 * blocks a pull.
 */
export const OLLAMA_CATALOG: readonly OllamaCatalogEntry[] = [
	{ tag: "qwen3:4b", label: "Qwen3 4B", params: 4, sizeBytes: 2.5e9, contextTokens: CATALOG_CONTEXT_TOKENS },
	{ tag: "qwen3:8b", label: "Qwen3 8B", params: 8, sizeBytes: 5.2e9, contextTokens: CATALOG_CONTEXT_TOKENS },
	{ tag: "qwen3:14b", label: "Qwen3 14B", params: 14, sizeBytes: 9.3e9, contextTokens: CATALOG_CONTEXT_TOKENS },
	{ tag: "gpt-oss:20b", label: "gpt-oss 20B", params: 20, sizeBytes: 14e9, contextTokens: CATALOG_CONTEXT_TOKENS },
	{ tag: "qwen3:30b", label: "Qwen3 30B", params: 30, sizeBytes: 19e9, contextTokens: CATALOG_CONTEXT_TOKENS },
];

/** Weights resident in memory run about 20% over the file size (runtime buffers, graph scratch): ×12/10, kept integral. */
const WEIGHT_OVERHEAD_NUM = 12;
const WEIGHT_OVERHEAD_DEN = 10;

/**
 * f16 KV cache bytes per context token: 2 (K and V) × layers × KV heads ×
 * head dim × 2 bytes. Qwen3 14B (40 layers, 8 KV heads, dim 128) is the
 * largest in the catalog at 163,840; the 4B/8B (36 layers) need 147,456 and
 * gpt-oss 20B far less. One upper-envelope constant over-states need for the
 * smaller rows, which recommends smaller — the safe direction.
 */
const KV_CACHE_BYTES_PER_TOKEN = 163_840;

/** Share of unified memory (Apple Silicon) the GPU may wire for a model. */
const UNIFIED_GPU_SHARE = 0.75;
/** Share of system RAM a model may take while the desktop stays usable. */
const RAM_SHARE = 0.6;
/** On CPU alone, models this large (billions of parameters) decode too slowly for daily use. */
const SLOW_ON_RAM_PARAMS = 14;

/** Estimated resident footprint: weights with overhead plus the KV cache at the entry's context. */
export function needBytes(entry: OllamaCatalogEntry): number {
	return (
		Math.ceil((entry.sizeBytes * WEIGHT_OVERHEAD_NUM) / WEIGHT_OVERHEAD_DEN) +
		entry.contextTokens * KV_CACHE_BYTES_PER_TOKEN
	);
}

/** Where a model of this footprint runs on the machine, or null when it does not fit. */
export function fitOf(need: number, machine: MachineFacts): ModelFit | null {
	if (machine.unifiedMemory) {
		return need <= machine.ramBytes * UNIFIED_GPU_SHARE ? "vram" : null;
	}
	const vram = machine.vramBytes ?? 0;
	const ramBudget = machine.ramBytes * RAM_SHARE;
	if (vram > 0) {
		if (need <= vram) return "vram";
		if (need <= vram + ramBudget) return "offload";
		return null;
	}
	return need <= ramBudget ? "ram" : null;
}

export function speedOf(fit: ModelFit, params: number): ModelSpeed {
	if (fit === "vram") return "fast";
	if (fit === "offload") return "moderate";
	return params >= SLOW_ON_RAM_PARAMS ? "slow" : "moderate";
}

interface Sized {
	entry: OllamaCatalogEntry;
	need: number;
	fit: ModelFit;
	speed: ModelSpeed;
}

/**
 * Sizes the catalog against this machine and picks up to three cards:
 * minimal = smallest footprint that fits; maximum = largest download that
 * fits; recommended = the largest that fits GPU memory (fast beats bigger for
 * a daily driver), else the largest that is not slow, else minimal. Tiers that
 * land on the same model share one card.
 *
 * `installedTags` null means Ollama did not answer, so every card's
 * `installed` is unknown rather than false.
 */
export function chooseModels(
	machine: MachineFacts | null,
	catalog: readonly OllamaCatalogEntry[],
	installedTags: readonly string[] | null,
): ModelScreen {
	if (!machine || !(machine.ramBytes > 0)) {
		return { machine: null, choices: [], emptyReason: "unreadable" };
	}

	const pool: Sized[] = [];
	for (const entry of catalog) {
		const need = needBytes(entry);
		const fit = fitOf(need, machine);
		if (fit) pool.push({ entry, need, fit, speed: speedOf(fit, entry.params) });
	}
	if (pool.length === 0) return { machine, choices: [], emptyReason: "too-small" };

	// Largest first: download size, then parameters, then tag so the order is total.
	pool.sort(
		(a, b) =>
			b.entry.sizeBytes - a.entry.sizeBytes ||
			b.entry.params - a.entry.params ||
			a.entry.tag.localeCompare(b.entry.tag),
	);
	const maximum = pool[0];
	const minimal = pool.reduce((best, row) => (row.need < best.need ? row : best), pool[pool.length - 1]);
	const recommended = pool.find(row => row.fit === "vram") ?? pool.find(row => row.speed !== "slow") ?? minimal;

	const picks: Record<ModelTier, Sized> = { minimal, recommended, maximum };
	const installed = installedTags ? new Set(installedTags) : null;
	const choices: ModelChoice[] = [];
	for (const tier of MODEL_TIERS) {
		const row = picks[tier];
		const existing = choices.find(choice => choice.tag === row.entry.tag);
		if (existing) {
			existing.tiers.push(tier);
			continue;
		}
		choices.push({
			tag: row.entry.tag,
			label: row.entry.label,
			params: row.entry.params,
			sizeBytes: row.entry.sizeBytes,
			needBytes: row.need,
			fit: row.fit,
			speed: row.speed,
			tiers: [tier],
			installed: installed ? installed.has(row.entry.tag) : null,
		});
	}
	return { machine, choices };
}
