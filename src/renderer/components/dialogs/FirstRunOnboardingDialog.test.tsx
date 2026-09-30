import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ProviderInfo, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Modal } from "../common";
import { FirstRunOnboardingDialog, hasUsableModelProvider } from "./FirstRunOnboardingDialog";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface MockOmp {
	rpc: {
		getProviders: Mock<() => Promise<RpcResponse>>;
		login: Mock<(providerId: string) => Promise<RpcResponse>>;
	};
	models: {
		listProviders: Mock<() => Promise<CustomProviderView[]>>;
	};
	updater: {
		version: Mock<() => Promise<string>>;
	};
	prefs: {
		get: Mock<(key?: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
}

function success(providers: ProviderInfo[]): RpcResponse {
	return { type: "response", command: "test", success: true, data: { providers } };
}

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
	return {
		name: partial.id,
		authenticated: false,
		loginAvailable: true,
		disabled: false,
		modelCount: 0,
		...partial,
	};
}

function config(partial: Partial<CustomProviderView> & { id: string }): CustomProviderView {
	return {
		api: "openai-completions",
		baseUrl: "https://api.example.com/v1",
		hasApiKey: false,
		models: [{ id: "model-id" }],
		builtin: false,
		...partial,
	};
}

function installMockOmp(providers: ProviderInfo[] = [], configs: CustomProviderView[] = []): MockOmp {
	const omp: MockOmp = {
		rpc: {
			getProviders: vi.fn(async () => success(providers)),
			login: vi.fn(async () => ({ type: "response", command: "login", success: true }) as const),
		},
		models: { listProviders: vi.fn(async () => configs) },
		updater: { version: vi.fn(async () => "0.9.10") },
		prefs: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
	};
	const testWindow = window as unknown as { omp: MockOmp };
	testWindow.omp = omp;
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

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function buttonNamed(text: string): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes(text));
	if (!(button instanceof HTMLElement)) throw new Error(`Button not found: ${text}`);
	return button as HTMLButtonElement;
}

/** A click event React can dispatch: linkedom's Event has a getter-only eventPhase React writes to. */
function clickEvent(): InstanceType<typeof Event> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	return event;
}

async function click(element: HTMLElement | HTMLButtonElement | HTMLInputElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(clickEvent());
	});
	await flush();
}

function dialog(): Element | null {
	return document.querySelector('[role="dialog"]');
}

function stepItems(): Element[] {
	return [...document.querySelectorAll('nav[aria-label="Setup steps"] li')];
}

function currentStep(): string | undefined {
	return stepItems()
		.find(item => item.getAttribute("aria-current") === "step")
		?.textContent?.trim();
}

/** linkedom has no native radio behavior: check the input, then click it so React sees the change. */
async function selectOption(label: string): Promise<void> {
	const option = [...document.querySelectorAll('[role="radiogroup"] label')].find(candidate =>
		candidate.textContent?.includes(label),
	);
	const input = option?.querySelector('input[type="radio"]');
	if (!input) throw new Error(`Option not found: ${label}`);
	(input as HTMLInputElement).checked = true;
	await click(input as HTMLInputElement);
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
	useUiStore.getState().closeProviders();
	useUiStore.getState().closeProviderConfig();
	useToastStore.setState({ toasts: [] });
});

describe("hasUsableModelProvider", () => {
	it("requires an enabled provider with both credentials and a model", () => {
		expect(hasUsableModelProvider([], [])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 0 })], [])).toBe(false);
		expect(
			hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 1, disabled: true })], []),
		).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 1 })], [])).toBe(true);
	});

	it("requires inventory-confirmed models for custom API-key and no-auth providers", () => {
		const gateway = config({ id: "gateway", hasApiKey: true });
		const local = config({ id: "ollama-local", auth: "none" });
		expect(hasUsableModelProvider([], [gateway])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "gateway", authenticated: true, modelCount: 1 })], [gateway])).toBe(
			true,
		);
		expect(hasUsableModelProvider([provider({ id: "ollama-local", modelCount: 1 })], [local])).toBe(true);
		expect(hasUsableModelProvider([provider({ id: "ollama-local", modelCount: 0 })], [local])).toBe(false);
	});
});

describe("FirstRunOnboardingDialog", () => {
	it("keeps the user's settings dialog accessible when the startup readiness check finishes late", async () => {
		const omp = installMockOmp();
		const pending = Promise.withResolvers<RpcResponse>();
		omp.rpc.getProviders.mockReturnValue(pending.promise);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(
			<>
				<FirstRunOnboardingDialog />
				<Modal open onClose={() => {}} title="Settings">
					Current settings
				</Modal>
			</>,
		);
		await act(async () => pending.resolve(success([])));
		await flush();
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Current settings");
	});

	it("walks an empty profile through the setup steps and closes only when the user finishes", async () => {
		const omp = installMockOmp([
			provider({ id: "anthropic", name: "Anthropic" }),
			provider({ id: "vertex", name: "Vertex", disabled: true }),
		]);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);

		expect(stepItems().map(item => item.textContent?.trim())).toEqual([
			"Welcome",
			"Connect a provider",
			"Choose models",
			"Open a workspace",
			"Ready",
		]);
		expect(currentStep()).toBe("Welcome");
		expect(document.body.textContent ?? "").toContain("Connect a model before your first session");
		expect(buttonNamed("Back").disabled).toBe(true);

		await click(buttonNamed("Continue"));
		expect(currentStep()).toBe("Connect a provider");
		const group = document.querySelector('[role="radiogroup"]');
		expect(group?.querySelectorAll('input[type="radio"]')).toHaveLength(3);
		expect(group?.textContent ?? "").toContain("Sign in with Anthropic");
		expect(group?.textContent ?? "").toContain("Open Providers & Login");
		expect(group?.textContent ?? "").toContain("Custom provider and model");
		expect(group?.textContent ?? "").not.toContain("Vertex");

		await click(buttonNamed("Open Providers & Login"));
		expect(useUiStore.getState().providersOpen).toBe(true);
		await click(buttonNamed("Configure custom provider"));
		expect(useUiStore.getState().providerConfigOpen).toBe(true);

		omp.rpc.getProviders.mockResolvedValue(
			success([provider({ id: "deepseek", authenticated: true, modelCount: 2 })]),
		);
		await click(buttonNamed("I've configured it"));
		expect(currentStep()).toBe("Choose models");
		expect(dialog()).not.toBeNull();

		await click(buttonNamed("Continue"));
		await click(buttonNamed("Continue"));
		expect(currentStep()).toBe("Ready");
		await click(buttonNamed("Start using omp"));
		await waitForExit();
		expect(dialog()).toBeNull();
		expect(omp.prefs.set).not.toHaveBeenCalled();
	});

	it("signs in with a selected OAuth provider", async () => {
		const omp = installMockOmp([provider({ id: "anthropic", name: "Anthropic" })]);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);

		await click(buttonNamed("Continue"));
		await selectOption("Sign in with Anthropic");
		await click(buttonNamed("Continue"));

		expect(omp.rpc.login).toHaveBeenCalledTimes(1);
		expect(omp.rpc.login).toHaveBeenCalledWith("anthropic");
	});

	it("continues to model choice after going back from it once a provider is ready", async () => {
		const omp = installMockOmp([provider({ id: "anthropic", name: "Anthropic" })]);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);

		await click(buttonNamed("Continue"));
		await selectOption("Sign in with Anthropic");
		omp.rpc.getProviders.mockResolvedValue(
			success([provider({ id: "anthropic", name: "Anthropic", authenticated: true, modelCount: 2 })]),
		);
		await click(buttonNamed("Continue"));
		expect(omp.rpc.login).toHaveBeenCalledTimes(1);
		expect(currentStep()).toBe("Choose models");

		await click(buttonNamed("Back"));
		expect(currentStep()).toBe("Connect a provider");
		// The signed-in provider's option is gone, so the selection falls back.
		expect(document.querySelector('[role="radiogroup"]')?.textContent ?? "").not.toContain("Sign in with Anthropic");

		await click(buttonNamed("Continue"));
		expect(currentStep()).toBe("Choose models");
		expect(useUiStore.getState().providersOpen).toBe(false);
		expect(useUiStore.getState().providerConfigOpen).toBe(false);
		expect(omp.rpc.login).toHaveBeenCalledTimes(1);
	});

	it("stays closed after Skip for now, even when readiness is checked again", async () => {
		const omp = installMockOmp();
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);
		expect(dialog()).not.toBeNull();

		await click(buttonNamed("Skip for now"));
		await waitForExit();
		expect(dialog()).toBeNull();

		// A sidecar restart and a settings overlay closing must not bring it back.
		await act(async () => useSessionStore.getState().setStatus("restarting", "/tmp/project"));
		await act(async () => useSessionStore.getState().setStatus("ready", "/tmp/project"));
		await act(async () => useUiStore.getState().openProviders());
		await act(async () => useUiStore.getState().closeProviders());
		await flush();
		await waitForExit();
		expect(dialog()).toBeNull();
		expect(omp.rpc.getProviders).toHaveBeenCalledTimes(1);
		expect(omp.prefs.set).not.toHaveBeenCalled();
	});

	it("stays closed when a login started before Skip finishes afterwards", async () => {
		const omp = installMockOmp([provider({ id: "anthropic", name: "Anthropic" })]);
		const login = Promise.withResolvers<RpcResponse>();
		omp.rpc.login.mockReturnValue(login.promise);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);

		await click(buttonNamed("Continue"));
		await selectOption("Sign in with Anthropic");
		await click(buttonNamed("Continue"));
		expect(omp.rpc.login).toHaveBeenCalledTimes(1);
		await click(buttonNamed("Skip for now"));

		await act(async () => login.resolve({ type: "response", command: "login", success: true }));
		await flush();
		await waitForExit();
		// The post-login readiness check ran and still found no usable provider.
		expect(omp.rpc.getProviders).toHaveBeenCalledTimes(2);
		expect(dialog()).toBeNull();
	});

	it("starts one login when Continue is pressed twice", async () => {
		const omp = installMockOmp([provider({ id: "anthropic", name: "Anthropic" })]);
		const login = Promise.withResolvers<RpcResponse>();
		omp.rpc.login.mockReturnValue(login.promise);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);

		await click(buttonNamed("Continue"));
		await selectOption("Sign in with Anthropic");
		const next = buttonNamed("Continue");
		// Both clicks land before React re-renders the disabled state.
		await act(async () => {
			next.dispatchEvent(clickEvent());
			next.dispatchEvent(clickEvent());
		});
		await flush();
		expect(omp.rpc.login).toHaveBeenCalledTimes(1);

		await act(async () => login.resolve({ type: "response", command: "login", success: true }));
		await flush();
	});

	it("re-checks readiness when the Providers window it opened closes", async () => {
		const omp = installMockOmp([provider({ id: "anthropic", name: "Anthropic" })]);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);

		await click(buttonNamed("Continue"));
		await selectOption("Open Providers & Login");
		await click(buttonNamed("Continue"));
		expect(useUiStore.getState().providersOpen).toBe(true);
		expect(currentStep()).toBe("Connect a provider");
		expect(dialog()?.textContent ?? "").toContain("Step 2 of 5");

		omp.rpc.getProviders.mockResolvedValue(
			success([provider({ id: "anthropic", name: "Anthropic", authenticated: true, modelCount: 2 })]),
		);
		await act(async () => useUiStore.getState().closeProviders());
		await flush();
		expect(omp.rpc.getProviders).toHaveBeenCalledTimes(2);
		expect(currentStep()).toBe("Choose models");
		expect(dialog()).not.toBeNull();
	});

	it("does not interrupt startup when a runnable provider already exists", async () => {
		installMockOmp([provider({ id: "anthropic", authenticated: true, modelCount: 3 })]);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);
		expect(document.body.textContent ?? "").not.toContain("Connect a model before your first session");
	});
});
