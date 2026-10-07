/**
 * Language pass of the offline check (run with `offline-check.sh --lang vi`):
 * the installed app, set to the language through the GUI settings file
 * (`prefs.json` `language`, seeded by the entrypoint), driven through the
 * welcome screen, the attach button, the three starter cards with their
 * approval prompts and output cards, and the helpdesk card plus one question.
 * Every step leaves a screenshot and the visible text (body text plus titles,
 * aria-labels and placeholders) under screens/ and texts/. At the end the
 * sidebar language switcher is clicked to record whether a runtime switch
 * restarts the sidecar (which reads the language only when it starts).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $, browser } from "@wdio/globals";
import { alive, pgrepFull, procInfo } from "./repo/e2e-tauri/outside";
import { until } from "./repo/e2e-tauri/session";
import {
	L,
	LANG,
	OUT,
	capture,
	freshConversation,
	modelTag,
	now,
	oneLine,
	record,
	sessionState,
	settle,
	sleep,
	starter,
	typeAndSend,
} from "./offline-helpers";

const INPUTS = path.join(os.homedir(), "Inputs");
const SAVED = path.join(os.homedir(), "Documents", "Sai ATLAS");
const WELCOME = `[role="dialog"][aria-label="${L("welcome.title")}"]`;
const QUIT_GRACE_MS = 15_000;
const HELPDESK_QUESTION =
	LANG === "vi"
		? "Wi-Fi của tôi cứ bị ngắt sau vài phút. Bạn kiểm tra giúp tôi xem có chuyện gì không?"
		: "My Wi-Fi keeps disconnecting every few minutes. Can you check what is going on?";
const JOBS =
	LANG === "vi"
		? ([
				["word-report", "wordReport", "ghi-chu-cuoc-hop.md"],
				["spreadsheet-cleanup", "spreadsheetCleanup", "doanh-so-cua-hang.csv"],
				["slide-deck", "slidesFromReport", "cap-nhat-du-an.md"],
			] as const)
		: ([
				["word-report", "wordReport", "meeting-notes.md"],
				["spreadsheet-cleanup", "spreadsheetCleanup", "store-sales.csv"],
				["slide-deck", "slidesFromReport", "project-update.md"],
			] as const);

async function action(name: string, body: () => Promise<{ outcome: string; notes: string }>) {
	const start = now();
	let outcome = "error";
	let notes = "";
	try {
		({ outcome, notes } = await body());
	} catch (error) {
		notes = error instanceof Error ? error.message : String(error);
		await capture(`${name}-failed`).catch(() => undefined);
		throw error;
	} finally {
		record(name, start, outcome, notes);
	}
}

function savedFiles(): string[] {
	return fs.existsSync(SAVED) ? fs.readdirSync(SAVED).sort() : [];
}

function sidecarPids(): number[] {
	const result = spawnSync("pgrep", ["-f", "^/usr/lib/Sai ATLAS/omp --mode"], { encoding: "utf8" });
	return (result.stdout ?? "").split("\n").filter(Boolean).map(Number);
}

function appPid(): number | null {
	return pgrepFull("/usr/bin/sai-atlas").find(pid => procInfo(pid)?.comm === "sai-atlas") ?? null;
}

/** The text of the last tool row that holds an office output card. */
function outputCardText(): Promise<string> {
	return browser.execute(() => {
		const cards = Array.from(document.querySelectorAll("[data-office-file]"));
		const card = cards[cards.length - 1];
		if (!card) return "(no output card)";
		const row = card.closest("[data-transcript-kind]") ?? card;
		return (row as HTMLElement).innerText.replace(/\s+/g, " ").trim();
	});
}

describe(`offline language pass (${LANG})`, () => {
	after(async () => {
		const pid = appPid();
		if (pid === null) return;
		process.kill(pid, "SIGTERM");
		const deadline = Date.now() + QUIT_GRACE_MS;
		while (alive(pid) && Date.now() < deadline) await sleep(100);
	});

	it("welcome screen and Get started", async () => {
		await action("welcome", async () => {
			await browser.waitUntil(() => browser.execute(() => window.omp?.rpc != null), { timeout: 60_000 });
			await browser.waitUntil(
				async () => (await browser.execute(() => window.omp.sidecar.getStatus())).status === "ready",
				{ timeout: 120_000, interval: 250, timeoutMsg: "the sidecar never reached ready" },
			);
			const htmlLang = await browser.execute(() => document.documentElement.lang);
			await capture("launch");
			const launchModel = modelTag(await sessionState());
			let opened = "it opened on its own";
			const auto = await $(WELCOME)
				.waitForDisplayed({ timeout: 15_000 })
				.then(() => true)
				.catch(() => false);
			if (!auto) {
				opened = `opened through "${L("ollama.settings.runSetup")}" (launch model ${launchModel})`;
				await $('[data-sidebar-nav="providers"]').click();
				await sleep(1_000);
				await capture("ollama-window");
				const runSetup = $(`//*[@role="dialog"]//button[normalize-space(.)="${L("ollama.settings.runSetup")}"]`);
				await runSetup.waitForClickable({ timeout: 30_000 });
				await runSetup.click();
				await $(WELCOME).waitForDisplayed({ timeout: 30_000 });
			}
			const getStarted = $(`//*[@aria-label="${L("welcome.title")}"]//button[normalize-space(.)="${L("welcome.continue")}"]`);
			await browser.waitUntil(async () => (await getStarted.isExisting()) && (await getStarted.isEnabled()), {
				timeout: 120_000,
				timeoutMsg: "Get started never became enabled",
			});
			await capture("welcome");
			const screen = oneLine(await $(WELCOME).getText(), 2_000);
			await getStarted.click();
			await $(WELCOME).waitForDisplayed({ reverse: true, timeout: 120_000 });
			const state = await until(sessionState, value => value.model != null, { timeout: 60_000 });
			fs.writeFileSync(path.join(OUT, "selected-model.txt"), `${modelTag(state)}\n`);
			return {
				outcome: `model ${launchModel} -> ${modelTag(state)} ("${L("welcome.continue")}")`,
				notes: `html lang=${htmlLang}; ${opened}; welcome text: ${screen}`,
			};
		});
	});

	it("empty state: starter cards and the attach button", async () => {
		await action("empty-state", async () => {
			await freshConversation();
			await sleep(1_000);
			await capture("empty-state");
			const attach = $(`button[aria-label="${L("input.attach")}"]`);
			const exists = await attach.isExisting();
			const title = exists ? await attach.getAttribute("title") : null;
			if (exists) {
				await attach.moveTo();
				await sleep(800);
				await capture("attach-hover");
			}
			const cards = await browser.execute(() =>
				Array.from(document.querySelectorAll(".omp-starter-card")).map(card =>
					(card as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
				),
			);
			return {
				outcome: `attach button ${exists ? "found" : "MISSING"} by aria-label "${L("input.attach")}"; title=${JSON.stringify(title)}; ${cards.length} starter cards`,
				notes: `cards: ${cards.join(" | ")}`,
			};
		});
	});

	for (const [name, id, file] of JOBS) {
		it(name, async () => {
			await freshConversation();
			await action(name, async () => {
				const before = savedFiles();
				const card = await starter(id, path.join(INPUTS, file));
				const result = await settle(name);
				await sleep(500);
				await capture(`${name}-output`);
				const output = await outputCardText();
				const added = savedFiles().filter(entry => !before.includes(entry));
				return {
					outcome: `${result.outcome}; saved: ${added.length ? added.join(", ") : "NOTHING"}`,
					notes: `card: ${card} ;; output card: ${output} ;; ${result.notes}`,
				};
			});
		});
	}

	it("helpdesk card and one question", async () => {
		await freshConversation();
		await action("helpdesk", async () => {
			const card = await starter("helpdesk", null);
			const first = await settle("helpdesk-card");
			await capture("helpdesk-card");
			await typeAndSend(HELPDESK_QUESTION);
			const question = await settle("helpdesk-question");
			await capture("helpdesk-answer");
			return {
				outcome: `card: ${first.outcome}; question: ${question.outcome}`,
				notes: `card: ${card} ;; card turn: ${first.notes} ;; question: ${question.notes}`,
			};
		});
	});

	it("a runtime language switch and the sidecar", async () => {
		await action("runtime-switch", async () => {
			const switcher = $(`button[aria-label="${L("lang.switch")}"]`);
			await switcher.waitForClickable({ timeout: 30_000 });
			const before = sidecarPids();
			await switcher.click();
			await sleep(8_000);
			const switched = sidecarPids();
			const label = await browser.execute(() => document.body.innerText.includes("Switch language"));
			await capture("switched-away");
			// Back to the run's language through the same control (its label is now the other locale's).
			await $(`button[aria-label="${LANG === "vi" ? "Switch language" : "Chuyển đổi ngôn ngữ"}"]`).click();
			await sleep(8_000);
			const back = sidecarPids();
			await capture("switched-back");
			return {
				outcome: `sidecar pids ${before.join(",")} -> ${switched.join(",")} -> ${back.join(",")}`,
				notes: `restarted on switch: ${before.join(",") !== switched.join(",")}; english label shown after switch: ${label}`,
			};
		});
	});
});
