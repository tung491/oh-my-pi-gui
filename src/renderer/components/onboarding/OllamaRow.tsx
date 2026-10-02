/**
 * The Ollama status row shared by the welcome screen and Settings › Ollama:
 * whether the local daemon answers, and what to do when it does not. Pure
 * props — the parent owns every probe and remedy.
 */

import { AlertTriangle, CheckCircle2, Download, ExternalLink, Play, RefreshCw, XCircle } from "lucide-react";
import { OLLAMA_REMEDY_COMMANDS, type OllamaRemedyId, type OllamaStatus } from "../../../shared/ollama-types";
import { useT } from "../../lib/i18n";
import { Button, Spinner } from "../common";
import "./onboarding.css";

export interface OllamaRowProps {
	/** null while the first probe is in flight. */
	status: OllamaStatus | null;
	/** The remedy currently running; its button spins and every other action is disabled. */
	busy: OllamaRemedyId | null;
	onRemedy: (id: OllamaRemedyId) => void;
	onCheckAgain: () => void;
	onOpenDownload: () => void;
}

const REMEDY_LABEL_KEYS: Record<OllamaRemedyId, string> = {
	"linux-start": "welcome.ollama.start",
	"linux-install": "welcome.ollama.install",
};

function messageKey(status: OllamaStatus): string {
	if (status.state === "absent") return "welcome.ollama.absent";
	if (status.platform !== "linux") return "welcome.ollama.stopped.other";
	// Without a systemd unit (a binary or tarball install) there is no service to start.
	return status.remedy === "linux-start" ? "welcome.ollama.stopped.linux" : "welcome.ollama.stopped.manual";
}

export function OllamaRow({ status, busy, onRemedy, onCheckAgain, onOpenDownload }: OllamaRowProps) {
	const t = useT();

	if (!status) {
		return (
			<div className="omp-ollama-row flex items-center gap-2 px-3 py-2.5 text-omp-md" data-state="loading">
				<Spinner size="sm" label={t("welcome.reading")} />
			</div>
		);
	}

	if (status.state === "ok") {
		return (
			<div
				className="omp-ollama-row flex items-center gap-2 px-3 py-2.5 text-omp-md"
				data-state="ok"
				data-tone="success"
				role="status"
			>
				<CheckCircle2 aria-hidden="true" className="omp-ollama-row-icon shrink-0" size={16} />
				<span>{t("welcome.ollama.running", { count: status.modelCount })}</span>
			</div>
		);
	}

	const remedy = status.remedy;
	const showCommand = remedy !== null && status.platform === "linux";
	const anyBusy = busy !== null;
	const Icon = status.state === "absent" ? XCircle : AlertTriangle;

	return (
		<div
			className="omp-ollama-row flex flex-col gap-2.5 px-3 py-2.5 text-omp-md"
			data-state={status.state}
			data-tone={status.state === "absent" ? "error" : "warning"}
			role="status"
		>
			<div className="flex items-start gap-2">
				<Icon aria-hidden="true" className="omp-ollama-row-icon mt-0.5 shrink-0" size={16} />
				<span>{t(messageKey(status))}</span>
			</div>
			{showCommand && (
				<code className="omp-ollama-command block px-2.5 py-1.5 font-mono text-omp-sm" data-remedy={remedy}>
					{OLLAMA_REMEDY_COMMANDS[remedy]}
				</code>
			)}
			{remedy === "linux-install" && (
				<p className="text-omp-sm text-(--omp-text-secondary)">{t("welcome.ollama.installNote")}</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				{remedy !== null && (
					<Button
						data-action="remedy"
						disabled={anyBusy && busy !== remedy}
						icon={remedy === "linux-install" ? <Download size={14} /> : <Play size={14} />}
						loading={busy === remedy}
						onClick={() => onRemedy(remedy)}
						size="sm"
						variant="primary"
					>
						{t(REMEDY_LABEL_KEYS[remedy])}
					</Button>
				)}
				<Button
					data-action="open-download"
					disabled={anyBusy}
					icon={<ExternalLink size={14} />}
					onClick={onOpenDownload}
					size="sm"
					variant="secondary"
				>
					{t("welcome.ollama.openDownload")}
				</Button>
				<Button
					data-action="check-again"
					disabled={anyBusy}
					icon={<RefreshCw size={14} />}
					onClick={onCheckAgain}
					size="sm"
					variant="ghost"
				>
					{t("welcome.ollama.checkAgain")}
				</Button>
			</div>
		</div>
	);
}
