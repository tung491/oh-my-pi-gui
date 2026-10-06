import { describe, expect, it } from "vitest";
import { isCloudTag } from "./ollama-cloud";

describe("isCloudTag", () => {
	it("recognises Ollama cloud tags by name or tag part", () => {
		expect(isCloudTag("gpt-oss:120b-cloud")).toBe(true);
		expect(isCloudTag("kimi-k2:cloud")).toBe(true);
		expect(isCloudTag("x-cloud")).toBe(true);
		expect(isCloudTag("  Kimi-K2:Cloud ")).toBe(true);
	});

	it("keeps local tags, including names that merely contain the word", () => {
		expect(isCloudTag("hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf")).toBe(false);
		expect(isCloudTag("llama3:8b")).toBe(false);
		expect(isCloudTag("cloudy:7b")).toBe(false);
		expect(isCloudTag("hf.co/org/cloud-model:q4")).toBe(false);
	});
});
