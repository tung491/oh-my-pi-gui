/**
 * Progress for the Linux Ollama installer, read from its stderr. `install.sh`
 * prints each stage as `>>> …` and downloads with `curl --progress-bar`, which
 * redraws its bar in place with `\r` frames such as `######   45.2%`.
 * Everything else (apt/dnf output, curl's `#=#=#` frames) is ignored.
 */
import type { OllamaInstallProgress } from "../../shared/ollama-types";

/** Install frames go out at most once per interval (10 Hz); the final frame goes out at once. */
export const INSTALL_PROGRESS_INTERVAL_MS = 100;

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const STAGE = /^>>> (.+)$/;
const PERCENT = /(\d{1,3}(?:\.\d)?)%\s*$/;
const SEGMENT_END = /[\r\n]/;
/** Longest unterminated segment kept between chunks; installer lines and bar frames are far shorter. */
const PARTIAL_MAX = 512;

export interface InstallProgressParser {
	/** Feed raw output; returns a frame when the stage or the whole percent changed, else null. */
	push(chunk: string): OllamaInstallProgress | null;
	/** The closing frame (`done: true`), after reading any unterminated last segment. */
	final(): OllamaInstallProgress;
}

export function initialInstallProgress(): OllamaInstallProgress {
	return { stage: null, percent: -1, done: false };
}

export function createInstallProgressParser(): InstallProgressParser {
	let stage: string | null = null;
	let percent = -1;
	let partial = "";

	/** Apply one segment; true when it changed the frame. A segment still being written may only set the percent. */
	const read = (raw: string, complete: boolean): boolean => {
		const segment = raw.replace(ANSI_ESCAPE, "").trim();
		const stageMatch = complete ? STAGE.exec(segment) : null;
		if (stageMatch) {
			const next = stageMatch[1].trim();
			const changed = next !== stage || percent !== -1;
			stage = next;
			percent = -1;
			return changed;
		}
		const percentMatch = PERCENT.exec(segment);
		if (!percentMatch) return false;
		const next = Math.floor(Math.min(100, Math.max(0, Number(percentMatch[1]))));
		if (next === percent) return false;
		percent = next;
		return true;
	};

	const frame = (done: boolean): OllamaInstallProgress => ({ stage, percent, done });

	return {
		push(chunk) {
			const segments = (partial + chunk).split(SEGMENT_END);
			partial = (segments.pop() ?? "").slice(-PARTIAL_MAX);
			let changed = false;
			for (const segment of segments) {
				if (read(segment, true)) changed = true;
			}
			// curl starts each bar frame with `\r`, so the newest one stays unterminated until the next
			// redraw. A trailing `%` means its number is whole, so read it now rather than a frame late.
			if (read(partial, false)) changed = true;
			return changed ? frame(false) : null;
		},
		final() {
			if (partial) read(partial, true);
			partial = "";
			return frame(true);
		},
	};
}

/**
 * Throttle `send` to one frame per `intervalMs`, the latest frame winning. A
 * `done` frame drops any pending one and goes out immediately.
 */
export function throttleInstallProgress(
	send: (frame: OllamaInstallProgress) => void,
	intervalMs = INSTALL_PROGRESS_INTERVAL_MS,
	now: () => number = Date.now,
): (frame: OllamaInstallProgress) => void {
	let lastSentAt = Number.NEGATIVE_INFINITY;
	let pending: OllamaInstallProgress | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = (frame: OllamaInstallProgress) => {
		lastSentAt = now();
		send(frame);
	};

	return frame => {
		if (frame.done) {
			clearTimeout(timer);
			timer = undefined;
			pending = null;
			flush(frame);
			return;
		}
		const wait = lastSentAt + intervalMs - now();
		if (wait <= 0 && !timer) {
			flush(frame);
			return;
		}
		pending = frame;
		timer ??= setTimeout(
			() => {
				timer = undefined;
				const next = pending;
				pending = null;
				if (next) flush(next);
			},
			Math.max(0, wait),
		);
	};
}
