// The assistant pack's extension module (bundled to tools.js): registers the three office tools
// everywhere and the four SAI OS tools on Linux only, every one kept in the top-level tool list.
// omp adds every extension-registered tool to the session whatever `--tools` says, so the
// platform gate lives here, matching the shells' flag lists.
import { registerOfficeTools } from "./office-tools";
import { createOsTools } from "./os-commands";
import type { PackExtensionApi } from "./types";

export function registerPackToolsFor(pi: PackExtensionApi, platform: NodeJS.Platform): void {
	if (platform === "linux") for (const tool of createOsTools()) pi.registerTool(tool);
	registerOfficeTools(pi);
}

export default function registerPackTools(pi: PackExtensionApi): void {
	registerPackToolsFor(pi, process.platform);
}
