import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type {
	ModelChoice,
	ModelScreen,
	OllamaInstallProgress,
	OllamaRemedyId,
	OllamaRemedyResult,
	OllamaStatus,
	PullProgress,
} from "../../../shared/ollama-types";
import type { ProviderInfo, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Modal } from "../common";
import {
	defaultPick,
	FirstRunOnboardingDialog,
	hasUsableModelProvider,
	WELCOME_COMPLETED_PREF,
} from "./FirstRunOnboardingDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

type Rpc = Mock<(...args: never[]) => Promise<RpcResponse>>;

interface FakeOllama {
	status: Mock<() => Promise<OllamaStatus>>;
	modelScreen: Mock<() => Promise<ModelScreen>>;
	pull: Mock<(tag: string) => Promise<PullProgress>>;
	cancelPull: Mock<() => Promise<void>>;
	warm: Mock<(tag: string) => Promise<void>>;
	runRemedy: Mock<(id: OllamaRemedyId) => Promise<OllamaRemedyResult>>;
	openDownload: Mock<() => Promise<void>>;
	onPullProgress: Mock<(callback: (progress: PullProgress) => void) => () => void>;
	onInstallProgress: Mock<(callback: (progress: OllamaInstallProgress) => void) => () => void>;
	/** Push a progress frame as main would. */
	emit: (frame: PullProgress) => void;
	/** Push an install progress frame as main would. */
	emitInstall: (frame: OllamaInstallProgress) => void;
	/** Settle the pull currently awaited by the screen. */
	finishPull: (frame: PullProgress) => void;
}

interface FakeOmp {
	rpc: {
		getProviders: Rpc;
		getState: Rpc;
		getAvailableModels: Mock<(forceRefresh?: boolean) => Promise<RpcResponse>>;
		setModel: Mock<(provider: string, modelId: string) => Promise<RpcResponse>>;
		setModelRole: Mock<(role: string, modelId: string | null) => Promise<RpcResponse>>;
	};
	models: { listProviders: Mock<() => Promise<CustomProviderView[]>> };
	prefs: {
		get: Mock<(key?: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
	ollama: FakeOllama;
}

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data } as RpcResponse;
}

function status(overrides: Partial<OllamaStatus> = {}): OllamaStatus {
	return {
		state: "ok",
		baseUrl: "http://127.0.0.1:11434",
		modelCount: 1,
		installedTags: ["qwen3:8b"],
		platform: "linux",
		remedy: null,
		...overrides,
	};
}

function choice(overrides: Partial<ModelChoice> & { tag: string }): ModelChoice {
	return {
		label: overrides.tag,
		params: 8,
		activeParams: 8,
		sizeBytes: 5.2e9,
		needBytes: 7.6e9,
		fit: "vram",
		speed: "fast",
		tiers: ["recommended"],
		installed: false,
		tight: false,
		...overrides,
	};
}

function modelScreen(choices: ModelChoice[]): ModelScreen {
	return {
		machine: { ramBytes: 32e9, vramBytes: 12e9, gpuName: "RTX 4070", unifiedMemory: false, threads: 8 },
		choices,
	};
}

const DEFAULT_CHOICES = [
	choice({ tag: "qwen3:4b", tiers: ["minimal"], installed: false }),
	choice({ tag: "qwen3:8b", tiers: ["recommended"], installed: true }),
	choice({ tag: "qwen3:14b", tiers: ["maximum"], installed: false }),
];

interface FakeOptions {
	statuses?: OllamaStatus[];
	screens?: ModelScreen[];
	completed?: string | null;
	providers?: ProviderInfo[];
}

/** A scripted `window.omp`: each status/modelScreen call takes the next entry, repeating the last. */
function installFakeOmp(options: FakeOptions = {}): FakeOmp {
	const statuses = [...(options.statuses ?? [status()])];
	const screens = [...(options.screens ?? [modelScreen(DEFAULT_CHOICES)])];
	const next = <T,>(queue: T[]): T => (queue.length > 1 ? (queue.shift() as T) : queue[0]);
	const listeners = new Set<(progress: PullProgress) => void>();
	const installListeners = new Set<(progress: OllamaInstallProgress) => void>();
	let pending: PromiseWithResolvers<PullProgress> | null = null;

	const ollama: FakeOllama = {
		status: vi.fn(async () => next(statuses)),
		modelScreen: vi.fn(async () => next(screens)),
		pull: vi.fn(() => {
			pending = Promise.withResolvers<PullProgress>();
			return pending.promise;
		}),
		cancelPull: vi.fn(async () => {}),
		warm: vi.fn(async () => {}),
		runRemedy: vi.fn(async () => ({ outcome: "applied", status: status() }) as OllamaRemedyResult),
		openDownload: vi.fn(async () => {}),
		onPullProgress: vi.fn(callback => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		}),
		onInstallProgress: vi.fn(callback => {
			installListeners.add(callback);
			return () => installListeners.delete(callback);
		}),
		emit: frame => {
			for (const listener of listeners) listener(frame);
		},
		emitInstall: frame => {
			for (const listener of installListeners) listener(frame);
		},
		finishPull: frame => pending?.resolve(frame),
	};
	const omp: FakeOmp = {
		rpc: {
			getProviders: vi.fn(async () => ok("get_providers", { providers: options.providers ?? [] })),
			getState: vi.fn(async () => ok("get_state", { model: null })),
			getAvailableModels: vi.fn(async () =>
				ok("get_available_models", { models: [], discoveryStates: [], refreshPending: false, generation: 1 }),
			),
			setModel: vi.fn(async () => ok("set_model")),
			setModelRole: vi.fn(async () => ok("set_model_role")),
		},
		models: { listProviders: vi.fn(async () => []) },
		prefs: { get: vi.fn(async () => options.completed ?? null), set: vi.fn(async () => {}) },
		ollama,
	};
	(window as unknown as { omp: FakeOmp }).omp = omp;
	return omp;
}

let container: InstanceType<typeof HTMLElement> | null = null;
let root: Root | null = null;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement = <FirstRunOnboardingDialog />): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

/** Mount with the sidecar ready, so the startup gate runs. */
async function mountReady(element?: ReactElement): Promise<void> {
	useSessionStore.getState().setStatus("ready", "/tmp/project");
	await mount(element);
	await flush();
}

/** A click event React can dispatch: linkedom's Event has a getter-only eventPhase React writes to. */
function clickEvent(): InstanceType<typeof Event> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	return event;
}

async function click(element: Element | null): Promise<void> {
	if (!element) throw new Error("nothing to click");
	await act(async () => {
		element.dispatchEvent(clickEvent());
	});
	await flush();
}

function dialog(): Element | null {
	return document.querySelector('[role="dialog"]');
}

function action(name: string, scope: ParentNode = document): HTMLButtonElement | null {
	return scope.querySelector(`[data-action="${name}"]`) as HTMLButtonElement | null;
}

function card(tag: string): Element {
	const found = document.querySelector(`article[data-tag="${tag}"]`);
	if (!found) throw new Error(`card not rendered: ${tag}`);
	return found;
}

/** The modal lingers for its exit animation before unmounting. */
async function waitForExit(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 300));
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	container = null;
	root = null;
	useSessionStore.getState().reset();
	useModelStore.getState().reset();
	useUiStore.getState().closeWelcome();
});

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
	return { name: partial.id, authenticated: false, loginAvailable: false, disabled: false, modelCount: 0, ...partial };
}

describe("hasUsableModelProvider", () => {
	it("counts only an enabled Ollama provider with a credential and a model", () => {
		expect(hasUsableModelProvider([], [])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 3 })], [])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "ollama", authenticated: true, modelCount: 0 })], [])).toBe(false);
		expect(
			hasUsableModelProvider([provider({ id: "ollama", authenticated: true, modelCount: 1, disabled: true })], []),
		).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "ollama", authenticated: true, modelCount: 1 })], [])).toBe(true);
	});

	it("accepts a keyless Ollama config only when the agent lists its models", () => {
		const local: CustomProviderView = {
			id: "ollama",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:11434/v1",
			hasApiKey: false,
			auth: "none",
			models: [],
			builtin: false,
		};
		expect(hasUsableModelProvider([provider({ id: "ollama", modelCount: 2 })], [local])).toBe(true);
		expect(hasUsableModelProvider([provider({ id: "ollama", modelCount: 0 })], [local])).toBe(false);
		const other = { ...local, id: "lmstudio" };
		expect(hasUsableModelProvider([provider({ id: "lmstudio", modelCount: 2 })], [other])).toBe(false);
	});
});

describe("defaultPick", () => {
	const choices = [
		choice({ tag: "a", tiers: ["minimal"], installed: true }),
		choice({ tag: "b", tiers: ["recommended"], installed: true }),
		choice({ tag: "c", tiers: ["maximum"], installed: true }),
	];

	it("prefers the current model, then the recommended tier, then the first downloaded", () => {
		expect(defaultPick(choices, "c")).toBe("c");
		expect(defaultPick(choices, null)).toBe("b");
		expect(defaultPick([choices[0], { ...choices[1], installed: false }], null)).toBe("a");
		expect(defaultPick([{ ...choices[1], installed: null }], null)).toBeNull();
	});
});

describe("FirstRunOnboardingDialog", () => {
	it("draws skeletons of the final layout before any data arrives", async () => {
		const omp = installFakeOmp();
		omp.ollama.status.mockReturnValue(new Promise(() => {}));
		omp.ollama.modelScreen.mockReturnValue(new Promise(() => {}));
		await mountReady();
		expect(dialog()).not.toBeNull();
		expect(document.querySelectorAll('[data-skeleton="true"]')).toHaveLength(3);
		expect(document.querySelectorAll(".omp-welcome-facts [data-fact]")).toHaveLength(2);
		expect(document.querySelector('.omp-ollama-row[data-state="loading"]')).not.toBeNull();
	});

	it("continues with the downloaded model: setModel, default role, then the completion pref", async () => {
		const omp = installFakeOmp();
		await mountReady();

		expect(dialog()?.textContent).toContain("Memory: 32.0 GB");
		expect(dialog()?.textContent).toContain("Graphics: RTX 4070, 12.0 GB");
		expect(dialog()?.textContent).toContain("Ollama is running (1 models)");
		expect(card("qwen3:8b").textContent).toContain("On this machine, ready to use");
		expect(card("qwen3:8b").getAttribute("data-picked")).toBe("true");
		expect(omp.ollama.warm).toHaveBeenCalledWith("qwen3:8b");

		const order: string[] = [];
		omp.rpc.getAvailableModels.mockImplementation(async forceRefresh => {
			order.push(`refresh:${forceRefresh}`);
			return ok("get_available_models", { models: [], generation: 2 });
		});
		omp.rpc.setModel.mockImplementation(async () => {
			order.push("setModel");
			return ok("set_model");
		});
		omp.rpc.setModelRole.mockImplementation(async () => {
			order.push("setModelRole");
			return ok("set_model_role");
		});
		omp.prefs.set.mockImplementation(async () => {
			order.push("prefs.set");
		});

		const continueButton = action("continue");
		expect(continueButton?.disabled).toBe(false);
		await click(continueButton);

		expect(omp.rpc.setModel).toHaveBeenCalledWith("ollama", "qwen3:8b");
		expect(omp.rpc.setModelRole).toHaveBeenCalledWith("default", "ollama/qwen3:8b");
		expect(omp.prefs.set).toHaveBeenCalledWith(WELCOME_COMPLETED_PREF, expect.any(String));
		const written = omp.prefs.set.mock.calls[0][1];
		expect(Number.isNaN(Date.parse(String(written)))).toBe(false);
		// A forced catalog read first: the agent only switches to a model it already lists.
		expect(order).toEqual(["refresh:true", "setModel", "setModelRole", "prefs.set"]);
		await waitForExit();
		expect(dialog()).toBeNull();
	});

	it("keeps Continue disabled until a model is on the machine", async () => {
		installFakeOmp({
			screens: [modelScreen(DEFAULT_CHOICES.map(entry => ({ ...entry, installed: false })))],
		});
		await mountReady();
		expect(action("continue")?.disabled).toBe(true);
	});

	it("stays open with an inline error and writes no pref when setModel fails", async () => {
		const omp = installFakeOmp();
		omp.rpc.setModel.mockResolvedValue({
			type: "response",
			command: "set_model",
			success: false,
			error: "model not found",
		} as RpcResponse);
		await mountReady();
		await click(action("continue"));

		expect(document.querySelector('[data-error="continue"]')?.textContent).toBe(
			"Couldn't make qwen3:8b the default model: model not found",
		);
		expect(omp.rpc.setModelRole).not.toHaveBeenCalled();
		expect(omp.prefs.set).not.toHaveBeenCalled();
		await waitForExit();
		expect(dialog()).not.toBeNull();
	});

	it("writes no pref when setModel rejects", async () => {
		const omp = installFakeOmp();
		omp.rpc.setModel.mockRejectedValue(new Error("sidecar gone"));
		await mountReady();
		await click(action("continue"));
		expect(document.querySelector('[data-error="continue"]')?.textContent).toContain("sidecar gone");
		expect(omp.prefs.set).not.toHaveBeenCalled();
	});

	it("does not open once setup was completed", async () => {
		const omp = installFakeOmp({ completed: "2026-10-01T00:00:00.000Z" });
		await mountReady();
		expect(dialog()).toBeNull();
		expect(omp.rpc.getProviders).not.toHaveBeenCalled();
	});

	it("does not open when an Ollama model is already usable", async () => {
		installFakeOmp({ providers: [provider({ id: "ollama", authenticated: true, modelCount: 2 })] });
		await mountReady();
		expect(dialog()).toBeNull();
	});

	it("does not cover a dialog the user opened before the startup check finished", async () => {
		const omp = installFakeOmp();
		const pending = Promise.withResolvers<RpcResponse>();
		omp.rpc.getProviders.mockReturnValue(pending.promise);
		await mountReady(
			<>
				<FirstRunOnboardingDialog />
				<Modal ariaLabel="Settings" onClose={() => {}} open>
					<button type="button">Settings content</button>
				</Modal>
			</>,
		);
		await act(async () => {
			pending.resolve(ok("get_providers", { providers: [] }));
		});
		await flush();
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		expect(dialog()?.getAttribute("aria-label")).toBe("Settings");
	});

	it("installs Ollama on Linux through the remedy id and renders the returned status", async () => {
		const omp = installFakeOmp({
			statuses: [status({ state: "absent", remedy: "linux-install", modelCount: 0, installedTags: [] })],
		});
		omp.ollama.runRemedy.mockResolvedValue({ outcome: "applied", status: status({ modelCount: 0 }) });
		await mountReady();

		expect(document.querySelector(".omp-ollama-command")?.textContent).toBe(
			"curl -fsSL https://ollama.com/install.sh | sh",
		);
		await click(action("remedy"));
		expect(omp.ollama.runRemedy).toHaveBeenCalledWith("linux-install");
		expect(document.querySelector('.omp-ollama-row[data-state="ok"]')?.textContent).toContain(
			"Ollama is running (0 models)",
		);
	});

	it("streams install progress under the row and drops it when the install ends", async () => {
		const absent = status({ state: "absent", remedy: "linux-install", modelCount: 0, installedTags: [] });
		const omp = installFakeOmp({ statuses: [absent] });
		const remedy = Promise.withResolvers<OllamaRemedyResult>();
		omp.ollama.runRemedy.mockReturnValue(remedy.promise);
		await mountReady();
		const bar = () => document.querySelector("[data-install-progress]");
		expect(bar()).toBeNull();

		await click(action("remedy"));
		expect(bar()?.textContent).toContain("Waiting for authorization…");
		expect(bar()?.querySelector('[role="progressbar"]')?.getAttribute("data-indeterminate")).toBe("true");

		await act(async () => omp.ollama.emitInstall({ stage: "Downloading ollama...", percent: 42, done: false }));
		expect(bar()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
		expect(bar()?.textContent).toContain("Downloading ollama...");
		expect(bar()?.textContent).toContain("42%");
		expect(bar()?.querySelector("button")).toBeNull();

		await act(async () => omp.ollama.emitInstall({ stage: "Install complete.", percent: -1, done: true }));
		expect(bar()).toBeNull();

		await act(async () => remedy.resolve({ outcome: "applied", status: status({ modelCount: 0 }) }));
		await flush();
		expect(bar()).toBeNull();
		expect(document.querySelector('.omp-ollama-row[data-state="ok"]')).not.toBeNull();
	});

	it("clears a held install frame when the install call fails", async () => {
		const absent = status({ state: "absent", remedy: "linux-install", modelCount: 0, installedTags: [] });
		const omp = installFakeOmp({ statuses: [absent] });
		const remedy = Promise.withResolvers<OllamaRemedyResult>();
		omp.ollama.runRemedy.mockReturnValue(remedy.promise);
		await mountReady();
		await click(action("remedy"));
		await act(async () => omp.ollama.emitInstall({ stage: "Downloading ollama...", percent: 10, done: false }));
		expect(document.querySelector("[data-install-progress]")).not.toBeNull();

		await act(async () => remedy.reject(new Error("install exited 1")));
		await flush();
		expect(document.querySelector("[data-install-progress]")).toBeNull();
	});

	it("leaves the row untouched when the authorization prompt is dismissed", async () => {
		const stopped = status({ state: "stopped", remedy: "linux-start", modelCount: 0 });
		const omp = installFakeOmp({ statuses: [stopped] });
		omp.ollama.runRemedy.mockResolvedValue({ outcome: "cancelled", status: stopped });
		await mountReady();
		await click(action("remedy"));
		expect(omp.ollama.runRemedy).toHaveBeenCalledWith("linux-start");
		expect(document.querySelector('.omp-ollama-row[data-state="stopped"]')).not.toBeNull();
		expect(document.querySelector('[data-notice="remedy"]')).toBeNull();
	});

	it("keeps the command on screen with a hint when no authorization agent exists", async () => {
		const stopped = status({ state: "stopped", remedy: "linux-start", modelCount: 0 });
		const omp = installFakeOmp({ statuses: [stopped] });
		omp.ollama.runRemedy.mockResolvedValue({ outcome: "unavailable", status: stopped, fault: "pkexec" });
		await mountReady();
		await click(action("remedy"));
		expect(document.querySelector(".omp-ollama-command")?.textContent).toBe("systemctl start ollama.service");
		expect(document.querySelector('[data-notice="remedy"]')?.textContent).toContain(
			"Run the command above in a terminal",
		);
	});

	it("asks for a reopen when this session cannot ask for administrator access", async () => {
		const stopped = status({ state: "stopped", remedy: "linux-start", modelCount: 0 });
		const omp = installFakeOmp({ statuses: [stopped] });
		omp.ollama.runRemedy.mockResolvedValue({ outcome: "reopen-required", status: stopped, fault: "no_new_privs" });
		await mountReady();
		await click(action("remedy"));
		const notice = document.querySelector('[data-notice="remedy"]')?.textContent;
		expect(notice).toContain("Quit and reopen Sai ATLAS, then try again.");
		expect(notice).not.toContain("Run the command above in a terminal");
	});

	it("shows a failed remedy inline", async () => {
		const stopped = status({ state: "stopped", remedy: "linux-start", modelCount: 0 });
		const omp = installFakeOmp({ statuses: [stopped] });
		omp.ollama.runRemedy.mockResolvedValue({ outcome: "failed", status: stopped, fault: "unit not found" });
		await mountReady();
		await click(action("remedy"));
		expect(document.querySelector('[data-notice="remedy"]')?.textContent).toBe("That didn't work: unit not found");
	});

	it("shows a refused remedy and re-reads Ollama's state", async () => {
		const stopped = status({ state: "stopped", remedy: "linux-start", modelCount: 0 });
		const omp = installFakeOmp({ statuses: [stopped, status({ modelCount: 0 })] });
		omp.ollama.runRemedy.mockRejectedValue(new Error("That fix no longer matches Ollama's state; check again"));
		await mountReady();
		await click(action("remedy"));
		expect(document.querySelector('[data-notice="remedy"]')?.textContent).toContain("no longer matches");
		expect(document.querySelector('.omp-ollama-row[data-state="ok"]')).not.toBeNull();
	});

	it("offers no command block off Linux", async () => {
		const omp = installFakeOmp({
			statuses: [status({ state: "absent", platform: "darwin", remedy: null, modelCount: 0 })],
		});
		await mountReady();
		expect(document.querySelector(".omp-ollama-command")).toBeNull();
		expect(action("remedy")).toBeNull();
		await click(action("open-download"));
		expect(omp.ollama.openDownload).toHaveBeenCalledTimes(1);
		const before = omp.ollama.status.mock.calls.length;
		await click(action("check-again"));
		expect(omp.ollama.status.mock.calls.length).toBe(before + 1);
		expect(omp.ollama.modelScreen.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("streams download progress, then flips the card to downloaded and re-checks", async () => {
		const omp = installFakeOmp();
		await mountReady();
		const statusCalls = omp.ollama.status.mock.calls.length;

		await click(action("download-model", card("qwen3:14b")));
		expect(omp.ollama.pull).toHaveBeenCalledWith("qwen3:14b");
		expect(card("qwen3:14b").querySelector('[data-indeterminate="true"]')).not.toBeNull();
		// Only one download at a time.
		expect(action("download-model", card("qwen3:4b"))?.disabled).toBe(true);

		await act(async () => {
			omp.ollama.emit({
				tag: "qwen3:14b",
				status: "downloading",
				completed: 42,
				total: 100,
				percent: 42,
				done: false,
			});
		});
		expect(card("qwen3:14b").textContent).toContain("downloading · 42%");

		await act(async () => {
			omp.ollama.emit({ tag: "qwen3:14b", status: "success", completed: 100, total: 100, percent: 100, done: true });
		});
		await flush();
		expect(card("qwen3:14b").textContent).toContain("On this machine, ready to use");
		expect(action("use-model", card("qwen3:14b"))).not.toBeNull();
		expect(omp.ollama.status.mock.calls.length).toBeGreaterThan(statusCalls);
		expect(omp.rpc.getAvailableModels).toHaveBeenCalledWith(true);
		expect(action("download-model", card("qwen3:4b"))?.disabled).toBe(false);
	});

	it("still tries the model when the catalog refresh fails", async () => {
		const omp = installFakeOmp();
		omp.rpc.getAvailableModels.mockRejectedValue(new Error("sidecar busy"));
		await mountReady();
		await click(action("continue"));
		expect(omp.rpc.setModel).toHaveBeenCalledWith("ollama", "qwen3:8b");
		expect(omp.prefs.set).toHaveBeenCalledWith(WELCOME_COMPLETED_PREF, expect.any(String));
	});

	it("ignores progress for a download it did not start", async () => {
		const omp = installFakeOmp();
		await mountReady();
		// A Settings › Ollama pull that is still running, then one that failed.
		await act(async () => {
			omp.ollama.emit({ tag: "qwen3:4b", status: "downloading", completed: 1, total: 4, percent: 25, done: false });
			omp.ollama.emit({ tag: "llama3.2", status: "error", completed: 0, total: 0, percent: -1, done: false });
		});
		await flush();
		expect(card("qwen3:4b").querySelector('[role="progressbar"]')).toBeNull();
		expect(action("download-model", card("qwen3:4b"))?.disabled).toBe(false);
		expect(action("download-model", card("qwen3:14b"))?.disabled).toBe(false);
	});

	it("treats an error frame as the end of its download", async () => {
		const omp = installFakeOmp();
		await mountReady();
		await click(action("download-model", card("qwen3:14b")));
		expect(action("download-model", card("qwen3:4b"))?.disabled).toBe(true);
		await act(async () => {
			omp.ollama.emit({
				tag: "qwen3:14b",
				status: "error",
				completed: 0,
				total: 0,
				percent: -1,
				done: false,
				error: "disk full",
			});
		});
		await flush();
		expect(card("qwen3:14b").querySelector('[role="alert"]')?.textContent).toBe("disk full");
		expect(action("download-model", card("qwen3:4b"))?.disabled).toBe(false);
	});

	it("keeps a download it started earlier when the screen reopens", async () => {
		const omp = installFakeOmp();
		await mountReady();
		await click(action("download-model", card("qwen3:14b")));
		await click(action("skip"));
		await waitForExit();
		await act(async () => {
			omp.ollama.emit({ tag: "qwen3:14b", status: "downloading", completed: 3, total: 4, percent: 75, done: false });
		});
		await act(async () => useUiStore.getState().openWelcome());
		await flush();
		expect(card("qwen3:14b").textContent).toContain("downloading · 75%");
		expect(action("download-model", card("qwen3:4b"))?.disabled).toBe(true);
	});

	it("drops the bar on Cancel and lets a later Download resume", async () => {
		const omp = installFakeOmp();
		await mountReady();
		await click(action("download-model", card("qwen3:14b")));
		await click(action("cancel-pull", card("qwen3:14b")));

		expect(omp.ollama.cancelPull).toHaveBeenCalledTimes(1);
		expect(card("qwen3:14b").querySelector('[role="progressbar"]')).toBeNull();
		await act(async () => {
			omp.ollama.finishPull({
				tag: "qwen3:14b",
				status: "",
				completed: 0,
				total: 0,
				percent: -1,
				done: true,
				error: "cancelled",
			});
		});
		await flush();
		expect(card("qwen3:14b").querySelector('[role="alert"]')).toBeNull();

		await click(action("download-model", card("qwen3:14b")));
		expect(omp.ollama.pull).toHaveBeenCalledTimes(2);
		expect(card("qwen3:14b").querySelector('[role="progressbar"]')).not.toBeNull();
	});

	it("shows a refused pull as a notice on the card", async () => {
		const omp = installFakeOmp();
		await mountReady();
		await click(action("download-model", card("qwen3:4b")));
		await act(async () => {
			omp.ollama.finishPull({
				tag: "qwen3:4b",
				status: "busy",
				completed: 0,
				total: 0,
				percent: -1,
				done: true,
				error: "another download is running",
			});
		});
		await flush();
		expect(card("qwen3:4b").querySelector('[role="alert"]')?.textContent).toBe("another download is running");
		expect(action("download-model", card("qwen3:4b"))?.disabled).toBe(false);
	});

	it("moves the pick and warms the chosen model", async () => {
		const omp = installFakeOmp({
			screens: [modelScreen(DEFAULT_CHOICES.map(entry => ({ ...entry, installed: true })))],
		});
		await mountReady();
		await click(action("use-model", card("qwen3:4b")));
		expect(card("qwen3:4b").getAttribute("data-picked")).toBe("true");
		expect(card("qwen3:8b").getAttribute("data-picked")).toBe("false");
		expect(omp.ollama.warm).toHaveBeenLastCalledWith("qwen3:4b");
		await click(action("continue"));
		expect(omp.rpc.setModel).toHaveBeenCalledWith("ollama", "qwen3:4b");
	});

	it("closes for the session on Set up later and reopens from Run setup again", async () => {
		const omp = installFakeOmp();
		await mountReady();
		await click(action("skip"));
		await waitForExit();
		expect(dialog()).toBeNull();
		expect(omp.prefs.set).not.toHaveBeenCalled();

		for (let round = 0; round < 2; round++) {
			await act(async () => useUiStore.getState().openWelcome());
			await flush();
			expect(dialog()).not.toBeNull();
			await click(action("skip"));
			await waitForExit();
			expect(dialog()).toBeNull();
			expect(useUiStore.getState().welcomeOpen).toBe(false);
		}
	});

	it("shows why no card fits a small machine", async () => {
		installFakeOmp({ screens: [{ machine: modelScreen([]).machine, choices: [], emptyReason: "too-small" }] });
		await mountReady();
		expect(document.querySelector('[data-empty="too-small"]')?.textContent).toContain("not have enough memory");
		expect(action("continue")?.disabled).toBe(true);
	});
});
