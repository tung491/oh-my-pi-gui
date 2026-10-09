// Pack load check: starts the sidecar with the shells' assistant-pack spawn flags and env and
// proves it loaded exactly the pack: the tool list, the four skills, the system prompt, no pack
// agent, and every config.yml setting read back with the pack's value from the overlay layer.
// The working folder holds planted `.omp/APPEND_SYSTEM.md` and `.claude/APPEND_SYSTEM.md` files, and
// it and its parent hold planted instruction files (AGENTS.md, CLAUDE.md, GEMINI.md,
// .github/copilot-instructions.md); none of them may reach the system prompt.
// Local models only: the sidecar talks to a fake local Ollama that also lists cloud models, and the
// scratch HOME's ~/.env holds online provider keys; only the local model may be listed or selected,
// through set_model, /model or /switch, and no model request may be sent.
// A second session runs in a folder whose `.env` points OLLAMA_BASE_URL and OLLAMA_HOST at a DNS
// name that merely starts with a loopback address. Its traffic goes through a recording proxy that
// answers as that host would: the session must list no model there and send it nothing.
// The scratch HOME's ~/.omp/agent/mcp.json and the working folder's .mcp.json each name a stdio MCP
// server that only records its start: neither may start in either session, at startup, on the GUI's
// heartbeat (get_state) or on a plugin reload.
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
} from "./assistant-pack";

const PACK_SKILLS = ["sai-os-helpdesk", "slides-from-report", "spreadsheet-cleanup", "word-report"];
/** Workspace folders omp searches for an `APPEND_SYSTEM.md` when no append prompt is passed. */
const APPEND_PROMPT_DIRS = [".omp", ".claude"];
/** Folder instruction files omp loads as context files unless the session skips them. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", join(".github", "copilot-instructions.md")];
/** The fake Ollama's models: one local model, two cloud tags and a renamed copy Ollama runs remotely. */
const LOCAL_MODEL = "gemma4:e4b";
const FAKE_OLLAMA_TAGS = {
	models: [
		{ name: LOCAL_MODEL, model: LOCAL_MODEL },
		{ name: "kimi-k2:cloud", model: "kimi-k2:cloud", remote_model: "kimi-k2", remote_host: "https://ollama.com:443" },
		{ name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud" },
		{
			name: "mine:latest",
			model: "mine:latest",
			remote_model: "gpt-oss:120b",
			remote_host: "https://ollama.com:443",
		},
	],
};
/** Model switches that must all be refused; the first two have keys in ~/.env. */
const REFUSED_SET_MODELS = [
	{ provider: "anthropic", modelId: "claude-sonnet-4-5" },
	{ provider: "openai", modelId: "gpt-4" },
	{ provider: "ollama", modelId: "kimi-k2:cloud" },
	{ provider: "ollama", modelId: "gpt-oss:120b-cloud" },
	{ provider: "ollama", modelId: "mine:latest" },
];
const REFUSED_MODEL_COMMANDS = [
	"/model anthropic/claude-sonnet-4-5",
	"/model claude-sonnet-4-5:high",
	"/model kimi-k2:cloud:low",
	"/switch kimi-k2:cloud",
	"/switch openai/gpt-4",
];
/** A DNS name that only looks like a loopback address; DNS can point it anywhere. */
const FAKE_LOOPBACK_HOST = "127.0.0.1.attacker.example";
const FAKE_LOOPBACK_URL = `http://${FAKE_LOOPBACK_HOST}:11434`;
/** How long the fake-loopback session gets to send its prompt anywhere before it is aborted. */
const FAKE_LOOPBACK_PROMPT_WAIT_MS = 3_000;
/** Settings that keep sessions local; the readback must find them pinned by the overlay. */
const LOCAL_ONLY_SETTINGS = ["modelPolicy.providers", "modelPolicy.localOnly"];
/** The setting that keeps every configured MCP server from starting; the pack pins it off. */
const MCP_OFF_SETTING = "mcp.enabled";
/** How long a session gets to start a configured MCP server after its last request. */
const MCP_START_WAIT_MS = 3_000;
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

/** A local Ollama stand-in on loopback; records every model request it receives. */
function startFakeOllama(): { server: ReturnType<typeof Bun.serve>; modelRequests: string[] } {
	const modelRequests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/api/tags") return Response.json(FAKE_OLLAMA_TAGS);
			if (path === "/api/show") return Response.json({ capabilities: ["completion", "tools"] });
			if (path === "/api/version") return Response.json({ version: "0.12.0" });
			modelRequests.push(`${request.method} ${path}`);
			return new Response("not found", { status: 404 });
		},
	});
	return { server, modelRequests };
}

/**
 * An HTTP proxy standing in for {@link FAKE_LOOPBACK_HOST}: it answers like the fake Ollama and
 * records every request it is asked to forward there.
 */
function startFakeLoopbackProxy(): { server: ReturnType<typeof Bun.serve>; requests: string[] } {
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.hostname !== FAKE_LOOPBACK_HOST) return new Response("not proxied", { status: 502 });
			requests.push(`${request.method} ${url.pathname}`);
			if (url.pathname === "/api/tags") return Response.json(FAKE_OLLAMA_TAGS);
			if (url.pathname === "/api/show") return Response.json({ capabilities: ["completion", "tools"] });
			if (url.pathname === "/api/version") return Response.json({ version: "0.12.0" });
			return new Response("not found", { status: 404 });
		},
	});
	return { server, requests };
}

/** Literal loopback hosts only, as WHATWG URL serializes them. */
function isLoopbackUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	let hostname: string;
	try {
		hostname = new URL(value).hostname;
	} catch {
		return false;
	}
	return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Runs a session in `cwd`, whose `.env` names {@link FAKE_LOOPBACK_URL} as the Ollama endpoint.
 * It must list no model away from loopback, and neither discovery nor a prompt may reach that host.
 */
async function checkFakeLoopback(argv: string[], env: Record<string, string>, cwd: string): Promise<string[]> {
	const failures: string[] = [];
	writeFileSync(join(cwd, ".env"), `OLLAMA_BASE_URL=${FAKE_LOOPBACK_URL}\nOLLAMA_HOST=${FAKE_LOOPBACK_URL}\n`);
	const proxy = startFakeLoopbackProxy();
	const sessionEnv = { ...env };
	// The .env must be what picks the endpoint: omp reads it only for keys the process env lacks.
	for (const key of ["OLLAMA_BASE_URL", "OLLAMA_HOST", "NO_PROXY", "no_proxy", "HTTPS_PROXY", "https_proxy"]) {
		delete sessionEnv[key];
	}
	sessionEnv.HTTP_PROXY = `http://127.0.0.1:${proxy.server.port}`;
	sessionEnv.http_proxy = sessionEnv.HTTP_PROXY;
	const sidecar = new Sidecar(argv, sessionEnv, cwd);
	try {
		await sidecar.ready(READY_TIMEOUT_MS);
		await sidecar.data({ type: "negotiate_protocol", protocolVersion: 2 });
		const catalog = await sidecar.data<{ models?: unknown[] }>({ type: "get_available_models", forceRefresh: true });
		for (const model of catalog.models ?? []) {
			const baseUrl = isPlainObject(model) ? model.baseUrl : undefined;
			console.log(`dotenv  model ${modelKey(model)} at ${String(baseUrl)}`);
			if (!isLoopbackUrl(baseUrl)) failures.push(`a .env endpoint listed ${modelKey(model)} at ${String(baseUrl)}`);
		}
		try {
			await sidecar.data({ type: "prompt", message: "Say hello." });
		} catch {
			// No model to send it to; the proxy log below decides.
		}
		await Bun.sleep(FAKE_LOOPBACK_PROMPT_WAIT_MS);
		try {
			await sidecar.data({ type: "abort" });
		} catch {
			// Nothing was running.
		}
	} catch (error) {
		const tail = sidecar.stderr.slice(-20).join("\n");
		failures.push(
			`fake-loopback session: ${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ""}`,
		);
	} finally {
		await sidecar.stop();
		await proxy.server.stop(true);
	}
	console.log(
		`dotenv  ${FAKE_LOOPBACK_HOST} ${proxy.requests.length > 0 ? `reached: ${proxy.requests.join(", ")}` : "never contacted"}`,
	);
	if (proxy.requests.length > 0) {
		failures.push(`requests reached ${FAKE_LOOPBACK_HOST}: ${proxy.requests.join(", ")}`);
	}
	return failures;
}

function modelKey(model: unknown): string {
	if (!isPlainObject(model)) return "none";
	return `${String(model.provider)}/${String(model.id)}`;
}

async function checkLocalOnly(sidecar: Sidecar, modelRequests: readonly string[]): Promise<string[]> {
	const failures: string[] = [];
	const local = `ollama/${LOCAL_MODEL}`;
	const catalog = await sidecar.data<{ models?: unknown[] }>({ type: "get_available_models", forceRefresh: true });
	const listed = sorted((catalog.models ?? []).map(modelKey));
	for (const key of listed) console.log(`model   ${key}`);
	if (!sameSet(listed, [local])) failures.push(`available models are [${listed.join(", ")}], not [${local}]`);

	const before = modelKey((await sidecar.data<{ model?: unknown }>({ type: "get_state" })).model);
	if (before !== local) failures.push(`the session starts on ${before}, not ${local}`);
	for (const target of REFUSED_SET_MODELS) {
		const key = `${target.provider}/${target.modelId}`;
		let refused = false;
		try {
			await sidecar.data({ type: "set_model", ...target });
		} catch {
			refused = true;
		}
		console.log(`switch  set_model ${key} ${refused ? "refused" : "ACCEPTED"}`);
		if (!refused) failures.push(`set_model ${key} was accepted`);
	}
	for (const message of REFUSED_MODEL_COMMANDS) {
		try {
			await sidecar.data({ type: "prompt", message });
		} catch {
			// A refused switch may fail the prompt; the model readback below decides.
		}
		const now = modelKey((await sidecar.data<{ model?: unknown }>({ type: "get_state" })).model);
		console.log(`switch  ${message} -> ${now}`);
		if (now !== local) failures.push(`${message} switched the session to ${now}`);
	}
	if (modelRequests.length > 0) failures.push(`model requests reached Ollama: ${modelRequests.join(", ")}`);
	return failures;
}

async function check(
	sidecar: Sidecar,
	pack: string,
	tools: readonly string[],
	appendMarker: string,
	instructionMarkers: ReadonlyMap<string, string>,
	modelRequests: readonly string[],
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
	for (const path of LOCAL_ONLY_SETTINGS) {
		if (!expected.some(row => row.path === path)) {
			failures.push(
				`config.yml does not pin ${path} (the sidecar needs patches/omp/0003-model-policy-local-only.patch)`,
			);
		}
	}
	if (!expected.some(row => row.path === MCP_OFF_SETTING && row.expected === false)) {
		failures.push(
			`config.yml does not pin ${MCP_OFF_SETTING}: false (the sidecar needs patches/omp/0004-mcp-enabled-setting.patch)`,
		);
	}
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

	failures.push(...(await checkLocalOnly(sidecar, modelRequests)));

	// Load warnings arrive as notice or extension_error frames.
	const packNames = [pack, "sai-atlas-assistant-pack", "tools.js"];
	for (const frame of sidecar.notices) {
		const text = JSON.stringify(frame);
		if (frame.type === "extension_error") failures.push(`extension error: ${text}`);
		else if (packNames.some(name => text.includes(name))) failures.push(`notice about the pack: ${text}`);
	}
	return failures;
}

/**
 * Plants a stdio MCP server in the user's ~/.omp/agent/mcp.json and the folder's .mcp.json. The
 * server never answers; it only appends a line naming its config to `marker` when it starts.
 */
function plantMcpTripwires(home: string, cwds: readonly string[], scratch: string): string {
	const marker = join(scratch, "mcp-tripwire");
	const server = join(scratch, "mcp-tripwire.sh");
	writeFileSync(server, `#!/bin/sh\necho "$1" >>${JSON.stringify(marker)}\nexec cat >/dev/null\n`, { mode: 0o755 });
	const config = (label: string) =>
		`${JSON.stringify({ mcpServers: { [`tripwire-${label}`]: { type: "stdio", command: server, args: [label] } } })}\n`;
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	writeFileSync(join(home, ".omp", "agent", "mcp.json"), config("user"));
	for (const cwd of cwds) writeFileSync(join(cwd, ".mcp.json"), config("project"));
	return marker;
}

/** The GUI's periodic heartbeat and a plugin reload, which rediscovers MCP servers when MCP is on. */
async function exerciseMcpTriggers(sidecar: Sidecar): Promise<void> {
	await sidecar.data({ type: "get_state" });
	await sidecar.data({ type: "reload_plugins" });
	await sidecar.data({ type: "get_state" });
	await Bun.sleep(MCP_START_WAIT_MS);
}

/** Which planted MCP servers started, by config. */
function mcpTripwireStarts(marker: string): string[] {
	if (!existsSync(marker)) return [];
	return readFileSync(marker, "utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
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
	const dotenvCwd = join(scratch, "work-dotenv");
	mkdirSync(dotenvCwd);
	const mcpMarker = plantMcpTripwires(home, [cwd, dotenvCwd], scratch);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	// The sidecar reads only the scratch HOME and the pack: a caller's own omp config location
	// would add layers (or hide skills) that the shells never pass to a pack session.
	for (const key of [...ASSISTANT_PACK_REMOVED_ENV, "PI_CONFIG_FILES", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) {
		delete env[key];
	}
	env.HOME = home;
	Object.assign(env, assistantPackEnv({ language: lang }));
	// Online keys omp still finds after the shells strip its env: ~/.env is read as a fallback.
	writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=sk-ant-pack-check\nOPENAI_API_KEY=sk-pack-check\n");
	const ollama = startFakeOllama();
	delete env.OLLAMA_HOST;
	env.OLLAMA_BASE_URL = `http://127.0.0.1:${ollama.server.port}`;
	const argv = [omp, "--mode", "rpc-ui", "--no-session", ...packFlags];

	const sidecar = new Sidecar(argv, env, cwd);
	let failures: string[];
	try {
		await sidecar.ready(READY_TIMEOUT_MS);
		failures = await check(sidecar, pack, tools, appendMarker, instructionMarkers, ollama.modelRequests);
		await exerciseMcpTriggers(sidecar);
	} catch (error) {
		const tail = sidecar.stderr.slice(-20).join("\n");
		failures = [`${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ""}`];
	} finally {
		await sidecar.stop();
		await ollama.server.stop(true);
	}
	try {
		failures.push(...(await checkFakeLoopback(argv, env, dotenvCwd)));
		const starts = mcpTripwireStarts(mcpMarker);
		const started = [...new Set(starts)].sort();
		console.log(
			`mcp     user and project MCP servers ${starts.length > 0 ? `STARTED ${starts.length} times: ${started.join(", ")}` : "never started"}`,
		);
		if (starts.length > 0) failures.push(`configured MCP servers started in a pack session: ${started.join(", ")}`);
	} finally {
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
