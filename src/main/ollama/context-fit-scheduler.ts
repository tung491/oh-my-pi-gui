/**
 * The one context-fit queue of the app. Runs a measurement only while no
 * sidecar in any window is running or compacting, commits each result to the
 * `ollamaContextFit` preference with a synchronous read-modify-write, and
 * rewrites the overlay every sidecar reads its per-model limits from. Plain
 * Node behind injected dependencies, so it is unit-tested without Electron.
 * Keeps step with `src-tauri/src/ollama/context_fit_scheduler.rs`; change both
 * together.
 */
import { setTimeout as delay } from "node:timers/promises";
import {
	type CapDecision,
	clampCap,
	effectiveLimits,
	failedUnderCurrent,
	fingerprintOf,
	isStale,
	needsAutoMeasure,
	overlayYaml,
	parseContextFitStore,
	withFailure,
	withMeasured,
} from "../../shared/context-fit-store";
import { installedName, withDefaultTag } from "../../shared/ollama-catalog";
import { isLocalOllamaRow, isLoopbackBaseUrl, type OllamaTagRow } from "../../shared/ollama-local";
import {
	type ContextFitChanged,
	type ContextFitEntry,
	type ContextFitList,
	type ContextFitProgress,
	type ContextFitStore,
	type ContextMeasureReason,
	type MachineFacts,
	type MeasureOutcome,
	SIDECAR_DEFAULT_OLLAMA_CONTEXT,
} from "../../shared/ollama-types";
import type { RpcCommand, RpcResponse, RpcSessionState } from "../../shared/rpc-types";
import { type MeasureContextFitInput, measureContextFit } from "./context-fit";
import { isRecord } from "./probe";
import { isValidModelTag } from "./pull";

/** An interrupted run is retried this many times per trigger, then dropped until the next one. */
export const MAX_INTERRUPTED_RETRIES = 3;

/** A tab that was idle when the limits changed; `command` answers null once it is no longer idle. */
export interface IdleSession {
	command(command: RpcCommand): Promise<RpcResponse | null>;
}

export interface ContextFitSchedulerDeps {
	/** The endpoint the sidecar talks to. */
	baseUrl(): Promise<string>;
	/** `/api/tags` rows, or null when Ollama does not answer. */
	listRows(baseUrl: string): Promise<OllamaTagRow[] | null>;
	readMachine(): Promise<MachineFacts | null>;
	/** A sidecar in any window is running or compacting. */
	isBusy(): boolean;
	/** The welcome dialog has closed, so a pulled model may be loaded. */
	welcomeDone(): boolean;
	/** The user's models config has an `ollama` provider, which turns the built-in one (and these limits) off. */
	configuredProvider(): boolean;
	/** The user's own `OLLAMA_CONTEXT_LENGTH`, which caps every model; null when unset. */
	envCap(): number | null;
	/** The raw preference value; parsed tolerantly on every read. */
	readStore(): unknown;
	/** Synchronous, so a commit has no `await` between its read and its write. */
	writeStore(store: ContextFitStore): void;
	writeOverlay(yaml: string): void;
	onProgress(progress: ContextFitProgress): void;
	onChanged(change: ContextFitChanged): void;
	idleSessions(): IdleSession[];
	measure?(input: MeasureContextFitInput): Promise<MeasureOutcome>;
	unloadResident?(baseUrl: string): Promise<void>;
	now?(): string;
	/** How often a blocked queue looks again (busy pool, welcome dialog, Ollama down). */
	retryMs?: number;
	/** How long a session gets to report its new context window before it is left alone. */
	rebindWaitMs?: number;
	rebindPollMs?: number;
}

interface QueueItem {
	tag: string;
	reason: ContextMeasureReason;
	retries: number;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The key Ollama's discovery gives a row (`model`, else `name`); the store and the overlay use it. */
function rowKey(row: OllamaTagRow): string {
	return row.model || row.name;
}

/** A row the app may measure and limit: a valid name, served by this computer. */
function isMeasurableRow(row: OllamaTagRow): boolean {
	return isValidModelTag(row.name) && isValidModelTag(rowKey(row)) && isLocalOllamaRow(row);
}

/** `/api/tags` rows with the fields the local rules read; null when Ollama does not answer. */
export async function fetchTagRows(baseUrl: string, timeoutMs = 5_000): Promise<OllamaTagRow[] | null> {
	try {
		const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return null;
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.models)) return null;
		const rows: OllamaTagRow[] = [];
		for (const raw of body.models) {
			if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") continue;
			rows.push({
				name: raw.name,
				...(typeof raw.model === "string" && { model: raw.model }),
				...(typeof raw.size === "number" && { size: raw.size }),
				...(typeof raw.remote_host === "string" && { remote_host: raw.remote_host }),
				...(typeof raw.remote_model === "string" && { remote_model: raw.remote_model }),
			});
		}
		return rows;
	} catch (error) {
		console.warn(`[ollama] listing models failed: ${errorText(error)}`);
		return null;
	}
}

export interface UnloadTiming {
	requestTimeoutMs: number;
	waitMs: number;
	pollMs: number;
}

const DEFAULT_UNLOAD_TIMING: UnloadTiming = { requestTimeoutMs: 10_000, waitMs: 10_000, pollMs: 250 };

async function residentNames(baseUrl: string, timeoutMs: number): Promise<string[]> {
	const response = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`/api/ps answered HTTP ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("/api/ps returned an unexpected shape");
	return body.models.filter(isRecord).flatMap(row => (typeof row.name === "string" && row.name ? [row.name] : []));
}

/**
 * Unload every model Ollama holds, then wait (bounded) until `/api/ps` is
 * empty, so a measurement sees only its own model. The next chat turn loads
 * its model again. Never rejects; a model that stays makes the measurement
 * end as interrupted instead.
 */
export async function unloadResidentModels(baseUrl: string, timing: Partial<UnloadTiming> = {}): Promise<void> {
	const { requestTimeoutMs, waitMs, pollMs } = { ...DEFAULT_UNLOAD_TIMING, ...timing };
	try {
		const names = await residentNames(baseUrl, requestTimeoutMs);
		if (names.length === 0) return;
		await Promise.all(
			names.map(async model => {
				const response = await fetch(`${baseUrl}/api/generate`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model, keep_alive: 0, stream: false }),
					signal: AbortSignal.timeout(requestTimeoutMs),
				});
				await response.text();
				if (!response.ok) console.warn(`[ollama] unloading ${model} failed: HTTP ${response.status}`);
			}),
		);
		const deadline = Date.now() + waitMs;
		while ((await residentNames(baseUrl, requestTimeoutMs)).length > 0 && Date.now() < deadline) {
			await delay(pollMs);
		}
	} catch (error) {
		console.warn(`[ollama] unloading resident models failed: ${errorText(error)}`);
	}
}

/** A positive integer `OLLAMA_CONTEXT_LENGTH`, as Ollama reads it; anything else is ignored. */
export function parseEnvCap(value: string | undefined): number | null {
	const trimmed = value?.trim() ?? "";
	if (!/^\d+$/.test(trimmed)) return null;
	const cap = Number(trimmed);
	return Number.isSafeInteger(cap) && cap > 0 ? cap : null;
}

/** A renderer `ollama:context-measure` payload; `stale` is internal and refused. */
export function parseMeasureRequest(payload: unknown): { tag: string; reason: "manual" | "pulled" } {
	if (!isRecord(payload) || typeof payload.tag !== "string") throw new Error("Invalid model name");
	const reason = payload.reason ?? "manual";
	if (reason !== "manual" && reason !== "pulled") throw new Error("Invalid measurement reason");
	return { tag: payload.tag, reason };
}

/** A renderer `ollama:context-set-cap` payload; the range is checked against the stored maximum. */
export function parseSetCapRequest(payload: unknown): { tag: string; cap: unknown } {
	if (!isRecord(payload) || typeof payload.tag !== "string" || !("cap" in payload)) {
		throw new Error("Invalid context limit");
	}
	return { tag: payload.tag, cap: payload.cap };
}

function capError(decision: Exclude<CapDecision, { ok: true }>): Error {
	return new Error(
		decision.reason === "unmeasured"
			? "This model has not been measured yet"
			: "The context limit is outside the measured range",
	);
}

export class ContextFitScheduler {
	readonly #deps: ContextFitSchedulerDeps;
	readonly #measure: (input: MeasureContextFitInput) => Promise<MeasureOutcome>;
	readonly #unloadResident: (baseUrl: string) => Promise<void>;
	readonly #now: () => string;
	readonly #retryMs: number;
	#queue: QueueItem[] = [];
	#running: string | null = null;
	#pumping = false;
	#timer: NodeJS.Timeout | null = null;
	#startupDone = false;
	#startupRunning = false;
	#disposed = false;
	#lastYaml: string | null = null;
	/** The effective limits the sidecars were last given; null before the first sync. */
	#lastLimits: Map<string, number> | null = null;

	constructor(deps: ContextFitSchedulerDeps) {
		this.#deps = deps;
		this.#measure = deps.measure ?? measureContextFit;
		this.#unloadResident = deps.unloadResident ?? (baseUrl => unloadResidentModels(baseUrl));
		this.#now = deps.now ?? (() => new Date().toISOString());
		this.#retryMs = deps.retryMs ?? 3_000;
	}

	/** Write the overlay for the current store and try the startup pass. */
	start(): void {
		this.refreshOverlay();
		void this.#startupPass();
	}

	dispose(): void {
		this.#disposed = true;
		this.#queue = [];
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	/** Every status probe reports here: the first answer from Ollama starts the startup pass and wakes the queue. */
	noteOllamaAnswered(): void {
		if (this.#disposed) return;
		void this.#startupPass();
		this.#kick();
	}

	/** Recompute the overlay, for example once the login shell's `OLLAMA_CONTEXT_LENGTH` is known. */
	refreshOverlay(): void {
		this.#syncOverlay(null);
	}

	/**
	 * Queue a measurement of an installed local model. Rejects a name that is
	 * not installed, not valid, a cloud tag or a remote copy, and any model
	 * when Ollama runs on another computer.
	 */
	async enqueue(tag: string, reason: ContextMeasureReason): Promise<void> {
		const baseUrl = await this.#deps.baseUrl();
		if (!isLoopbackBaseUrl(baseUrl)) throw new Error("Ollama is not running on this computer");
		const rows = await this.#deps.listRows(baseUrl);
		if (!rows) throw new Error("Ollama is not answering");
		const key = this.#resolve(rows, tag);
		this.#add(key, reason);
	}

	/** Set or clear the user's limit for a measured model; returns the stored entry. */
	async setCap(tag: string, cap: unknown): Promise<ContextFitEntry> {
		const baseUrl = await this.#deps.baseUrl();
		if (!isLoopbackBaseUrl(baseUrl)) throw new Error("Ollama is not running on this computer");
		const rows = await this.#deps.listRows(baseUrl);
		if (!rows) throw new Error("Ollama is not answering");
		const key = this.#resolve(rows, tag);
		// Read, decide and write with no `await` between, so a commit cannot overwrite a newer one.
		const store = this.#readStore();
		const entry = Object.hasOwn(store.models, key) ? store.models[key] : undefined;
		if (!entry) throw capError({ ok: false, reason: "unmeasured" });
		const decision = clampCap(entry, cap);
		if (!decision.ok) throw capError(decision);
		const next: ContextFitEntry = { ...entry, userCap: decision.userCap };
		this.#deps.writeStore({ ...store, models: { ...store.models, [key]: next } });
		this.#syncOverlay(key);
		return next;
	}

	/** Every installed local model with what is known about its context. */
	async list(): Promise<ContextFitList> {
		const baseUrl = await this.#deps.baseUrl();
		if (!isLoopbackBaseUrl(baseUrl)) return { rows: [], reason: "remote-host" };
		const [rows, machine] = await Promise.all([this.#deps.listRows(baseUrl), this.#deps.readMachine()]);
		const store = this.#readStore();
		const envCap = this.#deps.envCap();
		const limits = effectiveLimits(store, envCap);
		const current = machine ? fingerprintOf(machine) : null;
		const seen = new Set<string>();
		const listed: ContextFitList["rows"] = [];
		for (const row of rows ?? []) {
			if (!isMeasurableRow(row)) continue;
			const tag = rowKey(row);
			if (seen.has(tag)) continue;
			seen.add(tag);
			const entry = Object.hasOwn(store.models, tag) ? (store.models[tag] ?? null) : null;
			listed.push({
				tag,
				entry,
				effective: limits.get(tag) ?? null,
				stale: entry !== null && current !== null && isStale(entry, current),
				envCap,
				state: this.#running === tag ? "running" : this.#queue.some(item => item.tag === tag) ? "queued" : "idle",
			});
		}
		return this.#deps.configuredProvider() ? { rows: listed, reason: "configured-provider" } : { rows: listed };
	}

	#readStore(): ContextFitStore {
		return parseContextFitStore(this.#deps.readStore());
	}

	/** The store key of an installed local model, or an error naming why it cannot be measured. */
	#resolve(rows: readonly OllamaTagRow[], tag: string): string {
		if (!isValidModelTag(tag)) throw new Error("Invalid model name");
		const name = installedName(
			rows.map(row => row.name),
			withDefaultTag(tag),
		);
		const row = name === null ? undefined : rows.find(candidate => candidate.name === name);
		if (!row) throw new Error(`${tag} is not installed`);
		if (!isMeasurableRow(row)) throw new Error(`${tag} does not run on this computer`);
		return rowKey(row);
	}

	#add(tag: string, reason: ContextMeasureReason): void {
		if (this.#disposed) return;
		const existing = this.#queue.find(item => item.tag === tag);
		if (existing) {
			// A new trigger restarts the retry budget; a manual one jumps the queue.
			existing.retries = 0;
			if (reason === "manual" && existing.reason !== "manual") {
				this.#queue = [{ ...existing, reason }, ...this.#queue.filter(item => item !== existing)];
			}
		} else if (this.#running !== tag) {
			const item: QueueItem = { tag, reason, retries: 0 };
			if (reason === "manual") {
				const firstOther = this.#queue.findIndex(queued => queued.reason !== "manual");
				this.#queue.splice(firstOther === -1 ? this.#queue.length : firstOther, 0, item);
			} else {
				this.#queue.push(item);
			}
			this.#deps.onProgress({ tag, state: "queued" });
		}
		this.#kick();
	}

	#kick(): void {
		if (this.#disposed) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		void this.#pump();
	}

	#retryLater(): void {
		if (this.#disposed || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.#pump();
		}, this.#retryMs);
	}

	/** The next item allowed to run now: pulled models wait for the welcome dialog. */
	#nextItem(): QueueItem | undefined {
		const welcomeDone = this.#deps.welcomeDone();
		return this.#queue.find(item => item.reason !== "pulled" || welcomeDone);
	}

	async #pump(): Promise<void> {
		if (this.#pumping || this.#disposed) return;
		this.#pumping = true;
		try {
			while (!this.#disposed && this.#queue.length > 0) {
				const item = this.#nextItem();
				if (!item || this.#deps.isBusy()) {
					this.#retryLater();
					return;
				}
				const baseUrl = await this.#deps.baseUrl();
				if (!isLoopbackBaseUrl(baseUrl)) {
					// Never measure a model on another computer; the queue empties until Ollama is local again.
					for (const dropped of this.#queue) this.#deps.onChanged({ tag: dropped.tag });
					this.#queue = [];
					return;
				}
				const rows = await this.#deps.listRows(baseUrl);
				if (!rows) {
					this.#retryLater();
					return;
				}
				this.#queue = this.#queue.filter(queued => queued !== item);
				await this.#run(item, baseUrl, rows);
			}
		} finally {
			this.#pumping = false;
		}
	}

	async #run(item: QueueItem, baseUrl: string, rows: readonly OllamaTagRow[]): Promise<void> {
		const { tag } = item;
		const row = rows.find(candidate => rowKey(candidate) === tag && isMeasurableRow(candidate));
		const machine = await this.#deps.readMachine();
		if (!row || !machine) {
			console.warn(
				`[ollama] context measurement of ${tag} skipped: ${row ? "machine unreadable" : "not installed"}`,
			);
			this.#deps.onChanged({ tag });
			return;
		}
		const fingerprint = fingerprintOf(machine);
		const stored = this.#readStore().models;
		const entry = Object.hasOwn(stored, tag) ? stored[tag] : undefined;
		const skip =
			item.reason !== "manual" &&
			(failedUnderCurrent(entry, fingerprint) || (item.reason === "stale" && !needsAutoMeasure(entry, fingerprint)));
		if (skip) {
			this.#deps.onChanged({ tag });
			return;
		}

		this.#running = tag;
		let outcome: MeasureOutcome;
		try {
			if (this.#deps.isBusy()) {
				outcome = { kind: "interrupted" };
			} else {
				await this.#unloadResident(baseUrl);
				outcome = await this.#measure({
					baseUrl,
					row,
					machine,
					maxContext: this.#deps.envCap() ?? SIDECAR_DEFAULT_OLLAMA_CONTEXT,
					isBusy: () => this.#deps.isBusy(),
					onProgress: progress => this.#deps.onProgress(progress),
				});
			}
		} catch (error) {
			outcome = { kind: "error", message: errorText(error) };
		} finally {
			this.#running = null;
		}

		if (outcome.kind === "interrupted") {
			if (item.retries < MAX_INTERRUPTED_RETRIES && !this.#disposed) {
				this.#queue.unshift({ ...item, retries: item.retries + 1 });
				this.#deps.onProgress({ tag, state: "queued" });
			} else {
				console.warn(`[ollama] context measurement of ${tag} dropped after ${item.retries} retries`);
				this.#deps.onChanged({ tag });
			}
			return;
		}
		this.#commit(tag, outcome, fingerprint);
	}

	/** Re-read the store and write only `tag`, so a cap set during the measurement survives. */
	#commit(
		tag: string,
		outcome: Exclude<MeasureOutcome, { kind: "interrupted" }>,
		fingerprint: ReturnType<typeof fingerprintOf>,
	): void {
		try {
			const store = this.#readStore();
			const entry = Object.hasOwn(store.models, tag) ? store.models[tag] : undefined;
			const now = this.#now();
			const next =
				outcome.kind === "measured"
					? withMeasured(entry, outcome.result, fingerprint, now)
					: withFailure(entry, outcome.message, fingerprint, now);
			this.#deps.writeStore({ ...store, models: { ...store.models, [tag]: next } });
		} catch (error) {
			console.warn(`[ollama] saving the context of ${tag} failed: ${errorText(error)}`);
		}
		this.#deps.onProgress({ tag, state: outcome.kind === "measured" ? "done" : "error" });
		this.#syncOverlay(tag);
	}

	/**
	 * Write the overlay when it changed, tell every window which models
	 * changed (`touched` always counts), and compact idle sessions whose model
	 * just got a smaller window.
	 */
	#syncOverlay(touched: string | null): void {
		const store = this.#readStore();
		const envCap = this.#deps.envCap();
		const limits = effectiveLimits(store, envCap);
		const yaml = overlayYaml(store, envCap);
		if (yaml !== this.#lastYaml) {
			try {
				this.#deps.writeOverlay(yaml);
				this.#lastYaml = yaml;
			} catch (error) {
				console.warn(`[ollama] writing the context limits overlay failed: ${errorText(error)}`);
			}
		}
		const previous = this.#lastLimits;
		this.#lastLimits = limits;
		const changed = new Set<string>(touched === null ? [] : [touched]);
		if (previous) {
			const fallback = envCap ?? SIDECAR_DEFAULT_OLLAMA_CONTEXT;
			for (const tag of new Set([...previous.keys(), ...limits.keys()])) {
				const before = previous.get(tag) ?? fallback;
				const after = limits.get(tag) ?? fallback;
				if (before === after) continue;
				changed.add(tag);
				if (after < before) this.#compactAbove(tag, after);
			}
		}
		for (const tag of changed) this.#deps.onChanged({ tag });
	}

	#compactAbove(tag: string, window: number): void {
		for (const session of this.#deps.idleSessions()) {
			void this.#compactSession(session, tag, window).catch(error => {
				console.warn(`[ollama] compacting a session after a context change failed: ${errorText(error)}`);
			});
		}
	}

	/**
	 * Wait (bounded) until the session runs `tag` at the new window, then
	 * compact it when its last context usage no longer fits. A session on
	 * another model, or one that started a turn, is left alone.
	 */
	async #compactSession(session: IdleSession, tag: string, window: number): Promise<void> {
		const deadline = Date.now() + (this.#deps.rebindWaitMs ?? 2_000);
		for (;;) {
			const response = await session.command({ type: "get_state" });
			if (!response?.success || !isRecord(response.data)) return;
			const state = response.data as Partial<RpcSessionState>;
			const model = state.model;
			if (model?.provider !== "ollama" || model.id !== tag) return;
			if (typeof model.contextWindow === "number" && model.contextWindow <= window) {
				const tokens = state.contextUsage?.tokens ?? 0;
				if (tokens > window) {
					const failure = await session.command({ type: "compact" }).then(
						response =>
							response === null ? "the session is no longer idle" : response.success ? null : response.error,
						(error: unknown) => errorText(error),
					);
					if (failure !== null) {
						console.warn(
							`[ollama] compacting a session on ${tag} after its context dropped to ${window} did not succeed: ${failure}`,
						);
					}
				}
				return;
			}
			if (Date.now() >= deadline) {
				console.warn(`[ollama] a session on ${tag} did not take the new context window; not compacting it`);
				return;
			}
			await delay(this.#deps.rebindPollMs ?? 200);
		}
	}

	async #startupPass(): Promise<void> {
		if (this.#startupDone || this.#startupRunning || this.#disposed) return;
		this.#startupRunning = true;
		try {
			if (this.#deps.configuredProvider()) {
				this.#startupDone = true;
				return;
			}
			const baseUrl = await this.#deps.baseUrl();
			if (!isLoopbackBaseUrl(baseUrl)) {
				this.#startupDone = true;
				return;
			}
			const rows = await this.#deps.listRows(baseUrl);
			if (!rows) return;
			this.#startupDone = true;
			const machine = await this.#deps.readMachine();
			if (!machine) return;
			const current = fingerprintOf(machine);
			const stored = this.#readStore().models;
			for (const row of rows) {
				if (!isMeasurableRow(row)) continue;
				const tag = rowKey(row);
				const entry = Object.hasOwn(stored, tag) ? stored[tag] : undefined;
				if (needsAutoMeasure(entry, current)) this.#add(tag, "stale");
			}
		} catch (error) {
			console.warn(`[ollama] the startup context check failed: ${errorText(error)}`);
		} finally {
			this.#startupRunning = false;
		}
	}
}
