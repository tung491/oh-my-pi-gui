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

/** Display text only — what the user is shown before authorizing a remedy. Main never executes these strings. */
export const OLLAMA_REMEDY_COMMANDS: Readonly<Record<OllamaRemedyId, string>> = {
	"linux-start": "systemctl start ollama.service",
	"linux-install": "curl -fsSL https://ollama.com/install.sh | sh",
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
	/** GPU and CPU share RAM (Apple Silicon), so RAM is the GPU budget. */
	unifiedMemory: boolean;
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
}

export interface ModelScreen {
	machine: MachineFacts | null;
	choices: ModelChoice[];
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

/** Outcome of removing non-Ollama providers from `models.yml`. */
/**
 * What happened when a remedy ran. `applied` means the command exited 0, not that
 * Ollama now answers: `status.state` says that. `cancelled` is a dismissed polkit
 * dialog and `unavailable` a missing pkexec / authentication agent; neither is an error.
 */
export type OllamaRemedyOutcome = "applied" | "cancelled" | "unavailable" | "failed";

export interface OllamaRemedyResult {
	outcome: OllamaRemedyOutcome;
	/** Fresh probe after the attempt (the unchanged state on cancelled/unavailable). */
	status: OllamaStatus;
	/** Diagnostics: stderr tail on failed, the missing binary on unavailable. */
	fault?: string;
}

export interface ProviderConfigCleanupResult {
	/** Where the previous `models.yml` was copied, or null when nothing needed removing. */
	backupPath: string | null;
	/** Provider ids removed from `models.yml`. */
	removed: string[];
}
