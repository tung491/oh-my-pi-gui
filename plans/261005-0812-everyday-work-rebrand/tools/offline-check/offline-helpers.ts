/**
 * Locale-aware WebDriver helpers for the offline check's language passes
 * (offline-vi.e2e.ts). Every label is read from the app's own locale files by
 * key, so the same helpers drive the English and the Vietnamese UI. The default
 * English run (offline.e2e.ts) keeps its own copies and is not changed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $, browser } from "@wdio/globals";
import { en } from "./repo/src/renderer/locales/en";
import { vi } from "./repo/src/renderer/locales/vi";
import { fill, until } from "./repo/e2e-tauri/session";
import type { RpcSessionState } from "./repo/src/shared/rpc-types";

export type Lang = "en" | "vi";
export const LANG: Lang = process.env.OFFLINE_LANG === "vi" ? "vi" : "en";
export const OUT = process.env.OFFLINE_OUT ?? "";
export const ACTION_TIMEOUT_MS = Number(process.env.OFFLINE_ACTION_TIMEOUT_MS || 20 * 60_000);
const SETTLE_QUIET_MS = 5_000;
const NO_TURN_GRACE_MS = 20_000;

/** The UI string for `key` in the run's language; a missing key is an error, never a guess. */
export function L(key: string): string {
	const value = (LANG === "vi" ? vi : en)[key];
	if (value === undefined) throw new Error(`no locale key ${key}`);
	return value;
}

export const now = () => Date.now() / 1000;
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const oneLine = (text: string, max = 600) => text.replace(/\s+/g, " ").trim().slice(0, max);

const TIMELINE = () => path.join(OUT, "timeline.tsv");

export function record(action: string, start: number, outcome: string, notes: string): void {
	if (!fs.existsSync(TIMELINE())) fs.writeFileSync(TIMELINE(), "action\tstart\tend\toutcome\tnotes\n");
	fs.appendFileSync(
		TIMELINE(),
		`${action}\t${start.toFixed(3)}\t${now().toFixed(3)}\t${oneLine(outcome, 300)}\t${oneLine(notes, 4_000)}\n`,
	);
}

/**
 * Screenshot plus everything the page shows as text: the visible body text and
 * every visible title, aria-label and placeholder (tooltips and button names).
 */
export async function capture(name: string): Promise<string> {
	fs.mkdirSync(path.join(OUT, "screens"), { recursive: true });
	fs.mkdirSync(path.join(OUT, "texts"), { recursive: true });
	await browser.saveScreenshot(path.join(OUT, "screens", `${name}.png`)).catch(() => undefined);
	const text = await browser.execute(() => {
		const shown = (element: Element) => (element as HTMLElement).getClientRects().length > 0;
		const attributes: string[] = [];
		for (const element of Array.from(document.querySelectorAll("[title],[aria-label],[placeholder]"))) {
			if (!shown(element)) continue;
			for (const name of ["title", "aria-label", "placeholder"]) {
				const value = element.getAttribute(name);
				if (value) attributes.push(`${name}: ${value}`);
			}
		}
		return `## body text\n${document.body.innerText}\n\n## attributes\n${Array.from(new Set(attributes)).join("\n")}\n`;
	});
	fs.writeFileSync(path.join(OUT, "texts", `${name}.txt`), text);
	return text;
}

export async function sessionState(): Promise<RpcSessionState> {
	const response = await browser.execute(() => window.omp.rpc.getState());
	if (!response.success) throw new Error(`get_state failed: ${JSON.stringify(response)}`);
	return response.data as RpcSessionState;
}

export const modelTag = (state: RpcSessionState) =>
	state.model ? `${state.model.provider}/${state.model.id}` : "(none)";

export function visibleResult(): Promise<string> {
	return browser.execute(() => {
		const text = (element: Element) => (element as HTMLElement).innerText.replace(/\s+/g, " ").trim();
		const rows = Array.from(document.querySelectorAll("[data-transcript-kind]"))
			.slice(-3)
			.map(row => `[${row.getAttribute("data-transcript-kind")}] ${text(row).slice(0, 800)}`);
		return rows.length ? `last rows: ${rows.join(" | ")}` : "";
	});
}

interface DialogLabels {
	approve: string;
	questions: string;
	done: string;
	openUrl: string[];
	skip: string[];
	answer: string;
}

function dialogLabels(): DialogLabels {
	return {
		approve: L("approval.approve"),
		questions: L("extDialog.ask.title"),
		done: L("extDialog.openUrl.done"),
		openUrl: [L("extDialog.openUrl.open"), L("extDialog.openUrl.openAgain")],
		skip: [L("common.cancel"), L("common.close"), L("approval.deny"), ""],
		answer: LANG === "vi" ? "Bạn tự quyết định giúp tôi." : "Use your best judgement.",
	};
}

/** True when a dialog is showing. */
export function dialogShown(): Promise<boolean> {
	return browser.execute(
		() => Array.from(document.querySelectorAll('[role="dialog"]')).some(d => d.getClientRects().length > 0),
	);
}

/** Answer the topmost dialog as a cooperative user would; null when none is open. */
export function answerDialog(): Promise<string | null> {
	return browser.execute((labels: DialogLabels) => {
		const shown = (element: Element) => (element as HTMLElement).getClientRects().length > 0;
		const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(shown);
		const dialog = dialogs[dialogs.length - 1] as HTMLElement | undefined;
		if (!dialog) return null;
		const summary = dialog.innerText.replace(/\s+/g, " ").trim().slice(0, 600);
		const buttons = Array.from(dialog.querySelectorAll("button")).filter(shown) as HTMLButtonElement[];
		const named = (name: string) => buttons.find(button => button.innerText.trim() === name && !button.disabled);
		if (labels.openUrl.some(name => named(name))) {
			(named(labels.done) ?? (dialog.querySelector("[aria-label]") as HTMLButtonElement | null))?.click();
			return `open-url request, dismissed: ${summary}`;
		}
		const approve = named(labels.approve);
		if (approve) {
			approve.click();
			return `approved: ${summary}`;
		}
		const form = dialog.querySelector("form");
		if (form && dialog.getAttribute("aria-label") === labels.questions) {
			for (const group of Array.from(form.querySelectorAll("div.space-y-1"))) {
				const options = Array.from(group.querySelectorAll(":scope > button")) as HTMLButtonElement[];
				options[0]?.click();
			}
			(form.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
			return `answered questions: ${summary}`;
		}
		const input = dialog.querySelector("input") as HTMLInputElement | null;
		if (form && input) {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, labels.answer);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			(form.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
			return `answered input: ${summary}`;
		}
		const choice = buttons.find(b => !labels.skip.includes(b.innerText.trim()) && !b.disabled);
		if (choice) {
			const label = choice.innerText.replace(/\s+/g, " ").trim();
			choice.click();
			return `chose "${label}": ${summary}`;
		}
		return `unanswerable dialog: ${summary}`;
	}, dialogLabels());
}

/**
 * Wait until the turn is over, answering dialogs on the way. The first dialog
 * of the action is captured (screenshot and text) under `<name>-dialog`
 * before it is answered.
 */
export async function settle(name: string): Promise<{ outcome: string; notes: string; dialogs: string[] }> {
	const started = Date.now();
	const deadline = started + ACTION_TIMEOUT_MS;
	const dialogs: string[] = [];
	let sawTurn = false;
	let idleSince: number | null = null;
	while (Date.now() < deadline) {
		if (await dialogShown()) {
			if (dialogs.length === 0) {
				await sleep(500);
				await capture(`${name}-dialog`);
			}
			const dialog = await answerDialog();
			if (dialog) {
				dialogs.push(dialog);
				idleSince = null;
				if (dialog.startsWith("unanswerable")) break;
				await sleep(1_000);
				continue;
			}
		}
		const state = await sessionState();
		if (state.isStreaming || state.isCompacting || state.queuedMessageCount > 0) {
			sawTurn = true;
			idleSince = null;
		} else {
			idleSince ??= Date.now();
			if (Date.now() - idleSince >= SETTLE_QUIET_MS && (sawTurn || Date.now() - started >= NO_TURN_GRACE_MS)) {
				return {
					outcome: sawTurn ? "done" : "done (no turn started)",
					notes: [...dialogs.map(item => `dialog: ${item}`), await visibleResult()].join(" ; "),
					dialogs,
				};
			}
		}
		await sleep(1_000);
	}
	const aborted = await browser.execute(() => window.omp.rpc.abort());
	return {
		outcome: "timeout (aborted)",
		notes: [`abort: ${JSON.stringify(aborted)}`, ...dialogs, await visibleResult()].join(" ; "),
		dialogs,
	};
}

export async function freshConversation(): Promise<void> {
	if ((await sessionState()).messageCount === 0) return;
	const fresh = await browser.execute(() => window.omp.rpc.newSession());
	if (!fresh.success) throw new Error(`new_session failed: ${JSON.stringify(fresh)}`);
	await until(sessionState, state => state.messageCount === 0, { timeout: 30_000 });
}

export async function typeAndSend(text: string): Promise<void> {
	const send = `button[aria-label="${L("input.send")}"]`;
	await fill($("textarea"), text);
	await $(send).waitForClickable({ timeout: 30_000 });
	await $(send).click();
}

/** The starter card whose title is the locale's `chat.starter.<id>.title`. */
export function starterCard(id: string) {
	return $(
		`//button[contains(@class, "omp-starter-card")][contains(normalize-space(.), "${L(`chat.starter.${id}.title`)}")]`,
	);
}

/** Click a starter card; a file card gets `file` from the stand-in file chooser. */
export async function starter(id: string, file: string | null): Promise<string> {
	if (file) {
		if (!fs.existsSync(file)) throw new Error(`missing seeded input ${file}`);
		await browser.execute((picked: string) => {
			window.omp.system.showOpenDialog = async () => [picked];
		}, file);
	}
	const card = await starterCard(id);
	await card.waitForClickable({ timeout: 30_000 });
	const text = oneLine(await card.getText());
	await card.click();
	return text;
}
