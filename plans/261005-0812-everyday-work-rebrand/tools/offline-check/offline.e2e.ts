/**
 * The offline check against the installed app in a container with no network
 * except the host's Ollama: first run through Get started, one file of each
 * kind through the three starter cards, the typed request "run ls", and the
 * LibreOffice timeout check (the clean-up of a large .xls whose soffice.bin is
 * SIGSTOPped as soon as it appears, so the conversion hits its timeout).
 *
 * Helpers follow the egress audit's spec (tools/egress-audit/egress.e2e.ts):
 * the desktop file chooser is replaced by one that returns the seeded input,
 * approvals are approved and questions get their recommended answer.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $, browser } from "@wdio/globals";
import { alive, pgrepFull, procInfo } from "./repo/e2e-tauri/outside";
import { fill, until } from "./repo/e2e-tauri/session";
import type { RpcSessionState } from "./repo/src/shared/rpc-types";

const OUT = process.env.OFFLINE_OUT ?? "";
const ACTION_TIMEOUT_MS = Number(process.env.OFFLINE_ACTION_TIMEOUT_MS || 20 * 60_000);
const INPUTS = path.join(os.homedir(), "Inputs");
const SAVED = path.join(os.homedir(), "Documents", "Sai ATLAS");
const SESSIONS = path.join(os.homedir(), ".omp", "agent", "sessions");
const TIMELINE = path.join(OUT, "timeline.tsv");
const SEND = 'button[aria-label="Send (Enter)"]';
const WELCOME = '[role="dialog"][aria-label="Set up your local assistant"]';
const SETTLE_QUIET_MS = 5_000;
const NO_TURN_GRACE_MS = 20_000;
/** CONVERT_TIMEOUT_MS is 60 s; the tool must report well within this. */
const CONVERT_REPORT_LIMIT_MS = 5 * 60_000;
const QUIT_GRACE_MS = 15_000;

const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const oneLine = (text: string, max = 600) => text.replace(/\s+/g, " ").trim().slice(0, max);

function record(action: string, start: number, outcome: string, notes: string): void {
	if (!fs.existsSync(TIMELINE)) fs.writeFileSync(TIMELINE, "action\tstart\tend\toutcome\tnotes\n");
	fs.appendFileSync(
		TIMELINE,
		`${action}\t${start.toFixed(3)}\t${now().toFixed(3)}\t${oneLine(outcome, 200)}\t${oneLine(notes, 3_000)}\n`,
	);
}

async function action(name: string, body: () => Promise<{ outcome: string; notes: string }>) {
	const start = now();
	let outcome = "error";
	let notes = "";
	try {
		({ outcome, notes } = await body());
	} catch (error) {
		notes = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		record(name, start, outcome, notes);
		await browser.saveScreenshot(path.join(OUT, "screens", `${name}.png`)).catch(() => undefined);
	}
}

async function sessionState(): Promise<RpcSessionState> {
	const response = await browser.execute(() => window.omp.rpc.getState());
	if (!response.success) throw new Error(`get_state failed: ${JSON.stringify(response)}`);
	return response.data as RpcSessionState;
}

const modelTag = (state: RpcSessionState) => (state.model ? `${state.model.provider}/${state.model.id}` : "(none)");

function visibleResult(): Promise<string> {
	return browser.execute(() => {
		const text = (element: Element) => (element as HTMLElement).innerText.replace(/\s+/g, " ").trim();
		const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map(text);
		const rows = Array.from(document.querySelectorAll("[data-transcript-kind]"))
			.slice(-3)
			.map(row => `[${row.getAttribute("data-transcript-kind")}] ${text(row).slice(0, 500)}`);
		return [alerts.length ? `alerts: ${alerts.join(" | ")}` : "", rows.length ? `last rows: ${rows.join(" | ")}` : ""]
			.filter(Boolean)
			.join(" ; ");
	});
}

/** Answer the topmost dialog as a cooperative user would; null when none is open. */
function answerDialog(): Promise<string | null> {
	return browser.execute(() => {
		const shown = (element: Element) => (element as HTMLElement).getClientRects().length > 0;
		const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(shown);
		const dialog = dialogs[dialogs.length - 1] as HTMLElement | undefined;
		if (!dialog) return null;
		const summary = dialog.innerText.replace(/\s+/g, " ").trim().slice(0, 300);
		const buttons = Array.from(dialog.querySelectorAll("button")).filter(shown) as HTMLButtonElement[];
		const named = (name: string) => buttons.find(button => button.innerText.trim() === name && !button.disabled);
		const openUrl = named("Open in Browser") ?? named("Open Again");
		if (openUrl) {
			(named("Done") ?? (dialog.querySelector('[aria-label="Close"]') as HTMLButtonElement | null))?.click();
			return `open-url request, dismissed: ${summary}`;
		}
		const approve = named("Approve");
		if (approve) {
			approve.click();
			return `approved: ${summary}`;
		}
		const form = dialog.querySelector("form");
		if (form && dialog.getAttribute("aria-label") === "Questions") {
			for (const group of Array.from(form.querySelectorAll("div.space-y-1"))) {
				const options = Array.from(group.querySelectorAll(":scope > button")) as HTMLButtonElement[];
				(options.find(option => option.innerText.includes("Recommended")) ?? options[0])?.click();
			}
			(form.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
			return `answered questions: ${summary}`;
		}
		const input = dialog.querySelector("input") as HTMLInputElement | null;
		if (form && input) {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Use your best judgement.");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			(form.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
			return `answered input: ${summary}`;
		}
		const choice = buttons.find(b => !["Cancel", "Close", "Deny", ""].includes(b.innerText.trim()) && !b.disabled);
		if (choice) {
			const label = choice.innerText.replace(/\s+/g, " ").trim();
			choice.click();
			return `chose "${label}": ${summary}`;
		}
		return `unanswerable dialog: ${summary}`;
	});
}

async function settle(): Promise<{ outcome: string; notes: string }> {
	const started = Date.now();
	const deadline = started + ACTION_TIMEOUT_MS;
	const dialogs: string[] = [];
	let sawTurn = false;
	let idleSince: number | null = null;
	while (Date.now() < deadline) {
		const dialog = await answerDialog();
		if (dialog) {
			dialogs.push(dialog);
			idleSince = null;
			if (dialog.startsWith("unanswerable")) break;
			await sleep(1_000);
			continue;
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
				};
			}
		}
		await sleep(1_000);
	}
	const aborted = await browser.execute(() => window.omp.rpc.abort());
	return {
		outcome: "timeout (aborted)",
		notes: [`abort: ${JSON.stringify(aborted)}`, ...dialogs, await visibleResult()].join(" ; "),
	};
}

async function freshConversation(): Promise<void> {
	if ((await sessionState()).messageCount === 0) return;
	const fresh = await browser.execute(() => window.omp.rpc.newSession());
	if (!fresh.success) throw new Error(`new_session failed: ${JSON.stringify(fresh)}`);
	await until(sessionState, state => state.messageCount === 0, { timeout: 30_000 });
}

async function typeAndSend(text: string): Promise<void> {
	await fill($("textarea"), text);
	await $(SEND).waitForClickable({ timeout: 30_000 });
	await $(SEND).click();
}

async function starter(title: string, file: string | null): Promise<void> {
	if (file) {
		if (!fs.existsSync(file)) throw new Error(`missing seeded input ${file}`);
		await browser.execute((picked: string) => {
			window.omp.system.showOpenDialog = async () => [picked];
		}, file);
	}
	const card = await $(`//button[contains(@class, "omp-starter-card")][contains(normalize-space(.), "${title}")]`);
	await card.waitForClickable({ timeout: 30_000 });
	await card.click();
}

function sh(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return `$ ${[command, ...args].join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}(exit ${result.status})\n`;
}

/** Every office_clean tool result in the session files, as text. */
function cleanResults(): string[] {
	if (!fs.existsSync(SESSIONS)) return [];
	const found: string[] = [];
	for (const entry of fs.readdirSync(SESSIONS, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		for (const line of fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8").split("\n")) {
			if (line.includes('"role":"toolResult"') && line.includes('"toolName":"office_clean"')) found.push(line);
		}
	}
	return found;
}

function soffices(): number[] {
	const result = spawnSync("pgrep", ["-x", "soffice.bin"], { encoding: "utf8" });
	return (result.stdout ?? "").split("\n").filter(Boolean).map(Number);
}

function appPid(): number | null {
	return pgrepFull("/usr/bin/sai-atlas").find(pid => procInfo(pid)?.comm === "sai-atlas") ?? null;
}

describe("offline check", () => {
	after(async () => {
		const pid = appPid();
		if (pid === null) return;
		process.kill(pid, "SIGTERM");
		const deadline = Date.now() + QUIT_GRACE_MS;
		while (alive(pid) && Date.now() < deadline) await sleep(100);
	});

	it("first run picks a local model", async () => {
		await action("first-run", async () => {
			await browser.waitUntil(() => browser.execute(() => window.omp?.rpc != null), { timeout: 60_000 });
			await browser.waitUntil(
				async () => (await browser.execute(() => window.omp.sidecar.getStatus())).status === "ready",
				{ timeout: 120_000, interval: 250, timeoutMsg: "the sidecar never reached ready" },
			);
			const launchModel = modelTag(await sessionState());
			let opened = "it opened on its own";
			const auto = await $(WELCOME)
				.waitForDisplayed({ timeout: 15_000 })
				.then(() => true)
				.catch(() => false);
			if (!auto) {
				opened = `opened through Ollama › Run setup again (launch model ${launchModel})`;
				await $('[data-sidebar-nav="providers"]').click();
				const runSetup = $('//*[@role="dialog"]//button[normalize-space(.)="Run setup again"]');
				await runSetup.waitForClickable({ timeout: 30_000 });
				await runSetup.click();
				await $(WELCOME).waitForDisplayed({ timeout: 30_000 });
			}
			const getStarted = $(`//*[@aria-label="Set up your local assistant"]//button[normalize-space(.)="Get started"]`);
			await browser.waitUntil(async () => (await getStarted.isExisting()) && (await getStarted.isEnabled()), {
				timeout: 120_000,
				timeoutMsg: "Get started never became enabled",
			});
			const screen = oneLine(await $(WELCOME).getText(), 1_000);
			await getStarted.click();
			await $(WELCOME).waitForDisplayed({ reverse: true, timeout: 120_000 });
			const state = await until(sessionState, value => value.model != null, { timeout: 60_000 });
			const picked = modelTag(state);
			fs.writeFileSync(path.join(OUT, "selected-model.txt"), `${picked}\n`);
			return { outcome: `model ${launchModel} -> ${picked} (Get started)`, notes: `${opened}; ${screen}` };
		});
	});

	for (const [name, title, file] of [
		["word-report", "Turn my notes into a Word report", "meeting-notes.md"],
		["spreadsheet-cleanup", "Clean up a spreadsheet and add totals", "store-sales.csv"],
		["slide-deck", "Make slides from a report", "project-update.md"],
	] as const) {
		it(name, async () => {
			await freshConversation();
			await action(name, async () => {
				await starter(title, path.join(INPUTS, file));
				return settle();
			});
		});
	}

	it("lists the saved files", () => {
		fs.writeFileSync(path.join(OUT, "step2-listing.txt"), sh("ls", ["-la", SAVED]));
	});

	it("a typed 'run ls' runs no shell", async () => {
		await freshConversation();
		await action("run-ls", async () => {
			await typeAndSend("run ls");
			const result = await settle();
			const tools = await browser.execute(() =>
				Array.from(document.querySelectorAll("[data-transcript-kind]")).map(row => row.getAttribute("data-transcript-kind")),
			);
			return { outcome: result.outcome, notes: `${result.notes} ; transcript kinds: ${tools.join(",")}` };
		});
	});

	it("a LibreOffice conversion past its timeout leaves no soffice.bin", async () => {
		await freshConversation();
		await action("libreoffice-timeout", async () => {
			const before = cleanResults().length;
			let stopped: { pid: number; at: number } | null = null;
			let watching = true;
			const watcher = (async () => {
				while (watching && !stopped) {
					const [pid] = soffices();
					if (pid) {
						process.kill(pid, "SIGSTOP");
						stopped = { pid, at: now() };
						fs.writeFileSync(path.join(OUT, "2b-stopped.txt"), `${sh("ps", ["-o", "pid,ppid,stat,args", "-p", String(pid)])}`);
					}
					await sleep(50);
				}
			})();
			await starter("Clean up a spreadsheet and add totals", path.join(INPUTS, "yearly-sales.xls"));
			const deadline = Date.now() + ACTION_TIMEOUT_MS;
			let reported: { at: number; text: string } | null = null;
			let reportBy = Number.POSITIVE_INFINITY;
			while (Date.now() < deadline && Date.now() < reportBy && !reported) {
				if (stopped && reportBy === Number.POSITIVE_INFINITY) reportBy = Date.now() + CONVERT_REPORT_LIMIT_MS;
				await answerDialog();
				const results = cleanResults();
				if (stopped && results.length > before) reported = { at: now(), text: results[before] };
				else await sleep(250);
			}
			watching = false;
			await watcher;
			if (!stopped) {
				const result = await settle();
				return { outcome: "no soffice.bin ever started", notes: `${result.outcome}; ${result.notes}` };
			}
			const s = stopped as { pid: number; at: number };
			if (!reported) {
				const snapshot = sh("ps", ["-eo", "pid,ppid,stat,etime,args"]);
				fs.writeFileSync(path.join(OUT, "2b-pgrep.txt"), `tool never reported within ${CONVERT_REPORT_LIMIT_MS} ms of the stop\n${snapshot}`);
				for (const pid of soffices()) process.kill(pid, "SIGKILL");
				return { outcome: "tool never reported a result", notes: `stopped pid ${s.pid}` };
			}
			const r = reported as { at: number; text: string };
			const waitedMs = (r.at - s.at) * 1000;
			await sleep(5_000);
			const pgrep = sh("pgrep", ["-af", "soffice.bin"]);
			const tree = sh("ps", ["-eo", "pid,ppid,stat,etime,args"]);
			fs.writeFileSync(
				path.join(OUT, "2b-pgrep.txt"),
				`stopped pid ${s.pid}; tool reported ${(waitedMs / 1000).toFixed(1)} s later; 5 s after that:\n${pgrep}\n${tree}`,
			);
			const result = await settle();
			// Leave nothing stopped behind for the rest of the run.
			for (const pid of soffices()) process.kill(pid, "SIGKILL");
			return {
				outcome: `${/\n\d+ /.test(pgrep) ? "SURVIVOR" : "no survivor"}; reported after ${(waitedMs / 1000).toFixed(1)} s`,
				notes: `tool result: ${oneLine(r.text, 800)} ;; turn: ${result.outcome}; ${result.notes}`,
			};
		});
	});
});
