/**
 * The `^selector` model-delegation menu: when the store has no models yet it
 * reads the agent catalog itself, and that read must offer only the providers
 * the GUI allows, exactly like the store.
 */
import { parseHTML } from "linkedom";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { type CompletionMenu, useCompletionMenu } from "./use-completion-menu";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
Object.assign(window as unknown as Record<string, unknown>, { setTimeout, clearTimeout });

function model(provider: string, id: string): ModelInfo {
	return { provider, id, name: id } as ModelInfo;
}

function Probe({ text, onMenu }: { text: string; onMenu: (menu: CompletionMenu | null) => void }) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	useCompletionMenu({
		text,
		filePaths: [],
		commands: [],
		emojiAutocomplete: false,
		tabKind: "agent",
		textareaRef,
		setMenu: onMenu,
	});
	return (
		<textarea
			readOnly
			ref={element => {
				textareaRef.current = element;
				// linkedom has no caret; put it at the end of the draft.
				if (element) Object.assign(element, { selectionStart: text.length, selectionEnd: text.length });
			}}
			value={text}
		/>
	);
}

let container: InstanceType<typeof HTMLElement> | null = null;
let root: Root | null = null;

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	container = null;
	root = null;
	useModelStore.getState().reset();
});

describe("useCompletionMenu model delegation", () => {
	it("offers only allowed providers from the direct catalog read", async () => {
		const getAvailableModels = vi.fn(
			async () =>
				({
					type: "response",
					command: "get_available_models",
					success: true,
					data: {
						models: [model("anthropic", "claude-opus"), model("ollama", "qwen3:8b"), model("openai", "gpt-5")],
						discoveryStates: [],
						refreshPending: false,
						generation: 1,
					},
				}) as RpcResponse,
		);
		(window as unknown as { omp: unknown }).omp = { rpc: { getAvailableModels } };
		const menus: (CompletionMenu | null)[] = [];

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<Probe onMenu={menu => menus.push(menu)} text="review ^" />
				</I18nProvider>,
			);
		});
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
		});

		expect(useModelStore.getState().availableModels).toEqual([]);
		expect(getAvailableModels).toHaveBeenCalledWith(true);
		const last = menus.at(-1);
		expect(last?.source).toBe("model");
		expect(last?.items.map(item => item.label)).toEqual(["^ollama/qwen3:8b"]);
	});
});
