// Builds the assistant pack that every session loads through `--extension`:
//   bun scripts/build-assistant-pack.ts [--out <dir>] [--entry <extension module>]
// The pack is assembled in a temporary folder beside the output and renamed into place, so a
// failed build never leaves a partial pack. The only script in it is the bundled tools.js.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "assistant-pack");
const DEFAULT_OUT = join(ROOT, "resources", "assistant-pack");
const DEFAULT_ENTRY = join(SOURCE, "src", "tools", "index.ts");
const BUNDLE = "tools.js";
const MANIFEST = { name: "sai-atlas-assistant-pack", private: true, omp: { extensions: [`./${BUNDLE}`] } };
const TEXT_FILES = ["system-prompt.md", "append-system-prompt.md", "config.yml"];

/** Every .js file under `dir` other than the bundle, as paths relative to `dir`. */
export function strayScripts(dir: string): string[] {
	const walk = (folder: string): string[] =>
		readdirSync(folder).flatMap(name => {
			const path = join(folder, name);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
	return walk(dir)
		.map(path => relative(dir, path))
		.filter(path => path.endsWith(".js") && path !== BUNDLE);
}

async function buildInto(dir: string, entry: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const result = await Bun.build({ entrypoints: [entry], outdir: dir, naming: BUNDLE, target: "bun", minify: false });
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("bundling the pack tools failed");
	}
	const bundle = readFileSync(join(dir, BUNDLE), "utf8");
	if (/require\(\s*["']@oh-my-pi|from\s*["']@oh-my-pi/.test(bundle)) {
		throw new Error(`${BUNDLE} imports from @oh-my-pi; the pack must bundle everything it uses`);
	}
	cpSync(join(SOURCE, "skills"), join(dir, "skills"), { recursive: true });
	for (const file of TEXT_FILES) cpSync(join(SOURCE, file), join(dir, file));
	await Bun.write(join(dir, "package.json"), `${JSON.stringify(MANIFEST, null, "\t")}\n`);
	const stray = strayScripts(dir);
	if (stray.length > 0) throw new Error(`the pack may hold no script but ${BUNDLE}; found ${stray.join(", ")}`);
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { out: { type: "string" }, entry: { type: "string" } },
		strict: true,
	});
	const out = resolve(values.out ?? DEFAULT_OUT);
	const entry = resolve(values.entry ?? DEFAULT_ENTRY);
	const temp = `${out}.tmp-${process.pid}`;
	rmSync(temp, { recursive: true, force: true });
	mkdirSync(dirname(out), { recursive: true });
	try {
		await buildInto(temp, entry);
	} catch (error) {
		rmSync(temp, { recursive: true, force: true });
		console.error(`build-assistant-pack: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (existsSync(out)) rmSync(out, { recursive: true, force: true });
	renameSync(temp, out);
	console.log(`assistant pack written to ${relative(process.cwd(), out) || out}`);
	return 0;
}

// Importing the module (as the tests do) only exposes strayScripts; running it with Bun builds the pack.
if (import.meta.main && typeof Bun !== "undefined") process.exit(await main());
