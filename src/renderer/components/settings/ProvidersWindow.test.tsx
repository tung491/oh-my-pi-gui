/**
 * The Ollama window behind `openProviders`: it shows the daemon status and the
 * endpoint read-only, makes an installed model the default through set_model,
 * downloads a tag with live progress, treats a held download slot as a notice,
 * resolves remedies by outcome, offers no sign-in or custom-provider path, and
 * shows a context row for each installed local model.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	ContextFitChanged,
	ContextFitList,
	ContextFitProgress,
	OllamaInstallProgress,
	OllamaRemedyResult,
	OllamaStatus,
	PullProgress,
} from "../../../shared/ollama-types";
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
const ABSENT = ollamaStatus({ state: "absent", modelCount: 0, installedTags: [], remedy: "linux-install" });

let ollama: {
	status: Mock<() => Promise<OllamaStatus>>;
	pull: Mock<(tag: string) => Promise<PullProgress>>;
	cancelPull: Mock<() => Promise<void>>;
	runRemedy: Mock<(id: string) => Promise<OllamaRemedyResult>>;
	openDownload: Mock<() => Promise<void>>;
	onPullProgress: Mock<(callback: (progress: PullProgress) => void) => () => void>;
	onInstallProgress: Mock<(callback: (progress: OllamaInstallProgress) => void) => () => void>;
	contextList: Mock<() => Promise<ContextFitList>>;
	measureContext: Mock<(tag: string, reason?: string) => Promise<{ queued: true }>>;
	setContextCap: Mock;
	onContextProgress: Mock<(callback: (progress: ContextFitProgress) => void) => () => void>;
	onContextChanged: Mock<(callback: (change: ContextFitChanged) => void) => () => void>;
};
let rpc: Record<string, Mock>;
let prefs: { get: Mock; set: Mock<(key: string, value: unknown) => Promise<void>> };
let emitProgress: (progress: PullProgress) => void;
let emitInstall: (progress: OllamaInstallProgress) => void;
let emitChanged: (change: ContextFitChanged) => void;

/** Context rows for the default installed models, both unmeasured. */
function contextList(overrides: Partial<ContextFitList> = {}): ContextFitList {
	return {
		rows: ["qwen3:8b", "gemma3:4b"].map(tag => ({
			tag,
			entry: null,
			effective: null,
			stale: false,
			envCap: null,
			state: "idle" as const,
		})),
		...overrides,
	};
}

const ok = (data?: unknown): RpcResponse => ({ type: "response", command: "x", success: true, data });

beforeEach(() => {
	emitProgress = () => {};
	emitInstall = () => {};
	emitChanged = () => {};
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
		onInstallProgress: vi.fn(callback => {
			emitInstall = callback;
			return () => {
				emitInstall = () => {};
			};
		}),
		contextList: vi.fn(async () => contextList()),
		measureContext: vi.fn(async () => ({ queued: true as const })),
		setContextCap: vi.fn(),
		onContextProgress: vi.fn(() => () => {}),
		onContextChanged: vi.fn(callback => {
			emitChanged = callback;
			return () => {
				emitChanged = () => {};
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

describe("cloud models", () => {
	it("refuses Ollama cloud tags", () => {
		expect(normalizePullTag("gpt-oss:120b-cloud")).toBeNull();
		expect(normalizePullTag("kimi-k2:cloud")).toBeNull();
		expect(normalizePullTag("x-cloud")).toBeNull();
	});

	it("keeps local tags, including names that merely contain the word", () => {
		expect(normalizePullTag("hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf")).toBe(
			"hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf",
		);
		expect(normalizePullTag("llama3:8b")).toBe("llama3:8b");
		expect(normalizePullTag("cloudy:7b")).toBe("cloudy:7b");
	});
});

describe("ProvidersWindow (Ollama)", () => {
	it("disables Use as default for an installed cloud model and says why", async () => {
		ollama.status.mockResolvedValue(ollamaStatus({ installedTags: ["x:cloud", "gemma3:4b"] }));
		await mountOpen();
		const cloud = installedRow("x:cloud")?.querySelector(
			'[data-action="use-as-default"]',
		) as HTMLButtonElement | null;
		expect(cloud).not.toBeNull();
		expect(cloud?.disabled).toBe(true);
		expect(cloud?.getAttribute("title")).toBe(translate("ollama.settings.cloudRefused"));
		const local = installedRow("gemma3:4b")?.querySelector(
			'[data-action="use-as-default"]',
		) as HTMLButtonElement | null;
		expect(local?.disabled).toBe(false);
	});

	it("refuses to pull a cloud tag and sends nothing to Ollama", async () => {
		await mountOpen();
		await typeTag("gpt-oss:120b-cloud");
		await submitPull();
		expect(ollama.pull).not.toHaveBeenCalled();
		expect(text()).toContain(translate("ollama.settings.cloudRefused"));
		expect(translate("ollama.settings.cloudRefused")).toBe(
			"Cloud models send your conversations online. Sai ATLAS uses only models that run on this computer.",
		);
	});

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
		// A manual request: a pulled one would wait for the welcome screen, which may never complete here.
		expect(ollama.measureContext).toHaveBeenCalledTimes(1);
		expect(ollama.measureContext).toHaveBeenCalledWith("llama3.2:3b");
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
		expect(ollama.measureContext).not.toHaveBeenCalled();
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

	it("shows an install another window started from its broadcast frames", async () => {
		ollama.status.mockResolvedValue(ABSENT);
		await mountOpen();
		const bar = () => document.body.querySelector("[data-install-progress]");
		expect(bar()).toBeNull();

		await act(async () => emitInstall({ stage: "Downloading ollama...", percent: 42, done: false }));
		expect(ollama.runRemedy).not.toHaveBeenCalled();
		expect(bar()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
		expect(bar()?.textContent).toContain("Downloading ollama...");
		expect(bar()?.querySelector("button")).toBeNull();

		await act(async () => emitInstall({ stage: "Install complete.", percent: -1, done: true }));
		expect(bar()).toBeNull();
	});

	it("re-reads Ollama when another window's install ends", async () => {
		ollama.status.mockResolvedValue(ABSENT);
		await mountOpen();
		const probes = ollama.status.mock.calls.length;
		ollama.status.mockResolvedValue(ollamaStatus());
		await act(async () => emitInstall({ stage: "Install complete.", percent: -1, done: true }));
		await settle();
		expect(ollama.status.mock.calls.length).toBe(probes + 1);
		expect(document.body.querySelector('.omp-ollama-row[data-state="ok"]')).not.toBeNull();
	});

	it("keeps the running install's stage when it joins that install", async () => {
		ollama.status.mockResolvedValue(ABSENT);
		ollama.runRemedy.mockReturnValue(new Promise<OllamaRemedyResult>(() => {}));
		await mountOpen();
		await act(async () => emitInstall({ stage: "Downloading ollama...", percent: 42, done: false }));

		await act(async () => {
			(document.body.querySelector('[data-action="remedy"]') as HTMLButtonElement)?.click();
		});
		await settle();
		const bar = document.body.querySelector("[data-install-progress]");
		expect(bar?.textContent).toContain("Downloading ollama...");
		expect(bar?.textContent).not.toContain(translate("welcome.install.waiting"));
	});

	it("ignores install frames once the row no longer offers the install", async () => {
		ollama.status.mockResolvedValue(STOPPED);
		await mountOpen();
		await act(async () => emitInstall({ stage: "Downloading ollama...", percent: 42, done: false }));
		expect(document.body.querySelector("[data-install-progress]")).toBeNull();
	});

	it("shows the waiting state for its own install until the remedy result arrives", async () => {
		ollama.status.mockResolvedValue(ABSENT);
		const remedy = Promise.withResolvers<OllamaRemedyResult>();
		ollama.runRemedy.mockReturnValue(remedy.promise);
		await mountOpen();

		await act(async () => {
			(document.body.querySelector('[data-action="remedy"]') as HTMLButtonElement)?.click();
		});
		await settle();
		const bar = () => document.body.querySelector("[data-install-progress]");
		expect(bar()?.textContent).toContain(translate("welcome.install.waiting"));

		await act(async () => emitInstall({ stage: "Installing ollama to /usr/local", percent: -1, done: false }));
		expect(bar()?.textContent).toContain("Installing ollama to /usr/local");

		await act(async () => remedy.resolve({ outcome: "cancelled", status: ABSENT }));
		await settle();
		expect(bar()).toBeNull();
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

	it("asks for a reopen when this session cannot ask for administrator access", async () => {
		ollama.status.mockResolvedValue(STOPPED);
		ollama.runRemedy.mockResolvedValueOnce({ outcome: "reopen-required", status: STOPPED, fault: "no_new_privs" });
		await mountOpen();
		const remedy = () => document.body.querySelector('[data-action="remedy"]') as HTMLButtonElement;

		await act(async () => remedy().click());
		await settle();
		expect(document.body.querySelector("[data-remedy-hint]")?.textContent).toBe(
			translate("welcome.ollama.remedyReopen"),
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

describe("ProvidersWindow context rows", () => {
	function contextRow(tag: string): Element | null {
		return installedRow(tag)?.querySelector(`[data-context-row="${tag}"]`) ?? null;
	}

	it("gives each local model a context row and cloud or remote copies none", async () => {
		ollama.status.mockResolvedValue(
			ollamaStatus({ installedTags: ["gemma3:4b", "x:cloud", "remote:7b"], modelCount: 3 }),
		);
		ollama.contextList.mockResolvedValue({
			rows: [{ tag: "gemma3:4b", entry: null, effective: null, stale: false, envCap: null, state: "idle" }],
		});
		await mountOpen();
		expect(contextRow("gemma3:4b")).not.toBeNull();
		expect(contextRow("x:cloud")).toBeNull();
		expect(contextRow("remote:7b")).toBeNull();
		expect(document.body.querySelector("[data-context-notice]")).toBeNull();
	});

	it("shows one notice and no rows when Ollama is on another computer", async () => {
		ollama.contextList.mockResolvedValue({ rows: [], reason: "remote-host" });
		await mountOpen();
		const notices = document.body.querySelectorAll("[data-context-notice]");
		expect(notices.length).toBe(1);
		expect(notices[0]?.textContent).toBe(translate("ollama.context.remoteHost"));
		expect(document.body.querySelector("[data-context-row]")).toBeNull();
	});

	it("explains that a configured ollama provider turns the limits off but keeps Measure", async () => {
		ollama.contextList.mockResolvedValue(contextList({ reason: "configured-provider" }));
		await mountOpen();
		expect(document.body.querySelector('[data-context-notice="configured-provider"]')?.textContent).toBe(
			translate("ollama.context.configuredProvider"),
		);
		const measure = contextRow("qwen3:8b")?.querySelector('[data-action="measure-context"]') as HTMLButtonElement;
		expect(measure?.disabled).toBe(false);
	});

	it("renders no context rows unless Ollama answers", async () => {
		ollama.status.mockResolvedValue(STOPPED);
		await mountOpen();
		expect(ollama.contextList).not.toHaveBeenCalled();
		expect(document.body.querySelector("[data-context-row]")).toBeNull();
	});

	it("re-reads the rows once for a burst of context changes", async () => {
		await mountOpen();
		const lists = ollama.contextList.mock.calls.length;
		await act(async () => {
			emitChanged({ tag: "qwen3:8b" });
			emitChanged({ tag: "gemma3:4b" });
		});
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
		});
		expect(ollama.contextList.mock.calls.length).toBe(lists + 1);
	});

	it("shows a failed context read instead of the rows", async () => {
		ollama.contextList.mockRejectedValue(new Error("ipc closed"));
		await mountOpen();
		expect(document.body.querySelector("[data-context-error-list]")?.textContent).toBe(
			translate("ollama.context.listFailed", { error: "ipc closed" }),
		);
	});
});
