import { afterEach, describe, expect, it } from "vitest";
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
import { useToastStore } from "./toast";

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

describe("model store local-only guard", () => {
	const local: ModelInfo = { provider: "ollama", id: "gemma4:e4b" };
	const other: ModelInfo = { provider: "ollama", id: "qwen3:8b" };

	/** A sidecar whose set_model answers with the model it was asked for, or fails. */
	function sidecar(options: { fail?: boolean; hold?: boolean } = {}) {
		const calls: RpcCommand[] = [];
		const held = Promise.withResolvers<void>();
		const command = async (request: RpcCommand): Promise<RpcResponse> => {
			calls.push(request);
			if (options.hold) await held.promise;
			if (request.type !== "set_model") return { type: "response", command: request.type, success: true };
			if (options.fail) return { type: "response", command: "set_model", success: false, error: "no such model" };
			return {
				type: "response",
				command: "set_model",
				success: true,
				data: { provider: request.provider, id: request.modelId },
			};
		};
		return { calls, command, release: () => held.resolve() };
	}

	const warnings = () => useToastStore.getState().toasts.filter(toast => toast.variant === "warning");

	afterEach(() => {
		useToastStore.setState({ toasts: [] });
	});

	it("leaves a local session model alone", async () => {
		const { calls, command } = sidecar();
		const store = createModelStore(command);
		store.setState({ model: local });

		await store.getState().enforceLocalModel();

		expect(calls).toEqual([]);
		expect(warnings()).toEqual([]);
		expect(store.getState().model).toEqual(local);
	});

	it.each([
		["an online provider", { provider: "anthropic", id: "claude-sonnet-4-5" }],
		["an Ollama cloud tag", { provider: "ollama", id: "kimi-k2:cloud" }],
	])("refuses %s and switches back to the last local model", async (_label, refused) => {
		const { calls, command } = sidecar();
		const store = createModelStore(command);
		store.setState({ model: local, availableModels: [other, local] });
		await store.getState().enforceLocalModel();
		store.setState({ model: refused as ModelInfo });

		await store.getState().enforceLocalModel();

		expect(calls).toEqual([{ type: "set_model", provider: "ollama", modelId: "gemma4:e4b" }]);
		expect(store.getState().model).toEqual(local);
		expect(warnings()).toHaveLength(1);
	});

	it("falls back to the first local catalog model when the session never had one", async () => {
		const { calls, command } = sidecar();
		const store = createModelStore(command);
		store.setState({
			model: { provider: "openai", id: "gpt-4" },
			availableModels: [{ provider: "ollama", id: "kimi-k2:cloud" }, other, local],
		});

		await store.getState().enforceLocalModel();

		expect(calls).toEqual([{ type: "set_model", provider: "ollama", modelId: "qwen3:8b" }]);
		expect(store.getState().model).toEqual(other);
	});

	it("shows the refusal without a switch when no local model exists", async () => {
		const { calls, command } = sidecar();
		const store = createModelStore(command);
		store.setState({ model: { provider: "openai", id: "gpt-4" }, availableModels: [] });

		await store.getState().enforceLocalModel();

		expect(calls).toEqual([]);
		expect(warnings()).toHaveLength(1);
	});

	it("reports a failed switch back as an error", async () => {
		const { command } = sidecar({ fail: true });
		const store = createModelStore(command);
		store.setState({ model: { provider: "openai", id: "gpt-4" }, availableModels: [local] });

		await store.getState().enforceLocalModel();

		expect(warnings()).toHaveLength(1);
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "error")).toBe(true);
	});

	it("switches back once while a refusal is in flight", async () => {
		const { calls, command, release } = sidecar({ hold: true });
		const store = createModelStore(command);
		store.setState({ model: local });
		await store.getState().enforceLocalModel();
		store.setState({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } });

		const first = store.getState().enforceLocalModel();
		const second = store.getState().enforceLocalModel();
		release();
		await Promise.all([first, second]);

		expect(calls).toHaveLength(1);
		expect(warnings()).toHaveLength(1);
		expect(store.getState().model).toEqual(local);
	});
});
