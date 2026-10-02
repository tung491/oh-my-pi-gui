import { describe, expect, it } from "vitest";
import { normalizeOllamaHostEnv, ollamaBaseUrl } from "./base-url";

describe("normalizeOllamaHostEnv", () => {
	it.each([
		["127.0.0.1", "http://127.0.0.1:11434"],
		["0.0.0.0:11500", "http://0.0.0.0:11500"],
		[":8080", "http://127.0.0.1:8080"],
		["//gpu-box", "http://gpu-box:11434"],
		["http://gpu-box", "http://gpu-box:11434"],
		["https://ollama.example.com", "https://ollama.example.com"],
		["https://ollama.example.com:8443/", "https://ollama.example.com:8443"],
		["  localhost:11434  ", "http://localhost:11434"],
		["[::1]:11434", "http://[::1]:11434"],
	])("normalises %j to %j", (input, expected) => {
		expect(normalizeOllamaHostEnv(input)).toBe(expected);
	});

	it.each([[undefined], [""], ["   "], ["ftp://host"], ["http://"]])("ignores %j", input => {
		expect(normalizeOllamaHostEnv(input)).toBeUndefined();
	});
});

describe("ollamaBaseUrl", () => {
	it("defaults to the loopback daemon", () => {
		expect(ollamaBaseUrl({})).toBe("http://127.0.0.1:11434");
	});

	it("prefers OLLAMA_BASE_URL over OLLAMA_HOST", () => {
		expect(ollamaBaseUrl({ OLLAMA_BASE_URL: "http://a:1", OLLAMA_HOST: "b:2" })).toBe("http://a:1");
	});

	it("falls back to a normalised OLLAMA_HOST", () => {
		expect(ollamaBaseUrl({ OLLAMA_BASE_URL: "  ", OLLAMA_HOST: "b:2" })).toBe("http://b:2");
	});

	it("drops a path such as /v1 from the base URL", () => {
		expect(ollamaBaseUrl({ OLLAMA_BASE_URL: "http://a:1/v1" })).toBe("http://a:1");
	});

	it("uses the default when OLLAMA_BASE_URL is not a URL", () => {
		expect(ollamaBaseUrl({ OLLAMA_BASE_URL: "not a url" })).toBe("http://127.0.0.1:11434");
	});
});
