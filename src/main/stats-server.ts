/**
 * The GUI's built-in stats dashboard server, spawned from the SAME bundled
 * omp binary as the agent sidecar (`omp stats --no-open`).
 *
 * Internal to the GUI's closed loop: spawned by the first dashboard read, stopped
 * after a quiet spell without reads, killed on quit, localhost-only. No external `omp stats` process is required and none is
 * consulted — if an external process already owns the port, this reports the
 * conflict rather than silently using it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { MAX_RESTART_ATTEMPTS, RestartBudget, type Revive } from "./stats-restart-policy";

// Bind a private ephemeral port; separate GUI instances must not share an index or listener.
const DEFAULT_PORT = 0;
/** An open dashboard reads every 30 s; this long without a read means nobody is looking. */
export const STATS_IDLE_STOP_MS = 5 * 60_000;

export interface StatsServerOptions {
	idleStopMs?: number;
}

export class StatsServerManager extends EventEmitter {
	#child: ChildProcess | null = null;
	#budget = new RestartBudget();
	#restartTimer: NodeJS.Timeout | null = null;
	#idleTimer: NodeJS.Timeout | null = null;
	#disposed = false;
	#port = DEFAULT_PORT;
	readonly #binaryPath: string;
	readonly #idleStopMs: number;

	constructor(binaryPath: string, { idleStopMs = STATS_IDLE_STOP_MS }: StatsServerOptions = {}) {
		super();
		this.#binaryPath = binaryPath;
		this.#idleStopMs = idleStopMs;
	}

	get port(): number {
		return this.#port;
	}

	start(): void {
		if (this.#disposed) return;
		this.#spawn();
	}

	/**
	 * Bring the server up because something now wants to read it. Without this,
	 * a manager that spent its restart budget stays at port 0 for the rest of the
	 * session and every dashboard read answers "not ready" forever.
	 */
	ensureRunning(): Revive {
		if (this.#disposed) return "exhausted";
		if (this.#child || this.#restartTimer) return "already-pending";
		const verdict = this.#budget.revive(Date.now());
		if (verdict === "scheduled") this.#spawn();
		return verdict;
	}

	/** A dashboard read: keep a running (or restarting) server up for another idle window. */
	noteActivity(): void {
		if (this.#disposed || (!this.#child && !this.#restartTimer)) return;
		this.#armIdleTimer();
	}

	/**
	 * Stop the server without disposing the manager: the next read revives it
	 * through `ensureRunning()`. SIGINT is the signal `omp stats` handles, so its
	 * database closes cleanly; the stopped child's late output and exit are
	 * ignored, so it can neither publish a dead port nor enter the restart ladder.
	 */
	stop(): void {
		this.#clearIdleTimer();
		const child = this.#child;
		if (!child && !this.#restartTimer) return;
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		this.#child = null;
		this.#port = 0;
		this.emit("exit", null);
		child?.kill("SIGINT");
	}

	#armIdleTimer(): void {
		this.#clearIdleTimer();
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = null;
			console.log(`[stats-server] no dashboard reads for ${this.#idleStopMs}ms; stopping`);
			this.stop();
		}, this.#idleStopMs);
		this.#idleTimer.unref();
	}

	#clearIdleTimer(): void {
		if (!this.#idleTimer) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	#spawn(): void {
		// The bundled omp registers this flag as --no-open (kebab-case, per
		// `omp stats --help`), not the camelCase --noOpen the oclif property
		// name suggests — the latter is rejected as an unknown option.
		const args = ["stats", "--host", "127.0.0.1", "--port", String(DEFAULT_PORT), "--no-open"];
		console.log(`[stats-server] spawning: ${this.#binaryPath} ${args.join(" ")}`);
		let child: ChildProcess;
		try {
			child = spawn(this.#binaryPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
				// Bun's NO_ORPHANS flag makes this child die with the GUI however the
				// GUI ends (crash, SIGKILL, app.exit), which the quit teardown alone
				// cannot cover. Only this child gets it, never process.env: a flagged
				// Bun process also SIGKILLs its descendants on exit, which would take
				// a sidecar's LSP and MCP servers down with it.
				env: { ...process.env, PI_NOTIFICATIONS: "off", BUN_FEATURE_FLAG_NO_ORPHANS: "1" },
			});
		} catch (err) {
			// spawn() throws synchronously (e.g. EBADF/ENOENT) — treat like a
			// failed child so it retries gracefully instead of crashing the main
			// process with an uncaught-exception dialog.
			this.#attemptRestart(err instanceof Error ? err.message : String(err));
			return;
		}
		this.#child = child;
		this.#armIdleTimer();

		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			if (this.#child !== child) return;
			stdout = (stdout + chunk.toString("utf-8")).slice(-4096);
			const text = stripVTControlCharacters(stdout);
			const match = /http:\/\/(?:localhost|127\.0\.0\.1):([0-9]+)(?=[\s/])/.exec(text);
			if (match && Number(match[1]) > 0) {
				this.#port = Number(match[1]);
				this.#budget.noteReady();
				console.log(`[stats-server] ready on http://localhost:${this.#port}`);
				this.emit("ready", this.#port);
				stdout = "";
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (this.#child !== child) return;
			const text = chunk.toString("utf-8").trim();
			if (text) console.error(`[stats-server stderr] ${text}`);
		});
		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#child = null;
			if (this.#disposed) return;
			if (code === 0) {
				this.emit("exit", code);
				return;
			}
			this.#attemptRestart(`exit code ${code}${signal ? ` (${signal})` : ""}`);
		});
		child.on("error", err => {
			if (this.#child !== child) return;
			this.#child = null;
			if (this.#disposed) return;
			this.#attemptRestart(err.message);
		});
	}

	#attemptRestart(reason: string): void {
		this.#port = 0;
		this.emit("exit", null);
		const delay = this.#budget.nextDelay();
		if (delay === null) {
			console.error(`[stats-server] failed after ${MAX_RESTART_ATTEMPTS} attempts: ${reason}`);
			return;
		}
		console.warn(`[stats-server] restart in ${delay}ms: ${reason}`);
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			if (!this.#disposed) this.#spawn();
		}, delay);
	}

	kill(): void {
		this.#disposed = true;
		this.#clearIdleTimer();
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		const child = this.#child;
		this.#child = null;
		child?.kill("SIGTERM");
	}
}
