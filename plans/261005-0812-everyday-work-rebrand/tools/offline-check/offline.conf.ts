/**
 * WebdriverIO run of the offline check, inside the offline container (see
 * offline-entrypoint.sh). It reuses the worktree's driver handling from
 * wdio.conf.ts and launches the installed app through offline-app-launcher.sh
 * with its default profile.
 */
import * as path from "node:path";
import { browser } from "@wdio/globals";
import { config as base, startRun } from "./repo/wdio.conf";

const INSTALLED_APP = "/usr/bin/sai-atlas";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set; run this through offline-entrypoint.sh`);
	return value;
}

const work = required("OFFLINE_WORK");
const out = required("OFFLINE_OUT");

export const config: WebdriverIO.Config = {
	...base,
	tsConfigPath: path.join(work, "repo", "tsconfig.wdio.json"),
	// The default run is the English offline check; OFFLINE_LANG=vi runs the language pass instead.
	specs: [path.join(work, process.env.OFFLINE_LANG === "vi" ? "offline-vi.e2e.ts" : "offline.e2e.ts")],
	exclude: [],
	mochaOpts: { ui: "bdd", timeout: 60 * 60_000, bail: false },
	onPrepare: () => startRun(INSTALLED_APP, "The .deb did not install /usr/bin/sai-atlas."),
	beforeSession: (_config, capabilities) => {
		Object.assign(capabilities, {
			"tauri:options": { application: path.join(work, "offline-app-launcher.sh"), args: [] },
			"wdio:enforceWebDriverClassic": true,
		});
	},
	afterTest: async (test, _context, result) => {
		if (result.passed) return;
		const slug = test.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		await browser.saveScreenshot(path.join(out, "screens", `failed-${slug}.png`)).catch(() => undefined);
	},
};
