/**
 * The bundled Ollama model catalog and the pure sizing that turns it into the
 * onboarding cards. Works offline: nothing here touches the network.
 *
 * Sizing is a port of sai-welcome's unmeasured path
 * (`welcome-rs/welcome-core/src/modelfit`: `need.rs`, `class.rs`,
 * `quality.rs`, `sizing.rs`): every row is classed against this machine's
 * memory, then three tiers are picked and collapsed onto distinct models.
 * Install matching follows `llm/tags.rs` (`model_installed`).
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
	/** The reference `ollama pull` takes; may omit the tag, as the `hf.co` refs do. */
	tag: string;
	label: string;
	/** Parameter count in billions. */
	params: number;
	/** Parameters active per token, in billions. */
	activeParams: number;
	/** Size of the model file. */
	sizeBytes: number;
	/** Quantization rank: higher is better quality; breaks a parameter tie. */
	quantRank: number;
}

/**
 * The three QAT 4-bit Gemma 4 rows sai-welcome suggests
 * (`SUGGEST_FAMILIES = ["gemma"]`). Sizes, parameter counts and quant rank
 * come from sai-welcome `welcome-core/assets/hfmodels.json.gz` (fetched
 * 2026-08-27). All three files are Q4_0 (rank 10); none ends in `-q4_0.gguf`,
 * so each ref carries no quant tag.
 */
export const OLLAMA_CATALOG: readonly OllamaCatalogEntry[] = [
	{
		tag: "hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf",
		label: "Gemma 4 E2B",
		params: 5.1,
		activeParams: 2.3,
		sizeBytes: 3_349_516_256,
		quantRank: 10,
	},
	{
		tag: "hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf",
		label: "Gemma 4 E4B",
		params: 8,
		activeParams: 4.5,
		sizeBytes: 5_154_941_280,
		quantRank: 10,
	},
	{
		tag: "hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
		label: "Gemma 4 26B A4B",
		params: 25.2,
		activeParams: 3.8,
		sizeBytes: 14_439_363_584,
		quantRank: 10,
	},
];

/** Fitted proportional sizing ratio, 102/100, kept integral. */
const OVERHEAD_NUM = 102;
const OVERHEAD_DEN = 100;
/** Fitted constant resident overhead (4.25 GiB); it covers runtime and context, so there is no separate KV term. */
const FIXED_OVERHEAD_BYTES = 4_563_402_752;

/** GPU memory held back for the compositor and framebuffer. */
const VRAM_RESERVE_BYTES = 1024 ** 3;
/** The RAM reserve on a small machine, and the floor the proportional reserve never drops below. */
const RAM_RESERVE_FLOOR_BYTES = 4 * 1024 ** 3;
/** The reserve becomes a quarter of RAM once a quarter exceeds the floor (16 GiB). */
const RAM_RESERVE_DIVISOR = 4;

/** Past this thread count, more threads stop buying decode speed. */
const CPU_THREAD_PLATEAU = 16;
/** Below this thread count, CPU decode stops being near-interactive. */
const CPU_THREAD_FLOOR = 8;
/** Past this active-parameter count (billions), CPU decode stops being near-interactive. */
const CPU_ACTIVE_BUDGET = 9.0;

/** Rows below this parameter count (billions) are never suggested. */
const MIN_PARAMS_B = 3.0;

/** Estimated resident footprint of a model file of `sizeBytes`. */
export function needBytes(sizeBytes: number): number {
	return Math.ceil((sizeBytes * OVERHEAD_NUM) / OVERHEAD_DEN) + FIXED_OVERHEAD_BYTES;
}

function ramReserve(ramBytes: number): number {
	const quarter = Math.floor(ramBytes / RAM_RESERVE_DIVISOR);
	return quarter > RAM_RESERVE_FLOOR_BYTES ? quarter : RAM_RESERVE_FLOOR_BYTES;
}

/**
 * Where a model of this footprint runs, or null when it does not fit. A row
 * must fit one pool: VRAM plus RAM is never a budget. Unified memory adds no
 * VRAM, because sai-welcome counts integrated graphics as RAM only.
 */
export function fitOf(need: number, machine: MachineFacts): ModelFit | null {
	const vramBudget = Math.max(0, (machine.vramBytes ?? 0) - VRAM_RESERVE_BYTES);
	const ramBudget = Math.max(0, machine.ramBytes - ramReserve(machine.ramBytes));
	if (vramBudget > 0 && need <= vramBudget) return "vram";
	if (vramBudget === 0 && need <= ramBudget) return "ram";
	if (need <= ramBudget) return "offload";
	return null;
}

/** An expected-interactivity class, never a tokens-per-second figure. */
export function speedOf(fit: ModelFit, activeParams: number, threads: number): ModelSpeed {
	if (fit === "vram") return "fast";
	const effective = Math.min(threads, CPU_THREAD_PLATEAU);
	return activeParams <= CPU_ACTIVE_BUDGET && effective >= CPU_THREAD_FLOOR ? "moderate" : "slow";
}

/**
 * The name Ollama lists for `tag`, or null when it is not installed.
 * Case-insensitive; an exact `name:tag` matches, a bare name matches any tag
 * of it at the `:` boundary, and blank input matches nothing.
 */
function installedName(installedTags: readonly string[], tag: string): string | null {
	const want = tag.trim().toLowerCase();
	if (want === "") return null;
	for (const name of installedTags) {
		const got = name.toLowerCase();
		if (got === want || got.startsWith(`${want}:`)) return name;
	}
	return null;
}

export function isInstalled(installedTags: readonly string[], tag: string): boolean {
	return installedName(installedTags, tag) !== null;
}

/** `ref` with `:latest` appended when its last path segment carries no tag, as Ollama lists a fresh pull. */
function withDefaultTag(ref: string): string {
	const name = ref.slice(ref.lastIndexOf("/") + 1);
	return name.includes(":") ? ref : `${ref}:latest`;
}

interface Sized {
	entry: OllamaCatalogEntry;
	need: number;
	fit: ModelFit;
	speed: ModelSpeed;
}

/** True when `a` ranks above `b`: more parameters, then higher quant rank, then tag ascending. */
function byQuality(a: OllamaCatalogEntry, b: OllamaCatalogEntry): boolean {
	if (a.params !== b.params) return a.params > b.params;
	if (a.quantRank !== b.quantRank) return a.quantRank > b.quantRank;
	return a.tag < b.tag;
}

function qualityOrder(a: Sized, b: Sized): number {
	if (byQuality(a.entry, b.entry)) return -1;
	if (byQuality(b.entry, a.entry)) return 1;
	return 0;
}

/**
 * Sizes the catalog against this machine and picks up to three cards:
 * maximum = the best-quality row that fits; recommended = the first that fits
 * GPU memory, else the first that is not slow, else none (`status:
 * "recommended-omitted"`); minimal = the smallest need. Tiers on the same
 * model share one card, never padded to three.
 *
 * When no row fits at all but RAM still exceeds the smallest row's download,
 * that row is offered alone as a slow, tight-fit minimal card.
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

	const toChoice = (row: Sized, tiers: ModelTier[], tight: boolean): ModelChoice => {
		const listed = installedTags ? installedName(installedTags, row.entry.tag) : null;
		return {
			tag: listed ?? withDefaultTag(row.entry.tag),
			label: row.entry.label,
			params: row.entry.params,
			activeParams: row.entry.activeParams,
			sizeBytes: row.entry.sizeBytes,
			needBytes: row.need,
			fit: row.fit,
			speed: row.speed,
			tiers,
			installed: installedTags ? listed !== null : null,
			tight,
		};
	};

	const pool: Sized[] = [];
	let anyFits = false;
	for (const entry of catalog) {
		if (!(entry.sizeBytes > 0)) continue;
		const need = needBytes(entry.sizeBytes);
		const fit = fitOf(need, machine);
		if (fit) anyFits = true;
		if (fit && entry.params >= MIN_PARAMS_B) {
			pool.push({ entry, need, fit, speed: speedOf(fit, entry.activeParams, machine.threads) });
		}
	}

	if (pool.length === 0) {
		let smallest: OllamaCatalogEntry | null = null;
		for (const entry of catalog) {
			if (entry.sizeBytes > 0 && (!smallest || needBytes(entry.sizeBytes) < needBytes(smallest.sizeBytes))) {
				smallest = entry;
			}
		}
		// Rows that fit but fall under the parameter floor are not "nothing fits".
		if (anyFits || !smallest || !(machine.ramBytes > smallest.sizeBytes)) {
			return { machine, choices: [], emptyReason: "too-small" };
		}
		const row: Sized = { entry: smallest, need: needBytes(smallest.sizeBytes), fit: "ram", speed: "slow" };
		return { machine, choices: [toChoice(row, ["minimal"], true)], status: "recommended-omitted" };
	}

	pool.sort(qualityOrder);
	const maximum = pool[0];
	const recommended = pool.find(row => row.fit === "vram") ?? pool.find(row => row.speed !== "slow") ?? null;
	let minimal = pool[0];
	for (const row of pool) {
		if (row.need < minimal.need) minimal = row;
	}

	const picks: Record<ModelTier, Sized | null> = { minimal, recommended, maximum };
	const choices: ModelChoice[] = [];
	const cardOf = new Map<string, ModelChoice>();
	for (const tier of MODEL_TIERS) {
		const row = picks[tier];
		if (!row) continue;
		const existing = cardOf.get(row.entry.tag);
		if (existing) {
			existing.tiers.push(tier);
			continue;
		}
		const card = toChoice(row, [tier], false);
		cardOf.set(row.entry.tag, card);
		choices.push(card);
	}
	return { machine, choices, status: recommended ? "ok" : "recommended-omitted" };
}
