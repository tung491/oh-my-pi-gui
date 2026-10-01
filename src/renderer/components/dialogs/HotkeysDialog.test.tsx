import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	QuickEntryShortcutResult,
	QuickEntryShortcutState,
	QuickEntryShortcutUpdate,
} from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { KEYMAP_ACTIONS, RESERVED_CHORDS } from "../../lib/keymap";
import { en } from "../../locales/en";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { HotkeysDialog } from "./HotkeysDialog";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<HotkeysDialog open />
			</I18nProvider>,
		);
	});
	await flush();
}

/** The chord of every rendered row, in document order (the panel portals to body). */
function displayedChords(): string[] {
	return [...document.body.querySelectorAll("kbd")].map(cell => cell.textContent ?? "");
}

const REGISTERED: QuickEntryShortcutState = {
	chord: "⇧⌃␣",
	enabled: true,
	mode: "native",
	status: "registered",
	restartRequired: false,
	desktopEntryMissing: false,
	xwaylandOnly: false,
};

/** A Linux bridge whose quick-entry calls land in `calls`, in order. */
function stubQuickEntry(initial: QuickEntryShortcutState = REGISTERED) {
	const calls: string[] = [];
	let state = initial;
	const quickEntry = {
		getShortcut: vi.fn(async () => state),
		setShortcut: vi.fn(async (update: QuickEntryShortcutUpdate): Promise<QuickEntryShortcutResult> => {
			calls.push(`set ${JSON.stringify(update)}`);
			if ("chord" in update) state = { ...state, chord: update.chord, enabled: true, status: "registered" };
			if ("enabled" in update)
				state = { ...state, enabled: update.enabled, status: update.enabled ? "registered" : "off" };
			return { ok: true, state };
		}),
		suspendShortcuts: vi.fn((suspended: boolean) => {
			calls.push(`suspend ${suspended}`);
		}),
	};
	(window as unknown as { omp: unknown }).omp = { platform: "linux", quickEntry };
	return { quickEntry, calls };
}

/** The quick-entry row: the element holding its label and its controls. */
function quickEntryRow(): Element {
	const label = [...document.body.querySelectorAll("span")].find(
		span => span.textContent === en["hotkeys.row.quickEntry"],
	);
	const row = label?.parentElement?.parentElement;
	if (!row) throw new Error("quick entry row not rendered");
	return row as unknown as Element;
}

function buttonIn(scope: Element, name: string): Element {
	const button = [...scope.querySelectorAll("button")].find(
		candidate => candidate.getAttribute("aria-label") === name || candidate.textContent === name,
	);
	if (!button) throw new Error(`no "${name}" button`);
	return button;
}

async function click(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function pressChord(key: string, code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean }) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		key: { value: key },
		code: { value: code },
		ctrlKey: { value: mods.ctrl ?? false },
		altKey: { value: mods.alt ?? false },
		shiftKey: { value: mods.shift ?? false },
		metaKey: { value: false },
	});
	await act(async () => {
		window.dispatchEvent(event);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	useUiStore.setState({ keymapOverrides: {} });
	useToastStore.setState({ toasts: [] });
	Reflect.deleteProperty(window, "omp");
});

describe("HotkeysDialog", () => {
	it("renders one row for every remappable action and every chord the app owns", async () => {
		// The dialog is derived from the keymap tables. A row missing here is an
		// action nobody can discover or remap, and a duplicated one offers two
		// editors for the same binding.
		await mount();
		const chords = displayedChords();
		for (const action of KEYMAP_ACTIONS) {
			const displayed = action.defaults.join(" / ");
			expect(
				chords.filter(chord => chord === displayed),
				action.id,
			).toHaveLength(1);
		}
		for (const entry of RESERVED_CHORDS) {
			expect(
				chords.filter(chord => chord === entry.chord),
				entry.id,
			).toHaveLength(1);
		}
	});

	it("shows a user override instead of the default it replaced", async () => {
		// A remapped action's old chord is dead; listing both tells the user a key
		// works that no longer does.
		useUiStore.setState({ keymapOverrides: { retry: ["⌥⇧R"] } });
		await mount();
		const chords = displayedChords();
		expect(chords).toContain("⌥⇧R");
		expect(chords).not.toContain("⌥R");
	});

	it("lists Ctrl chords as text on Linux", async () => {
		(window as unknown as { omp: { platform: string } }).omp = { platform: "linux" };
		await mount();
		const chords = displayedChords();
		expect(chords).toContain("Ctrl+Shift+T / Shift+Super+T");
		expect(chords).toContain("Ctrl+W / Super+W");
		expect(chords).toContain("Ctrl+Shift+O");
		expect(chords).toContain("Shift+Enter");
		expect(chords).toContain("Unbound");
		expect(chords.filter(chord => /[⌘⌃⌥⇧]/.test(chord))).toEqual([]);
	});

	it("lists the quick-entry chord main reports, in the platform's spelling", async () => {
		stubQuickEntry();
		await mount();
		expect(quickEntryRow().querySelector("kbd")?.textContent).toBe("Ctrl+Shift+Space");
	});

	it("releases the shortcut suspension before main rebinds, then saves once", async () => {
		// Main cannot register a new chord while handling is suspended.
		const { quickEntry, calls } = stubQuickEntry();
		await mount();
		await click(buttonIn(quickEntryRow(), en["hotkeys.remap.rebind"]));
		expect(calls).toEqual(["suspend true"]);
		await pressChord("K", "KeyK", { alt: true, shift: true });
		await click(buttonIn(document.body as unknown as Element, en["common.save"]));
		expect(calls.slice(0, 3)).toEqual(["suspend true", "suspend false", 'set {"chord":"⌥⇧K"}']);
		expect(quickEntry.setShortcut).toHaveBeenCalledTimes(1);
		expect(quickEntryRow().querySelector("kbd")?.textContent).toBe("Alt+Shift+K");
	});

	it("turns the shortcut off through main", async () => {
		const { quickEntry } = stubQuickEntry();
		await mount();
		await click(buttonIn(quickEntryRow(), en["hotkeys.quickEntry.disable"]));
		expect(quickEntry.setShortcut).toHaveBeenCalledWith({ enabled: false });
		expect(quickEntryRow().querySelector("kbd")?.textContent).toBe(en["hotkeys.quickEntry.off"]);
	});

	it("says the desktop owns a portal binding and that a change waits for a restart", async () => {
		stubQuickEntry({ ...REGISTERED, mode: "portal", status: "requested", restartRequired: true });
		await mount();
		const text = quickEntryRow().textContent ?? "";
		expect(text).toContain("sai-atlas --quick-entry");
		expect(text).toContain(en["hotkeys.quickEntry.restart"]);
	});

	it("names the ⌘ forms after the Windows key on Windows", async () => {
		(window as unknown as { omp: { platform: string } }).omp = { platform: "win32" };
		await mount();
		const chords = displayedChords();
		expect(chords).toContain("Ctrl+W / Win+W");
		expect(chords).toContain("Ctrl+Shift+T / Shift+Win+T");
		expect(chords.filter(chord => /Super|[⌘⌃⌥⇧]/.test(chord))).toEqual([]);
	});
});
