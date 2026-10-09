/**
 * Sidecar lifecycle manager: spawns omp --mode rpc-ui, handles restart,
 * routes frames to RpcClient and EventBatcher.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Store from "electron-store";
import {
	ASSISTANT_PACK_REMOVED_ENV,
	type AssistantPackLanguage,
	assistantPackEnv,
	assistantPackFlags,
	isChatStampedSession,
	missingAssistantPackFile,
	missingAssistantPackMessage,
	resolveAssistantPackDir,
} from "../../scripts/assistant-pack";
import { emptyContextFitStore, overlayYaml } from "../shared/context-fit-store";
import { allowedLaunchFlags, parseLaunchProfile, profileToFlags } from "../shared/launch-profile";
import { SIDECAR_DEFAULT_OLLAMA_CONTEXT } from "../shared/ollama-types";
import { PRODUCT_NAME } from "../shared/product";
import type {
	AgentSessionEvent,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	HostToolCallRequest,
	HostUriRequest,
	ModelCatalogUpdateFrame,
	OutboundFrame,
	PromptResultFrame,
	RpcLiveUpdateFrame,
	RpcReadyFrame,
	RpcResponse,
	SessionInfoUpdateFrame,
	SidecarRestartProgress,
	SidecarStatus,
	SidecarStatusPayload,
	SubagentFrame,
} from "../shared/rpc-types";
import { EventBatcher } from "./event-batcher";
import { attachNdjsonParser, supportsRpcProtocolV2 } from "./rpc-bridge";
import { RpcClient } from "./rpc-client";

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS = [1000, 2000, 4000];

/** stderr lines kept per spawn for the crash report. */
const STDERR_TAIL_LINES = 20;
/** Cap on the stderr excerpt appended to the user-visible restart reason. */
const STDERR_REASON_CHARS = 240;

/**
 * Leading stderr line of the crashed spawn: a fatal message comes first
 * (`dyld: Library not loaded …`, `error: ENOENT …`) and whatever follows is
 * stack or warning noise. The full tail rides on the runtime-log report.
 */
function stderrExcerpt(lines: string[]): string {
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.length > STDERR_REASON_CHARS ? `${trimmed.slice(0, STDERR_REASON_CHARS - 1)}…` : trimmed;
	}
	return "";
}

/** Event types routed to the EventBatcher. Hoisted: one lookup table for the
 * process, not one allocation per frame. */
const AGENT_EVENT_TYPES: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	model_changed: true,
	ttsr_triggered: true,
	todo_reminder: true,
	todo_auto_clear: true,
	irc_message: true,
	notice: true,
	thinking_level_changed: true,
	goal_updated: true,
	loop_mode_update: true,
	plan_proposal: true,
	queue_update: true,
	collab_state: true,
};

/** A start refused before any spawn: no process runs, so nothing else logs it. */
export interface SidecarStartRefusalReport {
	message: string;
	cwd: string;
}

export interface SidecarOptions {
	binaryPath: string;
	cwd: string;
	extraFlags?: string[];
	/**
	 * `app.isPackaged`, injected because the missing-binary message branches on
	 * it: only a dev tree can act on a build instruction.
	 */
	packaged?: boolean;
	/** Fresh GUI tabs must not inherit the CLI's persistent autoResume setting. */
	fresh?: boolean;
	/**
	 * Session kind the tab asked for. Every sidecar spawns as an assistant
	 * session with the pack loaded, whatever this says.
	 */
	kind?: "agent" | "chat";
	/**
	 * Roots searched (with their ancestors) for `resources/assistant-pack` when
	 * no pack sits beside the binary: dev trees and the e2e fixture sidecar.
	 * A packaged build with its own binary passes none.
	 */
	packSearchFrom?: readonly string[];
	/** Records a start refused for an install problem (missing binary or pack). */
	reportStartRefusal?: (report: SidecarStartRefusalReport) => void;
	/**
	 * The per-model Ollama context limits file (`<userData>/ollama-context-limits.yml`),
	 * loaded after the pack's config so the sidecar applies every rewrite live.
	 */
	contextLimitsOverlay?: string;
	/** The app language at spawn, handed to the pack's tools; `en` when absent. */
	language?: () => AssistantPackLanguage;
	/** When set, spawn the workspace source CLI via bun instead of the installed binary. */
	sourceCli?: string;
	/**
	 * Resolves proxy env vars (PI_PROXY / HTTPS_PROXY / …) injected at spawn —
	 * the GUI proxy pref or the macOS system proxy. Finder-launched apps have
	 * no shell env, so without this a proxy-only network (e.g. codex's
	 * chatgpt.com backend behind a firewall) hangs every provider request.
	 * Called on every start()/restart(); crash-loop respawns reuse the last
	 * result. Resolution failure degrades to no proxy env, never a spawn block.
	 */
	proxyEnv?: () => Promise<Record<string, string>>;
	/**
	 * Resolves the login-shell PATH overlay injected at spawn. Finder-launched
	 * apps inherit launchd's bare PATH, so agent-spawned tools configured by
	 * bare name (MCP servers, CLI helpers) die with ENOENT while the terminal
	 * TUI works. Same point-of-use pattern as proxyEnv: called on every
	 * start()/restart(), failure degrades to the inherited PATH.
	 */
	shellEnv?: () => Promise<Record<string, string>>;
	/**
	 * Persists a crash report (reason + stderr tail) for post-mortem diagnosis.
	 * Same point-of-use injection as `proxyEnv`/`shellEnv`: the real
	 * implementation is `writeRuntimeLog`, which resolves its path through
	 * Electron's `app`, so the manager must keep working without it.
	 */
	reportFailure?: (report: SidecarFailureReport) => void;
}

/** One crash-loop step, as handed to `reportFailure`. */
export interface SidecarFailureReport {
	/** Exit/signal reason with the leading stderr line appended. */
	reason: string;
	/** Respawn about to be scheduled, or the exhausted count on the final error. */
	attempt: number;
	maxAttempts: number;
	/** stderr tail captured from this spawn (up to STDERR_TAIL_LINES). */
	stderr: string[];
	cwd: string;
}

/**
 * Load the workspace's launch profile from GUI prefs (`launchProfiles.<cwd>`)
 * and map it to agent CLI flags. Prefs access mirrors the 0.3.1 proxy-env
 * pattern (point-of-use electron-store read); any failure — prefs unreadable,
 * non-electron test env, malformed JSON — degrades to no flags, never a
 * spawn block. Profile changes require a sidecar restart: flags are
 * spawn-time argv, there is no live apply.
 */
function loadLaunchProfileFlags(cwd: string): string[] {
	try {
		// projectName is only a fallback for electron-less environments (tests):
		// with the app present, electron-store's own userData cwd wins and the
		// store matches index.ts/ipc.ts exactly. A pre-typed variable sidesteps
		// the excess-property check — electron-store's Options type hides
		// projectName, but its constructor passes it through to conf.
		const storeOptions = { name: "prefs", projectName: "omp-gui" };
		const profiles = new Store<{ launchProfiles?: Record<string, unknown> }>(storeOptions).get("launchProfiles");
		if (typeof profiles !== "object" || profiles === null) return [];
		return profileToFlags(parseLaunchProfile(profiles[cwd]));
	} catch {
		return [];
	}
}

/**
 * Create the context limits overlay when it is missing, so the sidecar's
 * settings watcher has a file to watch. True when the file is there to load.
 */
function ensureContextLimitsOverlay(file: string): boolean {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, overlayYaml(emptyContextFitStore(), null), { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
		console.error(`[sidecar] cannot create ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Resolve the bun executable for source-sidecar spawns (PATH fallback last). */
function resolveBunExe(): string {
	if (process.env.OMP_BUN) return process.env.OMP_BUN;
	for (const candidate of [join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]) {
		if (existsSync(candidate)) return candidate;
	}
	return "bun";
}

/**
 * The "no omp binary" message, worded for the build that hit it. A dev tree
 * can rebuild the sidecar; a packaged app cannot, so telling its user to run
 * `build:omp` sends them into a source checkout they do not have.
 */
export function missingSidecarMessage(packaged: boolean, resourcesPath?: string): string {
	if (!packaged) {
		return "Built-in omp not found. Build it with `bun --cwd=packages/gui run build:omp`, then relaunch.";
	}
	const target = resourcesPath ? join(resourcesPath, "omp") : "the bundled omp binary";
	return `omp is missing from this installation (${target}). Reinstall ${PRODUCT_NAME}, then relaunch.`;
}

export interface SidecarEvents {
	status: (payload: SidecarStatusPayload) => void;
	events: (events: AgentSessionEvent[]) => void;
	extensionUi: (request: ExtensionUIRequest) => void;
	hostToolCall: (request: HostToolCallRequest) => void;
	hostUriRequest: (request: HostUriRequest) => void;
	subagentFrame: (frame: SubagentFrame) => void;
	liveUpdate: (frame: RpcLiveUpdateFrame) => void;
	modelCatalogUpdate: (frame: ModelCatalogUpdateFrame) => void;
	commandsUpdate: (commands: unknown[]) => void;
	frame: (frame: OutboundFrame) => void;
}

export class SidecarManager extends EventEmitter {
	#child: ChildProcess | null = null;
	#rpcClient: RpcClient | null = null;
	#batcher: EventBatcher | null = null;
	#detachParser: (() => void) | null = null;
	#restartCount = 0;
	#restartTimer: NodeJS.Timeout | null = null;
	/**
	 * Spawn-cycle counter, bumped whenever a cycle is torn down or started.
	 * Every continuation that outlives the synchronous spawn (protocol
	 * negotiation, env resolution) captures it and drops itself when it no
	 * longer matches, so a dead child can never report `ready` or reset the
	 * crash-loop counter.
	 */
	#generation = 0;
	/** `start()` calls in flight; a superseded env resolution must not spawn. */
	#startSeq = 0;
	#lastStderr: string[] = [];
	/**
	 * `asleep` until something calls start(): a restored background tab costs
	 * nothing until it is shown. start() flips to `starting` synchronously, so
	 * "is a spawn already under way?" is answerable from this field alone.
	 */
	#status: SidecarStatus = "asleep";
	/** The last status pushed, whole, for a window that subscribes after the push. */
	#lastStatus: Omit<SidecarStatusPayload, "cwd"> = { status: "asleep" };
	#options: SidecarOptions;
	#proxyEnvVars: Record<string, string> = {};
	#shellEnvVars: Record<string, string> = {};
	#resumeSessionPath: string | null = null;
	/** Pack directory checked by the last start(); every spawn of this cycle loads it. */
	#packDir = "";
	#freshLaunchPending: boolean;
	#disposed = false;

	constructor(options: SidecarOptions) {
		super();
		this.#options = options;
		this.#freshLaunchPending = options.fresh === true;
	}

	get status(): SidecarStatus {
		return this.#status;
	}

	get cwd(): string {
		return this.#options.cwd;
	}

	/**
	 * The last status, whole (message, restart progress, refusal), in the
	 * folder the sidecar runs in now. A page reads it as it subscribes, so a
	 * status pushed before it listened (a refused start) still reaches it.
	 */
	get statusPayload(): SidecarStatusPayload {
		return { ...this.#lastStatus, cwd: this.#options.cwd };
	}

	get rpcClient(): RpcClient | null {
		return this.#rpcClient;
	}

	start(): void {
		if (this.#disposed) return;
		// Closed loop: only the bundled binary (or an explicit source override)
		// may run. Missing it is an actionable error, never an external fallback.
		if (!this.#options.binaryPath && !this.#options.sourceCli) {
			this.#refuseStart(missingSidecarMessage(!!this.#options.packaged, process.resourcesPath));
			return;
		}
		// The session is only an assistant with the whole pack: omp skips a missing
		// extension silently and reads a missing prompt path as literal text.
		const packDir = resolveAssistantPackDir(this.#options.binaryPath, this.#options.packSearchFrom);
		const missingPackFile = missingAssistantPackFile(packDir);
		if (missingPackFile) {
			this.#refuseStart(missingAssistantPackMessage(missingPackFile, !!this.#options.packaged));
			return;
		}
		this.#packDir = packDir;
		// A chat-stamped file resumes without the pack's tools and fails startup:
		// refuse it, so the tab tells the user to start a new task instead.
		if (this.#resumeSessionPath && isChatStampedSession(this.#resumeSessionPath)) {
			this.#setStatus(
				"error",
				`The session file is stamped chat: ${this.#resumeSessionPath}`,
				undefined,
				"kind-mismatch",
			);
			return;
		}
		this.#setStatus("starting");
		const resolveProxyEnv = this.#options.proxyEnv;
		const resolveShellEnv = this.#options.shellEnv;
		if (!resolveProxyEnv && !resolveShellEnv) {
			this.#spawn();
			return;
		}
		const fallback = () => ({}) as Record<string, string>;
		// Env resolution takes up to 4s. A restart()/start() landing inside that
		// window supersedes this pending spawn — it already killed whatever child
		// existed (nothing yet) — so spawning here would orphan the newer child
		// and tear it down with the session it just opened.
		const seq = ++this.#startSeq;
		void Promise.all([
			resolveProxyEnv ? resolveProxyEnv().catch(fallback) : Promise.resolve({}),
			resolveShellEnv ? resolveShellEnv().catch(fallback) : Promise.resolve({}),
		]).then(([proxyEnv, shellEnv]) => {
			if (this.#disposed || seq !== this.#startSeq) return;
			this.#proxyEnvVars = proxyEnv;
			this.#shellEnvVars = shellEnv;
			this.#spawn();
		});
	}

	#spawn(): void {
		// One live child per manager. `#child` is only ever set here, so anything
		// still attached means a previous spawn was never retired — kill it through
		// the normal teardown instead of letting it run parser-less and unkillable.
		const superseded = this.#child;
		if (superseded) {
			this.#cleanup();
			superseded.kill("SIGTERM");
		}
		this.#generation++;
		this.#lastStderr = [];
		const { binaryPath, sourceCli, cwd, extraFlags } = this.#options;

		const args = ["--mode", "rpc-ui"];
		if (this.#resumeSessionPath) args.push("--session", this.#resumeSessionPath);
		else if (this.#freshLaunchPending) args.push("--no-auto-resume");
		args.push(...assistantPackFlags(this.#packDir, process.platform));
		const overlay = this.#options.contextLimitsOverlay;
		if (overlay && ensureContextLimitsOverlay(overlay)) args.push("--config", overlay);
		// User-controllable flags ride the extraFlags seam + the launch profile.
		// Only the allowlisted flags of BOTH are appended: neither can override
		// the code-controlled argv above, while a --session-dir value that merely
		// looks like a protected flag survives intact.
		const userFlags = [...(extraFlags ?? []), ...loadLaunchProfileFlags(cwd)];
		args.push(...allowedLaunchFlags(userFlags));

		// Source sidecar (monorepo dev): run the workspace coding-agent from
		// source via bun so in-repo RPC fixes are live in the running GUI.
		// Falls back to the installed binary when no workspace source exists.
		const command = sourceCli ? resolveBunExe() : binaryPath;
		const spawnArgs = sourceCli ? [sourceCli, ...args] : args;
		console.log(`[sidecar] spawning ${sourceCli ? "source" : "bundled"} omp (${args.length} args, cwd: ${cwd})`);

		const env: NodeJS.ProcessEnv = {
			// The window sent as `num_ctx` for a model with no measured limit (capped at
			// its trained context); a user-set value, inherited or from the login shell, wins.
			OLLAMA_CONTEXT_LENGTH: String(SIDECAR_DEFAULT_OLLAMA_CONTEXT),
			...process.env,
			// Login-shell PATH first so the GUI proxy pref (and inherited
			// proxy env) keeps precedence over rc-file proxy exports.
			...this.#shellEnvVars,
			...this.#proxyEnvVars,
			PI_RPC_EMIT_TITLE: "1",
			PI_NO_PTY: "1",
			PI_NOTIFICATIONS: "off",
			// Ollama's native api carries `num_ctx`; over the OpenAI-compatible one the
			// server keeps its default context (4096 on most GPUs), below the agent's first request.
			PI_OLLAMA_API: "ollama-chat",
		};
		// No startup file may ride along into the pack tools' system programs, no
		// profile or role override may redirect omp away from the pack's settings,
		// and no online provider credential may reach the session.
		for (const key of ASSISTANT_PACK_REMOVED_ENV) delete env[key];
		Object.assign(env, assistantPackEnv({ language: this.#options.language?.() ?? "en" }));

		let child: ChildProcess;
		try {
			child = spawn(command, spawnArgs, {
				stdio: ["pipe", "pipe", "pipe"],
				env,
				cwd,
				windowsHide: true,
			});
		} catch (err) {
			// spawn() throws synchronously (EBADF/ENOENT) — surface it as a
			// sidecar failure + retry, never an uncaught main-process exception.
			this.#attemptRestart(err instanceof Error ? err.message : String(err));
			return;
		}

		this.#child = child;

		// Set up RPC client with stdin writer
		const send = (frame: object) => {
			if (child.stdin?.writable) {
				child.stdin.write(`${JSON.stringify(frame)}\n`);
			}
		};
		this.#rpcClient = new RpcClient(send);

		// Set up event batcher
		this.#batcher = new EventBatcher(events => {
			this.emit("events", events);
		});

		// Parse stdout NDJSON
		if (child.stdout) {
			this.#detachParser = attachNdjsonParser(child.stdout, frame => this.#routeFrame(frame));
		}

		// Log stderr to main process console for diagnostics, and keep a per-spawn
		// tail: a sidecar that dies before it can log anywhere only speaks through
		// this pipe, so without the ring the crash report is just an exit code.
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8").trim();
			if (text) {
				console.error(`[sidecar stderr] ${text}`);
				for (const line of text.split("\n")) {
					this.#lastStderr.push(line);
					if (this.#lastStderr.length > STDERR_TAIL_LINES) this.#lastStderr.shift();
				}
				this.emit("stderr", text);
			}
		});

		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;

			if (code === 0) {
				this.#setStatus("exited", "Normal shutdown");
			} else {
				const msg = `Exit code ${code}${signal ? ` (signal: ${signal})` : ""}`;
				this.#attemptRestart(msg);
			}
		});

		child.on("error", err => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;
			this.#attemptRestart(err.message);
		});
	}

	#routeFrame(frame: unknown): void {
		if (typeof frame !== "object" || frame === null) return;
		const obj = frame as Record<string, unknown>;

		// Ready frame
		if (obj.type === "ready") {
			this.#handleReady(obj as unknown as RpcReadyFrame);
			return;
		}

		// Response frame → route to RPC client
		if (obj.type === "response") {
			const handled = this.#rpcClient?.onResponse(obj as unknown as RpcResponse);
			if (handled) return;
		}

		// Extension UI request
		if (obj.type === "extension_ui_request") {
			this.emit("extensionUi", obj as ExtensionUIRequest);
			this.emit("frame", obj);
			return;
		}

		// Host tool/URI requests
		if (obj.type === "host_tool_call") {
			this.emit("hostToolCall", obj as unknown as HostToolCallRequest);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "host_uri_request") {
			this.emit("hostUriRequest", obj as unknown as HostUriRequest);
			this.emit("frame", obj);
			return;
		}

		// Subagent frames
		if (obj.type === "subagent_lifecycle" || obj.type === "subagent_progress" || obj.type === "subagent_event") {
			this.emit("subagentFrame", obj as unknown as SubagentFrame);
			this.emit("frame", obj);
			return;
		}

		// Available commands update
		if (obj.type === "available_commands_update") {
			this.emit("commandsUpdate", (obj as { commands: unknown[] }).commands);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "model_catalog_update") {
			this.emit("modelCatalogUpdate", obj as unknown as ModelCatalogUpdateFrame);
			this.emit("frame", obj);
			return;
		}

		// Config update (set_setting, slash-command config edits)
		if (obj.type === "config_update") {
			this.emit("configUpdate", obj as unknown as ConfigUpdateFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "prompt_result") {
			this.emit("promptResult", obj as unknown as PromptResultFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "command_output") {
			this.emit("commandOutput", obj as unknown as CommandOutputFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "session_info_update") {
			this.emit("sessionInfoUpdate", obj as unknown as SessionInfoUpdateFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "extension_error") {
			this.emit("extensionError", obj as unknown as ExtensionErrorFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "live_update") {
			this.emit("liveUpdate", obj as unknown as RpcLiveUpdateFrame);
			this.emit("frame", obj);
			return;
		}

		// Agent session events → batcher
		if (AGENT_EVENT_TYPES[obj.type as string] === true) {
			this.#batcher?.push(obj as AgentSessionEvent);
			this.emit("frame", obj);
			return;
		}

		// Other extension/host frames not consumed directly by the renderer.
		this.emit("frame", obj);
	}

	#handleReady(ready: RpcReadyFrame): void {
		this.#resumeSessionPath = null;
		// Freshness is a creation contract, not a restart policy. Once the new
		// tab has booted successfully, later crash/manual restarts may auto-resume
		// the session it has since created or opened.
		this.#freshLaunchPending = false;
		// Negotiation settles after this frame — and when the sidecar dies on boot,
		// `#cleanup()` rejects the pending command on a generation that is already
		// gone. Unguarded, that rejection announced "ready" and zeroed the restart
		// counter, so a broken binary respawned forever behind a healthy UI.
		const generation = this.#generation;
		const announceReady = (): void => {
			if (!this.#isLive(generation)) return;
			this.#setStatus("ready");
			this.#restartCount = 0;
		};
		// Stay on v1 when an older/malformed sidecar omits the negotiation fields
		// or advertises limits this decoder cannot safely honor.
		if (supportsRpcProtocolV2(ready)) {
			this.#rpcClient
				?.command({ type: "negotiate_protocol", protocolVersion: 2 })
				.then(announceReady, announceReady);
		} else {
			announceReady();
		}
	}

	/** Continuation guard: false once the spawn cycle that captured `generation`
	 *  has been torn down or replaced. */
	#isLive(generation: number): boolean {
		return !this.#disposed && generation === this.#generation;
	}

	#attemptRestart(reason: string): void {
		// The exit code alone is never the diagnosis; the spawn's stderr carries it.
		const excerpt = stderrExcerpt(this.#lastStderr);
		const detail = excerpt ? `${reason} — ${excerpt}` : reason;
		const exhausted = this.#restartCount >= MAX_RESTART_ATTEMPTS;
		const attempt = exhausted ? MAX_RESTART_ATTEMPTS : this.#restartCount + 1;
		this.#options.reportFailure?.({
			reason: detail,
			attempt,
			maxAttempts: MAX_RESTART_ATTEMPTS,
			stderr: [...this.#lastStderr],
			cwd: this.#options.cwd,
		});
		if (exhausted) {
			this.#setStatus("error", detail, { attempt, maxAttempts: MAX_RESTART_ATTEMPTS });
			return;
		}

		const delay = RESTART_DELAYS[attempt - 1] ?? 4000;
		this.#restartCount = attempt;
		this.#setStatus("restarting", detail, { attempt, maxAttempts: MAX_RESTART_ATTEMPTS });

		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			if (!this.#disposed) {
				this.#spawn();
			}
		}, delay);
	}

	/** An install problem stops the start: the tab shows it, the runtime log keeps it. */
	#refuseStart(message: string): void {
		this.#setStatus("error", message);
		this.#options.reportStartRefusal?.({ message, cwd: this.#options.cwd });
	}

	#setStatus(
		status: SidecarStatus,
		message?: string,
		restart?: SidecarRestartProgress,
		refusal?: SidecarStatusPayload["refusal"],
	): void {
		this.#status = status;
		const payload: SidecarStatusPayload = { status, message, cwd: this.#options.cwd, restart };
		if (refusal) payload.refusal = refusal;
		this.#lastStatus = {
			status,
			...(message !== undefined && { message }),
			...(restart && { restart }),
			...(refusal && { refusal }),
		};
		this.emit("status", payload);
	}

	#cleanup(): void {
		// Any async continuation of the current cycle (pending negotiation) is
		// stale from here on, even before the replacement spawns.
		this.#generation++;
		this.#detachParser?.();
		this.#detachParser = null;
		this.#batcher?.flushNow();
		this.#batcher?.dispose();
		this.#batcher = null;
		this.#rpcClient?.rejectAll("Sidecar disconnected");
		this.#rpcClient = null;
		this.#child = null;
	}

	/** Send a side-channel frame (bypasses command queue). */
	sendSideChannel(frame: object): void {
		if (this.#child?.stdin?.writable) {
			this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		}
	}

	/** Mark the sidecar as unhealthy (e.g. health check failed after ready). */
	markUnhealthy(reason: string): void {
		this.#setStatus("error", reason);
	}

	/**
	 * Adopt a new logical cwd WITHOUT a respawn. `switch_session` onto a file
	 * rooted in another workspace re-roots the agent with no main-observable
	 * event, leaving `get cwd()` (and the tab chip reading it) frozen at the
	 * spawn cwd. The RPC passthrough reports the post-switch cwd here so every
	 * consumer — status payloads, future plain `restart()` spawns,
	 * launch-profile lookup — follows the live session. Project switch goes
	 * through `restart(cwd)` instead (explicit re-root). Returns true when the
	 * cwd actually changed.
	 */
	adoptCwd(cwd: string): boolean {
		if (cwd === this.#options.cwd) return false;
		this.#options = { ...this.#options, cwd };
		return true;
	}

	restart(cwd?: string, resumeSessionPath?: string): void {
		this.kill();
		if (cwd) this.#options = { ...this.#options, cwd };
		this.#resumeSessionPath = resumeSessionPath ?? null;
		this.#restartCount = 0;
		this.start();
	}

	kill(): void {
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		const child = this.#child;
		this.#cleanup();
		child?.kill("SIGTERM");
	}

	dispose(): void {
		this.#disposed = true;
		this.kill();
		this.removeAllListeners();
	}
}
