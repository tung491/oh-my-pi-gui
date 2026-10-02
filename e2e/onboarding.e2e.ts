import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { type FakeOllama, sendJson, startFakeOllama } from "../src/main/ollama/test-fake-ollama";
import { writeDesktopPrefs } from "./desktop-prefs";

// A fresh profile meets the welcome screen once: download a model from a fake
// Ollama, continue, and the next launch goes straight to the assistant.
// The Playwright runner is Node, so the daemon is the node:http fake the unit
// tests share rather than Bun.serve.

let profile: string;
let userData: string;
let project: string;
let agent: string;
let record: string;
let ollama: FakeOllama;
const installed = new Set<string>();
const pulls: string[] = [];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-onboarding-"));
	project = path.join(profile, "project");
	userData = path.join(profile, "desktop");
	agent = path.join(profile, "agent");
	record = path.join(profile, "rpc.jsonl");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	await writeDesktopPrefs(userData, { language: "en" }, { freshWelcome: true });
	await fs.chmod(path.resolve("e2e/sidecar-fixture.ts"), 0o755);
	ollama = await startFakeOllama((req, res, body) => {
		const url = new URL(req.url ?? "/", "http://fake.invalid");
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

test.afterAll(async () => {
	await ollama?.close();
	if (record) await fs.copyFile(record, "test-results/onboarding-rpc.jsonl").catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: path.resolve("e2e/sidecar-fixture.ts"),
		OMP_GUI_TEST_RECORD: record,
		OLLAMA_HOST: new URL(ollama.url).host,
		// The fixture lists the fake daemon's tags the way agent discovery does, and
		// refuses set_model for a tag its catalog has not picked up yet.
		OMP_GUI_TEST_OLLAMA_URL: ollama.url,
		// The launch env wins over the login shell's, so an exported OLLAMA_BASE_URL cannot redirect the probe.
		OLLAMA_BASE_URL: "",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${userData}`],
		env,
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	return { app, page };
}

async function quit(app: ElectronApplication): Promise<void> {
	// Test teardown bypasses the production quit confirmation.
	await app.evaluate(({ app }) => app.exit(0));
	await app.close().catch(() => {});
}

async function recorded(type: string): Promise<Record<string, unknown>[]> {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(command => command.type === type);
}

test("a fresh profile downloads a model on the welcome screen and does not see it again", async () => {
	test.setTimeout(120_000);
	const first = await launch();
	try {
		const welcome = first.page.getByRole("dialog", { name: "Set up your local assistant" });
		await expect(welcome).toBeVisible();
		await expect(welcome.locator('.omp-ollama-row[data-state="ok"]')).toContainText("Ollama is running (0 models)");
		await expect(welcome.locator('.omp-welcome-facts[data-state="ready"]')).toContainText("Memory:");

		const downloadable = welcome.locator('article:has([data-action="download-model"]:enabled)').first();
		await expect(downloadable).toBeVisible();
		const tag = await downloadable.getAttribute("data-tag");
		if (!tag) throw new Error("model card has no data-tag");
		// Pinned by tag: the Download button, and with it the :has() match, goes away once the pull starts.
		const card = welcome.locator(`article[data-tag="${tag}"]`);
		const download = card.locator('[data-action="download-model"]');
		await expect(welcome.locator('[data-action="continue"]')).toBeDisabled();

		await download.click();
		// The streamed frames reach the card as a progress bar before the card turns installed.
		await expect(card.getByRole("progressbar")).toBeVisible();
		await expect(card).toHaveAttribute("data-installed", "true", { timeout: 20_000 });
		await expect(card).toContainText("On this machine, ready to use");
		expect(pulls).toEqual([tag]);

		const continueButton = welcome.locator('[data-action="continue"]');
		await expect(continueButton).toBeEnabled();
		await continueButton.click();
		await expect(welcome).toBeHidden();

		// The catalog started empty, so only a forced refresh lets set_model find the new tag.
		expect(await recorded("get_available_models")).toContainEqual(expect.objectContaining({ forceRefresh: true }));
		expect(await recorded("set_model")).toEqual([expect.objectContaining({ provider: "ollama", modelId: tag })]);
		expect(await recorded("set_model_role")).toEqual([
			expect.objectContaining({ role: "default", modelId: `ollama/${tag}` }),
		]);
		const prefs = JSON.parse(await fs.readFile(path.join(userData, "prefs.json"), "utf8")) as {
			welcome?: { completed?: unknown };
		};
		expect(typeof prefs.welcome?.completed).toBe("string");
	} finally {
		await quit(first.app);
	}

	const second = await launch();
	try {
		const ready = second.page.locator("textarea").first();
		await expect(ready).toBeVisible();
		// The gate runs on the ready transition; give it the time a probe would take before asserting absence.
		await second.page.waitForTimeout(2_000);
		await expect(second.page.getByRole("dialog", { name: "Set up your local assistant" })).toHaveCount(0);
	} finally {
		await quit(second.app);
	}
});
