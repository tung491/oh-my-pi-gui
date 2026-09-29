import { Bot, Check, Cpu, FileCode2, FolderOpen, RefreshCw, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ProviderInfo } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { currentKeyboardPlatform, displayShortcut } from "../../lib/keymap";
import { loginProvider } from "../../lib/provider-login";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, Modal, StepList, VifLogo } from "../common";
import { RadioGroup } from "../settings/editors/RadioGroup";
import { WorkspaceDialog } from "./WorkspaceDialog";

const CUSTOM_PROVIDER_EXAMPLE = `providers:
  my-provider:
    api: openai-completions
    baseUrl: https://api.example.com/v1
    apiKey: \${MY_PROVIDER_API_KEY}
    models:
      - id: model-id
        name: My Model
        contextWindow: 128000
        maxTokens: 8192`;

const STEP_KEYS = ["welcome", "provider", "models", "workspace", "ready"] as const;
const PROVIDER_STEP = 1;
const MODELS_STEP = 2;
const LAST_STEP = STEP_KEYS.length - 1;

/** Provider-step choices besides one "sign in" option per OAuth-capable provider. */
const PROVIDERS_OPTION = "providers";
const CUSTOM_OPTION = "custom";
const OAUTH_PREFIX = "oauth:";

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

/** A usable setup needs both a model and a non-disabled credential/config path. */
export function hasUsableModelProvider(
	providers: readonly ProviderInfo[],
	configs: readonly CustomProviderView[],
): boolean {
	if (providers.some(provider => provider.authenticated && !provider.disabled && provider.modelCount > 0)) {
		return true;
	}

	const providerById = new Map(providers.map(provider => [provider.id, provider]));
	return configs.some(config => {
		const provider = providerById.get(config.id);
		return config.auth === "none" && provider !== undefined && !provider.disabled && provider.modelCount > 0;
	});
}

export function FirstRunOnboardingDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarStatus = useSessionStore(state => state.status);
	const cwd = useSessionStore(state => state.cwd);
	const openProviders = useUiStore(state => state.openProviders);
	const openProviderConfig = useUiStore(state => state.openProviderConfig);
	const openModelRoles = useUiStore(state => state.openModelRoles);
	const openModelPicker = useUiStore(state => state.openModelPicker);
	const providersOpen = useUiStore(state => state.providersOpen);
	const providerConfigOpen = useUiStore(state => state.providerConfigOpen);
	const checkedThisLaunch = useRef(false);
	const requestVersion = useRef(0);
	// Skip, Escape, backdrop and Finish all dismiss for the rest of the launch;
	// no readiness check may reopen the wizard after that.
	const dismissed = useRef(false);
	const loginInFlight = useRef(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const shownStep = useRef(0);
	const [open, setOpen] = useState(false);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [knownProviders, setKnownProviders] = useState<ProviderInfo[]>([]);
	const [ready, setReady] = useState(false);
	const [step, setStep] = useState(0);
	const [selection, setSelection] = useState<string>(PROVIDERS_OPTION);
	const [busy, setBusy] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [guiVersion, setGuiVersion] = useState<string | null>(null);

	const checkReadiness = useCallback(
		async (manual: boolean) => {
			if (sidecarStatus !== "ready") {
				setError(t("common.notConnected"));
				return;
			}
			const version = ++requestVersion.current;
			setChecking(true);
			if (manual) setError(null);
			try {
				const [providerResult, configResult] = await Promise.allSettled([
					tabRpc.getProviders(),
					window.omp.models.listProviders(),
				]);
				if (version !== requestVersion.current) return;
				if (providerResult.status === "rejected") throw providerResult.reason;
				if (!providerResult.value.success) throw new Error(providerResult.value.error);

				const data = providerResult.value.data;
				if (
					!data ||
					typeof data !== "object" ||
					!("providers" in data) ||
					!Array.isArray(data.providers) ||
					!data.providers.every(isProviderInfo)
				) {
					throw new Error(t("onboarding.invalidResponse"));
				}
				const providers = data.providers;
				const configs = configResult.status === "fulfilled" ? configResult.value : [];
				setKnownProviders(providers);
				// Deterministic outcomes latch the once-per-launch gate. A thrown
				// error is transient (sidecar/transport) — leave it unlatched so the
				// next ready transition retries instead of abandoning first-run users.
				checkedThisLaunch.current = true;
				if (hasUsableModelProvider(providers, configs)) {
					setReady(true);
					setError(null);
					// Move an open wizard past the provider step; only the user closes it.
					setStep(current => Math.max(current, MODELS_STEP));
					return;
				}
				setReady(false);

				// A slow startup check must not cover a page the user already opened.
				if (!manual && document.querySelector('[role="dialog"]')) return;
				// A check that started before a dismissal must not reopen the wizard.
				if (!dismissed.current) setOpen(true);
				setError(
					configResult.status === "rejected"
						? t("onboarding.configReadFailed")
						: manual
							? t("onboarding.stillMissing")
							: null,
				);
			} catch (cause) {
				if (version !== requestVersion.current || !manual) return;
				setReady(false);
				if (!dismissed.current) setOpen(true);
				setError(t("onboarding.checkFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
			} finally {
				if (version === requestVersion.current) setChecking(false);
			}
		},
		[sidecarStatus, t, tabRpc.getProviders],
	);

	useEffect(() => {
		if (sidecarStatus !== "ready" || checkedThisLaunch.current) return;
		void checkReadiness(false);
	}, [sidecarStatus, checkReadiness]);

	// Finishing setup in Providers & Login or the custom-provider editor happens
	// in a window stacked over the wizard: re-check once when either one closes.
	const overlaysOpen = useRef({ providers: providersOpen, config: providerConfigOpen });
	useEffect(() => {
		const previous = overlaysOpen.current;
		overlaysOpen.current = { providers: providersOpen, config: providerConfigOpen };
		const closed = (previous.providers && !providersOpen) || (previous.config && !providerConfigOpen);
		if (closed && open && !dismissed.current) void checkReadiness(true);
	}, [providersOpen, providerConfigOpen, open, checkReadiness]);

	useEffect(() => {
		if (!open || guiVersion !== null) return;
		let cancelled = false;
		try {
			window.omp.updater
				.version()
				.then(value => {
					if (!cancelled && typeof value === "string" && value.length > 0) setGuiVersion(value);
				})
				// The version line is decorative: without an answer it stays empty.
				.catch(() => {});
		} catch {
			// A preload without the updater bridge shows no version line.
		}
		return () => {
			cancelled = true;
		};
	}, [open, guiVersion]);

	// Land on the new step's heading so it is announced, and recover focus that a
	// control dropped by disabling itself. Never pull focus out of a dialog that
	// is stacked above the wizard.
	useEffect(() => {
		if (!open || busy || checking) return;
		const stepChanged = shownStep.current !== step;
		shownStep.current = step;
		const heading = headingRef.current;
		if (!heading) return;
		const active = document.activeElement;
		const dropped = !active || active === document.body;
		if (dropped || (stepChanged && heading.closest('[role="dialog"]')?.contains(active))) heading.focus();
	}, [open, step, busy, checking]);

	const dismiss = () => {
		dismissed.current = true;
		setOpen(false);
	};

	const oauthProviders = knownProviders.filter(
		provider => provider.loginAvailable && !provider.disabled && !provider.authenticated,
	);
	const providerOptions = [
		...oauthProviders.map(provider => ({
			value: `${OAUTH_PREFIX}${provider.id}`,
			label: t("onboarding.wizard.oauth", { provider: provider.name }),
			badge: <Badge>{t("providers.badge.oauth")}</Badge>,
		})),
		{
			value: PROVIDERS_OPTION,
			label: t("onboarding.provider.action"),
			badge: <Badge>{t("onboarding.badge.apiKey")}</Badge>,
		},
		{
			value: CUSTOM_OPTION,
			label: t("onboarding.custom.title"),
			description: t("onboarding.custom.description"),
			badge: <Badge>{t("onboarding.badge.advanced")}</Badge>,
		},
	];
	// A provider that signed in elsewhere drops out of the list; fall back to the
	// Providers window instead of pointing at an option that no longer renders.
	const choice = providerOptions.some(option => option.value === selection) ? selection : PROVIDERS_OPTION;

	const handleContinue = async () => {
		if (loginInFlight.current) return;
		if (step === LAST_STEP) {
			dismiss();
			return;
		}
		if (step !== PROVIDER_STEP) {
			setStep(step + 1);
			return;
		}
		if (choice === PROVIDERS_OPTION) {
			openProviders();
			return;
		}
		if (choice === CUSTOM_OPTION) {
			openProviderConfig();
			return;
		}
		const target = oauthProviders.find(provider => `${OAUTH_PREFIX}${provider.id}` === choice);
		if (!target) return;
		loginInFlight.current = true;
		setBusy(true);
		try {
			await loginProvider(tabRpc, target.id, target.name, t, () => checkReadiness(true));
		} finally {
			loginInFlight.current = false;
			setBusy(false);
		}
	};

	const heading = (text: string) => (
		<h2 className="mt-2 font-display text-omp-xl font-semibold text-(--omp-text)" ref={headingRef} tabIndex={-1}>
			{text}
		</h2>
	);
	const description = (text: string) => <p className="mt-2 text-omp-md leading-relaxed text-(--omp-muted)">{text}</p>;
	const warning = (text: string) => (
		<div className="mt-4 rounded-lg border border-[color-mix(in_srgb,var(--omp-warning)_40%,transparent)] px-3 py-2 text-omp-sm text-(--omp-warning)">
			{text}
		</div>
	);

	let content: ReactNode;
	if (step === 0) {
		content = (
			<>
				{heading(t("onboarding.heading"))}
				{description(t("onboarding.description"))}
				<div className="mt-4">
					<Badge variant="warning">{t("onboarding.setupRequired")}</Badge>
				</div>
			</>
		);
	} else if (step === PROVIDER_STEP) {
		content = (
			<>
				{heading(t("onboarding.provider.title"))}
				{description(t("onboarding.provider.description"))}
				<p className="mt-1 text-omp-sm leading-relaxed text-(--omp-dim)">
					{t("onboarding.provider.location", { chord: displayShortcut("⌘K", currentKeyboardPlatform()) })}
				</p>
				<div className="mt-5">
					<RadioGroup
						label={t("onboarding.provider.title")}
						name="onboarding-provider"
						onChange={setSelection}
						options={providerOptions}
						value={choice}
						variant="card"
					/>
				</div>
				{choice === CUSTOM_OPTION && (
					<details className="mt-3 rounded-xl border border-(--omp-border-muted) p-4">
						<summary className="cursor-pointer text-omp-lg font-semibold text-(--omp-text)">
							{t("onboarding.parameters.title")}
						</summary>
						<p className="mb-3 text-omp-sm leading-relaxed text-(--omp-dim)">
							{t("onboarding.parameters.description")}
						</p>
						<div className="grid gap-x-5 gap-y-2 text-omp-sm md:grid-cols-2">
							<div>
								<code className="font-mono text-(--omp-text)">id</code>
								<span className="ml-2 text-(--omp-muted)">{t("onboarding.parameters.id")}</span>
							</div>
							<div>
								<code className="font-mono text-(--omp-text)">api</code>
								<span className="ml-2 text-(--omp-muted)">{t("onboarding.parameters.api")}</span>
							</div>
							<div>
								<code className="font-mono text-(--omp-text)">baseUrl</code>
								<span className="ml-2 text-(--omp-muted)">{t("onboarding.parameters.baseUrl")}</span>
							</div>
							<div>
								<code className="font-mono text-(--omp-text)">apiKey / auth</code>
								<span className="ml-2 text-(--omp-muted)">{t("onboarding.parameters.auth")}</span>
							</div>
							<div>
								<code className="font-mono text-(--omp-text)">models[].id</code>
								<span className="ml-2 text-(--omp-muted)">{t("onboarding.parameters.modelId")}</span>
							</div>
							<div>
								<code className="font-mono text-(--omp-text)">contextWindow / maxTokens</code>
								<span className="ml-2 text-(--omp-muted)">{t("onboarding.parameters.limits")}</span>
							</div>
						</div>
						<div className="mt-4">
							<div className="mb-1.5 text-omp-sm font-medium text-(--omp-text)">{t("onboarding.example")}</div>
							<pre className="overflow-x-auto rounded-lg border border-(--omp-border-muted) bg-(--omp-code-bg) p-3 font-mono text-omp-xs leading-[1.55] text-(--omp-muted)">
								{CUSTOM_PROVIDER_EXAMPLE}
							</pre>
						</div>
					</details>
				)}
				{error && warning(error)}
				<div className="mt-4 flex flex-wrap gap-2">
					<Button icon={<Bot size={14} />} onClick={openProviders} size="sm">
						{t("onboarding.provider.action")}
					</Button>
					<Button icon={<FileCode2 size={14} />} onClick={() => openProviderConfig()} size="sm">
						{t("onboarding.custom.action")}
					</Button>
					<Button
						disabled={sidecarStatus !== "ready"}
						icon={<RefreshCw size={13} />}
						loading={checking}
						onClick={() => void checkReadiness(true)}
						size="sm"
						title={sidecarStatus !== "ready" ? t("common.notConnected") : undefined}
						variant="ghost"
					>
						{t("onboarding.recheck")}
					</Button>
				</div>
			</>
		);
	} else if (step === MODELS_STEP) {
		content = (
			<>
				{heading(t("onboarding.wizard.steps.models"))}
				{description(t("onboarding.models.description"))}
				<div className="mt-5 flex flex-wrap gap-2">
					<Button icon={<SlidersHorizontal size={14} />} onClick={openModelRoles}>
						{t("onboarding.models.assignRoles")}
					</Button>
					<Button icon={<Cpu size={14} />} onClick={openModelPicker}>
						{t("input.model")}
					</Button>
				</div>
			</>
		);
	} else if (step < LAST_STEP) {
		content = (
			<>
				{heading(t("onboarding.wizard.steps.workspace"))}
				{description(t("onboarding.workspace.description"))}
				{cwd && (
					<p
						className="mt-4 truncate rounded-lg border border-(--omp-border-muted) px-3 py-2 font-mono text-omp-sm text-(--omp-text)"
						title={cwd}
					>
						{cwd}
					</p>
				)}
				<div className="mt-4">
					<Button icon={<FolderOpen size={14} />} onClick={() => setWorkspaceOpen(true)}>
						{t("onboarding.workspace.choose")}
					</Button>
				</div>
			</>
		);
	} else {
		content = (
			<>
				{heading(t("onboarding.ready.title"))}
				{ready ? (
					<p className="mt-4 flex items-center gap-2 text-omp-md text-(--omp-success)">
						<Check aria-hidden="true" size={16} />
						{t("onboarding.ready.provider")}
					</p>
				) : (
					warning(error ?? t("onboarding.stillMissing"))
				)}
			</>
		);
	}

	return (
		<>
			<Modal
				ariaLabel={t("onboarding.title")}
				backdrop={
					<>
						<VifLogo className="absolute top-6 left-8 text-(--omp-sidebar-text)" height={22} />
						<span className="absolute bottom-6 left-1/2 -translate-x-1/2 font-mono text-omp-xs text-(--omp-sidebar-muted)">
							{guiVersion && t("onboarding.wizard.version", { version: guiVersion })}
						</span>
					</>
				}
				bodyClassName="flex p-0"
				chromeless
				onClose={dismiss}
				open={open}
				overlayClassName="omp-onboarding-backdrop"
				panelClassName="omp-onboarding-panel"
			>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div className="flex min-h-0 flex-1">
						<div className="flex w-[232px] shrink-0 flex-col bg-(--omp-btn-primary-bg) text-(--omp-btn-primary-text)">
							<div className="omp-eyebrow px-4 pt-6 pb-2 text-(--omp-btn-primary-text)">
								{t("onboarding.wizard.eyebrow")}
							</div>
							<StepList
								ariaLabel={t("onboarding.wizard.stepsAria")}
								className="px-2"
								current={step}
								steps={STEP_KEYS.map(key => t(`onboarding.wizard.steps.${key}`))}
							/>
							<p className="mt-auto p-4 font-mono text-omp-xs leading-snug">{t("onboarding.wizard.footnote")}</p>
						</div>
						<div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-12 pt-9 pb-5">
							<div className="omp-eyebrow text-(--omp-accent)">
								{t("onboarding.wizard.stepOf", { current: step + 1, total: STEP_KEYS.length })}
							</div>
							{content}
						</div>
					</div>
					<div
						className="flex h-[68px] shrink-0 items-center gap-3 border-t border-(--omp-border-muted) bg-(--omp-bg-secondary) px-6" // surface-ok: wizard footer
					>
						<Button onClick={dismiss} variant="ghost">
							{t("onboarding.later")}
						</Button>
						<span className="flex-1" />
						<Button disabled={step === 0} onClick={() => setStep(step - 1)} variant="secondary">
							{t("onboarding.wizard.back")}
						</Button>
						<Button
							disabled={busy || checking}
							loading={busy}
							onClick={() => void handleContinue()}
							variant="primary"
						>
							{step === LAST_STEP ? t("onboarding.wizard.finish") : t("onboarding.wizard.continue")}
						</Button>
					</div>
				</div>
			</Modal>
			{workspaceOpen && <WorkspaceDialog onClose={() => setWorkspaceOpen(false)} open />}
		</>
	);
}
