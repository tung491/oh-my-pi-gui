import { LINUX_DISPLAY_SWITCH } from "../src/main/relaunch-args";

/**
 * The switches a desktop entry passes to a packaged build. A test that
 * launches one directly passes them too: without the display switch, a Linux
 * launch restarts itself once and Playwright loses the process it started.
 */
export const DESKTOP_ENTRY_SWITCHES: readonly string[] = process.platform === "linux" ? [LINUX_DISPLAY_SWITCH] : [];
