/**
 * The README screenshots: e2e-tauri/showcase.capture.ts against the e2e-hooks
 * debug build, with the driver, profiles and cleanup of wdio.conf.ts.
 *
 *   scripts/virtual-display.sh run -- bun run capture:showcase
 */
import { config as base } from "./wdio.conf";

export const config: WebdriverIO.Config = {
	...base,
	specs: ["./e2e-tauri/showcase.capture.ts"],
	exclude: [],
};
