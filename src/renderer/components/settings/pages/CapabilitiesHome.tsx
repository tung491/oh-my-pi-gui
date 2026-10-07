/**
 * Settings landing page: introduces Sai ATLAS and links to what an assistant
 * session offers — the action search, the model, Ollama, this conversation and
 * the app itself. Cards are discovery and navigation only; values live in their
 * own pages.
 */

import { Bot, Command, MessageSquare, Plug, Settings2, Sparkles } from "lucide-react";
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
	| "export"
	| "retry"
	| "resend"
	| "hotkeys"
	| "theme"
	| "settings"
	| "changelog"
	| "copy";

interface CapabilitiesHomeProps {
	onOpenCommandCenter: () => void;
	onOpenTarget: (target: CapabilityTarget) => void;
}

function CapabilityCard({
	icon,
	title,
	description,
	featured = false,
	children,
}: {
	icon: ReactNode;
	title: string;
	description: string;
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
					<h3 className="text-omp-lg font-semibold text-(--omp-text)">{title}</h3>
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

export function CapabilitiesHome({ onOpenCommandCenter, onOpenTarget }: CapabilitiesHomeProps) {
	const t = useT();

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

				<CapabilityCard description={t("cmd.model.desc")} icon={<Bot size={16} />} title={t("cmd.model")}>
					<TargetButton label={t("cmd.model")} onOpen={onOpenTarget} target="model" variant="secondary" />
				</CapabilityCard>

				<CapabilityCard description={t("cmd.providers.desc")} icon={<Plug size={16} />} title={t("cmd.providers")}>
					<TargetButton label={t("cmd.providers")} onOpen={onOpenTarget} target="providers" variant="secondary" />
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.conversationDesc")}
					icon={<MessageSquare size={16} />}
					title={t("settings.capabilities.conversation")}
				>
					<TargetButton label={t("cmd.retry")} onOpen={onOpenTarget} target="retry" variant="secondary" />
					<TargetButton label={t("cmd.resend")} onOpen={onOpenTarget} target="resend" />
					<TargetButton label={t("cmd.copy")} onOpen={onOpenTarget} target="copy" />
					<TargetButton label={t("cmd.export")} onOpen={onOpenTarget} target="export" />
					<TargetButton label={t("cmd.session")} onOpen={onOpenTarget} target="sessionInfo" />
					<TargetButton label={t("cmd.clear")} onOpen={onOpenTarget} target="clear" />
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.applicationDesc")}
					icon={<Settings2 size={16} />}
					title={t("settings.nav.application")}
				>
					<TargetButton label={t("cmd.settings")} onOpen={onOpenTarget} target="settings" variant="secondary" />
					<TargetButton label={t("cmd.theme")} onOpen={onOpenTarget} target="theme" />
					<TargetButton label={t("cmd.hotkeys")} onOpen={onOpenTarget} target="hotkeys" />
					<TargetButton label={t("cmd.changelog")} onOpen={onOpenTarget} target="changelog" />
					<TargetButton label={t("settings.tabs.updates")} onOpen={onOpenTarget} target="updates" />
				</CapabilityCard>
			</div>
		</div>
	);
}
