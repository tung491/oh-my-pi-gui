/**
 * Ctrl+P / the palette's "Cycle model" step through the store's allowed
 * catalog with set_model, wrapping at both ends, instead of the agent's
 * cycle_model (which also walks providers the GUI does not offer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, RpcResponse } from "../../shared/rpc-types";
import { useModelStore } from "../stores/model";
import { useToastStore } from "../stores/toast";
import { cycleAllowedModel } from "./command-registry";

function model(id: string): ModelInfo {
	return { provider: "ollama", id, name: id } as ModelInfo;
}

const MODELS = [model("qwen3:4b"), model("qwen3:8b"), model("qwen3:14b")];

function okResponse(data?: unknown): RpcResponse {
	return { type: "response", command: "set_model", success: true, data } as RpcResponse;
}

let setModel: ReturnType<typeof vi.fn<(provider: string, modelId: string) => Promise<RpcResponse>>>;

beforeEach(() => {
	setModel = vi.fn(async (_provider: string, modelId: string) => okResponse(model(modelId)));
	useModelStore.setState({ availableModels: MODELS, model: MODELS[1] });
});

afterEach(() => {
	useModelStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("cycleAllowedModel", () => {
	it("moves to the next model, and back to the previous one", async () => {
		await cycleAllowedModel({ setModel });
		expect(setModel).toHaveBeenLastCalledWith("ollama", "qwen3:14b");
		useModelStore.setState({ model: MODELS[1] });
		await cycleAllowedModel({ setModel }, "backward");
		expect(setModel).toHaveBeenLastCalledWith("ollama", "qwen3:4b");
	});

	it("wraps at both ends", async () => {
		useModelStore.setState({ model: MODELS[2] });
		await cycleAllowedModel({ setModel });
		expect(setModel).toHaveBeenLastCalledWith("ollama", "qwen3:4b");
		useModelStore.setState({ model: MODELS[0] });
		await cycleAllowedModel({ setModel }, "backward");
		expect(setModel).toHaveBeenLastCalledWith("ollama", "qwen3:14b");
	});

	it("starts from the list when the current model is not in it", async () => {
		useModelStore.setState({ model: { provider: "anthropic", id: "claude-opus", name: "Claude" } as ModelInfo });
		await cycleAllowedModel({ setModel });
		expect(setModel).toHaveBeenLastCalledWith("ollama", "qwen3:4b");
	});

	it("does nothing with no other model to move to", async () => {
		useModelStore.setState({ availableModels: [] });
		await cycleAllowedModel({ setModel });
		useModelStore.setState({ availableModels: [MODELS[1]] });
		await cycleAllowedModel({ setModel });
		expect(setModel).not.toHaveBeenCalled();
	});

	it("toasts a refused switch", async () => {
		setModel.mockResolvedValue({
			type: "response",
			command: "set_model",
			success: false,
			error: "Model not found: ollama/qwen3:14b",
		} as RpcResponse);
		await cycleAllowedModel({ setModel });
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
			variant: "error",
			message: "Model not found: ollama/qwen3:14b",
		});
	});
});
