import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeOllama, sendJson, startFakeOllama } from "../../../e2e/fake-ollama";
import { parseContextFitStore } from "../../shared/context-fit-store";
import type { OllamaTagRow } from "../../shared/ollama-local";
import type {
	ContextFitChanged,
	ContextFitEntry,
	ContextFitProgress,
	ContextFitStore,
	MachineFacts,
	MeasureOutcome,
} from "../../shared/ollama-types";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { MeasureContextFitInput } from "./context-fit";
import { ContextFitScheduler, type IdleSession, unloadResidentModels } from "./context-fit-scheduler";

const GiB = 1024 ** 3;
const LOCAL = "http://127.0.0.1:11434";
const NOW = "2026-10-07T12:00:00.000Z";

const MACHINE: MachineFacts = {
	ramBytes: 32 * GiB,
	vramBytes: 8 * GiB,
	gpuName: "NVIDIA RTX 4060",
	unifiedMemory: false,
	threads: 16,
};

function measured(maxContext: number): MeasureOutcome {
	return { kind: "measured", result: { maxContext, trainedContext: 131_072, pool: "gpu", verdict: "fits" } };
}

function entry(overrides: Partial<ContextFitEntry> = {}): ContextFitEntry {
	return {
		maxContext: 65_536,
		trainedContext: 131_072,
		pool: "gpu",
		verdict: "fits",
		measuredAt: NOW,
		fingerprint: {
			ramBytes: MACHINE.ramBytes,
			vramBytes: MACHINE.vramBytes,
			gpuName: MACHINE.gpuName,
			unifiedMemory: false,
		},
		userCap: null,
		attempts: 0,
		lastError: null,
		lastAttemptAt: NOW,
		...overrides,
	};
}

interface HarnessOptions {
	rows?: OllamaTagRow[];
	baseUrl?: string;
	models?: Record<string, ContextFitEntry>;
	measure?: (input: MeasureContextFitInput) => Promise<MeasureOutcome>;
	unloadResident?: (baseUrl: string) => Promise<void>;
	envCap?: number | null;
	configuredProvider?: boolean;
	welcomeDone?: boolean;
	busy?: boolean;
	sessions?: IdleSession[];
}

function harness(options: HarnessOptions = {}) {
	const state = {
		store: { version: 1, models: { ...options.models } } as unknown,
		busy: options.busy ?? false,
		welcomeDone: options.welcomeDone ?? true,
		envCap: options.envCap ?? null,
	};
	const overlays: string[] = [];
	const progress: ContextFitProgress[] = [];
	const changed: ContextFitChanged[] = [];
	const measures: MeasureContextFitInput[] = [];
	const scheduler = new ContextFitScheduler({
		baseUrl: async () => options.baseUrl ?? LOCAL,
		listRows: async () => options.rows ?? [{ name: "qwen3:8b", model: "qwen3:8b", size: 5 * GiB }],
		readMachine: async () => MACHINE,
		isBusy: () => state.busy,
		welcomeDone: () => state.welcomeDone,
		configuredProvider: () => options.configuredProvider ?? false,
		envCap: () => state.envCap,
		readStore: () => state.store,
		writeStore: value => {
			state.store = JSON.parse(JSON.stringify(value));
		},
		writeOverlay: yaml => overlays.push(yaml),
		onProgress: frame => progress.push(frame),
		onChanged: change => changed.push(change),
		idleSessions: () => options.sessions ?? [],
		measure: async input => {
			measures.push(input);
			return options.measure ? options.measure(input) : measured(65_536);
		},
		unloadResident: options.unloadResident ?? (async () => {}),
		now: () => NOW,
		retryMs: 10,
		rebindWaitMs: 500,
		rebindPollMs: 5,
	});
	schedulers.push(scheduler);
	const store = (): ContextFitStore => parseContextFitStore(state.store);
	return { scheduler, state, overlays, progress, changed, measures, store };
}

const schedulers: ContextFitScheduler[] = [];
let fake: FakeOllama | undefined;

afterEach(async () => {
	for (const scheduler of schedulers.splice(0)) scheduler.dispose();
	await fake?.close();
	fake = undefined;
});

/** Let queued work run, for checks that something did not happen. */
function settle(ms = 40): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** An idle tab on `model` that reports `windows` in turn from get_state (the last one repeats). */
function session(model: string, tokens: number, windows: number[]) {
	const commands: RpcCommand["type"][] = [];
	let polls = 0;
	const idle: IdleSession = {
		command: async (command: RpcCommand): Promise<RpcResponse | null> => {
			commands.push(command.type);
			if (command.type !== "get_state") return { type: "response", command: command.type, success: true };
			const contextWindow = windows[Math.min(polls, windows.length - 1)];
			polls++;
			return {
				type: "response",
				command: "get_state",
				success: true,
				data: {
					model: { provider: "ollama", id: model, contextWindow },
					contextUsage: { tokens, contextWindow, percent: 0 },
				},
			};
		},
	};
	return { idle, commands };
}

describe("ContextFitScheduler", () => {
	it("waits while any sidecar is running or compacting", async () => {
		const h = harness({ busy: true });
		await h.scheduler.enqueue("qwen3:8b", "manual");
		await settle();
		expect(h.measures).toHaveLength(0);
		expect((await h.scheduler.list()).rows[0]?.state).toBe("queued");

		h.state.busy = false;
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));
		await vi.waitFor(() => expect(h.store().models["qwen3:8b"]?.maxContext).toBe(65_536));
		expect(h.progress.map(frame => frame.state)).toEqual(["queued", "done"]);
	});

	it("puts manual requests first and removes duplicates", async () => {
		const gate = Promise.withResolvers<MeasureOutcome>();
		const rows = ["a:1b", "b:1b", "c:1b"].map(name => ({ name, model: name }));
		const h = harness({
			rows,
			measure: input => (input.row.name === "a:1b" ? gate.promise : Promise.resolve(measured(32_768))),
		});
		await h.scheduler.enqueue("a:1b", "manual");
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));
		await h.scheduler.enqueue("b:1b", "pulled");
		await h.scheduler.enqueue("c:1b", "pulled");
		await h.scheduler.enqueue("c:1b", "manual");
		await h.scheduler.enqueue("b:1b", "pulled");
		await h.scheduler.enqueue("a:1b", "manual");

		gate.resolve(measured(65_536));
		await vi.waitFor(() => expect(h.measures).toHaveLength(3));
		await settle();
		expect(h.measures.map(input => input.row.name)).toEqual(["a:1b", "c:1b", "b:1b"]);
	});

	it("requeues an interrupted run at most three times", async () => {
		const h = harness({ measure: async () => ({ kind: "interrupted" }) });
		await h.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(h.measures).toHaveLength(4));
		await settle();
		expect(h.measures).toHaveLength(4);
		expect(h.store().models).toEqual({});
		expect((await h.scheduler.list()).rows[0]?.state).toBe("idle");

		// A new trigger gets a fresh budget.
		await h.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(h.measures).toHaveLength(8));
	});

	it("does not auto retry a failed model but retries a manual request", async () => {
		const failed = entry({ maxContext: null, attempts: 1, lastError: "boom" });
		const h = harness({ models: { "qwen3:8b": failed } });
		h.scheduler.start();
		await h.scheduler.enqueue("qwen3:8b", "pulled");
		await settle();
		expect(h.measures).toHaveLength(0);

		await h.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(h.store().models["qwen3:8b"]?.maxContext).toBe(65_536));
		expect(h.measures).toHaveLength(1);
		expect(h.store().models["qwen3:8b"]).toMatchObject({ lastError: null, attempts: 1 });

		// A failure is counted, remembered with the machine, and keeps the earlier maximum.
		const failing = harness({ measure: async () => ({ kind: "error", message: "HTTP 404" }) });
		await failing.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(failing.store().models["qwen3:8b"]?.attempts).toBe(1));
		expect(failing.store().models["qwen3:8b"]).toMatchObject({ maxContext: null, lastError: "HTTP 404" });
		expect(failing.progress.at(-1)).toEqual({ tag: "qwen3:8b", state: "error" });
	});

	it("holds a pulled model until the welcome dialog has closed", async () => {
		const h = harness({ welcomeDone: false });
		await h.scheduler.enqueue("qwen3:8b", "pulled");
		await settle();
		expect(h.measures).toHaveLength(0);

		h.state.welcomeDone = true;
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));
	});

	it("stores a pulled bare tag under its latest name", async () => {
		const h = harness({
			rows: [
				{ name: "qwen3:8b", model: "qwen3:8b" },
				{ name: "qwen3:latest", model: "qwen3:latest" },
			],
		});
		await h.scheduler.enqueue("qwen3", "pulled");
		await vi.waitFor(() => expect(h.store().models["qwen3:latest"]?.maxContext).toBe(65_536));
		expect(h.measures[0]?.row.name).toBe("qwen3:latest");
		const list = await h.scheduler.list();
		expect(list.rows.find(row => row.tag === "qwen3:latest")).toMatchObject({ effective: 65_536, stale: false });
		expect(list.rows.find(row => row.tag === "qwen3:8b")).toMatchObject({ entry: null, effective: null });
	});

	it("keeps a cap set during a measurement", async () => {
		const gate = Promise.withResolvers<MeasureOutcome>();
		const h = harness({ models: { "qwen3:8b": entry() }, measure: () => gate.promise });
		h.scheduler.start();
		await h.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));

		await expect(h.scheduler.setCap("qwen3:8b", 32_768)).resolves.toMatchObject({ userCap: 32_768 });
		gate.resolve(measured(65_536));
		await vi.waitFor(() => expect(h.progress.at(-1)?.state).toBe("done"));
		expect(h.store().models["qwen3:8b"]).toMatchObject({ maxContext: 65_536, userCap: 32_768 });
		expect(h.overlays.at(-1)).toBe('ollama:\n  contextLimits:\n    "qwen3:8b": 32768\n');

		// Outside the range, or for a model never measured, the cap is refused.
		await expect(h.scheduler.setCap("qwen3:8b", 70_000)).rejects.toThrow();
		await expect(h.scheduler.setCap("qwen3:8b", 1_000)).rejects.toThrow();
		const fresh = harness();
		await expect(fresh.scheduler.setCap("qwen3:8b", 32_768)).rejects.toThrow();
	});

	it("lowers the overlay value with the env cap", async () => {
		const h = harness({ models: { "qwen3:8b": entry() } });
		h.scheduler.start();
		expect(h.overlays).toEqual(['ollama:\n  contextLimits:\n    "qwen3:8b": 65536\n']);

		h.state.envCap = 40_000;
		h.scheduler.refreshOverlay();
		expect(h.overlays.at(-1)).toBe('ollama:\n  contextLimits:\n    "qwen3:8b": 40000\n');
		expect(h.changed).toContainEqual({ tag: "qwen3:8b" });
		expect((await h.scheduler.list()).rows[0]).toMatchObject({ effective: 40_000, envCap: 40_000 });
	});

	it("compacts only idle sessions above the new window after the rebind", async () => {
		const over = session("qwen3:8b", 40_000, [65_536, 65_536, 32_768]);
		const under = session("qwen3:8b", 20_000, [32_768]);
		const other = session("gemma3:4b", 50_000, [8_192]);
		const h = harness({ models: { "qwen3:8b": entry() }, sessions: [over.idle, under.idle, other.idle] });
		h.scheduler.start();

		await h.scheduler.setCap("qwen3:8b", 32_768);
		await vi.waitFor(() => expect(over.commands).toContain("compact"));
		await settle();
		// The compaction waits until the session runs at the new window.
		expect(over.commands).toEqual(["get_state", "get_state", "get_state", "compact"]);
		expect(under.commands).toEqual(["get_state"]);
		expect(other.commands).toEqual(["get_state"]);

		// Raising the limit again compacts nothing.
		await h.scheduler.setCap("qwen3:8b", null);
		await settle();
		expect(over.commands.filter(command => command === "compact")).toHaveLength(1);
	});

	it("skips the startup pass when a configured ollama provider exists", async () => {
		const h = harness({ configuredProvider: true });
		h.scheduler.start();
		h.scheduler.noteOllamaAnswered();
		await settle();
		expect(h.measures).toHaveLength(0);
		expect((await h.scheduler.list()).reason).toBe("configured-provider");

		await h.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));

		// Without one, the startup pass measures each model never measured.
		const plain = harness({
			rows: [
				{ name: "qwen3:8b", model: "qwen3:8b" },
				{ name: "gemma3:4b", model: "gemma3:4b" },
			],
			models: { "gemma3:4b": entry() },
		});
		plain.scheduler.start();
		await vi.waitFor(() => expect(plain.measures).toHaveLength(1));
		expect(plain.measures[0]?.row.name).toBe("qwen3:8b");
	});

	it("unloads resident models before measuring", async () => {
		let resident = ["llama3:8b", "qwen3:8b"];
		const unloads: unknown[] = [];
		fake = await startFakeOllama((req, res, body) => {
			if (req.url === "/api/ps") return sendJson(res, { models: resident.map(name => ({ name, model: name })) });
			if (req.url === "/api/generate") {
				const parsed = JSON.parse(body) as { model: string; keep_alive: unknown };
				unloads.push(parsed);
				resident = resident.filter(name => name !== parsed.model);
				return sendJson(res, { done: true });
			}
			sendJson(res, { error: "not found" }, 404);
		});
		const url = fake.url;
		let residentAtMeasure: string[] | null = null;
		const h = harness({
			baseUrl: url,
			unloadResident: baseUrl => unloadResidentModels(baseUrl, { waitMs: 500, pollMs: 5 }),
			measure: async () => {
				residentAtMeasure = [...resident];
				return measured(65_536);
			},
		});
		await h.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));
		expect(residentAtMeasure).toEqual([]);
		expect(unloads).toEqual([
			{ model: "llama3:8b", keep_alive: 0, stream: false },
			{ model: "qwen3:8b", keep_alive: 0, stream: false },
		]);
	});

	it("passes the global cap as the engine ceiling", async () => {
		const h = harness();
		await h.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));
		expect(h.measures[0]?.maxContext).toBe(131_072);

		const capped = harness({ envCap: 32_768 });
		await capped.scheduler.enqueue("qwen3:8b", "manual");
		await vi.waitFor(() => expect(capped.measures).toHaveLength(1));
		expect(capped.measures[0]?.maxContext).toBe(32_768);
	});

	it("never measures a cloud tag or a remote host", async () => {
		const h = harness({
			rows: [
				{ name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud" },
				{ name: "mine:latest", model: "mine:latest", remote_host: "https://ollama.com:443" },
				{ name: "qwen3:8b", model: "qwen3:8b" },
			],
		});
		h.scheduler.start();
		await vi.waitFor(() => expect(h.measures).toHaveLength(1));
		expect(h.measures[0]?.row.name).toBe("qwen3:8b");
		await expect(h.scheduler.enqueue("gpt-oss:120b-cloud", "manual")).rejects.toThrow();
		await expect(h.scheduler.enqueue("mine:latest", "manual")).rejects.toThrow();
		await expect(h.scheduler.enqueue("missing:1b", "manual")).rejects.toThrow();
		await expect(h.scheduler.enqueue("bad name", "manual")).rejects.toThrow();
		expect((await h.scheduler.list()).rows.map(row => row.tag)).toEqual(["qwen3:8b"]);

		const remote = harness({ baseUrl: "http://192.168.1.5:11434" });
		remote.scheduler.start();
		await expect(remote.scheduler.enqueue("qwen3:8b", "manual")).rejects.toThrow();
		await settle();
		expect(remote.measures).toHaveLength(0);
		expect(await remote.scheduler.list()).toEqual({ rows: [], reason: "remote-host" });
	});
});
