import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { vi } from "../src/renderer/locales/vi";
import {
	SHOWCASE_SCENARIOS,
	SHOWCASE_SHOTS,
	type ShowcaseScenario,
	showcaseSessionTitles,
	showcaseTimestamp,
} from "./showcase-data";

const root = path.resolve(import.meta.dir, "..");
const realHome = os.homedir();
const privateText = [realHome, root, process.env.USER].filter((value): value is string => Boolean(value));
const theme = process.env.SHOWCASE_THEME === "light" ? "light" : "dark";
const outRoot = process.env.SHOWCASE_OUT ?? path.join(root, "docs", "screenshots");
const captureOnboarding = process.env.SHOWCASE_ONBOARDING === "1";
// The launch env replaces the parent's, so pass the display through for Linux hosts.
const displayEnv = Object.fromEntries(
	["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY"].flatMap(key =>
		process.env[key] ? [[key, process.env[key]]] : [],
	),
);

type Locale = "en" | "vi";

/** One app launch on a fresh temporary home: the stand-in agent replays one office task. */
async function captureScene(language: Locale, scenario: ShowcaseScenario, onboarding: boolean): Promise<void> {
	const t = language === "vi" ? vi : en;
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-showcase-"));
	const home = path.join(temporary, "home");
	const project = path.join(home, "Documents");
	const agent = path.join(home, ".omp", "agent");
	const desktop = path.join(temporary, "desktop");
	const output = path.join(outRoot, language);
	await Promise.all([project, agent, desktop, output].map(directory => fs.mkdir(directory, { recursive: true })));
	await Bun.write(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true, theme }));
	const fixture = path.join(temporary, "omp-showcase");
	await Bun.write(
		fixture,
		`#!/usr/bin/env bun\nimport ${JSON.stringify(path.join(root, "scripts", "showcase-fixture.ts"))};\n`,
	);
	await fs.chmod(fixture, 0o700);
	const titles = showcaseSessionTitles(language);
	for (const [index, title] of titles.entries()) {
		const entries = [
			{ type: "title", title },
			{ type: "session", id: `showcase-${index}`, timestamp: "2026-09-21T08:00:00.000Z", cwd: project },
			{ type: "message", id: `user-${index}`, message: { role: "user", content: title } },
			{
				type: "message",
				id: `assistant-${index}`,
				message: { role: "assistant", content: [{ type: "text", text: title }], stopReason: "stop" },
			},
		];
		await Bun.write(
			path.join(agent, "sessions", "documents", `showcase-${index}.jsonl`),
			`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
		);
	}
	const app = await electron.launch({
		args: [
			path.join(root, "out", "main", "index.js"),
			project,
			`--user-data-dir=${desktop}`,
			// Xwayland presents an obscured window at 1 Hz, so each screenshot would wait for a
			// frame for seconds; unpacing frames from presentation keeps the stability poll sampling.
			...(process.platform === "linux" ? ["--disable-gpu-vsync"] : []),
		],
		cwd: project,
		env: {
			HOME: home,
			USER: "demo",
			LOGNAME: "demo",
			SHELL: "/usr/bin/false",
			PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			TMPDIR: temporary,
			LANG: "en_US.UTF-8",
			PI_CODING_AGENT_DIR: agent,
			OMP_BUNDLED_OMP: fixture,
			OMP_SHOWCASE_PROJECT: project,
			OMP_SHOWCASE_LANG: language,
			OMP_SHOWCASE_SCENARIO: scenario,
			PI_NOTIFICATIONS: "off",
			...displayEnv,
		},
	});
	const errors: string[] = [];
	try {
		await app.context().route("**/*", route => {
			const url = new URL(route.request().url());
			return ["file:", "data:", "blob:"].includes(url.protocol) || ["127.0.0.1", "localhost"].includes(url.hostname)
				? route.continue()
				: route.abort();
		});
		const page = await app.firstWindow();
		const cdp = await app.context().newCDPSession(page);
		await cdp.send("Emulation.setLocaleOverride", { locale: language === "en" ? "en-US" : "vi-VN" });
		await page.clock.install({ time: showcaseTimestamp });
		page.on("pageerror", error => errors.push(error.message));
		page.setDefaultTimeout(15_000);
		await page.setViewportSize({ width: 1440, height: 960 });
		await expect(page.locator("textarea").first()).toBeVisible();

		async function shot(name: string): Promise<void> {
			await page.mouse.move(1430, 950);
			await page.waitForFunction(() =>
				document.getAnimations().every(animation => {
					const timing = animation.effect?.getComputedTiming();
					return timing?.iterations === Infinity || animation.playState !== "running";
				}),
			);
			await page.evaluate(() => document.fonts.ready);
			const text = await page.locator("body").innerText();
			if (privateText.some(value => text.includes(value)) || /\/(?:Users|home)\/(?!demo\b)[^\s/]+/.test(text)) {
				throw new Error(`Privacy check failed for ${language}/${name}`);
			}
			if (errors.length > 0) throw new Error(`Renderer errors: ${errors.join("; ")}`);
			await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
			console.log(`Captured ${language}/${name}`);
		}

		if (onboarding) {
			// The welcome screen is reopened by hand: the stand-in reports a local model,
			// so the startup gate leaves it closed.
			await page.getByRole("button", { name: t["ollama.settings.title"], exact: true }).first().click();
			await page.getByRole("button", { name: t["ollama.settings.runSetup"], exact: true }).click();
			const welcome = page.getByRole("dialog");
			// Wait for the Ollama probe and the machine facts so the shot shows no skeletons.
			await expect(welcome.locator('.omp-ollama-row:not([data-state="loading"])')).toBeVisible();
			await expect(welcome.locator('.omp-welcome-facts:not([data-state="loading"])')).toBeVisible();
			await shot("00-onboarding");
			return;
		}

		await expect(page.getByTitle(t["input.model"], { exact: true })).toBeEnabled();
		await expect(page.locator("[data-office-file]").first()).toBeVisible();
		await shot(SHOWCASE_SHOTS[scenario]);
	} finally {
		await app.close();
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

for (const language of ["en", "vi"] as const) {
	for (const scenario of SHOWCASE_SCENARIOS) await captureScene(language, scenario, false);
	if (captureOnboarding) await captureScene(language, "report", true);
}
