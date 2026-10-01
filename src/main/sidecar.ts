/**
 * Sidecar lifecycle manager: spawns omp --mode rpc-ui, handles restart,
 * routes frames to RpcClient and EventBatcher.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Store from "electron-store";
import { parseLaunchProfile, profileToFlags, stripDenylistedFlags } from "../shared/launch-profile";
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
	SidecarStatus,
	SidecarStatusPayload,
	SubagentFrame,
} from "../shared/rpc-types";
import { EventBatcher } from "./event-batcher";
import { attachNdjsonParser, supportsRpcProtocolV2 } from "./rpc-bridge";
import { RpcClient } from "./rpc-client";

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS = [1000, 2000, 4000];

/** How long a hibernating sidecar gets to run its own teardown after stdin closes. */
export const HIBERNATE_DRAIN_MS = 5000;
/** Grace between SIGTERM and SIGKILL when that teardown overruns. */
export const HIBERNATE_TERM_MS = 2000;

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
	/** Session kind: "agent" (default) or "chat" (tool-free conversation). Immutable per sidecar. */
	kind?: "agent" | "chat";
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

/**
 * What a ready gate decided. `error` keeps the sidecar from ever reporting
 * `ready` (its status goes to `error` with that message); `modesNotRestored`
 * rides on the `ready` status so the renderer can warn about each.
 */
export interface ReadyGateOutcome {
	error?: string;
	modesNotRestored?: string[];
}

/** Work that must finish on a fresh spawn before anything may send it a prompt. */
export type ReadyGate = (client: RpcClient) => Promise<ReadyGateOutcome>;

/** Resolves true when `promise` settles within `ms`. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(false), ms);
		void promise.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
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
	#options: SidecarOptions;
	#proxyEnvVars: Record<string, string> = {};
	#shellEnvVars: Record<string, string> = {};
	/** The session the next spawn opens with `--session`; cleared once a spawn boots. */
	#resumeSessionPath: string | null = null;
	#freshLaunchPending: boolean;
	/** Set by wake(); runs on the first `ready` of whichever spawn gets there, then clears. */
	#readyGate: ReadyGate | null = null;
	/** A child still running its own teardown; the next spawn waits for it to exit. */
	#draining: Promise<void> | null = null;
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

	get rpcClient(): RpcClient | null {
		return this.#rpcClient;
	}

	/** True while a stopped child is still running its own teardown. */
	get draining(): boolean {
		return this.#draining !== null;
	}

	start(): void {
		if (this.#disposed) return;
		// Closed loop: only the bundled binary (or an explicit source override)
		// may run. Missing it is an actionable error, never an external fallback.
		if (!this.#options.binaryPath && !this.#options.sourceCli) {
			this.#setStatus("error", missingSidecarMessage(!!this.#options.packaged, process.resourcesPath));
			return;
		}
		this.#setStatus("starting");
		const resolveProxyEnv = this.#options.proxyEnv;
		const resolveShellEnv = this.#options.shellEnv;
		// A hibernated child may still be writing its session file; a second
		// process on the same file must not start until it has exited.
		const draining = this.#draining;
		if (!resolveProxyEnv && !resolveShellEnv && !draining) {
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
			draining,
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
		if (this.#options.kind === "chat") args.push("--chat");
		// User-controllable flags ride the extraFlags seam + the launch profile.
		// Strip the code-controlled-flag denylist (pair-aware) over BOTH, then
		// append: neither can override the code-controlled argv above, while a
		// profile value that merely looks like a protected flag survives intact.
		const userFlags = [...(extraFlags ?? []), ...loadLaunchProfileFlags(cwd)];
		args.push(...stripDenylistedFlags(userFlags));

		// Source sidecar (monorepo dev): run the workspace coding-agent from
		// source via bun so in-repo RPC fixes are live in the running GUI.
		// Falls back to the installed binary when no workspace source exists.
		const command = sourceCli ? resolveBunExe() : binaryPath;
		const spawnArgs = sourceCli ? [sourceCli, ...args] : args;
		console.log(`[sidecar] spawning ${sourceCli ? "source" : "bundled"} omp (${args.length} args, cwd: ${cwd})`);

		let child: ChildProcess;
		try {
			child = spawn(command, spawnArgs, {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					// Login-shell PATH first so the GUI proxy pref (and inherited
					// proxy env) keeps precedence over rc-file proxy exports.
					...this.#shellEnvVars,
					...this.#proxyEnvVars,
					PI_RPC_EMIT_TITLE: "1",
					PI_NO_PTY: "1",
					PI_NOTIFICATIONS: "off",
				},
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
		// Freshness is a creation contract, not a restart policy. Once the new
		// tab has booted successfully, later crash/manual restarts may auto-resume
		// the session it has since created or opened. A woken tab has booted only
		// once its gate passes: a child that dies mid-gate respawns onto the same
		// session.
		const booted = (): void => {
			this.#resumeSessionPath = null;
			this.#freshLaunchPending = false;
		};
		if (!this.#readyGate) booted();
		// Negotiation settles after this frame — and when the sidecar dies on boot,
		// `#cleanup()` rejects the pending command on a generation that is already
		// gone. Unguarded, that rejection announced "ready" and zeroed the restart
		// counter, so a broken binary respawned forever behind a healthy UI.
		const generation = this.#generation;
		const announceReady = (): void => {
			if (!this.#isLive(generation)) return;
			const gate = this.#readyGate;
			const client = this.#rpcClient;
			if (!gate || !client) {
				this.#setStatus("ready");
				this.#restartCount = 0;
				return;
			}
			// The gate stays armed until a live spawn finishes it: a child that
			// dies mid-gate respawns into the same gate.
			const settle = (outcome: ReadyGateOutcome): void => {
				if (!this.#isLive(generation)) return;
				this.#readyGate = null;
				this.#restartCount = 0;
				const extra = { modesNotRestored: outcome.modesNotRestored };
				if (!outcome.error) {
					booted();
					this.#setStatus("ready", undefined, extra);
					return;
				}
				// A refused wake must not leave an agent running without the modes
				// it slept with. Stop it the way hibernation does. It has not
				// booted, so it keeps its session: a plain restart() continues it
				// without them.
				const child = this.#child;
				this.#cleanup();
				this.#setStatus("error", outcome.error, extra);
				if (child) void this.#drain(child, HIBERNATE_DRAIN_MS, HIBERNATE_TERM_MS);
			};
			void gate(client).then(settle, (err: unknown) =>
				settle({ error: err instanceof Error ? err.message : String(err) }),
			);
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
			this.#setStatus("error", detail, { restart: { attempt, maxAttempts: MAX_RESTART_ATTEMPTS } });
			return;
		}

		const delay = RESTART_DELAYS[attempt - 1] ?? 4000;
		this.#restartCount = attempt;
		this.#setStatus("restarting", detail, { restart: { attempt, maxAttempts: MAX_RESTART_ATTEMPTS } });

		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			if (!this.#disposed) {
				this.#spawn();
			}
		}, delay);
	}

	#setStatus(
		status: SidecarStatus,
		message?: string,
		extra: Pick<SidecarStatusPayload, "restart" | "modesNotRestored"> = {},
	): void {
		this.#status = status;
		const payload: SidecarStatusPayload = { status, message, cwd: this.#options.cwd, restart: extra.restart };
		if (extra.modesNotRestored?.length) payload.modesNotRestored = extra.modesNotRestored;
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
		// A spawn that has not booted yet (a wake, a refused wake, a resume
		// restarted before `ready`) still holds the session it was opening. A
		// restart that does not re-root the tab continues that session, and a
		// wake still restoring its modes keeps its gate, so the respawn re-arms
		// them before `ready`. Re-rooting the tab or opening another session
		// drops both: those modes were not that session's.
		const pending = cwd ? null : this.#resumeSessionPath;
		const sameTarget = !cwd && (resumeSessionPath === undefined || resumeSessionPath === pending);
		const gate = sameTarget ? this.#readyGate : null;
		this.kill();
		if (cwd) this.#options = { ...this.#options, cwd };
		this.#readyGate = gate;
		this.#resumeSessionPath = resumeSessionPath ?? pending;
		this.#restartCount = 0;
		this.start();
	}

	kill(): void {
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		// A stop drops a wake's pending gate; restart() re-arms it when it continues the wake.
		this.#readyGate = null;
		const child = this.#child;
		this.#cleanup();
		child?.kill("SIGTERM");
	}

	/**
	 * Stop the child the way stdin EOF does, so the agent runs its own teardown
	 * (session dispose reaps the browser tool and disconnects MCP servers, which
	 * a signal would leave running), and go back to `asleep` at once. Signals are
	 * only the fallback for a teardown that overruns. Resolves once the process
	 * is gone; wake() respawns it.
	 */
	async hibernate({ drainMs = HIBERNATE_DRAIN_MS, termMs = HIBERNATE_TERM_MS } = {}): Promise<void> {
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		// A start() still resolving its env must not spawn behind the hibernation.
		this.#startSeq++;
		this.#readyGate = null;
		const child = this.#child;
		this.#cleanup();
		this.#setStatus("asleep", "Hibernated");
		if (child) await this.#drain(child, drainMs, termMs);
	}

	/**
	 * Close `child`'s stdin and wait for it to exit, escalating to SIGTERM and
	 * then SIGKILL. Tracked so start() never spawns beside a child that is
	 * still writing its session file.
	 */
	#drain(child: ChildProcess, drainMs: number, termMs: number): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
		const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
		const stopped = (async () => {
			child.stdin?.end();
			if (await settlesWithin(exited, drainMs)) return;
			console.warn(`[sidecar] still running ${drainMs}ms after stdin closed; sending SIGTERM`);
			child.kill("SIGTERM");
			if (await settlesWithin(exited, termMs)) return;
			console.warn(`[sidecar] still running ${termMs}ms after SIGTERM; sending SIGKILL`);
			child.kill("SIGKILL");
			await settlesWithin(exited, termMs);
		})();
		const previous = this.#draining;
		const tracked: Promise<void> = Promise.all([previous, stopped]).then(() => {
			if (this.#draining === tracked) this.#draining = null;
		});
		this.#draining = tracked;
		return tracked;
	}

	/**
	 * Respawn a hibernated sidecar: resume `sessionPath`, or — when the session
	 * was deleted while it slept — launch a fresh one that cannot auto-resume a
	 * session another tab may own. `gate` runs before `ready` is announced.
	 */
	wake(sessionPath: string | null, gate: ReadyGate | null = null): void {
		this.#readyGate = gate;
		this.#resumeSessionPath = sessionPath;
		if (!sessionPath) this.#freshLaunchPending = true;
		this.#restartCount = 0;
		this.start();
	}

	dispose(): void {
		this.#disposed = true;
		this.kill();
		this.removeAllListeners();
	}
}
