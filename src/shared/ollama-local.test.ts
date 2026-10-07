import { describe, expect, it } from "vitest";
import { isLocalOllamaRow, isLoopbackBaseUrl, isOllamaCloudTag } from "./ollama-local";

describe("isOllamaCloudTag", () => {
	it("treats a cloud name or tag part as a cloud tag", () => {
		expect(isOllamaCloudTag("gpt-oss:120b-cloud")).toBe(true);
		expect(isOllamaCloudTag("qwen3-coder:cloud")).toBe(true);
		expect(isOllamaCloudTag("kimi-k2-cloud")).toBe(true);
		expect(isOllamaCloudTag("Deepseek:671B-CLOUD")).toBe(true);
		expect(isOllamaCloudTag("qwen3:4b")).toBe(false);
		expect(isOllamaCloudTag("cloudy:latest")).toBe(false);
		expect(isOllamaCloudTag("hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:latest")).toBe(false);
	});
});

describe("isLocalOllamaRow", () => {
	it("accepts a plain local row", () => {
		expect(isLocalOllamaRow({ name: "qwen3:4b", model: "qwen3:4b", size: 2_500_000_000 })).toBe(true);
		expect(isLocalOllamaRow({ name: "qwen3:4b", remote_host: "" })).toBe(true);
	});

	it("rejects a cloud tag in the name or the model field", () => {
		expect(isLocalOllamaRow({ name: "gpt-oss:120b-cloud" })).toBe(false);
		expect(isLocalOllamaRow({ name: "mine:latest", model: "gpt-oss:120b-cloud" })).toBe(false);
	});

	it("rejects a copy served from a remote host", () => {
		expect(isLocalOllamaRow({ name: "mine:latest", remote_host: "https://ollama.com:443" })).toBe(false);
		expect(isLocalOllamaRow({ name: "mine:latest", remote_model: "gpt-oss:120b" })).toBe(false);
	});
});

describe("isLoopbackBaseUrl", () => {
	it("accepts localhost, 127.0.0.0/8, ::1 and 0.0.0.0", () => {
		for (const url of [
			"http://localhost:11434",
			"http://LOCALHOST:11434",
			"http://127.0.0.1:11434",
			"http://127.1.2.3",
			"http://127.1:11434",
			"http://[::1]:11434",
			"http://0.0.0.0:11434",
		]) {
			expect(isLoopbackBaseUrl(url), url).toBe(true);
		}
	});

	it("rejects other hosts, look-alike names and unparseable URLs", () => {
		for (const url of [
			"http://192.168.1.5:11434",
			"http://10.0.0.1:11434",
			"http://127.0.0.1.example.com:11434",
			"http://localhost.example.com",
			"http://[::2]:11434",
			"https://ollama.com",
			"not a url",
			"",
		]) {
			expect(isLoopbackBaseUrl(url), url).toBe(false);
		}
	});
});
