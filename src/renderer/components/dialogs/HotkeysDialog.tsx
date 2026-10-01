import { Check, Pencil, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { QUICK_ENTRY_CHORD_ID } from "../../../shared/hotkeys";
import type {
	QuickEntryShortcutResult,
	QuickEntryShortcutState,
	QuickEntryShortcutUpdate,
} from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import {
	chordFromEvent,
	chordOwner,
	currentKeyboardPlatform,
	detectConflicts,
	formatChord,
	type HotkeyGroupId,
	KEYMAP_ACTION_BY_ID,
	KEYMAP_ACTIONS,
	type KeyboardPlatform,
	type KeymapActionId,
	keymapActionsForGroup,
	platformDefaults,
	quickEntryConflicts,
	type ReservedChord,
	type ReservedChordGroup,
	reservedChordsForGroup,
} from "../../lib/keymap";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal } from "../common";
import { QuickEntryShortcutRow } from "./QuickEntryShortcutRow";

interface StaticHotkeyRow {
	keys: string;
	labelKey: string;
}

/** Remappable row: label + current chords resolve from the keymap action table. */
interface RemapHotkeyRow {
	actionId: KeymapActionId;
}

/** The system-wide quick-entry chord, which main owns and the dialog rebinds over IPC. */
interface QuickEntryHotkeyRow {
	quickEntry: true;
}

type HotkeyRow = StaticHotkeyRow | RemapHotkeyRow | QuickEntryHotkeyRow;

function isRemapRow(row: HotkeyRow): row is RemapHotkeyRow {
	return "actionId" in row;
}

function isQuickEntryRow(row: HotkeyRow): row is QuickEntryHotkeyRow {
	return "quickEntry" in row;
}

interface HotkeyGroup {
	titleKey: string;
	rows: HotkeyRow[];
}

/** Remappable rows for a group, straight from the registry. */
function remapRows(group: HotkeyGroupId): HotkeyRow[] {
	return keymapActionsForGroup(group).map(action => ({ actionId: action.id }));
}

/** Non-remappable rows for an owner class (composer keys, native chords). */
function reservedRows(group: ReservedChordGroup, platform: KeyboardPlatform): HotkeyRow[] {
	return reservedChordsForGroup(group, platform).map(entry => ({ keys: entry.chord, labelKey: entry.labelKey }));
}

// GUI shortcut reference (plan/17 §6.2): the data-driven replacement for the
// TUI's static /hotkeys markdown. Remappable rows come from lib/keymap.ts's
// action table and non-remappable rows from its reserved-chord table — so an
// action can exist only with a row here, and the same chords the recorder
// conflict-checks against are the ones on display. Unmodified keys (Enter, @,
// /) and the shift-only ⇧Tab / Escape globals stay static; terminal-only TUI
// rows (suspend, display reset, $EDITOR) are deliberately absent.
function hotkeyGroups(platform: KeyboardPlatform, withQuickEntry: boolean): HotkeyGroup[] {
	return [
		{
			titleKey: "hotkeys.group.input",
			rows: [
				{ keys: "Enter", labelKey: "hotkeys.row.send" },
				{ keys: "⇧Enter", labelKey: "hotkeys.row.newline" },
				{ keys: "⌃Enter", labelKey: "hotkeys.row.followUpSend" },
				{ keys: "-> / =>", labelKey: "hotkeys.row.queueShorthand" },
				{ keys: "!", labelKey: "hotkeys.row.bashMode" },
				{ keys: "$", labelKey: "hotkeys.row.pythonMode" },
				{ keys: "@", labelKey: "hotkeys.row.mention" },
				{ keys: "/", labelKey: "hotkeys.row.commands" },
				{ keys: "↑ / ↓", labelKey: "hotkeys.row.historyNav" },
				...reservedRows("input", platform),
			],
		},
		{
			titleKey: "hotkeys.group.generation",
			rows: [
				{ keys: "Esc", labelKey: "hotkeys.row.abort" },
				{ keys: "⇧Tab", labelKey: "hotkeys.row.thinkingCycle" },
				...remapRows("generation"),
			],
		},
		{ titleKey: "hotkeys.group.view", rows: remapRows("view") },
		{ titleKey: "hotkeys.group.session", rows: remapRows("session") },
		{
			titleKey: "hotkeys.group.native",
			rows: [...(withQuickEntry ? [{ quickEntry: true as const }] : []), ...reservedRows("native", platform)],
		},
	];
}

interface ResolvedRow {
	label: string;
	keys: string;
	actionId: KeymapActionId | null;
	quickEntry: boolean;
}

type CaptureTarget = { kind: "action"; actionId: KeymapActionId } | { kind: "quickEntry" };

interface CaptureState {
	target: CaptureTarget;
	chord: string | null;
}

interface CaptureConflict {
	/** "error" blocks the save. */
	kind: "error" | "warning";
	label: string;
}

const QUICK_ENTRY_REFUSAL_KEYS: Record<Extract<QuickEntryShortcutResult, { ok: false }>["reason"], string> = {
	invalid: "hotkeys.quickEntry.invalid",
	system: "hotkeys.quickEntry.systemChord",
	reserved: "hotkeys.quickEntry.conflictGlobal",
	refused: "hotkeys.quickEntry.refused",
};

/** The display name of whoever holds a chord id. */
function ownerLabel(id: string, t: (key: string) => string): string {
	const owner = chordOwner(id);
	return owner ? t(owner.labelKey) : id;
}

/** Searchable shortcut reference panel with per-row keybinding remap (B3). */
export function HotkeysDialog({ open }: { open: boolean }) {
	const keyboardPlatform = currentKeyboardPlatform();
	const t = useT();
	const close = useUiStore(s => s.closeHotkeys);
	const overrides = useUiStore(s => s.keymapOverrides);
	const setKeymapOverride = useUiStore(s => s.setKeymapOverride);
	const resetKeymapOverrides = useUiStore(s => s.resetKeymapOverrides);
	const [query, setQuery] = useState("");
	const [capture, setCapture] = useState<CaptureState | null>(null);
	const [confirmingResetAll, setConfirmingResetAll] = useState(false);
	// Null until main answers, and for good where the bridge has no quick entry.
	const [quickEntry, setQuickEntry] = useState<QuickEntryShortcutState | null>(null);
	const [quickEntryBusy, setQuickEntryBusy] = useState(false);

	// Stays mounted through its exit animation, so every open starts from a clean
	// filter rather than the previous visit's search, capture or confirm state.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setCapture(null);
		setConfirmingResetAll(false);
		let live = true;
		void window.omp?.quickEntry?.getShortcut().then(state => {
			if (live) setQuickEntry(state);
		});
		return () => {
			live = false;
		};
	}, [open]);

	// A native global shortcut would fire on the very chord being recorded, so
	// main suspends handling while any recorder in this window is capturing.
	const capturing = capture !== null;
	useEffect(() => {
		if (!capturing) return;
		window.omp?.quickEntry?.suspendShortcuts(true);
		return () => window.omp?.quickEntry?.suspendShortcuts(false);
	}, [capturing]);

	// Capture mode: swallow every key at window-capture phase so nothing leaks
	// to App's global handler (window bubble) or the modal's own Escape-close
	// (document capture — later phase than window capture). Esc cancels.
	useEffect(() => {
		if (!capture) return;
		const onCaptureKey = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				setCapture(null);
				return;
			}
			const chord = chordFromEvent(event);
			if (chord) setCapture(current => (current ? { ...current, chord } : current));
		};
		window.addEventListener("keydown", onCaptureKey, true);
		return () => window.removeEventListener("keydown", onCaptureKey, true);
	}, [capture]);

	const captureLabel = capture
		? capture.target.kind === "action"
			? t(KEYMAP_ACTION_BY_ID[capture.target.actionId].labelKey)
			: t("hotkeys.row.quickEntry")
		: null;

	// Live conflict display for the captured chord: a native owner or a second
	// user binding blocks the save, a shadowed default or the composer's own key
	// only warns (the user binding wins the slot outside those contexts). The
	// quick-entry chord is held system-wide, so a keymap binding on it is an
	// error, and quick entry itself warns about each chord it would take over.
	const captureConflict: CaptureConflict | null = useMemo(() => {
		if (!capture?.chord) return null;
		if (capture.target.kind === "quickEntry") {
			const conflict = quickEntryConflicts(capture.chord, overrides, keyboardPlatform);
			if (!conflict) return null;
			const params = { action: ownerLabel(conflict.ownerId, t) };
			return {
				kind: conflict.kind,
				label:
					conflict.kind === "error"
						? t("hotkeys.quickEntry.conflictGlobal", params)
						: t("hotkeys.quickEntry.takesOver", params),
			};
		}
		const actionId = capture.target.actionId;
		const candidate = { ...overrides, [actionId]: [capture.chord] };
		const heldByQuickEntry: ReservedChord[] = quickEntry?.enabled
			? [
					{
						id: QUICK_ENTRY_CHORD_ID,
						labelKey: "hotkeys.row.quickEntry",
						chord: quickEntry.chord,
						hotkeyGroup: "native",
					},
				]
			: [];
		const conflict = detectConflicts(KEYMAP_ACTIONS, candidate, keyboardPlatform, heldByQuickEntry).find(
			entry => entry.chord === capture.chord,
		);
		if (!conflict) return null;
		const otherId = conflict.actionIds.find(id => id !== actionId);
		const other = otherId ? chordOwner(otherId) : undefined;
		const params = { action: otherId ? ownerLabel(otherId, t) : "" };
		if (other && other.holds !== "action") {
			return {
				kind: conflict.kind,
				label: t(other.holds === "native" ? "hotkeys.remap.conflictNative" : "hotkeys.remap.conflictInput", params),
			};
		}
		return {
			kind: conflict.kind,
			label:
				conflict.kind === "error"
					? t("hotkeys.remap.conflictUser", params)
					: t("hotkeys.remap.conflictShadow", params),
		};
	}, [capture, overrides, keyboardPlatform, quickEntry, t]);

	const groups = useMemo(() => {
		const resolve = (row: HotkeyRow): ResolvedRow => {
			if (isQuickEntryRow(row)) {
				return {
					label: t("hotkeys.row.quickEntry"),
					keys: quickEntry?.enabled
						? formatChord(quickEntry.chord, keyboardPlatform)
						: t("hotkeys.quickEntry.off"),
					actionId: null,
					quickEntry: true,
				};
			}
			if (isRemapRow(row)) {
				const action = KEYMAP_ACTION_BY_ID[row.actionId];
				const chords = overrides[action.id] ?? platformDefaults(action, keyboardPlatform);
				return {
					label: t(action.labelKey),
					keys: chords.length > 0 ? formatChord(chords.join(" / "), keyboardPlatform) : t("hotkeys.unbound"),
					actionId: row.actionId,
					quickEntry: false,
				};
			}
			return {
				label: t(row.labelKey),
				keys: formatChord(row.keys, keyboardPlatform),
				actionId: null,
				quickEntry: false,
			};
		};
		const q = query.trim().toLowerCase();
		return hotkeyGroups(keyboardPlatform, quickEntry !== null)
			.map(group => ({
				...group,
				rows: group.rows
					.map(resolve)
					.filter(row => !q || row.label.toLowerCase().includes(q) || row.keys.toLowerCase().includes(q)),
			}))
			.filter(group => group.rows.length > 0);
	}, [query, t, overrides, keyboardPlatform, quickEntry]);

	/** Main validates and applies the change; the row shows whatever state it answers with. */
	const updateQuickEntry = async (update: QuickEntryShortcutUpdate, savedChord?: string) => {
		const api = window.omp?.quickEntry;
		if (!api) return;
		setQuickEntryBusy(true);
		try {
			const result = await api.setShortcut(update);
			setQuickEntry(result.state);
			if (result.ok) {
				if (savedChord) {
					toast({
						variant: "success",
						message: t("hotkeys.remap.saved", {
							action: t("hotkeys.row.quickEntry"),
							chord: formatChord(result.state.chord, keyboardPlatform),
						}),
					});
				}
				return;
			}
			const chord = savedChord ?? result.state.chord;
			const chordLabel = formatChord(chord, keyboardPlatform);
			const owner = quickEntryConflicts(chord, overrides, keyboardPlatform);
			toast({
				variant: "error",
				message: t(QUICK_ENTRY_REFUSAL_KEYS[result.reason], {
					chord: chordLabel,
					action: owner ? ownerLabel(owner.ownerId, t) : chordLabel,
				}),
			});
		} catch (error) {
			toast({ variant: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setQuickEntryBusy(false);
		}
	};

	// Main ends this window's shortcut suspension on any change, so a capture
	// still open here would go on unprotected: end it first.
	const changeQuickEntry = (update: QuickEntryShortcutUpdate) => {
		setCapture(null);
		void updateQuickEntry(update);
	};

	const saveCapture = () => {
		if (!capture?.chord || !captureLabel || captureConflict?.kind === "error") return;
		const { target, chord } = capture;
		setCapture(null);
		if (target.kind === "quickEntry") {
			// Main cannot register while handling is suspended, so release it now
			// rather than when the capture effect cleans up after the next render.
			window.omp?.quickEntry?.suspendShortcuts(false);
			void updateQuickEntry({ chord }, chord);
			return;
		}
		setKeymapOverride(target.actionId, [chord]);
		toast({
			variant: "success",
			message: t("hotkeys.remap.saved", { action: captureLabel, chord: formatChord(chord, keyboardPlatform) }),
		});
	};

	const resetRow = (actionId: KeymapActionId) => {
		setKeymapOverride(actionId, []);
		toast({
			variant: "success",
			message: t("hotkeys.remap.resetDone", { action: t(KEYMAP_ACTION_BY_ID[actionId].labelKey) }),
		});
	};

	const confirmResetAll = () => {
		resetKeymapOverrides();
		setConfirmingResetAll(false);
		setCapture(null);
		toast({ variant: "success", message: t("hotkeys.remap.resetAllDone") });
	};

	return (
		<Modal onClose={close} open={open} title={t("hotkeys.title")}>
			<div className="mb-3 flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<Input
						value={query}
						onChange={event => setQuery(event.target.value)}
						placeholder={t("hotkeys.search")}
					/>
				</div>
				{confirmingResetAll ? (
					// Inline ✓/✕ confirm (0.3.0 convention): the confirm sits exactly
					// where "reset all" was; ✕ or clicking elsewhere cancels.
					<span className="flex shrink-0 items-center gap-0.5">
						<button
							type="button"
							title={t("common.confirm")}
							aria-label={t("common.confirm")}
							onClick={confirmResetAll}
							className="flex h-6 w-6 items-center justify-center rounded bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)] hover:brightness-110"
						>
							<Check size={12} strokeWidth={3} />
						</button>
						<button
							type="button"
							title={t("common.cancel")}
							aria-label={t("common.cancel")}
							onClick={() => setConfirmingResetAll(false)}
							className="flex h-6 w-6 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
						>
							<X size={12} strokeWidth={3} />
						</button>
					</span>
				) : (
					<Button size="sm" variant="ghost" onClick={() => setConfirmingResetAll(true)}>
						{t("hotkeys.remap.resetAll")}
					</Button>
				)}
			</div>

			{capture && captureLabel && (
				<div className="mb-3 rounded-lg border border-[var(--omp-border)] px-3 py-2">
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-omp-md text-[var(--omp-text)]">
							{t("hotkeys.remap.rebinding", { action: captureLabel })}
						</span>
						<kbd className="shrink-0 rounded-md border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-2 py-0.5 font-mono text-omp-sm text-[var(--omp-muted)]">
							{capture.chord ? formatChord(capture.chord, keyboardPlatform) : t("hotkeys.remap.pressChord")}
						</kbd>
						<Button
							size="sm"
							variant="primary"
							disabled={!capture.chord || captureConflict?.kind === "error"}
							onClick={saveCapture}
						>
							{t("common.save")}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setCapture(null)}>
							{t("common.cancel")}
						</Button>
					</div>
					<div className="mt-1 text-omp-sm text-[var(--omp-dim)]">{t("hotkeys.remap.captureHint")}</div>
					{captureConflict && (
						<div
							className={`mt-1 text-omp-sm ${
								captureConflict.kind === "error" ? "text-[var(--omp-error)]" : "text-[var(--omp-warning)]"
							}`}
						>
							{captureConflict.label}
						</div>
					)}
				</div>
			)}

			{groups.length === 0 && (
				<div className="py-6 text-center text-omp-md text-[var(--omp-dim)]">{t("hotkeys.empty")}</div>
			)}
			{groups.map(group => (
				<div key={group.titleKey} className="mb-4 last:mb-0">
					<div className="mb-1.5 text-omp-sm font-semibold uppercase tracking-wide text-[var(--omp-dim)]">
						{t(group.titleKey)}
					</div>
					<div className="overflow-hidden rounded-lg border border-[var(--omp-border-muted)]">
						{group.rows.map(row => {
							if (row.quickEntry && quickEntry) {
								return (
									<QuickEntryShortcutRow
										key="quickEntry"
										state={quickEntry}
										platform={keyboardPlatform}
										busy={quickEntryBusy}
										onRebind={() => setCapture({ target: { kind: "quickEntry" }, chord: null })}
										onToggle={() => changeQuickEntry({ enabled: !quickEntry.enabled })}
										onReset={() => changeQuickEntry({ reset: true })}
									/>
								);
							}
							const actionId = row.actionId;
							const hasOverride = actionId ? overrides[actionId] !== undefined : false;
							return (
								<div
									key={actionId ?? row.label}
									className="group flex items-center justify-between gap-4 px-3 py-2 text-omp-md"
								>
									<span className="text-[var(--omp-text)]">{row.label}</span>
									<span className="flex shrink-0 items-center gap-1">
										{actionId && (
											<>
												<button
													type="button"
													title={t("hotkeys.remap.rebind")}
													aria-label={t("hotkeys.remap.rebind")}
													onClick={() => setCapture({ target: { kind: "action", actionId }, chord: null })}
													className="hidden h-5 w-5 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)] group-hover:flex"
												>
													<Pencil size={11} />
												</button>
												{hasOverride && (
													<button
														type="button"
														title={t("hotkeys.remap.reset")}
														aria-label={t("hotkeys.remap.reset")}
														onClick={() => resetRow(actionId)}
														className="hidden h-5 w-5 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)] group-hover:flex"
													>
														<RotateCcw size={11} />
													</button>
												)}
											</>
										)}
										<kbd className="rounded-md border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-2 py-0.5 font-mono text-omp-sm text-[var(--omp-muted)]">
											{row.keys}
										</kbd>
									</span>
								</div>
							);
						})}
					</div>
				</div>
			))}
		</Modal>
	);
}
