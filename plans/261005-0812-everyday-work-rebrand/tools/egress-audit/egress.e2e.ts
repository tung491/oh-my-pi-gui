/**
 * The recorded session of the egress audit: every action of Task 9.6 step 3,
 * in order, against the installed app running under strace. Each action
 * appends one row to $EGRESS_OUT/timeline.tsv (epoch start and end, outcome,
 * what the app showed), which egress-report.ts joins with the connect() trace.
 *
 * The actions go through the UI a person uses: the welcome screen's Get
 * started, the starter cards, the composer, Settings › Updates and the Ollama
 * window. One stand-in: the file cards open the desktop's file chooser, which
 * WebDriver cannot drive, so the page's `showOpenDialog` is replaced by one
 * that returns the seeded input file; the card then sends exactly what it
 * sends after a real pick. Approvals are approved, and questions get their
 * recommended (else first) answer, as a cooperative user would; a request to
 * open a browser is recorded and dismissed with Done, never opened.
 *
 * With EGRESS_DRY_RUN=1 only the first action runs, and it stops once the
 * first-run screen shows: nothing is clicked and no model is set.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $, $$, browser } from "@wdio/globals";
import { alive, pgrepFull, procInfo } from "./repo/e2e-tauri/outside";
import { fill, until } from "./repo/e2e-tauri/session";
import type { RpcSessionState } from "./repo/src/shared/rpc-types";

const OUT = process.env.EGRESS_OUT ?? "";
const DRY_RUN = process.env.EGRESS_DRY_RUN === "1";
const ACTION_TIMEOUT_MS = Number(process.env.EGRESS_ACTION_TIMEOUT_MS || 20 * 60_000);
/** Optional: the Ollama tag to run the jobs on instead of the one Get started picks (set_model, as the picker sends). */
const MODEL_OVERRIDE = process.env.EGRESS_MODEL ?? "";
const TIMELINE = path.join(OUT, "timeline.tsv");
const INPUTS = path.join(os.homedir(), "Documents", "egress-inputs");
/** A cloud tag: Ollama runs it on ollama.com, so it must be refused both ways. */
const CLOUD_TAG = "gpt-oss:120b-cloud";
const SEND = 'button[aria-label="Send (Enter)"]';
const WELCOME = '[role="dialog"][aria-label="Set up your local assistant"]';
/** Quiet time between actions, so a late connection is not blamed on the next action. */
const GAP_MS = 5_000;
/** An action counts as finished after this long idle with no dialog. */
const SETTLE_QUIET_MS = 5_000;
/** A typed command that never starts a turn is finished after this long. */
const NO_TURN_GRACE_MS = 20_000;
const QUIT_GRACE_MS = 15_000;

const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const oneLine = (text: string, max = 600) => text.replace(/\s+/g, " ").trim().slice(0, max);

function record(action: string, start: number, end: number, outcome: string, notes: string): void {
	if (!fs.existsSync(TIMELINE)) fs.writeFileSync(TIMELINE, "action\tstart\tend\toutcome\tnotes\n");
	fs.appendFileSync(
		TIMELINE,
		`${action}\t${start.toFixed(3)}\t${end.toFixed(3)}\t${oneLine(outcome, 120)}\t${oneLine(notes, 2_000)}\n`,
	);
}

/**
 * Every thread of the container (`pid ppid lwp args`) after an action, so the
 * report can name the process behind a thread id in the trace.
 */
function snapshotProcesses(name: string): void {
	const ps = spawnSync("ps", ["-eLo", "pid=,ppid=,lwp=,args="], { encoding: "utf8" });
	fs.writeFileSync(path.join(OUT, "ps", `${name}.txt`), ps.stdout ?? `ps failed: ${String(ps.error)}`);
}

/** Run one action, stamp it in the timeline and keep its screenshot; a failure is recorded, then rethrown. */
async function action(name: string, body: () => Promise<{ outcome: string; notes: string }>, start = now()) {
	let outcome = "error";
	let notes = "";
	try {
		({ outcome, notes } = await body());
	} catch (error) {
		notes = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		record(name, start, now(), outcome, notes);
		snapshotProcesses(name);
		await browser.saveScreenshot(path.join(OUT, "screens", `${name}.png`)).catch(() => undefined);
		await sleep(GAP_MS);
	}
}

async function sessionState(): Promise<RpcSessionState> {
	const response = await browser.execute(() => window.omp.rpc.getState());
	if (!response.success) throw new Error(`get_state failed: ${JSON.stringify(response)}`);
	return response.data as RpcSessionState;
}

function modelTag(state: RpcSessionState): string {
	return state.model ? `${state.model.provider}/${state.model.id}` : "(none)";
}

/** What the page shows that tells an action's result: toasts, alerts and the last transcript rows. */
function visibleResult(): Promise<string> {
	return browser.execute(() => {
		const text = (element: Element) => (element as HTMLElement).innerText.replace(/\s+/g, " ").trim();
		const toasts = Array.from(document.querySelectorAll('[aria-live="polite"] > *')).map(text);
		const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map(text);
		const rows = Array.from(document.querySelectorAll("[data-transcript-kind]"))
			.slice(-3)
			.map(row => `[${row.getAttribute("data-transcript-kind")}] ${text(row).slice(0, 400)}`);
		return [
			toasts.length ? `toasts: ${toasts.join(" | ")}` : "",
			alerts.length ? `alerts: ${alerts.join(" | ")}` : "",
			rows.length ? `last rows: ${rows.join(" | ")}` : "",
		]
			.filter(Boolean)
			.join(" ; ");
	});
}

/**
 * Answer the topmost dialog the way a cooperative user would, and say what it was;
 * null when no dialog is open.
 */
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
			const done = named("Done");
			if (done) done.click();
			else (dialog.querySelector('[aria-label="Close"]') as HTMLElement | null)?.click();
			return `open-url request, dismissed without opening: ${summary}`;
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
				const pick = options.find(option => option.innerText.includes("Recommended")) ?? options[0];
				pick?.click();
			}
			(form.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
			return `answered questions: ${summary}`;
		}
		const input = dialog.querySelector("input") as HTMLInputElement | null;
		if (form && input) {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "Use your best judgement.");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			(form.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
			return `answered input: ${summary}`;
		}
		const choice = buttons.find(
			button => !["Cancel", "Close", "Deny", ""].includes(button.innerText.trim()) && !button.disabled,
		);
		if (choice) {
			const label = choice.innerText.replace(/\s+/g, " ").trim();
			choice.click();
			return `chose "${label}": ${summary}`;
		}
		return `unanswerable dialog: ${summary}`;
	});
}

/**
 * Wait until the agent has finished what the action started: not streaming,
 * not compacting, nothing queued and no dialog, for SETTLE_QUIET_MS. Dialogs
 * are answered on the way. A turn past ACTION_TIMEOUT_MS is aborted.
 */
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
			const quiet = Date.now() - idleSince >= SETTLE_QUIET_MS;
			if (quiet && (sawTurn || Date.now() - started >= NO_TURN_GRACE_MS)) {
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
		outcome: dialogs.some(item => item.startsWith("unanswerable"))
			? "stuck on a dialog (aborted)"
			: "timeout (aborted)",
		notes: [
			`abort: ${JSON.stringify(aborted)}`,
			...dialogs.map(item => `dialog: ${item}`),
			await visibleResult(),
		].join(" ; "),
	};
}

/** Start each job in a fresh conversation, as "New task" would, so the transcript stays small. */
async function freshConversation(): Promise<void> {
	if ((await sessionState()).messageCount === 0) return;
	const fresh = await browser.execute(() => window.omp.rpc.newSession());
	if (!fresh.success) throw new Error(`new_session failed: ${JSON.stringify(fresh)}`);
	await until(sessionState, state => state.messageCount === 0, { timeout: 30_000 });
}

/** Type into the composer and press Send, as a person would. */
async function typeAndSend(text: string): Promise<void> {
	await fill($("textarea"), text);
	await $(SEND).waitForClickable({ timeout: 30_000 });
	await $(SEND).click();
}

/** Click a starter card; a file card gets `file` from the stand-in file chooser. */
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

/** Open a settings page by its nav label, expanding the group that holds it. */
async function openSettingsPage(label: string): Promise<void> {
	await $('[data-sidebar-nav="settings"]').click();
	await $('[role="dialog"] .settings-nav-group-label').waitForDisplayed({ timeout: 15_000 });
	const groups = await $$('[role="dialog"] .settings-nav-group-label').length;
	for (let index = 0; index < groups; index++) {
		const item = $(
			`//*[@role="dialog"]//button[contains(@class, "settings-nav-item")][normalize-space(.)="${label}"]`,
		);
		if (await item.isExisting()) {
			await item.click();
			return;
		}
		await $$('[role="dialog"] .settings-nav-group-label')[index].click();
		await sleep(300);
	}
	const item = $(`//*[@role="dialog"]//button[contains(@class, "settings-nav-item")][normalize-space(.)="${label}"]`);
	if (!(await item.isExisting())) throw new Error(`no settings page named ${label}`);
	await item.click();
}

async function closeDialogs(): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const open = await browser.execute(
			() =>
				Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => d.getClientRects().length > 0).length,
		);
		if (open === 0) return;
		await browser.keys("Escape");
		await sleep(500);
	}
}

/** The installed app's main process (strace's child), for the graceful quit. */
function appPid(): number | null {
	const pids = pgrepFull("/usr/bin/sai-atlas").filter(pid => procInfo(pid)?.comm === "sai-atlas");
	return pids[0] ?? null;
}

describe("egress audit session", () => {
	after(async () => {
		// Quit as a desktop session end would; strace exits with the app's last process.
		const pid = appPid();
		if (pid === null) return;
		process.kill(pid, "SIGTERM");
		const deadline = Date.now() + QUIT_GRACE_MS;
		while (alive(pid) && Date.now() < deadline) await sleep(100);
		if (alive(pid)) throw new Error(`the app (pid ${pid}) did not exit within ${QUIT_GRACE_MS} ms of SIGTERM`);
	});

	it("first run", async () => {
		const launched = Number.parseFloat(fs.readFileSync(path.join(OUT, "launch-start"), "utf8"));
		await action(
			DRY_RUN ? "dry-run-first-run-screen" : "first-run",
			async () => {
				await browser.waitUntil(() => browser.execute(() => window.omp?.rpc != null), {
					timeout: 60_000,
					timeoutMsg: "the chat window never got its bridge",
				});
				await browser.waitUntil(
					async () => (await browser.execute(() => window.omp.sidecar.getStatus())).status === "ready",
					{ timeout: 120_000, interval: 250, timeoutMsg: "the sidecar never reached ready" },
				);
				const launchModel = modelTag(await sessionState());
				// The welcome screen opens on its own only when Ollama lists no model. On a
				// machine that already has models the app starts on the first one it lists,
				// and the person reaches the same screen through Ollama › Run setup again.
				let opened = "it opened on its own";
				const auto = await $(WELCOME)
					.waitForDisplayed({ timeout: 15_000 })
					.then(() => true)
					.catch(() => false);
				if (!auto) {
					opened = `it did not open on its own (Ollama already lists models; launch model ${launchModel}); opened through Ollama › Run setup again`;
					await $('[data-sidebar-nav="providers"]').click();
					const runSetup = $('//*[@role="dialog"]//button[normalize-space(.)="Run setup again"]');
					await runSetup.waitForClickable({ timeout: 30_000 });
					await runSetup.click();
					await $(WELCOME).waitForDisplayed({ timeout: 30_000, timeoutMsg: "the first-run screen never showed" });
				}
				const getStarted = $(
					`//*[@aria-label="Set up your local assistant"]//button[normalize-space(.)="Get started"]`,
				);
				await browser.waitUntil(async () => (await getStarted.isExisting()) && (await getStarted.isEnabled()), {
					timeout: 120_000,
					timeoutMsg: "Get started never became enabled (no installed local model?)",
				});
				const screen = `first-run screen: ${opened}; ${oneLine(await $(WELCOME).getText(), 1_500)}`;
				if (DRY_RUN) return { outcome: "first-run screen shown (dry run, nothing clicked)", notes: screen };
				await getStarted.click();
				await $(WELCOME).waitForDisplayed({ reverse: true, timeout: 120_000 });
				const state = await until(sessionState, value => value.model != null && modelTag(value) !== launchModel, {
					timeout: 60_000,
				});
				const picked = modelTag(state);
				let selected = picked;
				if (MODEL_OVERRIDE) {
					const switched = await browser.execute(
						(tag: string) => window.omp.rpc.setModel("ollama", tag),
						MODEL_OVERRIDE,
					);
					if (!switched.success)
						throw new Error(`EGRESS_MODEL ${MODEL_OVERRIDE} refused: ${JSON.stringify(switched)}`);
					selected = modelTag(await sessionState());
				}
				fs.writeFileSync(path.join(OUT, "selected-model.txt"), `${selected}\n`);
				const override = MODEL_OVERRIDE ? ` -> ${selected} (EGRESS_MODEL)` : "";
				return { outcome: `model ${launchModel} -> ${picked} (Get started)${override}`, notes: screen };
			},
			launched,
		);
	});

	describe("actions", () => {
		before(function () {
			if (DRY_RUN) this.skip();
		});

		it("Word report", async () => {
			await freshConversation();
			await action("word-report", async () => {
				await starter("Turn my notes into a Word report", path.join(INPUTS, "meeting-notes.md"));
				return settle();
			});
		});

		it("spreadsheet clean-up", async () => {
			await freshConversation();
			await action("spreadsheet-cleanup", async () => {
				await starter("Clean up a spreadsheet and add totals", path.join(INPUTS, "store-sales.csv"));
				return settle();
			});
		});

		it("slide deck", async () => {
			await freshConversation();
			await action("slide-deck", async () => {
				await starter("Make slides from a report", path.join(INPUTS, "project-update.md"));
				return settle();
			});
		});

		it("helpdesk question", async () => {
			await freshConversation();
			await action("helpdesk", async () => {
				await starter("Help with my computer", null);
				const card = await settle();
				await typeAndSend("My Wi-Fi keeps disconnecting every few minutes. Can you check what is going on?");
				const question = await settle();
				return {
					outcome: `card: ${card.outcome}; question: ${question.outcome}`,
					notes: `card: ${card.notes} ;; question: ${question.notes}`,
				};
			});
		});

		it("read a document that contains a URL", async () => {
			await freshConversation();
			await action("read-document-with-url", async () => {
				await typeAndSend(
					`Please read ${path.join(INPUTS, "supplier-note.txt")} and tell me what it says, including what is on the price list it links to.`,
				);
				return settle();
			});
		});

		it("search the web", async () => {
			await freshConversation();
			await action("web-search", async () => {
				await typeAndSend("Search the web for the latest LibreOffice release and tell me what is new in it.");
				return settle();
			});
		});

		it("typed /model with an online provider", async () => {
			await action("typed-model-anthropic", async () => {
				const before = modelTag(await sessionState());
				await typeAndSend("/model anthropic/claude-sonnet-4-5");
				const result = await settle();
				const after = modelTag(await sessionState());
				return { outcome: `${result.outcome}; model ${before} -> ${after}`, notes: result.notes };
			});
		});

		it("typed /login", async () => {
			await action("typed-login", async () => {
				await typeAndSend("/login");
				return settle();
			});
		});

		it("update check", async () => {
			await action("update-check", async () => {
				await openSettingsPage("Updates");
				const check = $('//*[@role="dialog"]//button[normalize-space(.)="Check for updates"]');
				await check.waitForClickable({ timeout: 30_000 });
				await check.click();
				// The button reads "Checking…" while either check runs.
				await sleep(1_000);
				await browser.waitUntil(
					async () => !(await $('//*[@role="dialog"]//*[contains(., "Checking…")]').isExisting()),
					{
						timeout: 120_000,
						timeoutMsg: "the update check never finished",
					},
				);
				const page = oneLine(await $('[role="dialog"] .settings-content').getText(), 1_500);
				await closeDialogs();
				return { outcome: "checked", notes: page };
			});
		});

		it("pull a cloud tag", async () => {
			await action("cloud-tag-pull", async () => {
				await $('[data-sidebar-nav="providers"]').click();
				const field = $('[aria-label="Model tag, e.g. qwen3:8b"]');
				await field.waitForEnabled({ timeout: 30_000 });
				await fill(field, CLOUD_TAG);
				await sleep(500);
				const download = $('button[data-action="pull"]');
				const disabled = !(await download.isEnabled());
				const refusal = (await $("[data-cloud-refused]").isExisting())
					? await $("[data-cloud-refused]").getText()
					: "(no refusal shown)";
				// Enter submits the form even when a person cannot click the disabled button.
				await field.click();
				await browser.keys("Enter");
				await sleep(5_000);
				const notice = (await $("[data-pull-notice]").isExisting()) ? await $("[data-pull-notice]").getText() : "";
				const progress = await visibleResult();
				await closeDialogs();
				return {
					outcome: disabled ? "refused: Download disabled" : "NOT refused: Download enabled",
					notes: `tag ${CLOUD_TAG}; refusal: ${refusal}; pull notice: ${notice || "(none)"}; ${progress}`,
				};
			});
		});

		it("select a cloud tag", async () => {
			await action("cloud-tag-select", async () => {
				const before = modelTag(await sessionState());
				await typeAndSend(`/model ollama/${CLOUD_TAG}`);
				const typed = await settle();
				const afterTyped = modelTag(await sessionState());
				// The agent's own layer, under the renderer's refusal: the set_model RPC the model picker sends.
				// The agent refuses an unknown or non-local model by rejecting the call, and WebKit's WebDriver
				// raises that rejection as a script error, so a rejected call is a refusal too.
				const direct = await browser
					.execute((tag: string) => window.omp.rpc.setModel("ollama", tag), CLOUD_TAG)
					.catch((error: unknown) => ({
						success: false,
						error: error instanceof Error ? error.message : String(error),
					}));
				const after = modelTag(await sessionState());
				fs.writeFileSync(path.join(OUT, "model-after.txt"), `${after}\n`);
				const refused = afterTyped === before && after === before && !direct.success;
				return {
					outcome: `${refused ? "refused" : "NOT refused"}: model ${before} -> ${afterTyped} (typed) -> ${after} (set_model)`,
					notes: `typed: ${typed.outcome}; ${typed.notes} ;; set_model: ${JSON.stringify(direct)}`,
				};
			});
		});
	});
});
