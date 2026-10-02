/**
 * Download progress for one Ollama model: striped while the size is unknown,
 * a percent bar once Ollama reports bytes, hidden when the download is done.
 * Pure props — the parent owns the pull and its cancellation.
 */

import type { PullProgress } from "../../../shared/ollama-types";
import { useT } from "../../lib/i18n";
import { Button } from "../common";
import "./onboarding.css";

export interface PullBarProps {
	/** null when no download is running for this model. */
	progress: PullProgress | null;
	onCancel: () => void;
}

export function PullBar({ progress, onCancel }: PullBarProps) {
	const t = useT();
	if (!progress) return null;

	if (progress.error) {
		return (
			<p className="omp-pull-error text-omp-sm" data-tag={progress.tag} role="alert">
				{progress.error}
			</p>
		);
	}
	if (progress.done) return null;

	const indeterminate = progress.percent < 0;
	const percent = Math.min(99, Math.max(0, Math.round(progress.percent)));
	const caption = indeterminate
		? t("welcome.card.starting")
		: progress.status
			? `${progress.status} · ${percent}%`
			: `${percent}%`;

	return (
		<div className="flex flex-col gap-1.5" data-tag={progress.tag}>
			<div
				aria-label={caption}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={indeterminate ? undefined : percent}
				className="omp-pull-track"
				data-indeterminate={indeterminate}
				role="progressbar"
			>
				<div className="omp-pull-fill" style={indeterminate ? undefined : { width: `${percent}%` }} />
			</div>
			<div className="flex items-center justify-between gap-2">
				<span className="min-w-0 truncate text-omp-sm text-(--omp-text-secondary) tabular-nums">{caption}</span>
				<Button data-action="cancel-pull" onClick={onCancel} size="sm" variant="ghost">
					{t("welcome.card.cancel")}
				</Button>
			</div>
		</div>
	);
}
