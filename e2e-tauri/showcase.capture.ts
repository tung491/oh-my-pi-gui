/**
 * The README screenshots (docs/screenshots/<en|vi>/<shot>.png): one launch of
 * the e2e-hooks debug build per language and office task, each on a fresh
 * temporary HOME and profile with the scripted stand-in agent
 * (scripts/showcase-fixture.ts), so no live model, credentials or personal
 * files are used. Only wdio.showcase.conf.ts runs this file.
 *
 * SHOWCASE_THEME=light, SHOWCASE_OUT=<dir> and SHOWCASE_ONBOARDING=1 work as
 * the README describes.
 */
import { spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $, browser } from "@wdio/globals";
import {
	SHOWCASE_SCENARIOS,
	SHOWCASE_SHOTS,
	type ShowcaseScenario,
	showcaseSessionTitles,
	showcaseTimestamp,
} from "../scripts/showcase-data";
import { en } from "../src/renderer/locales/en";
import { vi } from "../src/renderer/locales/vi";
import {
	awaitBridge,
	awaitMainWindow,
	byRole,
	collectPageErrors,
	launch,
	pageErrors,
	ROOT,
	runDir,
	shellQuote,
	until,
} from "./session";

type Locale = "en" | "vi";

const WIDTH = 1440;
const HEIGHT = 960;
const theme = process.env.SHOWCASE_THEME === "light" ? "light" : "dark";
const outRoot = process.env.SHOWCASE_OUT ?? path.join(ROOT, "docs", "screenshots");
const captureOnboarding = process.env.SHOWCASE_ONBOARDING === "1";
const privateText = [os.homedir(), ROOT, process.env.USER].filter((value): value is string => Boolean(value));
const VIRTUAL_DISPLAY = path.join(ROOT, "scripts", "virtual-display.sh");

/** The bun executable itself: under the temporary HOME a version-manager shim named `bun` may not resolve. */
let bun = "";

function bunBinary(): string {
	const probe = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" });
	const found = probe.stdout?.trim() ?? "";
	if (probe.status !== 0 || !found) throw new Error(`bun is not on PATH: ${probe.stderr ?? String(probe.error)}`);
	return found;
}

/** Park the virtual display's pointer in the screen corner, off the window, so no hover state is captured. */
function parkPointer(): void {
	const moved = spawnSync(VIRTUAL_DISPLAY, ["xdotool", "mousemove", "1919", "1079"], { encoding: "utf8" });
	if (moved.status !== 0) throw new Error(`virtual-display.sh xdotool failed: ${moved.stderr}`);
}

/** Start the page's wall clock at `time` and let it run on. */
async function pinClock(time: number): Promise<void> {
	await browser.execute((start: number) => {
		const RealDate = Date;
		const offset = start - RealDate.now();
		window.Date = new Proxy(RealDate, {
			construct: (target, args) => Reflect.construct(target, args.length === 0 ? [RealDate.now() + offset] : args),
			get: (target, key, receiver) =>
				key === "now" ? () => RealDate.now() + offset : Reflect.get(target, key, receiver),
		});
	}, time);
}

/**
 * Size the window so the page's viewport is exactly WIDTH × HEIGHT.
 *
 * Two things sit between the requested window size and the viewport. On a
 * display without a window manager nothing configures the window at startup,
 * so the app's one-shot outer-size correction is still armed and takes the
 * first resize for the first configure: it reads the growth over its build
 * size as a decoration and shrinks the window by it, once. After that, the
 * gap is the menu bar above the web view, so the request grows by it.
 */
async function sizeViewport(): Promise<void> {
	const viewport = () => browser.execute(() => [innerWidth, innerHeight]);
	const exact = ([width, height]: number[]) => width === WIDTH && height === HEIGHT;
	let [width, height] = [WIDTH, HEIGHT];
	let seen: number[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		await browser.setWindowSize(width, height);
		await until(viewport, exact, { timeout: 3_000 });
		// The correction lands in a later configure: hold, then read again.
		await browser.pause(500);
		seen = await viewport();
		if (exact(seen)) return;
		// The first gap is the one-shot correction, not chrome: only later gaps grow the request.
		if (attempt > 0) [width, height] = [width + WIDTH - seen[0], height + HEIGHT - seen[1]];
	}
	throw new Error(`the viewport is ${seen.join("x")}, not ${WIDTH}x${HEIGHT}`);
}

/** The sidebar's past tasks: one session file each in the stand-in's agent directory. */
async function seedSessions(agent: string, language: Locale, project: string): Promise<void> {
	const sessions = path.join(agent, "sessions", "documents");
	await fsp.mkdir(sessions, { recursive: true });
	for (const [index, title] of showcaseSessionTitles(language).entries()) {
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
		await fsp.writeFile(
			path.join(sessions, `showcase-${index}.jsonl`),
			`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
		);
	}
}

async function shot(language: Locale, name: string): Promise<void> {
	parkPointer();
	await browser.waitUntil(
		() =>
			browser.execute(() =>
				document.getAnimations().every(animation => {
					const timing = animation.effect?.getComputedTiming();
					return timing?.iterations === Infinity || animation.playState !== "running";
				}),
			),
		{ timeout: 15_000, timeoutMsg: `animations still running before ${language}/${name}` },
	);
	await browser.execute(async () => {
		await document.fonts.ready;
	});
	const text = await browser.execute(() => document.body.innerText);
	if (privateText.some(value => text.includes(value)) || /\/home\/(?!demo\b)[^\s/]+/.test(text)) {
		throw new Error(`Privacy check failed for ${language}/${name}`);
	}
	const errors = await pageErrors(browser);
	if (errors.length > 0) throw new Error(`Renderer errors: ${errors.join("; ")}`);
	await browser.saveScreenshot(path.join(outRoot, language, `${name}.png`));
	console.log(`Captured ${language}/${name}`);
}

/** One app launch on a fresh temporary home: the stand-in agent replays one office task. */
async function captureScene(language: Locale, scenario: ShowcaseScenario, onboarding: boolean): Promise<void> {
	const t = language === "vi" ? vi : en;
	const scene = await fsp.mkdtemp(path.join(runDir(), `showcase-home-${language}-`));
	const home = path.join(scene, "home");
	const project = path.join(home, "Documents");
	const go = path.join(scene, "go");
	const standIn = path.join(scene, "omp-showcase");
	await Promise.all(
		[project, path.join(outRoot, language)].map(directory => fsp.mkdir(directory, { recursive: true })),
	);
	// The stand-in starts only once `go` exists, which is written after the page's clock is pinned.
	await fsp.writeFile(
		standIn,
		[
			"#!/bin/sh",
			"i=0",
			`while [ ! -e ${shellQuote(go)} ]; do i=$((i + 1)); [ "$i" -le 300 ] || exit 1; sleep 0.1; done`,
			`exec ${shellQuote(bun)} ${shellQuote(path.join(ROOT, "scripts", "showcase-fixture.ts"))}`,
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	try {
		await launch({
			name: `showcase-${language}-${scenario}`,
			prefs: { language, theme, firstRunComplete: true },
			omp: standIn,
			noProject: true,
			args: [project],
			env: {
				HOME: home,
				USER: "demo",
				LOGNAME: "demo",
				SHELL: "/usr/bin/false",
				TMPDIR: scene,
				LANG: "en_US.UTF-8",
				PI_CONFIG_DIR: ".omp",
				OMP_E2E_APP_CWD: project,
				OMP_SHOWCASE_PROJECT: project,
				OMP_SHOWCASE_LANG: language,
				OMP_SHOWCASE_SCENARIO: scenario,
			},
			setup: prepared => seedSessions(prepared.agent, language, project),
		});
		await awaitBridge(browser);
		await pinClock(showcaseTimestamp);
		await collectPageErrors(browser);
		await fsp.writeFile(go, "");
		await awaitMainWindow(browser);
		await sizeViewport();
		await browser.waitUntil(() => $("textarea").isDisplayed(), {
			timeout: 15_000,
			timeoutMsg: "the composer never appeared",
		});
		if (onboarding) {
			// The welcome screen is reopened by hand: the stand-in reports a local model,
			// so the startup gate leaves it closed.
			await (await byRole("button", { name: t["ollama.settings.title"], exact: true })).click();
			await (await byRole("button", { name: t["ollama.settings.runSetup"], exact: true })).click();
			// Wait for the Ollama probe and the machine facts so the shot shows no skeletons.
			for (const loaded of [
				'.omp-ollama-row:not([data-state="loading"])',
				'.omp-welcome-facts:not([data-state="loading"])',
			]) {
				await browser.waitUntil(() => $(`[role="dialog"] ${loaded}`).isDisplayed(), {
					timeout: 15_000,
					timeoutMsg: `${loaded} never appeared`,
				});
			}
			await shot(language, "00-onboarding");
			return;
		}
		await browser.waitUntil(() => $(`[title=${JSON.stringify(t["input.model"])}]`).isEnabled(), {
			timeout: 15_000,
			timeoutMsg: "the model picker never enabled",
		});
		await browser.waitUntil(() => $("[data-office-file]").isDisplayed(), {
			timeout: 15_000,
			timeoutMsg: "no office file card appeared",
		});
		await shot(language, SHOWCASE_SHOTS[scenario]);
	} finally {
		// Release a stand-in that a failed step left waiting.
		await fsp.writeFile(go, "");
	}
}

describe("showcase screenshots", () => {
	before(() => {
		bun = bunBinary();
	});
	for (const language of ["en", "vi"] as const) {
		for (const scenario of SHOWCASE_SCENARIOS) {
			it(`captures ${language}/${SHOWCASE_SHOTS[scenario]}`, () => captureScene(language, scenario, false)).timeout(
				120_000,
			);
		}
		if (captureOnboarding) {
			it(`captures ${language}/00-onboarding`, () => captureScene(language, "report", true)).timeout(120_000);
		}
	}
});
