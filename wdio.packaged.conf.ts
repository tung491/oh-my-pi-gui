/**
 * The installed-package smoke: `e2e-tauri/packaged-smoke.e2e.ts` against the
 * build OMP_GUI_TEST_APP names (normally `/usr/bin/sai-atlas` from the .deb).
 * That build has no test hooks and runs its real bundled sidecar, so sessions
 * start it without the fixture. Same driver, profiles and cleanup as wdio.conf.ts.
 *
 *   OMP_GUI_TEST_APP=/usr/bin/sai-atlas bun run test:e2e:tauri:packaged
 *
 * With OMP_E2E_FAKE_MIC=1 it runs the audio probe (e2e-tauri/fake-mic.probe.ts)
 * instead, which needs an audio server with a tone at the default source.
 */

import { prepareLaunch, specName } from "./e2e-tauri/session";
import { config as base, PACKAGED_SPEC, startRun } from "./wdio.conf";

/** Opt-in: microphone capture and playback through WebKit's GStreamer backend. */
const FAKE_MIC_SPEC = "./e2e-tauri/fake-mic.probe.ts";

function installedApp(): string {
	const app = process.env.OMP_GUI_TEST_APP;
	if (!app) throw new Error("Set OMP_GUI_TEST_APP to the installed sai-atlas executable");
	return app;
}

export const config: WebdriverIO.Config = {
	...base,
	specs: [process.env.OMP_E2E_FAKE_MIC === "1" ? FAKE_MIC_SPEC : PACKAGED_SPEC],
	exclude: [],
	onPrepare: () => startRun(installedApp(), "Install the Sai ATLAS package, then point OMP_GUI_TEST_APP at it."),
	beforeSession: async (_config, capabilities, specs) => {
		const launch = await prepareLaunch({
			name: specName(specs[0] ?? "spec"),
			binary: installedApp(),
			omp: null,
			noProject: true,
		});
		Object.assign(capabilities, launch.capabilities);
	},
};
