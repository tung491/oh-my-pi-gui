/**
 * Wire types between the main-process Ollama service and the renderer: the
 * daemon's status, what this machine has, the model cards sized against it,
 * and download progress.
 */

/** `ok` answers on its HTTP API; `stopped` is installed but silent; `absent` is not installed. */
export type OllamaState = "ok" | "stopped" | "absent";

/**
 * The closed set of privileged fixes the renderer may ask for. Main owns the
 * command each id runs; the renderer can only name an id, never send a command.
 */
export type OllamaRemedyId = "linux-start" | "linux-install";

/**
 * The official installer. It downloads and runs remote code as root; that is
 * the user-chosen behaviour, shown verbatim before running.
 */
const OLLAMA_INSTALL_LINE = "curl -fsSL https://ollama.com/install.sh | sh";

/** The drop-in Sai ATLAS owns; no other drop-in and never the unit file itself is written. */
const OLLAMA_NO_CLOUD_DROP_IN = "/etc/systemd/system/ollama.service.d/sai-atlas.conf";

/**
 * Turns off Ollama's online features (`OLLAMA_NO_CLOUD=1`) for its systemd
 * service, then reloads systemd and (re)starts the service so the setting
 * takes effect. The drop-in is written only when missing or different. Each
 * step runs only when the one before it succeeded.
 */
const NO_CLOUD_STEPS: readonly string[] = [
	"mkdir -p /etc/systemd/system/ollama.service.d",
	`f=${OLLAMA_NO_CLOUD_DROP_IN}`,
	`s=$(printf '[Service]\\nEnvironment="OLLAMA_NO_CLOUD=1"')`,
	`{ [ "$(cat "$f" 2>/dev/null)" = "$s" ] || printf '%s\\n' "$s" > "$f"; }`,
	"systemctl daemon-reload",
	"systemctl restart ollama.service",
];

/**
 * The fixed root script of each remedy: shown verbatim before authorizing it,
 * and run verbatim by main as one `pkexec sh -c` (one password prompt). The
 * renderer only names an id; main reads its own copy of these strings.
 */
export const OLLAMA_REMEDY_COMMANDS: Readonly<Record<OllamaRemedyId, string>> = {
	"linux-start": NO_CLOUD_STEPS.join(" &&\n"),
	"linux-install": [OLLAMA_INSTALL_LINE, ...NO_CLOUD_STEPS].join(" &&\n"),
};

export interface OllamaStatus {
	state: OllamaState;
	/** The endpoint probed, resolved like the agent does (`OLLAMA_BASE_URL` / `OLLAMA_HOST`). */
	baseUrl: string;
	version?: string;
	modelCount: number;
	installedTags: string[];
	platform: NodeJS.Platform;
	/** The remedy that fits this state and platform, or null when none applies. */
	remedy: OllamaRemedyId | null;
	/** Last probe or remedy failure, for diagnostics. */
	fault?: string;
}

export interface MachineFacts {
	ramBytes: number;
	/** Dedicated GPU memory; null when there is no discrete GPU or it cannot be read. */
	vramBytes: number | null;
	gpuName: string | null;
	/** GPU and CPU share RAM (Apple Silicon); sizing counts it as RAM only. */
	unifiedMemory: boolean;
	/** Logical CPU count, at least 1; decides CPU-path speed. */
	threads: number;
}

export type ModelTier = "minimal" | "recommended" | "maximum";

/** Display order of tiers on a card. */
export const MODEL_TIERS: readonly ModelTier[] = ["minimal", "recommended", "maximum"];

export type ModelFit = "vram" | "ram" | "offload";
export type ModelSpeed = "fast" | "moderate" | "slow";

export interface ModelChoice {
	/** The Ollama tag, as `ollama pull` takes it and as `ollama/<tag>` names the model. */
	tag: string;
	label: string;
	/** Parameter count in billions. */
	params: number;
	/** Parameters active per token, in billions (lower than `params` for mixture-of-experts models). */
	activeParams: number;
	/** Download size. */
	sizeBytes: number;
	/** Estimated resident footprint at the catalog context length; what decides `fit`. */
	needBytes: number;
	fit: ModelFit;
	speed: ModelSpeed;
	/** Every tier this card won, in `MODEL_TIERS` order. */
	tiers: ModelTier[];
	/** null when Ollama did not answer, so whether it is downloaded is unknown. */
	installed: boolean | null;
	/** Offered only because nothing else fits: the machine will be short of memory while it runs. */
	tight: boolean;
}

export interface ModelScreen {
	machine: MachineFacts | null;
	choices: ModelChoice[];
	/** `recommended-omitted`: cards exist, but none runs well enough to recommend. */
	status?: "ok" | "recommended-omitted";
	emptyReason?: "too-small" | "unreadable";
}

export interface PullProgress {
	tag: string;
	/** Ollama's own status line (`pulling manifest`, `downloading`, `success`, …). */
	status: string;
	completed: number;
	total: number;
	/** -1 while the size is unknown (indeterminate); capped at 99 until `done`. */
	percent: number;
	done: boolean;
	error?: string;
}

/** One frame of the Linux Ollama installer's progress, parsed from its output. */
export interface OllamaInstallProgress {
	/** Latest `>>> …` stage text from the installer, without the `>>> ` prefix; null before the first one. */
	stage: string | null;
	/** 0–100 for the current download; -1 while no percentage is known (polkit dialog, non-download stage). */
	percent: number;
	/** True on the final frame, sent just before the remedy result resolves. */
	done: boolean;
}

/**
 * What happened when a remedy ran. `applied` means the command exited 0, not that
 * Ollama now answers: `status.state` says that. `cancelled` is a dismissed polkit
 * dialog and `unavailable` a missing pkexec / authentication agent; neither is an error.
 */
/** `reopen-required`: this process cannot ask for administrator access until the app is quit and reopened. */
export type OllamaRemedyOutcome = "applied" | "cancelled" | "unavailable" | "failed" | "reopen-required";

export interface OllamaRemedyResult {
	outcome: OllamaRemedyOutcome;
	/** Fresh probe after the attempt (the unchanged state on cancelled/unavailable). */
	status: OllamaStatus;
	/** Diagnostics: stderr tail on failed, the missing binary on unavailable. */
	fault?: string;
}

/** Outcome of removing non-Ollama providers from `models.yml`. */
export interface ProviderConfigCleanupResult {
	/** Where the previous `models.yml` was copied, or null when nothing needed removing. */
	backupPath: string | null;
	/** Provider ids removed from `models.yml`. */
	removed: string[];
}

/** Where a measured model runs: wholly on the GPU, or from system memory (always so on unified memory). */
export type ContextPool = "gpu" | "ram";
/** `spills`/`exceeds-ram`: even the smallest context tried did not fit, so `maxContext` is that floor and runs slowly. */
export type ContextVerdict = "fits" | "spills" | "exceeds-ram";

export interface ContextFitResult {
	/** The largest `num_ctx` that fits the pool, or the floor when none did. */
	maxContext: number;
	/** The model's trained context; 131072 when Ollama reports none or an implausible one. */
	trainedContext: number;
	pool: ContextPool;
	verdict: ContextVerdict;
}

/**
 * How a measurement ended. `interrupted` (a sidecar became busy, or another
 * model shared the daemon) is retried later and never recorded as a failure;
 * `error` is a failed attempt.
 */
export type MeasureOutcome =
	| { kind: "measured"; result: ContextFitResult }
	| { kind: "interrupted" }
	| { kind: "error"; message: string };

export interface ContextFitProgress {
	tag: string;
	/** `queued` and the outcome come from the scheduler; `running` from the measurement itself. */
	state: "queued" | "running" | "done" | "error";
	/** The context being loaded while `running`. */
	numCtx?: number;
}

/**
 * The context the sidecar sends for an Ollama model nothing else limits (its
 * global `OLLAMA_CONTEXT_LENGTH` default). A per-model limit can only lower it,
 * so no measurement climbs above it.
 */
export const SIDECAR_DEFAULT_OLLAMA_CONTEXT = 131_072;

/** The smallest context worth running the agent at: its first request already needs about this much. */
export const CONTEXT_FLOOR = 16_384;

/**
 * The contexts a model is measured at and the user may choose from, ascending:
 * the floor doubled while it stays under the ceiling, then the ceiling itself.
 * The engine walks it; the Ollama window offers it as the limit choices.
 */
export function contextLadder(ceiling: number): number[] {
	const floor = Math.min(CONTEXT_FLOOR, ceiling);
	const ladder: number[] = [];
	for (let n = floor; n < ceiling; n *= 2) ladder.push(n);
	ladder.push(ceiling);
	return ladder;
}

/** The machine facts a measurement depends on; a change makes the measurement stale. */
export type MachineFingerprint = Pick<MachineFacts, "ramBytes" | "vramBytes" | "gpuName" | "unifiedMemory">;

/** What is remembered about one model's context, keyed by its exact `/api/tags` id. */
export interface ContextFitEntry {
	/** The measured maximum; null until a measurement succeeded. */
	maxContext: number | null;
	trainedContext: number | null;
	pool: ContextPool | null;
	verdict: ContextVerdict | null;
	/** ISO time of the last successful measurement. */
	measuredAt: string | null;
	/** The machine at the last attempt, successful or not. */
	fingerprint: MachineFingerprint;
	/** The user's lower limit; null means the measured maximum. */
	userCap: number | null;
	/** Failed attempts so far. */
	attempts: number;
	lastError: string | null;
	lastAttemptAt: string | null;
}

/** The `ollamaContextFit` preference: one key for every model, because tags contain dots. */
export interface ContextFitStore {
	version: 1;
	models: Record<string, ContextFitEntry>;
}

/** What can ask for a measurement. `stale` is the startup pass and never comes from the renderer. */
export type ContextMeasureReason = "manual" | "pulled" | "stale";

export interface ContextFitRow {
	tag: string;
	entry: ContextFitEntry | null;
	/** The context the sidecar uses for this model, or null when it falls back to the global default. */
	effective: number | null;
	/** The machine changed since the last attempt. */
	stale: boolean;
	/** The user's own `OLLAMA_CONTEXT_LENGTH`, which caps every model. */
	envCap: number | null;
	state: "idle" | "queued" | "running";
}

export interface ContextFitList {
	/** Installed local models only. */
	rows: ContextFitRow[];
	/**
	 * `remote-host`: Ollama is not on this computer, so nothing is measured.
	 * `configured-provider`: the user's own `ollama` provider replaces the
	 * built-in one, so the limits have no effect.
	 */
	reason?: "remote-host" | "configured-provider";
}

export interface ContextFitChanged {
	tag: string;
}
