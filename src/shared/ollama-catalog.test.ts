import { describe, expect, it } from "vitest";
import { chooseModels, fitOf, isInstalled, needBytes, OLLAMA_CATALOG, speedOf } from "./ollama-catalog";
import type { MachineFacts, ModelTier } from "./ollama-types";

const GiB = 1024 ** 3;

const E2B = "hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf";
const E4B = "hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf";
const A4B = "hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf";

function machine(overrides: Partial<MachineFacts>): MachineFacts {
	return { ramBytes: 16 * GiB, vramBytes: null, gpuName: null, unifiedMemory: false, threads: 8, ...overrides };
}

function cards(facts: MachineFacts | null, installed: readonly string[] | null = []) {
	return chooseModels(facts, OLLAMA_CATALOG, installed).choices.map(
		choice => [choice.tag, choice.tiers, choice.speed] as const,
	);
}

describe("OLLAMA_CATALOG", () => {
	it("holds the three Gemma 4 rows, smallest first, with bare unique refs", () => {
		expect(OLLAMA_CATALOG.map(entry => entry.tag)).toEqual([E2B, E4B, A4B]);
		const sizes = OLLAMA_CATALOG.map(entry => entry.sizeBytes);
		expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
		expect(OLLAMA_CATALOG.every(entry => !entry.tag.includes(":"))).toBe(true);
	});

	it("estimates need as the file at 102% plus the fixed 4.25 GiB, rounded up", () => {
		expect(needBytes(1_000_000_000)).toBe(5_583_402_752);
		expect(needBytes(100)).toBe(102 + 4_563_402_752);
		expect(needBytes(101)).toBe(104 + 4_563_402_752);
		expect(needBytes(3_349_516_256)).toBe(7_979_909_334);
	});
});

describe("fitOf / speedOf", () => {
	it("holds back a quarter of RAM, never less than 4 GiB", () => {
		expect(fitOf(4 * GiB, machine({ ramBytes: 8 * GiB }))).toBe("ram");
		expect(fitOf(4 * GiB + 1, machine({ ramBytes: 8 * GiB }))).toBeNull();
		expect(fitOf(48 * GiB, machine({ ramBytes: 64 * GiB }))).toBe("ram");
		expect(fitOf(48 * GiB + 1, machine({ ramBytes: 64 * GiB }))).toBeNull();
	});

	it("classes a GPU as vram within its budget, then offload against RAM alone, never the sum", () => {
		const facts = machine({ ramBytes: 16 * GiB, vramBytes: 12 * GiB });
		expect(fitOf(11 * GiB, facts)).toBe("vram");
		expect(fitOf(11 * GiB + 1, facts)).toBe("offload");
		expect(fitOf(12 * GiB, facts)).toBe("offload");
		expect(fitOf(12 * GiB + 1, facts)).toBeNull();
	});

	it("treats a GPU at or under the 1 GiB reserve as no GPU", () => {
		expect(fitOf(GiB, machine({ vramBytes: GiB }))).toBe("ram");
	});

	it("gives unified memory no graphics budget", () => {
		expect(fitOf(GiB, machine({ unifiedMemory: true }))).toBe("ram");
	});

	it("rates speed by where it runs, active parameters and threads", () => {
		expect(speedOf("vram", 30, 1)).toBe("fast");
		expect(speedOf("ram", 9.0, 8)).toBe("moderate");
		expect(speedOf("offload", 9.0, 8)).toBe("moderate");
		expect(speedOf("ram", 9.1, 8)).toBe("slow");
		expect(speedOf("ram", 4.5, 7)).toBe("slow");
		expect(speedOf("ram", 4.5, 64)).toBe("moderate");
	});
});

describe("isInstalled", () => {
	it("matches an exact name, or a bare name against any of its tags", () => {
		expect(isInstalled(["gemma-2:9b"], "gemma-2:9b")).toBe(true);
		expect(isInstalled(["gemma4:26b"], "gemma4")).toBe(true);
		expect(isInstalled([`${E4B}:latest`], E4B)).toBe(true);
	});

	it("ignores case on both sides", () => {
		expect(isInstalled(["HF.CO/Google/Gemma-4-E4B-IT-QAT-Q4_0-GGUF:LATEST"], E4B)).toBe(true);
	});

	it("rejects a shared prefix that is not a tag boundary, and a blank request", () => {
		expect(isInstalled(["gemma-2:9b"], "gemma")).toBe(false);
		expect(isInstalled(["gemma-2:9b"], "   ")).toBe(false);
		expect(isInstalled([], "gemma")).toBe(false);
	});
});

describe("chooseModels", () => {
	const both: ModelTier[] = ["recommended", "maximum"];
	const e2b = `${E2B}:latest`;
	const e4b = `${E4B}:latest`;
	const a4b = `${A4B}:latest`;

	it.each([
		{
			name: "16 GiB, no GPU, 8 threads: E2B minimal, E4B recommended + maximum",
			facts: machine({}),
			expected: [
				[e2b, ["minimal"], "moderate"],
				[e4b, both, "moderate"],
			],
		},
		{
			name: "32 GiB, no GPU, 8 threads: E2B minimal, 26B recommended + maximum",
			facts: machine({ ramBytes: 32 * GiB }),
			expected: [
				[e2b, ["minimal"], "moderate"],
				[a4b, both, "moderate"],
			],
		},
		{
			name: "16 GiB + 12 GiB VRAM: E2B minimal, E4B recommended + maximum, fast",
			facts: machine({ vramBytes: 12 * GiB, gpuName: "RTX 4070" }),
			expected: [
				[e2b, ["minimal"], "fast"],
				[e4b, both, "fast"],
			],
		},
		{
			name: "64 GiB + 24 GiB VRAM, 16 threads: E2B minimal, 26B recommended + maximum, fast",
			facts: machine({ ramBytes: 64 * GiB, vramBytes: 24 * GiB, threads: 16 }),
			expected: [
				[e2b, ["minimal"], "fast"],
				[a4b, both, "fast"],
			],
		},
	])("$name", ({ facts, expected }) => {
		const screen = chooseModels(facts, OLLAMA_CATALOG, []);
		expect(cards(facts)).toEqual(expected);
		expect(screen.status).toBe("ok");
		expect(screen.choices.every(choice => !choice.tight)).toBe(true);
	});

	it("omits the recommended card when every fit is slow", () => {
		const screen = chooseModels(machine({ threads: 4 }), OLLAMA_CATALOG, []);
		expect(screen.choices.map(choice => [choice.tag, choice.tiers, choice.speed])).toEqual([
			[e2b, ["minimal"], "slow"],
			[e4b, ["maximum"], "slow"],
		]);
		expect(screen.status).toBe("recommended-omitted");
	});

	it("carries the active parameters and the need of each row", () => {
		const [minimal, top] = chooseModels(machine({}), OLLAMA_CATALOG, []).choices;
		expect([minimal.params, minimal.activeParams, minimal.needBytes]).toEqual([5.1, 2.3, 7_979_909_334]);
		expect([top.params, top.activeParams]).toEqual([8, 4.5]);
	});

	it("offers the smallest row as a tight, slow card when nothing fits but RAM exceeds its download", () => {
		const facts = machine({ ramBytes: 8 * GiB });
		const screen = chooseModels(facts, OLLAMA_CATALOG, []);
		expect(screen.emptyReason).toBeUndefined();
		expect(screen.status).toBe("recommended-omitted");
		expect(screen.choices).toHaveLength(1);
		expect(screen.choices[0]).toMatchObject({
			tag: e2b,
			tiers: ["minimal"],
			fit: "ram",
			speed: "slow",
			tight: true,
			installed: false,
		});
	});

	it("says the machine is too small when RAM does not even hold the smallest download", () => {
		const facts = machine({ ramBytes: 2 * GiB });
		expect(chooseModels(facts, OLLAMA_CATALOG, [])).toEqual({
			machine: facts,
			choices: [],
			emptyReason: "too-small",
		});
	});

	it("says the machine is unreadable when there are no facts", () => {
		expect(chooseModels(null, OLLAMA_CATALOG, [])).toEqual({ machine: null, choices: [], emptyReason: "unreadable" });
		expect(chooseModels(machine({ ramBytes: 0 }), OLLAMA_CATALOG, []).emptyReason).toBe("unreadable");
	});

	it("uses the name Ollama lists for an installed card", () => {
		const listed = "HF.CO/Google/Gemma-4-E4B-IT-QAT-Q4_0-GGUF:LATEST";
		const screen = chooseModels(machine({}), OLLAMA_CATALOG, [`${E4B}:latest`, "gemma-2:9b"]);
		expect(screen.choices.map(choice => [choice.tag, choice.installed])).toEqual([
			[e2b, false],
			[`${E4B}:latest`, true],
		]);
		const mixedCase = chooseModels(machine({}), OLLAMA_CATALOG, [listed]).choices[1];
		expect([mixedCase.tag, mixedCase.installed]).toEqual([listed, true]);
	});

	it("appends :latest to an untagged ref that is not installed, so a fresh pull keeps the same id", () => {
		const screen = chooseModels(machine({}), OLLAMA_CATALOG, ["gemma"]);
		expect(screen.choices.map(choice => [choice.tag, choice.installed])).toEqual([
			[e2b, false],
			[e4b, false],
		]);
		const tagged = [{ ...OLLAMA_CATALOG[0], tag: "gemma3:4b" }];
		expect(chooseModels(machine({}), tagged, []).choices[0].tag).toBe("gemma3:4b");
		expect(OLLAMA_CATALOG[0].tag).toBe(E2B);
	});

	it("leaves install state unknown when Ollama did not answer", () => {
		const screen = chooseModels(machine({}), OLLAMA_CATALOG, null);
		expect(screen.choices.map(choice => [choice.tag, choice.installed])).toEqual([
			[e2b, null],
			[e4b, null],
		]);
	});

	it("breaks a parameter tie by quant rank, then by ref ascending", () => {
		const base = { label: "X", params: 8, activeParams: 4, sizeBytes: GiB };
		const catalog = [
			{ ...base, tag: "b", quantRank: 10 },
			{ ...base, tag: "a", quantRank: 10 },
			{ ...base, tag: "c", quantRank: 20 },
		];
		const screen = chooseModels(machine({}), catalog, []);
		// Equal need, so minimal takes the first row in quality order: the same card as maximum.
		expect(screen.choices.map(choice => [choice.tag, choice.tiers])).toEqual([
			["c:latest", ["minimal", "recommended", "maximum"]],
		]);
		const tied = chooseModels(machine({}), catalog.slice(0, 2), []).choices;
		expect(tied.map(choice => choice.tag)).toEqual(["a:latest"]);
	});

	it("never suggests a row under 3B parameters", () => {
		const catalog = [{ tag: "tiny", label: "Tiny", params: 2.9, activeParams: 2.9, sizeBytes: GiB, quantRank: 10 }];
		// It fits, so the machine is not short of memory: no tight-fit fallback either.
		expect(chooseModels(machine({}), catalog, [])).toMatchObject({ choices: [], emptyReason: "too-small" });
	});
});
