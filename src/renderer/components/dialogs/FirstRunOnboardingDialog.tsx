/**
 * The local-model welcome screen, ported from sai-welcome's first screen: what
 * this machine has, whether Ollama answers (and the fix when it does not), and
 * three model cards sized for the machine. Continue makes the picked model the
 * default and records that setup is done.
 *
 * It opens on its own once per launch while setup is incomplete, and whenever
 * `useUiStore().welcomeOpen` is set ("Run setup again").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type {
	ModelChoice,
	ModelScreen,
	OllamaRemedyId,
	OllamaStatus,
	PullProgress,
} from "../../../shared/ollama-types";
import { isAllowedProvider } from "../../../shared/provider-policy";
import type { ProviderInfo } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, SaiAtlasLogo } from "../common";
import { MachineFacts } from "../onboarding/MachineFacts";
import { ModelCard, ModelCardSkeleton } from "../onboarding/ModelCard";
import { OllamaRow } from "../onboarding/OllamaRow";
import "../onboarding/welcome-screen.css";

/** Main prefs key holding the ISO time setup finished; set only after the model handoff succeeded. */
export const WELCOME_COMPLETED_PREF = "welcome.completed";

/** Skeleton cards drawn while the model screen loads: one per tier, the count the grid settles into. */
const SKELETON_CARDS = 3;

function isProviderInfo(value: unknown): value is ProviderInfo {
	if (!value || typeof value !== "object") return false;
	return (
		"id" in value &&
		typeof value.id === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"authenticated" in value &&
		typeof value.authenticated === "boolean" &&
		"loginAvailable" in value &&
		typeof value.loginAvailable === "boolean" &&
		"disabled" in value &&
		typeof value.disabled === "boolean" &&
		"modelCount" in value &&
		typeof value.modelCount === "number"
	);
}

/**
 * A usable setup needs an allowed (Ollama) provider with both a model and a
 * non-disabled credential/config path. Other providers never count, even if
 * leftovers from an earlier version are still signed in.
 */
export function hasUsableModelProvider(
	providers: readonly ProviderInfo[],
	configs: readonly CustomProviderView[],
): boolean {
	const allowed = providers.filter(provider => isAllowedProvider(provider.id));
	if (allowed.some(provider => provider.authenticated && !provider.disabled && provider.modelCount > 0)) {
		return true;
	}

	const providerById = new Map(allowed.map(provider => [provider.id, provider]));
	return configs.some(config => {
		if (!isAllowedProvider(config.id)) return false;
		const provider = providerById.get(config.id);
		return config.auth === "none" && provider !== undefined && !provider.disabled && provider.modelCount > 0;
	});
}

/**
 * The model Continue uses when the user has not picked one: the current model
 * if it is downloaded, then the recommended tier, then the first downloaded
 * card (sai-welcome's `refreshModels` rule — never silently move a machine off
 * the model it already runs).
 */
export function defaultPick(choices: readonly ModelChoice[], currentTag: string | null): string | null {
	const installed = choices.filter(choice => choice.installed === true);
	const ready =
		installed.find(choice => choice.tag === currentTag) ??
		installed.find(choice => choice.tiers.includes("recommended")) ??
		installed[0];
	return ready?.tag ?? null;
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The local frame a Download click shows before Ollama reports anything. */
function startingFrame(tag: string): PullProgress {
	return { tag, status: "", completed: 0, total: 0, percent: -1, done: false };
}

function withoutTag(pulls: Record<string, PullProgress>, tag: string): Record<string, PullProgress> {
	const { [tag]: _removed, ...rest } = pulls;
	return rest;
}

export function FirstRunOnboardingDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarStatus = useSessionStore(state => state.status);
	const welcomeOpen = useUiStore(state => state.welcomeOpen);
	const closeWelcome = useUiStore(state => state.closeWelcome);
	const refreshAvailableModels = useModelStore(state => state.refreshAvailableModels);

	const checkedThisLaunch = useRef(false);
	// "Set up later", Escape and backdrop close for the rest of the launch: no
	// readiness check may reopen the screen after that. "Run setup again" can.
	const dismissed = useRef(false);
	const loadVersion = useRef(0);
	const warmed = useRef<string | null>(null);
	// Tags whose download this screen cancelled: their late frames are dropped.
	const cancelledTags = useRef(new Set<string>());
	// Tags whose download this screen started and that have not settled yet. Main
	// broadcasts every pull, so frames for anything else (a Settings › Ollama
	// download, a stale frame) must not reach the cards or block Download.
	const startedTags = useRef(new Set<string>());

	const [autoOpen, setAutoOpen] = useState(false);
	const [status, setStatus] = useState<OllamaStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	// undefined while loading; null when the model screen could not be read.
	const [screen, setScreen] = useState<ModelScreen | null | undefined>(undefined);
	const [currentTag, setCurrentTag] = useState<string | null>(null);
	const [pulls, setPulls] = useState<Record<string, PullProgress>>({});
	const [pulledTags, setPulledTags] = useState<ReadonlySet<string>>(() => new Set());
	const [picked, setPicked] = useState<string | null>(null);
	const [remedyBusy, setRemedyBusy] = useState<OllamaRemedyId | null>(null);
	const [remedyNotice, setRemedyNotice] = useState<string | null>(null);
	const [continuing, setContinuing] = useState(false);
	const [continueError, setContinueError] = useState<string | null>(null);

	const open = welcomeOpen || autoOpen;

	// Startup gate: once per launch, after the sidecar is ready.
	useEffect(() => {
		if (sidecarStatus !== "ready" || checkedThisLaunch.current) return;
		checkedThisLaunch.current = true;
		let cancelled = false;
		void (async () => {
			try {
				const completed = await window.omp.prefs.get(WELCOME_COMPLETED_PREF).catch(() => null);
				if (typeof completed === "string" && completed.length > 0) return;
				const [providerResult, configResult] = await Promise.allSettled([
					tabRpc.getProviders(),
					window.omp.models.listProviders(),
				]);
				if (cancelled) return;
				if (providerResult.status === "rejected") throw providerResult.reason;
				if (!providerResult.value.success) throw new Error(providerResult.value.error);
				const data = providerResult.value.data;
				const providers =
					data &&
					typeof data === "object" &&
					"providers" in data &&
					Array.isArray(data.providers) &&
					data.providers.every(isProviderInfo)
						? data.providers
						: [];
				const configs = configResult.status === "fulfilled" ? configResult.value : [];
				if (hasUsableModelProvider(providers, configs)) return;
				// A slow startup check must not cover a page the user already opened.
				if (document.querySelector('[role="dialog"]')) return;
				if (!dismissed.current) setAutoOpen(true);
			} catch (cause) {
				// Transient sidecar/transport failure: retry on the next ready transition.
				checkedThisLaunch.current = false;
				console.warn("[welcome] readiness check failed:", errorText(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sidecarStatus, tabRpc.getProviders]);

	const refreshStatus = useCallback(async (version: number) => {
		try {
			const next = await window.omp.ollama.status();
			if (version !== loadVersion.current) return;
			setStatus(next);
			setStatusError(null);
		} catch (cause) {
			if (version !== loadVersion.current) return;
			setStatusError(errorText(cause));
		}
	}, []);

	const refreshScreen = useCallback(async (version: number) => {
		try {
			const next = await window.omp.ollama.modelScreen();
			if (version !== loadVersion.current) return;
			setScreen(next);
		} catch (cause) {
			if (version !== loadVersion.current) return;
			console.warn("[welcome] model screen failed:", errorText(cause));
			setScreen(null);
		}
	}, []);

	/** Both fetches start together so the cheap Ollama probe never waits behind the hardware read. */
	const load = useCallback(() => {
		const version = ++loadVersion.current;
		void refreshStatus(version);
		void refreshScreen(version);
	}, [refreshScreen, refreshStatus]);

	useEffect(() => {
		if (!open) return;
		setRemedyNotice(null);
		setContinueError(null);
		load();
		let cancelled = false;
		if (sidecarStatus === "ready") {
			tabRpc
				.getState()
				.then(response => {
					if (cancelled || !response.success) return;
					const model = (response.data as { model?: { provider?: unknown; id?: unknown } | null } | undefined)
						?.model;
					setCurrentTag(model?.provider === "ollama" && typeof model.id === "string" ? model.id : null);
				})
				// The current model only ranks the default pick; without it the recommended tier wins.
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	}, [open, load, sidecarStatus, tabRpc.getState]);

	/**
	 * Force the agent to re-run discovery. Its catalog was read when the sidecar
	 * started, so a model pulled since then is unknown to `set_model` until this.
	 */
	const refreshCatalog = useCallback(async () => {
		try {
			await refreshAvailableModels(true);
		} catch (cause) {
			// set_model reports a model the agent still cannot find, so this only logs.
			console.warn("[welcome] model catalog refresh failed:", errorText(cause));
		}
	}, [refreshAvailableModels]);

	const markInstalled = useCallback(
		(tag: string) => {
			setPulledTags(previous => new Set(previous).add(tag));
			setPulls(previous => withoutTag(previous, tag));
			load();
			void refreshCatalog();
		},
		[load, refreshCatalog],
	);

	// Progress streams from main for as long as this component lives, so a pull
	// started before the screen closed keeps updating when it reopens.
	useEffect(() => {
		const ollama = window.omp?.ollama;
		if (!ollama) return;
		return ollama.onPullProgress(frame => {
			if (!startedTags.current.has(frame.tag) || cancelledTags.current.has(frame.tag)) return;
			if (frame.done && !frame.error) {
				markInstalled(frame.tag);
				return;
			}
			// Main's error frames say done: false, but nothing follows them.
			setPulls(previous => ({ ...previous, [frame.tag]: frame.error ? { ...frame, done: true } : frame }));
		});
	}, [markInstalled]);

	const pick = useCallback((tag: string) => {
		setPicked(tag);
		setContinueError(null);
		// Start loading the model now, a whole screen before the first prompt.
		if (warmed.current === tag) return;
		warmed.current = tag;
		window.omp.ollama.warm(tag).catch(cause => console.warn("[welcome] warm failed:", errorText(cause)));
	}, []);

	const choices: ModelChoice[] = (screen?.choices ?? []).map(choice =>
		pulledTags.has(choice.tag) ? { ...choice, installed: true } : choice,
	);
	const pickedChoice = choices.find(choice => choice.tag === picked && choice.installed === true);
	const fallbackTag = defaultPick(choices, currentTag);
	const continueTag = pickedChoice?.tag ?? fallbackTag;

	// Settle on a default as soon as one is on the machine, and warm it, as sai-welcome does.
	useEffect(() => {
		if (open && picked === null && fallbackTag !== null) pick(fallbackTag);
	}, [open, picked, fallbackTag, pick]);

	const pullRunning = Object.values(pulls).some(frame => !frame.done && !frame.error);

	const download = async (tag: string) => {
		if (pullRunning) return;
		cancelledTags.current.delete(tag);
		startedTags.current.add(tag);
		setPulls(previous => ({ ...previous, [tag]: startingFrame(tag) }));
		let final: PullProgress;
		try {
			final = await window.omp.ollama.pull(tag);
		} catch (cause) {
			final = { ...startingFrame(tag), done: true, error: errorText(cause) };
		} finally {
			startedTags.current.delete(tag);
		}
		if (cancelledTags.current.has(tag)) return;
		if (final.done && !final.error) {
			markInstalled(tag);
			return;
		}
		// An error frame, including "another download is running", stays on the card as a notice.
		setPulls(previous => ({ ...previous, [tag]: { ...final, tag, done: true } }));
	};

	const cancel = (tag: string) => {
		cancelledTags.current.add(tag);
		setPulls(previous => withoutTag(previous, tag));
		window.omp.ollama.cancelPull().catch(cause => console.warn("[welcome] cancel failed:", errorText(cause)));
	};

	const runRemedy = async (id: OllamaRemedyId) => {
		setRemedyBusy(id);
		setRemedyNotice(null);
		try {
			const result = await window.omp.ollama.runRemedy(id);
			switch (result.outcome) {
				case "applied":
					setStatus(result.status);
					setStatusError(null);
					void refreshScreen(loadVersion.current);
					break;
				case "cancelled":
					break;
				case "unavailable":
					setRemedyNotice(t("welcome.ollama.remedyUnavailable"));
					break;
				case "failed":
					setStatus(result.status);
					setRemedyNotice(
						t("welcome.ollama.remedyFailed", { error: result.fault ?? result.status.fault ?? result.outcome }),
					);
					break;
			}
		} catch (cause) {
			setRemedyNotice(t("welcome.ollama.remedyFailed", { error: errorText(cause) }));
			// Main refuses a fix the current state no longer offers; show that state.
			void refreshStatus(loadVersion.current);
		} finally {
			setRemedyBusy(null);
		}
	};

	const openDownload = () => {
		window.omp.ollama
			.openDownload()
			.catch(cause => setRemedyNotice(t("welcome.ollama.remedyFailed", { error: errorText(cause) })));
	};

	const close = () => {
		dismissed.current = true;
		setAutoOpen(false);
		closeWelcome();
	};

	const handleContinue = async () => {
		if (!continueTag || continuing) return;
		const tag = continueTag;
		setContinuing(true);
		setContinueError(null);
		try {
			await refreshCatalog();
			const model = await tabRpc.setModel("ollama", tag);
			if (!model.success) throw new Error(model.error);
			const role = await tabRpc.setModelRole("default", `ollama/${tag}`);
			if (!role.success) throw new Error(role.error);
		} catch (cause) {
			setContinueError(t("welcome.error.setModel", { tag, error: errorText(cause) }));
			setContinuing(false);
			return;
		}
		try {
			await window.omp.prefs.set(WELCOME_COMPLETED_PREF, new Date().toISOString());
		} catch (cause) {
			// The model handoff already succeeded, and a usable Ollama model keeps the
			// screen closed next launch, so a lost marker is not worth blocking on.
			console.warn("[welcome] could not record completion:", errorText(cause));
		}
		setContinuing(false);
		close();
	};

	const emptyReason = screen === null ? "unreadable" : screen?.emptyReason;

	return (
		<Modal
			ariaLabel={t("welcome.title")}
			bodyClassName="flex min-h-0 flex-1 flex-col p-0"
			chromeless
			onClose={close}
			open={open}
			overlayClassName="omp-onboarding-backdrop"
			panelClassName="omp-welcome-panel"
			size="full"
		>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-8 pb-6">
				<header className="flex items-start gap-4">
					<SaiAtlasLogo height={44} kind="icon" surface="page" />
					<div className="min-w-0">
						<h2 className="font-display text-omp-xl font-semibold text-(--omp-text)">{t("welcome.title")}</h2>
						<p className="mt-1 text-omp-md leading-relaxed text-(--omp-text-secondary)">
							{t("welcome.subtitle")}
						</p>
					</div>
				</header>
				<div className="mt-6">
					<MachineFacts machine={screen === undefined ? undefined : (screen?.machine ?? null)} />
				</div>
				<div className="mt-4 flex flex-col gap-2">
					{statusError !== null && status === null ? (
						<div
							className="omp-ollama-row flex flex-wrap items-center gap-2 px-3 py-2.5 text-omp-md"
							data-state="unreachable"
							role="alert"
						>
							<span className="min-w-0 flex-1">{t("welcome.ollama.remedyFailed", { error: statusError })}</span>
							<Button data-action="check-again" onClick={load} size="sm" variant="ghost">
								{t("welcome.ollama.checkAgain")}
							</Button>
						</div>
					) : (
						<OllamaRow
							busy={remedyBusy}
							onCheckAgain={load}
							onOpenDownload={openDownload}
							onRemedy={id => void runRemedy(id)}
							status={status}
						/>
					)}
					{remedyNotice !== null && (
						<p className="text-omp-sm text-(--omp-warning)" data-notice="remedy" role="alert">
							{remedyNotice}
						</p>
					)}
				</div>
				<h3 className="mt-6 mb-3 text-omp-lg font-semibold text-(--omp-text)">{t("welcome.pickHeading")}</h3>
				{screen === undefined ? (
					<div aria-busy="true" className="omp-welcome-cards">
						{Array.from({ length: SKELETON_CARDS }, (_, index) => (
							<ModelCardSkeleton key={index} />
						))}
					</div>
				) : choices.length > 0 ? (
					<div className="omp-welcome-cards">
						{choices.map(choice => (
							<ModelCard
								choice={choice}
								downloadDisabled={pullRunning}
								key={choice.tag}
								onCancel={cancel}
								onDownload={tag => void download(tag)}
								onUse={pick}
								picked={choice.tag === continueTag}
								progress={pulls[choice.tag] ?? null}
							/>
						))}
					</div>
				) : (
					<p className="text-omp-md text-(--omp-text-secondary)" data-empty={emptyReason ?? "unreadable"}>
						{emptyReason === "too-small" ? t("welcome.empty.tooSmall") : t("welcome.empty.unreadable")}
					</p>
				)}
			</div>
			<footer className="flex shrink-0 flex-col gap-2 border-t border-(--omp-border-muted) px-8 py-4">
				{continueError !== null && (
					<p className="text-omp-sm text-(--omp-error)" data-error="continue" role="alert">
						{continueError}
					</p>
				)}
				<div className="flex items-center gap-3">
					<Button data-action="skip" onClick={close} variant="ghost">
						{t("welcome.skip")}
					</Button>
					<span className="min-w-0 flex-1 truncate text-center text-omp-sm text-(--omp-text-secondary)">
						{continueTag !== null && t("welcome.footNote", { tag: continueTag })}
					</span>
					<Button
						data-action="continue"
						disabled={continueTag === null || continuing}
						loading={continuing}
						onClick={() => void handleContinue()}
						variant="primary"
					>
						{t("welcome.continue")}
					</Button>
				</div>
			</footer>
		</Modal>
	);
}
