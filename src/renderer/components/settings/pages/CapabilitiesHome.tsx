/**
 * Capabilities home page: the OMP Capabilities tab in settings that showcases
 * differentiating workflows with discovery cards and direct actions.
 */

import {
	BarChart3,
	Bot,
	BrainCircuit,
	Command,
	Database,
	FolderOpen,
	GitPullRequest,
	Keyboard,
	Network,
	Plug,
	ShieldCheck,
	Sparkles,
	Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { Button } from "../../common";

export type CapabilityTarget =
	| "model"
	| "providers"
	| "agents"
	| "updates"
	| "clear"
	| "sessionInfo"
	| "sessionTree"
	| "handoff"
	| "export"
	| "dump"
	| "fork"
	| "retry"
	| "resend"
	| "btw"
	| "tan"
	| "omfg"
	| "queue"
	| "workspaceDirs"
	| "prCenter"
	| "jobs"
	| "hotkeys"
	| "theme"
	| "settings"
	| "changelog"
	| "copy";

interface CapabilitiesHomeProps {
	ready: boolean;
	ttsrEnabled: boolean;
	advisorEnabled: boolean;
	advisorActive: boolean | undefined;
	memoryBackend: string;
	onConfigureTtsr: () => void;
	onOpenAgents: () => void;
	onConfigureAdvisor: () => void;
	onOpenMemory: () => void;
	onOpenTools: () => void;
	onOpenCommandCenter: () => void;
	onOpenTarget: (target: CapabilityTarget) => void;
}

function CapabilityCard({
	icon,
	title,
	description,
	status,
	statusActive = false,
	featured = false,
	children,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	status?: string;
	statusActive?: boolean;
	featured?: boolean;
	children: ReactNode;
}) {
	return (
		<section
			className={`rounded-xl border bg-transparent p-4 ${
				featured
					? "settings-capability-featured border-[color-mix(in_srgb,var(--omp-accent)_45%,var(--omp-border-muted))]"
					: "border-(--omp-border-muted)"
			}`}
		>
			<div className="flex items-start gap-3">
				<div
					className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center ${featured ? "text-(--omp-accent)" : "text-(--omp-muted)"}`}
				>
					{icon}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-omp-lg font-semibold text-(--omp-text)">{title}</h3>
						{status && (
							<span
								className={`rounded-full border px-1.5 py-0.5 text-omp-xxs font-medium ${
									statusActive
										? "border-[color-mix(in_srgb,var(--omp-success)_35%,transparent)] bg-transparent text-(--omp-success)"
										: "border-(--omp-border-muted) text-(--omp-dim)"
								}`}
							>
								{status}
							</span>
						)}
					</div>
					<p className="mt-1 text-omp-sm leading-relaxed text-(--omp-muted)">{description}</p>
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
		</section>
	);
}
function TargetButton({
	target,
	label,
	onOpen,
	variant = "ghost",
}: {
	target: CapabilityTarget;
	label: string;
	onOpen: (target: CapabilityTarget) => void;
	variant?: "ghost" | "secondary";
}) {
	return (
		<Button onClick={() => onOpen(target)} size="sm" type="button" variant={variant}>
			{label}
		</Button>
	);
}

export function CapabilitiesHome({
	ready,
	ttsrEnabled,
	advisorEnabled,
	advisorActive,
	memoryBackend,
	onConfigureTtsr,
	onOpenAgents,
	onConfigureAdvisor,
	onOpenMemory,
	onOpenTools,
	onOpenCommandCenter,
	onOpenTarget,
}: CapabilitiesHomeProps) {
	const t = useT();
	const stateLabel = (enabled: boolean) =>
		ready
			? t(enabled ? "settings.capabilities.enabled" : "settings.capabilities.disabled")
			: t("settings.capabilities.loading");

	return (
		<div>
			<header className="mb-6 max-w-2xl">
				<div className="mb-2 flex items-center gap-1.5 text-omp-xs font-semibold tracking-[0.14em] text-(--omp-accent) uppercase">
					<Sparkles size={12} />
					{t("settings.capabilities.eyebrow")}
				</div>
				<h2 className="text-xl font-semibold tracking-tight text-(--omp-text)">
					{t("settings.capabilities.title")}
				</h2>
				<p className="mt-2 text-omp-md leading-relaxed text-(--omp-muted)">
					{t("settings.capabilities.description")}
				</p>
			</header>

			<div className="settings-capability-grid">
				<CapabilityCard
					description={t("settings.capabilities.commandCenterDesc")}
					featured
					icon={<Command size={17} />}
					title={t("settings.capabilities.commandCenter")}
				>
					<Button
						data-command-center-entry
						onClick={onOpenCommandCenter}
						size="sm"
						type="button"
						variant="secondary"
					>
						{t("settings.capabilities.openCommandCenter")}
					</Button>
				</CapabilityCard>
				<CapabilityCard
					description={t("settings.capabilities.quickActionsDesc")}
					icon={<Command size={16} />}
					title={t("settings.capabilities.quickActions")}
				>
					<TargetButton label={t("cmd.btw")} onOpen={onOpenTarget} target="btw" variant="secondary" />
					<TargetButton label={t("cmd.tan")} onOpen={onOpenTarget} target="tan" />
					<TargetButton label={t("cmd.omfg")} onOpen={onOpenTarget} target="omfg" />
					<TargetButton label={t("cmd.queue")} onOpen={onOpenTarget} target="queue" />
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.ttsrDesc")}
					featured
					icon={<ShieldCheck size={17} />}
					status={stateLabel(ttsrEnabled)}
					statusActive={ready && ttsrEnabled}
					title={t("settings.capabilities.ttsr")}
				>
					{/* Toggle lives in Context › Rules (schema owns the value); this card
					    is discovery + navigation only. */}
					<Button onClick={onConfigureTtsr} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureRules")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.agentsDesc")}
					icon={<Network size={16} />}
					title={t("settings.capabilities.agents")}
				>
					<Button onClick={onOpenAgents} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.openAgentHub")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.advisorDesc")}
					icon={<BrainCircuit size={16} />}
					status={
						ready && advisorEnabled && advisorActive === false
							? t("settings.capabilities.advisorInactive")
							: stateLabel(advisorEnabled)
					}
					statusActive={ready && advisorEnabled && advisorActive !== false}
					title={t("settings.capabilities.advisor")}
				>
					{/* Toggle lives in Model › Advisor (schema owns the value). */}
					<Button onClick={onConfigureAdvisor} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureAdvisor")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.memoryDesc")}
					icon={<Database size={16} />}
					status={
						ready
							? t("settings.capabilities.memoryBackend", {
									backend: memoryBackend || t("settings.capabilities.unconfigured"),
								})
							: t("settings.capabilities.loading")
					}
					statusActive={ready && memoryBackend !== "" && memoryBackend !== "off"}
					title={t("settings.capabilities.memory")}
				>
					<Button onClick={onOpenMemory} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureMemory")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.toolsDesc")}
					icon={<Wrench size={16} />}
					title={t("settings.capabilities.tools")}
				>
					<Button onClick={onOpenTools} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureTools")}
					</Button>
				</CapabilityCard>
				<CapabilityCard description={t("cmd.model.desc")} icon={<Bot size={16} />} title={t("cmd.model")}>
					<TargetButton label={t("cmd.model")} onOpen={onOpenTarget} target="model" variant="secondary" />
				</CapabilityCard>

				<CapabilityCard description={t("cmd.providers.desc")} icon={<Plug size={16} />} title={t("cmd.providers")}>
					<TargetButton label={t("cmd.providers")} onOpen={onOpenTarget} target="providers" variant="secondary" />
				</CapabilityCard>

				<CapabilityCard description={t("cmd.import.desc")} icon={<FolderOpen size={16} />} title={t("cmd.session")}>
					<TargetButton label={t("cmd.clear")} onOpen={onOpenTarget} target="clear" variant="secondary" />
					<TargetButton label={t("cmd.session")} onOpen={onOpenTarget} target="sessionInfo" />
					<TargetButton label={t("cmd.tree")} onOpen={onOpenTarget} target="sessionTree" />
					<TargetButton label={t("cmd.handoff")} onOpen={onOpenTarget} target="handoff" />
					<TargetButton label={t("cmd.export")} onOpen={onOpenTarget} target="export" />
					<TargetButton label={t("cmd.dump")} onOpen={onOpenTarget} target="dump" />
					<TargetButton label={t("cmd.fork")} onOpen={onOpenTarget} target="fork" />
					<TargetButton label={t("cmd.retry")} onOpen={onOpenTarget} target="retry" />
					<TargetButton label={t("cmd.resend")} onOpen={onOpenTarget} target="resend" />
				</CapabilityCard>

				<CapabilityCard
					description={t("cmd.prCenter.desc")}
					icon={<GitPullRequest size={16} />}
					title={t("cmd.prCenter")}
				>
					<TargetButton label={t("cmd.prCenter")} onOpen={onOpenTarget} target="prCenter" variant="secondary" />
					<TargetButton label={t("cmd.dirs")} onOpen={onOpenTarget} target="workspaceDirs" />
				</CapabilityCard>

				<CapabilityCard description={t("cmd.jobs.desc")} icon={<BarChart3 size={16} />} title={t("cmd.jobs")}>
					<TargetButton label={t("cmd.jobs")} onOpen={onOpenTarget} target="jobs" variant="secondary" />
				</CapabilityCard>

				<CapabilityCard
					description={t("cmd.settings.desc")}
					icon={<ShieldCheck size={16} />}
					title={t("settings.nav.application")}
				>
					<TargetButton label={t("cmd.hotkeys")} onOpen={onOpenTarget} target="hotkeys" variant="secondary" />
					<TargetButton label={t("cmd.theme")} onOpen={onOpenTarget} target="theme" />
					<TargetButton label={t("cmd.settings")} onOpen={onOpenTarget} target="settings" />
					<TargetButton label={t("cmd.changelog")} onOpen={onOpenTarget} target="changelog" />
					<TargetButton label={t("settings.tabs.updates")} onOpen={onOpenTarget} target="updates" />
				</CapabilityCard>

				<CapabilityCard description={t("cmd.copy.desc")} icon={<Keyboard size={16} />} title={t("cmd.copy")}>
					<TargetButton label={t("cmd.copy")} onOpen={onOpenTarget} target="copy" variant="secondary" />
				</CapabilityCard>
			</div>
		</div>
	);
}
