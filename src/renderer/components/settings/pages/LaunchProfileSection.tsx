import type { LaunchProfile } from "../../../../shared/launch-profile";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { CodeBlock } from "../../chat/CodeBlock";
import { Button, Input } from "../../common";
import { Section } from "../editors/Section";
import { Toggle } from "../editors/Toggle";
import type { LaunchTextField } from "../settings-window-model";

export interface LaunchProfileSectionProps {
	profile: LaunchProfile;
	/** Uncommitted text-field edits; they win over the saved values. */
	drafts: Partial<Record<LaunchTextField, string>>;
	/** Effective command line of the next sidecar start. */
	preview: string;
	/** Locks the fields while a save or a restart is running. */
	disabled: boolean;
	restarting: boolean;
	restartDisabled: boolean;
	/** A turn is running; the restart waits for it. */
	busy: boolean;
	onDraft: (field: LaunchTextField, value: string) => void;
	onCommitField: (field: LaunchTextField) => void;
	onUpdate: (patch: Partial<LaunchProfile>) => void;
	onRestart: () => void;
}

/**
 * Per-workspace launch options. Only the options an assistant session still
 * honours are offered (`--no-lsp` and `--session-dir`); the launch pins
 * everything that changes what a session loads or approves.
 */
export function LaunchProfileSection({
	profile,
	drafts,
	preview,
	disabled,
	restarting,
	restartDisabled,
	busy,
	onDraft,
	onCommitField,
	onUpdate,
	onRestart,
}: LaunchProfileSectionProps) {
	const t = useT();
	const textField = (field: LaunchTextField, label: string, placeholder: string) => (
		<div>
			<span className="mb-1 block text-xs font-medium text-(--omp-text)">{label}</span>
			<Input
				onBlur={() => onCommitField(field)}
				onChange={event => onDraft(field, event.target.value)}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter") event.currentTarget.blur();
				}}
				placeholder={placeholder}
				spellCheck={false}
				value={drafts[field] ?? profile[field] ?? ""}
			/>
		</div>
	);

	return (
		<Section id="setting-gui-launch" title={t("settings.launch.title")}>
			<fieldset className="space-y-3" disabled={disabled}>
				<Toggle
					checked={profile.noLsp === true}
					description={t("settings.launch.noLspDesc")}
					label={t("settings.launch.noLsp")}
					onChange={value => onUpdate({ noLsp: value })}
				/>
				{textField("sessionDir", t("settings.launch.sessionDir"), t("settings.launch.sessionDirPlaceholder"))}
				<div>
					<span className="mb-1 block text-xs font-medium text-(--omp-text)">{t("settings.launch.preview")}</span>
					<CodeBlock code={preview} language="bash" showCopy={false} showLineNumbers={false} />
				</div>
				<div className="flex items-center gap-3 rounded-md border border-[var(--omp-warning)]/40 px-3 py-2">
					<span className="min-w-0 flex-1 text-omp-sm text-[var(--omp-warning)]">
						{t("settings.launch.restartNote")}
					</span>
					<Button disabled={restartDisabled} onClick={onRestart} size="sm" type="button" variant="secondary">
						{restarting ? t("settings.launch.restarting") : t("settings.launch.restartNow")}
					</Button>
				</div>
				{busy && <p className="text-omp-sm text-(--omp-muted)">{t("settings.launch.busyHint")}</p>}
			</fieldset>
		</Section>
	);
}
