/**
 * One installed local model's context in the Ollama window: the measured
 * maximum, the user's lower limit as a select of allowed rungs, and the
 * measurement's live state. Main owns the queue, the busy gate and applying the
 * value to every sidecar; this row only shows `ollama:context-list` data, follows
 * the progress of its own tag, and sends `measureContext` / `setContextCap`.
 */

import { useEffect, useState } from "react";
import { CONTEXT_FLOOR, type ContextFitRow, contextLadder } from "../../../shared/ollama-types";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { Button } from "../common";

/** 32768 → "32k", 131072 → "128k", 40000 → "39.1k"; contexts below 1024 stay exact. */
export function formatContext(n: number): string {
	if (n < 1024) return String(n);
	return `${Number((n / 1024).toFixed(1))}k`;
}

/** The limits offered for a model measured at `max`: its ladder, plus a stored limit that is not a rung. */
export function contextChoices(max: number, userCap: number | null): number[] {
	const rungs = contextLadder(max);
	if (userCap !== null && userCap < max && !rungs.includes(userCap)) {
		rungs.push(userCap);
		rungs.sort((a, b) => a - b);
	}
	return rungs;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** What this row learned from progress events since the last list. */
type LiveState = { state: "running"; numCtx: number | null } | { state: "queued" };

export interface ModelContextRowProps {
	row: ContextFitRow;
	/** A custom `ollama` provider replaces the built-in one, so a limit does nothing there. */
	limitsInactive: boolean;
	/** Ask the window for a fresh `context-list`. */
	onRefresh(): void;
}

export function ModelContextRow({ row, limitsInactive, onRefresh }: ModelContextRowProps) {
	const t = useT();
	const { tag, entry, envCap, stale } = row;
	const [live, setLive] = useState<LiveState | null>(null);
	const [measureBusy, setMeasureBusy] = useState(false);
	const [capBusy, setCapBusy] = useState(false);

	// Progress is broadcast for every model; only this row's tag drives its line.
	useEffect(
		() =>
			window.omp.ollama.onContextProgress(progress => {
				if (progress.tag !== tag) return;
				if (progress.state === "running") setLive({ state: "running", numCtx: progress.numCtx ?? null });
				else if (progress.state === "queued") setLive({ state: "queued" });
				else setLive(null);
			}),
		[tag],
	);

	// A fresh list that says nothing is pending supersedes what the events said:
	// an item dropped after its retries announces itself only as a change.
	useEffect(() => {
		if (row.state === "idle") setLive(null);
	}, [row]);

	const state = live?.state ?? row.state;
	const runningCtx = live?.state === "running" ? live.numCtx : null;
	const max = entry?.maxContext ?? null;
	const lastError = entry?.lastError ?? null;

	const measure = async () => {
		setMeasureBusy(true);
		try {
			await window.omp.ollama.measureContext(tag);
			onRefresh();
		} catch (cause) {
			toast({
				variant: "error",
				message: t("ollama.context.measureFailed", { model: tag, error: messageOf(cause) }),
			});
		} finally {
			setMeasureBusy(false);
		}
	};

	const setCap = async (value: number) => {
		if (max === null) return;
		setCapBusy(true);
		try {
			const saved = await window.omp.ollama.setContextCap(tag, value >= max ? null : value);
			const size = formatContext(saved.userCap ?? saved.maxContext ?? value);
			toast({ variant: "success", message: t("ollama.context.setSuccess", { model: tag, size }) });
			onRefresh();
		} catch (cause) {
			toast({ variant: "error", message: t("ollama.context.setFailed", { model: tag, error: messageOf(cause) }) });
		} finally {
			setCapBusy(false);
		}
	};

	const measureLabel =
		max !== null
			? t("ollama.context.measureAgain")
			: lastError !== null
				? t("ollama.context.tryAgain")
				: t("ollama.context.measure");
	const slow = entry?.verdict === "spills" || entry?.verdict === "exceeds-ram";
	const current = max === null ? null : Math.min(entry?.userCap ?? max, max);

	return (
		<div
			className="flex flex-col gap-1 text-omp-sm text-(--omp-muted)"
			data-context-row={tag}
			data-context-state={state}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span>{t("ollama.context.label")}</span>
				{max !== null && current !== null ? (
					<>
						<select
							aria-label={t("ollama.context.selectLabel", { model: tag })}
							className="rounded-md border border-(--omp-border-muted) bg-(--omp-input-bg) px-2 py-0.5 text-omp-sm text-(--omp-text) focus:border-(--omp-border-accent) focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
							data-context-select
							disabled={capBusy || limitsInactive}
							onChange={event => void setCap(Number(event.target.value))}
							value={String(current)}
						>
							{contextChoices(max, entry?.userCap ?? null).map(rung => (
								<option disabled={envCap !== null && rung > envCap} key={rung} value={String(rung)}>
									{formatContext(rung)}
								</option>
							))}
						</select>
						<span>
							{t("ollama.context.of", { max: formatContext(max) })}
							{entry?.pool ? ` · ${t(`ollama.context.pool.${entry.pool}`)}` : ""}
						</span>
					</>
				) : (
					<span data-context-unmeasured>{t("ollama.context.notMeasured")}</span>
				)}
				{state !== "running" && (
					<Button
						data-action="measure-context"
						loading={measureBusy}
						onClick={() => void measure()}
						size="sm"
						variant={max === null ? "secondary" : "ghost"}
					>
						{measureLabel}
					</Button>
				)}
			</div>
			{envCap !== null && max !== null && envCap < max && (
				<p data-context-envcap>{t("ollama.context.envCap", { cap: formatContext(envCap) })}</p>
			)}
			{slow && (
				<p className="text-(--omp-warning)" data-context-slow>
					{t("ollama.context.slow", { floor: formatContext(CONTEXT_FLOOR) })}
				</p>
			)}
			{stale && <p data-context-stale>{t("ollama.context.stale")}</p>}
			{state === "running" && (
				<p data-context-running role="status">
					{runningCtx === null
						? t("ollama.context.measuringStart")
						: t("ollama.context.measuring", { size: formatContext(runningCtx) })}
				</p>
			)}
			{state === "queued" && (
				<p data-context-queued role="status">
					{t("ollama.context.queued")}
				</p>
			)}
			{lastError !== null && state === "idle" && (
				<p className="text-(--omp-error)" data-context-error>
					{t("ollama.context.error", { error: lastError })}
				</p>
			)}
		</div>
	);
}
