import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The welcome screen opens on every launch until `welcome.completed` is set
 * (FirstRunOnboardingDialog's WELCOME_COMPLETED_PREF) or an Ollama model is
 * usable, and it covers whatever a spec drives next. electron-store keeps a
 * dotted key nested, so the seed is `{ welcome: { completed } }`.
 */
const WELCOME_DONE = { completed: "2026-01-01T00:00:00.000Z" };

export interface DesktopPrefsOptions {
	/** Leave the welcome screen unseen. Only the onboarding spec needs this. */
	freshWelcome?: boolean;
}

/** Write the GUI's `prefs.json` into a test profile's user-data directory. */
export async function writeDesktopPrefs(
	userData: string,
	prefs: Record<string, unknown>,
	options: DesktopPrefsOptions = {},
): Promise<void> {
	const seeded = options.freshWelcome ? prefs : { welcome: WELCOME_DONE, ...prefs };
	await fs.writeFile(path.join(userData, "prefs.json"), JSON.stringify(seeded));
}
