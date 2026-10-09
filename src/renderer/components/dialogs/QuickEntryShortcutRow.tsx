import { Pencil, RotateCcw } from "lucide-react";
import { QUICK_ENTRY_DEFAULT_CHORD } from "../../../shared/hotkeys";
import type { QuickEntryShortcutState } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { formatChord } from "../../lib/keymap";
import { Button } from "../common";

interface QuickEntryShortcutRowProps {
	state: QuickEntryShortcutState;
	busy: boolean;
	onRebind: () => void;
	onToggle: () => void;
	onReset: () => void;
}

/**
 * The quick-entry chord in Keyboard Shortcuts. Main registers it system-wide, so
 * the row reports what main says about it: a refusal, a binding the desktop owns
 * (Wayland portal), a change that waits for a restart, or a grab that only works
 * while the app is focused (XWayland).
 */
export function QuickEntryShortcutRow({ state, busy, onRebind, onToggle, onReset }: QuickEntryShortcutRowProps) {
	const t = useT();
	const chord = formatChord(state.chord);
	const canReset = !state.enabled || state.chord !== QUICK_ENTRY_DEFAULT_CHORD;
	const notes: string[] = [];
	if (state.enabled && state.mode === "portal") notes.push(t("hotkeys.quickEntry.portal", { chord }));
	if (state.restartRequired) notes.push(t("hotkeys.quickEntry.restart"));
	if (state.enabled && state.desktopEntryMissing) notes.push(t("hotkeys.quickEntry.desktopEntryMissing"));
	if (state.enabled && state.xwaylandOnly) notes.push(t("hotkeys.quickEntry.xwayland"));
	return (
		<div className="group px-3 py-2 text-omp-md">
			<div className="flex items-center justify-between gap-4">
				<span className="text-[var(--omp-text)]">{t("hotkeys.row.quickEntry")}</span>
				<span className="flex shrink-0 items-center gap-1">
					<button
						type="button"
						title={t("hotkeys.remap.rebind")}
						aria-label={t("hotkeys.remap.rebind")}
						disabled={busy}
						onClick={onRebind}
						className="hidden h-5 w-5 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)] group-hover:flex"
					>
						<Pencil size={11} />
					</button>
					{canReset && (
						<button
							type="button"
							title={t("hotkeys.remap.reset")}
							aria-label={t("hotkeys.remap.reset")}
							disabled={busy}
							onClick={onReset}
							className="hidden h-5 w-5 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)] group-hover:flex"
						>
							<RotateCcw size={11} />
						</button>
					)}
					<Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>
						{state.enabled ? t("hotkeys.quickEntry.disable") : t("hotkeys.quickEntry.enable")}
					</Button>
					<kbd className="rounded-md border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-2 py-0.5 font-mono text-omp-sm text-[var(--omp-muted)]">
						{state.enabled ? chord : t("hotkeys.quickEntry.off")}
					</kbd>
				</span>
			</div>
			{state.status === "refused" && (
				<div role="alert" className="mt-1 text-omp-sm text-[var(--omp-error)]">
					{t("hotkeys.quickEntry.refused", { chord })}
				</div>
			)}
			{notes.map(note => (
				<div key={note} className="mt-1 text-omp-sm text-[var(--omp-dim)]">
					{note}
				</div>
			))}
		</div>
	);
}
