// Pack load check: starts the sidecar with the shells' assistant-pack spawn flags and env and
// proves it loaded exactly the pack: the tool list, the four skills, the system prompt, no pack
// agent, and every config.yml setting read back with the pack's value from the overlay layer.
// The working folder holds planted `.omp/APPEND_SYSTEM.md` and `.claude/APPEND_SYSTEM.md` files, and
// it and its parent hold planted instruction files (AGENTS.md, CLAUDE.md, GEMINI.md,
// .github/copilot-instructions.md); none of them may reach the system prompt.
//   bun scripts/check-assistant-pack.ts <omp binary> [<pack dir>] [--tools <comma list>] [--lang en|vi]
// The pack dir defaults to the one the shells resolve for that binary. Prints one row per tool,
// skill and setting; exits 1 naming every failed check, 2 on bad usage.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
	ASSISTANT_PACK_REMOVED_ENV,
	assistantPackEnv,
	assistantPackFlags,
	missingAssistantPackFile,
	resolveAssistantPackDir,
} from "../src/main/assistant-pack";

const PACK_SKILLS = ["sai-os-helpdesk", "slides-from-report", "spreadsheet-cleanup", "word-report"];
/** Workspace folders omp searches for an `APPEND_SYSTEM.md` when no append prompt is passed. */
const APPEND_PROMPT_DIRS = [".omp", ".claude"];
/** Folder instruction files omp loads as context files unless the session skips them. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", join(".github", "copilot-instructions.md")];
const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const USAGE =
	"usage: bun scripts/check-assistant-pack.ts <omp binary> [<pack dir>] [--tools <comma list>] [--lang en|vi]";

type Frame = { type: string; [key: string]: unknown };

interface Response {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return Bun.deepEquals(sorted(a), sorted(b));
}

/** Newline-delimited JSON client for `omp --mode rpc-ui` (protocol v2, chunked frames). */
class Sidecar {
	readonly stderr: string[] = [];
	/** `notice` and `extension_error` frames, in arrival order. */
	readonly notices: Frame[] = [];
	readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #pending = new Map<string, (response: Response) => void>();
	readonly #chunks = new Map<string, { parts: string[]; count: number }>();
	readonly #ready: Promise<void>;
	readonly exited: Promise<number>;
	#seq = 0;
	#exitCode: number | null = null;

	constructor(argv: string[], env: Record<string, string>, cwd: string) {
		this.#proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		let onReady: () => void = () => {};
		let onExit: (error: Error) => void = () => {};
		this.#ready = new Promise<void>((resolveReady, rejectReady) => {
			onReady = resolveReady;
			onExit = rejectReady;
		});
		this.exited = this.#proc.exited.then(code => {
			this.#exitCode = code;
			onExit(new Error(`the sidecar exited before it was ready (code ${code})`));
			return code;
		});
		void this.#pump(this.#proc.stdout, line => this.#onLine(line, onReady));
		void this.#pump(this.#proc.stderr, line => {
			if (line.trim()) this.stderr.push(line);
		});
	}

	async ready(timeoutMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no ready frame within ${timeoutMs / 1000} s`)), timeoutMs);
		});
		try {
			await Promise.race([this.#ready, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	async data<T>(command: Record<string, unknown> & { type: string }): Promise<T> {
		if (this.#exitCode !== null) throw new Error("the sidecar is not running");
		const id = `check-${++this.#seq}`;
		const response = await new Promise<Response>((resolveResponse, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`${command.type} timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.#pending.set(id, value => {
				clearTimeout(timer);
				resolveResponse(value);
			});
			this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			this.#proc.stdin.flush();
		});
		if (!response.success) throw new Error(`${command.type} failed: ${response.error ?? "unknown error"}`);
		return response.data as T;
	}

	async stop(): Promise<void> {
		if (this.#exitCode !== null) return;
		try {
			this.#proc.stdin.end();
		} catch {
			// stdin is already closed.
		}
		this.#proc.kill("SIGTERM");
		const killer = setTimeout(() => this.#proc.kill("SIGKILL"), KILL_GRACE_MS);
		await this.exited;
		clearTimeout(killer);
	}

	#onLine(line: string, onReady: () => void): void {
		if (!line.trim()) return;
		let frame: Frame;
		try {
			frame = JSON.parse(line) as Frame;
		} catch {
			return;
		}
		if (frame.type === "rpc_chunk") {
			const chunkId = String(frame.chunkId);
			const entry = this.#chunks.get(chunkId) ?? { parts: [], count: Number(frame.count) };
			entry.parts[Number(frame.index)] = String(frame.data);
			this.#chunks.set(chunkId, entry);
			if (entry.parts.filter(part => part !== undefined).length < entry.count) return;
			this.#chunks.delete(chunkId);
			try {
				frame = JSON.parse(Buffer.concat(entry.parts.map(part => Buffer.from(part, "base64"))).toString("utf8"));
			} catch {
				return;
			}
		}
		if (frame.type === "ready") onReady();
		if (frame.type === "notice" || frame.type === "extension_error") this.notices.push(frame);
		if (frame.type === "response" && typeof frame.id === "string") {
			const waiter = this.#pending.get(frame.id);
			if (waiter) {
				this.#pending.delete(frame.id);
				waiter(frame as unknown as Response);
			}
		}
	}

	async #pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of stream) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					onLine(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
			}
		} catch {
			// The stream closes when the sidecar exits.
		}
		if (buffer) onLine(buffer);
	}
}

/** Walks config.yml down to the setting paths the schema knows; anything else is unknown. */
function flattenToSchema(
	value: Record<string, unknown>,
	prefix: string,
	known: ReadonlySet<string>,
	out: { path: string; expected: unknown }[],
	unknown: string[],
): void {
	for (const [key, child] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (known.has(path)) out.push({ path, expected: child });
		else if (isPlainObject(child)) flattenToSchema(child, path, known, out, unknown);
		else unknown.push(path);
	}
}

function promptSkillNames(prompt: readonly string[]): string[] {
	const names = new Set<string>();
	for (const part of prompt) for (const match of part.matchAll(/<skill name="([^"]+)">/g)) names.add(match[1]);
	return sorted([...names]);
}

/** True when `path` lies strictly inside `dir`, comparing the first relative segment with "..". */
function isInside(path: string, dir: string): boolean {
	const rel = relative(dir, resolve(path));
	return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

function parseCommandLine() {
	return parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: { tools: { type: "string" }, lang: { type: "string" } },
	});
}

async function check(
	sidecar: Sidecar,
	pack: string,
	tools: readonly string[],
	appendMarker: string,
	instructionMarkers: ReadonlyMap<string, string>,
): Promise<string[]> {
	const failures: string[] = [];
	await sidecar.data({ type: "negotiate_protocol", protocolVersion: 2 });

	const active = await sidecar.data<{ tools: { name: string }[] }>({ type: "get_active_tools" });
	const activeNames = sorted(active.tools.map(tool => tool.name));
	for (const name of activeNames) console.log(`tool    ${name}`);
	if (!sameSet(activeNames, tools)) {
		const missing = tools.filter(name => !activeNames.includes(name));
		const extra = activeNames.filter(name => !tools.includes(name));
		failures.push(`tools differ from --tools: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
	}

	const commands = await sidecar.data<{ commands?: { name?: unknown }[] }>({ type: "get_available_commands" });
	const skills = sorted(
		(commands.commands ?? [])
			.map(command => command.name)
			.filter((name): name is string => typeof name === "string" && name.startsWith("skill:"))
			.map(name => name.slice("skill:".length)),
	);
	for (const name of skills) console.log(`skill   ${name}`);
	if (!sameSet(skills, PACK_SKILLS))
		failures.push(`skills are [${skills.join(", ")}], not [${PACK_SKILLS.join(", ")}]`);

	const state = await sidecar.data<{ systemPrompt?: string[] }>({ type: "get_state" });
	const prompt = state.systemPrompt ?? [];
	const packPrompt = readFileSync(join(pack, "system-prompt.md"), "utf8").trim();
	if (!prompt.some(part => part.includes(packPrompt)))
		failures.push("the system prompt does not hold system-prompt.md");
	const leaked = prompt.some(part => part.includes(appendMarker));
	console.log(`append  workspace APPEND_SYSTEM.md ${leaked ? "reached the system prompt" : "ignored"}`);
	if (leaked) failures.push("a workspace APPEND_SYSTEM.md reached the system prompt");
	const instructions = [...instructionMarkers].filter(([marker]) => prompt.some(part => part.includes(marker)));
	const reached = instructions.map(([, file]) => file).join(", ");
	console.log(`context  workspace instruction files ${reached ? `reached the system prompt: ${reached}` : "ignored"}`);
	if (reached) failures.push(`workspace instruction files reached the system prompt: ${reached}`);
	const promptSkills = promptSkillNames(prompt);
	if (!sameSet(promptSkills, PACK_SKILLS)) {
		failures.push(`the system prompt lists skills [${promptSkills.join(", ")}]`);
	}

	const agents = await sidecar.data<{ agents: { name: string; source?: string; filePath?: string }[] }>({
		type: "get_agent_definitions",
	});
	for (const agent of agents.agents) {
		if (agent.filePath && isInside(agent.filePath, pack)) {
			failures.push(`agent ${agent.name} comes from the pack (${agent.source ?? "unknown source"})`);
		}
	}

	const config = Bun.YAML.parse(readFileSync(join(pack, "config.yml"), "utf8"));
	if (!isPlainObject(config)) {
		failures.push("config.yml is not a mapping");
		return failures;
	}
	const schema = await sidecar.data<{ entries: { path: string; type: string }[] }>({ type: "get_settings_schema" });
	const types = new Map(schema.entries.map(entry => [entry.path, entry.type]));
	const expected: { path: string; expected: unknown }[] = [];
	const unknown: string[] = [];
	flattenToSchema(config, "", new Set(types.keys()), expected, unknown);
	for (const path of unknown) failures.push(`config.yml key ${path} is not a known setting`);
	const read = await sidecar.data<{
		values: Record<string, unknown>;
		provenance: Record<string, { layers?: unknown }>;
	}>({ type: "get_settings", paths: expected.map(row => row.path) });
	for (const row of expected) {
		const actual = read.values[row.path];
		const layers = read.provenance[row.path]?.layers;
		const layerList = Array.isArray(layers) ? layers.map(String) : [];
		console.log(`setting ${row.path} = ${JSON.stringify(actual)}  [${layerList.join(", ")}]`);
		let matches: boolean;
		if (types.get(row.path) === "record" && isPlainObject(row.expected) && isPlainObject(actual)) {
			const want = row.expected;
			// Records merge across layers: every pack entry must read back.
			matches = Object.entries(want).every(([key, value]) => Bun.deepEquals(actual[key], value));
		} else {
			matches = Bun.deepEquals(actual, row.expected);
		}
		if (!matches) failures.push(`setting ${row.path} reads ${JSON.stringify(actual)}`);
		// A rejected value falls back to its default with only a log warning; the layer proves the pack value won.
		if (!layerList.includes("overlay")) failures.push(`setting ${row.path} does not come from the overlay`);
	}

	// Load warnings arrive as notice or extension_error frames.
	const packNames = [pack, "sai-atlas-assistant-pack", "tools.js"];
	for (const frame of sidecar.notices) {
		const text = JSON.stringify(frame);
		if (frame.type === "extension_error") failures.push(`extension error: ${text}`);
		else if (packNames.some(name => text.includes(name))) failures.push(`notice about the pack: ${text}`);
	}
	return failures;
}

async function main(): Promise<number> {
	let parsed: ReturnType<typeof parseCommandLine>;
	try {
		parsed = parseCommandLine();
	} catch (error) {
		console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 2;
	}
	const [ompArg, packArg] = parsed.positionals;
	const lang = parsed.values.lang ?? "en";
	if (!ompArg || parsed.positionals.length > 2 || (lang !== "en" && lang !== "vi")) {
		console.error(USAGE);
		return 2;
	}
	const omp = resolve(ompArg);
	const pack = packArg ? resolve(packArg) : resolveAssistantPackDir(omp);
	if (!existsSync(omp)) {
		console.error(`sidecar binary missing: ${omp}`);
		return 2;
	}
	const missing = missingAssistantPackFile(pack);
	if (missing) {
		console.error(`the pack has no ${missing}: ${pack} (run bun run build:pack)`);
		return 2;
	}
	// The flags the shells spawn with; `--tools` replaces only the tool list.
	const packFlags = assistantPackFlags(pack, process.platform);
	const toolsAt = packFlags.indexOf("--tools") + 1;
	const tools = (parsed.values.tools ?? packFlags[toolsAt])
		.split(",")
		.map(name => name.trim())
		.filter(Boolean);
	packFlags[toolsAt] = tools.join(",");

	const scratch = mkdtempSync(join(tmpdir(), "sai-atlas-pack-check-"));
	const home = join(scratch, "home");
	const cwd = join(scratch, "work");
	mkdirSync(home);
	mkdirSync(cwd);
	// A workspace's own append prompt must never reach a pack session.
	const appendMarker = `sai-atlas-workspace-append-${process.pid}-${Date.now()}`;
	for (const dir of APPEND_PROMPT_DIRS) {
		mkdirSync(join(cwd, dir));
		writeFileSync(join(cwd, dir, "APPEND_SYSTEM.md"), `${appendMarker}\n`);
	}
	// Nor may the instruction files in the working folder or its parent. Each file gets its own
	// marker, so a failure names the file that leaked.
	const instructionMarkers = new Map<string, string>();
	for (const [folder, label] of [
		[cwd, "work"],
		[scratch, "parent"],
	] as const) {
		for (const file of INSTRUCTION_FILES) {
			const marker = `sai-atlas-workspace-instructions-${label}-${file.replace(/\W/g, "-")}-${process.pid}`;
			mkdirSync(dirname(join(folder, file)), { recursive: true });
			writeFileSync(join(folder, file), `${marker}\n`);
			instructionMarkers.set(marker, `${label}/${file}`);
		}
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	// The sidecar reads only the scratch HOME and the pack: a caller's own omp config location
	// would add layers (or hide skills) that the shells never pass to a pack session.
	for (const key of [...ASSISTANT_PACK_REMOVED_ENV, "PI_CONFIG_FILES", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) {
		delete env[key];
	}
	env.HOME = home;
	Object.assign(env, assistantPackEnv({ language: lang }));
	const argv = [omp, "--mode", "rpc-ui", "--no-session", ...packFlags];

	const sidecar = new Sidecar(argv, env, cwd);
	let failures: string[];
	try {
		await sidecar.ready(READY_TIMEOUT_MS);
		failures = await check(sidecar, pack, tools, appendMarker, instructionMarkers);
	} catch (error) {
		const tail = sidecar.stderr.slice(-20).join("\n");
		failures = [`${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ""}`];
	} finally {
		await sidecar.stop();
		rmSync(scratch, { recursive: true, force: true });
	}

	if (failures.length > 0) {
		console.log(`PACK LOAD CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
		return 1;
	}
	console.log("PACK LOAD CHECK: PASS");
	return 0;
}

process.exit(await main());
