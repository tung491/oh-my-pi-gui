import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
/**
 * Cmd+K command palette: fuzzy-searches the declarative command registry
 * and executes typed UI affordances (RPC actions, toggles, pickers, windows,
 * submenus, prompts) instead of injecting "/command" text into the composer.
 */

import { Check, ChevronRight, CornerDownLeft, History, Search, Slash, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailableCommand } from "../../../shared/rpc-types";
import { hydrateSession, hydrateTabSession } from "../../hooks/use-rpc-events";
import { newSessionNow } from "../../hooks/use-session-switch";
import {
	buildCommandMenu,
	type CommandAffordance,
	type CommandMenuItem,
	commandArgPrefill,
	cycleAllowedModel,
	forkSessionFromGui,
	groupByCategory,
	prefillComposer,
} from "../../lib/command-registry";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { currentKeyboardPlatform, displayShortcut } from "../../lib/keymap";
import { retryLastTurn as retryLastTurnShared } from "../../lib/messages";
import { writePersisted } from "../../lib/persisted-storage";
import { openHandoffDialog } from "../../stores/fork-handoff";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useActiveTabKind } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Kbd, Spinner } from "../common";
import { isTopmostDialog, registerDialogLayer } from "../common/dialog-layer";

const RECENT_KEY = "omp.palette.recent";
const RECENT_LIMIT = 5;

function sidecarBlocked(item: CommandMenuItem, ready: boolean): boolean {
	if (ready) return false;
	if (item.name === "new-tab" || item.name === "new-chat-tab" || item.name === "close" || item.name === "quit") {
		return false;
	}
	return item.affordance.kind === "action" || item.affordance.kind === "toggle" || item.affordance.kind === "prompt";
}

function loadRecent(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		return raw ? (JSON.parse(raw) as string[]) : [];
	} catch {
		return [];
	}
}

function saveRecent(names: string[]) {
	try {
		writePersisted(RECENT_KEY, JSON.stringify(names.slice(0, RECENT_LIMIT)));
	} catch {
		// Storage unavailable — recents are best-effort.
	}
}

/** Subsequence fuzzy score; null = no match. Earlier + denser wins. */
function fuzzyScore(query: string, target: string): number | null {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	if (q.length === 0) return 0;
	let qi = 0;
	let score = 0;
	let last = -2;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += ti === last + 1 ? 2 : 1;
			last = ti;
			qi++;
		}
	}
	return qi === q.length ? score : null;
}

interface ScoredItem {
	item: CommandMenuItem;
	score: number;
}

/** Execute an affordance, closing the palette and surfacing errors. */
async function runAffordance(
	affordance: CommandAffordance,
	close: () => void,
	t: (key: string) => string,
	rpc: TabRpc,
): Promise<void> {
	switch (affordance.kind) {
		case "action":
			close();
			try {
				await affordance.run();
			} catch (error) {
				toast({ variant: "error", title: t("palette.failed"), message: String(error) });
			}
			return;
		case "toggle":
			close();
			try {
				await affordance.set(!affordance.get());
			} catch (error) {
				toast({ variant: "error", title: t("palette.failed"), message: String(error) });
			}
			return;
		case "picker":
			close();
			affordance.open();
			return;
		case "window":
			close();
			affordance.open();
			return;
		case "prompt":
			close();
			try {
				const response = await rpc.prompt(affordance.text.trim());
				if (!response.success) throw new Error(response.error);
			} catch (error) {
				toast({ variant: "error", title: t("palette.failed"), message: String(error) });
			}
			return;
		case "submenu":
		case "unavailable":
			// Handled by the caller (submenu expands; unavailable is disabled).
			return;
	}
}

export function CommandPalette() {
	const tabRpc = useTabRpc();
	const keyboardPlatform = currentKeyboardPlatform();
	const tabId = useRuntimeTabId();
	const t = useT();
	const open = useUiStore(state => state.commandPaletteOpen);
	const close = useUiStore(state => state.closeCommandPalette);
	const openModelPicker = useUiStore(state => state.openModelPicker);
	const openSettings = useUiStore(state => state.openSettings);
	const openProviders = useUiStore(state => state.openProviders);
	const openRenameDialog = useUiStore(state => state.openRenameDialog);
	const openSessionPicker = useUiStore(state => state.openSessionPicker);
	const openBranchPicker = useUiStore(state => state.openBranchPicker);
	const openSessionTree = useUiStore(state => state.openSessionTree);
	const openSessionInfo = useUiStore(state => state.openSessionInfo);
	const openThemePicker = useUiStore(state => state.openThemePicker);
	const openAgentHub = useUiStore(state => state.openAgentHub);
	const openPrCenter = useUiStore(state => state.openPrCenter);
	const openHotkeys = useUiStore(state => state.openHotkeys);
	const focusDockCard = useUiStore(state => state.focusDockCard);

	const isStreaming = useSessionStore(s => s.isStreaming);
	const tabKind = useActiveTabKind();
	const fastModeEnabled = useModelStore(s => s.fastModeEnabled);
	const autoCompaction = useSettingsStore(s => s.autoCompaction);
	const autoRetry = useSettingsStore(s => s.autoRetry);
	const steeringMode = useSettingsStore(s => s.steeringMode);
	const followUpMode = useSettingsStore(s => s.followUpMode);
	const interruptMode = useSettingsStore(s => s.interruptMode);
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const prewalkArmed = useSessionStore(s => s.prewalkArmed);
	const sidecarReady = useSessionStore(s => s.status) === "ready";

	const [query, setQuery] = useState("");
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	/** Set when the sidecar command fetch failed; the list stays usable (native
	 *  rows only) but says so and offers a retry instead of going silent. */
	const [commandsError, setCommandsError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [recent, setRecent] = useState<string[]>(loadRecent);
	/** When set, the palette is drilled into a submenu's items. */
	const [submenu, setSubmenu] = useState<CommandMenuItem | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const fetchSeq = useRef(0);
	/** This render's palette key handler; returns whether it consumed the key. */
	const keyHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);

	const refreshCommands = useCallback(() => {
		const seq = ++fetchSeq.current;
		if (!sidecarReady) {
			setAvailableCommands([]);
			setCommandsError(t("common.notConnected"));
			setLoading(false);
			return;
		}
		setLoading(true);
		setCommandsError(null);
		tabRpc
			.getAvailableCommands()
			.then(response => {
				if (seq !== fetchSeq.current) return;
				if (!response.success) {
					setCommandsError(response.error ?? "");
					return;
				}
				const data = response.data as { commands?: AvailableCommand[] } | undefined;
				setAvailableCommands(data?.commands ?? []);
			})
			.catch((error: unknown) => {
				if (seq !== fetchSeq.current) return;
				setCommandsError(String(error));
			})
			.finally(() => {
				if (seq === fetchSeq.current) setLoading(false);
			});
	}, [sidecarReady, t, tabRpc.getAvailableCommands]);

	useEffect(() => {
		if (!open) return;
		const panel = dialogRef.current;
		const unregisterLayer = registerDialogLayer(panel);
		// Trap + restore: without this, Tab reaches controls behind the
		// aria-modal overlay and Escape stops working once focus escapes.
		const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setQuery("");
		setActiveIndex(0);
		setSubmenu(null);
		requestAnimationFrame(() => inputRef.current?.focus());
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Tab") {
				// Listened for on the document, not the panel: switching levels unmounts
				// the focused row and the browser parks focus on <body>, outside the
				// panel, where a panel-bound handler no longer hears Escape or arrows.
				if (isImeKeyEvent(event) || !isTopmostDialog(panel)) return;
				if (!keyHandlerRef.current(event)) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				event.stopPropagation();
				return;
			}
			if (!panel) return;
			const focusables = [
				...panel.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])"),
			].filter(el => !el.hasAttribute("disabled"));
			if (focusables.length === 0) {
				event.preventDefault();
				inputRef.current?.focus();
				return;
			}
			const first = focusables[0]!;
			const last = focusables[focusables.length - 1]!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKey, true);
		refreshCommands();
		return () => {
			document.removeEventListener("keydown", onKey, true);
			// Restore only while this palette is still the top surface: closing
			// it beneath a newer modal must not yank focus out of that modal.
			const wasTop = isTopmostDialog(panel);
			unregisterLayer();
			if (wasTop) restoreFocus?.focus();
		};
	}, [open, refreshCommands]);
	/** Retry: re-send the most recent user message; interrupt the active turn when streaming. */
	const retryLastTurn = useCallback(
		() =>
			retryLastTurnShared(() =>
				toast({ variant: "warning", title: t("palette.retryNothing"), message: t("palette.retryNothingDesc") }),
			),
		[t],
	);

	/** Retry the last FAILED turn via the retry RPC (TUI /retry parity). */
	const retryTurn = useCallback(async () => {
		if (!sidecarReady) {
			toast({ variant: "warning", message: t("common.notConnected") });
			return;
		}
		const response = await tabRpc.retry();
		if (!response.success) {
			toast({ variant: "error", title: t("palette.failed"), message: response.error });
			return;
		}
		const data = response.data as { retried?: boolean } | undefined;
		if (!data?.retried) {
			toast({ variant: "warning", title: t("palette.retryNothing"), message: t("palette.retryNothingDesc") });
		}
	}, [sidecarReady, t, tabRpc.retry]);

	const menuItems = useMemo(
		() =>
			buildCommandMenu({
				t,
				tabKind,
				isStreaming,
				fastModeEnabled,
				autoCompaction,
				autoRetry,
				steeringMode,
				followUpMode,
				interruptMode,
				planModeEnabled,
				prewalkArmed,
				availableCommands,
				openModelPicker,
				openSettings,
				openProviders,
				openRenameDialog,
				openSessionPicker,
				openBranchPicker,
				openSessionTree,
				openSessionInfo,
				openHandoffDialog,
				forkSession: forkSessionFromGui,
				hydrateSession: () => (tabId ? hydrateTabSession(tabId) : hydrateSession()),
				openThemePicker,
				openAgentHub,
				openPrCenter,
				openHotkeys,
				focusDockCard,
				openCommandPalette: () => {},
				retryTurn,
				retryLastTurn,
				rpc: {
					setFastMode: enabled => tabRpc.setFastMode(enabled),
					setAutoCompaction: enabled => tabRpc.setAutoCompaction(enabled),
					setAutoRetry: enabled => tabRpc.setAutoRetry(enabled),
					setSteeringMode: mode => tabRpc.setSteeringMode(mode),
					setFollowUpMode: mode => tabRpc.setFollowUpMode(mode),
					setInterruptMode: mode => tabRpc.setInterruptMode(mode),
					compact: instructions => tabRpc.compact(instructions),
					newSession: newSessionNow,
					handoff: () => tabRpc.handoff(),
					prompt: message => tabRpc.prompt(message),
					setPlanMode: enabled => tabRpc.setPlanMode(enabled),
					setPrewalk: enabled => tabRpc.setPrewalk(enabled),
					exportHtml: path => tabRpc.exportHtml(path),
					setSessionName: name => tabRpc.setSessionName(name),
					cycleModel: () => cycleAllowedModel({ setModel: tabRpc.setModel }),
					cycleThinkingLevel: () => tabRpc.cycleThinkingLevel(),
				},
			}),
		[
			t,
			tabKind,
			isStreaming,
			fastModeEnabled,
			autoCompaction,
			autoRetry,
			steeringMode,
			followUpMode,
			interruptMode,
			planModeEnabled,
			prewalkArmed,
			availableCommands,
			openModelPicker,
			openSettings,
			openProviders,
			openRenameDialog,
			openSessionPicker,
			openBranchPicker,
			openSessionTree,
			openSessionInfo,
			retryLastTurn,
			retryTurn,
			focusDockCard,
			openAgentHub,
			openPrCenter,
			openHotkeys,
			openThemePicker,
			tabRpc.setPrewalk,
			tabRpc.setSteeringMode,
			tabRpc.setSessionName,
			tabRpc.setPlanMode,
			tabRpc.setInterruptMode,
			tabRpc.setFollowUpMode,
			tabRpc.setFastMode,
			tabRpc.prompt,
			tabRpc.setAutoRetry,
			tabRpc.handoff,
			tabRpc.setModel,
			tabRpc.setAutoCompaction,
			tabRpc.exportHtml,
			tabRpc.cycleThinkingLevel,
			tabRpc.compact,
			tabId,
		],
	);

	// The working set: submenu items when drilled in, else the full menu.
	const workingItems = useMemo(
		() => (submenu?.affordance.kind === "submenu" ? submenu.affordance.items : menuItems),
		[submenu, menuItems],
	);

	const results = useMemo<ScoredItem[]>(() => {
		const q = query.trim();
		const scored: ScoredItem[] = [];
		for (const item of workingItems) {
			const targets = [item.name, item.label, item.description ?? "", ...(item.aliases ?? [])];
			let best: number | null = null;
			for (const target of targets) {
				const score = fuzzyScore(q, target);
				if (score !== null && (best === null || score > best)) best = score;
			}
			if (best !== null) scored.push({ item, score: best });
		}
		return scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
	}, [workingItems, query]);

	// When not searching the top level, group by category for readability.
	const grouped = useMemo(() => {
		if (submenu || query.trim().length > 0) return null;
		return groupByCategory(results.map(r => r.item));
	}, [results, submenu, query]);

	// Pinned recents: top level with an empty query only, resolved against the
	// live menu so stale names from a previous session are dropped.
	const recentItems = useMemo(() => {
		if (submenu || query.trim().length > 0) return [];
		const byName = new Map(menuItems.map(item => [item.name, item]));
		return recent.map(name => byName.get(name)).filter((item): item is CommandMenuItem => item != null);
	}, [menuItems, recent, submenu, query]);

	const flatList = useMemo(() => {
		if (grouped) {
			const flat: CommandMenuItem[] = [...recentItems];
			for (const items of grouped.values()) flat.push(...items);
			return flat;
		}
		return results.map(r => r.item);
	}, [grouped, recentItems, results]);

	const recordRecent = useCallback(
		(name: string) => {
			const next = [name, ...recent.filter(n => n !== name)].slice(0, RECENT_LIMIT);
			setRecent(next);
			saveRecent(next);
		},
		[recent],
	);

	const execute = useCallback(
		(item: CommandMenuItem) => {
			if (item.affordance.kind === "unavailable") {
				toast({ variant: "warning", message: `${item.label}: ${item.affordance.reason}` });
				return;
			}
			if (sidecarBlocked(item, sidecarReady)) {
				toast({ variant: "warning", message: `${item.label}: ${t("common.notConnected")}` });
				return;
			}
			if (item.affordance.kind === "submenu") {
				// Focus first: the clicked row unmounts with the level switch.
				inputRef.current?.focus();
				setSubmenu(item);
				setQuery("");
				setActiveIndex(0);
				return;
			}
			// Argument-taking commands never run blind: fill the composer with the
			// invocation prefix so the user supplies the argument.
			const prefill = commandArgPrefill(item);
			if (prefill !== null) {
				recordRecent(item.name);
				close();
				prefillComposer(prefill);
				return;
			}
			recordRecent(item.name);
			void runAffordance(item.affordance, close, t, tabRpc);
		},
		[recordRecent, close, sidecarReady, t, tabRpc],
	);

	/** Move the selection by `delta`, skipping disabled rows. */
	const step = useCallback(
		(delta: number) => {
			setActiveIndex(current => {
				for (let i = current + delta; i >= 0 && i < flatList.length; i += delta) {
					if (!sidecarBlocked(flatList[i], sidecarReady)) return i;
				}
				return current;
			});
		},
		[flatList, sidecarReady],
	);

	/** Back to the top level, focusing the search input before the focused row unmounts. */
	const leaveSubmenu = () => {
		inputRef.current?.focus();
		setSubmenu(null);
	};

	keyHandlerRef.current = (event: KeyboardEvent): boolean => {
		switch (event.key) {
			case "ArrowDown":
				step(1);
				return true;
			case "ArrowUp":
				step(-1);
				return true;
			case "ArrowLeft":
				if (!submenu) return false;
				leaveSubmenu();
				setActiveIndex(0);
				return true;
			case "Enter": {
				// The input owns Enter. A focused row button already activates itself
				// on Enter, so running the selection here too would execute twice.
				if (event.target !== inputRef.current) return false;
				const item = flatList[activeIndex];
				if (item) execute(item);
				return true;
			}
			case "Escape":
				if (submenu) leaveSubmenu();
				else close();
				return true;
			default:
				return false;
		}
	};

	// Clamp the selection whenever the result set changes (a stale index left
	// Enter reading flatList[undefined]) and whenever the palette re-opens, since
	// the open effect resets it to 0 — which may be a disabled row.
	const resultCount = flatList.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `open` re-runs the clamp after the open-effect reset
	useEffect(() => {
		setActiveIndex(current => {
			if (resultCount === 0) return 0;
			const clamped = Math.min(Math.max(current, 0), resultCount - 1);
			if (!sidecarBlocked(flatList[clamped], sidecarReady)) return clamped;
			// Never rest on a disabled row: Enter would otherwise be a no-op.
			const first = flatList.findIndex(item => !sidecarBlocked(item, sidecarReady));
			return first === -1 ? clamped : first;
		});
	}, [resultCount, flatList, open, sidecarReady]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-palette-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	if (!open) return null;

	let flatIndex = -1;

	const renderItem = (item: CommandMenuItem, options?: { categoryLabel?: string; recent?: boolean }) => {
		flatIndex++;
		const index = flatIndex;
		const isActive = index === activeIndex;
		const blocked = sidecarBlocked(item, sidecarReady);
		const disabled = item.affordance.kind === "unavailable" || blocked;
		const isSubmenu = item.affordance.kind === "submenu";
		const toggleOn = item.affordance.kind === "toggle" ? item.affordance.get() : null;

		return (
			<button
				aria-disabled={disabled}
				className={`flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors ${
					isActive
						? "bg-(--omp-selected-bg) shadow-[inset_0_0_0_1px_var(--omp-border-accent)]"
						: "hover:bg-(--omp-bg-tertiary)"
				} ${disabled ? "opacity-45" : ""}`}
				data-palette-index={index}
				data-command-name={item.name}
				data-command-aliases={JSON.stringify(item.aliases ?? [])}
				data-command-kind={item.affordance.kind}
				disabled={disabled}
				key={item.name}
				onClick={() => execute(item)}
				onMouseEnter={() => setActiveIndex(index)}
				type="button"
			>
				<span
					aria-hidden="true"
					className={`flex size-7 shrink-0 items-center justify-center rounded-[22%] text-(--omp-accent) ${
						isActive ? "bg-(--omp-bg-elevated) shadow-(--omp-shadow-sm)" : "bg-(--omp-selected-bg)"
					}`}
				>
					{options?.recent ? <History size={15} /> : <Slash size={15} />}
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex items-center gap-1.5">
						<span className="truncate text-omp-lg font-medium text-(--omp-text)">{item.label}</span>
						{toggleOn !== null && (
							<span
								className={`rounded px-1 text-omp-xxs font-semibold uppercase ${
									toggleOn ? "text-(--omp-success)" : "text-(--omp-dim)"
								}`}
							>
								{toggleOn ? t("palette.on") : t("palette.off")}
							</span>
						)}
					</span>
					<span className="block truncate text-omp-sm text-(--omp-text-secondary)">
						{disabled
							? item.affordance.kind === "unavailable"
								? item.affordance.reason
								: t("common.notConnected")
							: item.description}
					</span>
				</span>
				{item.shortcut && (
					<kbd className="omp-kbd shrink-0 font-medium text-(--omp-muted)">
						{displayShortcut(item.shortcut, keyboardPlatform)}
					</kbd>
				)}
				{options?.categoryLabel && (
					<span className="shrink-0 text-omp-xxs tracking-wide text-(--omp-dim) uppercase">
						{options.categoryLabel}
					</span>
				)}
				{isSubmenu ? (
					<ChevronRight className="shrink-0 text-(--omp-dim)" size={12} />
				) : (
					toggleOn !== null && (
						<Check className={`shrink-0 ${toggleOn ? "text-(--omp-success)" : "text-transparent"}`} size={12} />
					)
				)}
				{isActive && !isSubmenu && toggleOn === null && (
					<CornerDownLeft className="shrink-0 text-(--omp-dim)" size={11} />
				)}
			</button>
		);
	};

	return (
		<div
			className="omp-dialog-overlay omp-fade-in fixed inset-0 z-50 flex items-start justify-center bg-[var(--omp-overlay-bg)] p-4 pt-[12dvh] backdrop-blur-[2px]"
			onMouseDown={event => {
				if (event.target === event.currentTarget) close();
			}}
			role="presentation"
		>
			<div
				aria-label={t("palette.searchLabel")}
				aria-modal="true"
				className="omp-dialog-panel omp-dialog-size-picker overflow-hidden rounded-[14px] border border-(--omp-modal-border) bg-(--omp-modal-bg) shadow-(--omp-shadow-lg)"
				ref={dialogRef}
				role="dialog"
			>
				<div className="flex items-center gap-2.5 border-b border-(--omp-border-muted) px-3.5 py-2.5">
					{submenu && (
						<button
							type="button"
							onClick={leaveSubmenu}
							className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-omp-sm font-medium text-(--omp-accent) hover:bg-(--omp-bg-tertiary)"
						>
							<X size={11} />
							{submenu.label}
						</button>
					)}
					<Search className="shrink-0 text-(--omp-dim)" size={14} />
					<input
						aria-label={t("palette.searchLabel")}
						className="min-w-0 flex-1 bg-transparent text-sm text-(--omp-text) placeholder:text-(--omp-dim) focus:outline-none"
						onChange={event => setQuery(event.target.value)}
						placeholder={submenu ? t("palette.searchSubmenu", { name: submenu.label }) : t("palette.search")}
						ref={inputRef}
						value={query}
					/>
					{loading && <Spinner size="sm" />}
					<kbd className="omp-kbd shrink-0 font-medium text-(--omp-muted)">esc</kbd>
				</div>
				{commandsError !== null && (
					<div className="flex items-center gap-2 border-b border-(--omp-border-muted) px-3 py-1.5">
						<span
							className="min-w-0 flex-1 truncate text-omp-xs text-(--omp-error)"
							role="alert"
							title={commandsError || undefined}
						>
							{t("palette.commandsFailed")}
						</span>
						<button
							className="shrink-0 rounded border border-(--omp-border-muted) px-1.5 py-0.5 text-omp-xs text-(--omp-text) hover:bg-(--omp-bg-tertiary)"
							onClick={refreshCommands}
							type="button"
						>
							{t("common.retry")}
						</button>
					</div>
				)}
				<div className="omp-command-list overflow-y-auto px-2 pt-1 pb-2" ref={listRef}>
					{flatList.length === 0 && !loading && (
						<div className="px-3 py-8 text-center text-xs text-(--omp-dim)">
							{workingItems.length === 0 ? t("palette.noCommands") : t("palette.noMatch")}
						</div>
					)}

					{grouped ? (
						<>
							{recentItems.length > 0 && (
								<div className="mb-1">
									<div className="omp-eyebrow px-3 pt-2.5 pb-1.5 text-(--omp-dim)">{t("palette.recent")}</div>
									{recentItems.map(item => renderItem(item, { recent: true }))}
								</div>
							)}
							{Array.from(grouped.entries()).map(([category, items]) => (
								<div key={category} className="mb-1">
									<div className="omp-eyebrow px-3 pt-3 pb-1.5 text-(--omp-dim)">
										{t(`category.${category}`)}
									</div>
									{items.map(item => renderItem(item))}
								</div>
							))}
						</>
					) : (
						flatList.map(item => renderItem(item))
					)}
				</div>
				<div
					className="flex items-center gap-4 border-t border-(--omp-border-muted) bg-(--omp-bg-secondary) px-4 py-2.5 text-omp-sm text-(--omp-muted)" // surface-ok: palette footer
					data-palette-footer
				>
					<span className="flex items-center gap-1.5">
						<Kbd className="bg-(--omp-bg-elevated) font-medium">↑↓</Kbd>
						{t("palette.footer.navigate")}
					</span>
					<span className="flex items-center gap-1.5">
						<Kbd className="bg-(--omp-bg-elevated) font-medium">↵</Kbd>
						{t("palette.footer.run")}
					</span>
					<span className="ml-auto font-mono font-medium">
						{t("palette.footer.count", { count: results.length, plural: results.length === 1 ? "" : "s" })}
					</span>
				</div>
			</div>
		</div>
	);
}
