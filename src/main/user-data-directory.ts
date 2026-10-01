import { join, resolve } from "node:path";

/**
 * The profile directory: `--user-data-dir` when given, otherwise the path every
 * 0.9.x release derived from package.json `name`. It is pinned, never derived
 * from the product name, so a rename cannot orphan anyone's settings.
 */
export function userDataDirectory(appData: string, override: string): string {
	return override ? resolve(override) : join(appData, "@oh-my-pi", "omp-gui");
}
