/**
 * The remembered context of each local Ollama model (`ollamaContextFit` in the
 * prefs file) and the overlay the sidecar reads it from. Pure helpers: main
 * owns every write. Keeps step with `src-tauri/src/ollama/context_fit_store.rs`;
 * change both together.
 */
import {
	CONTEXT_FLOOR,
	type ContextFitEntry,
	type ContextFitResult,
	type ContextFitStore,
	type ContextPool,
	type ContextVerdict,
	type MachineFacts,
	type MachineFingerprint,
} from "./ollama-types";

/** The prefs key; one key for every model because tags contain dots. */
export const CONTEXT_FIT_PREF = "ollamaContextFit";

/** The overlay file in the user data directory, passed to every sidecar as a second `--config`. */
export const CONTEXT_LIMITS_OVERLAY_FILE = "ollama-context-limits.yml";

/** Memory readings closer than this count as the same machine. */
const FINGERPRINT_GRAIN_BYTES = 256 * 1024 * 1024;

/** A context above this (16M tokens) is not a real value. */
const MAX_CONTEXT = 2 ** 24;

export function emptyContextFitStore(): ContextFitStore {
	return { version: 1, models: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextValue(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONTEXT ? value : null;
}

function byteValue(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

/** A nullable field: null stays null, a valid value is kept, anything else marks the entry bad. */
function nullable<T>(value: unknown, parse: (value: unknown) => T | null): T | null | undefined {
	if (value === null) return null;
	const parsed = parse(value);
	return parsed === null ? undefined : parsed;
}

function parsePool(value: unknown): ContextPool | null {
	return value === "gpu" || value === "ram" ? value : null;
}

function parseVerdict(value: unknown): ContextVerdict | null {
	return value === "fits" || value === "spills" || value === "exceeds-ram" ? value : null;
}

function parseFingerprint(value: unknown): MachineFingerprint | null {
	if (!isRecord(value)) return null;
	const ramBytes = byteValue(value.ramBytes);
	const vramBytes = nullable(value.vramBytes, byteValue);
	const gpuName = nullableString(value.gpuName);
	if (ramBytes === null || vramBytes === undefined || gpuName === undefined) return null;
	if (typeof value.unifiedMemory !== "boolean") return null;
	return { ramBytes, vramBytes, gpuName, unifiedMemory: value.unifiedMemory };
}

function parseEntry(value: unknown): ContextFitEntry | null {
	if (!isRecord(value)) return null;
	const maxContext = nullable(value.maxContext, contextValue);
	const trainedContext = nullable(value.trainedContext, contextValue);
	const pool = nullable(value.pool, parsePool);
	const verdict = nullable(value.verdict, parseVerdict);
	const measuredAt = nullableString(value.measuredAt);
	const fingerprint = parseFingerprint(value.fingerprint);
	const userCap = nullable(value.userCap, contextValue);
	const attempts = byteValue(value.attempts);
	const lastError = nullableString(value.lastError);
	const lastAttemptAt = nullableString(value.lastAttemptAt);
	if (
		maxContext === undefined ||
		trainedContext === undefined ||
		pool === undefined ||
		verdict === undefined ||
		measuredAt === undefined ||
		fingerprint === null ||
		userCap === undefined ||
		attempts === null ||
		lastError === undefined ||
		lastAttemptAt === undefined
	) {
		return null;
	}
	// A cap only makes sense below a measured maximum.
	if (userCap !== null && (maxContext === null || userCap > maxContext)) return null;
	return {
		maxContext,
		trainedContext,
		pool,
		verdict,
		measuredAt,
		fingerprint,
		userCap,
		attempts,
		lastError,
		lastAttemptAt,
	};
}

/** The store from whatever the prefs file holds; malformed entries are dropped, and it never throws. */
export function parseContextFitStore(raw: unknown): ContextFitStore {
	const store = emptyContextFitStore();
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.models)) return store;
	const models = new Map<string, ContextFitEntry>();
	for (const tag of Object.keys(raw.models)) {
		if (!Object.hasOwn(raw.models, tag) || tag === "") continue;
		const entry = parseEntry(raw.models[tag]);
		if (entry) models.set(tag, entry);
	}
	store.models = Object.fromEntries(models);
	return store;
}

/** The facts of `machine` a measurement depends on. */
export function fingerprintOf(machine: MachineFacts): MachineFingerprint {
	return {
		ramBytes: machine.ramBytes,
		vramBytes: machine.vramBytes,
		gpuName: machine.gpuName,
		unifiedMemory: machine.unifiedMemory,
	};
}

/** `min(userCap ?? max, max, envCap)`, or null before a measurement. */
export function effectiveContext(entry: ContextFitEntry, envCap: number | null): number | null {
	if (entry.maxContext === null) return null;
	const chosen = Math.min(entry.userCap ?? entry.maxContext, entry.maxContext);
	return envCap === null ? chosen : Math.min(chosen, envCap);
}

function sameGrain(a: number, b: number): boolean {
	return Math.floor(a / FINGERPRINT_GRAIN_BYTES) === Math.floor(b / FINGERPRINT_GRAIN_BYTES);
}

/**
 * Whether the machine changed since the entry's last attempt. A null VRAM
 * reading is unknown, not a change; the GPU name counts only when both
 * readings came from `nvidia-smi` (the only source that reports VRAM).
 */
export function isStale(entry: ContextFitEntry, current: MachineFingerprint): boolean {
	const last = entry.fingerprint;
	if (!sameGrain(last.ramBytes, current.ramBytes)) return true;
	if (last.unifiedMemory !== current.unifiedMemory) return true;
	if (last.vramBytes !== null && current.vramBytes !== null) {
		if (!sameGrain(last.vramBytes, current.vramBytes)) return true;
		if (last.gpuName !== current.gpuName) return true;
	}
	return false;
}

/**
 * Whether the startup pass measures this model: it was never tried, or the
 * machine changed since. The fingerprint is the last attempt's, so a failure
 * under the current machine is never stale and is not retried automatically.
 */
export function needsAutoMeasure(entry: ContextFitEntry | null | undefined, current: MachineFingerprint): boolean {
	return !entry || isStale(entry, current);
}

/** The last attempt failed on this same machine; automatic triggers leave such a model alone. */
export function failedUnderCurrent(entry: ContextFitEntry | null | undefined, current: MachineFingerprint): boolean {
	return !!entry && entry.lastError !== null && !isStale(entry, current);
}

export type CapDecision = { ok: true; userCap: number | null } | { ok: false; reason: "unmeasured" | "out-of-range" };

/**
 * The `userCap` to store for a requested cap: null clears it, and a safe
 * integer in `[min(16384, max), max]` sets it (the max itself stores null).
 * Anything else, or a model never measured, is rejected.
 */
export function clampCap(entry: ContextFitEntry | null | undefined, cap: unknown): CapDecision {
	const max = entry?.maxContext ?? null;
	if (max === null) return { ok: false, reason: "unmeasured" };
	if (cap === null) return { ok: true, userCap: null };
	if (typeof cap !== "number" || !Number.isSafeInteger(cap)) return { ok: false, reason: "out-of-range" };
	if (cap < Math.min(CONTEXT_FLOOR, max) || cap > max) return { ok: false, reason: "out-of-range" };
	return { ok: true, userCap: cap === max ? null : cap };
}

/** The entry after a successful measurement: a cap still below the new maximum survives. */
export function withMeasured(
	entry: ContextFitEntry | null | undefined,
	result: ContextFitResult,
	fingerprint: MachineFingerprint,
	now: string,
): ContextFitEntry {
	const userCap = entry?.userCap ?? null;
	return {
		maxContext: result.maxContext,
		trainedContext: result.trainedContext,
		pool: result.pool,
		verdict: result.verdict,
		measuredAt: now,
		fingerprint,
		userCap: userCap !== null && userCap < result.maxContext ? userCap : null,
		attempts: entry?.attempts ?? 0,
		lastError: null,
		lastAttemptAt: now,
	};
}

/** The entry after a failed attempt: counted and remembered, with any earlier maximum kept. */
export function withFailure(
	entry: ContextFitEntry | null | undefined,
	message: string,
	fingerprint: MachineFingerprint,
	now: string,
): ContextFitEntry {
	return {
		maxContext: entry?.maxContext ?? null,
		trainedContext: entry?.trainedContext ?? null,
		pool: entry?.pool ?? null,
		verdict: entry?.verdict ?? null,
		measuredAt: entry?.measuredAt ?? null,
		fingerprint,
		userCap: entry?.userCap ?? null,
		attempts: (entry?.attempts ?? 0) + 1,
		lastError: message,
		lastAttemptAt: now,
	};
}

/** Each model's effective context, for models that have one. */
export function effectiveLimits(store: ContextFitStore, envCap: number | null): Map<string, number> {
	const limits = new Map<string, number>();
	for (const tag of Object.keys(store.models).sort()) {
		const entry = store.models[tag];
		const value = entry ? effectiveContext(entry, envCap) : null;
		if (value !== null) limits.set(tag, value);
	}
	return limits;
}

/** The overlay the sidecar reads: `ollama.contextLimits`, one quoted tag per model with an effective context. */
export function overlayYaml(store: ContextFitStore, envCap: number | null): string {
	const limits = effectiveLimits(store, envCap);
	if (limits.size === 0) return "ollama:\n  contextLimits: {}\n";
	const lines = ["ollama:", "  contextLimits:"];
	// A JSON string is a valid YAML double-quoted scalar.
	for (const [tag, value] of limits) lines.push(`    ${JSON.stringify(tag)}: ${value}`);
	return `${lines.join("\n")}\n`;
}
