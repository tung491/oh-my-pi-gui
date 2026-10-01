/**
 * Release gate: the combined latest-mac.yml must keep macOS 12 installs from
 * being offered a build they cannot open. Usage:
 *   bun run check:mac-update-floor dist/latest-mac.yml
 */

import * as fs from "node:fs";
import { macUpdateFloorError } from "./mac-update-floor";

const file = process.argv[2];
if (!file) {
	console.error("usage: bun run check:mac-update-floor <latest-mac.yml>");
	process.exit(1);
}

const error = macUpdateFloorError(fs.readFileSync(file, "utf8"));
if (error) {
	console.error(`${file}: ${error}`);
	process.exit(1);
}

console.log(`${file}: macOS update floor is in place`);
