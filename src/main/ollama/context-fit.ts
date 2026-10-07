/**
 * Measures the largest context a local Ollama model holds without leaving its
 * memory pool: load it at an ascending ladder of `num_ctx` values and read
 * `/api/ps` after each load. On a GPU a rung fits while the whole model stays
 * in VRAM (`size_vram >= size`); from system memory, and always on unified
 * memory, it fits while `size` stays within the RAM budget. Ollama spills to
 * the CPU rather than failing, so a spill is read, never caught.
 *
 * Plain HTTP to the daemon, like `warm.ts`; never rejects. Keeps step with
 * `src-tauri/src/ollama/context_fit.rs`; change both together.
 */
import { ramReserve } from "../../shared/ollama-catalog";
import { isLocalOllamaRow, isLoopbackBaseUrl, type OllamaTagRow } from "../../shared/ollama-local";
import {
	CONTEXT_FLOOR,
	type ContextFitProgress,
	type ContextPool,
	type ContextVerdict,
	contextLadder,
	type MachineFacts,
	type MeasureOutcome,
} from "../../shared/ollama-types";
import { isValidModelTag } from "./pull";

export { CONTEXT_FLOOR, contextLadder };
/** The ceiling assumed when Ollama reports no plausible trained context. */
export const UNKNOWN_TRAINED_CONTEXT = 131_072;
/** A trained context above this (16M tokens) is treated as unknown. */
const MAX_PLAUSIBLE_CONTEXT = 2 ** 24;
/** A rung predicted past the budget by more than this factor is certain to fail and is never loaded. */
const PREDICTION_SLACK = 1.1;
/** Keep each probe resident just long enough to read `/api/ps`. */
const PROBE_KEEP_ALIVE = "30s";

export interface ContextFitTiming {
	/** Base timeout of one load; the first load adds `probeMsPerSizeUnit` per `probeSizeUnitBytes` of the model file. */
	probeTimeoutMs: number;
	probeMsPerSizeUnit: number;
	probeSizeUnitBytes: number;
	/** `/api/show`, `/api/ps` and the unload request. */
	requestTimeoutMs: number;
	/** How long to wait for `/api/ps` to empty before re-probing a failing rung. */
	unloadWaitMs: number;
	unloadPollMs: number;
}

export const DEFAULT_CONTEXT_FIT_TIMING: ContextFitTiming = {
	probeTimeoutMs: 120_000,
	probeMsPerSizeUnit: 1_000,
	probeSizeUnitBytes: 50_000_000,
	requestTimeoutMs: 10_000,
	unloadWaitMs: 10_000,
	unloadPollMs: 250,
};

export interface MeasureContextFitInput {
	baseUrl: string;
	/** The model's `/api/tags` row; `name` is the tag measured. */
	row: OllamaTagRow;
	machine: MachineFacts;
	/**
	 * The most the sidecar can send for this model (its global cap); no rung
	 * above it is tried. `trainedContext` is still reported unchanged.
	 */
	maxContext?: number;
	/** Re-checked before every load; true ends the run as `interrupted`. */
	isBusy(): boolean;
	onProgress?(progress: ContextFitProgress): void;
	timing?: Partial<ContextFitTiming>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plausibleContext(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_PLAUSIBLE_CONTEXT
		? value
		: null;
}

/** `<general.architecture>.context_length` from `/api/show`, or null when absent or implausible. */
export function trainedContextOf(show: unknown): number | null {
	if (!isRecord(show) || !isRecord(show.model_info)) return null;
	const arch = show.model_info["general.architecture"];
	if (typeof arch !== "string" || arch === "") return null;
	return plausibleContext(show.model_info[`${arch}.context_length`]);
}

/** The Modelfile's `num_ctx` from `/api/show`'s `parameters` text, or null. */
export function modelfileNumCtx(show: unknown): number | null {
	if (!isRecord(show) || typeof show.parameters !== "string") return null;
	for (const line of show.parameters.split(/\r?\n/)) {
		const match = /^\s*num_ctx\s+(\d+)\s*$/.exec(line);
		if (match) return plausibleContext(Number(match[1]));
	}
	return null;
}

/** Ordinary least squares `size = a + b·n` over the fitting probes, evaluated at `n`; null under two points. */
export function predictSize(points: readonly (readonly [number, number])[], n: number): number | null {
	if (points.length < 2) return null;
	const meanN = points.reduce((sum, [x]) => sum + x, 0) / points.length;
	const meanS = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
	let cov = 0;
	let varN = 0;
	for (const [x, y] of points) {
		cov += (x - meanN) * (y - meanS);
		varN += (x - meanN) ** 2;
	}
	if (varN === 0) return null;
	const slope = cov / varN;
	return meanS + slope * (n - meanN);
}

/** A failure that ends the run with outcome `error`. */
class MeasureError extends Error {}
/** A probe that cannot be trusted; the run ends as `interrupted`. */
class ProbeDiscarded extends Error {}

interface PsEntry {
	name: string;
	model: string;
	size: unknown;
	size_vram: unknown;
	context_length: unknown;
}

interface Probe {
	size: number;
	sizeVram: number;
	/** The context Ollama loaded: the one asked for, or less when it clamped to the trained context. */
	context: number;
}

type LoadResult = { kind: "loaded"; probe: Probe } | { kind: "refused" };

function errorText(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
		return `${error.message}${cause}`;
	}
	return String(error);
}

function byteCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

class Daemon {
	readonly #baseUrl: string;
	readonly #tag: string;
	readonly #timing: ContextFitTiming;

	constructor(baseUrl: string, tag: string, timing: ContextFitTiming) {
		this.#baseUrl = baseUrl;
		this.#tag = tag;
		this.#timing = timing;
	}

	/** POST `body` as JSON, or GET when `body` is undefined. Network failures and timeouts end the run. */
	async #send(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
		try {
			const response = await fetch(`${this.#baseUrl}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			return { status: response.status, text: await response.text() };
		} catch (error) {
			throw new MeasureError(`${path} failed: ${errorText(error)}`);
		}
	}

	async #json(path: string, body: unknown): Promise<unknown> {
		const { status, text } = await this.#send(path, body, this.#timing.requestTimeoutMs);
		if (status < 200 || status > 299) {
			throw new MeasureError(`${path} answered HTTP ${status}: ${text.slice(0, 300)}`);
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new MeasureError(`${path} returned invalid JSON`);
		}
	}

	show(): Promise<unknown> {
		return this.#json("/api/show", { model: this.#tag });
	}

	async ps(): Promise<PsEntry[]> {
		const body = await this.#json("/api/ps", undefined);
		if (!isRecord(body) || !Array.isArray(body.models)) {
			throw new MeasureError("/api/ps returned an unexpected shape");
		}
		return body.models.filter(isRecord).map(row => ({
			name: typeof row.name === "string" ? row.name : "",
			model: typeof row.model === "string" ? row.model : "",
			size: row.size,
			size_vram: row.size_vram,
			context_length: row.context_length,
		}));
	}

	#isOurs(entry: PsEntry): boolean {
		const want = this.#tag.toLowerCase();
		return entry.name.toLowerCase() === want || entry.model.toLowerCase() === want;
	}

	/** Load at `numCtx`, then read `/api/ps`. HTTP 500 (no memory for it) is `refused`. */
	async load(numCtx: number, timeoutMs: number): Promise<LoadResult> {
		const { status, text } = await this.#send(
			"/api/generate",
			{ model: this.#tag, keep_alive: PROBE_KEEP_ALIVE, stream: false, options: { num_ctx: numCtx } },
			timeoutMs,
		);
		if (status === 500) return { kind: "refused" };
		if (status < 200 || status > 299) {
			throw new MeasureError(`loading at num_ctx ${numCtx} answered HTTP ${status}: ${text.slice(0, 300)}`);
		}
		const entries = await this.ps();
		const entry = entries.find(candidate => this.#isOurs(candidate));
		if (!entry) throw new ProbeDiscarded("/api/ps does not list the model");
		if (entries.length > 1) throw new ProbeDiscarded("another model is loaded");
		const size = byteCount(entry.size);
		const sizeVram = byteCount(entry.size_vram);
		if (size === null || sizeVram === null) throw new ProbeDiscarded("/api/ps did not report the model's size");
		// Ollama silently clamps a `num_ctx` above the model's trained context; a smaller context is that clamp.
		const context = plausibleContext(entry.context_length);
		if (context === null || context > numCtx) {
			throw new ProbeDiscarded(`Ollama loaded a different context than ${numCtx}`);
		}
		return { kind: "loaded", probe: { size, sizeVram, context } };
	}

	/** Ask Ollama to drop the model now; failures are logged, never thrown. */
	async unload(): Promise<void> {
		try {
			const { status, text } = await this.#send(
				"/api/generate",
				{ model: this.#tag, keep_alive: 0, stream: false },
				this.#timing.requestTimeoutMs,
			);
			if (status < 200 || status > 299) {
				console.warn(`[ollama] unloading ${this.#tag} failed: HTTP ${status} ${text.slice(0, 300)}`);
			}
		} catch (error) {
			console.warn(`[ollama] unloading ${this.#tag} failed: ${errorText(error)}`);
		}
	}

	/** Unload, then poll `/api/ps` until it lists nothing or the wait runs out. */
	async unloadAndSettle(): Promise<void> {
		await this.unload();
		const deadline = Date.now() + this.#timing.unloadWaitMs;
		while ((await this.ps()).length > 0 && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, this.#timing.unloadPollMs));
		}
	}
}

function reject(message: string): MeasureOutcome {
	console.warn(`[ollama] context measurement refused: ${message}`);
	return { kind: "error", message };
}

/**
 * Walk the ladder for `row.name` and return the largest rung that fits. Never
 * loads a rung predicted past the budget, and always unloads the model after
 * any load. Never rejects.
 */
export async function measureContextFit(input: MeasureContextFitInput): Promise<MeasureOutcome> {
	const { baseUrl, row, machine } = input;
	const tag = row.name;
	if (!isValidModelTag(tag)) return reject(`invalid model name ${JSON.stringify(String(tag).slice(0, 100))}`);
	if (!isLocalOllamaRow(row)) return reject(`${tag} is not a local model`);
	if (!isLoopbackBaseUrl(baseUrl)) return reject(`${baseUrl} is not this computer`);

	const timing = { ...DEFAULT_CONTEXT_FIT_TIMING, ...input.timing };
	const daemon = new Daemon(baseUrl, tag, timing);
	const ramBudget = Math.max(0, machine.ramBytes - ramReserve(machine.ramBytes));
	let loaded = false;

	try {
		const show = await daemon.show();
		const trained = trainedContextOf(show);
		const trainedContext = trained ?? UNKNOWN_TRAINED_CONTEXT;
		const limits = [trainedContext, modelfileNumCtx(show), plausibleContext(input.maxContext)];
		const ceiling = Math.min(...limits.filter((limit): limit is number => limit !== null));
		const ladder = contextLadder(ceiling);
		const floor = ladder[0];

		const modelBytes = byteCount(row.size) ?? 0;
		const firstTimeoutMs =
			timing.probeTimeoutMs + Math.floor(modelBytes / timing.probeSizeUnitBytes) * timing.probeMsPerSizeUnit;

		// Written by `probe`; an object so the walk below reads the latest values, not narrowed copies.
		// `clamped` is the context Ollama clamped a rung to: the real ceiling, so the walk ends there.
		const seen: { pool: ContextPool | null; clamped: number | null } = {
			pool: machine.unifiedMemory ? "ram" : null,
			clamped: null,
		};
		let best: number | null = null;
		let failedOnce = false;
		const fitting: [number, number][] = [];

		const probe = async (n: number): Promise<boolean> => {
			if (input.isBusy()) throw new ProbeDiscarded("a session became busy");
			input.onProgress?.({ tag, state: "running", numCtx: n });
			const timeoutMs = loaded ? timing.probeTimeoutMs : firstTimeoutMs;
			loaded = true;
			const result = await daemon.load(n, timeoutMs);
			if (result.kind === "refused") {
				// Ollama refuses a load beyond system memory; with no pool seen yet, that pool is RAM.
				seen.pool ??= "ram";
				return false;
			}
			const { size, sizeVram, context } = result.probe;
			seen.pool ??= sizeVram > 0 ? "gpu" : "ram";
			const fits = seen.pool === "gpu" ? sizeVram >= size : size <= ramBudget;
			if (context < n) seen.clamped = context;
			else if (fits) fitting.push([n, size]);
			return fits;
		};

		for (const n of ladder) {
			const budget = seen.pool === "gpu" ? machine.vramBytes : ramBudget;
			const predicted = predictSize(fitting, n);
			if (predicted !== null && budget !== null && predicted > budget * PREDICTION_SLACK) break;

			let fits = await probe(n);
			if (!fits && seen.clamped === null && !failedOnce) {
				failedOnce = true;
				await daemon.unloadAndSettle();
				fits = await probe(n);
			}
			if (seen.clamped !== null) {
				if (fits && (best === null || seen.clamped > best)) best = seen.clamped;
				break;
			}
			if (!fits) break;
			best = n;
		}

		const resolvedPool: ContextPool = seen.pool ?? "ram";
		const verdict: ContextVerdict = best !== null ? "fits" : resolvedPool === "gpu" ? "spills" : "exceeds-ram";
		const fallback = seen.clamped === null ? floor : Math.min(floor, seen.clamped);
		return {
			kind: "measured",
			result: { maxContext: best ?? fallback, trainedContext, pool: resolvedPool, verdict },
		};
	} catch (error) {
		if (error instanceof ProbeDiscarded) {
			console.warn(`[ollama] context measurement of ${tag} interrupted: ${error.message}`);
			return { kind: "interrupted" };
		}
		const message = errorText(error);
		console.warn(`[ollama] context measurement of ${tag} failed: ${message}`);
		return { kind: "error", message };
	} finally {
		if (loaded) await daemon.unload();
	}
}
