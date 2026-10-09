import { CheckCircle2, Download, RefreshCw, RotateCcw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { UpdateStatus } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { Button, Spinner } from "../common";
import { updateErrorText } from "../layout/UpdateBanner";

function appLatest(status: UpdateStatus): string {
	if ("version" in status) return status.version;
	return "—";
}

export type UpdateOverviewState = "checking" | "healthy" | "attention" | "error";

function appUpdateAvailable(status: UpdateStatus): boolean {
	return status.state === "available" || status.state === "downloading" || status.state === "downloaded";
}

/**
 * Derive the honest aggregate state shown by the updates header. The app's own
 * release feed is the only source: the bundled agent ships inside the app and
 * updates with it, so its package registry is never consulted.
 */
export function updateOverviewState(status: UpdateStatus, checking: boolean): UpdateOverviewState {
	if (checking || status.state === "idle" || status.state === "checking") return "checking";
	if (status.state === "error") return "error";
	if (appUpdateAvailable(status)) return "attention";
	return "healthy";
}

export function UpdatesSettingsPage() {
	const t = useT();
	const status = useUpdaterStore(state => state.status);
	const setStatus = useUpdaterStore(state => state.setStatus);
	const [guiVersion, setGuiVersion] = useState<string>();
	const [checking, setChecking] = useState(false);

	const check = useCallback(async () => {
		setChecking(true);
		try {
			setStatus(await window.omp.updater.check());
		} catch (error) {
			setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setChecking(false);
		}
	}, [setStatus]);

	useEffect(() => {
		void window.omp.updater.version().then(setGuiVersion);
		void check();
	}, [check]);

	const overview = updateOverviewState(status, checking);
	const errorMessage = status.state === "error" ? updateErrorText(t, status) : undefined;

	return (
		<div>
			<header className="mb-5">
				<h2 className="text-[20px] font-semibold tracking-[-0.015em] text-(--omp-text)">{t("updates.title")}</h2>
				<p className="mt-1 text-omp-md text-(--omp-muted)">{t("updates.subtitle")}</p>
			</header>

			<div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-(--omp-border-muted) px-3 py-2.5">
				{overview === "checking" ? (
					<Spinner size="sm" />
				) : overview === "healthy" ? (
					<CheckCircle2 className="text-(--omp-success)" size={15} />
				) : (
					<ServerCog className={overview === "error" ? "text-(--omp-error)" : "text-(--omp-warning)"} size={15} />
				)}
				<div className="min-w-0 flex-1">
					<div className="text-omp-md font-medium text-(--omp-text)">
						{overview === "healthy"
							? t("updates.systemHealthy")
							: overview === "attention"
								? t("updates.systemAttention")
								: overview === "error"
									? t("updates.systemError")
									: t("updates.systemChecking")}
					</div>
					<div className="mt-0.5 text-omp-xs text-(--omp-dim)">{t("updates.deliveryNote")}</div>
				</div>
				<Button
					icon={checking ? <Spinner size="sm" /> : <RefreshCw size={13} />}
					disabled={checking}
					onClick={check}
					size="sm"
				>
					{t("updates.checkAll")}
				</Button>
			</div>

			<div className="divide-y divide-(--omp-border-muted) overflow-hidden rounded-lg border border-(--omp-border-muted)">
				<section className="updates-row items-center gap-3 px-4 py-3">
					<div className="updates-icon flex size-8 items-center justify-center text-(--omp-muted)">
						<Download size={15} />
					</div>
					<div className="updates-copy min-w-0">
						<h3 className="text-omp-md font-semibold text-(--omp-text)">{t("updates.gui.name")}</h3>
						<p className="mt-0.5 text-omp-xs text-(--omp-dim)">{t("updates.gui.description")}</p>
						{status.state === "downloaded" && status.reopenRequired && (
							<p className="mt-1 text-omp-xs text-(--omp-muted)">
								{t("updater.reopenToInstall", { version: status.version })}
							</p>
						)}
					</div>
					<div className="updates-current">
						<div className="text-omp-xxs uppercase tracking-wider text-(--omp-dim)">{t("updates.current")}</div>
						<div className="mt-1 font-mono text-omp-sm text-(--omp-text)">{guiVersion ?? "—"}</div>
					</div>
					<div className="updates-latest">
						<div className="text-omp-xxs uppercase tracking-wider text-(--omp-dim)">{t("updates.latest")}</div>
						<div className="mt-1 font-mono text-omp-sm text-(--omp-text)">
							{guiVersion ? appLatest(status) : "—"}
						</div>
					</div>
					<div className="updates-action justify-self-end">
						{status.state === "available" && (
							<Button
								icon={<Download size={13} />}
								onClick={() => void window.omp.updater.download()}
								size="sm"
								variant="primary"
							>
								{t("updater.download")}
							</Button>
						)}
						{status.state === "downloading" && (
							<span className="text-omp-sm text-(--omp-muted)">{status.percent}%</span>
						)}
						{status.state === "downloaded" && !status.reopenRequired && (
							<Button
								icon={<RotateCcw size={13} />}
								onClick={() => void window.omp.updater.apply()}
								size="sm"
								variant="primary"
							>
								{t("updater.restart")}
							</Button>
						)}
						{(status.state === "idle" || status.state === "checking") && (
							<span className="flex items-center gap-1.5 text-omp-sm text-(--omp-muted)">
								<Spinner size="sm" /> {t("updates.checking")}
							</span>
						)}
						{status.state === "error" && (
							<span className="text-omp-sm text-(--omp-error)">{t("updates.checkFailed")}</span>
						)}
						{status.state === "not-available" && (
							<span className="text-omp-sm text-(--omp-success)">{t("updates.upToDate")}</span>
						)}
					</div>
				</section>
			</div>
			{errorMessage && <p className="mt-3 text-omp-sm text-(--omp-error)">{errorMessage}</p>}
		</div>
	);
}
