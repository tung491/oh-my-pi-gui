import {
	BriefcaseBusiness,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	ExternalLink,
	type LucideIcon,
	MessageCircle,
	Palette,
	Pencil,
	Pin,
	PinOff,
	Plug,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Trash2,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useAwaitingConfirmation } from "../../hooks/use-awaiting-confirmation";
import { useSessionList } from "../../hooks/use-session-list";
import { dropSessionNow } from "../../hooks/use-session-switch";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { sessionDisplayTitle } from "../../lib/session-title";
import { effectiveShortcut } from "../../lib/shortcut-hint";
import { useTabRpc } from "../../lib/tab-rpc";
import { tabSignalPresentation } from "../../lib/tab-signal";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, IconButton, Kbd, SaiAtlasLogo } from "../common";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../common/ContextMenu";
import { LangSwitcher } from "../common/LangSwitcher";

const STATUS_COLOR: Record<SessionInfo["status"], string> = {
	complete: "var(--omp-success)",
	interrupted: "var(--omp-warning)",
	aborted: "var(--omp-warning)",
	error: "var(--omp-error)",
	pending: "var(--omp-dim)",
	unknown: "var(--omp-dim)",
};

/**
 * The rail stays navy in every theme, so each shared status color (from
 * STATUS_COLOR, the row's own waiting/running states, and tabSignalPresentation)
 * repaints with its always-dark sidebar twin.
 */
const SIDEBAR_SIGNAL_COLOR: Record<string, string> = {
	"var(--omp-accent)": "var(--omp-sidebar-accent)",
	"var(--omp-success)": "var(--omp-sidebar-success)",
	"var(--omp-warning)": "var(--omp-sidebar-warning)",
	"var(--omp-error)": "var(--omp-sidebar-error)",
	"var(--omp-dim)": "var(--omp-sidebar-muted)",
};

function sidebarSignalColor(color: string): string {
	return SIDEBAR_SIGNAL_COLOR[color] ?? color;
}

const STATUS_LABEL_KEY: Record<SessionInfo["status"], string> = {
	complete: "sidebar.status.complete",
	interrupted: "sidebar.status.interrupted",
	aborted: "sidebar.status.aborted",
	error: "sidebar.status.error",
	pending: "sidebar.status.pending",
	unknown: "sidebar.status.unknown",
};

interface SidebarNavItem {
	id: string;
	icon: LucideIcon;
	label: string;
	/** Keymap hint; only the destinations the rail design marks carry one. */
	shortcut?: string;
	title?: string;
	onClick: () => void;
}

function modifiedAt(session: SessionInfo): number {
	const timestamp = Date.parse(session.modified);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function SidebarRowTitle({ className, title }: { className?: string; title: string }) {
	return (
		<span className={cx("omp-sidebar-title min-w-0 flex-1 truncate", className)} title={title}>
			{title}
		</span>
	);
}

/**
 * Left rail with one task lane: every session, whatever folder it ran in, in
 * one list with pinned tasks first and the rest by last activity. The main
 * action starts a task in the GUI-owned default workspace.
 */
export function Sidebar() {
	const tabRpc = useTabRpc();
	const t = useT();
	const keymapOverrides = useUiStore(state => state.keymapOverrides);
	// The command palette is the one destination the rail marks with a hint; it
	// shows every chord that actually fires it, overrides included.
	const paletteShortcut = useMemo(() => effectiveShortcut("palette", keymapOverrides), [keymapOverrides]);
	const [navigationExpanded, setNavigationExpanded] = useState(true);
	const switchPendingTo = useSessionStore(s => s.switchPending?.toId ?? null);
	// Resizable left rail (mirrors PanelContainer's right-rail drag, but the
	// handle sits on the right edge and dragging right grows the sidebar).
	const SIDEBAR_MIN = 180;
	const SIDEBAR_MAX = 420;
	const [sidebarWidth, setSidebarWidth] = useState(264);
	const sidebarWidthRef = useRef(264);
	// Layout widths persist like every other chrome pref; restored on mount.
	useEffect(() => {
		void window.omp.prefs
			.get("sidebarWidth")
			.then(value => {
				if (typeof value !== "number" || !Number.isFinite(value)) return;
				const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value));
				sidebarWidthRef.current = clamped;
				setSidebarWidth(clamped);
			})
			.catch(() => {});
	}, []);
	const sidebarDragging = useRef(false);
	const startSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		sidebarDragging.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);
	const onSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!sidebarDragging.current) return;
		// Sidebar is left-anchored: dragging right grows it.
		const host = e.currentTarget.parentElement;
		if (!host) return;
		const hostRect = host.getBoundingClientRect();
		const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - hostRect.left));
		sidebarWidthRef.current = clamped;
		setSidebarWidth(clamped);
	}, []);
	const endSidebarDrag = useCallback(() => {
		sidebarDragging.current = false;
		void window.omp.prefs.set("sidebarWidth", sidebarWidthRef.current).catch(() => {});
	}, []);
	const [deleting, setDeleting] = useState(false);
	// Deleting a session hard-deletes its transcript file, so the row and menu
	// clicks only queue it: the dialog names the target and states the
	// consequence before anything is removed.
	const [pendingDelete, setPendingDelete] = useState<SessionInfo | null>(null);
	const [renamingSessionPath, setRenamingSessionPath] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [sessionMenu, setSessionMenu] = useState<{ anchor: ContextMenuAnchor; session: SessionInfo } | null>(null);
	const openTab = useTabsStore(s => s.openTab);
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const activeTab = tabs.find(tab => tab.id === activeTabId);
	const pinnedSessions = useSidebarPrefs(s => s.pinnedSessions);
	const sessionLastUsed = useSidebarPrefs(s => s.sessionLastUsed);
	const touchSession = useSidebarPrefs(s => s.touchSession);
	const renameRef = useRef<HTMLInputElement>(null);
	const { sessions, isLoading, error: listError, refresh, deleteSession, renameSession } = useSessionList("global");
	const sessionId = useSessionStore(s => s.sessionId);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	// Sidebar signal-light state for the ATTACHED session: a blocking
	// confirmation (plan approval / ask / permission) overrides the running
	// signal — it needs the user, not just time.
	const awaitingConfirmation = useAwaitingConfirmation();
	const openThemePicker = useUiStore(s => s.openThemePicker);
	const openSessionPicker = useUiStore(s => s.openSessionPicker);
	// The footer names the GUI build. Until the main process answers (or if it
	// never does) the status line is simply absent; no placeholder version.
	const [guiVersion, setGuiVersion] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		window.omp.updater
			.version()
			.then(version => {
				if (!cancelled && typeof version === "string" && version.length > 0) setGuiVersion(version);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	const footerSignal = activeTab ? tabSignalPresentation(activeTab, isStreaming || isCompacting) : null;
	const footerStatus =
		footerSignal && guiVersion !== null
			? t("sidebar.footer.status", { version: guiVersion, status: t(footerSignal.labelKey) })
			: null;

	const recencyForSession = useCallback(
		(session: SessionInfo) => sessionLastUsed[session.path] ?? modifiedAt(session),
		[sessionLastUsed],
	);
	// One lane: every session either former lane listed, pinned first, then by
	// last activity.
	const taskSessions = useMemo(
		() =>
			sessions.toSorted((a, b) => {
				const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
				const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
				if (aPinned !== bPinned) return aPinned - bPinned;
				return recencyForSession(b) - recencyForSession(a);
			}),
		[sessions, pinnedSessions, recencyForSession],
	);
	const totalCount = taskSessions.length;

	const tabForSession = (session: SessionInfo) =>
		tabs.find(tab => tab.sessionId === session.id) ?? (session.id === sessionId ? activeTab : undefined);
	const sessionTabSignal = (session: SessionInfo) => {
		const tab = tabForSession(session);
		return tab ? tabSignalPresentation(tab, session.id === sessionId && (isStreaming || isCompacting)) : null;
	};
	const isSessionBusy = (session: SessionInfo) => {
		if (session.id === sessionId && awaitingConfirmation) return true;
		const signal = sessionTabSignal(session);
		if (signal) return signal.active;
		if (session.id === sessionId && (isStreaming || isCompacting)) return true;
		return session.status === "pending";
	};

	const openSession = (session: SessionInfo) => {
		if (session.id === sessionId) return;
		void openTab({ cwd: session.cwd, sessionPath: session.path, kind: session.kind ?? "agent" });
	};
	const startNew = () => {
		void openTab({ kind: "agent", work: true });
	};

	// Explicit parallel action: open this session in a NEW window with its own
	// sidecar, leaving the current window's running session untouched.
	const openSessionInNewWindow = async (session: SessionInfo) => {
		const result = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
		if (typeof result === "object") {
			toast({ variant: "error", message: t("sidebar.kindMismatch") });
			return;
		}
		if (!result) {
			toast({ variant: "warning", message: t("sidebar.parallelCap") });
			return;
		}
		touchSession(session.path);
	};

	const startRename = (session: SessionInfo) => {
		setRenameDraft(session.title || session.firstMessage || "");
		setRenamingSessionPath(session.path);
		requestAnimationFrame(() => renameRef.current?.select());
	};
	const commitRename = (session: SessionInfo, value = renameDraft) => {
		setRenamingSessionPath(null);
		const name = value.trim();
		if (!name || name === session.title) return;
		void renameSession(session.path, name)
			.then(() => {
				if (session.id === sessionId) useSessionStore.setState({ sessionName: name });
			})
			.catch(error => toast({ variant: "error", title: t("sidebar.renameFailed"), message: String(error) }));
	};

	const confirmDeleteSession = async (session: SessionInfo) => {
		if (isSessionBusy(session)) {
			toast({ variant: "warning", message: t("sidebar.menu.taskRunning") });
			setPendingDelete(null);
			return;
		}
		setDeleting(true);
		try {
			if (session.id === sessionId) {
				await dropSessionNow();
			} else {
				await deleteSession(session.path);
			}
			setPendingDelete(null);
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.deleteFailed"), message: String(error) });
		} finally {
			setDeleting(false);
		}
	};

	const renderSessionRow = (session: SessionInfo) => {
		const active = session.id === sessionId;
		const tabSignal = sessionTabSignal(session);
		const waiting = active && awaitingConfirmation;
		const externalRunning = tabSignal === null && isSessionBusy(session);
		const signalActive = waiting || tabSignal?.active === true || externalRunning;
		const signalLabel = waiting
			? t("sidebar.signal.waiting")
			: tabSignal
				? t(tabSignal.labelKey)
				: externalRunning
					? t("sidebar.signal.running")
					: t(STATUS_LABEL_KEY[session.status]);
		const signalColor = sidebarSignalColor(
			waiting
				? "var(--omp-warning)"
				: (tabSignal?.color ?? (externalRunning ? "var(--omp-accent)" : STATUS_COLOR[session.status])),
		);
		const running = !waiting && (tabSignal?.running === true || externalRunning);
		const title = sessionDisplayTitle(session, t("sidebar.untitled"));
		const hasActions = !signalActive || !active;
		const actionsOpen = renamingSessionPath === session.path;
		return (
			<div
				key={session.path}
				role="button"
				tabIndex={0}
				onClick={() => void openSession(session)}
				onContextMenu={event => setSessionMenu({ anchor: anchorFromEvent(event), session })}
				onKeyDown={event => {
					// Only the row itself: Enter inside a nested control (rename
					// input, action buttons) must not also switch the session.
					if (event.key === "Enter" && event.target === event.currentTarget) void openSession(session);
				}}
				data-active={active}
				data-switch-pending={switchPendingTo === session.id || undefined}
				data-has-actions={hasActions}
				data-actions-open={actionsOpen}
				data-session-kind={session.kind ?? "agent"}
				className={cx(
					"omp-sidebar-session-row omp-color-fade group flex h-8 cursor-pointer items-center rounded-md border border-transparent pr-2",
					"pl-2",
					active
						? "bg-(--omp-sidebar-item-active) font-semibold shadow-[inset_3px_0_0_0_var(--omp-sidebar-accent)]"
						: "hover:border-(--omp-sidebar-border) hover:bg-(--omp-sidebar-item-hover)",
				)}
			>
				<div className="flex min-w-0 flex-1 items-center">
					<span
						role="img"
						aria-label={signalLabel}
						title={signalLabel}
						className={cx("omp-signal-light mr-2", signalActive && "omp-signal-light--active")}
						style={{ color: signalColor }}
					/>
					{session.kind === "chat" ? (
						<MessageCircle
							aria-hidden="true"
							data-sidebar-session-icon
							size={14}
							className="mr-2 shrink-0 text-(--omp-sidebar-muted)"
						/>
					) : null}
					{pinnedSessions.includes(session.path) && (
						<Pin
							size={10}
							className="mr-1.5 shrink-0 text-(--omp-sidebar-accent)"
							aria-label={t("sidebar.pinned")}
						/>
					)}
					{renamingSessionPath === session.path ? (
						<input
							ref={renameRef}
							value={renameDraft}
							onChange={event => setRenameDraft(event.target.value)}
							onBlur={event => commitRename(session, event.currentTarget.value)}
							onKeyDown={event => {
								if (isImeKeyEvent(event)) return;
								if (event.key === "Enter") commitRename(session, event.currentTarget.value);
								onEscape(event, () => setRenamingSessionPath(null));
							}}
							onClick={event => event.stopPropagation()}
							className="min-w-0 flex-1 rounded border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-1.5 py-0.5 text-omp-md font-normal text-[var(--omp-muted)] outline-none"
						/>
					) : (
						<SidebarRowTitle
							className={cx(
								"text-omp-md leading-5",
								active ? "font-semibold text-(--omp-sidebar-text)" : "font-normal text-(--omp-sidebar-muted)",
							)}
							title={title}
						/>
					)}
					{running && (
						<span aria-hidden="true" className="ml-2 shrink-0 font-mono text-omp-xs text-(--omp-sidebar-accent)">
							{t("sidebar.signal.running")}
						</span>
					)}
					<span
						className="omp-sidebar-session-actions flex shrink-0 items-center justify-end gap-0.5"
						onClick={event => event.stopPropagation()}
					>
						{!signalActive && renamingSessionPath !== session.path ? (
							<button
								type="button"
								title={t("sidebar.rename")}
								aria-label={t("sidebar.rename")}
								onClick={() => startRename(session)}
								className="omp-sidebar-action order-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--omp-sidebar-muted) hover:bg-(--omp-sidebar-item-active) hover:text-(--omp-sidebar-text)"
							>
								<Pencil size={11} />
							</button>
						) : !active ? (
							<button
								type="button"
								title={t("sidebar.menu.openNewTab")}
								aria-label={t("sidebar.menu.openNewTab")}
								onClick={() => void openSession(session)}
								className="omp-sidebar-action flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--omp-sidebar-muted) hover:bg-(--omp-sidebar-item-active) hover:text-(--omp-sidebar-text)"
							>
								<Plus size={11} />
							</button>
						) : (
							<span className="h-5 w-5 shrink-0" />
						)}
						{!signalActive ? (
							<button
								className="omp-sidebar-action flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--omp-sidebar-muted) hover:bg-[var(--omp-tool-error-bg)] hover:text-(--omp-sidebar-error)"
								onClick={() => setPendingDelete(session)}
								title={t("sidebar.delete")}
								type="button"
								aria-label={t("sidebar.delete")}
							>
								<Trash2 size={11} />
							</button>
						) : (
							<span className="order-1 h-5 w-5 shrink-0" />
						)}
					</span>
				</div>
			</div>
		);
	};

	const primaryNavItems: SidebarNavItem[] = [
		{
			id: "commands",
			icon: Search,
			label: t("titlebar.commands"),
			shortcut: paletteShortcut,
			title: t("titlebar.commandsHint", { shortcut: paletteShortcut }),
			onClick: () => useUiStore.getState().openCommandPalette(),
		},
		{
			id: "providers",
			icon: Plug,
			label: t("ollama.settings.title"),
			onClick: () => useUiStore.getState().openProviders(),
		},
	];
	const secondaryNavItems: SidebarNavItem[] = [
		{
			id: "settings",
			icon: Settings,
			label: t("titlebar.settings"),
			onClick: () => useUiStore.getState().openSettings(),
		},
	];
	// The kbd chip is aria-hidden, so the accessible name stays the bare label
	// and the chord is repeated in the tooltip.
	const renderNavItem = (item: SidebarNavItem) => {
		const Icon = item.icon;
		return (
			<button
				key={item.id}
				type="button"
				onClick={item.onClick}
				data-sidebar-nav={item.id}
				data-command-center-entry={item.id === "commands" ? true : undefined}
				title={
					item.title ??
					(item.shortcut
						? t("sidebar.nav.shortcutTitle", { label: item.label, shortcut: item.shortcut })
						: undefined)
				}
				className="omp-pressable flex h-[34px] w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-omp-md text-(--omp-sidebar-muted) hover:bg-(--omp-sidebar-item-active) hover:text-(--omp-sidebar-text)"
			>
				<Icon aria-hidden="true" className="shrink-0" size={16} />
				<span className="min-w-0 flex-1 truncate">{item.label}</span>
				{item.shortcut && (
					<Kbd className="shrink-0 border-(--omp-sidebar-border) text-(--omp-sidebar-muted)">{item.shortcut}</Kbd>
				)}
			</button>
		);
	};

	return (
		<>
			<aside
				className="omp-session-sidebar relative flex h-full shrink-0 flex-col border-r border-(--omp-sidebar-border) bg-(--omp-sidebar-bg) text-(--omp-sidebar-text)"
				style={{ width: sidebarWidth }}
			>
				<div className="drag-region flex h-14 shrink-0 items-center gap-1 border-b border-(--omp-sidebar-border) pl-4 pr-2.5">
					<SaiAtlasLogo kind="lockup" surface="sidebar" height={28} />
					<div className="flex-1" />
					<IconButton
						variant="onDark"
						size="sm"
						label={t("sidebar.search")}
						icon={<Search size={15} />}
						onClick={openSessionPicker}
						className="no-drag"
					/>
				</div>

				<div className="flex items-center gap-2 px-3 pb-2 pt-3">
					<Button
						variant="primary"
						size="sm"
						data-sidebar-new-agent
						onClick={startNew}
						icon={<BriefcaseBusiness size={14} />}
						className="min-w-0 flex-1"
					>
						<span className="min-w-0 truncate">{t("sidebar.newWork")}</span>
					</Button>
				</div>

				<div className="px-2 pb-2" data-sidebar-navigation>
					<div
						aria-hidden={!navigationExpanded}
						className="omp-sidebar-group"
						data-state={navigationExpanded ? "expanded" : "collapsed"}
						inert={!navigationExpanded}
					>
						<div className="omp-sidebar-group-content space-y-0.5">
							{primaryNavItems.map(renderNavItem)}
							<div aria-hidden="true" className="mx-2 my-1.5 h-px bg-(--omp-sidebar-border)" />
							{secondaryNavItems.map(renderNavItem)}
						</div>
					</div>
					<button
						type="button"
						aria-expanded={navigationExpanded}
						aria-label={t(navigationExpanded ? "sidebar.navigation.collapse" : "sidebar.navigation.expand")}
						title={t(navigationExpanded ? "sidebar.navigation.collapse" : "sidebar.navigation.expand")}
						onClick={() => setNavigationExpanded(expanded => !expanded)}
						className="omp-pressable mt-1 flex h-6 w-full items-center justify-center rounded-lg border border-(--omp-sidebar-border) text-(--omp-sidebar-muted) hover:bg-(--omp-sidebar-item-hover) hover:text-(--omp-sidebar-text)"
					>
						{navigationExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</button>
				</div>

				<div className="flex items-center justify-between px-4 pb-1.5">
					<span className="omp-eyebrow text-(--omp-sidebar-muted)">{t("sidebar.recent")}</span>
					{totalCount > 0 && (
						<span
							className="rounded-full bg-(--omp-sidebar-item-hover) px-2 py-0.5 font-mono text-omp-xs tabular-nums text-(--omp-sidebar-muted)" // surface-ok: count pill
						>
							{totalCount}
						</span>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [overflow-anchor:none]">
					{listError && sessions.length > 0 && (
						<p role="alert" className="mx-3 mb-1 break-words text-omp-xs text-(--omp-sidebar-error)">
							{t("sidebar.stale")}: {listError}
						</p>
					)}
					{isLoading && sessions.length === 0 && (
						<div className="px-3 py-6 text-center text-omp-lg text-(--omp-sidebar-muted)">
							{t("sidebar.loading")}
						</div>
					)}
					{listError && sessions.length === 0 && (
						<div className="mx-1 mt-2 flex flex-col items-center gap-2 px-4 py-6 text-center">
							<div className="text-omp-lg font-medium text-(--omp-sidebar-error)">{t("sidebar.loadFailed")}</div>
							<div className="break-words text-omp-xs text-(--omp-sidebar-muted)">{listError}</div>
							<Button icon={<RefreshCw size={12} />} onClick={() => refresh(true)} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						</div>
					)}
					{!isLoading && !listError && totalCount === 0 && (
						<div className="mx-1 mt-2 flex flex-col items-center rounded-xl border border-dashed border-(--omp-sidebar-border) px-4 py-6 text-center">
							<BriefcaseBusiness size={20} className="mb-2 text-(--omp-sidebar-muted)" />
							<div className="text-omp-lg font-medium text-(--omp-sidebar-muted)">{t("sidebar.emptyWork")}</div>
						</div>
					)}
					{taskSessions.length > 0 && (
						<div className="space-y-px" data-session-list>
							{taskSessions.map(session => renderSessionRow(session))}
						</div>
					)}
				</div>

				{/* Status of the active tab plus theme, language, and settings. The dot
				    is decorative: the text carries the status. */}
				<div
					data-sidebar-footer
					className="flex h-10 shrink-0 items-center gap-1 border-t border-(--omp-sidebar-border) pl-3.5 pr-2"
				>
					{footerSignal && (
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-full"
							style={{ backgroundColor: sidebarSignalColor(footerSignal.color) }}
						/>
					)}
					{footerStatus !== null && (
						<span
							className="ml-1 min-w-0 truncate font-mono text-omp-xs text-(--omp-sidebar-muted)"
							title={footerStatus}
						>
							{footerStatus}
						</span>
					)}
					<div className="flex-1" />
					<IconButton
						variant="onDark"
						size="sm"
						label={t("themePicker.aria")}
						icon={<Palette size={14} />}
						onClick={openThemePicker}
					/>
					<LangSwitcher tone="onDark" className="h-7 max-h-7 rounded-md px-1.5 text-omp-sm [&_svg]:size-[14px]" />
					<IconButton
						variant="onDark"
						size="sm"
						label={t("sidebar.footer.settings")}
						icon={<Settings size={14} />}
						onClick={() => useUiStore.getState().openSettings()}
					/>
				</div>
				<div
					role="separator"
					aria-orientation="vertical"
					onPointerDown={startSidebarDrag}
					onPointerMove={onSidebarDrag}
					onPointerUp={endSidebarDrag}
					className="absolute inset-y-0 right-0 z-10 w-1 translate-x-1/2 cursor-col-resize transition-colors hover:bg-(--omp-sidebar-accent)/40 active:bg-(--omp-sidebar-accent) max-[1000px]:hidden"
				/>
			</aside>
			{/* Session row menu: open variants, per-task rename, pin, and delete. */}
			{sessionMenu &&
				(() => {
					const targetBusy = isSessionBusy(sessionMenu.session);
					return (
						<ContextMenu
							x={sessionMenu.anchor.x}
							y={sessionMenu.anchor.y}
							onClose={() => setSessionMenu(null)}
							items={[
								{
									id: "session-open",
									label: t("sidebar.menu.open"),
									icon: ChevronRight,
									onSelect: () => {
										setSessionMenu(null);
										void openSession(sessionMenu.session);
									},
								},
								{
									id: "session-open-tab",
									label: t("sidebar.menu.openNewTab"),
									icon: Plus,
									onSelect: () => {
										setSessionMenu(null);
										void openTab({
											cwd: sessionMenu.session.cwd,
											kind: sessionMenu.session.kind ?? "agent",
											sessionPath: sessionMenu.session.path,
										});
									},
								},
								{
									id: "session-open-window",
									label: t("sidebar.openInNewWindow"),
									icon: ExternalLink,
									onSelect: () => {
										setSessionMenu(null);
										void openSessionInNewWindow(sessionMenu.session);
									},
								},
								{
									id: "session-rename",
									label: t("sidebar.rename"),
									icon: Pencil,
									disabled: targetBusy,
									disabledReason: t("sidebar.menu.taskRunning"),
									onSelect: () => {
										setSessionMenu(null);
										startRename(sessionMenu.session);
									},
								},
								{
									id: "session-pin",
									label: pinnedSessions.includes(sessionMenu.session.path)
										? t("sidebar.menu.unpin")
										: t("sidebar.menu.pin"),
									icon: pinnedSessions.includes(sessionMenu.session.path) ? PinOff : Pin,
									onSelect: () => {
										const pinned = !pinnedSessions.includes(sessionMenu.session.path);
										useSidebarPrefs.getState().toggleSessionPin(sessionMenu.session.path);
										setSessionMenu(null);
										void tabRpc.setSessionPinned(sessionMenu.session.id, pinned).then(response => {
											if (!response.success) {
												toast({ variant: "warning", message: t("sidebar.pinSyncFailed") });
											}
										});
									},
								},
								{
									id: "session-delete",
									label: t("common.delete"),
									icon: Trash2,
									danger: true,
									disabled: targetBusy,
									disabledReason: t("sidebar.menu.taskRunning"),
									onSelect: () => {
										setPendingDelete(sessionMenu.session);
										setSessionMenu(null);
									},
								},
							]}
						/>
					);
				})()}

			<ConfirmDialog
				open={pendingDelete !== null}
				title={t("sidebar.deleteConfirm")}
				message={
					pendingDelete
						? t("sidebar.deleteMessage", { name: sessionDisplayTitle(pendingDelete, t("sidebar.untitled")) })
						: ""
				}
				busy={deleting}
				onConfirm={() => {
					if (pendingDelete) void confirmDeleteSession(pendingDelete);
				}}
				onCancel={() => setPendingDelete(null)}
			/>
		</>
	);
}
