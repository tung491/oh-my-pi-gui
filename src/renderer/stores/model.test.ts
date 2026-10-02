import { describe, expect, it } from "vitest";
import type {
	ModelCatalogUpdateFrame,
	ModelInfo,
	ProviderDiscoveryState,
	ProviderInfo,
	ProvidersResult,
	RpcCommand,
	RpcResponse,
} from "../../shared/rpc-types";
import { createModelStore } from "./model";

const models: ModelInfo[] = [
	{ provider: "anthropic", id: "claude-sonnet" },
	{ provider: "ollama", id: "qwen3:8b" },
	{ provider: "openai", id: "gpt-5" },
	{ provider: "ollama", id: "gemma3:4b" },
];

function providerRow(id: string): ProviderInfo {
	return { id, name: id, authenticated: true, loginAvailable: false, disabled: false, modelCount: 1 };
}

function discovery(provider: string): ProviderDiscoveryState {
	return { provider, status: "unavailable", optional: false, stale: false, models: [] };
}

const catalog: ProvidersResult = {
	providers: [providerRow("anthropic"), providerRow("ollama")],
	models,
	discoveryStates: [discovery("openai"), discovery("ollama")],
	refreshPending: false,
	generation: 4,
};

function answering(data: ProvidersResult) {
	const calls: RpcCommand[] = [];
	const command = async (request: RpcCommand): Promise<RpcResponse> => {
		calls.push(request);
		return { type: "response", command: request.type, success: true, data };
	};
	return { calls, command };
}

const ids = (list: readonly { provider: string; id: string }[]) => list.map(model => `${model.provider}/${model.id}`);

describe("model store catalog", () => {
	it("keeps only Ollama models from a get_available_models read, in order", async () => {
		const { command } = answering(catalog);
		const store = createModelStore(command);

		const result = await store.getState().refreshAvailableModels();

		expect(ids(store.getState().availableModels)).toEqual(["ollama/qwen3:8b", "ollama/gemma3:4b"]);
		// Callers that read the return value see the same list as the store.
		expect(ids(result.models)).toEqual(["ollama/qwen3:8b", "ollama/gemma3:4b"]);
	});

	it("keeps only the Ollama provider row and its discovery state from a get_providers read", async () => {
		const { command } = answering(catalog);
		const store = createModelStore(command);

		const result = await store.getState().refreshProviders(true);

		expect(store.getState().providers.map(row => row.id)).toEqual(["ollama"]);
		expect(result.providers.map(row => row.id)).toEqual(["ollama"]);
		expect(store.getState().discoveryStates.map(state => state.provider)).toEqual(["ollama"]);
	});

	it("filters a catalog push the same way as a read", () => {
		const store = createModelStore(answering(catalog).command);

		store.getState().applyCatalogUpdate({ type: "model_catalog_update", ...catalog } as ModelCatalogUpdateFrame);

		expect(ids(store.getState().availableModels)).toEqual(["ollama/qwen3:8b", "ollama/gemma3:4b"]);
		expect(store.getState().providers.map(row => row.id)).toEqual(["ollama"]);
		expect(store.getState().catalogGeneration).toBe(4);
	});
});
