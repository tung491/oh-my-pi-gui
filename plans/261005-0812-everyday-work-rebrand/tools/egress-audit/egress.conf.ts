/**
 * WebdriverIO run of the egress audit, inside the egress container (see
 * egress-entrypoint.sh). It reuses the worktree's driver handling from
 * wdio.conf.ts (tauri-driver on 4444, WebKitWebDriver on 4445, run directory,
 * leftover-process sweep) and differs in one thing: the session launches
 * egress-app-launcher.sh, which runs the installed app under strace with its
 * default profile and the seeded ~/.omp, never a throwaway profile.
 *
 * The entrypoint copies this file into a work directory beside two links:
 * `node_modules` (the worktree's, for @wdio/*) and `repo` (the worktree, for
 * wdio.conf.ts and the e2e-tauri helpers).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { browser } from "@wdio/globals";
import { config as base, startRun } from "./repo/wdio.conf";

const INSTALLED_APP = "/usr/bin/sai-atlas";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set; run this through egress-entrypoint.sh`);
	return value;
}

const work = required("EGRESS_WORK");
const out = required("EGRESS_OUT");

export const config: WebdriverIO.Config = {
	...base,
	tsConfigPath: path.join(work, "repo", "tsconfig.wdio.json"),
	specs: [path.join(work, "egress.e2e.ts")],
	exclude: [],
	// One action can run a local model for many minutes; each action enforces its own limit.
	mochaOpts: { ui: "bdd", timeout: 60 * 60_000, bail: false },
	onPrepare: () => startRun(INSTALLED_APP, "The .deb did not install /usr/bin/sai-atlas."),
	beforeSession: (_config, capabilities) => {
		// The launch is the start of the first-run action; the spec reads this stamp.
		fs.writeFileSync(path.join(out, "launch-start"), `${(Date.now() / 1000).toFixed(3)}\n`);
		Object.assign(capabilities, {
			"tauri:options": { application: path.join(work, "egress-app-launcher.sh"), args: [] },
			"wdio:enforceWebDriverClassic": true,
		});
	},
	afterTest: async (test, _context, result) => {
		if (result.passed) return;
		const slug = test.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		await browser.saveScreenshot(path.join(out, "screens", `failed-${slug}.png`)).catch((error: unknown) => {
			console.warn(`no failure screenshot: ${String(error)}`);
		});
	},
};
