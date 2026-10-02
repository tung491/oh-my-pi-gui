/**
 * Downloads one Ollama model at a time through `POST /api/pull`, folding the
 * NDJSON stream into PullProgress frames the way sai-welcome does
 * (`welcome/backend/pull.go`): per-layer totals summed, `completed` clamped to
 * `total`, percent -1 until a size is known and capped at 99 until `success`.
 *
 * `pull()` never rejects: failures, cancellation and a busy slot all resolve
 * as a frame. Cancelling aborts the request; Ollama keeps finished layers, so
 * pulling the same tag again resumes.
 */
import type { PullProgress } from "../../shared/ollama-types";
import { faultText, isRecord } from "./probe";

/** Progress listeners hear at most one frame per interval (10 Hz); terminal frames go out at once. */
export const PULL_PROGRESS_INTERVAL_MS = 100;

const MAX_TAG_LENGTH = 200;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** A model reference as `ollama pull` takes it: `name[:tag]`, optionally namespaced. */
export function isValidModelTag(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_TAG_LENGTH && TAG_PATTERN.test(value);
}

export type PullListener = (progress: PullProgress) => void;

interface Layer {
	completed: number;
	total: number;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Folds pull stream lines into frames; one instance per pull. */
export class PullAggregator {
	#tag: string;
	#layers = new Map<string, Layer>();
	#status = "pulling manifest";

	constructor(tag: string) {
		this.#tag = tag;
	}

	/** The frame after `line`; an `error` line yields a terminal error frame. */
	apply(line: unknown): PullProgress {
		if (!isRecord(line)) return this.frame();
		if (typeof line.error === "string") return { ...this.frame(), error: line.error };
		if (typeof line.status === "string") this.#status = line.status;
		if (typeof line.digest === "string" && line.digest) {
			const layer = this.#layers.get(line.digest) ?? { completed: 0, total: 0 };
			const total = count(line.total);
			if (total > 0) layer.total = total;
			layer.completed = Math.max(layer.completed, count(line.completed));
			if (layer.total > 0) layer.completed = Math.min(layer.completed, layer.total);
			this.#layers.set(line.digest, layer);
		}
		return this.frame();
	}

	frame(): PullProgress {
		let completed = 0;
		let total = 0;
		for (const layer of this.#layers.values()) {
			if (layer.total <= 0) continue;
			total += layer.total;
			completed += layer.completed;
		}
		const done = this.#status === "success";
		const percent = done ? 100 : total > 0 ? Math.min(99, Math.floor((completed * 100) / total)) : -1;
		return { tag: this.#tag, status: this.#status, completed, total, percent, done };
	}
}

export interface OllamaPullerOptions {
	baseUrl: () => Promise<string>;
	intervalMs?: number;
}

interface ActivePull {
	tag: string;
	controller: AbortController;
	listeners: Set<PullListener>;
	promise: Promise<PullProgress>;
	last: PullProgress;
	cancelled: boolean;
	lastEmitAt: number;
	pending: PullProgress | null;
	timer: ReturnType<typeof setTimeout> | undefined;
}

function idleFrame(tag: string, status: string): PullProgress {
	return { tag, status, completed: 0, total: 0, percent: -1, done: false };
}

async function responseError(response: Response): Promise<string> {
	const text = (await response.text().catch(() => "")).trim();
	try {
		const body: unknown = JSON.parse(text);
		if (isRecord(body) && typeof body.error === "string") return body.error;
	} catch {
		// Not JSON; fall through to the raw text.
	}
	return text ? `HTTP ${response.status}: ${text.slice(0, 300)}` : `HTTP ${response.status}`;
}

export class OllamaPuller {
	#baseUrl: () => Promise<string>;
	#intervalMs: number;
	#active: ActivePull | null = null;

	constructor(options: OllamaPullerOptions) {
		this.#baseUrl = options.baseUrl;
		this.#intervalMs = options.intervalMs ?? PULL_PROGRESS_INTERVAL_MS;
	}

	get activeTag(): string | null {
		return this.#active?.tag ?? null;
	}

	/**
	 * Start pulling `tag`, or join the running pull of the same tag. A different
	 * tag while one runs resolves at once with a `busy` error frame.
	 */
	pull(tag: string, listener?: PullListener): Promise<PullProgress> {
		if (!isValidModelTag(tag)) {
			return Promise.resolve({ ...idleFrame(String(tag), "invalid"), error: "Invalid model name" });
		}
		const active = this.#active;
		if (active) {
			if (active.tag === tag) {
				if (listener) active.listeners.add(listener);
				return active.promise;
			}
			return Promise.resolve({
				...idleFrame(tag, "busy"),
				error: `Another model is downloading (${active.tag}). Wait for it or cancel it first.`,
			});
		}
		const { promise, resolve } = Promise.withResolvers<PullProgress>();
		const run: ActivePull = {
			tag,
			controller: new AbortController(),
			listeners: new Set(listener ? [listener] : []),
			promise,
			last: idleFrame(tag, "pulling manifest"),
			cancelled: false,
			lastEmitAt: 0,
			pending: null,
			timer: undefined,
		};
		this.#active = run;
		// #run never rejects. Free the slot before resolving so a caller awaiting
		// this pull can start the next one straight away.
		void this.#run(run).then(frame => {
			clearTimeout(run.timer);
			if (this.#active === run) this.#active = null;
			resolve(frame);
		});
		return promise;
	}

	/** Abort the running pull; it resolves with its last frame and emits nothing further. */
	cancel(): void {
		const run = this.#active;
		if (!run) return;
		run.cancelled = true;
		clearTimeout(run.timer);
		run.pending = null;
		run.controller.abort();
	}

	async #run(run: ActivePull): Promise<PullProgress> {
		const aggregator = new PullAggregator(run.tag);
		try {
			const baseUrl = await this.#baseUrl();
			const response = await fetch(`${baseUrl}/api/pull`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: run.tag, stream: true }),
				signal: run.controller.signal,
			});
			if (!response.ok || !response.body) {
				return this.#finish(run, { ...aggregator.frame(), error: await responseError(response) });
			}
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += value;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					const frame = this.#applyLine(aggregator, line);
					if (!frame) continue;
					if (frame.error || frame.done) {
						await reader.cancel().catch(() => {});
						return this.#finish(run, frame);
					}
					this.#emit(run, frame);
				}
			}
			const tail = this.#applyLine(aggregator, buffer.trim());
			const final = tail ?? aggregator.frame();
			if (final.done || final.error) return this.#finish(run, final);
			if (run.cancelled) return run.last;
			return this.#finish(run, { ...final, error: "The download ended before Ollama reported success" });
		} catch (error) {
			if (run.cancelled) return run.last;
			return this.#finish(run, { ...run.last, error: faultText(error) });
		}
	}

	#applyLine(aggregator: PullAggregator, line: string): PullProgress | null {
		if (!line) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			console.warn(`[ollama] skipped a malformed pull line: ${line.slice(0, 120)}`);
			return null;
		}
		return aggregator.apply(parsed);
	}

	/** Throttled progress: the latest frame wins and goes out at most once per interval. */
	#emit(run: ActivePull, frame: PullProgress): void {
		run.last = frame;
		if (run.cancelled) return;
		const wait = run.lastEmitAt + this.#intervalMs - Date.now();
		if (wait <= 0 && !run.timer) {
			this.#send(run, frame);
			return;
		}
		run.pending = frame;
		run.timer ??= setTimeout(
			() => {
				run.timer = undefined;
				const pending = run.pending;
				run.pending = null;
				if (pending && !run.cancelled) this.#send(run, pending);
			},
			Math.max(0, wait),
		);
	}

	/** Terminal frame: drop any pending throttled frame and send this one now. */
	#finish(run: ActivePull, frame: PullProgress): PullProgress {
		clearTimeout(run.timer);
		run.timer = undefined;
		run.pending = null;
		// A cancelled pull ends on its last progress frame, silently.
		if (run.cancelled) return run.last;
		run.last = frame;
		this.#send(run, frame);
		return frame;
	}

	#send(run: ActivePull, frame: PullProgress): void {
		run.lastEmitAt = Date.now();
		for (const listener of run.listeners) {
			try {
				listener(frame);
			} catch (error) {
				console.warn(`[ollama] pull progress listener failed: ${faultText(error)}`);
			}
		}
	}
}
