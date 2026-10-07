/**
 * The context row of one local model: it renders every state `context-list`
 * can report, offers only the allowed limits, sends a cleared cap for the
 * maximum, follows progress only for its own tag, and shows the engine's error
 * text verbatim.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	type ContextFitEntry,
	type ContextFitProgress,
	type ContextFitRow,
	contextLadder,
} from "../../../shared/ollama-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { contextChoices, formatContext, ModelContextRow } from "./ModelContextRow";

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

const TAG = "gemma3:4b";

function entry(overrides: Partial<ContextFitEntry> = {}): ContextFitEntry {
	return {
		maxContext: 65_536,
		trainedContext: 131_072,
		pool: "gpu",
		verdict: "fits",
		measuredAt: "2026-10-07T10:00:00.000Z",
		fingerprint: { ramBytes: 32e9, vramBytes: 12e9, gpuName: "RTX 4070", unifiedMemory: false },
		userCap: null,
		attempts: 0,
		lastError: null,
		lastAttemptAt: "2026-10-07T10:00:00.000Z",
		...overrides,
	};
}

function row(overrides: Partial<ContextFitRow> = {}): ContextFitRow {
	return { tag: TAG, entry: entry(), effective: 65_536, stale: false, envCap: null, state: "idle", ...overrides };
}

let ollama: {
	measureContext: Mock<(tag: string, reason?: string) => Promise<{ queued: true }>>;
	setContextCap: Mock<(tag: string, cap: number | null) => Promise<ContextFitEntry>>;
	onContextProgress: Mock<(callback: (progress: ContextFitProgress) => void) => () => void>;
};
let emitProgress: (progress: ContextFitProgress) => void;
let onRefresh: Mock<() => void>;
let root: Root | null = null;

beforeEach(() => {
	emitProgress = () => {};
	onRefresh = vi.fn();
	ollama = {
		measureContext: vi.fn(async () => ({ queued: true as const })),
		setContextCap: vi.fn(async (_tag: string, cap: number | null) => entry({ userCap: cap })),
		onContextProgress: vi.fn(callback => {
			emitProgress = callback;
			return () => {
				emitProgress = () => {};
			};
		}),
	};
	Object.assign(window as unknown as Record<string, unknown>, { omp: { ollama } });
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
});

async function render(data: ContextFitRow, limitsInactive = false): Promise<void> {
	const element = (
		<I18nProvider>
			<ModelContextRow limitsInactive={limitsInactive} onRefresh={onRefresh} row={data} />
		</I18nProvider>
	);
	if (root) {
		await act(async () => root?.render(element));
		return;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(element));
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

function text(): string {
	return document.body.textContent ?? "";
}

function query<T = Element>(selector: string): T | null {
	return document.body.querySelector(selector) as T | null;
}

function measureButton(): HTMLButtonElement | null {
	return query<HTMLButtonElement>('[data-action="measure-context"]');
}

function options(): { value: string; label: string; disabled: boolean }[] {
	return Array.from(document.body.querySelectorAll("[data-context-select] option")).map(option => ({
		value: option.getAttribute("value") ?? "",
		label: (option.textContent ?? "").trim(),
		disabled: option.hasAttribute("disabled"),
	}));
}

/** Pick a value through React's onChange (linkedom's select has a read-only value and no tracker). */
async function choose(value: string): Promise<void> {
	const select = query<HTMLSelectElement>("[data-context-select]");
	if (!select) throw new Error("context select missing");
	const record = select as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	if (!props?.onChange) throw new Error("context select has no onChange");
	const target = { value };
	await act(async () => props.onChange?.({ target, currentTarget: target }));
	await settle();
}

describe("context helpers", () => {
	it("lists rungs from the floor up to the measured maximum", () => {
		expect(contextLadder(65_536)).toEqual([16_384, 32_768, 65_536]);
		expect(contextLadder(40_000)).toEqual([16_384, 32_768, 40_000]);
		expect(contextLadder(8_192)).toEqual([8_192]);
	});

	it("keeps a stored limit that is not a rung among the choices", () => {
		expect(contextChoices(65_536, null)).toEqual([16_384, 32_768, 65_536]);
		expect(contextChoices(65_536, 20_000)).toEqual([16_384, 20_000, 32_768, 65_536]);
	});

	it("formats contexts in thousands of tokens", () => {
		expect(formatContext(32_768)).toBe("32k");
		expect(formatContext(131_072)).toBe("128k");
		expect(formatContext(40_000)).toBe("39.1k");
		expect(formatContext(512)).toBe("512");
	});
});

describe("ModelContextRow", () => {
	it("offers Measure for a model never measured", async () => {
		await render(row({ entry: null, effective: null }));
		expect(text()).toContain(translate("ollama.context.notMeasured"));
		expect(measureButton()?.textContent?.trim()).toBe(translate("ollama.context.measure"));
		expect(query("[data-context-select]")).toBeNull();
	});

	it("shows the measured maximum, the pool and Measure again", async () => {
		await render(row());
		expect(text()).toContain(translate("ollama.context.of", { max: "64k" }));
		expect(text()).toContain(translate("ollama.context.pool.gpu"));
		expect(measureButton()?.textContent?.trim()).toBe(translate("ollama.context.measureAgain"));
		expect(query<HTMLSelectElement>("[data-context-select]")?.value).toBe("65536");
		for (const gone of [
			"[data-context-stale]",
			"[data-context-slow]",
			"[data-context-envcap]",
			"[data-context-error]",
		]) {
			expect(query(gone)).toBeNull();
		}
	});

	it("says a measurement from other hardware is stale without promising a re-measure", async () => {
		await render(row({ stale: true }));
		expect(query("[data-context-stale]")?.textContent).toBe(translate("ollama.context.stale"));
		expect(translate("ollama.context.stale")).toBe("Measured on different hardware — Measure again");
	});

	it("hides Measure while the model is being measured", async () => {
		await render(row({ state: "running" }));
		expect(query("[data-context-running]")?.textContent).toBe(translate("ollama.context.measuringStart"));
		expect(measureButton()).toBeNull();
	});

	it("shows one waiting line for a queued model", async () => {
		await render(row({ state: "queued" }));
		expect(query("[data-context-queued]")?.textContent).toBe("Queued — runs when no reply is in progress");
		expect(measureButton()).not.toBeNull();
	});

	it("shows the engine error verbatim and offers Try again", async () => {
		// An error string that happens to look like a locale key must not be translated.
		await render(
			row({ entry: entry({ maxContext: null, verdict: null, pool: null, lastError: "ollama.context.label" }) }),
		);
		expect(query("[data-context-error]")?.textContent).toBe("Couldn't measure: ollama.context.label");
		expect(measureButton()?.textContent?.trim()).toBe(translate("ollama.context.tryAgain"));
	});

	it("warns that a model spilling at the floor will be slow", async () => {
		await render(row({ entry: entry({ maxContext: 16_384, verdict: "spills" }) }));
		expect(query("[data-context-slow]")?.textContent).toBe(translate("ollama.context.slow", { floor: "16k" }));
	});

	it("names the shell's OLLAMA_CONTEXT_LENGTH when it caps the model and disables rungs above it", async () => {
		await render(row({ envCap: 32_768, effective: 32_768 }));
		expect(query("[data-context-envcap]")?.textContent).toBe(translate("ollama.context.envCap", { cap: "32k" }));
		expect(options()).toEqual([
			{ value: "16384", label: "16k", disabled: false },
			{ value: "32768", label: "32k", disabled: false },
			{ value: "65536", label: "64k", disabled: true },
		]);
	});

	it("lists only the allowed rungs and sends a lower limit", async () => {
		await render(row());
		expect(options().map(option => option.value)).toEqual(["16384", "32768", "65536"]);
		await choose("32768");
		expect(ollama.setContextCap).toHaveBeenCalledWith(TAG, 32_768);
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
			variant: "success",
			message: `Context for ${TAG} set to 32k. Applies from the next reply.`,
		});
		expect(onRefresh).toHaveBeenCalled();
	});

	it("clears the limit when the maximum is chosen", async () => {
		await render(row({ entry: entry({ userCap: 32_768 }), effective: 32_768 }));
		expect(query<HTMLSelectElement>("[data-context-select]")?.value).toBe("32768");
		await choose("65536");
		expect(ollama.setContextCap).toHaveBeenCalledWith(TAG, null);
	});

	it("reports a refused limit as an error toast", async () => {
		ollama.setContextCap.mockRejectedValue(new Error("out of range"));
		await render(row());
		await choose("16384");
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
			variant: "error",
			message: translate("ollama.context.setFailed", { model: TAG, error: "out of range" }),
		});
	});

	it("disables the limit when a configured ollama provider makes it ineffective", async () => {
		await render(row(), true);
		expect(query<HTMLSelectElement>("[data-context-select]")?.hasAttribute("disabled")).toBe(true);
		expect(measureButton()?.hasAttribute("disabled")).toBe(false);
	});

	it("asks for a manual measurement and re-reads the list", async () => {
		await render(row({ entry: null, effective: null }));
		await act(async () => measureButton()?.click());
		await settle();
		expect(ollama.measureContext).toHaveBeenCalledWith(TAG);
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("follows its own progress and ignores other tags", async () => {
		await render(row({ state: "queued" }));
		await act(async () => emitProgress({ tag: "qwen3:8b", state: "running", numCtx: 32_768 }));
		expect(query("[data-context-running]")).toBeNull();
		expect(query("[data-context-queued]")).not.toBeNull();

		await act(async () => emitProgress({ tag: TAG, state: "running", numCtx: 32_768 }));
		expect(query("[data-context-running]")?.textContent).toBe(translate("ollama.context.measuring", { size: "32k" }));
		expect(measureButton()).toBeNull();

		await act(async () => emitProgress({ tag: TAG, state: "done" }));
		expect(query("[data-context-running]")).toBeNull();
		expect(query("[data-context-queued]")).not.toBeNull();
	});

	it("drops a waiting line once a fresh list says nothing is pending", async () => {
		await render(row());
		await act(async () => emitProgress({ tag: TAG, state: "queued" }));
		expect(query("[data-context-queued]")).not.toBeNull();
		await render(row());
		expect(query("[data-context-queued]")).toBeNull();
	});
});
