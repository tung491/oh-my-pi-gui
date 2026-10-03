/**
 * One model on the welcome screen: its tiers, what it needs from this machine,
 * whether it is already downloaded, and the action that fits — use it, or
 * download it with a live progress bar. Pure props; the parent owns the pull.
 */

import { Check, Download } from "lucide-react";
import type { ModelChoice, PullProgress } from "../../../shared/ollama-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Button } from "../common";
import { formatGigabytes } from "./MachineFacts";
import { PullBar } from "./PullBar";
import "./welcome-screen.css";

export interface ModelCardProps {
	choice: ModelChoice;
	/** The download frame for this tag, or null when none is running or kept on screen. */
	progress: PullProgress | null;
	picked: boolean;
	/** Another model is downloading; only one pull runs at a time. */
	downloadDisabled: boolean;
	onUse: (tag: string) => void;
	onDownload: (tag: string) => void;
	onCancel: (tag: string) => void;
}

export function ModelCard({ choice, progress, picked, downloadDisabled, onUse, onDownload, onCancel }: ModelCardProps) {
	const t = useT();
	const downloading = progress !== null && !progress.done;

	return (
		<article
			aria-label={choice.label}
			className={cx("omp-model-card", picked && "omp-model-card-picked")}
			data-installed={choice.installed === null ? "unknown" : String(choice.installed)}
			data-picked={picked}
			data-tag={choice.tag}
		>
			<div className="flex flex-wrap gap-1.5">
				{choice.tiers.map(tier => (
					<span className="omp-model-tier" data-tier={tier} key={tier}>
						{t(`welcome.tier.${tier}`)}
					</span>
				))}
			</div>
			<div className="flex flex-col gap-0.5">
				<h3 className="font-display text-omp-lg font-semibold text-(--omp-text)">{choice.label}</h3>
				<p className="text-omp-sm text-(--omp-text-secondary)">{choice.tag}</p>
			</div>
			<dl className="omp-model-specs">
				<dt>{t("welcome.card.params")}</dt>
				<dd>{`${choice.params}B`}</dd>
				<dt>{t("welcome.card.active")}</dt>
				<dd>{`${choice.activeParams}B`}</dd>
				<dt>{t("welcome.card.download")}</dt>
				<dd>{formatGigabytes(choice.sizeBytes)}</dd>
				<dt>{t("welcome.card.needs")}</dt>
				<dd>{formatGigabytes(choice.needBytes)}</dd>
				<dt>{t("welcome.card.runsIn")}</dt>
				<dd>{t(`welcome.card.fit.${choice.fit}`)}</dd>
				<dt>{t("welcome.card.speed")}</dt>
				<dd>{t(`welcome.card.speed.${choice.speed}`)}</dd>
			</dl>
			{choice.tight && (
				<p className="text-omp-sm text-(--omp-warning)" data-tight="true">
					{t("welcome.card.tight")}
				</p>
			)}
			<div className="omp-model-state">
				{choice.installed === true ? (
					<div className="flex items-center gap-2 text-(--omp-success)">
						<span aria-hidden="true" className="omp-model-ready-badge">
							<Check size={12} strokeWidth={3} />
						</span>
						<span>{t("welcome.card.installed")}</span>
					</div>
				) : (
					<p className="text-(--omp-text-secondary)">
						{choice.installed === false ? t("welcome.card.notInstalled") : t("welcome.card.installUnknown")}
					</p>
				)}
			</div>
			<div className="mt-auto flex flex-col gap-2">
				<PullBar onCancel={() => onCancel(choice.tag)} progress={progress} />
				{choice.installed === true ? (
					<Button
						aria-pressed={picked}
						data-action="use-model"
						icon={picked ? <Check size={14} /> : undefined}
						onClick={() => onUse(choice.tag)}
						size="sm"
						variant={picked ? "primary" : "secondary"}
					>
						{t("welcome.card.use")}
					</Button>
				) : (
					!downloading && (
						<Button
							data-action="download-model"
							// Unknown means Ollama did not answer, so a pull could not start either.
							disabled={downloadDisabled || choice.installed === null}
							icon={<Download size={14} />}
							onClick={() => onDownload(choice.tag)}
							size="sm"
							variant="secondary"
						>
							{t("welcome.card.download")}
						</Button>
					)
				)}
			</div>
		</article>
	);
}

/** A card-shaped placeholder of the real card's size, shown before the model screen arrives. */
export function ModelCardSkeleton() {
	return (
		<div aria-hidden="true" className="omp-model-card" data-skeleton="true">
			<span className="omp-skeleton omp-welcome-wait" style={{ width: "5rem" }} />
			<span className="omp-skeleton omp-welcome-wait omp-welcome-wait-lg" style={{ width: "70%" }} />
			<span className="omp-skeleton omp-welcome-wait" style={{ width: "45%" }} />
			{[0, 1, 2, 3, 4, 5].map(row => (
				<span className="omp-skeleton omp-welcome-wait" key={row} style={{ width: "100%" }} />
			))}
		</div>
	);
}
