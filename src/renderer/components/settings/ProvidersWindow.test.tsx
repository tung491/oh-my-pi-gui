/**
 * The Ollama window behind `openProviders`: it shows the daemon status and the
 * endpoint read-only, makes an installed model the default through set_model,
 * downloads a tag with live progress, treats a held download slot as a notice,
 * resolves remedies by outcome, and offers no sign-in or custom-provider path.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { OllamaRemedyResult, OllamaStatus, PullProgress } from "../../../shared/ollama-types";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { WELCOME_COMPLETED_PREF } from "../dialogs/FirstRunOnboardingDialog";
import { normalizePullTag, ProvidersWindow } from "./ProvidersWindow";

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

function ollamaStatus(overrides: Partial<OllamaStatus> = {}): OllamaStatus {
	return {
		state: "ok",
		baseUrl: "http://127.0.0.1:11434",
		version: "0.12.0",
		modelCount: 2,
		installedTags: ["qwen3:8b", "gemma3:4b"],
		platform: "linux",
		remedy: null,
		...overrides,
	};
}

const STOPPED = ollamaStatus({ state: "stopped", modelCount: 0, installedTags: [], remedy: "linux-start" });

let ollama: {
	status: Mock<() => Promise<OllamaStatus>>;
	pull: Mock<(tag: string) => Promise<PullProgress>>;
	cancelPull: Mock<() => Promise<void>>;
	runRemedy: Mock<(id: string) => Promise<OllamaRemedyResult>>;
	openDownload: Mock<() => Promise<void>>;
	onPullProgress: Mock<(callback: (progress: PullProgress) => void) => () => void>;
};
let rpc: Record<string, Mock>;
let prefs: { get: Mock; set: Mock<(key: string, value: unknown) => Promise<void>> };
let emitProgress: (progress: PullProgress) => void;

const ok = (data?: unknown): RpcResponse => ({ type: "response", command: "x", success: true, data });

beforeEach(() => {
	emitProgress = () => {};
	ollama = {
		status: vi.fn(async () => ollamaStatus()),
		pull: vi.fn(),
		cancelPull: vi.fn(async () => {}),
		runRemedy: vi.fn(),
		openDownload: vi.fn(async () => {}),
		onPullProgress: vi.fn(callback => {
			emitProgress = callback;
			return () => {
				emitProgress = () => {};
			};
		}),
	};
	rpc = {
		setModel: vi.fn(async (_provider: string, id: string) => ok({ provider: "ollama", id })),
		setModelRole: vi.fn(async () => ok()),
		getAvailableModels: vi.fn(async () => ok({ models: [], generation: 1 })),
	};
	prefs = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
	Object.assign(window as unknown as Record<string, unknown>, { omp: { ollama, rpc, prefs } });
});

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.setState({ providersOpen: false, welcomeOpen: false });
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

async function mountOpen(): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	useUiStore.getState().openProviders();
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container as unknown as Element);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ProvidersWindow />
			</I18nProvider>,
		);
	});
	await settle();
}

function text(): string {
	return document.body.textContent ?? "";
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		button => (button.textContent ?? "").trim() === label,
	) as HTMLButtonElement | undefined;
}

function installedRow(tag: string): Element | null {
	return document.body.querySelector(`[data-installed-tag="${tag}"]`) as Element | null;
}

/** Set the controlled tag input and drive its React onChange (linkedom has no value tracker). */
async function typeTag(value: string): Promise<void> {
	const input = document.body.querySelector("form input") as HTMLInputElement | null;
	if (!input) throw new Error("tag input missing");
	input.value = value;
	const record = input as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	if (!props?.onChange) throw new Error("tag input has no onChange");
	await act(async () => props.onChange?.({ target: input, currentTarget: input }));
}

async function submitPull(): Promise<void> {
	const form = document.body.querySelector("form");
	if (!form) throw new Error("pull form missing");
	await act(async () => {
		const event = new Event("submit", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
		form.dispatchEvent(event);
	});
}

describe("normalizePullTag", () => {
	it("accepts an Ollama tag and trims it", () => {
		expect(normalizePullTag("  qwen3:8b ")).toBe("qwen3:8b");
		expect(normalizePullTag("hf.co/org/model:Q4_K_M")).toBe("hf.co/org/model:Q4_K_M");
	});

	it("rejects empty, spaced or option-looking input", () => {
		expect(normalizePullTag("   ")).toBeNull();
		expect(normalizePullTag("qwen3 8b")).toBeNull();
		expect(normalizePullTag("--insecure")).toBeNull();
	});
});

describe("ProvidersWindow (Ollama)", () => {
	it("shows the status row, the read-only endpoint and the installed models, with no provider sign-in", async () => {
		await mountOpen();

		expect(text()).toContain(translate("ollama.settings.title"));
		expect(text()).toContain(translate("welcome.ollama.running", { count: 2 }));
		expect(document.body.querySelector("[data-ollama-endpoint]")?.textContent).toBe("http://127.0.0.1:11434");
		// The endpoint is env-driven like the agent's; nothing here edits it.
		expect(document.body.querySelector("[data-ollama-endpoint]")?.tagName.toLowerCase()).toBe("code");
		expect(installedRow("qwen3:8b")).not.toBeNull();
		expect(installedRow("gemma3:4b")).not.toBeNull();
		for (const gone of ["Login", "Logout", "Add provider", "Edit Config"]) {
			expect(buttonWithLabel(gone)).toBeUndefined();
		}
	});

	it("says there are no local models when Ollama has none", async () => {
		ollama.status.mockResolvedValue(ollamaStatus({ modelCount: 0, installedTags: [] }));
		await mountOpen();
		expect(text()).toContain(translate("ollama.settings.noModels"));
	});

	it("makes an installed model the default for this and new sessions and marks setup done", async () => {
		await mountOpen();

		const row = installedRow("gemma3:4b");
		const use = row?.querySelector('[data-action="use-as-default"]') as HTMLButtonElement | null;
		expect(use?.textContent?.trim()).toBe(translate("ollama.settings.useAsDefault"));
		await act(async () => {
			use?.click();
		});
		await settle();

		expect(rpc.setModel).toHaveBeenCalledWith("ollama", "gemma3:4b");
		expect(rpc.setModelRole).toHaveBeenCalledWith("default", "ollama/gemma3:4b");
		expect(prefs.set).toHaveBeenCalledTimes(1);
		const [key, value] = prefs.set.mock.calls[0] ?? [];
		expect(key).toBe(WELCOME_COMPLETED_PREF);
		expect(Number.isNaN(Date.parse(String(value)))).toBe(false);
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ variant: "success" });
	});

	it("does not mark setup done when the default role is refused", async () => {
		rpc.setModelRole.mockResolvedValue({
			type: "response",
			command: "set_model_role",
			success: false,
			error: "locked",
		});
		await mountOpen();

		await act(async () => {
			(installedRow("qwen3:8b")?.querySelector('[data-action="use-as-default"]') as HTMLButtonElement)?.click();
		});
		await settle();

		expect(prefs.set).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
			variant: "error",
			message: translate("welcome.error.setModel", { tag: "qwen3:8b", error: "locked" }),
		});
	});

	it("still succeeds when the completion marker cannot be written", async () => {
		prefs.set.mockRejectedValue(new Error("disk full"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await mountOpen();

		await act(async () => {
			(installedRow("qwen3:8b")?.querySelector('[data-action="use-as-default"]') as HTMLButtonElement)?.click();
		});
		await settle();

		expect(rpc.setModelRole).toHaveBeenCalledWith("default", "ollama/qwen3:8b");
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ variant: "success" });
		warn.mockRestore();
	});

	it("names the tag when set_model refuses", async () => {
		rpc.setModel.mockResolvedValue({ type: "response", command: "set_model", success: false, error: "nope" });
		await mountOpen();

		await act(async () => {
			(installedRow("qwen3:8b")?.querySelector('[data-action="use-as-default"]') as HTMLButtonElement)?.click();
		});
		await settle();

		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
			variant: "error",
			message: translate("welcome.error.setModel", { tag: "qwen3:8b", error: "nope" }),
		});
	});

	it("does not offer Use as default on the model that already is", async () => {
		useModelStore.setState({ model: { provider: "ollama", id: "qwen3:8b" } });
		await mountOpen();
		expect(installedRow("qwen3:8b")?.querySelector('[data-action="use-as-default"]')).toBeNull();
		expect(installedRow("gemma3:4b")?.querySelector('[data-action="use-as-default"]')).not.toBeNull();
	});

	it("streams a download, ignores frames for other tags, then re-reads the status", async () => {
		const { promise, resolve } = Promise.withResolvers<PullProgress>();
		ollama.pull.mockReturnValue(promise);
		await mountOpen();

		await typeTag("llama3.2:3b");
		await submitPull();
		expect(ollama.pull).toHaveBeenCalledWith("llama3.2:3b");
		expect(text()).toContain(translate("welcome.card.starting"));

		await act(async () => {
			emitProgress({ tag: "other:1b", status: "downloading", completed: 9, total: 10, percent: 90, done: false });
		});
		expect(text()).not.toContain("90%");
		await act(async () => {
			emitProgress({
				tag: "llama3.2:3b",
				status: "downloading",
				completed: 4,
				total: 10,
				percent: 40,
				done: false,
			});
		});
		expect(text()).toContain("downloading · 40%");

		ollama.status.mockResolvedValue(ollamaStatus({ modelCount: 3, installedTags: ["qwen3:8b", "llama3.2:3b"] }));
		const statusCalls = ollama.status.mock.calls.length;
		await act(async () => {
			resolve({ tag: "llama3.2:3b", status: "success", completed: 10, total: 10, percent: 100, done: true });
		});
		await settle();

		expect(ollama.status.mock.calls.length).toBe(statusCalls + 1);
		expect(installedRow("llama3.2:3b")).not.toBeNull();
		expect(document.body.querySelector('[role="progressbar"]')).toBeNull();
		expect(rpc.getAvailableModels).toHaveBeenCalled();
	});

	it("treats a held download slot as a notice, not an error", async () => {
		ollama.pull.mockResolvedValue({
			tag: "llama3.2:3b",
			status: "busy",
			completed: 0,
			total: 0,
			percent: -1,
			done: false,
			error: "Another download is running.",
		});
		await mountOpen();

		await typeTag("llama3.2:3b");
		await submitPull();
		await settle();

		const notice = document.body.querySelector("[data-pull-notice]");
		expect(notice?.textContent).toBe("Another download is running.");
		expect(notice?.getAttribute("role")).toBe("status");
		expect(document.body.querySelector('[role="alert"]')).toBeNull();
		expect(document.body.querySelector('[role="progressbar"]')).toBeNull();
	});

	it("shows a failed download inline", async () => {
		ollama.pull.mockResolvedValue({
			tag: "nope:1b",
			status: "error",
			completed: 0,
			total: 0,
			percent: -1,
			done: false,
			error: "pull model manifest: file does not exist",
		});
		await mountOpen();

		await typeTag("nope:1b");
		await submitPull();
		await settle();

		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("file does not exist");
	});

	it("clears its own progress on cancel and ignores the pull's late answer", async () => {
		const { promise, resolve } = Promise.withResolvers<PullProgress>();
		ollama.pull.mockReturnValue(promise);
		await mountOpen();

		await typeTag("llama3.2:3b");
		await submitPull();
		await act(async () => {
			emitProgress({ tag: "llama3.2:3b", status: "downloading", completed: 1, total: 10, percent: 10, done: false });
		});
		expect(document.body.querySelector('[role="progressbar"]')).not.toBeNull();

		await act(async () => {
			(document.body.querySelector('[data-action="cancel-pull"]') as HTMLButtonElement)?.click();
		});
		expect(ollama.cancelPull).toHaveBeenCalledOnce();
		expect(document.body.querySelector('[role="progressbar"]')).toBeNull();

		await act(async () => {
			resolve({
				tag: "llama3.2:3b",
				status: "",
				completed: 1,
				total: 10,
				percent: 10,
				done: false,
				error: "aborted",
			});
		});
		await settle();
		expect(document.body.querySelector('[role="alert"]')).toBeNull();
	});

	it("applies the fresh status after an applied remedy", async () => {
		ollama.status.mockResolvedValue(STOPPED);
		ollama.runRemedy.mockResolvedValue({ outcome: "applied", status: ollamaStatus() });
		await mountOpen();
		expect(text()).toContain(translate("welcome.ollama.stopped.linux"));

		await act(async () => {
			(document.body.querySelector('[data-action="remedy"]') as HTMLButtonElement)?.click();
		});
		await settle();

		expect(ollama.runRemedy).toHaveBeenCalledWith("linux-start");
		expect(text()).toContain(translate("welcome.ollama.running", { count: 2 }));
	});

	it("leaves the row as it was when the authorization prompt is dismissed", async () => {
		ollama.status.mockResolvedValue(STOPPED);
		ollama.runRemedy.mockResolvedValue({ outcome: "cancelled", status: STOPPED });
		await mountOpen();

		await act(async () => {
			(document.body.querySelector('[data-action="remedy"]') as HTMLButtonElement)?.click();
		});
		await settle();

		expect(text()).toContain(translate("welcome.ollama.stopped.linux"));
		expect(document.body.querySelector("[data-remedy-hint]")).toBeNull();
	});

	it("explains an unavailable or failed remedy inline", async () => {
		ollama.status.mockResolvedValue(STOPPED);
		ollama.runRemedy
			.mockResolvedValueOnce({ outcome: "unavailable", status: STOPPED, fault: "pkexec" })
			.mockResolvedValueOnce({ outcome: "failed", status: STOPPED, fault: "unit not found" });
		await mountOpen();
		const remedy = () => document.body.querySelector('[data-action="remedy"]') as HTMLButtonElement;

		await act(async () => remedy().click());
		await settle();
		expect(document.body.querySelector("[data-remedy-hint]")?.textContent).toBe(
			translate("welcome.ollama.remedyUnavailable"),
		);

		await act(async () => remedy().click());
		await settle();
		expect(document.body.querySelector("[data-remedy-hint]")?.textContent).toBe(
			translate("welcome.ollama.remedyFailed", { error: "unit not found" }),
		);
	});

	it("shows a status probe failure instead of spinning", async () => {
		ollama.status.mockRejectedValue(new Error("ipc closed"));
		await mountOpen();
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("ipc closed");
	});

	it("Run setup again closes the window and opens the welcome screen", async () => {
		await mountOpen();

		await act(async () => {
			buttonWithLabel(translate("ollama.settings.runSetup"))?.click();
		});

		expect(useUiStore.getState().providersOpen).toBe(false);
		expect(useUiStore.getState().welcomeOpen).toBe(true);
	});
});
