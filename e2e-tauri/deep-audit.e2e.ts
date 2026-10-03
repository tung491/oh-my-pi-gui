/**
 * The deep GUI audit against the real bundled sidecar: every settings page and
 * control, every schema entry written, read back and restored through its
 * row, and every command discoverable in the palette. Mirrors
 * e2e/deep-audit.e2e.ts; WebDriver stands in for Playwright's locators.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { writeDesktopPrefs } from "../e2e/desktop-prefs";
import { keyboardPlatformOf } from "../src/renderer/lib/keymap";
import { effectiveShortcut } from "../src/renderer/lib/shortcut-hint";
import type { SettingEntry, SettingsSchemaResult } from "../src/shared/rpc-types";
import {
	awaitBridge,
	byRole,
	exactTextCount,
	fill,
	lastExactText,
	launch,
	nodeOf,
	queryRole,
	ROOT,
	textOf,
	until,
} from "./session";
import { runtimeFacts } from "./test-hooks";

type JsonRecord = Record<string, unknown>;

interface SettingAuditRow {
	path: string;
	type: SettingEntry["type"];
	tab?: string;
	condition?: string;
	tuiOnly: boolean;
	restartRequired: boolean;
	secret: boolean;
	initial: unknown;
	rowFound: boolean;
	control: {
		buttons: string[];
		inputs: Array<{ type: string; value: string; ariaLabel: string | null }>;
		selects: Array<{ value: string; optionCount: number; ariaLabel: string | null }>;
		textareas: number;
	};
	visibility:
		| "visible"
		| "advanced"
		| "hidden-by-condition"
		| "filtered-tui-only"
		| "filtered-terminal-only"
		| "no-gui-metadata";
	write: "passed" | "skipped-secret" | "skipped-unsafe" | "skipped-no-control" | "failed" | "not-run";
	readback: "passed" | "not-run" | "failed";
	restore: "passed" | "rpc-fallback" | "not-run" | "failed";
	initialAfter?: unknown;
	changedTo?: unknown;
	readbackValue?: unknown;
	error?: string;
	notes: string[];
}

interface SurfaceControl {
	page: string;
	kind: string;
	name: string;
	disabled: boolean;
	role: string | null;
	selectorHint: string;
}

interface DeepAuditEvidence {
	startedAt: string;
	finishedAt?: string;
	profile: string;
	runtime: JsonRecord;
	schema: { entryCount: number; tabCount: number; entriesWithUi: number; advanced: number; tuiOnly: number };
	settingsPages: Array<{ group: string; page: string; controls: SurfaceControl[] }>;
	settings: SettingAuditRow[];
	commands: {
		availableCount: number;
		names: string[];
		paletteTopLevelCount: number;
		paletteSearchMissing: string[];
		tuiOnlyNames: string[];
		nestedSurfaces: Array<{ name: string; controls: SurfaceControl[]; status: "opened" | "failed"; error?: string }>;
		error?: string;
	};
	limitations: string[];
}

const TERMINAL_DISPLAY_PATHS = new Set([
	"tui.resizeScrollback",
	"statusLine.preset",
	"display.showTurnTime",
	"theme.dark",
	"theme.light",
	"tui.tight",
	"colorBlindMode",
	"hideThinkingBlock",
	"proseOnlyThinking",
	"display.showTokenUsage",
	"display.collapseCompacted",
	"tui.titleState",
	"goal.statusInFooter",
	"terminal.showProgress",
	"emojiAutocomplete",
	"paste.largeMenuThreshold",
	"spelling.typoDetection",
	"spelling.autocomplete",
	"spelling.autocorrect",
	"tui.vimModeDisplay",
	"tui.mouse",
	"tui.maxInlineImageColumns",
	"tui.maxInlineImageRows",
	"tui.maxInlineImages",
	"statusLine.leftSegments",
	"statusLine.rightSegments",
	"statusLine.segmentOptions",
]);

const DIALOG = '[role="dialog"]';
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const SETTINGS_SEARCH = '[placeholder^="Search settings"]';
const TEXTBOX =
	'input:not([type]), input[type="text"], input[type="search"], textarea, [role="textbox"], [role="combobox"]';

/** The row of one setting, as a CSS selector (dots in the path escaped). */
function settingRow(pathName: string): string {
	return `#setting-${pathName.replaceAll(".", "\\.")}`;
}

async function readSetting(pathName: string): Promise<unknown> {
	// Serialized in the page: WebDriver would turn an unset (undefined) value into null.
	const reply = JSON.parse(
		await browser.execute(async (pathValue: string) => {
			const response = await window.omp.rpc.getSettings([pathValue]);
			if (!response.success) return JSON.stringify({ error: response.error ?? "getSettings failed" });
			const values = (response.data as { values?: Record<string, unknown> } | undefined)?.values;
			return JSON.stringify({ value: values?.[pathValue] });
		}, pathName),
	) as { value?: unknown; error?: string };
	if (reply.error) throw new Error(reply.error);
	return reply.value;
}

async function writeSetting(pathName: string, value: unknown): Promise<JsonRecord> {
	const reply = JSON.parse(
		await browser.execute(
			async (pathValue: string, serialized: string) => {
				const next = serialized === "undefined" ? undefined : (JSON.parse(serialized) as unknown);
				const response = await window.omp.rpc.setSetting(pathValue, next);
				return JSON.stringify(response.success ? { data: response.data ?? {} } : { error: response.error });
			},
			pathName,
			value === undefined ? "undefined" : JSON.stringify(value),
		),
	) as { data?: JsonRecord; error?: string };
	if (reply.error !== undefined) throw new Error(reply.error);
	return reply.data ?? {};
}

async function pollSetting(pathName: string, expected: unknown): Promise<unknown> {
	const same = (value: unknown) => JSON.stringify(value) === JSON.stringify(expected);
	expect(await until(() => readSetting(pathName), same, { timeout: 8_000 })).toEqual(expected);
	return readSetting(pathName);
}

async function restoreInitial(pathName: string, initial: unknown): Promise<"passed"> {
	if (initial === undefined) {
		const reset = await byRole("button", {
			name: "Remove global override",
			exact: true,
			within: settingRow(pathName),
		});
		await expect(reset).toBeDisplayed();
		await expect(reset).toBeEnabled();
		await reset.click();
		await pollSetting(pathName, undefined);
	}
	return "passed";
}

async function inspectRow(row: string): Promise<SettingAuditRow["control"]> {
	return browser.execute(
		(element: HTMLElement) => ({
			buttons: Array.from(element.querySelectorAll("button")).map(
				button => button.getAttribute("aria-label") ?? button.innerText.trim(),
			),
			inputs: Array.from(element.querySelectorAll("input")).map(input => ({
				type: input.type,
				value: input.value,
				ariaLabel: input.getAttribute("aria-label"),
			})),
			selects: Array.from(element.querySelectorAll("select")).map(select => ({
				value: select.value,
				optionCount: select.options.length,
				ariaLabel: select.getAttribute("aria-label"),
			})),
			textareas: element.querySelectorAll("textarea").length,
		}),
		await nodeOf(row),
	);
}

function equalJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function alternateOption(entry: SettingEntry, value: unknown): unknown {
	const options = entry.options ?? [];
	const current = typeof value === "string" || typeof value === "number" ? String(value) : "";
	const alternate = options.find(option => option.value !== current);
	if (!alternate) return undefined;
	if (entry.type === "number") return Number(alternate.value);
	return alternate.value;
}

function alternateNumber(input: {
	value: string;
	min: string | null;
	max: string | null;
	step: string | null;
}): number | undefined {
	const current = Number(input.value);
	const min = input.min === null || input.min === "" ? Number.NEGATIVE_INFINITY : Number(input.min);
	const max = input.max === null || input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
	const step =
		input.step === null || input.step === "" || input.step === "any" ? 1 : Math.abs(Number(input.step)) || 1;
	const candidates = [current + step, current - step, 1, 0];
	return candidates.find(
		candidate => Number.isFinite(candidate) && candidate >= min && candidate <= max && candidate !== current,
	);
}

function safeStringValue(entry: SettingEntry, profile: string): string {
	if (entry.path.includes("Url") || entry.path.toLowerCase().includes("url")) return "http://127.0.0.1:9/gui-audit";
	if (entry.path.toLowerCase().includes("path") || entry.path.includes("directory")) return profile;
	if (entry.path.includes("interpreter")) return "/usr/bin/python3";
	return `__gui_audit__${entry.path.replaceAll(".", "_")}`;
}

function isUnsafeString(entry: SettingEntry): boolean {
	return entry.secret === true || entry.path === "images.urls.command" || entry.path === "collab.relayUrl";
}

function conditionGate(condition: string | undefined): Array<{ path: string; value: unknown }> {
	const gates: Record<string, Array<{ path: string; value: unknown }>> = {
		advisorEnabled: [{ path: "advisor.enabled", value: true }],
		hindsightActive: [{ path: "memory.backend", value: "hindsight" }],
		mnemopiActive: [{ path: "memory.backend", value: "mnemopi" }],
		autolearnActive: [{ path: "autolearn.enabled", value: true }],
		autoThinkingActive: [{ path: "defaultThinkingLevel", value: "auto" }],
		usageAwareFallbackEnabled: [{ path: "retry.usageAwareFallback", value: true }],
		planModeEnabled: [{ path: "plan.enabled", value: true }],
		planAutosaveEnabled: [
			{ path: "plan.enabled", value: true },
			{ path: "plan.autosave", value: true },
		],
		unexpectedStopDetection: [{ path: "features.unexpectedStopDetection", value: true }],
	};
	return condition === undefined ? [] : (gates[condition] ?? []);
}

async function clickSearchResult(pathName: string): Promise<boolean> {
	await fill($(SETTINGS_SEARCH), pathName);
	if ((await exactTextCount(pathName)) === 0) return false;
	const last = await lastExactText(pathName);
	if (!last) return false;
	await last.click();
	return true;
}

async function captureSurfaceControls(pageName: string): Promise<SurfaceControl[]> {
	return browser.execute(
		(currentPage: string) =>
			Array.from(
				document.querySelectorAll(
					".settings-content button, .settings-content input, .settings-content select, .settings-content textarea",
				),
			).map((element, index) => ({
				page: currentPage,
				kind: element.tagName.toLowerCase(),
				name:
					element.getAttribute("aria-label") ??
					(element instanceof HTMLInputElement && element.placeholder ? element.placeholder : null) ??
					element.textContent?.trim() ??
					"",
				disabled:
					element instanceof HTMLButtonElement ||
					element instanceof HTMLInputElement ||
					element instanceof HTMLSelectElement ||
					element instanceof HTMLTextAreaElement
						? element.disabled
						: element.hasAttribute("disabled"),
				role: element.getAttribute("role"),
				selectorHint: `${element.tagName.toLowerCase()}[data-audit-index="${index}"]`,
			})),
		pageName,
	);
}

/** How many elements match the selector right now (Playwright's `count()`). */
function countOf(selector: string): Promise<number> {
	return browser.execute((all: string) => document.querySelectorAll(all).length, selector);
}

/** Playwright's `locator.press(key)`: focus the element, then press. */
async function press(element: WebdriverIO.Element, key: string): Promise<void> {
	await browser.execute((field: HTMLElement) => field.focus(), element as unknown as HTMLElement);
	await browser.keys(key);
}

/** The last element matching `selector` whose text contains `text`, or null. */
async function lastWithText(selector: string, text: string): Promise<WebdriverIO.Element | null> {
	const found = await browser.execute(
		(all: string, wanted: string) => {
			const matches = Array.from(document.querySelectorAll(all)).filter(element =>
				element.textContent?.includes(wanted),
			);
			return matches[matches.length - 1] ?? null;
		},
		selector,
		text,
	);
	return found ? $(found as unknown as WebdriverIO.Element).getElement() : null;
}

/** Run an assertion; when it fails, prefix its message with what was measured. */
function labelled(label: string, assertion: () => void): void {
	try {
		assertion();
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The last button inside `within` whose name (aria-label, else text) matches `pattern`, or null. */
async function lastButtonNamed(within: string, pattern: RegExp): Promise<WebdriverIO.Element | null> {
	const found = await browser.execute(
		(root: string, source: string, flags: string) => {
			const matcher = new RegExp(source, flags);
			const matches = Array.from(document.querySelectorAll<HTMLElement>(`${root} button`)).filter(button =>
				matcher.test(button.getAttribute("aria-label") ?? button.innerText),
			);
			return matches[matches.length - 1] ?? null;
		},
		within,
		pattern.source,
		pattern.flags,
	);
	return found ? $(found as unknown as WebdriverIO.Element).getElement() : null;
}

/** The last element matching the selector, or null. */
async function lastOf(selector: string): Promise<WebdriverIO.Element | null> {
	const all = await $$(selector).getElements();
	return all.length > 0 ? all[all.length - 1] : null;
}

async function mutateEntry(
	row: string,
	entry: SettingEntry,
	initial: unknown,
	profile: string,
): Promise<
	Pick<SettingAuditRow, "write" | "readback" | "restore" | "changedTo" | "readbackValue" | "error" | "notes">
> {
	const notes: string[] = [];
	if (entry.secret === true) {
		const reveal = await queryRole("button", { name: /Reveal|显示/, within: row });
		if (reveal) {
			await reveal.click();
			notes.push("secret reveal control opened; value was not written");
		}
		return { write: "skipped-secret", readback: "not-run", restore: "not-run", notes };
	}
	if (isUnsafeString(entry)) {
		return {
			write: "skipped-unsafe",
			readback: "not-run",
			restore: "not-run",
			notes: ["write skipped to avoid starting an external uploader/relay from an audit run"],
		};
	}
	try {
		if (entry.type === "boolean") {
			const TOGGLE = `${row} button[role="switch"]`;
			if ((await countOf(TOGGLE)) === 0)
				return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			const toggle = $(TOGGLE);
			const next = initial !== true;
			await toggle.click();
			const readbackValue = await pollSetting(entry.path, next);
			if (initial === undefined) {
				const restore = await restoreInitial(entry.path, initial);
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			}
			await toggle.click();
			await pollSetting(entry.path, initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		const SELECT = `${row} select`;
		if (
			entry.type === "enum" ||
			(entry.type === "number" && entry.options && entry.options.length > 0 && (await countOf(SELECT)) > 0)
		) {
			const next = alternateOption(entry, initial);
			if (next === undefined) return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			await $(SELECT).selectByAttribute("value", String(next));
			const readbackValue = await pollSetting(entry.path, next);
			if (initial === undefined) {
				const restore = await restoreInitial(entry.path, initial);
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			}
			await $(SELECT).selectByAttribute("value", initial === undefined ? "" : String(initial));
			await pollSetting(entry.path, initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		if (entry.type === "number") {
			const NUMBER = `${row} input[type="number"], ${row} input[inputmode="numeric"]`;
			if ((await countOf(NUMBER)) === 0)
				return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			const input = await $(NUMBER).getElement();
			const metadata = await browser.execute(
				(element: HTMLInputElement) => ({
					value: element.value,
					min: element.getAttribute("min"),
					max: element.getAttribute("max"),
					step: element.getAttribute("step"),
				}),
				input as unknown as HTMLInputElement,
			);
			const next = alternateNumber(metadata);
			if (next === undefined) return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			await fill(input, String(next));
			await press(input, "Enter");
			const readbackValue = await pollSetting(entry.path, next);
			if (initial === undefined) {
				const restore = await restoreInitial(entry.path, initial);
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			}
			await fill(input, String(initial));
			await press(input, "Enter");
			await pollSetting(entry.path, initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		if (entry.type === "string") {
			// Model/provider references use the searchable picker, which supports a
			// custom value even when the isolated audit profile has no catalog rows.
			if (/(model|provider)$/i.test(entry.path) || entry.path === "shellPath") {
				const TRIGGER = `${row} button[aria-haspopup="listbox"]`;
				if ((await countOf(TRIGGER)) > 0) {
					const marker =
						entry.path === "shellPath" ? "/bin/sh" : `__gui_audit__/${entry.path.replaceAll(".", "_")}`;
					await $(TRIGGER).click();
					const pickerInput = await lastOf(`${row} input`);
					if (pickerInput) await expect(pickerInput).toBeDisplayed();
					if (pickerInput) {
						await fill(pickerInput, marker);
						const OPTIONS = `${row} [role="listbox"] button`;
						const custom = await until(
							() => lastWithText(OPTIONS, marker),
							found => found !== null,
						);
						if (custom) await expect(custom).toBeDisplayed();
						if (custom) {
							await custom.click();
							const readbackValue = await pollSetting(entry.path, marker);
							if (initial === undefined) {
								const restore = await restoreInitial(entry.path, initial);
								return {
									write: "passed",
									readback: "passed",
									restore,
									changedTo: marker,
									readbackValue,
									notes,
								};
							}
							await $(TRIGGER).click();
							if (initial === "") {
								await (await byRole("button", { name: /Clear|清除/, within: row })).click();
							} else {
								await fill(pickerInput, String(initial));
								const original = await until(
									() => lastWithText(OPTIONS, String(initial)),
									found => found !== null,
								);
								if (!original) throw new Error(`no picker row for ${String(initial)}`);
								await original.click();
							}
							await pollSetting(entry.path, initial == null ? "" : initial);
							return {
								write: "passed",
								readback: "passed",
								restore: "passed",
								changedTo: marker,
								readbackValue,
								notes,
							};
						}
					}
					await browser.keys("Escape");
				}
			}
			const FIELD = `${row} input, ${row} textarea`;
			if ((await countOf(FIELD)) === 0)
				return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			const input = await $(FIELD).getElement();
			const next = safeStringValue(entry, profile);
			await fill(input, next);
			await press(input, "Enter").catch(() =>
				browser.execute((field: HTMLElement) => field.blur(), input as unknown as HTMLElement),
			);
			const readbackValue = await pollSetting(entry.path, next);
			const restore = await restoreInitial(entry.path, initial);
			if (initial === undefined)
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			await fill(input, initial == null ? "" : String(initial));
			await press(input, "Enter").catch(() =>
				browser.execute((field: HTMLElement) => field.blur(), input as unknown as HTMLElement),
			);
			await pollSetting(entry.path, initial == null ? "" : initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		if (entry.type === "array") {
			const INPUT = `${row} input`;
			const SELECT_CONTROL = `${row} select`;
			const TEXTAREA = `${row} textarea`;
			if ((await countOf(TEXTAREA)) > 0) {
				const textarea = await $(TEXTAREA).getElement();
				const changed =
					entry.path === "bash.patterns"
						? [{ match: "echo gui-audit-block", approval: "deny" }]
						: ["__gui_audit__"];
				await fill(textarea, JSON.stringify(changed, null, 2));
				await (await byRole("button", { name: /Apply|应用/, within: row })).click();
				const readbackValue = await pollSetting(entry.path, changed);
				await fill(textarea, JSON.stringify(initial ?? [], null, 2));
				await (await byRole("button", { name: /Apply|应用/, within: row })).click();
				await pollSetting(entry.path, initial ?? []);
				return { write: "passed", readback: "passed", restore: "passed", changedTo: changed, readbackValue, notes };
			}
			if (Array.isArray(initial) && initial.length > 0) {
				const first = String(initial[0]);
				const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const remove = await queryRole("button", { name: new RegExp(`Remove ${escaped}`), within: row });
				if (remove) {
					await remove.click();
					const changed = initial.slice(1);
					await pollSetting(entry.path, changed);
					// Chip editors append new values, so adding the removed first chip
					// back would change an ordered list. Restore the exact order through
					// the same RPC used by the row after proving the UI removal/readback.
					await writeSetting(entry.path, initial);
					await pollSetting(entry.path, initial);
					return {
						write: "passed",
						readback: "passed",
						restore: "rpc-fallback",
						changedTo: changed,
						readbackValue: changed,
						notes: ["restore used RPC to preserve ordered chip position"],
					};
				}
			}
			const down = await queryRole("button", { name: /Move .* down|下移/, within: row });
			if (down && (await down.isEnabled()) && Array.isArray(initial) && initial.length > 1) {
				const changed = [...initial];
				[changed[0], changed[1]] = [changed[1], changed[0]];
				await down.click();
				const readbackValue = await pollSetting(entry.path, changed);
				const up = await queryRole("button", {
					name: new RegExp(`Move ${String(changed[1])} up|上移`),
					within: row,
				});
				if (up) await up.click();
				else await writeSetting(entry.path, initial);
				await pollSetting(entry.path, initial);
				return { write: "passed", readback: "passed", restore: "passed", changedTo: changed, readbackValue, notes };
			}
			if ((await countOf(SELECT_CONTROL)) > 0 && (await $(SELECT_CONTROL).isEnabled())) {
				const options = await browser.execute(
					(select: HTMLSelectElement) => Array.from(select.options, option => option.value).filter(Boolean),
					(await $(SELECT_CONTROL).getElement()) as unknown as HTMLSelectElement,
				);
				const current = Array.isArray(initial) ? initial.map(value => String(value)) : [];
				const next = options.find(option => !current.includes(option));
				if (!next)
					return {
						write: "skipped-no-control",
						readback: "not-run",
						restore: "not-run",
						notes: ["ordered/fixed options already exhausted"],
					};
				await $(SELECT_CONTROL).selectByAttribute("value", next);
				const changed = [...current, next];
				const readbackValue = await pollSetting(entry.path, changed);
				await writeSetting(entry.path, initial);
				await pollSetting(entry.path, initial);
				return {
					write: "passed",
					readback: "passed",
					restore: "rpc-fallback",
					changedTo: changed,
					readbackValue,
					notes: ["restore used RPC because the chip remove label is localized"],
				};
			}
			if ((await countOf(INPUT)) > 0) {
				const input = await $(INPUT).getElement();
				const marker = `__gui_audit__${entry.path.replaceAll(".", "_")}`;
				await fill(input, marker);
				await press(input, "Enter");
				const changed = [...(Array.isArray(initial) ? initial : []), marker];
				const readbackValue = await pollSetting(entry.path, changed);
				const remove = await queryRole("button", { name: new RegExp(marker), within: row });
				if (remove) {
					await remove.click();
					await pollSetting(entry.path, initial);
					return {
						write: "passed",
						readback: "passed",
						restore: "passed",
						changedTo: changed,
						readbackValue,
						notes,
					};
				}
				await writeSetting(entry.path, initial);
				await pollSetting(entry.path, initial);
				return {
					write: "passed",
					readback: "passed",
					restore: "rpc-fallback",
					changedTo: changed,
					readbackValue,
					notes,
				};
			}
		}

		if (entry.type === "record") {
			const TEXTAREA = `${row} textarea`;
			if ((await countOf(TEXTAREA)) > 0) {
				const textarea = await $(TEXTAREA).getElement();
				const changed = {
					...(initial && typeof initial === "object" && !Array.isArray(initial) ? initial : {}),
					__gui_audit__: "ok",
				};
				await fill(textarea, JSON.stringify(changed, null, 2));
				await (await byRole("button", { name: /Apply|应用/, within: row })).click();
				const readbackValue = await pollSetting(entry.path, changed);
				await fill(textarea, JSON.stringify(initial ?? {}, null, 2));
				await (await byRole("button", { name: /Apply|应用/, within: row })).click();
				await pollSetting(entry.path, initial ?? {});
				return { write: "passed", readback: "passed", restore: "passed", changedTo: changed, readbackValue, notes };
			}
			if (entry.path === "providers.maxInFlightRequests") {
				const trigger = await queryRole("button", { name: /Add provider|添加提供商/, within: row });
				if (trigger) {
					const marker = "__gui_audit_provider__";
					await trigger.click();
					const pickerInput = await lastOf(`${row} input`);
					if (pickerInput) await expect(pickerInput).toBeDisplayed();
					if (pickerInput) {
						await fill(pickerInput, marker);
						const custom = await until(
							() => queryRole("button", { name: new RegExp(marker), within: row }),
							found => found !== null,
						);
						if (custom) await expect(custom).toBeDisplayed();
						if (custom) {
							await custom.click();
							const changed = { [marker]: 1 };
							const readbackValue = await pollSetting(entry.path, changed);
							const remove = await lastButtonNamed(row, /Remove|移除/);
							if (remove) await remove.click();
							else await writeSetting(entry.path, initial ?? {});
							await pollSetting(entry.path, initial ?? {});
							return {
								write: "passed",
								readback: "passed",
								restore: "passed",
								changedTo: changed,
								readbackValue,
								notes,
							};
						}
					}
					await browser.keys("Escape");
				}
			}
			const add = await queryRole("button", { name: /Add|添加/, within: row });
			if (add) {
				await add.click();
				const changed = await readSetting(entry.path);
				if (!changed || typeof changed !== "object" || Array.isArray(changed) || equalJson(changed, initial)) {
					// Escape only dismisses an open picker; with none open it closes the whole Settings window.
					if ((await countOf('[role="listbox"]')) > 0) await browser.keys("Escape");
					return {
						write: "skipped-no-control",
						readback: "not-run",
						restore: "not-run",
						notes: ["record editor has no available provider/key option"],
					};
				}
				const readbackValue = changed;
				await writeSetting(entry.path, initial ?? {});
				await pollSetting(entry.path, initial ?? {});
				return {
					write: "passed",
					readback: "passed",
					restore: "rpc-fallback",
					changedTo: changed,
					readbackValue,
					notes: ["record editor restore used RPC"],
				};
			}
		}
		return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
	} catch (error) {
		return { write: "failed", readback: "failed", restore: "failed", error: String(error), notes };
	}
}

describe("deep audit", () => {
	it("deep GUI audit: settings rows, nested controls, and command discoverability", async () => {
		const evidence: DeepAuditEvidence = {
			startedAt: new Date().toISOString(),
			profile: "",
			runtime: {},
			schema: { entryCount: 0, tabCount: 0, entriesWithUi: 0, advanced: 0, tuiOnly: 0 },
			settingsPages: [],
			settings: [],
			commands: {
				availableCount: 0,
				names: [],
				paletteTopLevelCount: 0,
				paletteSearchMissing: [],
				tuiOnlyNames: [],
				nestedSurfaces: [],
			},
			limitations: [
				"Runtime effect is classified as readback unless a separate consumer state is exposed by RPC; no provider/network command is executed.",
				"Destructive/external actions (delete, upload, login, publish, PR mutation) are enumerated but never confirmed in an audit profile.",
			],
		};
		try {
			const app = await launch({
				name: "deep-audit",
				omp: path.join(ROOT, "resources", "omp"),
				setup: async prepared => {
					await writeDesktopPrefs(prepared.desktop, {
						language: "en",
						firstRunComplete: true,
						launchProfiles: { [prepared.project]: { noRules: true, noLsp: true } },
					});
					await fs.writeFile(path.join(prepared.project, "README.md"), "# GUI deep audit\n");
				},
			});
			evidence.profile = app.dir;
			const profile = app.dir;
			await awaitBridge(browser, 90_000);
			expect(
				await until(
					async () => (await browser.execute(() => window.omp.sidecar.getStatus())).status,
					status => status === "ready",
					{ timeout: 90_000 },
				),
			).toBe("ready");
			evidence.runtime = { ...(await runtimeFacts(browser)) };

			await (await byRole("button", { name: "Settings", exact: true })).click();
			const settings = $(SETTINGS);
			await expect(settings).toBeDisplayed();
			await expect($(`${SETTINGS} .settings-nav-group-label`)).toBeDisplayed();
			const schemaResponse = await browser.execute(() => window.omp.rpc.getSettingsSchema());
			if (!schemaResponse.success) throw new Error(schemaResponse.error);
			const schema = schemaResponse.data as SettingsSchemaResult;
			// Serialized in the page: WebDriver would turn unset (undefined) values into null.
			const currentValues = JSON.parse(
				await browser.execute(async () => {
					const response = await window.omp.rpc.getSettings();
					if (!response.success) return JSON.stringify({ error: response.error ?? "getSettings failed" });
					return JSON.stringify({ values: (response.data as { values?: unknown } | undefined)?.values ?? {} });
				}),
			) as { values?: JsonRecord; error?: string };
			if (currentValues.error) throw new Error(currentValues.error);
			const values = currentValues.values ?? {};
			evidence.schema = {
				entryCount: schema.entries.length,
				tabCount: schema.tabs.length,
				entriesWithUi: schema.entries.filter(entry => entry.tab !== undefined).length,
				advanced: schema.entries.filter(entry => entry.tab === undefined).length,
				tuiOnly: schema.entries.filter(entry => entry.tuiOnly === true).length,
			};

			// Capture every settings page and every rendered control before mutating values.
			const GROUPS = `${SETTINGS} .settings-nav-group-label`;
			const PAGES = `${SETTINGS} .settings-nav-item`;
			const innerText = (selector: string, index: number) =>
				browser.execute(
					(all: string, at: number) => (document.querySelectorAll<HTMLElement>(all)[at]?.innerText ?? "").trim(),
					selector,
					index,
				);
			for (let groupIndex = 0; groupIndex < (await countOf(GROUPS)); groupIndex++) {
				await $$(GROUPS)[groupIndex].click();
				const groupName = await innerText(GROUPS, groupIndex);
				for (let pageIndex = 0; pageIndex < (await countOf(PAGES)); pageIndex++) {
					const pageName = await innerText(PAGES, pageIndex);
					await $$(PAGES)[pageIndex].click();
					expect(
						await until(
							() => countOf(`${SETTINGS} .settings-content .animate-spin`),
							spinners => spinners === 0,
							{ timeout: 30_000 },
						),
					).toBe(0);
					evidence.settingsPages.push({
						group: groupName,
						page: pageName,
						controls: await captureSurfaceControls(pageName),
					});
				}
			}

			// Exercise every schema entry that the GUI claims to support. TUI-only and
			// metadata-less entries remain explicit rows in the matrix instead of being silently dropped.
			for (const entry of schema.entries) {
				// A row that closed the window fails itself instead of every row after it.
				await expect(settings).toBeDisplayed();
				let initial = values[entry.path] ?? entry.value;
				const isTuiOnly = entry.tuiOnly === true;
				const isTerminalOnly = TERMINAL_DISPLAY_PATHS.has(entry.path);
				if (initial === undefined && !isTuiOnly && !isTerminalOnly) {
					initial = await readSetting(entry.path);
					initial ??= entry.default;
				}
				const base: SettingAuditRow = {
					path: entry.path,
					type: entry.type,
					tab: entry.tab,
					condition: entry.condition,
					tuiOnly: isTuiOnly,
					restartRequired: entry.restartRequired === true,
					secret: entry.secret === true,
					initial,
					rowFound: false,
					control: { buttons: [], inputs: [], selects: [], textareas: 0 },
					visibility: isTuiOnly
						? "filtered-tui-only"
						: isTerminalOnly
							? "filtered-terminal-only"
							: entry.tab
								? "hidden-by-condition"
								: "advanced",
					write: "not-run",
					readback: "not-run",
					restore: "not-run",
					notes: [],
				};
				if (base.visibility === "filtered-tui-only" || base.visibility === "filtered-terminal-only") {
					await fill($(SETTINGS_SEARCH), entry.path);
					expect(await exactTextCount(entry.path)).toBe(0);
					base.notes.push("GUI search absence verified");
					evidence.settings.push(base);
					continue;
				}
				const gates = conditionGate(entry.condition);
				const gateOriginals: Array<{ path: string; value: unknown }> = [];
				try {
					for (const gate of gates) {
						const originalGate = await readSetting(gate.path);
						gateOriginals.push({ path: gate.path, value: originalGate });
						if (!equalJson(originalGate, gate.value)) {
							await writeSetting(gate.path, gate.value);
							await pollSetting(gate.path, gate.value);
						}
					}
					// Search drives the same locator path a user sees, after the condition
					// gate has been opened through the real settings RPC.
					const found = await clickSearchResult(entry.path);
					if (!found) {
						base.notes.push("not in GUI search results after enabling its condition gate");
						evidence.settings.push(base);
						continue;
					}
					const row = settingRow(entry.path);
					if ((await countOf(row)) === 0) {
						base.notes.push("search result did not resolve to a setting row");
						evidence.settings.push(base);
						continue;
					}
					await expect($(row)).toBeDisplayed();
					base.rowFound = true;
					base.visibility = "visible";
					base.control = await inspectRow(row);
					const result = await mutateEntry(row, entry, initial, profile);
					Object.assign(base, result);
					base.initialAfter = await readSetting(entry.path).catch(() => undefined);
					evidence.settings.push(base);
				} catch (error) {
					base.write = "failed";
					base.readback = "failed";
					base.restore = "failed";
					base.error = String(error);
					evidence.settings.push(base);
				} finally {
					for (const original of gateOriginals.reverse()) {
						if (!equalJson(await readSetting(original.path).catch(() => undefined), original.value)) {
							await writeSetting(original.path, original.value);
							await pollSetting(original.path, original.value).catch(() => {});
						}
					}
				}
			}

			// The command palette is the single discoverability surface for built-ins,
			// slash commands, and native actions. Search every advertised command without
			// executing it and retain the TUI-only negative contract.
			// The settings home also exposes the same live palette entry, so the
			// discoverability action is exercised through its second-level surface.
			await $(`${SETTINGS} [aria-label="Close"]`).click();
			await expect($$(SETTINGS)).toBeElementsArrayOfSize(0);
			await (await byRole("button", { name: "Settings", exact: true })).click();
			await expect($(SETTINGS)).toBeDisplayed();
			const settingsCommandCenter = $(`${SETTINGS} [data-command-center-entry="true"]`);
			await expect(settingsCommandCenter).toBeDisplayed();
			await settingsCommandCenter.click();
			await expect($$(SETTINGS)).toBeElementsArrayOfSize(0);
			await expect($(DIALOG)).toBeDisplayed();
			await browser.keys("Escape");
			await expect($$(DIALOG)).toBeElementsArrayOfSize(0);
			// The chip spells the palette's chords in the host's form: glyphs on macOS, text elsewhere.
			await expect($('button[data-command-center-entry="true"] kbd')).toHaveElementProperty(
				"textContent",
				effectiveShortcut("palette", {}, keyboardPlatformOf(process.platform)),
				{ containing: true },
			);
			await $('button[data-command-center-entry="true"]').click();
			const palette = $(DIALOG);
			await expect(palette).toBeDisplayed();
			const SEARCH = TEXTBOX.split(", ")
				.map(selector => `${DIALOG} ${selector}`)
				.join(", ");
			const available = await browser.execute(async () => window.omp.rpc.getAvailableCommands());
			if (available.success) {
				const commandEntries =
					(available.data as { commands?: Array<{ name: string; textModeExecutable?: boolean }> } | undefined)
						?.commands ?? [];
				const commands = commandEntries.map(command => command.name);
				evidence.commands.availableCount = commands.length;
				evidence.commands.names = commands;
				for (const { name, textModeExecutable } of commandEntries) {
					await fill($(SEARCH), name);
					const exactMatch = () =>
						browser.execute(
							(command: string) =>
								Array.from(document.querySelectorAll('[role="dialog"] button[data-command-name]')).some(
									row =>
										row.getAttribute("data-command-name") === command ||
										(JSON.parse(row.getAttribute("data-command-aliases") ?? "[]") as string[]).includes(
											command,
										),
								),
							name,
						);
					if (textModeExecutable === false && !(await exactMatch())) {
						evidence.commands.tuiOnlyNames.push(name);
						continue;
					}
					try {
						expect(await until(exactMatch, matched => matched, { timeout: 2_000 })).toBe(true);
					} catch {
						evidence.commands.paletteSearchMissing.push(name);
					}
				}
			} else {
				evidence.commands.error = available.error;
			}
			// Drill into every native submenu without executing its actions. This
			// verifies that nested command surfaces open and that their own controls
			// are rendered; destructive/external rows remain enumerated only.
			await fill($(SEARCH), "");
			await expect($(`${DIALOG} .omp-command-list`)).toBeDisplayed();
			evidence.commands.paletteTopLevelCount = await countOf(`${DIALOG} button[data-palette-index]`);
			const SUBMENUS = `${DIALOG} button[data-command-kind="submenu"]`;
			const submenuCount = await countOf(SUBMENUS);
			for (let index = 0; index < submenuCount; index++) {
				const button = $$(SUBMENUS)[index];
				const name = (await textOf(button)).replaceAll(/\s+/g, " ").trim();
				try {
					await button.click();
					const nestedRows = await countOf(`${DIALOG} button[data-palette-index]`);
					labelled(`${name} did not render nested command rows`, () => expect(nestedRows).toBeGreaterThan(0));
					await expect($(SEARCH)).toBeDisplayed();
					evidence.commands.nestedSurfaces.push({
						name,
						status: "opened",
						controls: await browser.execute(
							(currentPage: string) =>
								Array.from(
									document.querySelectorAll(
										'[role="dialog"] button, [role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea',
									),
								).map((element, controlIndex) => ({
									page: currentPage,
									kind: element.tagName.toLowerCase(),
									name:
										element.getAttribute("aria-label") ??
										(element instanceof HTMLInputElement && element.placeholder
											? element.placeholder
											: null) ??
										element.textContent?.trim() ??
										"",
									disabled:
										element instanceof HTMLButtonElement ||
										element instanceof HTMLInputElement ||
										element instanceof HTMLSelectElement ||
										element instanceof HTMLTextAreaElement
											? element.disabled
											: element.hasAttribute("disabled"),
									role: element.getAttribute("role"),
									selectorHint: `${element.tagName.toLowerCase()}[data-audit-index="${controlIndex}"]`,
								})),
							name,
						),
					});
				} catch (error) {
					evidence.commands.nestedSurfaces.push({ name, status: "failed", controls: [], error: String(error) });
				}
				await browser.keys("Escape");
				await expect($$(SUBMENUS)).toBeElementsArrayOfSize(submenuCount);
			}
			await browser.keys("Escape");
			evidence.finishedAt = new Date().toISOString();
			await fs.mkdir("test-results/deep-audit", { recursive: true });
			await fs.writeFile("test-results/deep-audit/evidence.json", JSON.stringify(evidence, null, 2));
			const failed = evidence.settings.filter(row => row.write === "failed");
			labelled(JSON.stringify(failed, null, 2), () => expect(failed).toEqual([]));
			labelled(JSON.stringify(evidence.commands), () => expect(evidence.commands.paletteSearchMissing).toEqual([]));
			expect(evidence.commands.nestedSurfaces.filter(surface => surface.status === "failed")).toEqual([]);
		} finally {
			evidence.finishedAt ??= new Date().toISOString();
			await fs.mkdir("test-results/deep-audit", { recursive: true });
			await fs.writeFile("test-results/deep-audit/evidence.json", JSON.stringify(evidence, null, 2));
		}
	}).timeout(600_000);
});
