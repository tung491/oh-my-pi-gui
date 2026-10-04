/**
 * The Ollama window (opened by `openProviders`, so every former "Providers"
 * entry point lands here): whether the local daemon answers and how to fix it,
 * the endpoint the agent uses, the installed models with "Use as default", a
 * tag-based download, and a way back into the welcome screen. Ollama is the
 * only provider the GUI offers, so there is no sign-in or custom provider here.
 */

import { Check, Download, RefreshCw, RotateCcw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { OllamaInstallProgress, OllamaRemedyId, OllamaStatus, PullProgress } from "../../../shared/ollama-types";
import { applyModelInfo } from "../../hooks/use-rpc-events";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal } from "../common";
import { WELCOME_COMPLETED_PREF } from "../dialogs/FirstRunOnboardingDialog";
import { OllamaRow } from "../onboarding/OllamaRow";
import { PullBar } from "../onboarding/PullBar";

/** Main answers a second concurrent pull with this status: the single download slot is taken. */
const PULL_BUSY_STATUS = "busy";

/** What `ollama pull` accepts as a tag: no whitespace, no option-looking prefix, bounded length. */
export function normalizePullTag(input: string): string | null {
	const tag = input.trim();
	if (tag.length === 0 || tag.length > 200 || tag.startsWith("-") || /\s/.test(tag)) return null;
	return tag;
}

/** A pull frame with nothing downloaded yet. */
function emptyFrame(tag: string, status: string): PullProgress {
	return { tag, status, completed: 0, total: 0, percent: -1, done: false };
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function ProvidersWindow() {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const open = useUiStore(s => s.providersOpen);
	const close = useUiStore(s => s.closeProviders);
	const openWelcome = useUiStore(s => s.openWelcome);
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const current = useModelStore(s => s.model);
	const refreshAvailableModels = useModelStore(s => s.refreshAvailableModels);

	const [status, setStatus] = useState<OllamaStatus | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [remedyBusy, setRemedyBusy] = useState<OllamaRemedyId | null>(null);
	const [remedyHint, setRemedyHint] = useState<string | null>(null);
	const [installProgress, setInstallProgress] = useState<OllamaInstallProgress | null>(null);
	const [defaultBusy, setDefaultBusy] = useState<string | null>(null);
	const [tagInput, setTagInput] = useState("");
	const [progress, setProgress] = useState<PullProgress | null>(null);
	const [pullNotice, setPullNotice] = useState<string | null>(null);
	/** The tag this window is downloading; null when idle or after its own cancel. */
	const pullingTag = useRef<string | null>(null);
	const statusVersion = useRef(0);

	const loadStatus = useCallback(async (): Promise<void> => {
		const version = ++statusVersion.current;
		setLoading(true);
		try {
			const next = await window.omp.ollama.status();
			if (version !== statusVersion.current) return;
			setStatus(next);
			setLoadError(null);
		} catch (cause) {
			if (version === statusVersion.current) setLoadError(messageOf(cause));
		} finally {
			if (version === statusVersion.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		setRemedyHint(null);
		void loadStatus();
	}, [open, loadStatus]);

	// Subscribed for the component's lifetime, not just while open: closing the
	// window does not stop a download, and reopening must still show it. Frames
	// for any other tag belong to the welcome screen's download.
	useEffect(
		() =>
			window.omp.ollama.onPullProgress(frame => {
				if (frame.tag === pullingTag.current) setProgress(frame);
			}),
		[],
	);

	// Main runs one install for every window and broadcasts its frames, so this
	// window shows an install the welcome screen started, too. The done frame
	// re-reads Ollama, since only the window that ran the install gets its result.
	useEffect(
		() =>
			window.omp.ollama.onInstallProgress(frame => {
				setInstallProgress(frame);
				if (frame.done) void loadStatus();
			}),
		[loadStatus],
	);

	const runRemedy = async (id: OllamaRemedyId) => {
		setRemedyBusy(id);
		setRemedyHint(null);
		// A done frame held from an earlier run would hide this run's waiting state; a live one
		// belongs to the run this call joins, so it stays.
		setInstallProgress(held => (held?.done ? null : held));
		try {
			const result = await window.omp.ollama.runRemedy(id);
			switch (result.outcome) {
				case "applied":
					setStatus(result.status);
					break;
				case "cancelled":
					break;
				case "unavailable":
					setRemedyHint(t("welcome.ollama.remedyUnavailable"));
					break;
				case "reopen-required":
					setRemedyHint(t("welcome.ollama.remedyReopen"));
					break;
				case "failed":
					setRemedyHint(t("welcome.ollama.remedyFailed", { error: result.fault ?? "" }));
					break;
			}
		} catch (cause) {
			setRemedyHint(t("welcome.ollama.remedyFailed", { error: messageOf(cause) }));
			// Main rejects a remedy that no longer matches the daemon's state; re-read it
			// so a stale button goes away.
			void loadStatus();
		} finally {
			setRemedyBusy(null);
			setInstallProgress(null);
		}
	};

	const openDownload = () => {
		void window.omp.ollama.openDownload().catch(cause => {
			toast({ variant: "error", message: messageOf(cause) });
		});
	};

	const makeDefault = async (tag: string) => {
		if (!sidecarReady || defaultBusy !== null) return;
		setDefaultBusy(tag);
		const toastFailure = (error: string) => {
			toast({ variant: "error", message: t("welcome.error.setModel", { tag, error }) });
		};
		try {
			const response = await tabRpc.setModel("ollama", tag);
			if (!response.success) {
				toastFailure(response.error);
				return;
			}
			// The response carries the sidecar's live model; applying it covers a
			// re-pick of the current model, which emits no model_changed event.
			applyModelInfo(response.data, tabId);
			// Same handoff as the welcome screen's Continue: the default role makes the
			// pick stick for new sessions, and the completion marker stops the welcome
			// screen reopening for someone who set Ollama up here.
			const role = await tabRpc.setModelRole("default", `ollama/${tag}`);
			if (!role.success) {
				toastFailure(role.error);
				return;
			}
			try {
				await window.omp.prefs.set(WELCOME_COMPLETED_PREF, new Date().toISOString());
			} catch (cause) {
				// The model is already the default; a lost marker only risks the welcome
				// screen showing once more, which is not worth failing the action over.
				console.warn("[providers] could not record welcome completion:", messageOf(cause));
			}
			toast({ variant: "success", message: t("modelCompare.setSuccess", { model: `ollama/${tag}` }) });
		} catch (cause) {
			toastFailure(messageOf(cause));
		} finally {
			setDefaultBusy(null);
		}
	};

	const pull = async (event: FormEvent) => {
		event.preventDefault();
		const tag = normalizePullTag(tagInput);
		if (!tag || pullingTag.current !== null) return;
		pullingTag.current = tag;
		setPullNotice(null);
		setProgress(emptyFrame(tag, ""));
		let final: PullProgress;
		try {
			final = await window.omp.ollama.pull(tag);
		} catch (cause) {
			// pull() resolves with its final frame by contract; an IPC failure is the
			// only way here, and it reads the same as a failed download.
			final = { ...emptyFrame(tag, "error"), error: messageOf(cause) };
		}
		// Our own cancel already cleared the bar; main sends nothing after it.
		if (pullingTag.current !== tag) return;
		pullingTag.current = null;
		if (final.error && final.status === PULL_BUSY_STATUS) {
			setProgress(null);
			setPullNotice(final.error);
			return;
		}
		if (final.error) {
			setProgress(final);
			return;
		}
		setProgress(null);
		setTagInput("");
		await loadStatus();
		if (sidecarReady) {
			// The picker reads the catalog again whenever it opens, so a failed
			// forced refresh here only delays the new model by one open.
			await refreshAvailableModels(true).catch(() => undefined);
		}
	};

	const cancelPull = () => {
		pullingTag.current = null;
		setProgress(null);
		void window.omp.ollama.cancelPull().catch(cause => {
			toast({ variant: "error", message: messageOf(cause) });
		});
	};

	const pulling = progress !== null && !progress.done && !progress.error;
	const running = status?.state === "ok";
	const pullTag = normalizePullTag(tagInput);
	const installed = status?.installedTags ?? [];

	return (
		<Modal open={open} onClose={close} title={t("ollama.settings.title")} size="lg">
			<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2 text-omp-md">
						<span className="shrink-0 text-(--omp-muted)">{t("ollama.settings.endpoint")}</span>
						<code className="truncate font-mono text-omp-sm text-(--omp-text)" data-ollama-endpoint>
							{status?.baseUrl ?? "—"}
						</code>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							size="sm"
							variant="ghost"
							icon={<RefreshCw size={12} />}
							loading={loading}
							onClick={() => void loadStatus()}
						>
							{t("ollama.settings.refresh")}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							icon={<RotateCcw size={12} />}
							onClick={() => {
								close();
								openWelcome();
							}}
						>
							{t("ollama.settings.runSetup")}
						</Button>
					</div>
				</div>

				{loadError ? (
					<div
						role="alert"
						className="rounded-md bg-(--omp-tool-error-bg) px-3 py-2 text-omp-md text-(--omp-error)"
					>
						{loadError}
					</div>
				) : (
					<OllamaRow
						busy={remedyBusy}
						installProgress={installProgress}
						onCheckAgain={() => void loadStatus()}
						onOpenDownload={openDownload}
						onRemedy={id => void runRemedy(id)}
						status={status}
					/>
				)}
				{remedyHint && (
					<p className="text-omp-sm text-(--omp-warning)" data-remedy-hint role="alert">
						{remedyHint}
					</p>
				)}

				<section className="flex flex-col gap-2" aria-label={t("ollama.settings.models")}>
					<span className="text-omp-sm font-semibold uppercase tracking-wider text-(--omp-muted)">
						{t("ollama.settings.models")}
					</span>
					{status && installed.length === 0 && (
						<div className="rounded-md border border-(--omp-border-muted) px-3 py-4 text-center text-omp-md text-(--omp-dim)">
							{t("ollama.settings.noModels")}
						</div>
					)}
					{installed.map(tag => {
						const isCurrent = current?.provider === "ollama" && current.id === tag;
						return (
							<div
								className="flex items-center gap-3 rounded-lg border border-(--omp-border-muted) px-3 py-2.5"
								data-installed-tag={tag}
								key={tag}
							>
								<span className="min-w-0 flex-1 truncate font-mono text-omp-md text-(--omp-text)">{tag}</span>
								{isCurrent ? (
									<Check aria-hidden="true" className="shrink-0 text-(--omp-accent)" size={16} />
								) : (
									<Button
										data-action="use-as-default"
										disabled={!sidecarReady || defaultBusy !== null}
										loading={defaultBusy === tag}
										onClick={() => void makeDefault(tag)}
										size="sm"
										title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
										variant="secondary"
									>
										{t("ollama.settings.useAsDefault")}
									</Button>
								)}
							</div>
						);
					})}
				</section>

				<form className="flex flex-col gap-2" onSubmit={event => void pull(event)}>
					<div className="flex items-end gap-2">
						<div className="min-w-0 flex-1">
							<Input
								aria-label={t("ollama.settings.pullPlaceholder")}
								disabled={pulling || !running}
								mono
								onChange={event => setTagInput(event.target.value)}
								placeholder={t("ollama.settings.pullPlaceholder")}
								value={tagInput}
							/>
						</div>
						<Button
							data-action="pull"
							disabled={pulling || !running || pullTag === null}
							icon={<Download size={14} />}
							size="sm"
							type="submit"
							variant="primary"
						>
							{t("ollama.settings.pull")}
						</Button>
					</div>
					{pullNotice && (
						<p className="text-omp-sm text-(--omp-muted)" data-pull-notice role="status">
							{pullNotice}
						</p>
					)}
					<PullBar onCancel={cancelPull} progress={progress} />
				</form>
			</div>
		</Modal>
	);
}
