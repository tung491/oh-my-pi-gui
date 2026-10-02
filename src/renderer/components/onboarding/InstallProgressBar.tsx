/**
 * Progress of the Linux Ollama install: striped while polkit asks for the
 * password or the installer is between downloads, a percent bar while curl
 * downloads. Pure props, and no cancel control: a root child of `pkexec`
 * cannot be stopped safely from the GUI.
 */

import type { OllamaInstallProgress } from "../../../shared/ollama-types";
import { headLines, sanitizeToolText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import "./onboarding.css";

export interface InstallProgressBarProps {
	progress: OllamaInstallProgress;
}

/** The installer's stage text on one line, with terminal controls stripped. */
function stageLine(stage: string | null): string {
	if (stage === null) return "";
	return headLines(sanitizeToolText(stage).trim(), 1).head;
}

export function InstallProgressBar({ progress }: InstallProgressBarProps) {
	const t = useT();
	const indeterminate = progress.percent < 0;
	const percent = Math.min(100, Math.max(0, Math.round(progress.percent)));
	const stage = stageLine(progress.stage);
	const caption = stage.length > 0 ? stage : indeterminate ? t("welcome.install.waiting") : "";
	const percentText = indeterminate ? null : t("welcome.install.percent", { percent });

	return (
		<div className="flex flex-col gap-1.5" data-install-progress>
			<div
				aria-label={caption || percentText || t("welcome.install.note")}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={indeterminate ? undefined : percent}
				className="omp-pull-track"
				data-indeterminate={indeterminate}
				role="progressbar"
			>
				<div className="omp-pull-fill" style={indeterminate ? undefined : { width: `${percent}%` }} />
			</div>
			<div className="flex items-center justify-between gap-2 text-omp-sm text-(--omp-text-secondary)">
				<span className="min-w-0 truncate" data-install-stage>
					{caption}
				</span>
				{percentText !== null && <span className="shrink-0 tabular-nums">{percentText}</span>}
			</div>
			<p className="text-omp-sm text-(--omp-muted)">{t("welcome.install.note")}</p>
		</div>
	);
}
