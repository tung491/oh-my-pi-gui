import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfigCleanupResult } from "../../shared/ollama-types";
import type { ProviderInfo, RpcResponse } from "../../shared/rpc-types";
import { useToastStore } from "../stores/toast";
import { I18nProvider, translate } from "./i18n";
import {
	PROVIDER_CLEANUP_PREF,
	PROVIDER_CLEANUP_VERSION,
	type ProviderCleanupDeps,
	runProviderCleanup,
	useProviderCleanup,
} from "./provider-cleanup";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function provider(id: string, authenticated: boolean, authKind?: ProviderInfo["authKind"]): ProviderInfo {
	return { id, name: id, authenticated, authKind, loginAvailable: true, disabled: false, modelCount: 1 };
}

const PROVIDERS: ProviderInfo[] = [
	provider("anthropic", true, "oauth"),
	provider("github-copilot", true, "oauth"),
	provider("openai", true, "apikey"),
	provider("groq", true, "env"),
	provider("google-gemini-cli", false, "oauth"),
	provider("ollama", true, "oauth"),
];

const ok = (data?: unknown): RpcResponse => ({ type: "response", command: "test", success: true, data });
const fail = (error: string): RpcResponse => ({ type: "response", command: "test", success: false, error });

interface Fake {
	deps: ProviderCleanupDeps;
	prefs: Map<string, unknown>;
	logouts: string[];
	cleanCalls: number;
	notified: number;
	warnings: string[];
}

function fake(options: {
	providers?: ProviderInfo[] | Error;
	failLogout?: string[];
	clean?: ProviderConfigCleanupResult | Error;
	pref?: unknown;
}): Fake {
	const state: Fake = {
		prefs: new Map(options.pref === undefined ? [] : [[PROVIDER_CLEANUP_PREF, options.pref]]),
		logouts: [],
		cleanCalls: 0,
		notified: 0,
		warnings: [],
		deps: undefined as never,
	};
	state.deps = {
		waitForReady: async () => {},
		rpc: () => ({
			getProviders: async () => {
				if (options.providers instanceof Error) throw options.providers;
				return ok({ providers: options.providers ?? PROVIDERS });
			},
			logout: async id => {
				state.logouts.push(id);
				return options.failLogout?.includes(id) ? fail("refused") : ok();
			},
		}),
		prefs: {
			get: async key => state.prefs.get(key),
			set: async (key, value) => {
				state.prefs.set(key, value);
			},
		},
		cleanConfig: async () => {
			state.cleanCalls++;
			if (options.clean instanceof Error) throw options.clean;
			return options.clean ?? { backupPath: "/agent/models.yml.bak-20261002-090507", removed: ["my-proxy"] };
		},
		notify: () => {
			state.notified++;
		},
		warn: message => {
			state.warnings.push(message);
		},
	};
	return state;
}

describe("runProviderCleanup", () => {
	it("signs out only authenticated OAuth providers outside the allow-list, then sets the pref", async () => {
		const state = fake({});
		const outcome = await runProviderCleanup(state.deps);

		expect(state.logouts).toEqual(["anthropic", "github-copilot"]);
		expect(state.cleanCalls).toBe(1);
		expect(state.prefs.get(PROVIDER_CLEANUP_PREF)).toBe(PROVIDER_CLEANUP_VERSION);
		expect(outcome).toEqual({
			ran: true,
			loggedOut: ["anthropic", "github-copilot"],
			removed: ["my-proxy"],
			backupPath: "/agent/models.yml.bak-20261002-090507",
		});
		expect(state.notified).toBe(1);
	});

	it("skips a failed logout, keeps going, and still finishes", async () => {
		const state = fake({ failLogout: ["anthropic"] });
		const outcome = await runProviderCleanup(state.deps);

		expect(state.logouts).toEqual(["anthropic", "github-copilot"]);
		expect(outcome.loggedOut).toEqual(["github-copilot"]);
		expect(state.warnings).toHaveLength(1);
		expect(state.prefs.get(PROVIDER_CLEANUP_PREF)).toBe(PROVIDER_CLEANUP_VERSION);
	});

	it("leaves the pref unset when cleaning the config fails", async () => {
		const state = fake({ clean: new Error("backup incomplete") });
		await expect(runProviderCleanup(state.deps)).rejects.toThrow("backup incomplete");

		expect(state.prefs.has(PROVIDER_CLEANUP_PREF)).toBe(false);
		expect(state.notified).toBe(0);
	});

	it("leaves the pref unset and touches nothing when the provider list fails", async () => {
		const state = fake({ providers: new Error("sidecar gone") });
		await expect(runProviderCleanup(state.deps)).rejects.toThrow("sidecar gone");

		expect(state.logouts).toEqual([]);
		expect(state.cleanCalls).toBe(0);
		expect(state.prefs.has(PROVIDER_CLEANUP_PREF)).toBe(false);
	});

	it("does nothing once an earlier launch finished", async () => {
		const state = fake({ pref: PROVIDER_CLEANUP_VERSION });
		const outcome = await runProviderCleanup(state.deps);

		expect(outcome.ran).toBe(false);
		expect(state.logouts).toEqual([]);
		expect(state.cleanCalls).toBe(0);
	});

	it("sets the pref without a notice when nothing needed changing", async () => {
		const state = fake({ providers: [provider("ollama", true)], clean: { backupPath: null, removed: [] } });
		await runProviderCleanup(state.deps);

		expect(state.prefs.get(PROVIDER_CLEANUP_PREF)).toBe(PROVIDER_CLEANUP_VERSION);
		expect(state.notified).toBe(0);
	});
});

describe("useProviderCleanup", () => {
	let container: Element;
	let root: Root;

	function Probe({ deps }: { deps: Partial<ProviderCleanupDeps> }) {
		useProviderCleanup(deps);
		return null;
	}

	async function mount(deps: Partial<ProviderCleanupDeps>): Promise<void> {
		container = document.createElement("div") as unknown as Element;
		document.body.appendChild(container as never);
		root = createRoot(container);
		await act(async () => {
			root.render(
				<I18nProvider>
					<Probe deps={deps} />
				</I18nProvider>,
			);
		});
	}

	/** Let the migration's awaits drain inside act. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 10; i++) {
			await act(async () => {
				await new Promise(resolve => setTimeout(resolve, 0));
			});
		}
	}

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		useToastStore.setState({ toasts: [] });
	});

	it("runs once and shows the notice with the backup path", async () => {
		const state = fake({});
		const { notify: _unused, ...deps } = state.deps;
		await mount(deps);
		await settle();
		await act(async () => {
			root.render(
				<I18nProvider>
					<Probe deps={deps} />
				</I18nProvider>,
			);
		});
		await settle();

		expect(state.logouts).toEqual(["anthropic", "github-copilot"]);
		expect(state.cleanCalls).toBe(1);
		expect(state.prefs.get(PROVIDER_CLEANUP_PREF)).toBe(PROVIDER_CLEANUP_VERSION);
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.message).toContain("/agent/models.yml.bak-20261002-090507");
	});

	it("says only that providers were signed out when models.yml was left alone", async () => {
		const state = fake({ clean: { backupPath: null, removed: [] } });
		const { notify: _unused, ...deps } = state.deps;
		await mount(deps);
		await settle();

		expect(state.logouts).toEqual(["anthropic", "github-copilot"]);
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.message).toBe(translate("providers.cleanup.noticeSignOutOnly"));
		expect(toasts[0]?.message).not.toContain("models.yml");
	});

	it("shows no notice on the no-op path", async () => {
		const state = fake({ providers: [provider("ollama", true)], clean: { backupPath: null, removed: [] } });
		const { notify: _unused, ...deps } = state.deps;
		await mount(deps);
		await settle();

		expect(state.prefs.get(PROVIDER_CLEANUP_PREF)).toBe(PROVIDER_CLEANUP_VERSION);
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("leaves the pref unset and reports the failure when cleanup throws", async () => {
		const state = fake({ clean: new Error("disk full") });
		const { notify: _unused, ...deps } = state.deps;
		await mount(deps);
		await settle();

		expect(state.prefs.has(PROVIDER_CLEANUP_PREF)).toBe(false);
		expect(state.warnings.some(message => message.includes("retry on the next launch"))).toBe(true);
		expect(useToastStore.getState().toasts).toEqual([]);
	});
});
