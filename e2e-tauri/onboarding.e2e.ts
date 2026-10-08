import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { type FakeOllama, sendJson, startFakeOllama } from "../src/main/ollama/test-fake-ollama";
import { awaitMainWindow, type Launch, launch, recorded, relaunch } from "./session";

// A fresh profile meets the welcome screen once: download a model from a fake
// Ollama, continue, and the next launch goes straight to the assistant.
// The fake answers 404 to /api/show and /api/ps, so the context measurement
// of the pulled model, held until the welcome screen closes, ends as a failure
// that is remembered and not retried on the next launch.
// The wdio worker is Node, so the daemon is the node:http fake the unit tests
// share rather than Bun.serve.

const WELCOME = '[role="dialog"][aria-label="Set up your local assistant"]';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface FakeRequest {
	method: string;
	path: string;
	at: number;
}

interface ContextFitPrefs {
	ollamaContextFit?: { models?: Record<string, { lastError?: string | null }> };
}

describe("onboarding", () => {
	let ollama: FakeOllama;
	let first: Launch | null = null;
	const installed = new Set<string>();
	const pulls: string[] = [];
	const requests: FakeRequest[] = [];
	const showRequests = (since = 0) => requests.filter(request => request.path === "/api/show" && request.at >= since);

	before(async () => {
		ollama = await startFakeOllama((req, res, body) => {
			const url = new URL(req.url ?? "/", "http://fake.invalid");
			requests.push({ method: req.method ?? "", path: url.pathname, at: Date.now() });
			if (req.method === "GET" && url.pathname === "/api/version") return sendJson(res, { version: "0.12.0" });
			if (req.method === "GET" && url.pathname === "/api/tags")
				return sendJson(res, { models: [...installed].map(name => ({ name })) });
			if (req.method === "POST" && url.pathname === "/api/generate") return sendJson(res, { done: true });
			if (req.method === "POST" && url.pathname === "/api/pull") {
				const tag = (JSON.parse(body) as { model: string }).model;
				pulls.push(tag);
				res.writeHead(200, { "content-type": "application/x-ndjson" });
				void (async () => {
					const digest = "sha256:0123456789abcdef";
					const total = 4_000_000_000;
					res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
					for (const step of [0, 1, 2, 3, 4]) {
						await delay(250);
						res.write(
							`${JSON.stringify({ status: `pulling ${digest.slice(7, 19)}`, digest, total, completed: (total * step) / 4 })}\n`,
						);
					}
					await delay(150);
					res.write(`${JSON.stringify({ status: "verifying sha256 digest" })}\n`);
					installed.add(tag);
					res.end(`${JSON.stringify({ status: "success" })}\n`);
				})();
				return;
			}
			sendJson(res, { error: `fake Ollama does not serve ${req.method} ${url.pathname}` }, 404);
		});
	});

	after(async () => {
		await ollama?.close();
		if (first) await fs.copyFile(first.record, "test-results/onboarding-rpc.jsonl").catch(() => {});
	});

	it("a fresh profile downloads a model on the welcome screen and does not see it again", async () => {
		first = await launch({
			name: "onboarding",
			freshWelcome: true,
			env: {
				OLLAMA_HOST: new URL(ollama.url).host,
				// The fixture lists the fake daemon's tags the way agent discovery does, and
				// refuses set_model for a tag its catalog has not picked up yet.
				OMP_GUI_TEST_OLLAMA_URL: ollama.url,
				// The launch env wins over the login shell's, so an exported OLLAMA_BASE_URL cannot redirect the probe.
				OLLAMA_BASE_URL: "",
			},
		});
		await awaitMainWindow(browser);

		const welcome = $(WELCOME);
		await expect(welcome).toBeDisplayed();
		await expect(welcome.$('.omp-ollama-row[data-state="ok"]')).toHaveText("Ollama is running (0 models)", {
			containing: true,
		});
		await expect(welcome.$('.omp-welcome-facts[data-state="ready"]')).toHaveText("Memory:", { containing: true });

		const downloadable = welcome.$('article:has([data-action="download-model"]:enabled)');
		await expect(downloadable).toBeDisplayed();
		const tag = await downloadable.getAttribute("data-tag");
		if (!tag) throw new Error("model card has no data-tag");
		// Gemma refs carry Ollama's own `:latest`, so the pulled tag is the one /api/tags lists.
		expect(tag).toMatch(/^hf\.co\/google\/gemma-4-[\w-]+-it-qat-q4_0-gguf:latest$/);
		// Pinned by tag: the Download button, and with it the :has() match, goes away once the pull starts.
		const card = welcome.$(`article[data-tag="${tag}"]`);
		const download = card.$('[data-action="download-model"]');
		await expect(welcome.$('[data-action="continue"]')).toBeDisabled();

		await download.click();
		// The streamed frames reach the card as a progress bar before the card turns installed.
		await expect(card.$('[role="progressbar"]')).toBeDisplayed();
		await expect(card).toHaveAttribute("data-installed", "true", { wait: 20_000 });
		await expect(card).toHaveText("On this machine, ready to use", { containing: true });
		expect(pulls).toEqual([tag]);

		const continueButton = welcome.$('[data-action="continue"]');
		await expect(continueButton).toBeEnabled();
		// The pulled model's measurement waits for the welcome screen to close.
		expect(showRequests()).toEqual([]);
		await continueButton.click();
		await expect(welcome).not.toBeDisplayed();

		// The catalog started empty, so only a forced refresh lets set_model find the new tag.
		expect(await recorded(first.record, "get_available_models")).toContainEqual(
			expect.objectContaining({ forceRefresh: true }),
		);
		expect(await recorded(first.record, "set_model")).toEqual([
			expect.objectContaining({ provider: "ollama", modelId: tag }),
		]);
		expect(await recorded(first.record, "set_model_role")).toEqual([
			expect.objectContaining({ role: "default", modelId: `ollama/${tag}` }),
		]);
		const prefsFile = path.join(first.desktop, "prefs.json");
		const prefs = JSON.parse(await fs.readFile(prefsFile, "utf8")) as {
			welcome?: { completed?: unknown };
		};
		expect(typeof prefs.welcome?.completed).toBe("string");

		// The fake has no /api/show, so the measurement fails and the failure is stored.
		const lastError = async () => {
			try {
				const stored = JSON.parse(await fs.readFile(prefsFile, "utf8")) as ContextFitPrefs;
				return stored.ollamaContextFit?.models?.[tag]?.lastError ?? null;
			} catch {
				return null;
			}
		};
		await browser.waitUntil(async () => /HTTP 404/.test((await lastError()) ?? ""), {
			timeout: 20_000,
			timeoutMsg: "the pulled model's failed measurement was not stored",
		});
		expect(await lastError()).toMatch(/HTTP 404/);
		const relaunchedAt = Date.now();

		await relaunch(first);
		await awaitMainWindow(browser);
		const ready = $("textarea");
		await expect(ready).toBeDisplayed();
		// The gate runs on the ready transition; give it the time a probe would take before asserting absence.
		await browser.pause(2_000);
		await expect($$(WELCOME)).toBeElementsArrayOfSize(0);
		// A failure under the same machine is not retried automatically.
		expect(showRequests(relaunchedAt)).toEqual([]);
	}).timeout(120_000);
});
