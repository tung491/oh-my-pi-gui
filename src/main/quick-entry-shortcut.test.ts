/**
 * The shortcut glue drives Electron's globalShortcut, where the order of calls
 * matters: registration fails while handling is suspended, a refused or
 * unparsable chord must leave the old one working, and a portal session binds
 * once, so nothing may register after startup there.
 */

import { describe, expect, it } from "vitest";
import type { QuickEntryShortcutPref } from "../shared/ipc-types";
import { QuickEntryShortcut, type ShortcutRegistry } from "./quick-entry-shortcut";
import type { ShortcutMode } from "./quick-entry-shortcut-core";

const DEFAULT_ACCELERATOR = "Control+Shift+Space";

/** A globalShortcut stand-in: records every call and lets a test refuse or throw per accelerator. */
function fakeRegistry(outcomes: Record<string, "refuse" | "throw"> = {}) {
	const calls: string[] = [];
	const bound = new Map<string, () => void>();
	const registry: ShortcutRegistry = {
		register(accelerator, callback) {
			calls.push(`register ${accelerator}`);
			if (outcomes[accelerator] === "throw") throw new Error(`conversion failure from ${accelerator}`);
			if (outcomes[accelerator] === "refuse") return false;
			bound.set(accelerator, callback);
			return true;
		},
		unregister(accelerator) {
			calls.push(`unregister ${accelerator}`);
			bound.delete(accelerator);
		},
		setSuspended(suspended) {
			calls.push(`suspend ${suspended}`);
		},
	};
	return { registry, calls, bound };
}

function shortcut(mode: ShortcutMode, registry: ShortcutRegistry, saved?: QuickEntryShortcutPref) {
	const saves: QuickEntryShortcutPref[] = [];
	let activations = 0;
	const instance = new QuickEntryShortcut({
		registry,
		log: () => {},
		readPref: () => saved,
		savePref: pref => saves.push(pref),
		mode,
		desktopEntryMissing: false,
		xwaylandOnly: false,
		onActivate: () => {
			activations += 1;
		},
	});
	return { instance, saves, activations: () => activations };
}

describe("native rebinding", () => {
	it("resumes handling before it registers, and re-suspends while another window still captures", () => {
		const { registry, calls } = fakeRegistry();
		const { instance } = shortcut("native", registry);
		instance.registerAtStartup();
		instance.setSuspended(1, true);
		instance.setSuspended(2, true);
		calls.length = 0;
		expect(instance.update(1, { chord: "⌥⇧K" }).ok).toBe(true);
		expect(calls).toEqual([
			"suspend false",
			`unregister ${DEFAULT_ACCELERATOR}`,
			"register Alt+Shift+K",
			"suspend true",
		]);
	});

	it("puts the old chord back when the system refuses the new one", () => {
		const { registry, calls, bound } = fakeRegistry({ "Alt+Shift+K": "refuse" });
		const { instance, saves } = shortcut("native", registry);
		instance.registerAtStartup();
		const result = instance.update(1, { chord: "⌥⇧K" });
		expect(result).toMatchObject({ ok: false, reason: "refused", state: { chord: "⇧⌃␣", status: "registered" } });
		expect(calls.at(-2)).toBe(`register ${DEFAULT_ACCELERATOR}`);
		expect([...bound.keys()]).toEqual([DEFAULT_ACCELERATOR]);
		expect(saves).toEqual([]);
	});

	it("treats a register that throws as a refusal and keeps the old chord", () => {
		const { registry, bound } = fakeRegistry({ "Alt+Shift+K": "throw" });
		const { instance } = shortcut("native", registry);
		instance.registerAtStartup();
		expect(instance.update(1, { chord: "⌥⇧K" })).toMatchObject({ ok: false, reason: "refused" });
		expect([...bound.keys()]).toEqual([DEFAULT_ACCELERATOR]);
	});
});

describe("startup", () => {
	it("survives a register that throws and reports the refusal once", () => {
		const { registry } = fakeRegistry({ [DEFAULT_ACCELERATOR]: "throw" });
		const { instance } = shortcut("native", registry);
		expect(() => instance.registerAtStartup()).not.toThrow();
		expect(instance.takeStartupNotice()?.status).toBe("refused");
		expect(instance.takeStartupNotice()).toBeNull();
	});

	it("registers nothing for a saved shortcut that is off", () => {
		const { registry, calls } = fakeRegistry();
		const { instance } = shortcut("native", registry, { chord: "⌥⇧K", enabled: false });
		instance.registerAtStartup();
		expect(calls).toEqual([]);
		expect(instance.state().status).toBe("off");
	});
});

describe("portal session", () => {
	it("only saves a change, and a disable mutes the chord bound at startup", () => {
		const { registry, calls, bound } = fakeRegistry();
		const { instance, saves, activations } = shortcut("portal", registry);
		instance.registerAtStartup();
		calls.length = 0;
		expect(instance.update(1, { chord: "⌥⇧K" }).state.restartRequired).toBe(true);
		instance.update(1, { enabled: false });
		expect(calls).toEqual([]);
		expect(saves.at(-1)).toEqual({ chord: "⌥⇧K", enabled: false });
		bound.get(DEFAULT_ACCELERATOR)?.();
		expect(activations()).toBe(0);
	});
});
