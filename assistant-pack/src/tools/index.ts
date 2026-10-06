// The assistant pack's extension module (bundled to tools.js): registers the four SAI OS tools
// and the three office tools, every one kept in the top-level tool list.
import { registerOfficeTools } from "./office-tools";
import { createOsTools } from "./os-commands";
import type { PackExtensionApi } from "./types";

export default function registerPackTools(pi: PackExtensionApi): void {
	for (const tool of createOsTools()) pi.registerTool(tool);
	registerOfficeTools(pi);
}
