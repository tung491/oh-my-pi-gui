import { describe, expect, it } from "vitest";
import {
	clampCap,
	effectiveContext,
	emptyContextFitStore,
	isStale,
	needsAutoMeasure,
	overlayYaml,
	parseContextFitStore,
} from "./context-fit-store";
import type { ContextFitEntry, ContextFitStore, MachineFingerprint } from "./ollama-types";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function fingerprint(overrides: Partial<MachineFingerprint> = {}): MachineFingerprint {
	return { ramBytes: 32 * GiB, vramBytes: 8 * GiB, gpuName: "NVIDIA RTX 4060", unifiedMemory: false, ...overrides };
}

function entry(overrides: Partial<ContextFitEntry> = {}): ContextFitEntry {
	return {
		maxContext: 65_536,
		trainedContext: 131_072,
		pool: "gpu",
		verdict: "fits",
		measuredAt: "2026-10-07T10:00:00.000Z",
		fingerprint: fingerprint(),
		userCap: null,
		attempts: 0,
		lastError: null,
		lastAttemptAt: "2026-10-07T10:00:00.000Z",
		...overrides,
	};
}

function store(models: Record<string, ContextFitEntry>): ContextFitStore {
	return { version: 1, models };
}

describe("context fit store", () => {
	it("parses a valid store", () => {
		const raw = store({
			"qwen3:8b": entry({ userCap: 32_768 }),
			"gemma3:4b": entry({
				maxContext: null,
				trainedContext: null,
				pool: null,
				verdict: null,
				measuredAt: null,
				fingerprint: fingerprint({ vramBytes: null, gpuName: null }),
				attempts: 2,
				lastError: "boom",
			}),
		});
		expect(parseContextFitStore(JSON.parse(JSON.stringify(raw)))).toEqual(raw);
	});

	it("drops malformed entries without throwing", () => {
		const good = entry();
		const models = JSON.parse(
			`{"__proto__": ${JSON.stringify(good)}, "constructor": 1, "ok:latest": ${JSON.stringify(good)}}`,
		) as Record<string, unknown>;
		Object.assign(models, {
			"": good,
			"float:latest": { ...good, maxContext: 1.5 },
			"neg:latest": { ...good, maxContext: -1 },
			"huge:latest": { ...good, maxContext: 2 ** 30 },
			"pool:latest": { ...good, pool: "disk" },
			"fp:latest": { ...good, fingerprint: { ramBytes: "lots" } },
			"cap:latest": { ...good, userCap: 131_072 },
			"orphan-cap:latest": { ...good, maxContext: null, userCap: 16_384 },
			"attempts:latest": { ...good, attempts: -2 },
			"missing:latest": { maxContext: 32_768 },
			"string:latest": "32768",
		});
		const parsed = parseContextFitStore({ version: 1, models });
		expect(Object.keys(parsed.models).sort()).toEqual(["__proto__", "ok:latest"].sort());
		expect(Object.getPrototypeOf(parsed.models)).toBe(Object.prototype);
		for (const raw of [null, undefined, 42, "x", [], { version: 2, models: {} }, { version: 1, models: [] }]) {
			expect(parseContextFitStore(raw)).toEqual(emptyContextFitStore());
		}
	});

	it("computes the effective context from the cap the max and the env cap", () => {
		expect(effectiveContext(entry(), null)).toBe(65_536);
		expect(effectiveContext(entry({ userCap: 32_768 }), null)).toBe(32_768);
		expect(effectiveContext(entry({ userCap: 32_768 }), 16_384)).toBe(16_384);
		expect(effectiveContext(entry(), 40_000)).toBe(40_000);
		expect(effectiveContext(entry({ userCap: 32_768 }), 131_072)).toBe(32_768);
	});

	it("returns no effective context before a measurement", () => {
		expect(effectiveContext(entry({ maxContext: null }), null)).toBeNull();
		expect(effectiveContext(entry({ maxContext: null }), 8_192)).toBeNull();
	});

	it("treats a null vram reading as unchanged", () => {
		expect(isStale(entry(), fingerprint({ vramBytes: null, gpuName: null }))).toBe(false);
		expect(isStale(entry({ fingerprint: fingerprint({ vramBytes: null }) }), fingerprint())).toBe(false);
		expect(isStale(entry(), fingerprint({ vramBytes: 12 * GiB }))).toBe(true);
	});

	it("detects a ram change at 256 MiB granularity", () => {
		const base = fingerprint({ ramBytes: 32 * GiB });
		expect(isStale(entry({ fingerprint: base }), fingerprint({ ramBytes: 32 * GiB + 100 * MiB }))).toBe(false);
		expect(isStale(entry({ fingerprint: base }), fingerprint({ ramBytes: 32 * GiB + 256 * MiB }))).toBe(true);
		expect(isStale(entry({ fingerprint: base }), fingerprint({ ramBytes: 16 * GiB }))).toBe(true);
		expect(isStale(entry({ fingerprint: base }), fingerprint({ unifiedMemory: true }))).toBe(true);
	});

	it("ignores a gpu name change unless both readings come from nvidia-smi", () => {
		// Without VRAM the name came from Chromium, whose wording changes between drivers.
		const chromium = entry({ fingerprint: fingerprint({ vramBytes: null, gpuName: "ANGLE (NVIDIA)" }) });
		expect(isStale(chromium, fingerprint({ vramBytes: null, gpuName: "NVIDIA GeForce" }))).toBe(false);
		expect(isStale(chromium, fingerprint({ gpuName: "NVIDIA RTX 4060" }))).toBe(false);
		expect(isStale(entry(), fingerprint({ gpuName: "NVIDIA RTX 4070" }))).toBe(true);
	});

	it("needs an auto measure for a model with no entry", () => {
		expect(needsAutoMeasure(undefined, fingerprint())).toBe(true);
		expect(needsAutoMeasure(null, fingerprint())).toBe(true);
		expect(needsAutoMeasure(entry(), fingerprint())).toBe(false);
		expect(needsAutoMeasure(entry(), fingerprint({ ramBytes: 64 * GiB }))).toBe(true);
	});

	it("does not auto retry a failure under the current fingerprint", () => {
		const failed = entry({ maxContext: null, attempts: 1, lastError: "/api/show answered HTTP 404" });
		expect(needsAutoMeasure(failed, fingerprint())).toBe(false);
		expect(needsAutoMeasure(failed, fingerprint({ ramBytes: 64 * GiB }))).toBe(true);
	});

	it("clamps a cap into the allowed range", () => {
		expect(clampCap(entry(), 32_768)).toEqual({ ok: true, userCap: 32_768 });
		expect(clampCap(entry(), 16_384)).toEqual({ ok: true, userCap: 16_384 });
		expect(clampCap(entry(), null)).toEqual({ ok: true, userCap: null });
		for (const cap of [16_383, 65_537, 20_000.5, Number.NaN, "32768", undefined, -1]) {
			expect(clampCap(entry(), cap), String(cap)).toEqual({ ok: false, reason: "out-of-range" });
		}
		// A maximum below the floor is its own lower bound.
		expect(clampCap(entry({ maxContext: 8_192 }), 8_192)).toEqual({ ok: true, userCap: null });
		expect(clampCap(entry({ maxContext: 8_192 }), 4_096)).toEqual({ ok: false, reason: "out-of-range" });
		expect(clampCap(entry({ maxContext: null }), 32_768)).toEqual({ ok: false, reason: "unmeasured" });
		expect(clampCap(undefined, null)).toEqual({ ok: false, reason: "unmeasured" });
	});

	it("stores a cap equal to the max as null", () => {
		expect(clampCap(entry(), 65_536)).toEqual({ ok: true, userCap: null });
	});

	it("quotes tags in the overlay yaml", () => {
		const yaml = overlayYaml(
			store({ "qwen3:8b": entry({ userCap: 32_768 }), "hf.co/x/y:Q4_K_M": entry({ maxContext: 16_384 }) }),
			null,
		);
		expect(yaml).toBe('ollama:\n  contextLimits:\n    "hf.co/x/y:Q4_K_M": 16384\n    "qwen3:8b": 32768\n');
		expect(overlayYaml(store({ "qwen3:8b": entry() }), 20_000)).toBe(
			'ollama:\n  contextLimits:\n    "qwen3:8b": 20000\n',
		);
	});

	it("leaves models without an effective value out of the overlay", () => {
		const yaml = overlayYaml(store({ "qwen3:8b": entry(), "gemma3:4b": entry({ maxContext: null }) }), null);
		expect(yaml).toBe('ollama:\n  contextLimits:\n    "qwen3:8b": 65536\n');
		expect(overlayYaml(store({ "gemma3:4b": entry({ maxContext: null }) }), null)).toBe(
			"ollama:\n  contextLimits: {}\n",
		);
		expect(overlayYaml(emptyContextFitStore(), 8_192)).toBe("ollama:\n  contextLimits: {}\n");
	});
});
