import { create } from "zustand";
import type { SessionInfo } from "../../shared/ipc-types";
import type { SidecarRestartProgress } from "../../shared/rpc-types";
import { KEYMAP_ACTIONS, type KeymapOverrides, sanitizeOverrides } from "../lib/keymap";
import { readPrepaintThemeMode, type ThemeMode } from "../lib/theme";

export type { ThemeMode };

export type PanelTab = "files" | "logs";

/** Panel tabs older builds could persist, mapped to the tab that replaces them. */
const RETIRED_PANEL_TABS: Readonly<Record<string, PanelTab>> = { diff: "files" };

/**
 * The workspace panel tab a persisted `defaultPanelTab` preference restores,
 * or null when the stored value names no tab.
 */
export function panelTabFromPref(value: unknown): PanelTab | null {
	if (value === "files" || value === "logs") return value;
	return typeof value === "string" && Object.hasOwn(RETIRED_PANEL_TABS, value) ? RETIRED_PANEL_TABS[value] : null;
}
/** Center-dock card identifiers: todo/plan/agents render as live cards above the composer. */
export type DockCardId = "todo" | "plan" | "agents";
export type TranscriptDetail = "compact" | "full";

/**
 * What the Files drawer previews: a file pinned to the tab that opened it (so
 * a relative path keeps resolving against that tab's workspace after a pane
 * focus change), or an in-memory image with no file on disk.
 */
export type PreviewTarget =
	| { kind: "path"; path: string; tabId: string | null }
	| { kind: "image"; id: number; dataUrl: string; name: string };

/** Gives each in-memory image target its own identity, so reopening remounts. */
let nextImagePreviewId = 0;

export interface GuiDisplayPreferences {
	hideThinkingBlock?: boolean | null;
	proseOnlyThinking?: boolean | null;
	showTokenUsage?: boolean | null;
	collapseCompacted?: boolean | null;
	titleState?: boolean | null;
	goalStatusInFooter?: boolean | null;
	showProgress?: boolean | null;
	emojiAutocomplete?: boolean | null;
	pasteMenuThreshold?: number | null;
}

interface UiStore {
	displayPreferences: GuiDisplayPreferences;
	sidebarVisible: boolean;
	panelVisible: boolean;
	panelTab: PanelTab;
	/** File or in-memory image currently shown in the Files drawer. */
	filePreview: PreviewTarget | null;
	/** Bumped when the previewed path target is opened again: the preview re-checks
	 * it (`ifChanged`) in place instead of remounting, since its target key is unchanged. */
	filePreviewRecheck: number;
	commandPaletteOpen: boolean;
	modelPickerOpen: boolean;
	settingsOpen: boolean;
	settingsTab: string;
	providersOpen: boolean;
	/** The local-model welcome screen (first run, or reopened from Settings › Ollama). */
	welcomeOpen: boolean;
	themePickerOpen: boolean;
	agentHubOpen: boolean;
	agentHubTab: "definitions" | "hub";
	hotkeysOpen: boolean;
	copySelectorOpen: boolean;
	changelogOpen: boolean;
	jobsOpen: boolean;
	btwRequest: string | null;
	composerEditorOpen: boolean;
	composerEditorInitial: string | null;
	renameDialogOpen: boolean;
	/** Live tab whose close is armed for confirmation: set by the chip's ×, ⌘W or
	 * the menu, so all three share one inline confirm (the second commit closes). */
	armedCloseTab: { tabId: string } | null;
	sessionPickerOpen: boolean;
	sessionInfoOpen: boolean;
	/** Session the user tried to open while the attached session was busy
	 * (streaming/compacting). Non-null shows the SessionSwitchDialog offering
	 * a parallel new tab (recommended) / new window vs abort-and-switch. */
	sessionSwitchPrompt: SessionInfo | null;
	sidecarError: string | null;
	/** Crash-loop progress carried by the status behind `sidecarError`: non-null
	 * while the sidecar is respawning itself, and on the terminal error once the
	 * attempts run out. Null for renderer-detected health failures. */
	sidecarRestart: SidecarRestartProgress | null;
	/** The banner was dismissed by the user. A new diagnostic — or the sidecar
	 * coming back — clears it; the one that was closed stays hidden. */
	sidecarDismissed: boolean;
	theme: ThemeMode;
	fontSize: number;
	/** Application-wide display preferences, independent of a task's terminal configuration. */
	compactDensity: boolean;
	colorBlindMode: boolean;
	followAgentTheme: boolean;
	/** Master switch for desktop notifications (Settings → GUI, default on). */
	notifications: boolean;
	/** Expand reasoning (thinking) blocks by default (Settings → GUI, default off). */
	thinkingExpanded: boolean;
	/** Transcript density: compact folds reasoning/tools; full shows every step. */
	transcriptDetail: TranscriptDetail;
	/** Expand/collapse-all signal for tool cards (⌃O); `seq` bumps per toggle so cards re-sync their local state. */
	toolsExpandAll: { expanded: boolean; seq: number };
	toggleSidebar: () => void;
	togglePanel: () => void;
	toggleToolsExpandAll: () => void;
	setPanelTab: (tab: PanelTab) => void;
	openFilePreview: (path: string, tabId?: string | null) => void;
	openImagePreview: (dataUrl: string, name: string) => void;
	closeFilePreview: () => void;
	/** Per-card collapse overrides for the center dock (absent = expanded). */
	dockCollapsed: Partial<Record<DockCardId, boolean>>;
	toggleDockCard: (id: DockCardId) => void;
	/** Focus signal: bumps seq so the target card expands and flashes (command-palette deep links). */
	dockFocus: { id: DockCardId; seq: number } | null;
	focusDockCard: (id: DockCardId) => void;
	openCommandPalette: () => void;
	closeCommandPalette: () => void;
	openModelPicker: () => void;
	closeModelPicker: () => void;
	openSettings: (tab?: string) => void;
	closeSettings: () => void;
	openProviders: () => void;
	closeProviders: () => void;
	openWelcome: () => void;
	closeWelcome: () => void;
	openThemePicker: () => void;
	closeThemePicker: () => void;
	openAgentHub: (tab?: "definitions" | "hub") => void;
	closeAgentHub: () => void;
	openHotkeys: () => void;
	closeHotkeys: () => void;
	openCopySelector: () => void;
	closeCopySelector: () => void;
	openChangelog: () => void;
	closeChangelog: () => void;
	openJobs: () => void;
	closeJobs: () => void;
	openBtw: (question: string) => void;
	closeBtw: () => void;
	openComposerEditor: (initial: string) => void;
	closeComposerEditor: () => void;
	openRenameDialog: () => void;
	closeRenameDialog: () => void;
	armCloseTab: (tabId: string) => void;
	cancelCloseTab: () => void;
	openSessionPicker: () => void;
	closeSessionPicker: () => void;
	openSessionInfo: () => void;
	closeSessionInfo: () => void;
	requestSessionSwitch: (session: SessionInfo) => void;
	closeSessionSwitch: () => void;
	/** Close UI whose data or actions belong to the outgoing tab. With
	 * `keepFilePreview` the preview stays: it is pinned to its own tab, so a
	 * focus change between split panes does not invalidate it. */
	closeSessionOverlays: (options?: { keepFilePreview?: boolean }) => void;
	/** In-flight sidebar/picker session switch: keep the outgoing transcript painted. */
	setSidecarError: (error: string | null, restart?: SidecarRestartProgress | null) => void;
	clearSidecarError: () => void;
	dismissSidecarBanner: () => void;
	setTheme: (theme: ThemeMode) => void;
	setFontSize: (size: number) => void;
	setNotifications: (enabled: boolean) => void;
	setThinkingExpanded: (enabled: boolean) => void;
	setTranscriptDetail: (detail: TranscriptDetail) => void;
	/**
	 * User keybinding overrides (B3 remap layer): actionId → replacement chord
	 * list, compiled with the defaults in lib/keymap.ts into the keydown
	 * dispatch map. GUI-local only — never synced to the TUI's keybindings.yml.
	 */
	keymapOverrides: KeymapOverrides;
	/** One-shot boot hydration guard for keymapOverrides (input-history pattern). */
	keymapHydrated: boolean;
	hydrateKeymap: () => Promise<void>;
	/** Replace one action's chords; an empty list removes the override (reset to default). */
	setKeymapOverride: (actionId: string, chords: string[]) => void;
	resetKeymapOverrides: () => void;
}

export const useUiStore = create<UiStore>()((set, get) => ({
	displayPreferences: {},
	sidebarVisible: true,
	panelVisible: false,
	panelTab: "files",
	filePreview: null,
	filePreviewRecheck: 0,
	commandPaletteOpen: false,
	modelPickerOpen: false,
	settingsOpen: false,
	settingsTab: "capabilities",
	theme: readPrepaintThemeMode(),
	fontSize: 15,
	compactDensity: false,
	colorBlindMode: false,
	followAgentTheme: false,
	notifications: true,
	thinkingExpanded: false,
	transcriptDetail: "compact",
	toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
	togglePanel: () => set({ panelVisible: !get().panelVisible }),
	toolsExpandAll: { expanded: false, seq: 0 },
	toggleToolsExpandAll: () =>
		set({ toolsExpandAll: { expanded: !get().toolsExpandAll.expanded, seq: get().toolsExpandAll.seq + 1 } }),
	setPanelTab: tab => set({ panelTab: tab, panelVisible: true }),
	openFilePreview: (path, tabId = null) => {
		const current = get().filePreview;
		if (current?.kind === "path" && current.path === path && current.tabId === tabId) {
			set({ filePreviewRecheck: get().filePreviewRecheck + 1, panelTab: "files", panelVisible: true });
			return;
		}
		set({ filePreview: { kind: "path", path, tabId }, panelTab: "files", panelVisible: true });
	},
	openImagePreview: (dataUrl, name) => {
		nextImagePreviewId += 1;
		set({
			filePreview: { kind: "image", id: nextImagePreviewId, dataUrl, name },
			panelTab: "files",
			panelVisible: true,
		});
	},
	closeFilePreview: () => set({ filePreview: null }),
	dockCollapsed: {},
	toggleDockCard: id =>
		set({
			dockCollapsed: { ...get().dockCollapsed, [id]: !(get().dockCollapsed[id] ?? false) },
		}),
	dockFocus: null,
	focusDockCard: id =>
		set({
			dockCollapsed: { ...get().dockCollapsed, [id]: false },
			dockFocus: { id, seq: (get().dockFocus?.seq ?? 0) + 1 },
		}),
	openCommandPalette: () => set({ commandPaletteOpen: true }),
	closeCommandPalette: () => set({ commandPaletteOpen: false }),
	openModelPicker: () => set({ modelPickerOpen: true }),
	closeModelPicker: () => set({ modelPickerOpen: false }),
	// Without an explicit target, a window that is already open stays on its
	// page: ⌘, pressed again must not bounce the user back to the first tab (and
	// wipe the search they typed).
	openSettings: tab =>
		set(state => ({
			settingsOpen: true,
			settingsTab: tab ?? (state.settingsOpen ? state.settingsTab : "capabilities"),
		})),
	closeSettings: () => set({ settingsOpen: false }),
	providersOpen: false,
	openProviders: () => set({ providersOpen: true }),
	closeProviders: () => set({ providersOpen: false }),
	welcomeOpen: false,
	openWelcome: () => set({ welcomeOpen: true }),
	closeWelcome: () => set({ welcomeOpen: false }),
	themePickerOpen: false,
	openThemePicker: () => set({ themePickerOpen: true }),
	closeThemePicker: () => set({ themePickerOpen: false }),
	agentHubOpen: false,
	agentHubTab: "definitions" as const,
	openAgentHub: tab => set({ agentHubOpen: true, agentHubTab: tab ?? "definitions" }),
	closeAgentHub: () => set({ agentHubOpen: false }),
	hotkeysOpen: false,
	openHotkeys: () => set({ hotkeysOpen: true }),
	closeHotkeys: () => set({ hotkeysOpen: false }),
	copySelectorOpen: false,
	openCopySelector: () => set({ copySelectorOpen: true }),
	closeCopySelector: () => set({ copySelectorOpen: false }),
	changelogOpen: false,
	openChangelog: () => set({ changelogOpen: true }),
	closeChangelog: () => set({ changelogOpen: false }),
	jobsOpen: false,
	openJobs: () => set({ jobsOpen: true }),
	closeJobs: () => set({ jobsOpen: false }),
	btwRequest: null,
	openBtw: question => set({ btwRequest: question }),
	closeBtw: () => set({ btwRequest: null }),
	composerEditorOpen: false,
	composerEditorInitial: null,
	openComposerEditor: initial => set({ composerEditorOpen: true, composerEditorInitial: initial }),
	closeComposerEditor: () => set({ composerEditorOpen: false, composerEditorInitial: null }),
	renameDialogOpen: false,
	openRenameDialog: () => set({ renameDialogOpen: true }),
	closeRenameDialog: () => set({ renameDialogOpen: false }),
	armedCloseTab: null,
	armCloseTab: tabId => set({ armedCloseTab: { tabId } }),
	cancelCloseTab: () => set({ armedCloseTab: null }),
	sessionPickerOpen: false,
	openSessionPicker: () => set({ sessionPickerOpen: true }),
	closeSessionPicker: () => set({ sessionPickerOpen: false }),
	sessionInfoOpen: false,
	openSessionInfo: () => set({ sessionInfoOpen: true }),
	closeSessionInfo: () => set({ sessionInfoOpen: false }),
	sessionSwitchPrompt: null as SessionInfo | null,
	requestSessionSwitch: session => set({ sessionSwitchPrompt: session }),
	closeSessionSwitch: () => set({ sessionSwitchPrompt: null }),
	closeSessionOverlays: (options = {}) =>
		set({
			...(options.keepFilePreview ? {} : { filePreview: null }),
			commandPaletteOpen: false,
			modelPickerOpen: false,
			settingsOpen: false,
			agentHubOpen: false,
			copySelectorOpen: false,
			jobsOpen: false,
			btwRequest: null,
			composerEditorOpen: false,
			composerEditorInitial: null,
			renameDialogOpen: false,
			armedCloseTab: null,
			sessionPickerOpen: false,
			sessionInfoOpen: false,
			sessionSwitchPrompt: null,
		}),
	sidecarError: null as string | null,
	sidecarRestart: null as SidecarRestartProgress | null,
	sidecarDismissed: false,
	setSidecarError: (error, restart = null) =>
		set({ sidecarError: error, sidecarRestart: restart, sidecarDismissed: false }),
	clearSidecarError: () => set({ sidecarError: null, sidecarRestart: null, sidecarDismissed: false }),
	dismissSidecarBanner: () => set({ sidecarDismissed: true }),
	setTheme: theme => set({ theme }),
	setFontSize: size => set({ fontSize: size }),
	setNotifications: enabled => set({ notifications: enabled }),
	setThinkingExpanded: enabled => set({ thinkingExpanded: enabled }),
	setTranscriptDetail: detail => set({ transcriptDetail: detail }),
	keymapOverrides: {} as KeymapOverrides,
	keymapHydrated: false,
	hydrateKeymap: async () => {
		if (get().keymapHydrated) return;
		try {
			const raw = await window.omp.prefs.get("keymapOverrides");
			set({ keymapOverrides: sanitizeOverrides(KEYMAP_ACTIONS, raw), keymapHydrated: true });
		} catch {
			// prefs IPC unavailable (tests, storybook) — defaults stay in effect.
			set({ keymapHydrated: true });
		}
	},
	setKeymapOverride: (actionId, chords) => {
		// Fresh object per mutation so subscribers (and App's compiled-map memo)
		// see a new reference; untouched overrides keep their identity.
		const next = { ...get().keymapOverrides };
		if (chords.length === 0) delete next[actionId];
		else next[actionId] = chords;
		set({ keymapOverrides: next });
		void window.omp.prefs.set("keymapOverrides", next).catch(() => {});
	},
	resetKeymapOverrides: () => {
		set({ keymapOverrides: {} });
		void window.omp.prefs.set("keymapOverrides", {}).catch(() => {});
	},
}));
