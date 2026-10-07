/**
 * The privileged fixes the onboarding screen may run, as a closed set owned by
 * main: the renderer names an `OllamaRemedyId` and can never supply a command.
 * Linux only, authorised through polkit (`pkexec`).
 */
import { spawn } from "node:child_process";
import {
	OLLAMA_REMEDY_COMMANDS,
	type OllamaInstallProgress,
	type OllamaRemedyId,
	type OllamaRemedyResult,
	type OllamaStatus,
} from "../../shared/ollama-types";
import { createInstallProgressParser, initialInstallProgress } from "./install-progress";

interface RemedyCommand {
	file: string;
	args: readonly string[];
	timeoutMs: number;
}

/**
 * The only commands a remedy can run: the fixed script the screen shows
 * (OLLAMA_REMEDY_COMMANDS), as one root shell behind one polkit prompt.
 * Timeouts include time spent in the polkit dialog.
 */
export const REMEDY_COMMANDS: Readonly<Record<OllamaRemedyId, RemedyCommand>> = {
	"linux-start": { file: "pkexec", args: ["sh", "-c", OLLAMA_REMEDY_COMMANDS["linux-start"]], timeoutMs: 2 * 60_000 },
	"linux-install": {
		file: "pkexec",
		args: ["sh", "-c", OLLAMA_REMEDY_COMMANDS["linux-install"]],
		timeoutMs: 15 * 60_000,
	},
};

export function isRemedyId(value: unknown): value is OllamaRemedyId {
	return typeof value === "string" && Object.hasOwn(REMEDY_COMMANDS, value);
}

export interface ExecError extends Error {
	/** Exit code for a process that ran, or a spawn errno string such as `ENOENT`. */
	code?: number | string | null;
	killed?: boolean;
	signal?: NodeJS.Signals | null;
}

/** What a spawned command reports back: output as it arrives, then exactly one exit or spawn error. */
export interface SpawnHandlers {
	onOutput(stream: "stdout" | "stderr", chunk: string): void;
	onExit(code: number | null, signal: NodeJS.Signals | null): void;
	/** The process could not be started (or failed outright), e.g. `ENOENT` for a missing `pkexec`. */
	onError(error: ExecError): void;
}

/** Start `file`; the returned `kill` signals the child (the timeout's SIGTERM). */
export type SpawnFn = (
	file: string,
	args: readonly string[],
	handlers: SpawnHandlers,
) => { kill(signal: NodeJS.Signals): void };

const nodeSpawn: SpawnFn = (file, args, handlers) => {
	const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => handlers.onOutput("stdout", chunk));
	child.stderr.on("data", (chunk: string) => handlers.onOutput("stderr", chunk));
	child.on("error", handlers.onError);
	// `close` rather than `exit`, so the last output has been read.
	child.on("close", handlers.onExit);
	return {
		kill: signal => {
			child.kill(signal);
		},
	};
};

export interface RemedyDeps {
	platform: NodeJS.Platform;
	spawn: SpawnFn;
	probe: () => Promise<OllamaStatus>;
	/** After a successful remedy the daemon may need a moment to listen; how often and how long to re-probe. */
	settleIntervalMs: number;
	settleAttempts: number;
	/**
	 * Installer progress, for `linux-install` only: an indeterminate frame before
	 * the polkit dialog, frames parsed from its output, then a `done` frame just
	 * before the result resolves, whatever the outcome.
	 */
	onProgress?: (frame: OllamaInstallProgress) => void;
}

const STDERR_TAIL = 500;
/** Enough stderr kept for `tail` after trimming curl's trailing bar redraws. */
const STDERR_KEEP = 16 * STDERR_TAIL;
const NO_AUTH_AGENT = /no authentication agent/i;

function tail(text: string): string {
	// Each `\r` redraw replaces the line it is on, as a terminal would show it.
	const trimmed = text
		.split("\n")
		.map(line => line.slice(line.lastIndexOf("\r") + 1))
		.join("\n")
		.trim();
	return trimmed.length > STDERR_TAIL ? trimmed.slice(-STDERR_TAIL) : trimmed;
}

type Attempt = Pick<OllamaRemedyResult, "outcome" | "fault">;

/** pkexec's contract: 126 = dialog dismissed / not authorised, 127 = could not authenticate (or no agent). */
export function classifyExit(error: ExecError | null, stderr: string, file: string): Attempt {
	if (!error) return { outcome: "applied" };
	if (error.code === "ENOENT") return { outcome: "unavailable", fault: `${file} is not installed` };
	if (error.code === 126) return { outcome: "cancelled" };
	if (error.code === 127) {
		return NO_AUTH_AGENT.test(stderr)
			? { outcome: "unavailable", fault: tail(stderr) || "No polkit authentication agent" }
			: { outcome: "cancelled" };
	}
	if (error.killed) return { outcome: "failed", fault: `Timed out${stderr.trim() ? `: ${tail(stderr)}` : ""}` };
	return { outcome: "failed", fault: tail(stderr) || error.message };
}

/** The error `execFile` would report for this exit, so `classifyExit` reads both the same way. */
function exitError(
	file: string,
	code: number | null,
	signal: NodeJS.Signals | null,
	killed: boolean,
): ExecError | null {
	if (code === 0 && !signal && !killed) return null;
	const reason = signal ? `signal ${signal}` : `code ${code}`;
	return Object.assign(new Error(`${file} exited with ${reason}`), { code, signal, killed });
}

function run(deps: RemedyDeps, command: RemedyCommand, onStderr: ((chunk: string) => void) | null): Promise<Attempt> {
	return new Promise(resolve => {
		let stderr = "";
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = (attempt: Attempt) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(attempt);
		};
		try {
			const child = deps.spawn(command.file, command.args, {
				onOutput: (stream, chunk) => {
					if (settled || stream !== "stderr") return;
					stderr = (stderr + chunk).slice(-STDERR_KEEP);
					onStderr?.(chunk);
				},
				onExit: (code, signal) =>
					finish(classifyExit(exitError(command.file, code, signal, timedOut), stderr, command.file)),
				onError: error => {
					// Once authorised, pkexec has become the root command, which this process may not signal.
					// It keeps running, so its own exit decides the outcome rather than the failed kill.
					if (timedOut && error.code === "EPERM") {
						timedOut = false;
						return;
					}
					finish(classifyExit(error, stderr, command.file));
				},
			});
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
			}, command.timeoutMs);
		} catch (error) {
			finish({ outcome: "failed", fault: error instanceof Error ? error.message : String(error) });
		}
	});
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The IPC entry for remedies. Main re-probes and runs `id` only when it is the
 * remedy the current status offers, so a stale or forged request cannot raise a
 * root prompt the screen never showed. One remedy runs at a time: a repeat of
 * the running id (a double click, the welcome screen and Settings together)
 * joins it and gets the same result; any other id is refused until it ends.
 */
export function createRemedyGate(
	probe: () => Promise<OllamaStatus>,
	run: (id: OllamaRemedyId) => Promise<OllamaRemedyResult>,
): (id: OllamaRemedyId) => Promise<OllamaRemedyResult> {
	let inFlight: { id: OllamaRemedyId; result: Promise<OllamaRemedyResult> } | null = null;
	return id => {
		if (inFlight) {
			if (inFlight.id === id) return inFlight.result;
			return Promise.reject(new Error("Another Ollama fix is already running"));
		}
		const result = (async () => {
			const status = await probe();
			if (status.remedy !== id) throw new Error("That fix no longer matches Ollama's state; check again");
			return run(id);
		})().finally(() => {
			inFlight = null;
		});
		inFlight = { id, result };
		return result;
	};
}

/**
 * Run the remedy `id` maps to, then re-probe. Rejects only on programming
 * errors: an id outside the closed set, or a platform without remedies.
 */
export async function runRemedy(
	id: OllamaRemedyId,
	overrides: Partial<RemedyDeps> & Pick<RemedyDeps, "probe">,
): Promise<OllamaRemedyResult> {
	const deps: RemedyDeps = {
		platform: process.platform,
		spawn: nodeSpawn,
		settleIntervalMs: 500,
		settleAttempts: 10,
		...overrides,
	};
	if (!isRemedyId(id)) throw new Error(`Unknown Ollama remedy: ${String(id)}`);
	if (deps.platform !== "linux") throw new Error(`Ollama remedies run on Linux only, not ${deps.platform}`);

	const onProgress = id === "linux-install" ? deps.onProgress : undefined;
	if (!onProgress) return settle(deps, await run(deps, REMEDY_COMMANDS[id], null));

	const report = (frame: OllamaInstallProgress) => {
		try {
			onProgress(frame);
		} catch (error) {
			console.warn(`[ollama] install progress listener failed: ${error instanceof Error ? error.message : error}`);
		}
	};
	const parser = createInstallProgressParser();
	report(initialInstallProgress());
	try {
		const attempt = await run(deps, REMEDY_COMMANDS[id], chunk => {
			const frame = parser.push(chunk);
			if (frame) report(frame);
		});
		return await settle(deps, attempt);
	} finally {
		report(parser.final());
	}
}

/** Re-probe after the command, waiting for the daemon when the command succeeded. */
async function settle(deps: RemedyDeps, attempt: Attempt): Promise<OllamaRemedyResult> {
	let status = await deps.probe();
	if (attempt.outcome === "applied") {
		for (let i = 1; i < deps.settleAttempts && status.state !== "ok"; i++) {
			await delay(deps.settleIntervalMs);
			status = await deps.probe();
		}
		// The command exiting cleanly is not the fix; a daemon that still does not
		// answer means the screen must keep offering the remedy.
		if (status.state !== "ok") {
			return { outcome: "failed", status, fault: "Ollama is still not answering after the command finished" };
		}
	}
	return attempt.fault
		? { outcome: attempt.outcome, status, fault: attempt.fault }
		: { outcome: attempt.outcome, status };
}
