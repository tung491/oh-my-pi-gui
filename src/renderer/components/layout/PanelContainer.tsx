import { FolderTree, ScrollText, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import type { PanelTab } from "../../stores/ui";
import { useUiStore } from "../../stores/ui";
import { IconButton, PanelErrorBoundary } from "../common";
import { FilePreviewPanel, FilesPanel } from "../panels/FilesPanel";
import { LogPanel } from "../panels/LogPanel";

const MIN_WIDTH = 360;
const MAX_WIDTH = 840;
const PANEL_WIDTH_PREF = "gui.panelWidth";
/** Below this the inspector overlays instead of docking, unless it previews a file. */
const COMPACT_QUERY = "(max-width: 1000px)";

function defaultPanelWidth(): number {
	const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1440;
	return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(viewportWidth * 0.28)));
}

const TABS: { id: PanelTab; labelKey: string; icon: typeof FolderTree }[] = [
	{ id: "files", labelKey: "panel.tabs.files", icon: FolderTree },
	{ id: "logs", labelKey: "panel.tabs.logs", icon: ScrollText },
];

/**
 * Contextual workspace drawer. Hidden by default; opened explicitly for
 * files or logs without shrinking the core chat. Live execution
 * state (todos, plan, subagents, queue) renders in the center dock above
 * the composer instead — see chat/dock/WorkspaceDock.
 *
 * While a file is previewed the drawer always docks beside the chat (split
 * workspace and narrow windows included) at a derived width that is never
 * saved; in a narrow window it also hides the session sidebar until it closes.
 */
export function PanelContainer() {
	const t = useT();
	const panelTab = useUiStore(s => s.panelTab);
	const setPanelTab = useUiStore(s => s.setPanelTab);
	const togglePanel = useUiStore(s => s.togglePanel);
	const filePreview = useUiStore(s => s.filePreview);
	const previewing = panelTab === "files" && filePreview !== null;
	const activeTabId = useTabsStore(s => s.activeTabId);
	const split = useTabsStore(s => s.split);
	const routeReady = useActiveTabRouteReady();
	// ≤1000px: the inspector would squeeze the conversation below usability as
	// a flex sibling — render it as a right-anchored overlay instead (same
	// breakpoint App uses to auto-hide on shrink).
	const [compact, setCompactState] = useState(() =>
		typeof window.matchMedia === "function" ? window.matchMedia(COMPACT_QUERY).matches : false,
	);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia(COMPACT_QUERY);
		const onChange = () => setCompactState(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	const [width, setWidth] = useState(defaultPanelWidth);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	const [widthHydrated, setWidthHydrated] = useState(false);
	const dragging = useRef(false);

	useEffect(() => {
		let cancelled = false;
		const prefs = window.omp?.prefs;
		if (typeof prefs?.get !== "function") {
			setWidthHydrated(true);
			return;
		}
		void prefs
			.get(PANEL_WIDTH_PREF)
			.then(value => {
				if (cancelled) return;
				const saved = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
				if (saved !== null) {
					const viewportLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 56));
					setWidth(Math.min(viewportLimit, Math.max(MIN_WIDTH, saved)));
				}
				setWidthHydrated(true);
			})
			.catch(() => {
				if (!cancelled) setWidthHydrated(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!widthHydrated || typeof window.omp?.prefs?.set !== "function") return;
		const timer = window.setTimeout(() => {
			void window.omp.prefs.set(PANEL_WIDTH_PREF, Math.round(width)).catch(() => {});
		}, 150);
		return () => window.clearTimeout(timer);
	}, [width, widthHydrated]);

	useEffect(() => {
		const clampToViewport = () => {
			const viewportLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 56));
			setWidth(current => Math.min(current, viewportLimit));
			setViewportWidth(window.innerWidth);
		};
		window.addEventListener("resize", clampToViewport);
		return () => window.removeEventListener("resize", clampToViewport);
	}, []);

	const startDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		dragging.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);

	const onDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragging.current) return;
		// Panel is right-anchored: dragging left grows it.
		const hostLimit = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.55));
		const next = Math.min(hostLimit, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
		setWidth(next);
	}, []);

	const endDrag = useCallback(() => {
		dragging.current = false;
	}, []);

	// The preview widens the drawer to 40 % of the window. Derived only: just
	// drags and keys go through `setWidth`, so `gui.panelWidth` keeps the
	// user's own width. Narrow windows dock at 50vw through global.css.
	const effectiveWidth =
		previewing && !compact
			? Math.max(
					width,
					Math.min(MAX_WIDTH, Math.round(viewportWidth * 0.4), Math.max(MIN_WIDTH, viewportWidth - 56)),
				)
			: width;

	// A narrow window docks the preview beside the chat, so the sidebar makes
	// room. The cleanup gives it back when the preview closes, the window
	// widens or the drawer unmounts (hiding the panel) — only a sidebar this
	// effect hid, and only if the user has not reopened it meanwhile.
	const hidSidebar = useRef(false);
	useEffect(() => {
		if (!compact || !previewing) return;
		const ui = useUiStore.getState();
		if (ui.sidebarVisible) {
			ui.toggleSidebar();
			hidSidebar.current = true;
		}
		return () => {
			if (!hidSidebar.current) return;
			hidSidebar.current = false;
			const current = useUiStore.getState();
			if (!current.sidebarVisible) current.toggleSidebar();
		};
	}, [compact, previewing]);

	return (
		<aside
			aria-busy={!routeReady}
			className={cx(
				"omp-inspector relative flex h-full flex-col border-l border-[var(--omp-border-muted)] bg-(--omp-bg-elevated)",
				(compact || split) && !previewing
					? "absolute inset-y-0 right-0 z-30 shadow-[var(--omp-shadow-lg)]"
					: "shrink-0",
				!routeReady && "pointer-events-none",
			)}
			data-docked-preview={previewing ? "" : undefined}
			style={{ width: effectiveWidth }}
		>
			<div className="flex shrink-0 items-start gap-3 px-4 pt-3.5">
				<div className="min-w-0 flex-1">
					<h2 className="font-display text-omp-xl font-semibold text-(--omp-text)">{t("panel.title")}</h2>
					<p className="mt-0.5 text-omp-md text-(--omp-muted)">{t("panel.subtitle")}</p>
				</div>
				<IconButton icon={<X size={15} />} label={t("panel.close")} onClick={togglePanel} size="sm" />
			</div>
			<div className="shrink-0 px-3 pt-1">
				<div className="flex items-center gap-0.5 overflow-x-auto border-b border-(--omp-border-muted)">
					{TABS.map(({ id, labelKey, icon: Icon }) => {
						const active = panelTab === id;
						return (
							<button
								key={id}
								aria-label={t(labelKey)}
								title={t(labelKey)}
								aria-pressed={active}
								type="button"
								onClick={() => setPanelTab(id)}
								className={cx(
									"omp-inspector-tab omp-pressable relative flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-3.5 pt-2.5 pb-3 text-omp-md",
									active
										? "font-semibold text-(--omp-accent) shadow-[inset_0_-2px_0_0_var(--omp-accent)]"
										: "font-medium text-(--omp-muted) hover:text-(--omp-text)",
								)}
							>
								<Icon size={14} />
								<span className="omp-inspector-tab-label">{t(labelKey)}</span>
							</button>
						);
					})}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				{panelTab === "files" && (
					<>
						{/* The tree stays mounted under a preview, so Back finds its folders,
						    search and listing as they were. */}
						<div className="h-full" hidden={previewing}>
							<PanelErrorBoundary key={`${activeTabId ?? "no-tab"}:files`}>
								<FilesPanel />
							</PanelErrorBoundary>
						</div>
						{/* A preview is pinned to its own tab: a pane-focus change must not
						    remount it. Its renderer boundary keys on the target inside. */}
						{previewing && (
							<PanelErrorBoundary key="preview">
								<FilePreviewPanel />
							</PanelErrorBoundary>
						)}
					</>
				)}
				{panelTab === "logs" && (
					<PanelErrorBoundary key={`${activeTabId ?? "no-tab"}:logs`}>
						<LogPanel />
					</PanelErrorBoundary>
				)}
			</div>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-valuemin={MIN_WIDTH}
				aria-valuemax={MAX_WIDTH}
				aria-valuenow={Math.round(effectiveWidth)}
				tabIndex={0}
				onPointerDown={startDrag}
				onPointerMove={onDrag}
				onPointerUp={endDrag}
				onKeyDown={event => {
					if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					const viewportLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 56));
					const max = Math.min(MAX_WIDTH, viewportLimit);
					// Step from what the aside shows: a preview's derived width, if wider.
					setWidth(current => {
						const from = previewing ? Math.max(current, effectiveWidth) : current;
						return event.key === "Home"
							? MIN_WIDTH
							: event.key === "End"
								? max
								: Math.min(max, Math.max(MIN_WIDTH, from + (event.key === "ArrowLeft" ? 24 : -24)));
					});
				}}
				className="absolute inset-y-0 left-0 z-10 w-1 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-[var(--omp-accent)]/40 active:bg-[var(--omp-accent)] max-[1000px]:hidden"
			/>
		</aside>
	);
}
