import { describe, expect, it } from "vitest";
import { chooseModels, fitOf, needBytes, OLLAMA_CATALOG, speedOf } from "./ollama-catalog";
import type { MachineFacts, ModelTier } from "./ollama-types";

const GiB = 1024 ** 3;

function machine(overrides: Partial<MachineFacts>): MachineFacts {
	return { ramBytes: 16 * GiB, vramBytes: null, gpuName: null, unifiedMemory: false, ...overrides };
}

function cards(facts: MachineFacts | null, installed: readonly string[] | null = []) {
	return chooseModels(facts, OLLAMA_CATALOG, installed).choices.map(choice => [choice.tag, choice.tiers] as const);
}

describe("OLLAMA_CATALOG", () => {
	it("is ordered smallest first with unique tags", () => {
		const sizes = OLLAMA_CATALOG.map(entry => entry.sizeBytes);
		expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
		expect(new Set(OLLAMA_CATALOG.map(entry => entry.tag)).size).toBe(OLLAMA_CATALOG.length);
	});

	it("estimates need as weights with overhead plus the KV cache", () => {
		const entry = { tag: "x", label: "X", params: 1, sizeBytes: 1e9, contextTokens: 1000 };
		expect(needBytes(entry)).toBe(1.2e9 + 1000 * 163_840);
	});
});

describe("fitOf / speedOf", () => {
	it("classes a discrete GPU as vram, then offload, then no fit", () => {
		const facts = machine({ ramBytes: 10e9, vramBytes: 4e9 });
		expect(fitOf(4e9, facts)).toBe("vram");
		expect(fitOf(10e9, facts)).toBe("offload");
		expect(fitOf(10.1e9, facts)).toBeNull();
	});

	it("classes a GPU-less machine against 60% of RAM", () => {
		const facts = machine({ ramBytes: 10e9 });
		expect(fitOf(6e9, facts)).toBe("ram");
		expect(fitOf(6.1e9, facts)).toBeNull();
	});

	it("lets unified memory use 75% of RAM as GPU memory", () => {
		const facts = machine({ ramBytes: 10e9, unifiedMemory: true });
		expect(fitOf(7.5e9, facts)).toBe("vram");
		expect(fitOf(7.6e9, facts)).toBeNull();
	});

	it("rates speed by where the model runs and, on CPU, by its size", () => {
		expect(speedOf("vram", 30)).toBe("fast");
		expect(speedOf("offload", 30)).toBe("moderate");
		expect(speedOf("ram", 8)).toBe("moderate");
		expect(speedOf("ram", 14)).toBe("slow");
	});
});

describe("chooseModels", () => {
	const all: ModelTier[] = ["minimal", "recommended", "maximum"];

	it.each([
		{
			name: "8 GB RAM, no GPU: only 4b, every tier merged",
			facts: machine({ ramBytes: 8 * GiB }),
			expected: [["qwen3:4b", all]],
		},
		{
			name: "16 GB RAM + 12 GB VRAM: 4b / 14b / 20b",
			facts: machine({ ramBytes: 16 * GiB, vramBytes: 12 * GiB, gpuName: "RTX 4070" }),
			expected: [
				["qwen3:4b", ["minimal"]],
				["qwen3:14b", ["recommended"]],
				["gpt-oss:20b", ["maximum"]],
			],
		},
		{
			name: "32 GB unified Mac: 4b, and 30b recommended + maximum",
			facts: machine({ ramBytes: 32 * GiB, gpuName: "Apple M2 Pro", unifiedMemory: true }),
			expected: [
				["qwen3:4b", ["minimal"]],
				["qwen3:30b", ["recommended", "maximum"]],
			],
		},
	])("$name", ({ facts, expected }) => {
		expect(cards(facts)).toEqual(expected);
	});

	it("reports the fit and speed each card was sized with", () => {
		const screen = chooseModels(machine({ ramBytes: 16 * GiB, vramBytes: 12 * GiB }), OLLAMA_CATALOG, []);
		expect(screen.choices.map(choice => [choice.fit, choice.speed])).toEqual([
			["vram", "fast"],
			["vram", "fast"],
			["offload", "moderate"],
		]);
		expect(screen.emptyReason).toBeUndefined();
	});

	it("falls back to the largest non-slow model when nothing fits GPU memory", () => {
		// 32 GB, no GPU: 60% = 20.6e9 admits up to gpt-oss:20b, but 14B+ on CPU is slow.
		expect(cards(machine({ ramBytes: 32 * GiB }))).toEqual([
			["qwen3:4b", ["minimal"]],
			["qwen3:8b", ["recommended"]],
			["gpt-oss:20b", ["maximum"]],
		]);
	});

	it("says the machine is unreadable when there are no facts", () => {
		expect(chooseModels(null, OLLAMA_CATALOG, [])).toEqual({ machine: null, choices: [], emptyReason: "unreadable" });
		expect(chooseModels(machine({ ramBytes: 0 }), OLLAMA_CATALOG, []).emptyReason).toBe("unreadable");
	});

	it("says the machine is too small when nothing fits", () => {
		const facts = machine({ ramBytes: 4 * GiB });
		expect(chooseModels(facts, OLLAMA_CATALOG, [])).toEqual({
			machine: facts,
			choices: [],
			emptyReason: "too-small",
		});
	});

	it("marks installed cards, and leaves install state unknown when Ollama did not answer", () => {
		const facts = machine({ ramBytes: 16 * GiB, vramBytes: 12 * GiB });
		const known = chooseModels(facts, OLLAMA_CATALOG, ["qwen3:14b", "llama3:8b"]).choices;
		expect(known.map(choice => choice.installed)).toEqual([false, true, false]);
		const unknown = chooseModels(facts, OLLAMA_CATALOG, null).choices;
		expect(unknown.map(choice => choice.installed)).toEqual([null, null, null]);
	});
});
