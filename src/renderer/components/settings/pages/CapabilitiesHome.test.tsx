/**
 * The Settings landing page: it introduces Sai ATLAS in plain words, offers
 * only what an assistant session can do, and keeps its kept targets working.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { en } from "../../../locales/en";
import { vi } from "../../../locales/vi";
import { CapabilitiesHome, type CapabilityTarget } from "./CapabilitiesHome";

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

const realLocalStorage = globals.localStorage;

function setLanguage(lang: "en" | "vi"): void {
	globals.localStorage = {
		getItem: (key: string) => (key === "omp.lang" ? lang : null),
		setItem: () => {},
		removeItem: () => {},
	};
}

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	remove: () => void;
	dispatchEvent: (event: unknown) => boolean;
	querySelectorAll: (selector: string) => TestElement[];
}

let container: TestElement;
let root: Root;
let opened: CapabilityTarget[];
let commandCenterOpened: number;

async function mountPage(): Promise<void> {
	opened = [];
	commandCenterOpened = 0;
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<CapabilitiesHome
					onOpenCommandCenter={() => {
						commandCenterOpened++;
					}}
					onOpenTarget={target => {
						opened.push(target);
					}}
				/>
			</I18nProvider>,
		);
	});
}

async function clickButton(label: string): Promise<void> {
	const button = container.querySelectorAll("button").find(candidate => candidate.textContent === label);
	expect(button, `button "${label}"`).toBeDefined();
	await act(async () => {
		button?.dispatchEvent(new Event("click", { bubbles: true }));
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
	globals.localStorage = realLocalStorage;
});

describe("CapabilitiesHome", () => {
	it("introduces Sai ATLAS without naming OMP, in both languages", async () => {
		for (const [lang, locale] of [
			["en", en],
			["vi", vi],
		] as const) {
			setLanguage(lang);
			await mountPage();
			const text = container.textContent ?? "";
			expect(text).toContain(locale["settings.capabilities.title"]);
			expect(text).toContain("Sai ATLAS");
			expect(text).not.toMatch(/\bOMP\b/);
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
		// The afterEach unmount needs a live root.
		await mountPage();
	});

	it("does not offer developer commands or features assistant sessions lack", async () => {
		setLanguage("en");
		await mountPage();
		const text = container.textContent ?? "";
		for (const key of ["cmd.btw", "cmd.tan", "cmd.omfg", "cmd.queue", "cmd.dump", "cmd.fork", "cmd.jobs", "cmd.hub"])
			expect(text).not.toContain(en[key]);
		for (const removed of ["TTSR", "Advisor", "advisor", "memory", "Memory", "Agent Hub", "Claude", "Codex", "/"])
			expect(text).not.toContain(removed);
	});

	it("opens every kept target from its button", async () => {
		setLanguage("en");
		await mountPage();
		await clickButton(en["settings.capabilities.openCommandCenter"]);
		await clickButton(en["cmd.model"]);
		await clickButton(en["cmd.providers"]);
		await clickButton(en["settings.tabs.updates"]);
		expect(commandCenterOpened).toBe(1);
		expect(opened).toEqual(["model", "providers", "updates"]);
	});

	it("routes no button to a removed command", async () => {
		setLanguage("en");
		await mountPage();
		for (const button of container.querySelectorAll("button")) {
			await act(async () => {
				button.dispatchEvent(new Event("click", { bubbles: true }));
			});
		}
		for (const removed of ["btw", "tan", "omfg", "queue", "dump", "fork", "jobs"])
			expect(opened).not.toContain(removed);
	});
});
