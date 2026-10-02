/**
 * The privileged fixes the onboarding screen may run, as a closed set owned by
 * main: the renderer names an `OllamaRemedyId` and can never supply a command.
 * Linux only, authorised through polkit (`pkexec`).
 */
import { execFile } from "node:child_process";
import type { OllamaRemedyId, OllamaRemedyResult, OllamaStatus } from "../../shared/ollama-types";

/**
 * The official installer. It downloads and runs remote code as root; that is
 * the user-chosen behaviour, it is shown verbatim (OLLAMA_REMEDY_COMMANDS)
 * before running, and polkit asks for authorisation.
 */
export const INSTALL_LINE = "curl -fsSL https://ollama.com/install.sh | sh";

interface RemedyCommand {
	file: string;
	args: readonly string[];
	timeoutMs: number;
}

/** The only commands a remedy can run. Timeouts include time spent in the polkit dialog. */
export const REMEDY_COMMANDS: Readonly<Record<OllamaRemedyId, RemedyCommand>> = {
	"linux-start": { file: "pkexec", args: ["systemctl", "start", "ollama.service"], timeoutMs: 2 * 60_000 },
	"linux-install": { file: "pkexec", args: ["sh", "-c", INSTALL_LINE], timeoutMs: 15 * 60_000 },
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

export type ExecFileFn = (
	file: string,
	args: readonly string[],
	options: { timeout: number },
	callback: (error: ExecError | null, stdout: string, stderr: string) => void,
) => void;

const nodeExecFile: ExecFileFn = (file, args, options, callback) => {
	execFile(file, [...args], { timeout: options.timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, callback);
};

export interface RemedyDeps {
	platform: NodeJS.Platform;
	execFile: ExecFileFn;
	probe: () => Promise<OllamaStatus>;
	/** After a successful remedy the daemon may need a moment to listen; how often and how long to re-probe. */
	settleIntervalMs: number;
	settleAttempts: number;
}

const STDERR_TAIL = 500;
const NO_AUTH_AGENT = /no authentication agent/i;

function tail(text: string): string {
	const trimmed = text.trim();
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

function run(deps: RemedyDeps, command: RemedyCommand): Promise<Attempt> {
	return new Promise(resolve => {
		try {
			deps.execFile(command.file, command.args, { timeout: command.timeoutMs }, (error, _stdout, stderr) =>
				resolve(classifyExit(error, stderr ?? "", command.file)),
			);
		} catch (error) {
			resolve({ outcome: "failed", fault: error instanceof Error ? error.message : String(error) });
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
		execFile: nodeExecFile,
		settleIntervalMs: 500,
		settleAttempts: 10,
		...overrides,
	};
	if (!isRemedyId(id)) throw new Error(`Unknown Ollama remedy: ${String(id)}`);
	if (deps.platform !== "linux") throw new Error(`Ollama remedies run on Linux only, not ${deps.platform}`);

	const attempt = await run(deps, REMEDY_COMMANDS[id]);
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
