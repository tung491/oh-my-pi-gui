import { describe, expect, it } from "vitest";
import { isCloudTag, isLocalModel } from "./ollama-cloud";

describe("isCloudTag", () => {
	it("recognises Ollama cloud tags by name or tag part", () => {
		expect(isCloudTag("gpt-oss:120b-cloud")).toBe(true);
		expect(isCloudTag("kimi-k2:cloud")).toBe(true);
		expect(isCloudTag("x-cloud")).toBe(true);
		expect(isCloudTag("  Kimi-K2:Cloud ")).toBe(true);
	});

	it("recognises a cloud tag behind a thinking-level suffix or a provider prefix", () => {
		expect(isCloudTag("kimi-k2:cloud:low")).toBe(true);
		expect(isCloudTag("gpt-oss:120b-cloud:high")).toBe(true);
		expect(isCloudTag("ollama/kimi-k2:cloud")).toBe(true);
		expect(isCloudTag("llama3:8b:high")).toBe(false);
	});

	it("keeps local tags, including names that merely contain the word", () => {
		expect(isCloudTag("hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf")).toBe(false);
		expect(isCloudTag("llama3:8b")).toBe(false);
		expect(isCloudTag("cloudy:7b")).toBe(false);
		expect(isCloudTag("hf.co/org/cloud-model:q4")).toBe(false);
	});
});

describe("isLocalModel", () => {
	it("accepts only Ollama models that are not cloud tags", () => {
		expect(isLocalModel({ provider: "ollama", id: "gemma4:e4b" })).toBe(true);
		expect(isLocalModel({ provider: "ollama", id: "hf.co/org/cloud-model:q4" })).toBe(true);
		expect(isLocalModel({ provider: "ollama", id: "kimi-k2:cloud" })).toBe(false);
		expect(isLocalModel({ provider: "ollama", id: "gpt-oss:120b-cloud" })).toBe(false);
		expect(isLocalModel({ provider: "anthropic", id: "claude-sonnet-4-5" })).toBe(false);
		expect(isLocalModel({ provider: "openai", id: "gpt-4" })).toBe(false);
		expect(isLocalModel({ provider: "ollama-cloud", id: "llama3:8b" })).toBe(false);
	});
});
