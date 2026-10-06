/**
 * Tests for the model/provider-referencing setting dropdown: path
 * classification (which string settings become dropdowns), the closed-state
 * trigger contract (current value shown, unset placeholder, listbox
 * semantics), and the open panel's rules that a provider the catalog reports as
 * disabled cannot be chosen and that only providers the GUI offers are listed.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ProviderInfo, ProvidersResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { useModelStore } from "../../stores/model";
import { ModelValueSelect, settingRefKind } from "./ModelValueSelect";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function provider(id: string, disabled: boolean): ProviderInfo {
	return { id, name: id, authenticated: true, loginAvailable: false, disabled, modelCount: 1 };
}

const DEFAULT_PROVIDERS = [provider("ollama", false), provider("anthropic", false)];
let catalogProviders: ProviderInfo[] = DEFAULT_PROVIDERS;
let catalogModels: ModelInfo[] = [];

const command = vi.fn(
	async (): Promise<RpcResponse> => ({
		type: "response",
		command: "get_providers",
		success: true,
		data: {
			providers: catalogProviders,
			models: catalogModels,
			discoveryStates: [],
			refreshPending: false,
			generation: 1,
		} satisfies ProvidersResult,
	}),
);

Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc: { command } } });

function optionRows(): HTMLButtonElement[] {
	return Array.from(document.body.querySelectorAll("button[role='option']")) as HTMLButtonElement[];
}

function rowFor(value: string): HTMLButtonElement {
	const row = optionRows().find(button => (button.textContent ?? "").includes(value));
	expect(row, `no row for ${value}`).toBeDefined();
	return row as HTMLButtonElement;
}

let root: Root | null = null;

/** Mount the dropdown and open its panel, letting the fetch-on-open settle. */
async function openDropdown(
	props: { kind?: "model" | "provider"; value?: string; onCommit?: (value: string) => void } = {},
): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ModelValueSelect
					kind={props.kind ?? "provider"}
					onCommit={props.onCommit ?? (() => {})}
					value={props.value ?? ""}
				/>
			</I18nProvider>,
		);
	});
	await act(async () => {
		(container.querySelector("button") as HTMLButtonElement).click();
	});
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	command.mockClear();
	catalogProviders = DEFAULT_PROVIDERS;
	catalogModels = [];
});

describe("settingRefKind", () => {
	it("classifies the string-typed model settings from the real schema", () => {
		expect(settingRefKind("providers.webSearchGeminiModel")).toBe("model");
		expect(settingRefKind("mnemopi.llmModel")).toBe("model");
		expect(settingRefKind("mnemopi.embeddingModel")).toBe("model");
	});

	it("matches a bare .model suffix", () => {
		expect(settingRefKind("services.image.model")).toBe("model");
	});

	it("classifies provider id settings", () => {
		expect(settingRefKind("services.searchProvider")).toBe("provider");
	});

	it("leaves unrelated strings and namespaces alone", () => {
		// Plain strings that merely live near models/providers.
		expect(settingRefKind("theme.dark")).toBeNull();
		expect(settingRefKind("stt.language")).toBeNull();
		expect(settingRefKind("searxng.endpoint")).toBeNull();
		expect(settingRefKind("hindsight.bankId")).toBeNull();
		// Plural/nested segments must not match (model.loopGuard.* is a namespace).
		expect(settingRefKind("images.describeForTextModels")).toBeNull();
		expect(settingRefKind("model.loopGuard.enabled")).toBeNull();
		expect(settingRefKind("providers.maxInFlightRequests")).toBeNull();
		// "modelName" ends in Name, not Model.
		expect(settingRefKind("stt.modelName")).toBeNull();
	});
});

describe("ModelValueSelect", () => {
	it("renders the current value on a listbox trigger, not a text input", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="model" onCommit={() => {}} value="google/gemini-2.5-flash" />
			</I18nProvider>,
		);
		expect(html).toContain("google/gemini-2.5-flash");
		expect(html).toContain('aria-haspopup="listbox"');
		expect(html).not.toContain("<input");
	});

	it("renders an unset placeholder when the value is empty", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="provider" onCommit={() => {}} value="" />
			</I18nProvider>,
		);
		expect(html).toContain("(unset)");
	});

	it("renders the dropdown closed without touching window.omp", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="model" onCommit={() => {}} value="" />
			</I18nProvider>,
		);
		expect(html).not.toContain('role="listbox"');
	});

	it("lists only Ollama when the catalog reports other providers too", async () => {
		await openDropdown();

		expect(rowFor("ollama").hasAttribute("disabled")).toBe(false);
		expect(optionRows().some(row => (row.textContent ?? "").includes("anthropic"))).toBe(false);
	});

	it("will not offer a provider the catalog reports as disabled", async () => {
		catalogProviders = [provider("ollama", true)];
		await openDropdown();

		// A disabled provider is listed for recognition only: committing it as a
		// `*Provider` setting value fails at call time, far from this row.
		expect(rowFor("ollama").hasAttribute("disabled")).toBe(true);
		expect(rowFor("ollama").textContent).toContain("(disabled)");
	});

	describe("model settings", () => {
		const LOCAL_MODELS: ModelInfo[] = [
			{ provider: "ollama", id: "gemma4:e4b" },
			{ provider: "ollama", id: "kimi-k2:cloud" },
			{ provider: "ollama", id: "gpt-oss:120b-cloud" },
			{ provider: "anthropic", id: "claude-sonnet-4-5" },
			{ provider: "ollama", id: "qwen3:8b" },
		];

		/** Type into the search box through React's own change handler (linkedom fires no input event React reads). */
		async function search(text: string): Promise<void> {
			const input = document.body.querySelector("input") as unknown as HTMLInputElement & Record<string, unknown>;
			input.value = text;
			const propsKey = Object.getOwnPropertyNames(input).find(key => key.startsWith("__reactProps$"));
			const props = propsKey ? (input[propsKey] as { onChange?: (event: object) => void }) : undefined;
			await act(async () => {
				props?.onChange?.({ target: input });
			});
		}

		function buttonWithText(text: string): HTMLButtonElement | undefined {
			return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(button =>
				(button.textContent ?? "").includes(text),
			);
		}

		it("lists only local Ollama models, never a cloud tag or an online provider", async () => {
			catalogModels = LOCAL_MODELS;
			await openDropdown({ kind: "model" });

			expect(optionRows().map(row => row.textContent)).toEqual(["ollama/gemma4:e4b", "ollama/qwen3:8b"]);
		});

		it.each(["anthropic/claude-sonnet-4-5", "ollama/kimi-k2:cloud", "pi/smol", "gpt-4"])(
			"refuses %s typed as a custom value",
			async typed => {
				catalogModels = LOCAL_MODELS;
				const onCommit = vi.fn();
				await openDropdown({ kind: "model", onCommit });
				await search(typed);

				expect(buttonWithText(typed)).toBeUndefined();
				expect(document.body.textContent).toContain(en["modelValue.localOnly"]);
				expect(onCommit).not.toHaveBeenCalled();
			},
		);

		it("offers a typed local Ollama model as a custom value", async () => {
			catalogModels = LOCAL_MODELS;
			const onCommit = vi.fn();
			await openDropdown({ kind: "model", onCommit });
			await search("ollama/mine:latest");

			const custom = buttonWithText("ollama/mine:latest");
			expect(custom).toBeDefined();
			await act(async () => {
				custom?.click();
			});
			expect(onCommit).toHaveBeenCalledWith("ollama/mine:latest");
		});

		it("shows a saved online model as current but will not keep it selectable", async () => {
			catalogModels = LOCAL_MODELS;
			await openDropdown({ kind: "model", value: "anthropic/claude-sonnet-4-5" });

			expect(rowFor("anthropic/claude-sonnet-4-5").hasAttribute("disabled")).toBe(true);
			expect(buttonWithText(en["modelValue.clear"])).toBeDefined();
		});
	});
});
