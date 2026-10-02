import { describe, expect, it } from "vitest";
import {
	ALLOWED_PROVIDER_IDS,
	filterAllowedModels,
	HIDDEN_ACCOUNT_COMMANDS,
	isAllowedProvider,
} from "./provider-policy";

describe("provider policy", () => {
	it("allows only Ollama", () => {
		expect(ALLOWED_PROVIDER_IDS).toEqual(["ollama"]);
		expect(isAllowedProvider("ollama")).toBe(true);
		expect(isAllowedProvider("anthropic")).toBe(false);
		expect(isAllowedProvider("Ollama")).toBe(false);
		expect(isAllowedProvider("")).toBe(false);
	});

	it("filters models to allowed providers in their original order", () => {
		const models = [
			{ provider: "ollama", id: "qwen3:8b" },
			{ provider: "openai", id: "gpt-5" },
			{ provider: "ollama", id: "gpt-oss:20b" },
			{ provider: "my-custom", id: "local" },
		];
		expect(filterAllowedModels(models).map(model => model.id)).toEqual(["qwen3:8b", "gpt-oss:20b"]);
		expect(filterAllowedModels([])).toEqual([]);
	});

	it("hides exactly the account sign-in commands", () => {
		expect([...HIDDEN_ACCOUNT_COMMANDS].sort()).toEqual(["login", "logout"]);
	});
});
