import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUpdaterStore } from "../../stores/updater";
import { updateErrorText } from "../layout/UpdateBanner";
import { UpdatesSettingsPage, updateOverviewState } from "./UpdatesSettingsPage";

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

/** Every method the page reads from the agent RPC client, in call order. */
interface MockOmp {
	rpcCalls: string[];
	updater: {
		check: () => Promise<UpdateStatus>;
		version: () => Promise<string>;
	};
	rpc: Record<string, () => Promise<{ success: false; error: string }>>;
}

function installMockOmp(): MockOmp {
	const rpcCalls: string[] = [];
	// Stable method identities, like the real client: a fresh function per read
	// would change hook dependencies on every render.
	const methods = new Map<string, () => Promise<{ success: false; error: string }>>();
	const rpc = new Proxy({} as MockOmp["rpc"], {
		get: (_target, property) => {
			const name = String(property);
			let method = methods.get(name);
			if (!method) {
				method = () => {
					rpcCalls.push(name);
					return Promise.resolve({ success: false as const, error: "not stubbed" });
				};
				methods.set(name, method);
			}
			return method;
		},
	});
	const omp: MockOmp = {
		rpcCalls,
		updater: {
			check: vi.fn(async (): Promise<UpdateStatus> => ({ state: "not-available", version: "1.0.0" })),
			version: vi.fn(async () => "1.0.0"),
		},
		rpc,
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

let container: InstanceType<typeof HTMLElement> | null = null;
let root: Root | null = null;

async function mountPage(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<UpdatesSettingsPage />
			</I18nProvider>,
		);
	});
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	container?.remove();
	container = null;
	useSessionStore.getState().reset();
	useUpdaterStore.getState().setStatus({ state: "idle" });
});

describe("updates settings page", () => {
	it("checks only the app's own release feed, never the agent's package registry", async () => {
		const omp = installMockOmp();
		useSessionStore.getState().setStatus("ready", "/tmp");
		await mountPage();

		expect(omp.updater.check).toHaveBeenCalledTimes(1);
		expect(omp.rpcCalls).toEqual([]);
		expect(useUpdaterStore.getState().status).toEqual({ state: "not-available", version: "1.0.0" });
	});
});

describe("updates overview state", () => {
	it("does not claim the app is up to date before the check finishes", () => {
		expect(updateOverviewState({ state: "idle" }, false)).toBe("checking");
		expect(updateOverviewState({ state: "checking" }, false)).toBe("checking");
		expect(updateOverviewState({ state: "error", message: "stale" }, true)).toBe("checking");
	});

	it("surfaces an updater failure instead of rendering up to date", () => {
		expect(updateOverviewState({ state: "error", message: "offline" }, false)).toBe("error");
	});

	it("reports attention while an app update is available, downloading or ready", () => {
		expect(updateOverviewState({ state: "available", version: "0.7.2", mode: "automatic" }, false)).toBe("attention");
		expect(
			updateOverviewState(
				{
					state: "downloading",
					version: "0.7.2",
					mode: "automatic",
					percent: 40,
					bytesPerSecond: 1,
					transferred: 40,
					total: 100,
				},
				false,
			),
		).toBe("attention");
	});

	it("reports healthy once the app's release feed has no newer version", () => {
		expect(updateOverviewState({ state: "not-available", version: "0.7.1" }, false)).toBe("healthy");
	});
});

describe("update error text", () => {
	const t = (key: string, params?: Record<string, string | number>) => `${key}: ${params?.command ?? ""}`;

	it("shows the manual install command instead of apt's output when apt could not resolve dependencies", () => {
		expect(
			updateErrorText(t, {
				state: "error",
				message: "The update could not be installed. (E: Unmet dependencies)",
				manualInstallCommand: "sudo apt install /tmp/a.deb",
			}),
		).toBe("updater.unresolvedDependencies: sudo apt install /tmp/a.deb");
	});

	it("shows every other failure as the updater reported it", () => {
		expect(updateErrorText(t, { state: "error", message: "offline" })).toBe("offline");
	});
});
