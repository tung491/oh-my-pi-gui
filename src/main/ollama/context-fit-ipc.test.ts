import { describe, expect, it } from "vitest";
import { parseEnvCap, parseMeasureRequest, parseSetCapRequest } from "./context-fit-scheduler";

describe("context fit IPC inputs", () => {
	it("accepts a manual or pulled measure request and defaults to manual", () => {
		expect(parseMeasureRequest({ tag: "qwen3:8b" })).toEqual({ tag: "qwen3:8b", reason: "manual" });
		expect(parseMeasureRequest({ tag: "qwen3", reason: "pulled" })).toEqual({ tag: "qwen3", reason: "pulled" });
	});

	it("refuses the internal stale reason and malformed measure requests", () => {
		for (const payload of [
			{ tag: "qwen3:8b", reason: "stale" },
			{ tag: "qwen3:8b", reason: 1 },
			{ tag: 4 },
			null,
			"x",
		]) {
			expect(() => parseMeasureRequest(payload), JSON.stringify(payload)).toThrow();
		}
	});

	it("requires a tag and an explicit cap on a set-cap request", () => {
		expect(parseSetCapRequest({ tag: "qwen3:8b", cap: null })).toEqual({ tag: "qwen3:8b", cap: null });
		expect(parseSetCapRequest({ tag: "qwen3:8b", cap: 32_768 })).toEqual({ tag: "qwen3:8b", cap: 32_768 });
		for (const payload of [{ tag: "qwen3:8b" }, { cap: 1 }, null, []]) {
			expect(() => parseSetCapRequest(payload), JSON.stringify(payload)).toThrow();
		}
	});

	it("reads a positive integer OLLAMA_CONTEXT_LENGTH and ignores anything else", () => {
		expect(parseEnvCap("8192")).toBe(8_192);
		expect(parseEnvCap(" 32768 ")).toBe(32_768);
		for (const value of [undefined, "", "0", "-1", "8k", "1.5", "99999999999999999999"]) {
			expect(parseEnvCap(value), String(value)).toBeNull();
		}
	});
});
