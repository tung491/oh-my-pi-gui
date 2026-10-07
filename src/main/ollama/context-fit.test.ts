import { afterEach, describe, expect, it } from "vitest";
import type { OllamaTagRow } from "../../shared/ollama-local";
import type { ContextFitProgress, MachineFacts, MeasureOutcome } from "../../shared/ollama-types";
import { measureContextFit } from "./context-fit";
import { type FakeOllama, sendJson, startFakeOllama } from "./test-fake-ollama";

const GiB = 1024 ** 3;
const TAG = "qwen3:8b";

/**
 * A stand-in for the daemon's memory behaviour: a model of `weights` bytes
 * plus `kvPerToken` per context token, loaded onto a GPU of `gpuBytes` (the
 * rest spills, as Ollama does), or wholly in RAM.
 */
interface SimOptions {
	trained?: unknown;
	parameters?: string;
	weights: number;
	kvPerToken: number;
	/** VRAM Ollama can use; null runs on the CPU (size_vram 0). */
	gpuBytes?: number | null;
	/** Unified memory: Ollama reports the whole model as VRAM. */
	unified?: boolean;
	/** Loads whose size exceeds this answer HTTP 500, as a load beyond system memory does. */
	refuseAbove?: number;
	showStatus?: number;
	psStatus?: number;
	/** Another model stays loaded throughout. */
	foreignRunner?: boolean;
	/** Ollama silently clamps `num_ctx` to this. */
	clampContextAt?: number;
	/** The first load at `numCtx` finds `bytes` less VRAM free (another process held it). */
	transientShortfall?: { numCtx: number; bytes: number };
}

interface SimRequest {
	path: string;
	body: Record<string, unknown> | null;
}

interface Sim {
	requests: SimRequest[];
	loads: number[];
	resident(): boolean;
}

let fake: FakeOllama | undefined;
afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

async function simulate(options: SimOptions): Promise<Sim> {
	const requests: SimRequest[] = [];
	const loads: number[] = [];
	let shortfallUsed = false;
	let loaded: { size: number; sizeVram: number; context: number } | null = null;
	const trained = "trained" in options ? options.trained : 131_072;

	fake = await startFakeOllama((req, res, body) => {
		const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
		const path = req.url ?? "";
		requests.push({ path, body: parsed });
		if (path === "/api/show") {
			if (options.showStatus) return sendJson(res, { error: "model not found" }, options.showStatus);
			return sendJson(res, {
				model_info: { "general.architecture": "qwen3", "qwen3.context_length": trained },
				...(options.parameters === undefined ? {} : { parameters: options.parameters }),
			});
		}
		if (path === "/api/generate") {
			if (parsed?.keep_alive === 0) {
				loaded = null;
				return sendJson(res, { model: TAG, done: true, done_reason: "unload" });
			}
			const numCtx = Number((parsed?.options as { num_ctx?: unknown } | undefined)?.num_ctx);
			loads.push(numCtx);
			const size = options.weights + options.kvPerToken * numCtx;
			if (options.refuseAbove !== undefined && size > options.refuseAbove) {
				loaded = null;
				return sendJson(res, { error: "model requires more system memory (12.0 GiB) than is available" }, 500);
			}
			let gpu = options.gpuBytes ?? 0;
			if (options.transientShortfall?.numCtx === numCtx && !shortfallUsed) {
				shortfallUsed = true;
				gpu -= options.transientShortfall.bytes;
			}
			const sizeVram = options.unified ? size : Math.max(0, Math.min(size, gpu));
			const context = options.clampContextAt === undefined ? numCtx : Math.min(numCtx, options.clampContextAt);
			loaded = { size, sizeVram, context };
			return sendJson(res, { model: TAG, done: true, done_reason: "load" });
		}
		if (path === "/api/ps") {
			if (options.psStatus) return sendJson(res, { error: "boom" }, options.psStatus);
			const models: unknown[] = [];
			if (loaded) {
				models.push({
					name: TAG,
					model: TAG,
					size: loaded.size,
					size_vram: loaded.sizeVram,
					context_length: loaded.context,
				});
			}
			if (options.foreignRunner) {
				models.push({ name: "other:1b", model: "other:1b", size: GiB, size_vram: GiB, context_length: 4096 });
			}
			return sendJson(res, { models });
		}
		sendJson(res, { error: "not found" }, 404);
	});
	return { requests, loads, resident: () => loaded !== null };
}

function machine(overrides: Partial<MachineFacts> = {}): MachineFacts {
	return {
		ramBytes: 32 * GiB,
		vramBytes: 8 * GiB,
		gpuName: "NVIDIA RTX 4060",
		unifiedMemory: false,
		threads: 16,
		...overrides,
	};
}

/** `gib` GiB of KV cache per 1024 tokens, as bytes per token. */
function kv(gib: number): number {
	return (gib * GiB) / 1024;
}

interface RunOptions {
	row?: OllamaTagRow;
	baseUrl?: string;
	machine?: MachineFacts;
	isBusy?: () => boolean;
	progress?: ContextFitProgress[];
}

function run(options: RunOptions = {}): Promise<MeasureOutcome> {
	return measureContextFit({
		baseUrl: options.baseUrl ?? fake?.url ?? "http://127.0.0.1:1",
		row: options.row ?? { name: TAG, model: TAG, size: 5 * GiB },
		machine: options.machine ?? machine(),
		isBusy: options.isBusy ?? (() => false),
		onProgress: progress => options.progress?.push(progress),
		timing: { unloadWaitMs: 200, unloadPollMs: 5 },
	});
}

function lastRequest(sim: Sim): SimRequest | undefined {
	return sim.requests[sim.requests.length - 1];
}

describe("measureContextFit", () => {
	it("picks the largest rung that stays on the GPU", async () => {
		const sim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.1), gpuBytes: 8 * GiB });
		const progress: ContextFitProgress[] = [];
		const outcome = await run({ progress });
		expect(outcome).toEqual({
			kind: "measured",
			result: { maxContext: 32_768, trainedContext: 131_072, pool: "gpu", verdict: "fits" },
		});
		expect(sim.loads).toEqual([16_384, 32_768, 65_536, 65_536]);
		expect(progress).toEqual(sim.loads.map(numCtx => ({ tag: TAG, state: "running", numCtx })));
	});

	it("returns the ceiling when every rung fits", async () => {
		const sim = await simulate({ trained: 32_768, weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		const outcome = await run();
		expect(outcome).toEqual({
			kind: "measured",
			result: { maxContext: 32_768, trainedContext: 32_768, pool: "gpu", verdict: "fits" },
		});
		expect(sim.loads).toEqual([16_384, 32_768]);
	});

	it("uses a trained context that is not a power of two as the top rung", async () => {
		const sim = await simulate({ trained: 40_960, weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		const outcome = await run();
		expect(outcome).toMatchObject({ kind: "measured", result: { maxContext: 40_960, trainedContext: 40_960 } });
		expect(sim.loads).toEqual([16_384, 32_768, 40_960]);
	});

	it("caps the ceiling at the Modelfile num_ctx", async () => {
		const sim = await simulate({
			parameters:
				'stop                           "<|im_end|>"\nnum_ctx                        32768\ntemperature                    0.6',
			weights: 2 * GiB,
			kvPerToken: kv(0.01),
			gpuBytes: 8 * GiB,
		});
		const outcome = await run();
		expect(outcome).toMatchObject({ kind: "measured", result: { maxContext: 32_768, trainedContext: 131_072 } });
		expect(sim.loads).toEqual([16_384, 32_768]);
	});

	it("handles a trained context below the floor", async () => {
		const sim = await simulate({ trained: 8_192, weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		const outcome = await run();
		expect(outcome).toEqual({
			kind: "measured",
			result: { maxContext: 8_192, trainedContext: 8_192, pool: "gpu", verdict: "fits" },
		});
		expect(sim.loads).toEqual([8_192]);
	});

	it("treats an absurd trained context as unknown", async () => {
		for (const trained of [2 ** 40, -1, 0, 1.5, "lots", null]) {
			const sim = await simulate({ trained, weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
			const outcome = await run();
			expect(outcome, String(trained)).toMatchObject({
				kind: "measured",
				result: { maxContext: 131_072, trainedContext: 131_072 },
			});
			expect(sim.loads).toEqual([16_384, 32_768, 65_536, 131_072]);
			await fake?.close();
			fake = undefined;
		}
	});

	it("decides the pool from size_vram, not from nvidia-smi", async () => {
		// nvidia-smi found no GPU, yet Ollama put the model in VRAM.
		await simulate({ weights: 2 * GiB, kvPerToken: kv(0.1), gpuBytes: 8 * GiB });
		const onGpu = await run({ machine: machine({ vramBytes: null, gpuName: null }) });
		expect(onGpu).toMatchObject({ kind: "measured", result: { pool: "gpu", maxContext: 32_768 } });
		await fake?.close();

		// nvidia-smi reported a GPU, yet Ollama ran the model on the CPU.
		await simulate({ weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: null });
		const onCpu = await run({ machine: machine({ vramBytes: 8 * GiB }) });
		expect(onCpu).toMatchObject({ kind: "measured", result: { pool: "ram", maxContext: 131_072, verdict: "fits" } });
	});

	it("uses the RAM budget on unified memory", async () => {
		// 16 GiB RAM keeps 4 GiB back: 12 GiB budget. 64k needs 12.32 GiB, predicted within the slack, so it is tried.
		const sim = await simulate({ weights: 4 * GiB, kvPerToken: kv(0.13), unified: true });
		const outcome = await run({ machine: machine({ ramBytes: 16 * GiB, vramBytes: null, unifiedMemory: true }) });
		expect(outcome).toEqual({
			kind: "measured",
			result: { maxContext: 32_768, trainedContext: 131_072, pool: "ram", verdict: "fits" },
		});
		expect(sim.loads).toEqual([16_384, 32_768, 65_536, 65_536]);
	});

	it("skips a rung predicted to exceed the budget", async () => {
		// 12 GiB budget; 16k and 32k fit, and the line through them puts 64k at 16.8 GiB.
		const sim = await simulate({ weights: 4 * GiB, kvPerToken: kv(0.2), gpuBytes: null });
		const outcome = await run({ machine: machine({ ramBytes: 16 * GiB, vramBytes: null }) });
		expect(outcome).toMatchObject({ kind: "measured", result: { maxContext: 32_768, pool: "ram", verdict: "fits" } });
		expect(sim.loads).toEqual([16_384, 32_768]);
	});

	it("re-probes the first failing rung once after unloading", async () => {
		const sim = await simulate({
			weights: 2 * GiB,
			kvPerToken: kv(0.1),
			gpuBytes: 8 * GiB,
			transientShortfall: { numCtx: 32_768, bytes: 4 * GiB },
		});
		const outcome = await run();
		expect(outcome).toMatchObject({ kind: "measured", result: { maxContext: 32_768, pool: "gpu", verdict: "fits" } });
		// 32k spilled once and fit after the unload; 64k spilled, and a second failure is not re-probed.
		expect(sim.loads).toEqual([16_384, 32_768, 32_768, 65_536]);
		const generate32k = sim.requests
			.map((request, index) => ({ request, index }))
			.filter(({ request }) => (request.body?.options as { num_ctx?: number } | undefined)?.num_ctx === 32_768)
			.map(({ index }) => index);
		const between = sim.requests.slice(generate32k[0] + 1, generate32k[1]).map(request => request.path);
		expect(sim.requests[generate32k[0] + 2]?.body).toMatchObject({ model: TAG, keep_alive: 0 });
		expect(between.slice(1)).toEqual(["/api/generate", "/api/ps"]);
	});

	it("treats HTTP 500 on load as not fitting", async () => {
		const sim = await simulate({ weights: 4 * GiB, kvPerToken: kv(0.1), gpuBytes: null, refuseAbove: 10 * GiB });
		const outcome = await run({ machine: machine({ vramBytes: null }) });
		expect(outcome).toEqual({
			kind: "measured",
			result: { maxContext: 32_768, trainedContext: 131_072, pool: "ram", verdict: "fits" },
		});
		expect(sim.loads).toEqual([16_384, 32_768, 65_536, 65_536]);
	});

	it("reports spills at the floor", async () => {
		const sim = await simulate({ weights: 4 * GiB, kvPerToken: kv(0.1), gpuBytes: 4 * GiB });
		const spills = await run();
		expect(spills).toEqual({
			kind: "measured",
			result: { maxContext: 16_384, trainedContext: 131_072, pool: "gpu", verdict: "spills" },
		});
		expect(sim.loads).toEqual([16_384, 16_384]);
		await fake?.close();

		// From RAM: 8 GiB keeps 4 GiB back, and the floor needs 5.6 GiB.
		await simulate({ weights: 4 * GiB, kvPerToken: kv(0.1), gpuBytes: null });
		const exceeds = await run({ machine: machine({ ramBytes: 8 * GiB, vramBytes: null }) });
		expect(exceeds).toMatchObject({
			kind: "measured",
			result: { maxContext: 16_384, pool: "ram", verdict: "exceeds-ram" },
		});
	});

	it("returns error on a non-2xx from api/show or api/ps", async () => {
		const showSim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.1), gpuBytes: 8 * GiB, showStatus: 404 });
		const showOutcome = await run();
		expect(showOutcome).toMatchObject({ kind: "error" });
		expect(showSim.requests.map(request => request.path)).toEqual(["/api/show"]);
		await fake?.close();

		const psSim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.1), gpuBytes: 8 * GiB, psStatus: 500 });
		const psOutcome = await run();
		expect(psOutcome).toMatchObject({ kind: "error" });
		expect(lastRequest(psSim)?.body).toMatchObject({ model: TAG, keep_alive: 0 });
		expect(psSim.resident()).toBe(false);
	});

	it("discards a probe with a foreign runner", async () => {
		const sim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.1), gpuBytes: 8 * GiB, foreignRunner: true });
		expect(await run()).toEqual({ kind: "interrupted" });
		expect(sim.loads).toEqual([16_384]);
		expect(sim.resident()).toBe(false);
	});

	it("discards a probe whose context_length differs", async () => {
		const sim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB, clampContextAt: 32_768 });
		expect(await run()).toEqual({ kind: "interrupted" });
		expect(sim.loads).toEqual([16_384, 32_768, 65_536]);
		expect(sim.resident()).toBe(false);
	});

	it("aborts as interrupted when a sidecar becomes busy", async () => {
		const sim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		const outcome = await run({ isBusy: () => sim.loads.length >= 1 });
		expect(outcome).toEqual({ kind: "interrupted" });
		expect(sim.loads).toEqual([16_384]);
	});

	it("unloads the model after measuring, also after an abort", async () => {
		const measured = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		expect(await run()).toMatchObject({ kind: "measured" });
		expect(lastRequest(measured)).toEqual({
			path: "/api/generate",
			body: { model: TAG, keep_alive: 0, stream: false },
		});
		expect(measured.resident()).toBe(false);
		await fake?.close();

		const aborted = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		expect(await run({ isBusy: () => aborted.loads.length >= 2 })).toEqual({ kind: "interrupted" });
		expect(lastRequest(aborted)?.body).toMatchObject({ model: TAG, keep_alive: 0 });
		expect(aborted.resident()).toBe(false);
	});

	it("rejects a cloud tag, a remote copy and a non-loopback host without any request", async () => {
		const sim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		const rows: OllamaTagRow[] = [
			{ name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud" },
			{
				name: "mine:latest",
				model: "mine:latest",
				remote_host: "https://ollama.com:443",
				remote_model: "gpt-oss:120b",
			},
		];
		for (const row of rows) {
			expect(await run({ row }), row.name).toMatchObject({ kind: "error" });
		}
		for (const baseUrl of ["http://192.168.1.5:11434", "http://127.0.0.1.example.com:11434"]) {
			expect(await run({ baseUrl }), baseUrl).toMatchObject({ kind: "error" });
		}
		expect(sim.requests).toEqual([]);
	});

	it("rejects an invalid tag without any request", async () => {
		const sim = await simulate({ weights: 2 * GiB, kvPerToken: kv(0.01), gpuBytes: 8 * GiB });
		for (const name of ["bad name", "", "-leading:dash", "x".repeat(300)]) {
			expect(await run({ row: { name } }), name).toMatchObject({ kind: "error" });
		}
		expect(sim.requests).toEqual([]);
	});
});
