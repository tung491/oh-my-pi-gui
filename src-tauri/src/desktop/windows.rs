//! The window manager, ported from `src/main/window.ts` and the window parts of
//! `src/main/index.ts`. Every native call goes through the private [`Backend`]
//! trait: the Tauri implementation drives `webview::build_window`, the tray
//! and the menu; tests install a fake so every decision runs without a runtime.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::tab_layout::{sanitize_persisted_tab_layouts, DiskPathChecks};
use super::window_bounds::{restore_within_displays, Rect};
use super::{lock, survive, Desktop, Platform};
use crate::bridge;
use crate::ctx::AppCtx;
use crate::ports::{AcquireOptions, PersistedTabLayout, RunProgressState, SessionKind, WindowId, WindowRecord};
use crate::runtime_log;

const DEFAULT_WIDTH: f64 = 1400.0;
const DEFAULT_HEIGHT: f64 = 900.0;
pub(crate) const MIN_WIDTH: f64 = 800.0;
pub(crate) const MIN_HEIGHT: f64 = 600.0;
/// Parallel windows share one saved geometry; each additional one is offset by this many pixels.
const CASCADE_STEP: f64 = 28.0;
/// Bounds are written this long after the last move or resize.
pub(crate) const PERSIST_DEBOUNCE: Duration = Duration::from_millis(500);
const WINDOW_STATE_KEY: &str = "windowState";

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

/// What the window system reports about one of our windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WinEvent {
    Moved,
    Resized,
    CloseRequested,
    Destroyed,
    Focused(bool),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MainWindowSpec {
    pub win_id: WindowId,
    pub size: (f64, f64),
    pub position: Option<(f64, f64)>,
    pub maximize: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct QuickEntrySpec {
    pub position: Option<(f64, f64)>,
    pub dark: bool,
}

/// Standard items the OS renders itself (Electron's menu roles).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PredefinedItem {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Maximize,
    Fullscreen,
    Quit,
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
}

/// A menu as pure data, so the tray and app menus are built and tested without a runtime.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum MenuItemModel {
    Item { id: String, label: String, enabled: bool, accelerator: Option<String> },
    Check { id: String, label: String, checked: bool, enabled: bool },
    Separator,
    Submenu { label: String, items: Vec<MenuItemModel> },
    Predefined(PredefinedItem),
}

impl MenuItemModel {
    pub(crate) fn item(id: impl Into<String>, label: impl Into<String>) -> Self {
        MenuItemModel::Item { id: id.into(), label: label.into(), enabled: true, accelerator: None }
    }

    pub(crate) fn disabled(label: impl Into<String>) -> Self {
        MenuItemModel::Item { id: String::new(), label: label.into(), enabled: false, accelerator: None }
    }

    pub(crate) fn with_accelerator(self, accelerator: Option<&str>) -> Self {
        match self {
            MenuItemModel::Item { id, label, enabled, .. } => MenuItemModel::Item { id, label, enabled, accelerator: accelerator.map(str::to_string) },
            other => other,
        }
    }

    pub(crate) fn submenu(label: impl Into<String>, items: Vec<MenuItemModel>) -> Self {
        MenuItemModel::Submenu { label: label.into(), items }
    }
}

/// The native surface: windows, monitors, tray, menu, and the environment
/// probes the decisions need. One implementation drives Tauri; tests fake it.
pub(crate) trait Backend: Send + Sync {
    fn platform(&self) -> Platform;
    fn packaged(&self) -> bool;
    fn build_main_window(&self, spec: MainWindowSpec) -> Result<(), String>;
    fn build_quick_entry_window(&self, spec: QuickEntrySpec) -> Result<(), String>;
    fn exists(&self, id: WindowId) -> bool;
    fn show(&self, id: WindowId);
    fn hide(&self, id: WindowId);
    /// Unminimize, show and focus.
    fn focus(&self, id: WindowId);
    /// Ask the window to close (its `CloseRequested` runs first).
    fn close(&self, id: WindowId);
    fn destroy(&self, id: WindowId);
    fn is_visible(&self, id: WindowId) -> bool;
    fn is_minimized(&self, id: WindowId) -> bool;
    fn is_maximized(&self, id: WindowId) -> bool;
    fn focused_window(&self) -> Option<WindowId>;
    /// Outer position and inner size, in logical pixels.
    fn bounds(&self, id: WindowId) -> Option<Rect>;
    fn set_bounds(&self, id: WindowId, bounds: Rect);
    /// Work areas with the primary display first (the recentering target).
    fn work_areas(&self) -> Vec<Rect>;
    fn work_area_at_cursor(&self) -> Option<Rect>;
    fn prefers_dark(&self) -> bool;
    /// Taskbar progress in percent; `None` clears it.
    fn set_progress(&self, id: WindowId, percent: Option<u64>);
    /// macOS dock badge; `None` clears it.
    fn set_badge(&self, label: Option<String>);
    fn install_tray(&self, tooltip: &str, menu: &[MenuItemModel]) -> Result<(), String>;
    fn set_tray_tooltip(&self, tooltip: &str);
    fn set_tray_menu(&self, menu: &[MenuItemModel]) -> Result<(), String>;
    fn destroy_tray(&self);
    fn set_app_menu(&self, menu: &[MenuItemModel]) -> Result<(), String>;
    /// Register the `omp` scheme with the desktop (release builds on Linux).
    /// Only compiled-in callers are release builds, so debug builds never use it.
    #[cfg_attr(debug_assertions, allow(dead_code))]
    fn register_deep_link_scheme(&self) -> Result<(), String>;
    /// URLs the deep-link plugin holds at launch: the OS handoff on macOS, an argv copy elsewhere.
    fn startup_urls(&self) -> Vec<String>;
    fn default_workspace(&self) -> std::io::Result<PathBuf>;
    fn directory_exists(&self, path: &str) -> bool;
    fn initial_cwd(&self, candidates: &[Option<String>]) -> Option<String>;
    fn home_dir(&self) -> Option<PathBuf>;
    fn argv(&self) -> Vec<String>;
    fn env(&self) -> super::wayland_portal::Env;
}

// ---------------------------------------------------------------------------
// Saved geometry
// ---------------------------------------------------------------------------

/// `windowState` in `window-state.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedWindowState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_maximized: Option<bool>,
}

impl Default for SavedWindowState {
    fn default() -> Self {
        Self { x: None, y: None, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, is_maximized: None }
    }
}

/// The geometry a new window opens with: the saved one, cascaded for parallel
/// windows and pulled back onto an attached display.
pub(crate) fn startup_geometry(saved: &SavedWindowState, cascade: usize, work_areas: &[Rect]) -> MainWindowSpec {
    let offset = cascade as f64 * CASCADE_STEP;
    let (position, size) = match (saved.x, saved.y) {
        (Some(x), Some(y)) => {
            let rect = restore_within_displays(Rect { x: x + offset, y: y + offset, width: saved.width, height: saved.height }, work_areas);
            (Some((rect.x, rect.y)), (rect.width, rect.height))
        }
        _ => (None, (saved.width, saved.height)),
    };
    MainWindowSpec { win_id: WindowId(0), size, position, maximize: saved.is_maximized == Some(true) }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

struct Record {
    record: WindowRecord,
    /// The last bounds the window reported, read on the main thread as it moved.
    last_bounds: Option<Rect>,
    maximized: bool,
    /// Bumped on every move; a debounced write persists only the latest.
    persist_generation: u64,
}

#[derive(Default)]
struct RegistryState {
    records: BTreeMap<WindowId, Record>,
    next_id: u32,
    /// Focus history, most recent last.
    focus_order: Vec<WindowId>,
    /// The chat window that currently has focus, from the window system's events.
    focused: Option<WindowId>,
}

/// The chat windows and their persisted geometry.
pub(crate) struct WindowRegistry {
    state: Mutex<RegistryState>,
    persist_counter: AtomicU64,
}

impl WindowRegistry {
    pub(crate) fn new() -> Self {
        Self { state: Mutex::new(RegistryState { next_id: 1, ..Default::default() }), persist_counter: AtomicU64::new(0) }
    }

    pub(crate) fn records(&self) -> Vec<WindowRecord> {
        lock(&self.state).records.values().map(|entry| entry.record.clone()).collect()
    }

    pub(crate) fn ids(&self) -> Vec<WindowId> {
        lock(&self.state).records.keys().copied().collect()
    }

    pub(crate) fn record(&self, win_id: WindowId) -> Option<WindowRecord> {
        lock(&self.state).records.get(&win_id).map(|entry| entry.record.clone())
    }

    pub(crate) fn is_record(&self, win_id: WindowId) -> bool {
        lock(&self.state).records.contains_key(&win_id)
    }

    pub(crate) fn count(&self) -> usize {
        lock(&self.state).records.len()
    }

    /// The most recently focused live window, else the first one.
    pub(crate) fn main_window(&self) -> Option<WindowId> {
        let state = lock(&self.state);
        state.focus_order.iter().rev().find(|id| state.records.contains_key(id)).copied().or_else(|| state.records.keys().next().copied())
    }

    /// The focused chat window, else the main window.
    pub(crate) fn target_window(&self) -> Option<WindowId> {
        let focused = {
            let state = lock(&self.state);
            state.focused.filter(|id| state.records.contains_key(id))
        };
        focused.or_else(|| self.main_window())
    }

    pub(crate) fn focused(&self) -> Option<WindowId> {
        lock(&self.state).focused
    }

    pub(crate) fn set_cwd(&self, win_id: WindowId, cwd: &str) {
        if let Some(entry) = lock(&self.state).records.get_mut(&win_id) {
            entry.record.cwd = cwd.to_string();
        }
    }

    pub(crate) fn consume_pending_session(&self, win_id: WindowId) -> Option<String> {
        lock(&self.state).records.get_mut(&win_id).and_then(|entry| entry.record.pending_session_path.take())
    }

    fn insert(&self, cwd: String, pending_session_path: Option<String>) -> WindowId {
        let mut state = lock(&self.state);
        let id = WindowId(state.next_id);
        state.next_id += 1;
        state.records.insert(
            id,
            Record {
                record: WindowRecord { id, cwd, pending_session_path },
                last_bounds: None,
                maximized: false,
                persist_generation: 0,
            },
        );
        state.focus_order.push(id);
        id
    }

    pub(crate) fn remove(&self, win_id: WindowId) -> Option<WindowRecord> {
        let mut state = lock(&self.state);
        state.focus_order.retain(|id| *id != win_id);
        if state.focused == Some(win_id) {
            state.focused = None;
        }
        state.records.remove(&win_id).map(|entry| entry.record)
    }

    pub(crate) fn note_focus(&self, win_id: WindowId, focused: bool) {
        let mut state = lock(&self.state);
        if focused {
            if state.records.contains_key(&win_id) {
                state.focus_order.retain(|id| *id != win_id);
                state.focus_order.push(win_id);
                state.focused = Some(win_id);
            }
        } else if state.focused == Some(win_id) {
            state.focused = None;
        }
    }

    /// Remember the geometry the window just reported; returns the generation a debounced write must match.
    fn note_bounds(&self, win_id: WindowId, bounds: Option<Rect>, maximized: bool) -> Option<u64> {
        let mut state = lock(&self.state);
        let entry = state.records.get_mut(&win_id)?;
        if bounds.is_some() {
            entry.last_bounds = bounds;
        }
        entry.maximized = maximized;
        entry.persist_generation = self.persist_counter.fetch_add(1, Ordering::Relaxed) + 1;
        Some(entry.persist_generation)
    }

    fn saved_state_for(&self, win_id: WindowId, generation: Option<u64>) -> Option<SavedWindowState> {
        let state = lock(&self.state);
        let entry = state.records.get(&win_id)?;
        if generation.is_some_and(|generation| generation != entry.persist_generation) {
            return None;
        }
        let bounds = entry.last_bounds?;
        Some(SavedWindowState { x: Some(bounds.x), y: Some(bounds.y), width: bounds.width, height: bounds.height, is_maximized: Some(entry.maximized) })
    }
}

// ---------------------------------------------------------------------------
// Spawning and persistence (the `Desktop` methods that touch windows)
// ---------------------------------------------------------------------------

/// `resolveWindowSpawnTarget`: a window created without an explicit workspace
/// or session starts a full agent in the GUI-owned Work workspace with a fresh,
/// disposable tab; everything else keeps its selected or fallback cwd.
pub(crate) struct SpawnTarget {
    pub cwd: String,
    pub kind: SessionKind,
    pub fresh: bool,
    pub placeholder: bool,
}

pub(crate) fn resolve_spawn_target(
    cwd: Option<&str>,
    pending_session_path: Option<&str>,
    kind: Option<SessionKind>,
    fallback_cwd: &str,
    default_workspace: &str,
) -> SpawnTarget {
    if cwd.is_none() && pending_session_path.is_none() && kind.is_none() {
        return SpawnTarget { cwd: default_workspace.to_string(), kind: SessionKind::Agent, fresh: true, placeholder: true };
    }
    SpawnTarget {
        cwd: cwd.filter(|cwd| !cwd.is_empty()).unwrap_or(fallback_cwd).to_string(),
        kind: kind.unwrap_or_default(),
        fresh: false,
        placeholder: false,
    }
}

impl Desktop {
    /// `resolveInitialCwd` without the argv part: the last project, then the
    /// process cwd, then the home directory.
    pub(crate) fn initial_cwd(&self, ctx: &AppCtx) -> String {
        let candidates = [ctx.prefs.get_string("lastProject"), std::env::current_dir().ok().map(|dir| dir.to_string_lossy().to_string())];
        self.backend
            .initial_cwd(&candidates)
            .or_else(|| self.backend.home_dir().map(|home| home.to_string_lossy().to_string()))
            .unwrap_or_else(|| "/".to_string())
    }

    fn default_workspace(&self) -> Option<String> {
        match self.backend.default_workspace() {
            Ok(path) => Some(path.to_string_lossy().to_string()),
            Err(error) => {
                runtime_log::note("unknown", format!("could not create the Work workspace: {error}"), json!({}));
                None
            }
        }
    }

    /// Build a chat window at the saved geometry, cascaded, and register its record.
    pub(crate) fn create_window(&self, ctx: &AppCtx, cwd: String, pending_session_path: Option<String>) -> Option<WindowId> {
        let saved: SavedWindowState = ctx
            .window_state
            .get(WINDOW_STATE_KEY)
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        let cascade = self.windows.count();
        let mut spec = startup_geometry(&saved, cascade, &self.backend.work_areas());
        let win_id = self.windows.insert(cwd, pending_session_path);
        spec.win_id = win_id;
        if let Err(error) = self.backend.build_main_window(spec) {
            runtime_log::note("unknown", format!("could not build window {win_id}: {error}"), json!({ "winId": win_id.0 }));
            self.windows.remove(win_id);
            return None;
        }
        Some(win_id)
    }

    /// Reopen one saved window: its tabs in order, at the layout's active cwd.
    pub(crate) fn spawn_window_with_layout(&self, ctx: &AppCtx, layout: PersistedTabLayout) -> Option<WindowId> {
        let active_cwd = layout.tabs.get(layout.active_index).or_else(|| layout.tabs.first()).map(|tab| tab.cwd.clone())?;
        let win_id = self.create_window(ctx, active_cwd, None)?;
        let restored = survive("tabs.restore_layout", || ctx.tabs.restore_layout(win_id, layout)).unwrap_or(0);
        if restored > 0 {
            return Some(win_id);
        }
        self.discard_window(win_id);
        None
    }

    /// A window whose first tab never came: forget it now and let it close.
    fn discard_window(&self, win_id: WindowId) {
        self.windows.remove(win_id);
        self.backend.close(win_id);
    }

    /// The saved session: one tab layout per window, in both the current and the pre-multi-window shape.
    pub(crate) fn read_saved_tab_layouts(ctx: &AppCtx) -> Vec<PersistedTabLayout> {
        let layouts = sanitize_persisted_tab_layouts(ctx.prefs.get("tabLayouts").as_ref(), &DiskPathChecks);
        if !layouts.is_empty() {
            return layouts;
        }
        sanitize_persisted_tab_layouts(ctx.prefs.get("tabLayout").as_ref(), &DiskPathChecks)
    }

    /// `spawnWindow`: with no target, restore the saved session's first window
    /// or open the Work workspace; explicit requests keep their cwd and kind.
    pub(crate) fn spawn_window_in(&self, ctx: &AppCtx, cwd: Option<String>, pending_session_path: Option<String>, kind: Option<SessionKind>) -> Option<WindowId> {
        let restore_saved_layout = cwd.is_none() && pending_session_path.is_none() && kind.is_none();
        if restore_saved_layout {
            if let Some(saved) = Self::read_saved_tab_layouts(ctx).into_iter().next() {
                if let Some(win_id) = self.spawn_window_with_layout(ctx, saved) {
                    return Some(win_id);
                }
            }
        }
        if survive("tabs.at_cap", || ctx.tabs.at_cap()).unwrap_or(false) {
            return None;
        }
        let fallback = self.initial_cwd(ctx);
        let workspace = self.default_workspace().unwrap_or_else(|| fallback.clone());
        let target = resolve_spawn_target(cwd.as_deref(), pending_session_path.as_deref(), kind, &fallback, &workspace);
        let win_id = self.create_window(ctx, target.cwd.clone(), pending_session_path)?;
        let options = AcquireOptions {
            kind: target.kind,
            fresh: target.fresh,
            placeholder: target.placeholder,
            ..AcquireOptions::new(target.cwd, win_id)
        };
        match survive("tabs.acquire", || ctx.tabs.acquire(options)).flatten() {
            Some(_) => Some(win_id),
            None => {
                self.discard_window(win_id);
                None
            }
        }
    }

    /// Rewrite the saved session from the live windows. Skipped while quitting,
    /// so a three-window session restores as three windows, and never written
    /// empty: no live window means the app is quitting, not that the session ended.
    pub(crate) fn persist_tab_layouts(&self, ctx: &AppCtx) {
        if self.is_quitting_latched() {
            return;
        }
        let Some(layouts) = collect_layouts(&self.windows.ids(), |id| ctx.tabs.tab_layout_for_window(id)) else {
            runtime_log::note("unknown", "tab layouts not saved: a window's layout could not be read", json!({}));
            return;
        };
        if layouts.is_empty() {
            return;
        }
        let value = match serde_json::to_value(&layouts) {
            Ok(value) => value,
            Err(error) => {
                runtime_log::note("unknown", format!("could not serialize the tab layouts: {error}"), json!({}));
                return;
            }
        };
        if let Err(error) = ctx.prefs.set("tabLayouts", value) {
            runtime_log::note("unknown", format!("could not save the tab layouts: {error}"), json!({}));
            return;
        }
        if let Err(error) = ctx.prefs.delete("tabLayout") {
            runtime_log::note("unknown", format!("could not drop the legacy tab layout: {error}"), json!({}));
        }
    }

    /// A window moved or resized: remember its geometry now (on the thread that
    /// reported it) and write it after the debounce if nothing newer arrived.
    pub(crate) fn note_window_geometry(&self, win_id: WindowId) {
        let bounds = self.backend.bounds(win_id);
        let maximized = self.backend.is_maximized(win_id);
        let Some(generation) = self.windows.note_bounds(win_id, bounds, maximized) else { return };
        let ctx = self.ctx.clone();
        bridge::spawn_task(async move {
            tokio::time::sleep(PERSIST_DEBOUNCE).await;
            if let Some(ctx) = ctx.upgrade() {
                if let Some(desktop) = Self::of(&ctx) {
                    desktop.persist_window_state(&ctx, win_id, Some(generation));
                }
            }
        });
    }

    /// Write the remembered geometry; with a generation, only when it is still the latest.
    pub(crate) fn persist_window_state(&self, ctx: &AppCtx, win_id: WindowId, generation: Option<u64>) {
        let Some(saved) = self.windows.saved_state_for(win_id, generation) else { return };
        let value = match serde_json::to_value(&saved) {
            Ok(value) => value,
            Err(_) => return,
        };
        if let Err(error) = ctx.window_state.set(WINDOW_STATE_KEY, value) {
            runtime_log::note("unknown", format!("could not save the window state: {error}"), json!({ "winId": win_id.0 }));
        }
    }

    /// Run-progress indicator: dock badge (macOS) plus a progress bar on every window.
    pub(crate) fn apply_run_progress(&self, state: RunProgressState) {
        let (badge, percent) = match state {
            RunProgressState::Working => (Some("●".to_string()), Some(50)),
            RunProgressState::Waiting => (Some("!".to_string()), Some(75)),
            RunProgressState::Idle => (None, None),
        };
        if self.backend.platform() == Platform::Darwin {
            self.backend.set_badge(badge);
        }
        for id in self.windows.ids() {
            self.backend.set_progress(id, percent);
        }
    }

    /// Collapse per-window run-progress to one: any working > waiting > idle.
    pub(crate) fn aggregate_progress(states: impl IntoIterator<Item = RunProgressState>) -> RunProgressState {
        let mut waiting = false;
        for state in states {
            match state {
                RunProgressState::Working => return RunProgressState::Working,
                RunProgressState::Waiting => waiting = true,
                RunProgressState::Idle => {}
            }
        }
        if waiting {
            RunProgressState::Waiting
        } else {
            RunProgressState::Idle
        }
    }
}

/// Every live window's layout, in window order. `None` when any query failed:
/// a partial list would be saved as the whole session and lose the other windows.
pub(crate) fn collect_layouts(ids: &[WindowId], query: impl Fn(WindowId) -> Option<PersistedTabLayout>) -> Option<Vec<PersistedTabLayout>> {
    let mut layouts = Vec::new();
    for id in ids {
        layouts.extend(survive("tabs.tab_layout_for_window", || query(*id))?);
    }
    Some(layouts)
}

/// `windowState` as JSON.
#[cfg(test)]
pub(crate) fn saved_state_value(ctx: &AppCtx) -> Option<serde_json::Value> {
    ctx.window_state.get(WINDOW_STATE_KEY)
}

// ---------------------------------------------------------------------------
// Tauri backend
// ---------------------------------------------------------------------------

pub(crate) use tauri_backend::TauriBackend;

mod tauri_backend {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
    use tauri_plugin_deep_link::DeepLinkExt;

    use super::{Backend, MainWindowSpec, MenuItemModel, QuickEntrySpec, WinEvent};
    use crate::desktop::quick_entry_core::QUICK_ENTRY_SIZE;
    use crate::desktop::window_bounds::Rect;
    use crate::desktop::{lock, menu, survive, tray, Desktop, Platform};
    use crate::ports::{CtxRef, WindowId, WindowKind};
    use crate::webview::{self, WindowSpec};
    use crate::{paths, product};

    /// The production backend: Tauri windows through `webview::build_window`.
    pub(crate) struct TauriBackend {
        app: AppHandle,
        ctx: CtxRef,
        tray: Mutex<Option<tauri::tray::TrayIcon>>,
    }

    impl TauriBackend {
        pub(crate) fn new(app: AppHandle, ctx: CtxRef) -> Self {
            Self { app, ctx, tray: Mutex::new(None) }
        }

        fn window(&self, id: WindowId) -> Option<WebviewWindow> {
            self.app.get_webview_window(&id.label())
        }

        /// Route a window's events to the desktop module; `CloseRequested` may be vetoed.
        fn observe(&self, window: &WebviewWindow, id: WindowId) {
            let ctx = self.ctx.clone();
            window.on_window_event(move |event| {
                survive("window event", || Self::route_window_event(&ctx, id, event));
            });
        }

        fn route_window_event(ctx: &CtxRef, id: WindowId, event: &WindowEvent) {
            {
                let mapped = match event {
                    WindowEvent::Moved(_) => WinEvent::Moved,
                    WindowEvent::Resized(_) => WinEvent::Resized,
                    WindowEvent::CloseRequested { .. } => WinEvent::CloseRequested,
                    WindowEvent::Destroyed => WinEvent::Destroyed,
                    WindowEvent::Focused(focused) => WinEvent::Focused(*focused),
                    _ => return,
                };
                let Some(ctx) = ctx.upgrade() else { return };
                let Some(desktop) = Desktop::of(&ctx) else { return };
                let prevent_close = desktop.on_window_event(&ctx, id, mapped);
                if let (true, WindowEvent::CloseRequested { api, .. }) = (prevent_close, event) {
                    api.prevent_close();
                }
            }
        }

        fn logical_rect(window: &WebviewWindow) -> Option<Rect> {
            let scale = window.scale_factor().ok()?;
            let position = window.outer_position().ok()?.to_logical::<f64>(scale);
            let size = window.inner_size().ok()?.to_logical::<f64>(scale);
            Some(Rect { x: position.x, y: position.y, width: size.width, height: size.height })
        }

        fn monitor_rect(monitor: &tauri::Monitor) -> Rect {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let position = area.position.to_logical::<f64>(scale);
            let size = area.size.to_logical::<f64>(scale);
            Rect { x: position.x, y: position.y, width: size.width, height: size.height }
        }

        fn window_icon(&self) -> Option<tauri::image::Image<'static>> {
            if let Some(icon) = self.app.default_window_icon() {
                return Some(tauri::image::Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height()));
            }
            let path = crate::desktop::app_icons::linux_window_icon_path(
                Platform::current(),
                self.packaged(),
                &self.app.path().resource_dir().unwrap_or_default(),
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."),
            )?;
            tauri::image::Image::from_path(path).ok()
        }
    }

    impl Backend for TauriBackend {
        fn platform(&self) -> Platform {
            Platform::current()
        }

        fn packaged(&self) -> bool {
            !cfg!(debug_assertions)
        }

        fn build_main_window(&self, spec: MainWindowSpec) -> Result<(), String> {
            let window = webview::build_window(
                &self.app,
                WindowSpec {
                    kind: WindowKind::Main,
                    win_id: spec.win_id,
                    url: "index.html",
                    title: product::PRODUCT_NAME.into(),
                    inner_size: spec.size,
                    min_inner_size: Some((super::MIN_WIDTH, super::MIN_HEIGHT)),
                    position: spec.position,
                    background_color: Some(tauri::window::Color(0x0a, 0x1a, 0x33, 0xff)),
                    ..Default::default()
                },
            )
            .map_err(|error| error.to_string())?;
            self.observe(&window, spec.win_id);
            if let Some(icon) = self.window_icon() {
                let _ = window.set_icon(icon);
            }
            if spec.maximize {
                let _ = window.maximize();
            }
            Ok(())
        }

        fn build_quick_entry_window(&self, spec: QuickEntrySpec) -> Result<(), String> {
            let color = if spec.dark { tauri::window::Color(0x0a, 0x1a, 0x33, 0xff) } else { tauri::window::Color(0xf7, 0xf9, 0xfc, 0xff) };
            let size = (QUICK_ENTRY_SIZE.width, QUICK_ENTRY_SIZE.height);
            let window = webview::build_window(
                &self.app,
                WindowSpec {
                    kind: WindowKind::QuickEntry,
                    win_id: WindowId::QUICK_ENTRY,
                    url: "quick-entry.html",
                    title: product::PRODUCT_NAME.into(),
                    inner_size: size,
                    // Equal min and max pin the size; `resizable(false)` would grow it to 680×200 on GTK.
                    min_inner_size: Some(size),
                    max_inner_size: Some(size),
                    position: spec.position,
                    visible: false,
                    decorations: false,
                    minimizable: false,
                    maximizable: false,
                    skip_taskbar: true,
                    always_on_top: true,
                    focused: true,
                    background_color: Some(color),
                    ..Default::default()
                },
            )
            .map_err(|error| error.to_string())?;
            self.observe(&window, WindowId::QUICK_ENTRY);
            #[cfg(not(target_os = "macos"))]
            {
                let _ = window.remove_menu();
            }
            #[cfg(target_os = "macos")]
            {
                // A non-activating panel floats over full-screen apps on every Space.
                use tauri_nspanel::WebviewWindowExt;
                if let Ok(panel) = window.to_panel() {
                    const NS_NONACTIVATING_PANEL_MASK: i32 = 1 << 7;
                    panel.set_style_mask(NS_NONACTIVATING_PANEL_MASK);
                    panel.set_hides_on_deactivate(false);
                }
            }
            Ok(())
        }

        fn exists(&self, id: WindowId) -> bool {
            self.window(id).is_some()
        }

        fn show(&self, id: WindowId) {
            if let Some(window) = self.window(id) {
                let _ = window.show();
            }
        }

        fn hide(&self, id: WindowId) {
            if let Some(window) = self.window(id) {
                let _ = window.hide();
            }
        }

        fn focus(&self, id: WindowId) {
            if let Some(window) = self.window(id) {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
        }

        fn close(&self, id: WindowId) {
            if let Some(window) = self.window(id) {
                let _ = window.close();
            }
        }

        fn destroy(&self, id: WindowId) {
            if let Some(window) = self.window(id) {
                let _ = window.destroy();
            }
        }

        fn is_visible(&self, id: WindowId) -> bool {
            self.window(id).and_then(|window| window.is_visible().ok()).unwrap_or(false)
        }

        fn is_minimized(&self, id: WindowId) -> bool {
            self.window(id).and_then(|window| window.is_minimized().ok()).unwrap_or(false)
        }

        fn is_maximized(&self, id: WindowId) -> bool {
            self.window(id).and_then(|window| window.is_maximized().ok()).unwrap_or(false)
        }

        fn focused_window(&self) -> Option<WindowId> {
            self.app
                .webview_windows()
                .into_iter()
                .find(|(_, window)| window.is_focused().unwrap_or(false))
                .and_then(|(label, _)| crate::ports::Caller::from_label(&label))
                .map(|caller| caller.win_id)
        }

        fn bounds(&self, id: WindowId) -> Option<Rect> {
            Self::logical_rect(&self.window(id)?)
        }

        fn set_bounds(&self, id: WindowId, bounds: Rect) {
            if let Some(window) = self.window(id) {
                let _ = window.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y));
                let _ = window.set_size(tauri::LogicalSize::new(bounds.width, bounds.height));
            }
        }

        fn work_areas(&self) -> Vec<Rect> {
            let mut areas = Vec::new();
            if let Ok(Some(primary)) = self.app.primary_monitor() {
                areas.push(Self::monitor_rect(&primary));
            }
            if let Ok(monitors) = self.app.available_monitors() {
                areas.extend(monitors.iter().map(Self::monitor_rect));
            }
            areas
        }

        fn work_area_at_cursor(&self) -> Option<Rect> {
            let cursor = self.app.cursor_position().ok()?;
            let monitor = self.app.monitor_from_point(cursor.x, cursor.y).ok().flatten().or_else(|| self.app.primary_monitor().ok().flatten())?;
            Some(Self::monitor_rect(&monitor))
        }

        fn prefers_dark(&self) -> bool {
            self.app
                .webview_windows()
                .values()
                .next()
                .and_then(|window| window.theme().ok())
                .map(|theme| theme == tauri::Theme::Dark)
                .unwrap_or(true)
        }

        fn set_progress(&self, id: WindowId, percent: Option<u64>) {
            if let Some(window) = self.window(id) {
                let state = match percent {
                    Some(progress) => tauri::window::ProgressBarState { status: Some(tauri::window::ProgressBarStatus::Normal), progress: Some(progress) },
                    None => tauri::window::ProgressBarState { status: Some(tauri::window::ProgressBarStatus::None), progress: None },
                };
                let _ = window.set_progress_bar(state);
            }
        }

        fn set_badge(&self, label: Option<String>) {
            #[cfg(target_os = "macos")]
            if let Some(window) = self.app.webview_windows().values().next() {
                let _ = window.set_badge_label(label);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = label;
        }

        fn install_tray(&self, tooltip: &str, menu: &[MenuItemModel]) -> Result<(), String> {
            let icon = tray::build_tray(&self.app, tooltip, menu)?;
            *lock(&self.tray) = Some(icon);
            Ok(())
        }

        fn set_tray_tooltip(&self, tooltip: &str) {
            if let Some(tray) = lock(&self.tray).as_ref() {
                let _ = tray.set_tooltip(Some(tooltip));
            }
        }

        fn set_tray_menu(&self, items: &[MenuItemModel]) -> Result<(), String> {
            let Some(tray) = lock(&self.tray).clone() else { return Ok(()) };
            let built = menu::build_menu(&self.app, items)?;
            tray.set_menu(Some(built)).map_err(|error| error.to_string())
        }

        fn destroy_tray(&self) {
            if let Some(tray) = lock(&self.tray).take() {
                let _ = tray.set_visible(false);
                self.app.remove_tray_by_id(tray.id());
            }
        }

        fn set_app_menu(&self, items: &[MenuItemModel]) -> Result<(), String> {
            let built = menu::build_menu(&self.app, items)?;
            self.app.set_menu(built).map(|_| ()).map_err(|error| error.to_string())
        }

        fn register_deep_link_scheme(&self) -> Result<(), String> {
            self.app.deep_link().register_all().map_err(|error| error.to_string())
        }

        fn startup_urls(&self) -> Vec<String> {
            self.app.deep_link().get_current().ok().flatten().unwrap_or_default().into_iter().map(|url| url.to_string()).collect()
        }

        fn default_workspace(&self) -> std::io::Result<PathBuf> {
            paths::ensure_default_workspace()
        }

        fn directory_exists(&self, path: &str) -> bool {
            paths::is_existing_directory(path)
        }

        fn initial_cwd(&self, candidates: &[Option<String>]) -> Option<String> {
            let refs: Vec<Option<&str>> = candidates.iter().map(|candidate| candidate.as_deref()).collect();
            paths::initial_cwd(&refs)
        }

        fn home_dir(&self) -> Option<PathBuf> {
            dirs::home_dir()
        }

        fn argv(&self) -> Vec<String> {
            std::env::args().collect()
        }

        fn env(&self) -> crate::desktop::wayland_portal::Env {
            crate::desktop::wayland_portal::process_env()
        }
    }
}

// ---------------------------------------------------------------------------
// Fake backend for tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod fake {
    use std::collections::{BTreeMap, HashSet};
    use std::path::PathBuf;
    use std::sync::Mutex;

    use super::{Backend, MainWindowSpec, MenuItemModel, QuickEntrySpec};
    use crate::desktop::window_bounds::Rect;
    use crate::desktop::{lock, Platform};
    use crate::ports::WindowId;
    use crate::testing::CallLog;

    #[derive(Debug)]
    pub(crate) struct FakeWindow {
        pub visible: bool,
        pub minimized: bool,
        pub maximized: bool,
        pub bounds: Rect,
    }

    /// A window system in memory: windows, their geometry, the tray and menu models.
    pub(crate) struct FakeBackend {
        pub log: CallLog,
        pub platform: Mutex<Platform>,
        pub windows: Mutex<BTreeMap<WindowId, FakeWindow>>,
        pub main_specs: Mutex<Vec<MainWindowSpec>>,
        pub quick_entry_specs: Mutex<Vec<QuickEntrySpec>>,
        pub focused: Mutex<Option<WindowId>>,
        pub work_areas: Mutex<Vec<Rect>>,
        pub cursor_area: Mutex<Option<Rect>>,
        pub dark: Mutex<bool>,
        pub progress: Mutex<BTreeMap<WindowId, Option<u64>>>,
        pub badge: Mutex<Option<String>>,
        pub tray_tooltip: Mutex<Option<String>>,
        pub tray_menu: Mutex<Option<Vec<MenuItemModel>>>,
        pub app_menu: Mutex<Option<Vec<MenuItemModel>>>,
        pub directories: Mutex<HashSet<String>>,
        pub workspace: PathBuf,
        pub argv: Mutex<Vec<String>>,
        pub env: Mutex<crate::desktop::wayland_portal::Env>,
        pub startup_urls: Mutex<Vec<String>>,
        /// When set, every main-window build fails with this message.
        pub build_failure: Mutex<Option<String>>,
        /// The context whose bridge a built window registers with, as `build_window` does.
        pub ctx: Mutex<Option<crate::ports::CtxRef>>,
    }

    impl FakeBackend {
        pub(crate) fn new(platform: Platform) -> Self {
            Self {
                log: CallLog::default(),
                platform: Mutex::new(platform),
                windows: Mutex::new(BTreeMap::new()),
                main_specs: Mutex::new(Vec::new()),
                quick_entry_specs: Mutex::new(Vec::new()),
                focused: Mutex::new(None),
                work_areas: Mutex::new(vec![Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 }]),
                cursor_area: Mutex::new(None),
                dark: Mutex::new(true),
                progress: Mutex::new(BTreeMap::new()),
                badge: Mutex::new(None),
                tray_tooltip: Mutex::new(None),
                tray_menu: Mutex::new(None),
                app_menu: Mutex::new(None),
                directories: Mutex::new(HashSet::from(["/w/alpha".to_string(), "/w/beta".to_string(), "/work".to_string()])),
                workspace: PathBuf::from("/work"),
                argv: Mutex::new(vec!["sai-atlas".into()]),
                env: Mutex::new([("XDG_SESSION_TYPE".to_string(), "x11".to_string())].into_iter().collect()),
                startup_urls: Mutex::new(Vec::new()),
                build_failure: Mutex::new(None),
                ctx: Mutex::new(None),
            }
        }

        fn register_with_bridge(&self, caller: crate::ports::Caller) {
            if let Some(ctx) = lock(&self.ctx).as_ref().and_then(|ctx| ctx.upgrade()) {
                ctx.bridge.register_window(caller);
            }
        }

        pub(crate) fn window_ids(&self) -> Vec<WindowId> {
            lock(&self.windows).keys().copied().collect()
        }

        pub(crate) fn move_window(&self, id: WindowId, x: f64, y: f64) {
            if let Some(window) = lock(&self.windows).get_mut(&id) {
                window.bounds.x = x;
                window.bounds.y = y;
            }
        }
    }

    impl Backend for FakeBackend {
        fn platform(&self) -> Platform {
            *lock(&self.platform)
        }

        fn packaged(&self) -> bool {
            false
        }

        fn build_main_window(&self, spec: MainWindowSpec) -> Result<(), String> {
            if let Some(message) = lock(&self.build_failure).clone() {
                return Err(message);
            }
            self.log.record(format!("build_main_window({})", spec.win_id));
            self.register_with_bridge(crate::ports::Caller::main(spec.win_id));
            let (x, y) = spec.position.unwrap_or((100.0, 100.0));
            lock(&self.windows).insert(
                spec.win_id,
                FakeWindow { visible: true, minimized: false, maximized: spec.maximize, bounds: Rect { x, y, width: spec.size.0, height: spec.size.1 } },
            );
            lock(&self.main_specs).push(spec);
            Ok(())
        }

        fn build_quick_entry_window(&self, spec: QuickEntrySpec) -> Result<(), String> {
            self.log.record("build_quick_entry_window()");
            self.register_with_bridge(crate::ports::Caller::quick_entry());
            let (x, y) = spec.position.unwrap_or((0.0, 0.0));
            lock(&self.windows).insert(
                WindowId::QUICK_ENTRY,
                FakeWindow { visible: false, minimized: false, maximized: false, bounds: Rect { x, y, width: 680.0, height: 168.0 } },
            );
            lock(&self.quick_entry_specs).push(spec);
            Ok(())
        }

        fn exists(&self, id: WindowId) -> bool {
            lock(&self.windows).contains_key(&id)
        }

        fn show(&self, id: WindowId) {
            self.log.record(format!("show({id})"));
            if let Some(window) = lock(&self.windows).get_mut(&id) {
                window.visible = true;
            }
        }

        fn hide(&self, id: WindowId) {
            self.log.record(format!("hide({id})"));
            if let Some(window) = lock(&self.windows).get_mut(&id) {
                window.visible = false;
            }
        }

        fn focus(&self, id: WindowId) {
            self.log.record(format!("focus({id})"));
            if let Some(window) = lock(&self.windows).get_mut(&id) {
                window.visible = true;
                window.minimized = false;
                *lock(&self.focused) = Some(id);
            }
        }

        fn close(&self, id: WindowId) {
            self.log.record(format!("close({id})"));
            lock(&self.windows).remove(&id);
        }

        fn destroy(&self, id: WindowId) {
            self.log.record(format!("destroy({id})"));
            lock(&self.windows).remove(&id);
        }

        fn is_visible(&self, id: WindowId) -> bool {
            lock(&self.windows).get(&id).map(|window| window.visible).unwrap_or(false)
        }

        fn is_minimized(&self, id: WindowId) -> bool {
            lock(&self.windows).get(&id).map(|window| window.minimized).unwrap_or(false)
        }

        fn is_maximized(&self, id: WindowId) -> bool {
            lock(&self.windows).get(&id).map(|window| window.maximized).unwrap_or(false)
        }

        fn focused_window(&self) -> Option<WindowId> {
            *lock(&self.focused)
        }

        fn bounds(&self, id: WindowId) -> Option<Rect> {
            lock(&self.windows).get(&id).map(|window| window.bounds)
        }

        fn set_bounds(&self, id: WindowId, bounds: Rect) {
            self.log.record(format!("set_bounds({id}, {bounds:?})"));
            if let Some(window) = lock(&self.windows).get_mut(&id) {
                window.bounds = bounds;
            }
        }

        fn work_areas(&self) -> Vec<Rect> {
            lock(&self.work_areas).clone()
        }

        fn work_area_at_cursor(&self) -> Option<Rect> {
            lock(&self.cursor_area).or_else(|| lock(&self.work_areas).first().copied())
        }

        fn prefers_dark(&self) -> bool {
            *lock(&self.dark)
        }

        fn set_progress(&self, id: WindowId, percent: Option<u64>) {
            lock(&self.progress).insert(id, percent);
        }

        fn set_badge(&self, label: Option<String>) {
            *lock(&self.badge) = label;
        }

        fn install_tray(&self, tooltip: &str, menu: &[MenuItemModel]) -> Result<(), String> {
            self.log.record("install_tray()");
            *lock(&self.tray_tooltip) = Some(tooltip.to_string());
            *lock(&self.tray_menu) = Some(menu.to_vec());
            Ok(())
        }

        fn set_tray_tooltip(&self, tooltip: &str) {
            *lock(&self.tray_tooltip) = Some(tooltip.to_string());
        }

        fn set_tray_menu(&self, menu: &[MenuItemModel]) -> Result<(), String> {
            self.log.record("set_tray_menu()");
            *lock(&self.tray_menu) = Some(menu.to_vec());
            Ok(())
        }

        fn destroy_tray(&self) {
            self.log.record("destroy_tray()");
            *lock(&self.tray_menu) = None;
            *lock(&self.tray_tooltip) = None;
        }

        fn set_app_menu(&self, menu: &[MenuItemModel]) -> Result<(), String> {
            self.log.record("set_app_menu()");
            *lock(&self.app_menu) = Some(menu.to_vec());
            Ok(())
        }

        fn register_deep_link_scheme(&self) -> Result<(), String> {
            self.log.record("register_deep_link_scheme()");
            Ok(())
        }

        fn startup_urls(&self) -> Vec<String> {
            lock(&self.startup_urls).clone()
        }

        fn default_workspace(&self) -> std::io::Result<PathBuf> {
            Ok(self.workspace.clone())
        }

        fn directory_exists(&self, path: &str) -> bool {
            lock(&self.directories).contains(path)
        }

        fn initial_cwd(&self, candidates: &[Option<String>]) -> Option<String> {
            let dirs = lock(&self.directories);
            candidates.iter().flatten().find(|candidate| dirs.contains(*candidate)).cloned()
        }

        fn home_dir(&self) -> Option<PathBuf> {
            Some(PathBuf::from("/home/test"))
        }

        fn argv(&self) -> Vec<String> {
            lock(&self.argv).clone()
        }

        fn env(&self) -> crate::desktop::wayland_portal::Env {
            lock(&self.env).clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::testing::{harness, DesktopPort as _, Harness};
    use crate::ports::Caller;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn opens_at_the_default_size_when_nothing_was_saved() {
        let spec = startup_geometry(&SavedWindowState::default(), 0, &[rect(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(spec.size, (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        assert_eq!(spec.position, None);
        assert!(!spec.maximize);
    }

    #[test]
    fn cascades_parallel_windows_and_pulls_a_lost_display_back() {
        let saved = SavedWindowState { x: Some(100.0), y: Some(50.0), width: 1000.0, height: 700.0, is_maximized: Some(true) };
        let second = startup_geometry(&saved, 1, &[rect(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(second.position, Some((128.0, 78.0)));
        assert!(second.maximize);
        let gone = SavedWindowState { x: Some(5000.0), y: Some(50.0), ..saved };
        let recentred = startup_geometry(&gone, 0, &[rect(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(recentred.position, Some((460.0, 190.0)));
    }

    #[test]
    fn resolves_the_spawn_target_like_the_typescript_helper() {
        let idle = resolve_spawn_target(None, None, None, "/fallback", "/work");
        assert_eq!((idle.cwd.as_str(), idle.kind, idle.fresh, idle.placeholder), ("/work", SessionKind::Agent, true, true));
        let explicit = resolve_spawn_target(Some(""), Some("/s.jsonl"), Some(SessionKind::Chat), "/fallback", "/work");
        assert_eq!((explicit.cwd.as_str(), explicit.kind, explicit.fresh, explicit.placeholder), ("/fallback", SessionKind::Chat, false, false));
        let chosen = resolve_spawn_target(Some("/w/alpha"), None, None, "/fallback", "/work");
        assert_eq!(chosen.cwd, "/w/alpha");
    }

    #[test]
    fn spawns_a_window_and_acquires_its_first_tab() {
        let Harness { ctx, desktop, fakes, backend } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        assert_eq!(id, WindowId(1));
        assert_eq!(desktop.record(id).map(|r| r.cwd), Some("/w/alpha".into()));
        assert!(backend.window_ids().contains(&id));
        assert!(fakes.tabs.log.calls().iter().any(|call| call.contains("acquire(") && call.contains("/w/alpha") && call.contains("fresh: false")));
        assert!(ctx.bridge.windows().contains(&Caller::main(id)));
        // The second window gets the next id and cascades.
        let second = desktop.spawn_window(Some("/w/beta".into()), None, None).unwrap();
        assert_eq!(second, WindowId(2));
        assert_eq!(desktop.records().len(), 2);
    }

    #[test]
    fn an_idle_spawn_opens_the_work_workspace_with_a_fresh_placeholder_tab() {
        let Harness { desktop, fakes, .. } = harness(Platform::Linux);
        desktop.spawn_window(None, None, None).unwrap();
        let acquire = fakes.tabs.log.calls().into_iter().find(|call| call.starts_with("acquire(")).unwrap();
        assert!(acquire.contains("cwd: \"/work\""), "{acquire}");
        assert!(acquire.contains("fresh: true"), "{acquire}");
        assert!(acquire.contains("placeholder: true"), "{acquire}");
    }

    #[test]
    fn refuses_to_spawn_at_the_pool_cap_and_closes_a_window_whose_tab_failed() {
        let Harness { desktop, fakes, backend, .. } = harness(Platform::Linux);
        *fakes.tabs.at_cap.lock().unwrap() = true;
        assert_eq!(desktop.spawn_window(Some("/w/alpha".into()), None, None), None);
        assert!(backend.window_ids().is_empty());
        assert!(desktop.records().is_empty());
    }

    #[test]
    fn restores_the_saved_session_one_window_per_layout() {
        let Harness { ctx, desktop, fakes, .. } = harness(Platform::Linux);
        let layout = |cwd: &str| json!({ "version": 1, "activeIndex": 0, "tabs": [{ "cwd": cwd, "kind": "agent" }] });
        // Every fake directory exists for the sanitizer, which probes the real filesystem.
        let dir = fakes.dir.path();
        let a = dir.join("a");
        let b = dir.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        ctx.prefs.set("tabLayouts", json!([layout(a.to_str().unwrap()), layout(b.to_str().unwrap())])).unwrap();
        desktop.restore_startup_windows(&ctx, None);
        assert_eq!(desktop.records().len(), 2);
        assert_eq!(fakes.tabs.log.calls().iter().filter(|call| call.starts_with("restore_layout(")).count(), 2);
        assert_eq!(desktop.record(WindowId(1)).map(|r| r.cwd), Some(a.to_string_lossy().to_string()));
    }

    #[test]
    fn persists_bounds_on_close_and_tab_layouts_on_change() {
        let Harness { ctx, desktop, fakes, backend } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        backend.move_window(id, 300.0, 200.0);
        desktop.on_window_event(&ctx, id, WinEvent::CloseRequested);
        let saved = saved_state_value(&ctx).unwrap();
        assert_eq!(saved["x"], 300.0);
        assert_eq!(saved["y"], 200.0);
        assert_eq!(saved["width"], DEFAULT_WIDTH);
        assert_eq!(saved["isMaximized"], false);

        fakes.tabs.layouts.lock().unwrap().insert(
            id,
            PersistedTabLayout { version: 1, tabs: vec![], active_index: 0, split: None },
        );
        desktop.persist_tab_layouts(&ctx);
        assert_eq!(ctx.prefs.get("tabLayouts").map(|v| v.as_array().map(Vec::len)), Some(Some(1)));
        assert_eq!(ctx.prefs.get("tabLayout"), None);
    }

    #[test]
    fn a_layout_query_that_panics_keeps_the_saved_session_untouched() {
        let ids = [WindowId(1), WindowId(2), WindowId(3)];
        let layout = PersistedTabLayout { version: 1, tabs: vec![], active_index: 0, split: None };
        let healthy = collect_layouts(&ids, |id| (id != WindowId(2)).then(|| layout.clone()));
        assert_eq!(healthy.map(|l| l.len()), Some(2));
        let broken = collect_layouts(&ids, |id| if id == WindowId(2) { panic!("not yet implemented") } else { Some(layout.clone()) });
        assert_eq!(broken, None, "one failed window must not shrink the saved session to the others");

        let Harness { ctx, desktop, fakes, .. } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        fakes.tabs.layouts.lock().unwrap().insert(id, layout);
        desktop.persist_tab_layouts(&ctx);
        assert_eq!(ctx.prefs.get("tabLayouts").and_then(|v| v.as_array().map(Vec::len)), Some(1));
    }

    #[tokio::test(start_paused = true)]
    async fn debounces_bounds_while_the_window_keeps_moving() {
        let Harness { ctx, desktop, backend, .. } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        backend.move_window(id, 10.0, 10.0);
        desktop.on_window_event(&ctx, id, WinEvent::Moved);
        tokio::time::sleep(Duration::from_millis(200)).await;
        backend.move_window(id, 20.0, 20.0);
        desktop.on_window_event(&ctx, id, WinEvent::Moved);
        tokio::time::sleep(Duration::from_millis(400)).await;
        // The first write was superseded; nothing is saved yet.
        assert_eq!(saved_state_value(&ctx), None);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(saved_state_value(&ctx).map(|v| v["x"].clone()), Some(json!(20.0)));
    }

    #[test]
    fn tracks_focus_for_the_main_and_target_window() {
        let Harness { ctx, desktop, .. } = harness(Platform::Linux);
        let first = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let second = desktop.spawn_window(Some("/w/beta".into()), None, None).unwrap();
        assert_eq!(desktop.main_window(), Some(second));
        desktop.on_window_event(&ctx, first, WinEvent::Focused(true));
        assert_eq!(desktop.target_window(), Some(first));
        assert_eq!(desktop.main_window(), Some(first));
        desktop.on_window_event(&ctx, first, WinEvent::Focused(false));
        assert_eq!(desktop.target_window(), Some(first));
        assert!(desktop.focus(second));
        assert!(!desktop.focus(WindowId(9)));
        desktop.set_cwd(first, "/w/beta");
        assert_eq!(desktop.record(first).map(|r| r.cwd), Some("/w/beta".into()));
    }

    #[test]
    fn maps_run_progress_to_the_taskbar_and_the_dock() {
        let Harness { desktop, backend, .. } = harness(Platform::Darwin);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        desktop.set_run_progress(RunProgressState::Working);
        assert_eq!(backend.progress.lock().unwrap().get(&id), Some(&Some(50)));
        assert_eq!(backend.badge.lock().unwrap().clone(), Some("●".into()));
        desktop.set_run_progress(RunProgressState::Idle);
        assert_eq!(backend.progress.lock().unwrap().get(&id), Some(&None));
        assert_eq!(backend.badge.lock().unwrap().clone(), None);
        assert_eq!(Desktop::aggregate_progress([RunProgressState::Idle, RunProgressState::Waiting]), RunProgressState::Waiting);
        assert_eq!(Desktop::aggregate_progress([RunProgressState::Waiting, RunProgressState::Working]), RunProgressState::Working);
    }
}
