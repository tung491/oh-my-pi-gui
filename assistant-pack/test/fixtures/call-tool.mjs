// Runs one tool of a built pack the way omp loads it: imports <packDir>/tools.js, registers its
// tools with a recording `pi`, executes the named tool once and prints the result as one JSON line.
//   BUN_BE_BUN=1 <omp binary> call-tool.mjs <packDir> <toolName> <params JSON>
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packDir, toolName, paramsJson = "{}"] = process.argv.slice(2);
if (!packDir || !toolName) {
	console.error("usage: call-tool.mjs <packDir> <toolName> <params JSON>");
	process.exit(2);
}

const tools = new Map();
const module = await import(pathToFileURL(join(packDir, "tools.js")).href);
module.default({ registerTool: tool => tools.set(tool.name, tool) });
const tool = tools.get(toolName);
if (!tool) {
	console.error(`the pack has no tool named ${toolName}`);
	process.exit(2);
}
const result = await tool.execute("t1", JSON.parse(paramsJson));
console.log(JSON.stringify(result));
