/**
 * Theme cards on the GUI settings page: the three first-party selections,
 * the live apply + save path they share with the theme picker, and the
 * pressed state read back from the saved preferences.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { applyThemeByName } from "../../lib/themes";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { ThemeCards } from "./ThemeCards";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><head></head><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface MockOmp {
	prefs: {
		get: Mock<(key: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
}

function installMockOmp(saved: Record<string, unknown> = {}): MockOmp {
	const omp: MockOmp = {
		prefs: {
			get: vi.fn(async (key: string) => saved[key] ?? null),
			set: vi.fn(async () => {}),
		},
	};
	const testWindow = window as unknown as { omp: MockOmp };
	testWindow.omp = omp;
	return omp;
}

const initialTheme = useUiStore.getState().theme;
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

/** A click event React can dispatch: linkedom's Event has a getter-only eventPhase React writes to. */
function clickEvent(): InstanceType<typeof Event> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	return event;
}

async function click(element: InstanceType<typeof HTMLElement>): Promise<void> {
	await act(async () => {
		element.dispatchEvent(clickEvent());
	});
	await flush();
}

function cards(): InstanceType<typeof HTMLElement>[] {
	const group = document.querySelector('[role="group"][aria-label="GUI theme"]');
	if (!group) return [];
	return [...group.querySelectorAll("button[aria-pressed]")] as InstanceType<typeof HTMLElement>[];
}

function card(label: string): InstanceType<typeof HTMLElement> {
	const found = cards().find(candidate => (candidate.textContent ?? "").startsWith(label));
	if (!found) throw new Error(`Theme card not found: ${label}`);
	return found;
}

function pressedStates(): Array<string | null> {
	return cards().map(candidate => candidate.getAttribute("aria-pressed"));
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	container = null;
	root = null;
	// Drop the inline tokens and data-theme a click wrote so tests stay independent.
	applyThemeByName("system", { persist: false });
	document.documentElement.removeAttribute("data-theme");
	useUiStore.setState({ theme: initialTheme });
	useToastStore.setState({ toasts: [] });
});

describe("ThemeCards", () => {
	it("offers VIF Light, VIF Navy, and System as a labelled group of pressable cards", async () => {
		installMockOmp();
		await mount(<ThemeCards />);

		const labels = cards().map(candidate => candidate.textContent ?? "");
		expect(labels).toHaveLength(3);
		expect(labels[0].startsWith("VIF Light")).toBe(true);
		expect(labels[1].startsWith("VIF Navy")).toBe(true);
		expect(labels[2].startsWith("System")).toBe(true);
		// With nothing saved, the persisted selection falls back to VIF Light.
		expect(pressedStates()).toEqual(["true", "false", "false"]);
	});

	it("applies and saves the chosen theme without a toast, then follows the system", async () => {
		const omp = installMockOmp({ themeName: "light" });
		await mount(<ThemeCards />);

		await click(card("VIF Navy"));
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(useUiStore.getState().theme).toBe("dark");
		expect(card("VIF Navy").getAttribute("aria-pressed")).toBe("true");
		expect(pressedStates()).toEqual(["false", "true", "false"]);
		expect(omp.prefs.set).toHaveBeenCalledWith("themeName", "dark");
		expect(omp.prefs.set).toHaveBeenCalledWith("theme", "dark");

		await click(card("System"));
		expect(useUiStore.getState().theme).toBe("system");
		expect(pressedStates()).toEqual(["false", "false", "true"]);
		expect(omp.prefs.set).toHaveBeenCalledWith("themeName", "system");
		expect(omp.prefs.set).toHaveBeenCalledWith("theme", "system");
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("lights VIF Navy for a legacy dark preference with no named theme", async () => {
		installMockOmp({ theme: "dark" });
		await mount(<ThemeCards />);

		expect(pressedStates()).toEqual(["false", "true", "false"]);
	});

	it("leaves every card unpressed while another named theme is saved", async () => {
		installMockOmp({ themeName: "nord", theme: "dark" });
		await mount(<ThemeCards />);

		expect(pressedStates()).toEqual(["false", "false", "false"]);
	});
});
